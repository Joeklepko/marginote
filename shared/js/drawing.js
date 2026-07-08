// shared/js/drawing.js
// 内置 Excalidraw 画图（step2）。
// 画板 = 一条特殊 note（type:'drawing'），content 存 Excalidraw 场景 JSON，
// note.thumb='img:<id>' 存缩略图（在 IndexedDB 图片仓）。
// 通过 iframe(excalidraw/index.html) + postMessage 与主 app 交换场景，
// React/Excalidraw 全部锁在 iframe 内，不污染主 vanilla JS。
//
// 依赖主 app 暴露的全局：notes, currentNote, currentView, uid, saveData,
//   getNotebook, getFolder, switchView, renderNotesList, renderNotebooks,
//   showToast, persistImage, images, updateActiveNoteListItem（可选）。
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  let _iframeReady = false;
  let _drawingNote = null;     // 当前打开的画板 note
  let _saveTimer = null;
  let _bound = false;

  function el(id) { return document.getElementById(id); }

  function ensureWrap() {
    let wrap = el('drawingWrap');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'drawingWrap';
    // absolute fill #editor，保证 iframe 有确定高度（否则画布高度 0 无法编辑）
    wrap.style.cssText = 'display:none; position:absolute; inset:0; width:100%; height:100%; min-height:0; z-index:2;';
    wrap.innerHTML =
      '<div id="drawingBar" style="position:absolute; top:8px; right:12px; z-index:5; display:flex; gap:6px;">' +
      '  <button id="drawExportPng" class="icon-btn" data-tip="导出 PNG 到笔记" title="导出 PNG 到笔记" style="background:var(--paper);box-shadow:var(--shadow-soft);font-size:11px;width:auto;padding:0 8px;">PNG</button>' +
      '  <button id="drawExportSvg" class="icon-btn" data-tip="导出 SVG 到笔记" title="导出 SVG 到笔记" style="background:var(--paper);box-shadow:var(--shadow-soft);font-size:11px;width:auto;padding:0 8px;">SVG</button>' +
      '  <button id="drawDelete" class="icon-btn" data-tip="删除此画板" title="删除此画板" style="background:var(--paper);box-shadow:var(--shadow-soft);font-size:11px;width:auto;padding:0 8px;">🗑 删除</button>' +
      '</div>' +
      '<iframe id="drawingFrame" title="Excalidraw 画图" ' +
      'style="border:0; width:100%; height:100%; display:block; background:var(--paper,#faf6ed);" ' +
      'allow="clipboard-read; clipboard-write"></iframe>';
    const editor = el('editor');
    if (editor) editor.appendChild(wrap);
    else {
      const ew = el('editorWrap');
      if (ew && ew.parentNode) ew.parentNode.insertBefore(wrap, ew.nextSibling);
      else document.body.appendChild(wrap);
    }
    const pBtn = wrap.querySelector('#drawExportPng');
    const sBtn = wrap.querySelector('#drawExportSvg');
    const dBtn = wrap.querySelector('#drawDelete');
    if (pBtn) pBtn.addEventListener('click', function () { requestExport('png'); });
    if (sBtn) sBtn.addEventListener('click', function () { requestExport('svg'); });
    // 删除当前画板：复用主程序的 deleteCurrent（工作目录下会移入回收站，可恢复）
    if (dBtn) dBtn.addEventListener('click', function () { if (typeof window.deleteCurrent === 'function') window.deleteCurrent(); });
    return wrap;
  }

  function bridge() {
    if (_bound) return;
    _bound = true;
    window.addEventListener('message', function (ev) {
      const d = ev.data;
      if (!d || d.source !== 'mn-excalidraw') return;
      if (d.type === 'ready') {
        _iframeReady = true;
        sendScene();
      } else if (d.type === 'scene') {
        onSceneFromFrame(d.json || '');
      } else if (d.type === 'thumb') {
        onThumbFromFrame(d.b64 || '');
      } else if (d.type === 'export') {
        onExportFromFrame(d);
      } else if (d.type === 'assets-missing') {
        if (typeof showToast === 'function') {
          showToast('画图资源缺失：安装包/扩展未完整，请重新安装或重新加载扩展');
        }
      } else if (d.type === 'error') {
        if (typeof console !== 'undefined') console.warn('[drawing]', d.message);
      }
    });
  }

  function frameWin() {
    const f = el('drawingFrame');
    return f && f.contentWindow ? f.contentWindow : null;
  }

  function sendScene() {
    const w = frameWin();
    if (!w || !_drawingNote) return;
    w.postMessage({ target: 'mn-excalidraw', type: 'load', json: _drawingNote.content || '' }, '*');
  }

  function onSceneFromFrame(json) {
    if (!_drawingNote) return;
    _drawingNote.content = json;
    _drawingNote.updatedAt = Date.now();
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () {
      try { saveData(); } catch (e) {}
      const st = el('editorStatus');
      if (st) st.textContent = '已保存';
      if (typeof updateActiveNoteListItem === 'function') {
        try { updateActiveNoteListItem(); } catch (e) {}
      }
    }, 300);
  }

  // 缩略图回来 → 存图片仓，记 note.thumb='img:<id>'
  function onThumbFromFrame(b64) {
    if (!_drawingNote || !b64) return;
    try {
      const dataUrl = 'data:image/png;base64,' + b64;
      let id = (_drawingNote.thumb && /^img:([a-z0-9]+)$/i.test(_drawingNote.thumb))
        ? _drawingNote.thumb.slice(4) : (typeof uid === 'function' ? uid() : ('d' + Date.now()));
      if (typeof window.images === 'object' && window.images) {
        window.images[id] = { name: 'thumb-' + id + '.png', dataUrl: dataUrl, ext: '.png', createdAt: Date.now() };
      }
      if (typeof persistImage === 'function') persistImage(id);
      _drawingNote.thumb = 'img:' + id;
      try { saveData(); } catch (e) {}
      if (typeof updateActiveNoteListItem === 'function') { try { updateActiveNoteListItem(); } catch (e) {} }
    } catch (e) { if (typeof console !== 'undefined') console.warn('[drawing] thumb', e); }
  }

  function requestExport(kind) {
    const w = frameWin();
    if (!w) return;
    w.postMessage({ target: 'mn-excalidraw', type: 'request-export', kind: kind }, '*');
  }

  // 导出整图回来 → 存图片仓 → 复制 ![](img:<id>) 引用到剪贴板/提示
  function onExportFromFrame(d) {
    const out = d && d.data;
    if (!out || !out.b64) { if (typeof showToast === 'function') showToast('画板为空，无法导出'); return; }
    try {
      const id = (typeof uid === 'function') ? uid() : ('e' + Date.now());
      const ext = out.ext || '.png';
      const dataUrl = 'data:' + (out.mime || 'image/png') + ';base64,' + out.b64;
      if (typeof window.images === 'object' && window.images) {
        window.images[id] = { name: ((_drawingNote && _drawingNote.title) || 'drawing') + ext, dataUrl: dataUrl, ext: ext, createdAt: Date.now() };
      }
      if (typeof persistImage === 'function') persistImage(id);
      const ref = '![' + ((_drawingNote && _drawingNote.title) || 'drawing') + '](img:' + id + ')';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ref);
      } catch (e) {}
      if (typeof showToast === 'function') showToast('已导出图片，引用已复制：粘贴到笔记即可显示');
    } catch (e) { if (typeof console !== 'undefined') console.warn('[drawing] export', e); }
  }

  function isDark() {
    try { return document.body.getAttribute('data-theme') === 'dark'; }
    catch (e) { return false; }
  }

  // 打开一个画板 note
  function openDrawing(note) {
    _drawingNote = note;
    try { window.currentNote = note; } catch (e) {}
    bridge();
    const wrap = ensureWrap();

    const empty = el('emptyState'); if (empty) empty.style.display = 'none';
    const ew = el('editorWrap'); if (ew) ew.style.display = 'none';
    const tew = el('todoEditorWrap'); if (tew) tew.style.display = 'none';
    wrap.style.display = 'block';
    const app = el('app'); if (app) app.classList.add('show-editor');

    _iframeReady = false;
    const f = el('drawingFrame');
    if (f) {
      const base = 'excalidraw/index.html';
      f.src = base + (isDark() ? '?theme=dark' : '');
    }

    if (typeof renderNotesList === 'function') { try { renderNotesList(); } catch (e) {} }
  }

  // 切回普通视图时收起画板（保存最后场景）
  function closeDrawing() {
    const w = frameWin();
    if (w) w.postMessage({ target: 'mn-excalidraw', type: 'request-save' }, '*');
    const wrap = el('drawingWrap'); if (wrap) wrap.style.display = 'none';
    _drawingNote = null;
  }

  // 主题切换时通知 iframe（免重载、不丢未存改动）
  function syncTheme() {
    const w = frameWin();
    if (w) w.postMessage({ target: 'mn-excalidraw', type: 'set-theme', dark: isDark() }, '*');
  }

  // 新建画板（参考 createNote 归属逻辑）
  function createDrawing() {
    let targetNbId = null;
    const view = (typeof currentView !== 'undefined') ? currentView : 'all';
    if (view.startsWith('folder:')) {
      const f = getFolder(view.slice(7));
      targetNbId = f ? f.notebookId : notebooksFirst();
    } else if (view.startsWith('nb:')) {
      targetNbId = view.slice(3);
    } else {
      targetNbId = notebooksFirst();
      if (view !== 'all' && typeof switchView === 'function') switchView('all');
    }
    const note = {
      id: uid(),
      notebookId: targetNbId,
      folderId: view.startsWith('folder:') ? view.slice(7) : null,
      type: 'drawing',
      title: '未命名画板',
      content: '',
      thumb: '',
      tags: [],
      starred: false,
      deleted: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    notes.unshift(note);
    try { saveData(); } catch (e) {}
    openDrawing(note);
    if (typeof renderNotesList === 'function') renderNotesList();
    if (typeof renderNotebooks === 'function') renderNotebooks();
    if (typeof showToast === 'function') showToast('已创建画板');
  }

  function notebooksFirst() {
    try { return (window.notebooks && window.notebooks[0]) ? window.notebooks[0].id : null; }
    catch (e) { return null; }
  }

  function bindButton() {
    const btn = el('newDrawingBtn');
    if (btn && !btn._mnBound) { btn._mnBound = true; btn.addEventListener('click', createDrawing); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButton);
  } else {
    bindButton();
  }

  window.openDrawing = openDrawing;
  window.createDrawing = createDrawing;
  window.closeDrawing = closeDrawing;
  window.syncDrawingTheme = syncTheme;
})();
