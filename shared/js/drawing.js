// 画板（Excalidraw 手绘图）功能已移除 —— 规避 WebView2 渲染进程加载/销毁 ~4.4MB 运行时导致的
// out of memory 崩溃。此文件保留为轻量占位：不再创建任何 iframe / 加载任何 Excalidraw 运行时。
// 已有的“画板类型笔记”仍可打开为占位视图并删除；不再支持新建/编辑画板。
// 注意：drawingToFile / drawingRelPath 仍在 app.js 中定义，旧 .excalidraw 文件的同步/删除不受影响。
(function () {
  function el(id) { return document.getElementById(id); }

  function ensureWrap() {
    let wrap = el('drawingWrap');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'drawingWrap';
    wrap.style.cssText = 'display:none; position:absolute; inset:0; width:100%; height:100%; z-index:2; padding:40px; box-sizing:border-box; overflow:auto; background:var(--paper,#faf6ed);';
    wrap.innerHTML =
      '<div style="max-width:520px;margin:8vh auto 0;text-align:center;color:var(--ink-soft,#666);">' +
      '  <div style="font-size:40px;margin-bottom:12px;">✎</div>' +
      '  <h3 id="drawPlaceholderTitle" style="margin:0 0 8px;color:var(--ink,#222);"></h3>' +
      '  <p style="line-height:1.7;">画板（手绘图）功能已移除。这是一条旧的画板笔记，无法再编辑。你可以删除它。</p>' +
      '  <button id="drawPlaceholderDelete" class="modal-btn primary" style="margin-top:14px;">🗑 删除此画板</button>' +
      '</div>';
    const editor = el('editor');
    if (editor) editor.appendChild(wrap); else document.body.appendChild(wrap);
    const db = wrap.querySelector('#drawPlaceholderDelete');
    if (db) db.addEventListener('click', function () { if (typeof window.deleteCurrent === 'function') window.deleteCurrent(); });
    return wrap;
  }

  // 打开旧画板笔记：显示占位视图（不加载 Excalidraw），并让删除入口可用
  function openDrawing(note) {
    try { window.currentNote = note; window.currentTodo = null; } catch (e) {}
    const wrap = ensureWrap();
    const t = wrap.querySelector('#drawPlaceholderTitle');
    if (t) t.textContent = (note && note.title) ? note.title : '未命名画板';
    const empty = el('emptyState'); if (empty) empty.style.display = 'none';
    const ew = el('editorWrap'); if (ew) ew.style.display = 'none';
    const tew = el('todoEditorWrap'); if (tew) tew.style.display = 'none';
    wrap.style.display = 'block';
    const app = el('app'); if (app) app.classList.add('show-editor');
    if (typeof renderNotesList === 'function') { try { renderNotesList(); } catch (e) {} }
  }

  function closeDrawing() { const wrap = el('drawingWrap'); if (wrap) wrap.style.display = 'none'; }
  function createDrawing() { if (typeof showToast === 'function') showToast('画板功能已移除'); }
  function syncTheme() {}

  window.openDrawing = openDrawing;
  window.createDrawing = createDrawing;
  window.closeDrawing = closeDrawing;
  window.syncDrawingTheme = syncTheme;
})();
