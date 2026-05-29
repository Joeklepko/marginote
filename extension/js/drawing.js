// shared/js/drawing.js
// 内置 Excalidraw 画图（step1 最小可用）。
// 画板 = 一条特殊 note（type:'drawing'），content 存 Excalidraw 场景 JSON。
// 通过 iframe(excalidraw/index.html) + postMessage 与主 app 交换场景，
// React/Excalidraw 全部锁在 iframe 内，不污染主 vanilla JS。
//
// 依赖主 app 暴露的全局：notes, currentNote, currentView, uid, saveData,
//   getNotebook, getFolder, switchView, renderNotesList, renderNotebooks,
//   showToast, updateActiveNoteListItem（可选）。
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
    wrap.style.cssText = 'display:none; position:relative; height:100%; width:100%; min-height:0;';
    wrap.innerHTML =
      '<iframe id="drawingFrame" title="Excalidraw 画图" ' +
      'style="border:0; width:100%; height:100%; display:block; background:var(--paper,#faf6ed);" ' +
      'allow="clipboard-read; clipboard-write"></iframe>';
    // 插到编辑器容器旁（与 #editorWrap 同级）
    const ew = el('editorWrap');
    if (ew && ew.parentNode) ew.parentNode.insertBefore(wrap, ew.nextSibling);
    else document.body.appendChild(wrap);
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
      } else if (d.type === 'assets-missing') {
        if (typeof showToast === 'function') {
          showToast('画图资源未安装：在 shared/excalidraw/vendor 运行 bash fetch.sh');
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

  function isDark() {
    try { return document.body.getAttribute('data-theme') === 'dark'; }
    catch (e) { return false; }
  }

  // 打开一个画板 note
  function openDrawing(note) {
    _drawingNote = note;
    if (typeof currentNote !== 'undefined') { try { window.currentNote = note; } catch (e) {} }
    bridge();
    const wrap = ensureWrap();

    // 隐藏其它视图，显示画板
    const empty = el('emptyState'); if (empty) empty.style.display = 'none';
    const ew = el('editorWrap'); if (ew) ew.style.display = 'none';
    const tew = el('todoEditorWrap'); if (tew) tew.style.display = 'none';
    wrap.style.display = 'block';
    const app = el('app'); if (app) app.classList.add('show-editor');

    // (重新)加载 iframe，确保主题正确
    _iframeReady = false;
    const f = el('drawingFrame');
    if (f) {
      const base = 'excalidraw/index.html';
      f.src = base + (isDark() ? '?theme=dark' : '');
    }

    if (typeof renderNotesList === 'function') { try { renderNotesList(); } catch (e) {} }
  }

  // 关闭画板视图（回到空状态），保存最后场景
  function closeDrawing() {
    const w = frameWin();
    if (w) w.postMessage({ target: 'mn-excalidraw', type: 'request-save' }, '*');
    const wrap = el('drawingWrap'); if (wrap) wrap.style.display = 'none';
    _drawingNote = null;
  }

  // 新建画板（参考 createNote 的归属逻辑）
  function createDrawing() {
    let targetNbId = null;
    const view = (typeof currentView !== 'undefined') ? currentView : 'all';
    if (view.startsWith('folder:')) {
      const f = getFolder(view.slice(7));
      targetNbId = f ? f.notebookId : (notes && notebooksFirst());
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

  // 绑定侧栏「画板」按钮（若存在）
  function bindButton() {
    const btn = el('newDrawingBtn');
    if (btn && !btn._mnBound) { btn._mnBound = true; btn.addEventListener('click', createDrawing); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButton);
  } else {
    bindButton();
  }

  // 暴露给 app.js（selectNote 会据 note.type 调 openDrawing）
  window.openDrawing = openDrawing;
  window.createDrawing = createDrawing;
  window.closeDrawing = closeDrawing;
})();
