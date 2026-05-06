// ===================== 错误日志 =====================
const ERROR_LOG_KEY = 'marginote.errorLog';
const ERROR_LOG_MAX = 100;
let errorLogBuffer = [];

function loadErrorLog() {
  try { errorLogBuffer = JSON.parse(localStorage.getItem(ERROR_LOG_KEY)) || []; }
  catch { errorLogBuffer = []; }
}

function logError(err, context) {
  const entry = {
    ts: Date.now(),
    context: context || '',
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : ''
  };
  errorLogBuffer.push(entry);
  if (errorLogBuffer.length > ERROR_LOG_MAX) errorLogBuffer.shift();
  try { localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(errorLogBuffer)); } catch {}
  if (typeof console !== 'undefined') console.error('[Marginote]', context, err);
}

function clearErrorLog() {
  errorLogBuffer = [];
  localStorage.removeItem(ERROR_LOG_KEY);
}

window.addEventListener('error', e => logError(e.error || e.message, 'window.error'));
window.addEventListener('unhandledrejection', e => logError(e.reason, 'unhandled-promise'));

// ===================== IndexedDB 图片仓库 =====================
const IDB_NAME = 'marginote';
const IDB_VERSION = 2;
let _idb = null;

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    if (!_idb) { resolve(null); return; }
    const tx = _idb.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    if (!_idb) { resolve(); return; }
    const tx = _idb.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    if (!_idb) { resolve([]); return; }
    const tx = _idb.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    if (!_idb) { resolve(); return; }
    const tx = _idb.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function initImagesIdb() {
  try {
    _idb = await openIdb();
  } catch (e) {
    logError(e, 'idb-open');
    return;
  }
  // 迁移：localStorage 已有 images 全部搬到 IDB，并从 saveData 写入中剔除
  const localImageIds = Object.keys(images);
  if (localImageIds.length > 0) {
    for (const id of localImageIds) {
      try { await idbPut('images', { id, ...images[id] }); }
      catch (e) { logError(e, 'idb-migrate'); }
    }
    // saveData 之后会从 localStorage 主表移除（saveData 已不写 images）
    saveData();
  }
  // 从 IDB 加载所有图片到内存（同步访问需要）
  try {
    const all = await idbGetAll('images');
    all.forEach(img => {
      images[img.id] = { name: img.name, dataUrl: img.dataUrl, ext: img.ext, createdAt: img.createdAt };
    });
  } catch (e) { logError(e, 'idb-load'); }
}

async function persistImage(id) {
  if (!_idb) return;
  try { await idbPut('images', { id, ...images[id] }); }
  catch (e) { logError(e, 'idb-put'); }
}

// ===================== 数据层 =====================
const STORAGE_KEY = 'marginote.data.v2';
const LEGACY_KEY = 'marginote.notes.v1';

const NOTEBOOK_COLORS = [
  '#b8431f', '#d97706', '#ca8a04', '#65a30d',
  '#0d9488', '#0284c7', '#4f46e5', '#9333ea',
  '#db2777', '#525252'
];

let notebooks = [];
let folders = [];
let notes = [];
let todos = [];
let images = {}; // { id: { name, dataUrl, ext, createdAt } }
let currentNote = null;
let currentTodo = null;
let todoSaveTimer = null;
let isTodoPreviewMode = false;
let currentView = 'all'; // 'all' | 'starred' | 'trash' | 'nb:<id>' | 'folder:<id>' | 'todo:active|done|overdue|all'
let currentTagFilter = 'all';
let saveTimer = null;
let isPreviewMode = false;
let modalCallback = null;
let editingNotebook = null; // 当前编辑中的笔记本（null = 新建）
let editingFolder = null;   // 当前编辑中的文件夹
let pickedColor = NOTEBOOK_COLORS[0];

const THEME_KEY = 'marginote.theme';

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      notebooks = data.notebooks || [];
      folders = data.folders || [];
      notes = data.notes || [];
      todos = data.todos || [];
      images = data.images || {};
    } else {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        notes = JSON.parse(legacy);
      }
    }
  } catch (e) {
    notebooks = [];
    folders = [];
    notes = [];
    todos = [];
    images = {};
  }

  // 初始化默认数据
  if (notebooks.length === 0) {
    notebooks = [
      { id: uid(), name: '随笔', color: '#b8431f', createdAt: Date.now() },
      { id: uid(), name: '工作', color: '#0d9488', createdAt: Date.now() + 1 },
      { id: uid(), name: '阅读', color: '#9333ea', createdAt: Date.now() + 2 }
    ];
  }

  // 给老笔记打上默认笔记本和 folderId
  const defaultNbId = notebooks[0].id;
  notes.forEach(n => {
    if (!n.notebookId) n.notebookId = defaultNbId;
    if (n.folderId === undefined) n.folderId = null;
  });

  // 初始化示例笔记
  if (notes.length === 0) {
    notes = [
      {
        id: uid(),
        notebookId: notebooks[0].id,
        title: '欢迎来到 Marginote',
        content: `# 欢迎来到 Marginote

这是一本属于你的数字笔记本。**Marginote** 取自 *marginal note*（页边批注），是阅读时灵感的栖息地。

## 它能做什么

- 用 **笔记本** 把内容分门别类（左侧栏即可新建/管理）
- 创建、编辑和组织笔记
- 用 *Markdown* 语法格式化文字
- 通过 \`#标签\` 二级分类
- **收藏**重要的笔记
- 全文 **搜索**
- 一键 **导出/导入** JSON 备份

> 文字是思想的脚印，留下它们，未来的你会感谢现在的你。

## 快捷键

- \`⌘/Ctrl + N\` 新建笔记
- \`⌘/Ctrl + S\` 保存（其实自动保存了）
- \`⌘/Ctrl + B\` 加粗
- \`⌘/Ctrl + I\` 斜体

---

试试在左侧栏点 + 创建一个属于你的笔记本吧。`,
        tags: ['指南', '欢迎'],
        starred: true,
        deleted: false,
        folderId: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        id: uid(),
        notebookId: notebooks[0].id,
        title: '今日所思',
        content: `今天读到一句话：「真正的发现之旅不在于寻找新的风景，而在于拥有新的眼睛。」——普鲁斯特

## 想法

- 每日记录三件值得感激的事
- 阅读，但更要思考
- 写下来，会比你以为的更重要

## 待办

- [ ] 完成季度总结
- [x] 整理书架
- [ ] 给朋友写一封长信`,
        tags: ['日记', '思考'],
        starred: false,
        deleted: false,
        folderId: null,
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now() - 86400000
      },
      {
        id: uid(),
        notebookId: notebooks[2].id,
        title: '关于设计的几则笔记',
        content: `# 关于设计

> "Good design is as little design as possible." — Dieter Rams

设计不是给物件添加什么，而是去掉所有不必要的部分，直到留下的就是答案本身。

## 三个原则

1. **诚实** — 不假装，不模仿
2. **克制** — 少即是多
3. **耐用** — 经得起时间的检验`,
        tags: ['设计', '引用'],
        starred: true,
        deleted: false,
        folderId: null,
        createdAt: Date.now() - 172800000,
        updatedAt: Date.now() - 172800000
      }
    ];
  }

  saveData();
}

function saveData() {
  try {
    // 图片不入 localStorage（改用 IndexedDB），主表只存元数据避免大对象阻塞
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ notebooks, folders, notes, todos }));
  } catch (e) {
    showToast('存储失败：可能超出本地存储容量');
    logError(e, 'saveData');
  }
}

// 兼容旧名称
function saveNotes() { saveData(); }

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getNotebook(id) {
  return notebooks.find(nb => nb.id === id);
}

function getFolder(id) {
  return folders.find(f => f.id === id);
}

function getFoldersByNotebook(nbId) {
  return folders.filter(f => f.notebookId === nbId);
}

// ===================== 视图渲染 =====================
function getFilteredNotes() {
  let list = notes.filter(n => {
    if (currentView === 'trash') return n.deleted;
    if (n.deleted) return false;
    if (currentView === 'starred') return n.starred;
    if (currentView.startsWith('folder:')) {
      return n.folderId === currentView.slice(7);
    }
    if (currentView.startsWith('nb:')) {
      return n.notebookId === currentView.slice(3);
    }
    return true; // 'all'
  });

  if (currentTagFilter !== 'all') {
    list = list.filter(n => n.tags && n.tags.includes(currentTagFilter));
  }

  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  if (q) {
    list = list.filter(n =>
      (n.title || '').toLowerCase().includes(q) ||
      (n.content || '').toLowerCase().includes(q) ||
      (n.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  // 置顶星标，再按更新时间排
  list.sort((a, b) => {
    if (a.starred !== b.starred) return b.starred ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });

  return list;
}

function renderNotesList() {
  const list = getFilteredNotes();
  const container = document.getElementById('notesList');

  // 显示笔记本徽标的视图（全部/收藏/回收站）
  const showNbBadge = !currentView.startsWith('nb:') && !currentView.startsWith('folder:');

  if (list.length === 0) {
    const empty = currentView === 'trash' ? '回收站为空' :
                  currentView === 'starred' ? '尚无收藏的笔记' :
                  currentView.startsWith('folder:') ? '此文件夹还是空的' :
                  currentView.startsWith('nb:') ? '这本笔记本还是空的' :
                  '尚无笔记，开始书写吧';
    container.innerHTML = `<div class="empty-list">${empty}</div>`;
    return;
  }

  container.innerHTML = list.map(n => {
    const date = formatDate(n.updatedAt);
    const preview = stripMarkdown(n.content || '').slice(0, 100);
    const tags = (n.tags || []).slice(0, 3).map(t =>
      `<span class="note-tag">${escapeHtml(t)}</span>`
    ).join('');
    const isActive = currentNote && currentNote.id === n.id;
    const nb = getNotebook(n.notebookId);
    const nbBadge = (showNbBadge && nb)
      ? `<span class="note-nb-badge"><span class="note-nb-dot" style="background:${nb.color}"></span>${escapeHtml(nb.name)}</span>`
      : '';
    return `
      <div class="note-item ${isActive ? 'active' : ''}" data-id="${n.id}">
        <div class="note-item-head">
          <div class="note-title">${n.starred ? '<span class="note-pin">★</span>' : ''}${escapeHtml(n.title || '无题')}</div>
          <div class="note-date">${date}</div>
        </div>
        ${preview ? `<div class="note-preview">${escapeHtml(preview)}</div>` : ''}
        <div class="note-foot">
          ${nbBadge}
          ${tags ? `<div class="note-tags">${tags}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.note-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const note = notes.find(n => n.id === id);
      if (note) selectNote(note);
    });
  });

  if (typeof updateCollectionCount === 'function') updateCollectionCount();
}

function renderNotebooks() {
  const container = document.getElementById('notebooksList');
  const aliveNotes = notes.filter(n => !n.deleted);

  // 系统计数
  document.getElementById('countAll').textContent = aliveNotes.length;
  document.getElementById('countStarred').textContent = aliveNotes.filter(n => n.starred).length;
  document.getElementById('countTrash').textContent = notes.filter(n => n.deleted).length;
  renderTodoCounts();

  // 笔记本列表
  container.innerHTML = notebooks.map(nb => {
    const count = aliveNotes.filter(n => n.notebookId === nb.id).length;
    const isActive = currentView === 'nb:' + nb.id;
    const nbFolders = getFoldersByNotebook(nb.id);
    let html = `
      <div class="rail-item ${isActive ? 'active' : ''}" data-nb="${nb.id}" role="button" tabindex="0">
        <span class="nb-dot" style="background:${nb.color}"></span>
        <span class="rail-item-label">${escapeHtml(nb.name)}</span>
        <span class="rail-item-count">${count}</span>
        <span class="nb-actions">
          <button data-action="addFolder" data-id="${nb.id}" title="新建文件夹">
            <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" d="M12 5v14M5 12h14"/>
            </svg>
          </button>
          <button data-action="edit" data-id="${nb.id}" title="编辑">
            <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button data-action="delete" data-id="${nb.id}" title="删除">
            <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7M3 7h18M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/>
            </svg>
          </button>
        </span>
      </div>`;
    // 文件夹列表
    nbFolders.forEach(f => {
      const fCount = aliveNotes.filter(n => n.folderId === f.id).length;
      const fActive = currentView === 'folder:' + f.id;
      html += `
        <div class="rail-folder-item ${fActive ? 'active' : ''}" data-folder="${f.id}" data-nb="${nb.id}" role="button" tabindex="0">
          <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
          </svg>
          <span class="rail-item-label">${escapeHtml(f.name)}</span>
          <span class="rail-item-count">${fCount}</span>
          <span class="nb-actions">
            <button data-action="editFolder" data-id="${f.id}" title="重命名">
              <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button data-action="deleteFolder" data-id="${f.id}" title="删除">
              <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7M3 7h18M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/>
              </svg>
            </button>
          </span>
        </div>`;
    });
    return html;
  }).join('');

  if (notebooks.length === 0) {
    container.innerHTML = '<div style="padding: 16px 12px; color: var(--ink-mute); font-size: 12px; font-style: italic; text-align: center;">还没有笔记本，<br>点击右上角 + 创建</div>';
  }

  // 笔记本点击切换视图
  container.querySelectorAll('.rail-item[data-nb]').forEach(el => {
    el.addEventListener('click', e => {
      // 处理操作按钮
      const actBtn = e.target.closest('button[data-action]');
      if (actBtn) {
        e.stopPropagation();
        const action = actBtn.dataset.action;
        const nb = getNotebook(actBtn.dataset.id);
        if (action === 'edit') openNotebookModal(nb);
        if (action === 'delete') deleteNotebook(nb);
        if (action === 'addFolder') openFolderModal(nb.id, null);
        return;
      }
      switchView('nb:' + el.dataset.nb);
    });
  });

  // 文件夹点击切换视图
  container.querySelectorAll('.rail-folder-item[data-folder]').forEach(el => {
    el.addEventListener('click', e => {
      const actBtn = e.target.closest('button[data-action]');
      if (actBtn) {
        e.stopPropagation();
        const action = actBtn.dataset.action;
        const folder = getFolder(actBtn.dataset.id);
        if (action === 'editFolder') openFolderModal(el.dataset.nb, folder);
        if (action === 'deleteFolder') deleteFolder(folder);
        return;
      }
      switchView('folder:' + el.dataset.folder);
    });
  });
}

function switchView(view) {
  currentView = view;
  currentTagFilter = 'all';

  // 切换 todo / notes 模式
  const sidebar = document.querySelector('.sidebar');
  const todoPanel = document.getElementById('todoPanel');
  const isTodo = view.startsWith('todo:');
  if (sidebar) sidebar.classList.toggle('todo-mode', isTodo);
  if (todoPanel) todoPanel.classList.toggle('show', isTodo);
  // 模式切换时清除右侧编辑器对应的另一类内容
  if (isTodo) {
    currentNote = null;
    const ew = document.getElementById('editorWrap');
    if (ew) ew.style.display = 'none';
    if (!currentTodo) {
      document.getElementById('todoEditorWrap').style.display = 'none';
      document.getElementById('emptyState').style.display = 'flex';
      document.getElementById('app').classList.remove('show-editor');
    }
  } else {
    currentTodo = null;
    const tew = document.getElementById('todoEditorWrap');
    if (tew) tew.style.display = 'none';
    if (!currentNote) {
      document.getElementById('emptyState').style.display = 'flex';
      document.getElementById('app').classList.remove('show-editor');
    }
  }
  // 切换搜索框 placeholder
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.placeholder = isTodo ? '搜索待办...' : '搜索笔记标题或内容...';
    searchInput.value = '';
  }

  // 更新系统项激活态（笔记 + 待办视图共用 data-view）
  document.querySelectorAll('.rail-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });

  // 更新当前集合标题
  let title = '全部笔记';
  let dotColor = 'var(--ink)';
  if (view === 'starred') { title = '收藏'; dotColor = 'var(--accent)'; }
  else if (view === 'trash') { title = '回收站'; dotColor = 'var(--ink-mute)'; }
  else if (view === 'todo:active') { title = '进行中的待办'; dotColor = '#0d9488'; }
  else if (view === 'todo:done') { title = '已完成的待办'; dotColor = 'var(--ink-mute)'; }
  else if (view === 'todo:overdue') { title = '已超期的待办'; dotColor = 'var(--accent)'; }
  else if (view === 'todo:all') { title = '全部待办'; dotColor = 'var(--ink-soft)'; }
  else if (view.startsWith('folder:')) {
    const f = getFolder(view.slice(7));
    if (f) { title = f.name; dotColor = 'var(--ink-soft)'; }
  }
  else if (view.startsWith('nb:')) {
    const nb = getNotebook(view.slice(3));
    if (nb) { title = nb.name; dotColor = nb.color; }
  }
  document.getElementById('currentCollectionName').textContent = title;
  document.getElementById('currentNbDot').style.background = dotColor;

  renderNotebooks();
  renderTagFilters();
  if (isTodo) renderTodos();
  else renderNotesList();
  updateCollectionCount();
}

function updateCollectionCount() {
  if (currentView.startsWith('todo:')) {
    const c = getTodoCounts();
    let total = c.all;
    if (currentView === 'todo:active') total = c.active;
    else if (currentView === 'todo:done') total = c.done;
    else if (currentView === 'todo:overdue') total = c.overdue;
    document.getElementById('noteCount').textContent = `${total} 项`;
    document.getElementById('issueNo').textContent = `№ ${String(total).padStart(3, '0')}`;
    return;
  }
  // 不考虑搜索后的数量影响 issue-no
  const totalNoSearch = notes.filter(n => {
    if (currentView === 'trash') return n.deleted;
    if (n.deleted) return false;
    if (currentView === 'starred') return n.starred;
    if (currentView.startsWith('folder:')) return n.folderId === currentView.slice(7);
    if (currentView.startsWith('nb:')) return n.notebookId === currentView.slice(3);
    return true;
  }).length;
  document.getElementById('noteCount').textContent = `${totalNoSearch} 篇`;
  document.getElementById('issueNo').textContent = `№ ${String(totalNoSearch).padStart(3, '0')}`;
}

// ===================== 待办事项 =====================
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isOverdue(t) {
  if (t.done) return false;
  if (!t.dueDate) return false;
  return t.dueDate < Date.now();
}

function getTodoCounts() {
  const now = Date.now();
  let active = 0, done = 0, overdue = 0;
  todos.forEach(t => {
    if (t.done) done++;
    else if (t.dueDate && t.dueDate < now) overdue++;
    else active++;
  });
  return { active, done, overdue, all: todos.length };
}

function renderTodoCounts() {
  const c = getTodoCounts();
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('countTodoActive', c.active);
  setText('countTodoDone', c.done);
  setText('countTodoOverdue', c.overdue);
  setText('countTodoAll', c.all);
}

function getFilteredTodos() {
  const now = Date.now();
  let list = todos.slice();
  if (currentView === 'todo:active') {
    list = list.filter(t => !t.done && (!t.dueDate || t.dueDate >= now));
  } else if (currentView === 'todo:done') {
    list = list.filter(t => t.done);
  } else if (currentView === 'todo:overdue') {
    list = list.filter(t => !t.done && t.dueDate && t.dueDate < now);
  }
  // search
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  if (q) list = list.filter(t => (t.text || '').toLowerCase().includes(q));
  // sort: overdue → active by due → done at bottom
  list.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.dueDate || Infinity;
    const bd = b.dueDate || Infinity;
    if (ad !== bd) return ad - bd;
    return b.createdAt - a.createdAt;
  });
  return list;
}

function formatDueDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  const today0 = new Date(); today0.setHours(0,0,0,0);
  const dDay0 = new Date(d); dDay0.setHours(0,0,0,0);
  const diff = Math.round((dDay0.getTime() - today0.getTime()) / 86400000);
  const ymd = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let dayLabel;
  if (diff === 0) dayLabel = '今天';
  else if (diff === 1) dayLabel = '明天';
  else if (diff === -1) dayLabel = '昨天';
  else if (diff > 1 && diff < 7) dayLabel = `${diff}天后`;
  else if (diff < -1 && diff > -30) dayLabel = `逾期${-diff}天`;
  else dayLabel = ymd;
  return `${dayLabel} ${hm}`;
}

function toDatetimeLocal(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderTodos() {
  const container = document.getElementById('todoList');
  if (!container) return;
  const list = getFilteredTodos();
  if (list.length === 0) {
    const empty = currentView === 'todo:active' ? '没有进行中的待办' :
                  currentView === 'todo:done' ? '尚无已完成待办' :
                  currentView === 'todo:overdue' ? '没有超期待办 ✓' :
                  '尚无待办，开始添加吧';
    container.innerHTML = `<div class="todo-empty">${empty}</div>`;
    return;
  }
  container.innerHTML = list.map(t => {
    const overdue = isOverdue(t);
    const dueText = formatDueDate(t.dueDate);
    const dueClass = overdue ? 'overdue' : '';
    const isActive = currentTodo && currentTodo.id === t.id;
    return `
      <div class="todo-row ${t.done ? 'done' : ''} ${isActive ? 'active' : ''}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? 'checked' : ''} data-toggle="${t.id}">
        <div class="todo-body">
          <div class="todo-text">${escapeHtml(t.text)}</div>
          <div class="todo-meta">
            ${dueText ? `<span class="todo-due ${dueClass}">⏱ ${escapeHtml(dueText)}</span>` : ''}
            <span>建于 ${formatDate(t.createdAt)}</span>
            ${t.done && t.completedAt ? `<span>完成于 ${formatDate(t.completedAt)}</span>` : ''}
          </div>
        </div>
        <button class="todo-del" data-del="${t.id}" title="删除">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7M3 7h18M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/>
          </svg>
        </button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('input[data-toggle]').forEach(el => {
    el.addEventListener('change', e => {
      e.stopPropagation();
      toggleTodo(el.dataset.toggle);
    });
    el.addEventListener('click', e => e.stopPropagation());
  });
  container.querySelectorAll('button[data-del]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      deleteTodo(el.dataset.del);
    });
  });
  container.querySelectorAll('.todo-row').forEach(el => {
    el.addEventListener('click', () => {
      const t = todos.find(x => x.id === el.dataset.id);
      if (t) selectTodo(t);
    });
  });
}

function selectTodo(t) {
  currentTodo = t;
  currentNote = null;
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('editorWrap').style.display = 'none';
  document.getElementById('todoEditorWrap').style.display = 'block';
  document.getElementById('app').classList.add('show-editor');
  document.getElementById('todoEditTitle').value = t.text || '';
  document.getElementById('todoEditContent').value = t.content || '';
  document.getElementById('todoEditDue').value = toDatetimeLocal(t.dueDate);
  document.getElementById('todoEditRemindBefore').value = t.remindBeforeMin || '';
  document.getElementById('todoEditRemindCount').value = t.remindCount || 1;
  document.getElementById('todoEditRemindInterval').value = t.remindIntervalMin || 5;
  refreshTodoEditState();
  document.getElementById('todoEditMeta').textContent = '建于 ' + formatFullDate(t.createdAt) +
    (t.completedAt ? ' · 完成于 ' + formatFullDate(t.completedAt) : '');
  document.getElementById('todoEditMetaTop').textContent = formatDate(t.createdAt);
  document.getElementById('todoEditStatus').textContent = '已保存';

  // 默认进入预览模式
  isTodoPreviewMode = true;
  const ta = document.getElementById('todoEditContent');
  const pv = document.getElementById('todoPreview');
  const pvBtn = document.getElementById('todoPreviewBtn');
  pv.innerHTML = renderMarkdown(t.content || '');
  ta.style.display = 'none';
  pv.style.display = 'block';
  pvBtn.classList.add('active');
  pvBtn.setAttribute('data-tip', '编辑');

  renderTodos();
}

function toggleTodoPreview() {
  if (!currentTodo) return;
  isTodoPreviewMode = !isTodoPreviewMode;
  const ta = document.getElementById('todoEditContent');
  const pv = document.getElementById('todoPreview');
  const btn = document.getElementById('todoPreviewBtn');
  if (isTodoPreviewMode) {
    pv.innerHTML = renderMarkdown(ta.value);
    ta.style.display = 'none';
    pv.style.display = 'block';
    btn.classList.add('active');
    btn.setAttribute('data-tip', '编辑');
  } else {
    ta.style.display = '';
    pv.style.display = 'none';
    btn.classList.remove('active');
    btn.setAttribute('data-tip', '预览');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

function refreshTodoEditState() {
  if (!currentTodo) return;
  const pill = document.getElementById('todoEditState');
  const toggle = document.getElementById('todoEditToggle');
  pill.classList.remove('done', 'overdue');
  if (currentTodo.done) {
    pill.classList.add('done');
    pill.textContent = '已完成';
    toggle.textContent = '标记未完成';
    toggle.classList.add('done');
  } else if (isOverdue(currentTodo)) {
    pill.classList.add('overdue');
    pill.textContent = '已超期';
    toggle.textContent = '标记完成';
    toggle.classList.remove('done');
  } else {
    pill.textContent = '进行中';
    toggle.textContent = '标记完成';
    toggle.classList.remove('done');
  }
}

function autoSaveTodo() {
  if (!currentTodo) return;
  document.getElementById('todoEditStatus').textContent = '保存中…';
  clearTimeout(todoSaveTimer);
  todoSaveTimer = setTimeout(() => {
    currentTodo.text = document.getElementById('todoEditTitle').value.trim() || '无标题待办';
    currentTodo.content = document.getElementById('todoEditContent').value;
    const dueRaw = document.getElementById('todoEditDue').value;
    currentTodo.dueDate = dueRaw ? new Date(dueRaw).getTime() : null;
    currentTodo.remindBeforeMin = parseInt(document.getElementById('todoEditRemindBefore').value, 10) || 0;
    currentTodo.remindCount = parseInt(document.getElementById('todoEditRemindCount').value, 10) || 1;
    currentTodo.remindIntervalMin = parseInt(document.getElementById('todoEditRemindInterval').value, 10) || 5;
    saveData();
    scheduleTodoReminders(currentTodo);
    document.getElementById('todoEditStatus').textContent = '已保存';
    refreshTodoEditState();
    renderTodoCounts();
    renderTodos();
    updateCollectionCount();
  }, 400);
}

function toggleCurrentTodoDone() {
  if (!currentTodo) return;
  currentTodo.done = !currentTodo.done;
  currentTodo.completedAt = currentTodo.done ? Date.now() : null;
  saveData();
  scheduleTodoReminders(currentTodo);
  refreshTodoEditState();
  document.getElementById('todoEditMeta').textContent = '建于 ' + formatFullDate(currentTodo.createdAt) +
    (currentTodo.completedAt ? ' · 完成于 ' + formatFullDate(currentTodo.completedAt) : '');
  renderTodos();
  renderTodoCounts();
  updateCollectionCount();
  showToast(currentTodo.done ? '已完成 ✓' : '已恢复进行中');
}

function deleteCurrentTodo() {
  if (!currentTodo) return;
  const id = currentTodo.id;
  showModal('删除待办？', '此操作将永久删除该待办，无法恢复。', () => {
    todos = todos.filter(x => x.id !== id);
    currentTodo = null;
    document.getElementById('todoEditorWrap').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('app').classList.remove('show-editor');
    saveData();
    if (isExtensionContext()) {
      chrome.alarms.getAll(all => {
        all.filter(a => a.name.startsWith(`mtodo:${id}:`)).forEach(a => chrome.alarms.clear(a.name));
      });
      syncRemindersToExt();
    }
    renderTodos();
    renderTodoCounts();
    updateCollectionCount();
    showToast('已删除待办');
  });
}

function addTodo() {
  const text = document.getElementById('todoTextInput').value.trim();
  if (!text) { showToast('请输入待办内容'); return; }
  const dueRaw = document.getElementById('todoDueInput').value;
  let dueDate = null;
  if (dueRaw) {
    const d = new Date(dueRaw);
    if (!isNaN(d.getTime())) dueDate = d.getTime();
  }
  const remindBefore = parseInt(document.getElementById('todoRemindBefore').value, 10) || 0;
  const remindCount = parseInt(document.getElementById('todoRemindCount').value, 10) || 1;
  const remindInterval = parseInt(document.getElementById('todoRemindInterval').value, 10) || 5;
  const t = {
    id: uid(),
    text,
    content: '',
    done: false,
    dueDate,
    remindBeforeMin: remindBefore,
    remindCount: remindCount,
    remindIntervalMin: remindInterval,
    createdAt: Date.now(),
    completedAt: null
  };
  todos.push(t);
  saveData();
  scheduleTodoReminders(t);
  document.getElementById('todoTextInput').value = '';
  document.getElementById('todoDueInput').value = '';
  document.getElementById('todoRemindBefore').value = '';
  renderTodos();
  renderTodoCounts();
  updateCollectionCount();
  showToast('已添加待办');
}

function toggleTodo(id) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.completedAt = t.done ? Date.now() : null;
  saveData();
  scheduleTodoReminders(t);
  renderTodos();
  renderTodoCounts();
  updateCollectionCount();
}

function deleteTodo(id) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  todos = todos.filter(x => x.id !== id);
  if (currentTodo && currentTodo.id === id) {
    currentTodo = null;
    document.getElementById('todoEditorWrap').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('app').classList.remove('show-editor');
  }
  saveData();
  // 清除该 todo 所有 alarm
  if (isExtensionContext()) {
    chrome.alarms.getAll(all => {
      all.filter(a => a.name.startsWith(`mtodo:${id}:`)).forEach(a => chrome.alarms.clear(a.name));
    });
    syncRemindersToExt();
  }
  renderTodos();
  renderTodoCounts();
  updateCollectionCount();
  showToast('已删除待办');
}

// ===================== 主题 =====================
const THEMES = {
  light: { name: '默认 · 米黄', mode: 'light', vars: {} },
  dark:  { name: '默认 · 暗夜', mode: 'dark',  vars: {} },
  sepia: { name: '羊皮纸', mode: 'light', vars: {
    '--bg': '#f5e9d4', '--bg-warm': '#ecdab9', '--paper': '#faf0d9',
    '--ink': '#3a2c1a', '--ink-soft': '#5a4a30', '--ink-mute': '#8b7651',
    '--rule': '#d3bc8d', '--rule-soft': '#e2d4af',
    '--accent': '#a85a1f', '--accent-soft': '#c06d2c'
  }},
  solarizedLight: { name: '日和 · Solarized', mode: 'light', vars: {
    '--bg': '#fdf6e3', '--bg-warm': '#eee8d5', '--paper': '#fff9e8',
    '--ink': '#073642', '--ink-soft': '#586e75', '--ink-mute': '#93a1a1',
    '--rule': '#d8d2bd', '--rule-soft': '#ece6d4',
    '--accent': '#cb4b16', '--accent-soft': '#dc6332'
  }},
  solarizedDark: { name: '夜和 · Solarized', mode: 'dark', vars: {
    '--bg': '#002b36', '--bg-warm': '#073642', '--paper': '#0d3a47',
    '--ink': '#fdf6e3', '--ink-soft': '#eee8d5', '--ink-mute': '#93a1a1',
    '--rule': '#114a59', '--rule-soft': '#0c3d4a',
    '--accent': '#cb4b16', '--accent-soft': '#dc6332'
  }},
  nord: { name: '北境 · Nord', mode: 'dark', vars: {
    '--bg': '#2e3440', '--bg-warm': '#3b4252', '--paper': '#434c5e',
    '--ink': '#eceff4', '--ink-soft': '#d8dee9', '--ink-mute': '#8898ad',
    '--rule': '#4c566a', '--rule-soft': '#3f4757',
    '--accent': '#88c0d0', '--accent-soft': '#8fbcbb'
  }},
  dracula: { name: '德古拉', mode: 'dark', vars: {
    '--bg': '#282a36', '--bg-warm': '#343746', '--paper': '#3c3f51',
    '--ink': '#f8f8f2', '--ink-soft': '#e6e6dc', '--ink-mute': '#7a7d8a',
    '--rule': '#44475a', '--rule-soft': '#3a3d4d',
    '--accent': '#ff79c6', '--accent-soft': '#ff92d0'
  }},
  gruvbox: { name: '丘陵 · Gruvbox', mode: 'light', vars: {
    '--bg': '#fbf1c7', '--bg-warm': '#f2e5bc', '--paper': '#fdf4cc',
    '--ink': '#3c3836', '--ink-soft': '#504945', '--ink-mute': '#7c6f64',
    '--rule': '#d5c4a1', '--rule-soft': '#e3d7b3',
    '--accent': '#af3a03', '--accent-soft': '#cc5511'
  }},
  forest: { name: '林间', mode: 'dark', vars: {
    '--bg': '#1e2820', '--bg-warm': '#293730', '--paper': '#2f4035',
    '--ink': '#e8eddf', '--ink-soft': '#d3dac4', '--ink-mute': '#8a9786',
    '--rule': '#3a4d40', '--rule-soft': '#34453b',
    '--accent': '#a3be8c', '--accent-soft': '#b4cb9e'
  }},
  mono: { name: '黑白', mode: 'light', vars: {
    '--bg': '#fafafa', '--bg-warm': '#f0f0f0', '--paper': '#ffffff',
    '--ink': '#1a1a1a', '--ink-soft': '#404040', '--ink-mute': '#888888',
    '--rule': '#dadada', '--rule-soft': '#ebebeb',
    '--accent': '#1a1a1a', '--accent-soft': '#3a3a3a'
  }},
  rose: { name: '玫瑰', mode: 'light', vars: {
    '--bg': '#fdf2f4', '--bg-warm': '#f7e3e7', '--paper': '#ffffff',
    '--ink': '#3a1f24', '--ink-soft': '#5e3942', '--ink-mute': '#a07a82',
    '--rule': '#e9c8cf', '--rule-soft': '#f1d7dd',
    '--accent': '#c2185b', '--accent-soft': '#d9356f'
  }},
  ocean: { name: '深海', mode: 'dark', vars: {
    '--bg': '#0f1c2e', '--bg-warm': '#162638', '--paper': '#1c2e44',
    '--ink': '#e8f0f8', '--ink-soft': '#cad7e6', '--ink-mute': '#7d8da3',
    '--rule': '#2a3e57', '--rule-soft': '#22344a',
    '--accent': '#5ec5d7', '--accent-soft': '#76d2e0'
  }}
};

const THEME_VAR_NAMES = ['--bg','--bg-warm','--paper','--ink','--ink-soft','--ink-mute','--rule','--rule-soft','--accent','--accent-soft','--highlight'];
const CUSTOM_KEY = 'marginote.themeCustom';
const REGION_VAR_MAP = {
  rail:    { sel: '.rail',    bg: '--bg-warm', ink: '--ink-soft' },
  sidebar: { sel: '.sidebar', bg: '--bg',      ink: '--ink' },
  editor:  { sel: '.editor',  bg: '--paper',   ink: '--ink-soft' }
};
let currentThemePreset = 'light';

function applyTheme(name) {
  const preset = THEMES[name] || THEMES.light;
  document.body.setAttribute('data-theme', preset.mode);
  THEME_VAR_NAMES.forEach(v => document.body.style.removeProperty(v));
  Object.entries(preset.vars).forEach(([k, v]) => document.body.style.setProperty(k, v));
  currentThemePreset = name;
  localStorage.setItem(THEME_KEY, name);
  // 重新应用区域自定义
  let custom = null;
  try { custom = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null'); } catch {}
  applyCustomOverrides(custom);
  // 标签
  const label = document.getElementById('themeLabel');
  if (label) label.textContent = preset.name;
}

function applyCustomOverrides(c) {
  Object.entries(REGION_VAR_MAP).forEach(([region, { sel, bg, ink }]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.removeProperty(bg);
    el.style.removeProperty(ink);
    if (c) {
      const bgVal = c[region + 'Bg'];
      const inkVal = c[region + 'Ink'];
      if (bgVal) el.style.setProperty(bg, bgVal);
      if (inkVal) el.style.setProperty(ink, inkVal);
    }
  });
}

function getCustomTheme() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null') || {}; } catch { return {}; }
}

function saveCustomTheme(c) {
  if (!c || !Object.keys(c).length) localStorage.removeItem(CUSTOM_KEY);
  else localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
  applyCustomOverrides(Object.keys(c || {}).length ? c : null);
}

function rgbToHex(input) {
  if (!input) return null;
  input = input.trim();
  if (input.startsWith('#')) {
    if (input.length === 4) return '#' + input.slice(1).split('').map(c => c + c).join('');
    return input.slice(0, 7);
  }
  const m = input.match(/rgba?\((\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}

function resolveDefaultColor(key) {
  const region = key.replace(/Bg$|Ink$/, '').toLowerCase();
  const map = REGION_VAR_MAP[region];
  if (!map) return '#000000';
  const el = document.querySelector(map.sel);
  if (!el) return '#000000';
  const cs = getComputedStyle(el);
  const prop = key.endsWith('Bg') ? map.bg : map.ink;
  return rgbToHex(cs.getPropertyValue(prop)) || '#000000';
}

function defaultSwatches(mode) {
  return mode === 'dark'
    ? ['#1a1814', '#221f1a', '#2a2620', '#f4efe6', '#e07a3d']
    : ['#f4efe6', '#ede5d6', '#faf6ed', '#1a1814', '#b8431f'];
}

function renderThemeGrid() {
  const grid = document.getElementById('themeGrid');
  if (!grid) return;
  grid.innerHTML = Object.entries(THEMES).map(([key, t]) => {
    const fallback = defaultSwatches(t.mode);
    const swatches = (Object.keys(t.vars).length === 0)
      ? fallback
      : ['--bg', '--bg-warm', '--paper', '--ink', '--accent'].map((v, i) => t.vars[v] || fallback[i]);
    return `
      <div class="theme-card ${key === currentThemePreset ? 'active' : ''}" data-theme="${key}">
        <div class="theme-card-name">${escapeHtml(t.name)}</div>
        <div class="theme-card-swatches">
          ${swatches.map(c => `<div class="theme-card-swatch" style="background:${c}"></div>`).join('')}
        </div>
      </div>`;
  }).join('');
  grid.querySelectorAll('.theme-card').forEach(el => {
    el.addEventListener('click', () => {
      applyTheme(el.dataset.theme);
      renderThemeGrid();
      // 重新填充自定义输入默认值
      syncCustomInputs();
    });
  });
}

function syncCustomInputs() {
  const c = getCustomTheme();
  ['railBg', 'railInk', 'sidebarBg', 'sidebarInk', 'editorBg', 'editorInk'].forEach(k => {
    const id = 'custom' + k.charAt(0).toUpperCase() + k.slice(1);
    const el = document.getElementById(id);
    if (el) el.value = c[k] || resolveDefaultColor(k);
  });
}

function openThemeModal() {
  renderThemeGrid();
  syncCustomInputs();
  document.getElementById('themeModalBg').classList.add('show');
}

function closeThemeModal() {
  document.getElementById('themeModalBg').classList.remove('show');
}

// ===================== 笔记本操作 =====================
function openNotebookModal(nb) {
  editingNotebook = nb || null;
  document.getElementById('notebookModalTitle').textContent = nb ? '编辑笔记本' : '新建笔记本';
  document.getElementById('notebookNameInput').value = nb ? nb.name : '';
  pickedColor = nb ? nb.color : NOTEBOOK_COLORS[Math.floor(Math.random() * NOTEBOOK_COLORS.length)];
  renderColorPicker();
  document.getElementById('notebookModalBg').classList.add('show');
  setTimeout(() => document.getElementById('notebookNameInput').focus(), 50);
}

function renderColorPicker() {
  const picker = document.getElementById('colorPicker');
  picker.innerHTML = NOTEBOOK_COLORS.map(c =>
    `<div class="color-swatch ${c === pickedColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`
  ).join('');
  picker.querySelectorAll('.color-swatch').forEach(el => {
    el.addEventListener('click', () => {
      pickedColor = el.dataset.color;
      renderColorPicker();
    });
  });
}

function saveNotebook() {
  const name = document.getElementById('notebookNameInput').value.trim();
  if (!name) {
    showToast('请输入笔记本名称');
    return;
  }
  if (editingNotebook) {
    editingNotebook.name = name;
    editingNotebook.color = pickedColor;
    showToast('已更新笔记本');
  } else {
    const nb = { id: uid(), name, color: pickedColor, createdAt: Date.now() };
    notebooks.push(nb);
    showToast(`已创建笔记本「${name}」`);
  }
  saveData();
  renderNotebooks();
  // 如果当前打开的就是这本，更新标题
  if (editingNotebook && currentView === 'nb:' + editingNotebook.id) {
    switchView(currentView);
  }
  document.getElementById('notebookModalBg').classList.remove('show');
  editingNotebook = null;
}

function deleteNotebook(nb) {
  if (!nb) return;
  const noteCount = notes.filter(n => n.notebookId === nb.id && !n.deleted).length;
  const msg = noteCount > 0
    ? `这本笔记本包含 ${noteCount} 篇笔记，删除后这些笔记将被移至「${notebooks.find(x => x.id !== nb.id)?.name || '其他笔记本'}」。`
    : '这本笔记本是空的，将直接删除。';

  showModal(`删除笔记本「${nb.name}」？`, msg, () => {
    // 把笔记迁移到第一个其他笔记本，没有则创建一个默认
    const others = notebooks.filter(x => x.id !== nb.id);
    let target;
    if (others.length > 0) {
      target = others[0];
    } else {
      target = { id: uid(), name: '默认', color: '#525252', createdAt: Date.now() };
      notebooks.push(target);
    }
    notes.forEach(n => {
      if (n.notebookId === nb.id) n.notebookId = target.id;
    });
    // 清理文件夹
    folders = folders.filter(f => f.notebookId !== nb.id);
    notebooks = notebooks.filter(x => x.id !== nb.id);
    saveData();
    if (currentView === 'nb:' + nb.id) switchView('all');
    else { renderNotebooks(); renderNotesList(); }
    showToast('已删除笔记本');
  });
}

// ===================== 文件夹操作 =====================
function openFolderModal(nbId, folder) {
  const nb = getNotebook(nbId);
  if (!nb) return;
  editingFolder = folder || null;
  document.getElementById('folderModalTitle').textContent = folder ? '重命名文件夹' : `新建文件夹 · ${nb.name}`;
  document.getElementById('folderNameInput').value = folder ? folder.name : '';
  document.getElementById('folderModalBg').classList.add('show');
  // 记录归属笔记本
  document.getElementById('folderModalBg').dataset.notebookId = nbId;
  setTimeout(() => document.getElementById('folderNameInput').focus(), 50);
}

function saveFolder() {
  const name = document.getElementById('folderNameInput').value.trim();
  const nbId = document.getElementById('folderModalBg').dataset.notebookId;
  if (!name) { showToast('请输入文件夹名称'); return; }
  if (editingFolder) {
    editingFolder.name = name;
    showToast('已重命名文件夹');
  } else {
    folders.push({ id: uid(), notebookId: nbId, name, createdAt: Date.now() });
    showToast(`已创建文件夹「${name}」`);
  }
  saveData();
  renderNotebooks();
  document.getElementById('folderModalBg').classList.remove('show');
  editingFolder = null;
}

function deleteFolder(folder) {
  if (!folder) return;
  const count = notes.filter(n => n.folderId === folder.id && !n.deleted).length;
  const msg = count > 0
    ? `文件夹「${folder.name}」包含 ${count} 篇笔记，删除后笔记将移出文件夹。`
    : '此文件夹为空，将直接删除。';
  showModal(`删除文件夹「${folder.name}」？`, msg, () => {
    notes.forEach(n => { if (n.folderId === folder.id) n.folderId = null; });
    folders = folders.filter(f => f.id !== folder.id);
    saveData();
    if (currentView === 'folder:' + folder.id) switchView('nb:' + folder.notebookId);
    else { renderNotebooks(); renderNotesList(); }
    showToast('已删除文件夹');
  });
}

function renderTagFilters() {
  const tagSet = new Set();
  notes.filter(n => !n.deleted).forEach(n => (n.tags || []).forEach(t => tagSet.add(t)));
  const tags = Array.from(tagSet).sort();
  const container = document.getElementById('filterTabs');
  container.innerHTML = `<button class="filter-tab ${currentTagFilter === 'all' ? 'active' : ''}" data-tag="all">全部</button>` +
    tags.map(t => `<button class="filter-tab ${currentTagFilter === t ? 'active' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('');

  container.querySelectorAll('.filter-tab').forEach(el => {
    el.addEventListener('click', () => {
      currentTagFilter = el.dataset.tag;
      renderTagFilters();
      renderNotesList();
    });
  });
}

function selectNote(note) {
  currentNote = note;
  currentTodo = null;
  isPreviewMode = true;
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('editorWrap').style.display = 'block';
  document.getElementById('todoEditorWrap').style.display = 'none';
  document.getElementById('app').classList.add('show-editor');

  document.getElementById('titleInput').value = note.title || '';
  document.getElementById('contentInput').value = note.content || '';
  document.getElementById('editorDate').textContent = formatFullDate(note.updatedAt);
  document.getElementById('editorStatus').textContent = '已保存';

  // 笔记本徽标
  const nb = getNotebook(note.notebookId);
  const nbEl = document.getElementById('editorNbBadge');
  if (nb) {
    nbEl.innerHTML = `<span class="nb-dot" style="background:${nb.color}"></span>${escapeHtml(nb.name)}`;
    const folder = getFolder(note.folderId);
    if (folder) nbEl.innerHTML += ` · ${escapeHtml(folder.name)}`;
  } else {
    nbEl.innerHTML = '';
  }

  const starBtn = document.getElementById('starBtn');
  starBtn.classList.toggle('starred', !!note.starred);
  starBtn.setAttribute('data-tip', note.starred ? '取消收藏' : '收藏');

  const modeBtn = document.getElementById('modeBtn');
  modeBtn.classList.add('active');
  modeBtn.setAttribute('data-tip', '编辑');

  // 默认预览模式
  document.getElementById('preview').innerHTML = renderMarkdown(note.content || '');
  document.getElementById('contentInput').style.display = 'none';
  document.getElementById('preview').style.display = 'block';

  renderTags();
  updateWordCount();
  renderNotesList();
}

function renderTags() {
  if (!currentNote) return;
  const wrap = document.getElementById('tagWrap');
  wrap.innerHTML = (currentNote.tags || []).map(t =>
    `<span class="tag-pill">${escapeHtml(t)}<span class="remove" data-tag="${escapeHtml(t)}">×</span></span>`
  ).join('');

  wrap.querySelectorAll('.remove').forEach(el => {
    el.addEventListener('click', () => {
      const tag = el.dataset.tag;
      currentNote.tags = currentNote.tags.filter(t => t !== tag);
      currentNote.updatedAt = Date.now();
      saveNotes();
      renderTags();
      renderTagFilters();
      renderNotesList();
    });
  });
}

function updateWordCount() {
  const text = document.getElementById('contentInput').value;
  // 中英文字数计算
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const english = (text.match(/[a-zA-Z]+/g) || []).length;
  const total = chinese + english;
  document.getElementById('wordCount').innerHTML = `<strong>${total}</strong>字`;
  document.getElementById('readTime').innerHTML = `<strong>${Math.max(1, Math.ceil(total / 300))}</strong>分钟阅读`;
}

// ===================== 笔记操作 =====================
function createNote() {
  // 决定归属笔记本：当前是folder:/nb:视图就用对应笔记本，否则用第一个
  let targetNbId;
  if (currentView.startsWith('folder:')) {
    const f = getFolder(currentView.slice(7));
    targetNbId = f ? f.notebookId : (notebooks[0] ? notebooks[0].id : null);
  } else if (currentView.startsWith('nb:')) {
    targetNbId = currentView.slice(3);
  } else if (notebooks.length > 0) {
    targetNbId = notebooks[0].id;
    // 如果当前不在某本笔记本视图，新建后切换到该本
    if (currentView !== 'all') {
      switchView('all');
    }
  } else {
    // 没有笔记本，创建一个默认
    const nb = { id: uid(), name: '默认', color: '#525252', createdAt: Date.now() };
    notebooks.push(nb);
    targetNbId = nb.id;
    saveData();
    renderNotebooks();
  }

  const note = {
    id: uid(),
    notebookId: targetNbId,
    folderId: currentView.startsWith('folder:') ? currentView.slice(7) : null,
    title: '',
    content: '',
    tags: [],
    starred: false,
    deleted: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  notes.unshift(note);
  saveData();
  selectNote(note);
  renderNotesList();
  renderNotebooks();
  document.getElementById('titleInput').focus();
  showToast('已创建新笔记');
}

function autoSave() {
  if (!currentNote) return;
  document.getElementById('editorStatus').textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    currentNote.title = document.getElementById('titleInput').value;
    currentNote.content = document.getElementById('contentInput').value;
    currentNote.updatedAt = Date.now();
    saveNotes();
    document.getElementById('editorDate').textContent = formatFullDate(currentNote.updatedAt);
    document.getElementById('editorStatus').textContent = '已保存';
    renderNotesList();
  }, 400);
}

function deleteCurrent() {
  if (!currentNote) return;
  const isPermanent = currentNote.deleted;
  showModal(
    isPermanent ? '永久删除？' : '移至回收站？',
    isPermanent ? '此操作将永久删除这篇笔记，无法恢复。' : '笔记将被移至回收站，可在那里恢复或彻底删除。',
    () => {
      if (isPermanent) {
        notes = notes.filter(n => n.id !== currentNote.id);
      } else {
        currentNote.deleted = true;
        currentNote.updatedAt = Date.now();
      }
      saveData();
      currentNote = null;
      document.getElementById('emptyState').style.display = 'flex';
      document.getElementById('editorWrap').style.display = 'none';
      document.getElementById('app').classList.remove('show-editor');
      renderNotesList();
      renderTagFilters();
      renderNotebooks();
      showToast(isPermanent ? '已永久删除' : '已移至回收站');
    }
  );
}

// 移动到笔记本/文件夹菜单
function openMoveMenu(anchor) {
  if (!currentNote) return;
  const menu = document.getElementById('moveMenu');
  menu.innerHTML = `
    <div style="font-family: 'JetBrains Mono', monospace; font-size: 9px; color: var(--ink-mute); letter-spacing: 0.1em; text-transform: uppercase; padding: 8px 12px 6px;">移动到</div>
    ${notebooks.map(nb => {
      const isCurNb = currentNote.notebookId === nb.id;
      const nbFolders = getFoldersByNotebook(nb.id);
      let nbHtml = `
        <button class="rail-item" data-target="${nb.id}" data-target-type="nb" style="margin-bottom: 2px; ${isCurNb && !currentNote.folderId ? 'opacity: 0.5;' : ''}">
          <span class="nb-dot" style="background:${nb.color}"></span>
          <span class="rail-item-label">${escapeHtml(nb.name)}</span>
          ${isCurNb && !currentNote.folderId ? '<span class="rail-item-count">当前</span>' : ''}
        </button>`;
      nbFolders.forEach(f => {
        const isCurF = currentNote.folderId === f.id;
        nbHtml += `
          <button class="rail-folder-item" data-target="${f.id}" data-target-type="folder" style="margin-bottom: 1px; padding-left: 24px; ${isCurF ? 'opacity: 0.5;' : ''}">
            <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" style="width:13px;height:13px;flex-shrink:0">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
            </svg>
            <span class="rail-item-label">${escapeHtml(f.name)}</span>
            ${isCurF ? '<span class="rail-item-count">当前</span>' : ''}
          </button>`;
      });
      return nbHtml;
    }).join('')}
  `;
  const rect = anchor.getBoundingClientRect();
  menu.style.display = 'block';
  const menuRect = menu.getBoundingClientRect();
  menu.style.top = (rect.bottom + 8) + 'px';
  menu.style.left = Math.max(8, rect.right - menuRect.width) + 'px';

  menu.querySelectorAll('button[data-target]').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.dataset.targetType;
      if (type === 'folder') {
        moveCurrentToFolder(el.dataset.target);
      } else {
        moveCurrentToNotebook(el.dataset.target);
      }
      hideMoveMenu();
    });
  });

  setTimeout(() => {
    document.addEventListener('click', _outsideMoveMenu, { once: true });
  }, 0);
}

function _outsideMoveMenu(e) {
  const menu = document.getElementById('moveMenu');
  if (!menu.contains(e.target) && e.target.id !== 'moveBtn' && !e.target.closest('#moveBtn')) {
    hideMoveMenu();
  } else if (menu.contains(e.target) && !e.target.closest('button[data-target]')) {
    document.addEventListener('click', _outsideMoveMenu, { once: true });
  }
}

function hideMoveMenu() {
  document.getElementById('moveMenu').style.display = 'none';
}

function moveCurrentToNotebook(nbId) {
  if (!currentNote || currentNote.notebookId === nbId) return;
  currentNote.notebookId = nbId;
  currentNote.folderId = null; // 移到笔记本根层级
  currentNote.updatedAt = Date.now();
  saveData();
  const nb = getNotebook(nbId);
  const nbEl = document.getElementById('editorNbBadge');
  if (nb) nbEl.innerHTML = `<span class="nb-dot" style="background:${nb.color}"></span>${escapeHtml(nb.name)}`;
  renderNotesList();
  renderNotebooks();
  showToast(`已移至「${nb.name}」`);
}

function moveCurrentToFolder(folderId) {
  if (!currentNote || currentNote.folderId === folderId) return;
  const folder = getFolder(folderId);
  if (!folder) return;
  currentNote.notebookId = folder.notebookId;
  currentNote.folderId = folderId;
  currentNote.updatedAt = Date.now();
  saveData();
  const nb = getNotebook(folder.notebookId);
  const nbEl = document.getElementById('editorNbBadge');
  if (nb) nbEl.innerHTML = `<span class="nb-dot" style="background:${nb.color}"></span>${escapeHtml(nb.name)} · ${escapeHtml(folder.name)}`;
  renderNotesList();
  renderNotebooks();
  showToast(`已移至「${folder.name}」`);
}

function toggleStar() {
  if (!currentNote) return;
  currentNote.starred = !currentNote.starred;
  currentNote.updatedAt = Date.now();
  saveNotes();
  const starBtn = document.getElementById('starBtn');
  starBtn.classList.toggle('starred', !!currentNote.starred);
  starBtn.setAttribute('data-tip', currentNote.starred ? '取消收藏' : '收藏');
  renderNotesList();
  showToast(currentNote.starred ? '已收藏 ★' : '已取消收藏');
}

function togglePreview() {
  if (!currentNote) return;
  isPreviewMode = !isPreviewMode;
  const ta = document.getElementById('contentInput');
  const pv = document.getElementById('preview');
  const modeBtn = document.getElementById('modeBtn');
  if (isPreviewMode) {
    pv.innerHTML = renderMarkdown(ta.value);
    ta.style.display = 'none';
    pv.style.display = 'block';
    modeBtn.classList.add('active');
    modeBtn.setAttribute('data-tip', '编辑');
  } else {
    ta.style.display = '';
    pv.style.display = 'none';
    modeBtn.classList.remove('active');
    modeBtn.setAttribute('data-tip', '预览');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

function copyContent() {
  if (!currentNote) return;
  const text = (currentNote.title ? currentNote.title + '\n\n' : '') + (currentNote.content || '');
  navigator.clipboard.writeText(text).then(() => {
    showToast('已复制到剪贴板 ✓');
  }).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('已复制到剪贴板 ✓');
  });
}

// ===================== Markdown 渲染 (markdown-it + DOMPurify) =====================
let _mdRenderer = null;
function getMdRenderer() {
  if (_mdRenderer) return _mdRenderer;
  if (typeof window.markdownit !== 'function') return null;
  const md = window.markdownit({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false
  });
  const dft = md.renderer.rules.link_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener nofollow');
    return dft(tokens, idx, options, env, self);
  };
  _mdRenderer = md;
  return md;
}

// 协议白名单：http(s) / mailto / tel / ftp / 锚点 / 相对路径 / data:image
const SAFE_URI_RE = /^(?:(?:https?|mailto|tel|ftp):|#|\/|data:image\/(?:png|jpe?g|gif|webp|svg\+xml|bmp))/i;

function renderMarkdown(mdText) {
  if (!mdText) return '<p style="color:var(--ink-mute);font-style:italic">空白页…</p>';

  // 1. img:<id> → data URL
  let processed = mdText.replace(/!\[([^\]]*)\]\(img:([a-z0-9]+)\)/gi, (m, alt, id) => {
    const img = images[id];
    if (!img || !img.dataUrl) return `*[图片缺失:${id}]*`;
    return `![${alt}](${img.dataUrl})`;
  });

  // 2. ==高亮== (markdown-it 不原生支持)
  processed = processed.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

  // 3. markdown-it 渲染（出错回退到转义文本）
  const renderer = getMdRenderer();
  let html;
  if (renderer) {
    try { html = renderer.render(processed); }
    catch (e) { logError(e, 'markdown-render'); html = '<pre>' + escapeHtml(processed) + '</pre>'; }
  } else {
    html = '<pre>' + escapeHtml(processed) + '</pre>';
  }

  // 4. 任务列表 post-process
  html = html
    .replace(/<li>\[ \] /g, '<li class="task-item"><input type="checkbox" disabled> ')
    .replace(/<li>\[x\] /gi, '<li class="task-item"><input type="checkbox" checked disabled> ');

  // 5. DOMPurify XSS 清洗
  if (window.DOMPurify) {
    html = window.DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel'],
      ALLOWED_URI_REGEXP: SAFE_URI_RE,
      FORBID_TAGS: ['style', 'iframe', 'frame', 'object', 'embed', 'form', 'button', 'script'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur']
    });
  }
  return html;
}

function stripMarkdown(md) {
  return (md || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*`>\-\[\]\(\)]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

// ===================== 工具函数 =====================
function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMs / 3600000);
  const diffD = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffH < 24) return `${diffH}小时前`;
  if (diffD < 7) return `${diffD}天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatFullDate(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

function showModal(title, text, callback) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').textContent = text;
  document.getElementById('modalBg').classList.add('show');
  modalCallback = callback;
}

// ===================== 工具栏格式化 =====================
function applyFormat(format) {
  if (format === 'image') {
    document.getElementById('imageFileInput').click();
    return;
  }
  const ta = document.getElementById('contentInput');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.substring(start, end);
  const before = ta.value.substring(0, start);
  const after = ta.value.substring(end);
  let newText = '';
  let cursorOffset = 0;

  const lineStart = before.lastIndexOf('\n') + 1;
  const linePrefix = before.substring(lineStart);

  switch (format) {
    case 'h1': newText = `# ${sel || '标题'}`; break;
    case 'h2': newText = `## ${sel || '标题'}`; break;
    case 'h3': newText = `### ${sel || '标题'}`; break;
    case 'bold': newText = `**${sel || '加粗文本'}**`; cursorOffset = sel ? 0 : -2; break;
    case 'italic': newText = `*${sel || '斜体文本'}*`; cursorOffset = sel ? 0 : -1; break;
    case 'code': newText = `\`${sel || '代码'}\``; break;
    case 'quote': newText = `> ${sel || '引用文字'}`; break;
    case 'list': newText = `- ${sel || '列表项'}`; break;
    case 'checkbox': newText = `- [ ] ${sel || '待办事项'}`; break;
    case 'link': newText = `[${sel || '链接文字'}](https://)`; break;
    case 'hr': newText = `\n---\n`; break;
  }

  ta.value = before + newText + after;
  const newPos = start + newText.length + cursorOffset;
  ta.setSelectionRange(newPos, newPos);
  ta.focus();
  autoSave();
  updateWordCount();
}

function insertAtCursor(ta, text) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
  const pos = start + text.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function detectExtFromDataUrl(dataUrl) {
  const m = (dataUrl || '').match(/^data:image\/([a-z0-9+.\-]+);/i);
  if (!m) return '.png';
  let ext = m[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (ext === 'svg+xml') ext = 'svg';
  return '.' + ext;
}

function mimeFromExt(ext) {
  const map = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp' };
  return map[(ext || '').toLowerCase()] || 'image/png';
}

async function handleImageInsert(file, target) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const dataUrl = await readFileAsDataURL(file);
    const id = uid();
    const ext = detectExtFromDataUrl(dataUrl);
    const baseName = (file.name || 'image' + ext).replace(/[\[\]()]/g, '');
    images[id] = { name: baseName, dataUrl, ext, createdAt: Date.now() };
    persistImage(id); // 异步写 IDB
    // 短引用，避免编辑区显示长 base64
    const md = `\n![${baseName}](img:${id})\n`;
    if (target === 'todo') {
      const ta = document.getElementById('todoEditContent');
      insertAtCursor(ta, md);
      autoSaveTodo();
      if (isTodoPreviewMode) {
        document.getElementById('todoPreview').innerHTML = renderMarkdown(ta.value);
      }
    } else {
      const ta = document.getElementById('contentInput');
      insertAtCursor(ta, md);
      autoSave();
      updateWordCount();
      if (isPreviewMode) {
        document.getElementById('preview').innerHTML = renderMarkdown(ta.value);
      }
    }
  } catch (e) {
    showToast('图片插入失败');
  }
}

// 内容引用回写为 data URL 或相对路径
function expandImageRefs(content, opts) {
  opts = opts || { mode: 'inline' };
  return (content || '').replace(/!\[([^\]]*)\]\(img:([a-z0-9]+)\)/gi, (m, alt, id) => {
    const img = images[id];
    if (!img) return m;
    if (opts.mode === 'zip') {
      const ext = img.ext || detectExtFromDataUrl(img.dataUrl);
      return `![${alt}](${opts.prefix || ''}_assets/${id}${ext})`;
    }
    return `![${alt}](${img.dataUrl})`;
  });
}

// 把 data URL / 相对路径资产引用转回 img:<id>
function ingestImageDataUrls(content) {
  return (content || '').replace(/!\[([^\]]*)\]\((data:image\/[a-z0-9+.\-]+;base64,[^\s)]+)\)/gi, (m, alt, dataUrl) => {
    const id = uid();
    const ext = detectExtFromDataUrl(dataUrl);
    images[id] = { name: alt || ('image' + ext), dataUrl, ext, createdAt: Date.now() };
    persistImage(id);
    return `![${alt}](img:${id})`;
  });
}

function ingestAssetPathRefs(content) {
  return (content || '').replace(/!\[([^\]]*)\]\((?:\.\.\/)*_assets\/([a-z0-9]+)\.[a-z0-9]+\)/gi, (m, alt, id) => {
    return `![${alt}](img:${id})`;
  });
}

function attachImagePaste(textareaId, target) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  ta.addEventListener('paste', e => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          handleImageInsert(blob, target);
          return;
        }
      }
    }
  });
  ta.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      files.forEach(f => handleImageInsert(f, target));
    }
  });
}

// ===================== 文件名 / Front-matter / Markdown 互转 =====================
function safeName(s) {
  return String(s || 'untitled')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
}

function noteToMarkdown(note, opts) {
  opts = opts || { mode: 'inline' };
  const nb = getNotebook(note.notebookId);
  const folder = getFolder(note.folderId);
  const lines = [
    '---',
    `title: ${(note.title || '无题').replace(/\n/g, ' ')}`,
    nb ? `notebook: ${nb.name}` : '',
    folder ? `folder: ${folder.name}` : '',
    `tags: [${(note.tags || []).map(t => JSON.stringify(t)).join(', ')}]`,
    `starred: ${!!note.starred}`,
    `createdAt: ${new Date(note.createdAt).toISOString()}`,
    `updatedAt: ${new Date(note.updatedAt).toISOString()}`,
    `id: ${note.id}`,
    '---',
    ''
  ].filter(Boolean);
  const body = expandImageRefs(note.content || '', opts);
  return lines.join('\n') + '\n' + body;
}

function parseMarkdownFile(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, content: text };
  const meta = {};
  m[1].split('\n').forEach(line => {
    const i = line.indexOf(':');
    if (i <= 0) return;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (k === 'tags') {
      try { meta.tags = JSON.parse(v.replace(/'/g, '"')); }
      catch { meta.tags = v.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean); }
    } else if (k === 'starred') {
      meta.starred = v === 'true';
    } else {
      meta[k] = v;
    }
  });
  return { meta, content: m[2] };
}

function ensureNotebookByName(name, color) {
  if (!name) return notebooks[0];
  let nb = notebooks.find(x => x.name === name);
  if (!nb) {
    nb = { id: uid(), name, color: color || NOTEBOOK_COLORS[notebooks.length % NOTEBOOK_COLORS.length], createdAt: Date.now() };
    notebooks.push(nb);
  }
  return nb;
}

function ensureFolderByName(nbId, name) {
  if (!name) return null;
  let f = folders.find(x => x.notebookId === nbId && x.name === name);
  if (!f) {
    f = { id: uid(), notebookId: nbId, name, createdAt: Date.now() };
    folders.push(f);
  }
  return f;
}

// ===================== 导入导出 =====================
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportNoteAsMarkdown(note) {
  if (!note) return;
  const md = noteToMarkdown(note);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, safeName(note.title || 'untitled') + '.md');
  showToast('已导出为 Markdown');
}

async function exportAll() {
  if (typeof JSZip === 'undefined') {
    showToast('JSZip 未加载，无法压缩导出');
    return;
  }
  const zip = new JSZip();
  const aliveNotes = notes.filter(n => !n.deleted);
  const usedNames = new Map();
  const usedImgIds = new Set();

  aliveNotes.forEach(n => {
    const nb = getNotebook(n.notebookId);
    const folder = getFolder(n.folderId);
    let dirParts = [];
    if (nb) dirParts.push(safeName(nb.name));
    if (folder) dirParts.push(safeName(folder.name));
    const dir = dirParts.join('/');
    let fileBase = safeName(n.title || 'untitled');
    let key = dir + '/' + fileBase;
    let count = usedNames.get(key) || 0;
    if (count > 0) fileBase = fileBase + '-' + (count + 1);
    usedNames.set(key, count + 1);
    const path = (dir ? dir + '/' : '') + fileBase + '.md';
    const depth = dirParts.length;
    const prefix = '../'.repeat(depth);
    // 收集引用的图片 id
    (n.content || '').replace(/!\[[^\]]*\]\(img:([a-z0-9]+)\)/gi, (_, id) => { usedImgIds.add(id); return ''; });
    zip.file(path, noteToMarkdown(n, { mode: 'zip', prefix }));
  });

  // 写入资产
  usedImgIds.forEach(id => {
    const img = images[id];
    if (!img || !img.dataUrl) return;
    const m = img.dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (!m) return;
    const ext = img.ext || detectExtFromDataUrl(img.dataUrl);
    zip.file('_assets/' + id + ext, m[1], { base64: true });
  });

  // 元信息（含被回收笔记 + 笔记本/文件夹/待办 + 完整 images 供回写）
  zip.file('_marginote_meta.json', JSON.stringify({
    exportedAt: new Date().toISOString(),
    notebooks, folders, todos,
    deletedNotes: notes.filter(n => n.deleted),
    imagesMeta: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, { name: v.name, ext: v.ext, createdAt: v.createdAt }]))
  }, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `marginote-backup-${new Date().toISOString().slice(0,10)}.zip`);
  showToast(`已导出 ${aliveNotes.length} 篇笔记 + ${usedImgIds.size} 张图`);
}

function importFiles(files) {
  if (!files || !files.length) return;
  let pending = files.length;
  let added = 0;
  const done = () => {
    saveData();
    renderNotebooks();
    renderTagFilters();
    renderNotesList();
    renderTodoCounts();
    showToast(`已导入 ${added} 篇`);
  };
  Array.from(files).forEach(file => {
    const name = file.name.toLowerCase();
    const reader = new FileReader();
    if (name.endsWith('.zip')) {
      reader.onload = async e => {
        try {
          const zip = await JSZip.loadAsync(e.target.result);
          const meta = zip.file('_marginote_meta.json');
          let imagesMeta = {};
          if (meta) {
            try {
              const obj = JSON.parse(await meta.async('string'));
              if (Array.isArray(obj.notebooks)) {
                obj.notebooks.forEach(nb => {
                  if (!notebooks.find(x => x.id === nb.id || x.name === nb.name)) notebooks.push(nb);
                });
              }
              if (Array.isArray(obj.folders)) {
                obj.folders.forEach(f => {
                  if (!folders.find(x => x.id === f.id)) folders.push(f);
                });
              }
              if (Array.isArray(obj.todos)) {
                obj.todos.forEach(t => {
                  if (!todos.find(x => x.id === t.id)) todos.push(t);
                });
              }
              if (Array.isArray(obj.deletedNotes)) {
                obj.deletedNotes.forEach(n => {
                  if (!notes.find(x => x.id === n.id)) notes.push(n);
                });
              }
              if (obj.imagesMeta && typeof obj.imagesMeta === 'object') imagesMeta = obj.imagesMeta;
            } catch {}
          }
          // 资产目录读入 images 映射
          const assetEntries = Object.keys(zip.files).filter(p => !zip.files[p].dir && p.toLowerCase().startsWith('_assets/'));
          for (const path of assetEntries) {
            const filename = path.split('/').pop();
            const id = filename.replace(/\.[^.]+$/, '');
            const ext = '.' + (filename.split('.').pop() || 'png');
            const b64 = await zip.files[path].async('base64');
            const mime = mimeFromExt(ext);
            const metaInfo = imagesMeta[id] || {};
            images[id] = {
              name: metaInfo.name || filename,
              ext: metaInfo.ext || ext,
              createdAt: metaInfo.createdAt || Date.now(),
              dataUrl: `data:${mime};base64,${b64}`
            };
          }
          const entries = Object.keys(zip.files).filter(p => !zip.files[p].dir && p.toLowerCase().endsWith('.md'));
          for (const path of entries) {
            const text = await zip.files[path].async('string');
            const { meta, content } = parseMarkdownFile(text);
            const segs = path.split('/').filter(Boolean);
            const nbName = meta.notebook || (segs.length > 1 ? segs[0] : null);
            const folderName = meta.folder || (segs.length > 2 ? segs[1] : null);
            const nb = ensureNotebookByName(nbName);
            const folder = folderName ? ensureFolderByName(nb.id, folderName) : null;
            // 资产路径 / data URL 都转回 img:<id>
            let body = ingestAssetPathRefs(content);
            body = ingestImageDataUrls(body);
            const note = {
              id: meta.id || uid(),
              notebookId: nb.id,
              folderId: folder ? folder.id : null,
              title: meta.title || segs[segs.length - 1].replace(/\.md$/i, ''),
              content: body,
              tags: Array.isArray(meta.tags) ? meta.tags : [],
              starred: !!meta.starred,
              deleted: false,
              createdAt: meta.createdAt ? new Date(meta.createdAt).getTime() : Date.now(),
              updatedAt: meta.updatedAt ? new Date(meta.updatedAt).getTime() : Date.now()
            };
            if (!notes.find(x => x.id === note.id)) {
              notes.push(note);
              added++;
            }
          }
        } catch (err) {
          showToast('压缩包解析失败');
        }
        if (--pending === 0) done();
      };
      reader.readAsArrayBuffer(file);
    } else if (name.endsWith('.md') || name.endsWith('.markdown')) {
      reader.onload = e => {
        try {
          const { meta, content } = parseMarkdownFile(e.target.result);
          const nb = ensureNotebookByName(meta.notebook) || notebooks[0];
          const folder = meta.folder ? ensureFolderByName(nb.id, meta.folder) : null;
          const body = ingestImageDataUrls(ingestAssetPathRefs(content));
          const note = {
            id: meta.id || uid(),
            notebookId: nb.id,
            folderId: folder ? folder.id : null,
            title: meta.title || file.name.replace(/\.(md|markdown)$/i, ''),
            content: body,
            tags: Array.isArray(meta.tags) ? meta.tags : [],
            starred: !!meta.starred,
            deleted: false,
            createdAt: meta.createdAt ? new Date(meta.createdAt).getTime() : Date.now(),
            updatedAt: meta.updatedAt ? new Date(meta.updatedAt).getTime() : Date.now()
          };
          if (!notes.find(x => x.id === note.id)) { notes.push(note); added++; }
        } catch { showToast('Markdown 解析失败'); }
        if (--pending === 0) done();
      };
      reader.readAsText(file);
    } else if (name.endsWith('.json')) {
      reader.onload = e => {
        try {
          const data = JSON.parse(e.target.result);
          const incoming = Array.isArray(data) ? data : data.notes;
          if (!Array.isArray(incoming)) throw new Error('格式错误');
          const existingIds = new Set(notes.map(n => n.id));
          incoming.forEach(n => {
            if (!existingIds.has(n.id)) { notes.push(n); added++; }
          });
        } catch { showToast('JSON 解析失败'); }
        if (--pending === 0) done();
      };
      reader.readAsText(file);
    } else {
      if (--pending === 0) done();
    }
  });
}

// 兼容旧调用
function importFile(file) { importFiles([file]); }

// ===================== AI 优化 =====================
const AI_STORAGE_KEY = 'marginote.ai';
const AI_UNDO_KEY = 'marginote.aiUndo';
const AI_PRESETS = [
  { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  { name: 'Kimi (Moonshot)', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  { name: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
  { name: '通义千问 (DashScope)', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  { name: '本地 Ollama', endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.2' },
  { name: '自定义', endpoint: '', model: '' }
];
const AI_ACTIONS = [
  { id: 'polish',      label: '✨ 润色优化',     mode: 'replace', system: '你是中文写作助手。请优化下面这段内容的语言表达，使其更清晰、流畅、专业，但保留原意和 Markdown 格式。直接返回优化后的全部内容，不要任何前后缀说明。' },
  { id: 'summarize',   label: '📝 总结要点',     mode: 'replace', system: '请将下面的内容总结为简洁的 Markdown 要点列表，保留关键信息。直接返回总结结果。' },
  { id: 'expand',      label: '📖 扩写丰富',     mode: 'replace', system: '请扩写下面的内容，添加细节、举例和说明，使其更丰富完整。保留 Markdown 格式。直接返回扩写后的全文。' },
  { id: 'continue',    label: '✍️ 智能续写',     mode: 'append',  system: '请基于下面的内容自然地往下续写一段，保持风格和语气一致。只返回续写部分，不要重复原文。' },
  { id: 'grammar',     label: '🩹 修正语法错字', mode: 'replace', system: '请修正下面内容中的语法错误、错别字和标点问题，但保留原文风格、语气和 Markdown 格式。直接返回修正后的全文。' },
  { id: 'translateEn', label: '🌐 翻译为英文',   mode: 'replace', system: 'Translate the following text into natural, fluent English. Preserve markdown formatting. Output only the translation.' },
  { id: 'translateZh', label: '🇨🇳 翻译为中文',   mode: 'replace', system: '请将下面的内容翻译为自然流畅的中文，保留 Markdown 格式。直接返回翻译。' },
  { id: 'custom',      label: '⚙ 自定义指令…',   mode: 'custom' }
];

let aiConfig = { providers: [], activeId: null };
let aiUndoStore = {};
let aiEditingProviderId = null;

function loadAiConfig() {
  try { aiConfig = JSON.parse(localStorage.getItem(AI_STORAGE_KEY)) || { providers: [], activeId: null }; }
  catch { aiConfig = { providers: [], activeId: null }; }
  if (!aiConfig.providers) aiConfig.providers = [];
  try { aiUndoStore = JSON.parse(localStorage.getItem(AI_UNDO_KEY)) || {}; }
  catch { aiUndoStore = {}; }
}

function saveAiConfig() {
  localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(aiConfig));
}

function saveAiUndo() {
  localStorage.setItem(AI_UNDO_KEY, JSON.stringify(aiUndoStore));
}

function getActiveProvider() {
  return aiConfig.providers.find(p => p.id === aiConfig.activeId) || null;
}

function renderAiProviderList() {
  const wrap = document.getElementById('aiProviderList');
  if (!aiConfig.providers.length) {
    wrap.innerHTML = '<div style="padding:16px;color:var(--ink-mute);font-style:italic;text-align:center;font-size:13px;">尚未配置任何模型，从下方选择预设新增</div>';
    return;
  }
  wrap.innerHTML = aiConfig.providers.map(p => `
    <div class="ai-provider ${p.id === aiConfig.activeId ? 'active' : ''}" data-id="${p.id}">
      <input type="radio" name="aiActive" data-active="${p.id}" ${p.id === aiConfig.activeId ? 'checked' : ''}>
      <div>
        <div class="name">${escapeHtml(p.name || '未命名')}</div>
        <div class="meta">${escapeHtml(p.model || '?')} · ${escapeHtml(p.endpoint || '')}</div>
      </div>
      <div class="ai-provider-actions">
        <button data-act="edit" data-id="${p.id}">编辑</button>
        <button data-act="del" data-id="${p.id}">删除</button>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('input[type=radio][data-active]').forEach(el => {
    el.addEventListener('change', () => {
      aiConfig.activeId = el.dataset.active;
      saveAiConfig();
      renderAiProviderList();
    });
  });
  wrap.querySelectorAll('button[data-act=edit]').forEach(el => {
    el.addEventListener('click', () => openAiProviderForm(el.dataset.id));
  });
  wrap.querySelectorAll('button[data-act=del]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const p = aiConfig.providers.find(x => x.id === id);
      if (!p) return;
      showModal(`删除「${p.name}」？`, '此操作将删除该模型配置，无法恢复。', () => {
        aiConfig.providers = aiConfig.providers.filter(x => x.id !== id);
        if (aiConfig.activeId === id) aiConfig.activeId = aiConfig.providers[0]?.id || null;
        saveAiConfig();
        renderAiProviderList();
        if (typeof syncProxyToBackground === 'function') syncProxyToBackground();
      });
    });
  });
}

function renderAiPresetSelect() {
  const sel = document.getElementById('aiPresetSelect');
  sel.innerHTML = AI_PRESETS.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
}

function openAiProviderForm(id) {
  const form = document.getElementById('aiProviderForm');
  aiEditingProviderId = id || null;
  let p;
  if (id) {
    p = aiConfig.providers.find(x => x.id === id);
    if (!p) return;
  } else {
    const presetIdx = parseInt(document.getElementById('aiPresetSelect').value, 10) || 0;
    const preset = AI_PRESETS[presetIdx];
    p = { name: preset.name, endpoint: preset.endpoint, model: preset.model, apiKey: '', system: '', temperature: 0.7, proxyPrefix: '' };
  }
  document.getElementById('aiFormName').value = p.name || '';
  document.getElementById('aiFormEndpoint').value = p.endpoint || '';
  document.getElementById('aiFormModel').value = p.model || '';
  document.getElementById('aiFormKey').value = p.apiKey || '';
  document.getElementById('aiFormProxy').value = p.proxyPrefix || '';
  document.getElementById('aiFormSystem').value = p.system || '';
  document.getElementById('aiFormTemp').value = p.temperature ?? 0.7;
  form.classList.add('show');
}

function closeAiProviderForm() {
  document.getElementById('aiProviderForm').classList.remove('show');
  aiEditingProviderId = null;
}

function saveAiProviderForm() {
  const name = document.getElementById('aiFormName').value.trim();
  const endpoint = document.getElementById('aiFormEndpoint').value.trim();
  const model = document.getElementById('aiFormModel').value.trim();
  const apiKey = document.getElementById('aiFormKey').value;
  const proxyPrefix = document.getElementById('aiFormProxy').value.trim();
  const system = document.getElementById('aiFormSystem').value;
  const temperature = parseFloat(document.getElementById('aiFormTemp').value);
  if (!name) { showToast('请填写名称'); return; }
  if (!endpoint) { showToast('请填写接口地址'); return; }
  if (!model) { showToast('请填写模型 ID'); return; }
  const fields = { name, endpoint, model, apiKey, proxyPrefix, system, temperature: isNaN(temperature) ? 0.7 : temperature };
  if (aiEditingProviderId) {
    const p = aiConfig.providers.find(x => x.id === aiEditingProviderId);
    if (p) Object.assign(p, fields);
  } else {
    const p = Object.assign({ id: uid() }, fields);
    aiConfig.providers.push(p);
    if (!aiConfig.activeId) aiConfig.activeId = p.id;
  }
  saveAiConfig();
  renderAiProviderList();
  closeAiProviderForm();
  if (typeof syncProxyToBackground === 'function') syncProxyToBackground();
  showToast('已保存');
}

function openAiSettings() {
  renderAiPresetSelect();
  renderAiProviderList();
  closeAiProviderForm();
  document.getElementById('aiModalBg').classList.add('show');
}

function closeAiSettings() {
  document.getElementById('aiModalBg').classList.remove('show');
}

// 解析代理 URL：HTTP/HTTPS/SOCKS（含 user:pass auth）→ chrome.proxy；否则视为 URL 反代
function parseProxyUrl(input) {
  const url = (input || '').trim();
  if (!url) return { kind: 'none' };
  if (url.includes('{url}') || url.includes('{ENDPOINT}')) return { kind: 'rewrite' };
  try {
    const u = new URL(url);
    // 仅根路径 + 无查询 → 视为 HTTP 代理
    if ((u.pathname === '/' || u.pathname === '') && !u.search) {
      let scheme = 'PROXY';
      if (u.protocol === 'https:') scheme = 'HTTPS';
      else if (u.protocol === 'socks5:' || u.protocol === 'socks:') scheme = 'SOCKS5';
      else if (u.protocol === 'socks4:') scheme = 'SOCKS4';
      const port = u.port || (u.protocol === 'https:' ? '443' : (scheme.startsWith('SOCKS') ? '1080' : '80'));
      return {
        kind: 'http',
        scheme,
        host: u.hostname,
        port,
        user: u.username ? decodeURIComponent(u.username) : '',
        pass: u.password ? decodeURIComponent(u.password) : ''
      };
    }
  } catch {}
  return { kind: 'rewrite' };
}

function resolveAiUrl(provider) {
  const proxy = (provider.proxyPrefix || '').trim();
  const endpoint = provider.endpoint;
  if (!proxy) return endpoint;
  // HTTP 代理走 chrome.proxy，本函数返回原 endpoint
  if (parseProxyUrl(proxy).kind === 'http') return endpoint;
  // URL 反代
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(endpoint));
  if (proxy.includes('{ENDPOINT}')) return proxy.replace('{ENDPOINT}', endpoint);
  if (/[=?]$/.test(proxy)) return proxy + encodeURIComponent(endpoint);
  return proxy.replace(/\/$/, '') + (endpoint.startsWith('/') ? '' : '/') + endpoint.replace(/^https?:\/\//, '');
}

function buildProxyRules() {
  const rules = [];
  (aiConfig.providers || []).forEach(p => {
    const parsed = parseProxyUrl(p.proxyPrefix);
    if (parsed.kind !== 'http') return;
    let providerHost;
    try { providerHost = new URL(p.endpoint).hostname; } catch { return; }
    rules.push({
      providerHost,
      proxyHost: parsed.host,
      proxyPort: parsed.port,
      scheme: parsed.scheme,
      user: parsed.user,
      pass: parsed.pass
    });
  });
  return rules;
}

async function syncProxyToBackground() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  const rules = buildProxyRules();
  try {
    if (rules.length) {
      const res = await chrome.runtime.sendMessage({ type: 'applyProxyRules', rules });
      if (res && res.error) { logError(new Error(res.error), 'apply-proxy'); showToast('代理应用失败：' + res.error); }
    } else {
      await chrome.runtime.sendMessage({ type: 'clearProxy' });
    }
  } catch (e) { logError(e, 'sync-proxy'); }
}

async function callAi(messages, opts) {
  const p = getActiveProvider();
  if (!p) throw new Error('未配置 AI 模型，请先在 AI 设置中添加');
  const body = {
    model: p.model,
    messages,
    temperature: opts?.temperature ?? p.temperature ?? 0.7,
    stream: false
  };
  const url = resolveAiUrl(p);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (p.apiKey || '')
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('返回数据缺少 choices[0].message.content');
  return content.trim();
}

function aiUndoKeyForCurrent() {
  if (currentTodo) return 'todo:' + currentTodo.id;
  if (currentNote) return 'note:' + currentNote.id;
  return null;
}

function pushAiUndoSnapshot(target, snapshot) {
  if (!target) return;
  if (!aiUndoStore[target]) aiUndoStore[target] = [];
  aiUndoStore[target].push(snapshot);
  if (aiUndoStore[target].length > 10) aiUndoStore[target].shift();
  saveAiUndo();
}

function popAiUndoSnapshot(target) {
  if (!target || !aiUndoStore[target] || !aiUndoStore[target].length) return null;
  const snap = aiUndoStore[target].pop();
  if (!aiUndoStore[target].length) delete aiUndoStore[target];
  saveAiUndo();
  return snap;
}

function hasAiUndo(target) {
  return !!(target && aiUndoStore[target] && aiUndoStore[target].length);
}

function setAiBusy(busy) {
  document.querySelectorAll('.ai-btn').forEach(b => b.classList.toggle('busy', !!busy));
}

async function runAiAction(action) {
  const provider = getActiveProvider();
  if (!provider) {
    showToast('未配置 AI 模型');
    openAiSettings();
    return;
  }
  const isTodo = !!currentTodo;
  const isNote = !!currentNote;
  if (!isTodo && !isNote) { showToast('请先选择笔记或待办'); return; }

  let userInstruction = '';
  let actionDef = action;
  if (action.id === 'custom') {
    const ins = window.prompt('请输入对当前内容的自定义指令：', '请把这段内容改写得更精炼。');
    if (!ins) return;
    userInstruction = ins;
    actionDef = { id: 'custom', mode: 'replace', system: ins };
  }

  // 取目标内容
  let title, content, target;
  if (isTodo) {
    title = currentTodo.text || '';
    content = currentTodo.content || '';
    target = 'todo:' + currentTodo.id;
  } else {
    title = currentNote.title || '';
    content = currentNote.content || '';
    target = 'note:' + currentNote.id;
  }

  const userPayload = (title ? `标题：${title}\n\n` : '') + (content || '(空)');
  const messages = [];
  const sysParts = [];
  if (provider.system) sysParts.push(provider.system);
  if (actionDef.system) sysParts.push(actionDef.system);
  if (sysParts.length) messages.push({ role: 'system', content: sysParts.join('\n\n') });
  messages.push({ role: 'user', content: userPayload });

  setAiBusy(true);
  showToast('AI 处理中…');
  try {
    const reply = await callAi(messages);
    // 快照
    pushAiUndoSnapshot(target, { title, content, ts: Date.now() });
    if (isTodo) {
      if (actionDef.mode === 'append') {
        currentTodo.content = (content ? content + '\n\n' : '') + reply;
      } else {
        currentTodo.content = reply;
      }
      saveData();
      // 刷新 UI
      document.getElementById('todoEditContent').value = currentTodo.content;
      if (isTodoPreviewMode) {
        document.getElementById('todoPreview').innerHTML = renderMarkdown(currentTodo.content);
      }
      document.getElementById('todoEditStatus').textContent = '已保存 · AI 已应用';
      renderTodos();
    } else {
      if (actionDef.mode === 'append') {
        currentNote.content = (content ? content + '\n\n' : '') + reply;
      } else {
        currentNote.content = reply;
      }
      currentNote.updatedAt = Date.now();
      saveData();
      document.getElementById('contentInput').value = currentNote.content;
      if (isPreviewMode) {
        document.getElementById('preview').innerHTML = renderMarkdown(currentNote.content);
      }
      document.getElementById('editorStatus').textContent = '已保存 · AI 已应用';
      updateWordCount();
      renderNotesList();
    }
    showToast('AI 已优化 ✓ 可在 AI 菜单撤销');
  } catch (e) {
    logError(e, 'ai-action:' + (actionDef.id || 'unknown'));
    showToast('AI 失败：' + (e.message || e));
  } finally {
    setAiBusy(false);
  }
}

function undoAi() {
  const target = aiUndoKeyForCurrent();
  if (!target) return;
  const snap = popAiUndoSnapshot(target);
  if (!snap) { showToast('无可撤销的 AI 操作'); return; }
  if (target.startsWith('todo:') && currentTodo) {
    currentTodo.text = snap.title || currentTodo.text;
    currentTodo.content = snap.content || '';
    saveData();
    document.getElementById('todoEditTitle').value = currentTodo.text;
    document.getElementById('todoEditContent').value = currentTodo.content;
    if (isTodoPreviewMode) {
      document.getElementById('todoPreview').innerHTML = renderMarkdown(currentTodo.content);
    }
    renderTodos();
  } else if (target.startsWith('note:') && currentNote) {
    currentNote.title = snap.title || currentNote.title;
    currentNote.content = snap.content || '';
    currentNote.updatedAt = Date.now();
    saveData();
    document.getElementById('titleInput').value = currentNote.title;
    document.getElementById('contentInput').value = currentNote.content;
    if (isPreviewMode) {
      document.getElementById('preview').innerHTML = renderMarkdown(currentNote.content);
    }
    updateWordCount();
    renderNotesList();
  }
  showToast('已撤销 AI 修改');
}

function openAiMenu(anchor) {
  const menu = document.getElementById('aiMenu');
  const target = aiUndoKeyForCurrent();
  const undoCount = (target && aiUndoStore[target]) ? aiUndoStore[target].length : 0;
  const provider = getActiveProvider();
  const providerLabel = provider ? `${provider.name} · ${provider.model}` : '未配置';
  menu.innerHTML = `
    <div class="ai-menu-title">AI · ${escapeHtml(providerLabel)}</div>
    ${AI_ACTIONS.map(a => `<button data-action="${a.id}">${a.label}</button>`).join('')}
    <div class="ai-menu-divider"></div>
    <button class="ai-undo" data-action="undo" ${undoCount ? '' : 'disabled'}>↶ 撤销 AI (${undoCount})</button>
    <button data-action="settings">⚙ AI 设置</button>
  `;
  const rect = anchor.getBoundingClientRect();
  menu.classList.add('show');
  const mr = menu.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - mr.width - 8, rect.right - mr.width)) + 'px';

  menu.querySelectorAll('button[data-action]').forEach(el => {
    el.addEventListener('click', () => {
      const act = el.dataset.action;
      hideAiMenu();
      if (act === 'settings') { openAiSettings(); return; }
      if (act === 'undo') { undoAi(); return; }
      const action = AI_ACTIONS.find(x => x.id === act);
      if (action) runAiAction(action);
    });
  });

  setTimeout(() => document.addEventListener('click', _outsideAiMenu, { once: true }), 0);
}

function _outsideAiMenu(e) {
  const menu = document.getElementById('aiMenu');
  if (!menu.contains(e.target) && !e.target.closest('.ai-btn')) hideAiMenu();
  else if (menu.contains(e.target) && !e.target.closest('button[data-action]')) {
    document.addEventListener('click', _outsideAiMenu, { once: true });
  }
}

function hideAiMenu() {
  document.getElementById('aiMenu').classList.remove('show');
}

async function testAiProvider() {
  if (!getActiveProvider()) { showToast('请先选择当前模型'); return; }
  showToast('测试中…');
  try {
    const reply = await callAi([
      { role: 'system', content: '你是一个测试助手。' },
      { role: 'user', content: '请回复"连接正常"四个字。' }
    ]);
    showToast('✓ 测试成功：' + reply.slice(0, 30));
  } catch (e) {
    showToast('测试失败：' + (e.message || e));
  }
}

// ===================== 扩展环境 + 提醒 =====================
function isExtensionContext() {
  return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id) && !!chrome.alarms;
}

function syncRemindersToExt() {
  if (!isExtensionContext()) return;
  const data = todos.filter(t => !t.done && t.dueDate).map(t => ({
    id: t.id, text: t.text, dueDate: t.dueDate, done: t.done,
    remindBeforeMin: t.remindBeforeMin || 0,
    remindCount: t.remindCount || 1,
    remindIntervalMin: t.remindIntervalMin || 5
  }));
  try { chrome.storage.local.set({ marginoteTodos: data }); } catch (e) {}
}

function scheduleTodoReminders(t) {
  if (!isExtensionContext()) return;
  chrome.alarms.getAll(all => {
    all.filter(a => a.name.startsWith(`mtodo:${t.id}:`)).forEach(a => chrome.alarms.clear(a.name));
    if (t.done || !t.dueDate || !t.remindBeforeMin) { syncRemindersToExt(); return; }
    const count = Math.max(1, t.remindCount || 1);
    const interval = Math.max(1, t.remindIntervalMin || 5);
    for (let i = 0; i < count; i++) {
      const offsetMin = t.remindBeforeMin - i * interval;
      const when = t.dueDate - offsetMin * 60000;
      if (when > Date.now()) chrome.alarms.create(`mtodo:${t.id}:${i}`, { when });
    }
    syncRemindersToExt();
  });
}

function rescheduleAllAlarms() {
  if (!isExtensionContext()) return;
  chrome.alarms.getAll(all => {
    all.filter(a => a.name.startsWith('mtodo:')).forEach(a => chrome.alarms.clear(a.name));
    todos.forEach(t => {
      if (t.done || !t.dueDate || !t.remindBeforeMin) return;
      const count = Math.max(1, t.remindCount || 1);
      const interval = Math.max(1, t.remindIntervalMin || 5);
      for (let i = 0; i < count; i++) {
        const offsetMin = t.remindBeforeMin - i * interval;
        const when = t.dueDate - offsetMin * 60000;
        if (when > Date.now()) chrome.alarms.create(`mtodo:${t.id}:${i}`, { when });
      }
    });
    syncRemindersToExt();
  });
}

// ===================== 存储 / 备份 =====================
const AUTO_BACKUP_KEY = 'marginote.autoBackup';

function getAutoBackup() {
  try { return JSON.parse(localStorage.getItem(AUTO_BACKUP_KEY)) || { intervalDays: 0, lastBackupAt: 0 }; }
  catch { return { intervalDays: 0, lastBackupAt: 0 }; }
}

function saveAutoBackup(c) {
  localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(c));
}

function estimateLocalStorageBytes() {
  let total = 0;
  for (const k in localStorage) {
    if (Object.prototype.hasOwnProperty.call(localStorage, k)) {
      total += (k.length + (localStorage[k] || '').length) * 2;
    }
  }
  return total;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(2) + ' MB';
}

function getStorageOriginInfo() {
  const isExt = isExtensionContext();
  const url = typeof location !== 'undefined' ? location.href : '';
  let extId = '';
  try { extId = chrome?.runtime?.id || ''; } catch {}
  return {
    mode: isExt ? '浏览器扩展' : '独立网页',
    origin: location.origin,
    extId,
    url,
    pathHint: isExt
      ? '存于扩展私有 IndexedDB / Local Storage（位于浏览器 profile：~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/<id> 或 %LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Local Extension Settings\\<id>）'
      : '存于浏览器 profile 的 Local Storage（按 origin 分隔）'
  };
}

function openStorageModal() {
  const info = getStorageOriginInfo();
  const size = estimateLocalStorageBytes();
  const counts = {
    notes: notes.length,
    todos: todos.length,
    notebooks: notebooks.length,
    folders: folders.length,
    images: Object.keys(images).length
  };
  document.getElementById('storageInfo').innerHTML = `
    <div><span class="key">运行模式</span><span class="val">${escapeHtml(info.mode)}</span></div>
    <div><span class="key">扩展 ID</span><span class="val">${escapeHtml(info.extId || '-')}</span></div>
    <div><span class="key">Origin</span><span class="val">${escapeHtml(info.origin)}</span></div>
    <div><span class="key">占用大小</span><span class="val">${formatBytes(size)}</span></div>
    <div><span class="key">数据统计</span><span class="val">笔记 ${counts.notes} · 待办 ${counts.todos} · 笔记本 ${counts.notebooks} · 文件夹 ${counts.folders} · 图片 ${counts.images}</span></div>
    <div style="margin-top:8px;color:var(--ink-mute);font-size:10px;">${escapeHtml(info.pathHint)}</div>
  `;
  const ab = getAutoBackup();
  document.getElementById('storageAutoDays').value = ab.intervalDays;
  document.getElementById('storageLastBackup').textContent = ab.lastBackupAt ? formatFullDate(ab.lastBackupAt) : '从未';
  renderErrorLog();
  document.getElementById('storageModalBg').classList.add('show');
}

function renderErrorLog() {
  document.getElementById('errorLogCount').textContent = `(${errorLogBuffer.length})`;
  const list = document.getElementById('errorLogList');
  if (!errorLogBuffer.length) {
    list.innerHTML = '<div class="error-log-empty">无错误记录</div>';
    return;
  }
  list.innerHTML = errorLogBuffer.slice().reverse().map(e => `
    <div class="entry">
      <span class="ts">${formatFullDate(e.ts)}</span>
      <span class="ctx">[${escapeHtml(e.context)}]</span>
      ${escapeHtml(e.message)}
      ${e.stack ? `<div class="stack">${escapeHtml(e.stack)}</div>` : ''}
    </div>
  `).join('');
}

function closeStorageModal() {
  document.getElementById('storageModalBg').classList.remove('show');
}

async function checkAutoBackup() {
  const ab = getAutoBackup();
  if (!ab.intervalDays || ab.intervalDays <= 0) return;
  const elapsed = Date.now() - (ab.lastBackupAt || 0);
  if (elapsed < ab.intervalDays * 86400000) return;
  try {
    await exportAll();
    ab.lastBackupAt = Date.now();
    saveAutoBackup(ab);
    showToast('已自动备份 ✓');
  } catch (e) {
    showToast('自动备份失败：' + (e.message || e));
  }
}

// ===================== 初始化 =====================
function migrateInlineImages() {
  let changed = false;
  notes.forEach(n => {
    const before = n.content || '';
    const after = ingestImageDataUrls(before);
    if (after !== before) { n.content = after; changed = true; }
  });
  todos.forEach(t => {
    const before = t.content || '';
    const after = ingestImageDataUrls(before);
    if (after !== before) { t.content = after; changed = true; }
  });
  if (changed) saveData();
}

async function init() {
  loadErrorLog();
  loadData();
  loadAiConfig();
  await initImagesIdb();
  migrateInlineImages();
  if (isExtensionContext()) document.body.classList.add('is-ext');
  rescheduleAllAlarms();
  // 自动备份延迟到 UI 渲染完
  setTimeout(checkAutoBackup, 1500);
  renderNotebooks();
  renderTagFilters();
  renderNotesList();
  switchView('all');

  // 日期
  const today = new Date();
  const months = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  document.getElementById('todayDate').textContent = `${months[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;

  // 主题恢复
  const savedTheme = localStorage.getItem(THEME_KEY) ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(THEMES[savedTheme] ? savedTheme : 'light');
  document.getElementById('themeToggle').addEventListener('click', openThemeModal);

  // 主题模态框
  document.getElementById('themeModalClose').addEventListener('click', closeThemeModal);
  document.getElementById('themeModalBg').addEventListener('click', e => {
    if (e.target.id === 'themeModalBg') closeThemeModal();
  });
  document.getElementById('customResetBtn').addEventListener('click', () => {
    saveCustomTheme({});
    syncCustomInputs();
    showToast('已重置自定义');
  });
  ['railBg','railInk','sidebarBg','sidebarInk','editorBg','editorInk'].forEach(k => {
    const id = 'custom' + k.charAt(0).toUpperCase() + k.slice(1);
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const c = getCustomTheme();
      c[k] = el.value;
      saveCustomTheme(c);
    });
  });

  // 存储 / 备份模态框
  document.getElementById('storageBtn').addEventListener('click', openStorageModal);
  document.getElementById('storageModalClose').addEventListener('click', closeStorageModal);
  document.getElementById('storageModalBg').addEventListener('click', e => {
    if (e.target.id === 'storageModalBg') closeStorageModal();
  });
  document.getElementById('storageExportBtn').addEventListener('click', () => {
    exportAll();
    const ab = getAutoBackup();
    ab.lastBackupAt = Date.now();
    saveAutoBackup(ab);
    document.getElementById('storageLastBackup').textContent = formatFullDate(ab.lastBackupAt);
  });
  document.getElementById('storageImportBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('storageAutoDays').addEventListener('change', e => {
    const ab = getAutoBackup();
    ab.intervalDays = Math.max(0, parseInt(e.target.value, 10) || 0);
    saveAutoBackup(ab);
    showToast(ab.intervalDays > 0 ? `自动备份：每 ${ab.intervalDays} 天` : '已关闭自动备份');
  });
  document.getElementById('errorLogClearBtn').addEventListener('click', () => {
    clearErrorLog();
    renderErrorLog();
    showToast('已清空错误日志');
  });

  // AI 入口
  document.getElementById('aiSettingsBtn').addEventListener('click', openAiSettings);
  document.getElementById('aiModalClose').addEventListener('click', closeAiSettings);
  document.getElementById('aiModalBg').addEventListener('click', e => {
    if (e.target.id === 'aiModalBg') closeAiSettings();
  });
  document.getElementById('aiAddBtn').addEventListener('click', () => openAiProviderForm(null));
  document.getElementById('aiFormCancel').addEventListener('click', closeAiProviderForm);
  document.getElementById('aiFormSave').addEventListener('click', saveAiProviderForm);
  document.getElementById('aiTestBtn').addEventListener('click', testAiProvider);

  // 笔记 / 待办 AI 按钮
  document.getElementById('noteAiBtn').addEventListener('click', e => {
    e.stopPropagation();
    if (!currentNote) { showToast('请先选择笔记'); return; }
    openAiMenu(e.currentTarget);
  });
  document.getElementById('todoAiBtn').addEventListener('click', e => {
    e.stopPropagation();
    if (!currentTodo) { showToast('请先选择待办'); return; }
    openAiMenu(e.currentTarget);
  });

  // 事件绑定
  document.getElementById('searchInput').addEventListener('input', () => {
    if (currentView.startsWith('todo:')) renderTodos();
    else renderNotesList();
  });
  document.getElementById('newNoteBtn').addEventListener('click', createNote);

  // 待办相关
  document.getElementById('newTodoBtn').addEventListener('click', e => {
    e.stopPropagation();
    if (!currentView.startsWith('todo:')) switchView('todo:active');
    setTimeout(() => document.getElementById('todoTextInput').focus(), 50);
  });
  document.getElementById('todoAddBtn').addEventListener('click', addTodo);
  document.getElementById('todoTextInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addTodo(); }
  });

  // 系统视图（全部 / 收藏 / 回收站）
  document.querySelectorAll('.rail-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // 折叠/展开 section
  document.querySelectorAll('.rail-section-title[data-toggle]').forEach(title => {
    title.addEventListener('click', e => {
      // 不折叠「+新建」按钮的点击
      if (e.target.closest('.add-btn')) return;
      const sectionId = title.dataset.toggle;
      const section = document.getElementById(sectionId);
      section.classList.toggle('collapsed');
      // 记住折叠状态
      const collapsed = JSON.parse(localStorage.getItem('marginote.collapsed') || '{}');
      collapsed[sectionId] = section.classList.contains('collapsed');
      localStorage.setItem('marginote.collapsed', JSON.stringify(collapsed));
    });
  });

  // 恢复折叠状态
  try {
    const collapsed = JSON.parse(localStorage.getItem('marginote.collapsed') || '{}');
    Object.entries(collapsed).forEach(([id, val]) => {
      if (val) document.getElementById(id)?.classList.add('collapsed');
    });
  } catch (e) {}

  // 全局侧栏折叠
  function toggleRailCollapse() {
    const app = document.getElementById('app');
    const isCollapsed = app.classList.toggle('rail-collapsed');
    localStorage.setItem('marginote.rail-collapsed', isCollapsed);
  }

  // 点击 Logo 折叠/展开
  document.getElementById('railLogo').addEventListener('click', toggleRailCollapse);

  // 折叠状态下点击任意侧栏项 → 自动展开
  document.querySelector('.rail').addEventListener('click', function(e) {
    const app = document.getElementById('app');
    if (app.classList.contains('rail-collapsed') && !e.target.closest('#railLogo')) {
      app.classList.remove('rail-collapsed');
      localStorage.setItem('marginote.rail-collapsed', false);
    }
  }, true); // capture phase: 先展开再让具体按钮处理

  // 恢复全局折叠状态
  try {
    if (JSON.parse(localStorage.getItem('marginote.rail-collapsed') || 'false')) {
      document.getElementById('app').classList.add('rail-collapsed');
    }
  } catch (e) {}

  // 新建笔记本（阻止冒泡以免触发折叠）
  document.getElementById('newNotebookBtn').addEventListener('click', e => {
    e.stopPropagation();
    openNotebookModal(null);
  });

  // 编辑器
  document.getElementById('titleInput').addEventListener('input', autoSave);
  document.getElementById('contentInput').addEventListener('input', () => {
    autoSave();
    updateWordCount();
  });

  // 标签输入
  document.getElementById('tagInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const tag = e.target.value.trim().replace(/^#/, '');
      if (tag && currentNote) {
        currentNote.tags = currentNote.tags || [];
        if (!currentNote.tags.includes(tag)) {
          currentNote.tags.push(tag);
          currentNote.updatedAt = Date.now();
          saveData();
          renderTags();
          renderTagFilters();
          renderNotesList();
        }
      }
      e.target.value = '';
    }
  });

  // 工具栏
  document.querySelectorAll('.tool-btn[data-format]').forEach(btn => {
    btn.addEventListener('click', () => applyFormat(btn.dataset.format));
  });

  // 操作按钮
  document.getElementById('starBtn').addEventListener('click', toggleStar);
  document.getElementById('modeBtn').addEventListener('click', togglePreview);
  document.getElementById('copyBtn').addEventListener('click', copyContent);
  document.getElementById('deleteBtn').addEventListener('click', deleteCurrent);
  document.getElementById('moveBtn').addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('moveMenu');
    if (menu.style.display === 'block') hideMoveMenu();
    else openMoveMenu(e.currentTarget);
  });

  document.getElementById('exportBtn').addEventListener('click', exportAll);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', e => {
    if (e.target.files && e.target.files.length) importFiles(e.target.files);
    e.target.value = '';
  });

  // 单笔记导出 markdown
  document.getElementById('exportMdBtn').addEventListener('click', () => {
    if (currentNote) exportNoteAsMarkdown(currentNote);
    else showToast('请先选择一篇笔记');
  });

  // 图片插入文件输入
  document.getElementById('imageFileInput').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) {
      const target = currentTodo ? 'todo' : 'note';
      handleImageInsert(f, target);
    }
    e.target.value = '';
  });

  // 粘贴 / 拖入图片
  attachImagePaste('contentInput', 'note');
  attachImagePaste('todoEditContent', 'todo');

  // 待办编辑器绑定
  document.getElementById('todoEditTitle').addEventListener('input', autoSaveTodo);
  document.getElementById('todoEditContent').addEventListener('input', autoSaveTodo);
  document.getElementById('todoEditDue').addEventListener('change', autoSaveTodo);
  document.getElementById('todoEditToggle').addEventListener('click', toggleCurrentTodoDone);
  document.getElementById('todoEditDeleteBtn').addEventListener('click', deleteCurrentTodo);
  document.getElementById('todoPreviewBtn').addEventListener('click', toggleTodoPreview);
  document.getElementById('todoImageBtn').addEventListener('click', () => {
    if (!currentTodo) { showToast('请先选择待办'); return; }
    document.getElementById('imageFileInput').click();
  });

  // 通用模态框
  document.getElementById('modalCancel').addEventListener('click', () => {
    document.getElementById('modalBg').classList.remove('show');
    modalCallback = null;
  });
  document.getElementById('modalConfirm').addEventListener('click', () => {
    if (modalCallback) modalCallback();
    document.getElementById('modalBg').classList.remove('show');
    modalCallback = null;
  });
  document.getElementById('modalBg').addEventListener('click', e => {
    if (e.target.id === 'modalBg') {
      document.getElementById('modalBg').classList.remove('show');
      modalCallback = null;
    }
  });

  // 笔记本模态框
  document.getElementById('notebookModalCancel').addEventListener('click', () => {
    document.getElementById('notebookModalBg').classList.remove('show');
    editingNotebook = null;
  });
  document.getElementById('notebookModalConfirm').addEventListener('click', saveNotebook);
  document.getElementById('notebookModalBg').addEventListener('click', e => {
    if (e.target.id === 'notebookModalBg') {
      document.getElementById('notebookModalBg').classList.remove('show');
      editingNotebook = null;
    }
  });
  document.getElementById('notebookNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveNotebook(); }
  });

  // 文件夹模态框
  document.getElementById('folderModalCancel').addEventListener('click', () => {
    document.getElementById('folderModalBg').classList.remove('show');
    editingFolder = null;
  });
  document.getElementById('folderModalConfirm').addEventListener('click', saveFolder);
  document.getElementById('folderModalBg').addEventListener('click', e => {
    if (e.target.id === 'folderModalBg') {
      document.getElementById('folderModalBg').classList.remove('show');
      editingFolder = null;
    }
  });
  document.getElementById('folderNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveFolder(); }
  });

  // 快捷键
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'n') { e.preventDefault(); createNote(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openNotebookModal(null); }
    if (mod && e.key === 's') { e.preventDefault(); showToast('已自动保存 ✓'); }
    if (mod && e.key === 'k') { e.preventDefault(); document.getElementById('searchInput').focus(); }
    if (mod && e.key === 'b' && document.activeElement.id === 'contentInput') { e.preventDefault(); applyFormat('bold'); }
    if (mod && e.key === 'i' && document.activeElement.id === 'contentInput') { e.preventDefault(); applyFormat('italic'); }
    if (mod && e.key === 'p') { e.preventDefault(); togglePreview(); }
    if (e.key === 'Escape') {
      document.getElementById('modalBg').classList.remove('show');
      document.getElementById('notebookModalBg').classList.remove('show');
      document.getElementById('folderModalBg').classList.remove('show');
      document.getElementById('themeModalBg').classList.remove('show');
      document.getElementById('aiModalBg').classList.remove('show');
      document.getElementById('storageModalBg').classList.remove('show');
      hideMoveMenu();
      hideAiMenu();
      modalCallback = null;
      editingNotebook = null;
      editingFolder = null;
    }
  });
}

// ==========================================================
// v1.2 优化批：以下为新增 / 重写功能
// ==========================================================

// ---------- safeName 增强：Windows 保留字 ----------
const RESERVED_NAMES_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const _origSafeName = safeName;
safeName = function(s) {
  let out = _origSafeName(s);
  if (RESERVED_NAMES_RE.test(out)) out = '_' + out;
  return out;
};

// ---------- showToast 详情链接 ----------
const _origShowToast = showToast;
showToast = function(msg, details) {
  const t = document.getElementById('toast');
  t.innerHTML = escapeHtml(String(msg)) + (details ? ` <span class="detail-link">详情</span>` : '');
  t.classList.add('show');
  clearTimeout(t._timer);
  const ms = details ? 4500 : 1800;
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
  if (details) {
    const link = t.querySelector('.detail-link');
    if (link) link.addEventListener('click', () => { openStorageModal(); }, { once: true });
  }
};

// ---------- 多 tab 同步 ----------
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  try {
    const data = JSON.parse(e.newValue);
    notebooks = data.notebooks || notebooks;
    folders = data.folders || folders;
    notes = data.notes || notes;
    todos = data.todos || todos;
    renderNotebooks();
    renderTagFilters();
    if (currentView.startsWith('todo:')) renderTodos();
    else renderNotesList();
    showToast('其它标签页已更新数据');
  } catch (err) { logError(err, 'storage-sync'); }
});

// ---------- 排序 + 紧凑模式 持久化 ----------
const VIEW_KEY = 'marginote.notesView';
let viewPrefs = { sortBy: 'updated', compact: false };
try { const r = localStorage.getItem(VIEW_KEY); if (r) viewPrefs = Object.assign(viewPrefs, JSON.parse(r)); } catch {}
function saveViewPrefs() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewPrefs)); } catch {} }

// ---------- 搜索语法解析 + 高亮 ----------
function parseSearchQuery(q) {
  const r = { terms: [], tags: [], nb: null, folder: null, isStarred: false, due: null };
  if (!q) return r;
  const tokens = q.match(/(?:"[^"]*"|\S+)/g) || [];
  for (const tk of tokens) {
    const m = tk.match(/^(\w+):(.+)$/);
    if (m) {
      const v = m[2].replace(/^["']|["']$/g, '').toLowerCase();
      if (m[1] === 'tag') r.tags.push(v);
      else if (m[1] === 'nb') r.nb = v;
      else if (m[1] === 'folder') r.folder = v;
      else if (m[1] === 'is' && v === 'starred') r.isStarred = true;
      else if (m[1] === 'due') r.due = v;
      else r.terms.push(tk.toLowerCase());
    } else r.terms.push(tk.replace(/^["']|["']$/g, '').toLowerCase());
  }
  return r;
}

function highlightTerms(text, terms) {
  let out = escapeHtml(text || '');
  terms.forEach(t => {
    if (!t) return;
    const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  });
  return out;
}

// 重写 getFilteredNotes
getFilteredNotes = function() {
  let list = notes.filter(n => {
    if (currentView === 'trash') return n.deleted;
    if (n.deleted) return false;
    if (currentView === 'starred') return n.starred;
    if (currentView.startsWith('folder:')) return n.folderId === currentView.slice(7);
    if (currentView.startsWith('nb:')) return n.notebookId === currentView.slice(3);
    return true;
  });
  if (currentTagFilter !== 'all') list = list.filter(n => n.tags && n.tags.includes(currentTagFilter));
  const q = document.getElementById('searchInput').value.trim();
  const parsed = parseSearchQuery(q);
  if (parsed.isStarred) list = list.filter(n => n.starred);
  if (parsed.tags.length) list = list.filter(n => parsed.tags.every(t => (n.tags || []).map(x => x.toLowerCase()).includes(t)));
  if (parsed.nb) list = list.filter(n => { const nb = getNotebook(n.notebookId); return nb && nb.name.toLowerCase().includes(parsed.nb); });
  if (parsed.folder) list = list.filter(n => { const f = getFolder(n.folderId); return f && f.name.toLowerCase().includes(parsed.folder); });
  if (parsed.terms.length) {
    list = list.filter(n => parsed.terms.every(term =>
      (n.title || '').toLowerCase().includes(term) ||
      (n.content || '').toLowerCase().includes(term) ||
      (n.tags || []).some(t => t.toLowerCase().includes(term))
    ));
  }
  const sortBy = viewPrefs.sortBy;
  list.sort((a, b) => {
    if (a.starred !== b.starred) return b.starred ? 1 : -1;
    if (sortBy === 'created') return b.createdAt - a.createdAt;
    if (sortBy === 'title') return (a.title || '').localeCompare(b.title || '', 'zh');
    if (sortBy === 'words') return (b.content || '').length - (a.content || '').length;
    return b.updatedAt - a.updatedAt;
  });
  list._terms = parsed.terms;
  return list;
};

// 重写 renderNotesList
renderNotesList = function() {
  const list = getFilteredNotes();
  const container = document.getElementById('notesList');
  const showNbBadge = !currentView.startsWith('nb:') && !currentView.startsWith('folder:');
  if (list.length === 0) {
    const empty = currentView === 'trash' ? '回收站为空' :
                  currentView === 'starred' ? '尚无收藏的笔记' :
                  currentView.startsWith('folder:') ? '此文件夹还是空的' :
                  currentView.startsWith('nb:') ? '这本笔记本还是空的' :
                  '尚无笔记，开始书写吧';
    container.innerHTML = `<div class="empty-list">${empty}</div>`;
    return;
  }
  const terms = list._terms || [];
  const compact = !!viewPrefs.compact;
  container.innerHTML = list.map(n => {
    const date = formatDate(n.updatedAt);
    const preview = stripMarkdown(n.content || '').slice(0, 100);
    const tags = (n.tags || []).slice(0, 3).map(t => `<span class="note-tag">${escapeHtml(t)}</span>`).join('');
    const isActive = currentNote && currentNote.id === n.id;
    const nb = getNotebook(n.notebookId);
    const nbBadge = (showNbBadge && nb) ? `<span class="note-nb-badge"><span class="note-nb-dot" style="background:${nb.color}"></span>${escapeHtml(nb.name)}</span>` : '';
    const titleHtml = terms.length ? highlightTerms(n.title || '无题', terms) : escapeHtml(n.title || '无题');
    const previewHtml = preview ? (terms.length ? highlightTerms(preview, terms) : escapeHtml(preview)) : '';
    return `
      <div class="note-item ${isActive ? 'active' : ''} ${compact ? 'compact' : ''}" data-id="${n.id}" role="button" tabindex="0">
        <div class="note-item-head">
          <div class="note-title">${n.starred ? '<span class="note-pin">★</span>' : ''}${titleHtml}</div>
          <div class="note-date">${date}</div>
        </div>
        ${previewHtml ? `<div class="note-preview">${previewHtml}</div>` : ''}
        <div class="note-foot">
          ${nbBadge}
          ${tags ? `<div class="note-tags">${tags}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
  container.querySelectorAll('.note-item').forEach(el => {
    const open = () => {
      const note = notes.find(n => n.id === el.dataset.id);
      if (note) selectNote(note);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  if (typeof updateCollectionCount === 'function') updateCollectionCount();
};

// 待办过滤同步搜索语法
getFilteredTodos = function() {
  const now = Date.now();
  let list = todos.slice();
  if (currentView === 'todo:active') list = list.filter(t => !t.done && (!t.dueDate || t.dueDate >= now));
  else if (currentView === 'todo:done') list = list.filter(t => t.done);
  else if (currentView === 'todo:overdue') list = list.filter(t => !t.done && t.dueDate && t.dueDate < now);
  const parsed = parseSearchQuery(document.getElementById('searchInput').value.trim());
  if (parsed.terms.length) {
    list = list.filter(t => parsed.terms.every(term =>
      (t.text || '').toLowerCase().includes(term) ||
      (t.content || '').toLowerCase().includes(term)));
  }
  list.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.dueDate || Infinity, bd = b.dueDate || Infinity;
    if (ad !== bd) return ad - bd;
    return b.createdAt - a.createdAt;
  });
  list._terms = parsed.terms;
  return list;
};

// ---------- 提醒预设 ----------
const REMIND_PRESETS = {
  '0':       { before: 0, count: 0, interval: 5 },
  '0-now':   { before: 0, count: 1, interval: 1 },
  '5':       { before: 5, count: 1, interval: 5 },
  '15':      { before: 15, count: 1, interval: 5 },
  '30':      { before: 30, count: 1, interval: 5 },
  '60':      { before: 60, count: 1, interval: 5 },
  '180':     { before: 180, count: 1, interval: 30 },
  '1440':    { before: 1440, count: 1, interval: 60 }
};

function readRemindFields(prefix, presetEl) {
  if (presetEl.value === 'custom') {
    return {
      before: parseInt(document.getElementById(prefix + 'Before').value, 10) || 0,
      count:  parseInt(document.getElementById(prefix + 'Count').value, 10) || 1,
      interval: parseInt(document.getElementById(prefix + 'Interval').value, 10) || 5
    };
  }
  const p = REMIND_PRESETS[presetEl.value] || REMIND_PRESETS['0'];
  return { before: p.before, count: p.count, interval: p.interval };
}

function setRemindUi(prefix, t) {
  const el = document.getElementById(prefix + 'Preset');
  if (!el) return;
  const before = t.remindBeforeMin || 0;
  const count  = t.remindCount || 0;
  const interval = t.remindIntervalMin || 5;
  let m = '0';
  if (count > 0) {
    if (before === 0) m = '0-now';
    else if ([5, 15, 30, 60, 180, 1440].includes(before) && count === 1) m = String(before);
    else m = 'custom';
  }
  el.value = m;
  document.getElementById(prefix + 'Adv').classList.toggle('show', m === 'custom');
  document.getElementById(prefix + 'Before').value = before || '';
  document.getElementById(prefix + 'Count').value = count || 1;
  document.getElementById(prefix + 'Interval').value = interval || 5;
}

// 重写 addTodo
addTodo = function() {
  const text = document.getElementById('todoTextInput').value.trim();
  if (!text) { showToast('请输入待办内容'); return; }
  const dueRaw = document.getElementById('todoDueInput').value;
  let dueDate = null;
  if (dueRaw) { const d = new Date(dueRaw); if (!isNaN(d.getTime())) dueDate = d.getTime(); }
  const r = readRemindFields('todoRemind', document.getElementById('todoRemindPreset'));
  const t = { id: uid(), text, content: '', done: false, dueDate,
    remindBeforeMin: r.before, remindCount: r.count, remindIntervalMin: r.interval,
    createdAt: Date.now(), completedAt: null };
  todos.push(t);
  saveData();
  scheduleTodoReminders(t);
  document.getElementById('todoTextInput').value = '';
  document.getElementById('todoDueInput').value = '';
  document.getElementById('todoRemindPreset').value = '0';
  document.getElementById('todoRemindAdv').classList.remove('show');
  renderTodos(); renderTodoCounts(); updateCollectionCount();
  showToast('已添加待办');
};

// 重写 autoSaveTodo
autoSaveTodo = function() {
  if (!currentTodo) return;
  document.getElementById('todoEditStatus').textContent = '保存中…';
  clearTimeout(todoSaveTimer);
  todoSaveTimer = setTimeout(() => {
    currentTodo.text = document.getElementById('todoEditTitle').value.trim() || '无标题待办';
    currentTodo.content = document.getElementById('todoEditContent').value;
    const dueRaw = document.getElementById('todoEditDue').value;
    currentTodo.dueDate = dueRaw ? new Date(dueRaw).getTime() : null;
    const r = readRemindFields('todoEditRemind', document.getElementById('todoEditRemindPreset'));
    currentTodo.remindBeforeMin = r.before;
    currentTodo.remindCount = r.count;
    currentTodo.remindIntervalMin = r.interval;
    saveData();
    scheduleTodoReminders(currentTodo);
    document.getElementById('todoEditStatus').textContent = '已保存';
    refreshTodoEditState();
    renderTodoCounts(); renderTodos(); updateCollectionCount();
  }, 400);
};

// selectTodo 同步 preset UI + outline
const _origSelectTodoV12 = selectTodo;
selectTodo = function(t) {
  _origSelectTodoV12(t);
  setRemindUi('todoEditRemind', t);
  if (document.getElementById('outlinePanel').classList.contains('show')) renderOutline();
};

// selectNote outline 刷新
const _origSelectNoteV12 = selectNote;
selectNote = function(n) {
  _origSelectNoteV12(n);
  if (document.getElementById('outlinePanel').classList.contains('show')) renderOutline();
};

// ---------- AI 自定义指令 modal ----------
const AI_HISTORY_KEY = 'marginote.aiCustomHistory';
function getAiHistory() { try { return JSON.parse(localStorage.getItem(AI_HISTORY_KEY)) || []; } catch { return []; } }
function pushAiHistory(text) {
  if (!text) return;
  let h = getAiHistory().filter(x => x !== text);
  h.unshift(text);
  if (h.length > 10) h = h.slice(0, 10);
  try { localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(h)); } catch {}
}

function openAiCustomModal() {
  const ta = document.getElementById('aiCustomInput');
  ta.value = '';
  const list = document.getElementById('aiHistoryList');
  const h = getAiHistory();
  list.innerHTML = h.length ? h.map(x => `<div class="history-item">${escapeHtml(x.slice(0, 100))}</div>`).join('')
    : '<div style="color:var(--ink-mute);font-style:italic;padding:8px;font-size:11px;">暂无历史</div>';
  list.querySelectorAll('.history-item').forEach((el, i) => {
    el.addEventListener('click', () => { ta.value = h[i]; ta.focus(); });
  });
  document.getElementById('aiCustomModalBg').classList.add('show');
  setTimeout(() => ta.focus(), 50);
}
function closeAiCustomModal() { document.getElementById('aiCustomModalBg').classList.remove('show'); }

// ---------- AI 流式 callAi ----------
let _aiAbortCtrl = null;
const _origCallAi = callAi;
callAi = async function(messages, opts) {
  const p = getActiveProvider();
  if (!p) throw new Error('未配置 AI 模型');
  if (opts && opts.stream === false) return _origCallAi(messages, opts);
  const body = { model: p.model, messages, temperature: (opts && opts.temperature) ?? p.temperature ?? 0.7, stream: true };
  _aiAbortCtrl = new AbortController();
  const cancelBtn = document.getElementById('aiCancelBtn');
  cancelBtn.classList.add('show');
  try {
    const url = resolveAiUrl(p);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (p.apiKey || '') },
      body: JSON.stringify(body),
      signal: _aiAbortCtrl.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('event-stream')) {
      const data = await res.json();
      const c = data?.choices?.[0]?.message?.content;
      if (typeof c === 'string' && opts?.onDelta) opts.onDelta(c, c);
      return typeof c === 'string' ? c.trim() : '';
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { try { reader.cancel(); } catch {} break; }
        try {
          const obj = JSON.parse(payload);
          const delta = obj?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            if (opts && typeof opts.onDelta === 'function') opts.onDelta(delta, full);
          }
        } catch {}
      }
    }
    return full.trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('已取消');
    throw e;
  } finally {
    cancelBtn.classList.remove('show');
    _aiAbortCtrl = null;
  }
};

// ---------- runAiAction：支持流式 + custom modal ----------
runAiAction = async function(action) {
  if (action.id === 'custom') { openAiCustomModal(); return; }
  await _runAiActionInternal(action);
};

async function _runAiActionInternal(action) {
  const provider = getActiveProvider();
  if (!provider) { showToast('未配置 AI 模型'); openAiSettings(); return; }
  const isTodo = !!currentTodo, isNote = !!currentNote;
  if (!isTodo && !isNote) { showToast('请先选择笔记或待办'); return; }
  const target = isTodo ? 'todo:' + currentTodo.id : 'note:' + currentNote.id;
  const title = isTodo ? (currentTodo.text || '') : (currentNote.title || '');
  const content = isTodo ? (currentTodo.content || '') : (currentNote.content || '');
  pushAiUndoSnapshot(target, { title, content, ts: Date.now() });
  const userPayload = (title ? `标题：${title}\n\n` : '') + (content || '(空)');
  const messages = [];
  const sysParts = [];
  if (provider.system) sysParts.push(provider.system);
  if (action.system) sysParts.push(action.system);
  if (sysParts.length) messages.push({ role: 'system', content: sysParts.join('\n\n') });
  messages.push({ role: 'user', content: userPayload });

  setAiBusy(true);
  const ta = isTodo ? document.getElementById('todoEditContent') : document.getElementById('contentInput');
  const baseContent = action.mode === 'append' ? (content + (content ? '\n\n' : '')) : '';

  try {
    const reply = await callAi(messages, {
      stream: true,
      onDelta: (d, full) => {
        if (isTodo) {
          currentTodo.content = baseContent + full;
          ta.value = currentTodo.content;
          if (isTodoPreviewMode) document.getElementById('todoPreview').innerHTML = renderMarkdown(currentTodo.content);
        } else {
          currentNote.content = baseContent + full;
          ta.value = currentNote.content;
          if (isPreviewMode) document.getElementById('preview').innerHTML = renderMarkdown(currentNote.content);
        }
      }
    });
    if (isTodo) {
      currentTodo.content = baseContent + reply;
      saveData();
      document.getElementById('todoEditStatus').textContent = '已保存 · AI 已应用';
      renderTodos();
    } else {
      currentNote.content = baseContent + reply;
      currentNote.updatedAt = Date.now();
      saveData();
      document.getElementById('editorStatus').textContent = '已保存 · AI 已应用';
      updateWordCount();
      renderNotesList();
    }
    showToast('AI 已优化 ✓');
  } catch (e) {
    logError(e, 'ai-stream');
    showToast('AI 失败：' + (e.message || e), e && e.stack);
  } finally {
    setAiBusy(false);
  }
}

async function runCustomAi() {
  const ta = document.getElementById('aiCustomInput');
  const ins = ta.value.trim();
  if (!ins) { showToast('请输入指令'); return; }
  pushAiHistory(ins);
  closeAiCustomModal();
  await _runAiActionInternal({ id: 'custom', mode: 'replace', system: ins });
}

// ---------- 主题 hover 实时预览 ----------
function previewTheme(name) {
  const preset = THEMES[name];
  if (!preset) return;
  document.body.setAttribute('data-theme', preset.mode);
  THEME_VAR_NAMES.forEach(v => document.body.style.removeProperty(v));
  Object.entries(preset.vars).forEach(([k, v]) => document.body.style.setProperty(k, v));
}
function restoreTheme() { applyTheme(currentThemePreset); }

const _origRenderThemeGrid = renderThemeGrid;
renderThemeGrid = function() {
  _origRenderThemeGrid();
  document.querySelectorAll('#themeGrid .theme-card').forEach(el => {
    el.addEventListener('mouseenter', () => previewTheme(el.dataset.theme));
    el.addEventListener('mouseleave', () => restoreTheme());
  });
};

// ---------- Outline 大纲面板 ----------
function getOutline(text) {
  if (!text) return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,3})\s+(.+)$/);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), lineIdx: i });
  }
  return out;
}

function renderOutline() {
  const list = document.getElementById('outlineList');
  if (!list) return;
  let text = '';
  if (currentNote) text = currentNote.content || '';
  else if (currentTodo) text = currentTodo.content || '';
  const items = getOutline(text);
  if (!items.length) {
    list.innerHTML = '<div class="outline-empty">无标题。在内容里加 # / ## / ### 即可。</div>';
    return;
  }
  list.innerHTML = items.map((it, i) =>
    `<button class="outline-item h${it.level}" data-idx="${i}" data-line="${it.lineIdx}">${escapeHtml(it.text)}</button>`
  ).join('');
  list.querySelectorAll('.outline-item').forEach(el => {
    el.addEventListener('click', () => jumpToHeading(parseInt(el.dataset.idx, 10), parseInt(el.dataset.line, 10)));
  });
}

function jumpToHeading(idx, lineIdx) {
  const ta = currentTodo ? document.getElementById('todoEditContent') : document.getElementById('contentInput');
  const pv = currentTodo ? document.getElementById('todoPreview') : document.getElementById('preview');
  if (pv && pv.style.display !== 'none') {
    const headings = pv.querySelectorAll('h1, h2, h3');
    if (headings[idx]) headings[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (!ta) return;
  const lines = ta.value.split('\n');
  let pos = 0;
  for (let i = 0; i < lineIdx; i++) pos += (lines[i] || '').length + 1;
  ta.focus();
  ta.setSelectionRange(pos, pos + (lines[lineIdx] || '').length);
  const lh = 28;
  ta.scrollTop = lineIdx * lh - ta.clientHeight / 2;
}

function toggleOutline() {
  const panel = document.getElementById('outlinePanel');
  const visible = panel.classList.toggle('show');
  document.getElementById('outlineBtn').classList.toggle('active', visible);
  if (visible) renderOutline();
}

// 内容变更 → 刷新大纲
const _origAutoSave = autoSave;
autoSave = function() {
  _origAutoSave();
  if (document.getElementById('outlinePanel').classList.contains('show')) renderOutline();
};

// ---------- Split View ----------
let _splitMode = false;
function _splitSync() {
  const ta = document.getElementById('contentInput');
  const pv = document.getElementById('preview');
  if (pv && ta) pv.innerHTML = renderMarkdown(ta.value);
}
function _splitScroll() {
  const ta = document.getElementById('contentInput');
  const pv = document.getElementById('preview');
  if (!pv || !ta) return;
  const r = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
  pv.scrollTop = r * Math.max(0, pv.scrollHeight - pv.clientHeight);
}

function toggleSplitView() {
  if (!currentNote) { showToast('请先选择笔记'); return; }
  _splitMode = !_splitMode;
  const ec = document.querySelector('#editorWrap .editor-content');
  if (!ec) return;
  ec.classList.toggle('split', _splitMode);
  const ta = document.getElementById('contentInput');
  const pv = document.getElementById('preview');
  document.getElementById('splitBtn').classList.toggle('active', _splitMode);
  if (_splitMode) {
    pv.innerHTML = renderMarkdown(ta.value);
    ta.style.display = '';
    pv.style.display = 'block';
    ta.addEventListener('input', _splitSync);
    ta.addEventListener('scroll', _splitScroll);
  } else {
    ta.removeEventListener('input', _splitSync);
    ta.removeEventListener('scroll', _splitScroll);
    if (isPreviewMode) { ta.style.display = 'none'; pv.style.display = 'block'; }
    else { ta.style.display = ''; pv.style.display = 'none'; }
  }
}

// ---------- 移动端抽屉 + 底部 tab ----------
function initMobileUi() {
  const fab = document.getElementById('mobileFab');
  if (fab) {
    fab.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('app').classList.toggle('show-rail');
    });
  }
  document.addEventListener('click', (e) => {
    const app = document.getElementById('app');
    if (app.classList.contains('show-rail') && !e.target.closest('.rail') && !e.target.closest('#mobileFab')) {
      app.classList.remove('show-rail');
    }
  }, true);
  document.querySelectorAll('#mobileTabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#mobileTabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const t = btn.dataset.mtab;
      if (t === 'notes') switchView('all');
      else if (t === 'todos') switchView('todo:active');
      else if (t === 'theme') openThemeModal();
      else if (t === 'settings') openStorageModal();
    });
  });
}

// ---------- 绑定 ----------
function bindV12() {
  // 排序 / 紧凑
  const sortSel = document.getElementById('sortSelect');
  if (sortSel) {
    sortSel.value = viewPrefs.sortBy;
    sortSel.addEventListener('change', () => {
      viewPrefs.sortBy = sortSel.value;
      saveViewPrefs();
      renderNotesList();
    });
  }
  const cToggle = document.getElementById('compactToggle');
  if (cToggle) {
    cToggle.classList.toggle('active', viewPrefs.compact);
    cToggle.addEventListener('click', () => {
      viewPrefs.compact = !viewPrefs.compact;
      saveViewPrefs();
      cToggle.classList.toggle('active', viewPrefs.compact);
      renderNotesList();
    });
  }

  // 提醒预设 select 切换
  ['todoRemind', 'todoEditRemind'].forEach(prefix => {
    const ps = document.getElementById(prefix + 'Preset');
    if (!ps) return;
    ps.addEventListener('change', () => {
      const adv = document.getElementById(prefix + 'Adv');
      adv.classList.toggle('show', ps.value === 'custom');
      if (prefix === 'todoEditRemind') autoSaveTodo();
    });
  });

  // AI custom modal
  const cc = document.getElementById('aiCustomCancel');
  const cr = document.getElementById('aiCustomRun');
  const cb = document.getElementById('aiCustomModalBg');
  if (cc) cc.addEventListener('click', closeAiCustomModal);
  if (cr) cr.addEventListener('click', runCustomAi);
  if (cb) cb.addEventListener('click', e => { if (e.target.id === 'aiCustomModalBg') closeAiCustomModal(); });
  const ci = document.getElementById('aiCustomInput');
  if (ci) ci.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runCustomAi(); } });

  // AI streaming cancel
  const cancelBtn = document.getElementById('aiCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { if (_aiAbortCtrl) _aiAbortCtrl.abort(); });

  // outline / split
  const ob = document.getElementById('outlineBtn');
  if (ob) ob.addEventListener('click', toggleOutline);
  const sb = document.getElementById('splitBtn');
  if (sb) sb.addEventListener('click', toggleSplitView);

  // 搜索 placeholder 加语法提示
  const si = document.getElementById('searchInput');
  if (si && !si.placeholder.includes('tag:')) {
    si.placeholder = '搜索 / tag:foo nb:bar is:starred';
  }

  // 移动端
  initMobileUi();

  // Esc 扩展
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('aiCustomModalBg').classList.remove('show');
      const op = document.getElementById('outlinePanel');
      if (op) op.classList.remove('show');
      const app = document.getElementById('app');
      if (app && app.classList.contains('show-rail')) app.classList.remove('show-rail');
    }
  });
}

bindV12();

// ==========================================================
// v1.3 本地文件夹同步 (File System Access API)
// ==========================================================
const SYNC_KEY = 'marginote.diskSync';
let _diskSyncCfg = { enabled: false, lastSyncAt: 0 };
try { Object.assign(_diskSyncCfg, JSON.parse(localStorage.getItem(SYNC_KEY) || '{}')); } catch {}
function saveDiskSyncCfg() { try { localStorage.setItem(SYNC_KEY, JSON.stringify(_diskSyncCfg)); } catch {} }

let _diskHandle = null;
let _diskSyncTimer = null;

async function loadDirHandle() {
  try {
    const r = await idbGet('meta', 'dirHandle');
    if (r && r.value) {
      _diskHandle = r.value;
      return true;
    }
  } catch (e) { logError(e, 'load-dir-handle'); }
  return false;
}

async function saveDirHandle(h) {
  try { await idbPut('meta', { key: 'dirHandle', value: h }); }
  catch (e) { logError(e, 'save-dir-handle'); }
}

async function ensureDirPermission(mode) {
  if (!_diskHandle) return false;
  mode = mode || 'readwrite';
  try {
    const opts = { mode };
    if ((await _diskHandle.queryPermission(opts)) === 'granted') return true;
    if ((await _diskHandle.requestPermission(opts)) === 'granted') return true;
  } catch (e) { logError(e, 'fsa-perm'); }
  return false;
}

async function pickStorageDir() {
  if (!window.showDirectoryPicker) {
    showToast('当前浏览器不支持 File System Access，请用 Chrome/Edge 100+');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    _diskHandle = handle;
    await saveDirHandle(handle);
    showToast('已绑定文件夹：' + handle.name);
    await syncToDisk();
    renderLocalSyncInfo();
  } catch (e) {
    if (e.name !== 'AbortError') {
      logError(e, 'pick-dir');
      showToast('选择失败：' + e.message);
    }
  }
}

async function writeJsonToDir(dirHandle, filename, obj) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(obj, null, 2));
  await w.close();
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function syncToDisk(silent) {
  if (!_diskHandle) { if (!silent) showToast('未绑定本地文件夹'); return false; }
  if (!await ensureDirPermission('readwrite')) {
    if (!silent) showToast('未授权写入');
    return false;
  }
  try {
    const data = {
      version: 'v1.3',
      exportedAt: Date.now(),
      notebooks, folders, notes, todos
    };
    await writeJsonToDir(_diskHandle, 'marginote.json', data);
    // images
    let imgDir;
    try { imgDir = await _diskHandle.getDirectoryHandle('images', { create: true }); }
    catch (e) { logError(e, 'mkdir-images'); }
    if (imgDir) {
      const usedIds = new Set();
      // 收集 notes/todos 中实际引用的图片 id
      const collectIds = (text) => {
        if (!text) return;
        const re = /!\[[^\]]*\]\(img:([a-z0-9]+)\)/gi;
        let m;
        while ((m = re.exec(text)) !== null) usedIds.add(m[1]);
      };
      notes.forEach(n => collectIds(n.content));
      todos.forEach(t => collectIds(t.content));
      // 写入引用到的图片
      for (const id of usedIds) {
        const img = images[id];
        if (!img || !img.dataUrl) continue;
        try {
          const fname = id + (img.ext || '.png');
          const fh = await imgDir.getFileHandle(fname, { create: true });
          const w = await fh.createWritable();
          const blob = await dataUrlToBlob(img.dataUrl);
          await w.write(blob);
          await w.close();
        } catch (e) { logError(e, 'write-img:' + id); }
      }
    }
    // AI / 主题等元配置
    try {
      await writeJsonToDir(_diskHandle, 'config.json', {
        aiConfig,
        theme: localStorage.getItem('marginote.theme'),
        themeCustom: JSON.parse(localStorage.getItem('marginote.themeCustom') || 'null')
      });
    } catch (e) { logError(e, 'write-config'); }

    _diskSyncCfg.lastSyncAt = Date.now();
    saveDiskSyncCfg();
    renderLocalSyncInfo();
    if (!silent) showToast('已同步到本地文件夹');
    return true;
  } catch (e) {
    logError(e, 'sync-disk');
    if (!silent) showToast('同步失败：' + e.message, e && e.stack);
    return false;
  }
}

async function restoreFromDisk() {
  if (!_diskHandle) { showToast('未绑定本地文件夹'); return; }
  if (!await ensureDirPermission('readwrite')) { showToast('未授权读取'); return; }
  try {
    const fh = await _diskHandle.getFileHandle('marginote.json');
    const file = await fh.getFile();
    const data = JSON.parse(await file.text());
    showModal(
      '从本地文件夹恢复？',
      `将用本地数据 (${new Date(data.exportedAt || file.lastModified).toLocaleString()}) 替换当前所有笔记/待办/笔记本/文件夹。无法撤销。`,
      async () => {
        notebooks = data.notebooks || [];
        folders = data.folders || [];
        notes = data.notes || [];
        todos = data.todos || [];
        // 恢复图片
        try {
          const imgDir = await _diskHandle.getDirectoryHandle('images');
          for await (const [name, h] of imgDir.entries()) {
            if (h.kind !== 'file') continue;
            const id = name.replace(/\.[^.]+$/, '');
            const ext = '.' + (name.split('.').pop() || 'png');
            const f = await h.getFile();
            const buf = await f.arrayBuffer();
            // base64 编码
            let binary = '';
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            const b64 = btoa(binary);
            const mime = mimeFromExt(ext);
            images[id] = { name, ext, createdAt: f.lastModified, dataUrl: `data:${mime};base64,${b64}` };
            await idbPut('images', { id, ...images[id] });
          }
        } catch (e) { /* 没 images 目录则忽略 */ }
        // 恢复 config（可选）
        try {
          const cfh = await _diskHandle.getFileHandle('config.json');
          const cf = await cfh.getFile();
          const cd = JSON.parse(await cf.text());
          if (cd.aiConfig) { aiConfig = cd.aiConfig; saveAiConfig(); }
          if (cd.theme) { applyTheme(cd.theme); }
          if (cd.themeCustom) { saveCustomTheme(cd.themeCustom); }
        } catch {}
        saveData();
        renderNotebooks();
        renderTagFilters();
        if (currentView.startsWith('todo:')) renderTodos();
        else renderNotesList();
        renderTodoCounts();
        showToast('已从本地恢复 ✓');
      }
    );
  } catch (e) {
    if (e.name === 'NotFoundError') {
      showToast('本地文件夹中无 marginote.json');
    } else {
      logError(e, 'restore-disk');
      showToast('恢复失败：' + e.message, e && e.stack);
    }
  }
}

function renderLocalSyncInfo() {
  const el = document.getElementById('localSyncInfo');
  if (!el) return;
  if (!_diskHandle) {
    el.innerHTML = '<span style="color:var(--ink-mute);">未连接本地文件夹（数据仅存浏览器）</span>';
  } else {
    const last = _diskSyncCfg.lastSyncAt ? formatFullDate(_diskSyncCfg.lastSyncAt) : '从未';
    el.innerHTML = `<div><span class="key">已绑定</span><span class="val">${escapeHtml(_diskHandle.name)}</span></div>
      <div><span class="key">上次同步</span><span class="val">${last}</span></div>
      <div><span class="key">自动同步</span><span class="val">${_diskSyncCfg.enabled ? '已开启' : '关闭'}</span></div>`;
  }
  const tg = document.getElementById('autoSyncToggle');
  if (tg) tg.checked = !!_diskSyncCfg.enabled;
}

// hook saveData → debounced 自动同步
const _origSaveDataV13 = saveData;
saveData = function() {
  _origSaveDataV13();
  if (_diskSyncCfg.enabled && _diskHandle) {
    clearTimeout(_diskSyncTimer);
    _diskSyncTimer = setTimeout(() => syncToDisk(true), 5000);
  }
};

// 启动加载 dirHandle + 提示恢复
(async function initDiskSync() {
  // 等 IDB 就绪
  let tries = 0;
  while (!_idb && tries < 50) { await new Promise(r => setTimeout(r, 100)); tries++; }
  if (!_idb) return;
  await loadDirHandle();
  renderLocalSyncInfo();
  if (_diskHandle && _diskSyncCfg.enabled) {
    // 启动若无数据 (notes 仅初始示例) 且文件夹有数据，提示恢复
    // 这里被动：用户主动点恢复按钮即可。避免静默覆盖。
  }
})();

// 绑定 UI
function bindDiskSync() {
  const pickBtn = document.getElementById('pickDirBtn');
  const syncBtn = document.getElementById('syncDiskBtn');
  const restoreBtn = document.getElementById('restoreDiskBtn');
  const autoTg = document.getElementById('autoSyncToggle');
  if (pickBtn) pickBtn.addEventListener('click', pickStorageDir);
  if (syncBtn) syncBtn.addEventListener('click', () => syncToDisk(false));
  if (restoreBtn) restoreBtn.addEventListener('click', restoreFromDisk);
  if (autoTg) {
    autoTg.checked = !!_diskSyncCfg.enabled;
    autoTg.addEventListener('change', () => {
      _diskSyncCfg.enabled = autoTg.checked;
      saveDiskSyncCfg();
      renderLocalSyncInfo();
      showToast(autoTg.checked ? '已启用自动同步' : '已关闭自动同步');
    });
  }
}
bindDiskSync();

// 打开 storage modal 时刷新本地同步状态
const _origOpenStorageModal = openStorageModal;
openStorageModal = function() {
  _origOpenStorageModal();
  renderLocalSyncInfo();
};

// ==========================================================
// v1.7 阅读模式
// ==========================================================
function enterReadingMode() {
  if (!currentNote) { showToast('请先选择笔记'); return; }
  const app = document.getElementById('app');
  const pv = document.getElementById('preview');
  const ta = document.getElementById('contentInput');
  pv.innerHTML = renderMarkdown(currentNote.content || '');
  pv.style.display = 'block';
  ta.style.display = 'none';
  app.classList.add('reading-mode');
  document.getElementById('readingBtn').classList.add('active');
  document.querySelector('.editor').scrollTop = 0;
  updateReadingProgress();
}

function exitReadingMode() {
  const app = document.getElementById('app');
  if (!app.classList.contains('reading-mode')) return;
  app.classList.remove('reading-mode');
  document.getElementById('readingBtn').classList.remove('active');
  // 恢复进入前的预览/编辑状态
  if (!isPreviewMode) {
    document.getElementById('preview').style.display = 'none';
    document.getElementById('contentInput').style.display = '';
  }
}

function toggleReadingMode() {
  if (document.getElementById('app').classList.contains('reading-mode')) exitReadingMode();
  else enterReadingMode();
}

function updateReadingProgress() {
  const editor = document.querySelector('.editor');
  const bar = document.getElementById('readingProgress');
  if (!editor || !bar) return;
  const r = editor.scrollTop / Math.max(1, editor.scrollHeight - editor.clientHeight);
  bar.style.width = (r * 100).toFixed(2) + '%';
}

document.getElementById('readingBtn').addEventListener('click', toggleReadingMode);
document.getElementById('readingExitBtn').addEventListener('click', exitReadingMode);
document.querySelector('.editor').addEventListener('scroll', () => {
  if (document.getElementById('app').classList.contains('reading-mode')) updateReadingProgress();
});

// 拦截 Esc：阅读模式时优先退出，不关其他 modal
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('app').classList.contains('reading-mode')) {
    e.stopPropagation();
    exitReadingMode();
  }
}, true);

console.info('[Marginote] v1.2 优化批已加载（' + new Date().toISOString().slice(0, 10) + '）');

// ---------- 启动注入功能说明书笔记 ----------
const MANUAL_FLAG_KEY = 'marginote.manualGenerated';
const MANUAL_VERSION = 'v1.7';
async function ensureManualNote() {
  if (localStorage.getItem(MANUAL_FLAG_KEY) === MANUAL_VERSION) return;
  if (!notebooks.length) return;
  let content = '';
  try {
    const url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL('manual.md')
      : 'manual.md';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    content = await res.text();
  } catch (e) {
    logError(e, 'load-manual');
    return;
  }
  notes.unshift({
    id: 'marginote-manual-' + MANUAL_VERSION,
    notebookId: notebooks[0].id,
    folderId: null,
    title: '📖 Marginote 功能说明书 ' + MANUAL_VERSION,
    content,
    tags: ['说明书', '指南'],
    starred: true,
    deleted: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  saveData();
  localStorage.setItem(MANUAL_FLAG_KEY, MANUAL_VERSION);
  renderNotebooks();
  renderTagFilters();
  if (!currentView.startsWith('todo:')) renderNotesList();
}

init()
  .then(ensureManualNote)
  .then(() => { if (typeof syncProxyToBackground === 'function') syncProxyToBackground(); })
  .catch(e => { logError(e, 'init'); console.error(e); });
