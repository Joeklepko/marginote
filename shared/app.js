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
const IDB_VERSION = 3;
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
      if (!db.objectStoreNames.contains('versions')) {
        const vs = db.createObjectStore('versions', { keyPath: 'key' });
        vs.createIndex('byNote', 'noteId', { unique: false });
      } else {
        const tx = e.target.transaction;
        const vs = tx.objectStore('versions');
        if (!vs.indexNames.contains('byNote')) vs.createIndex('byNote', 'noteId', { unique: false });
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

// ===================== 笔记版本历史 =====================
const VERSION_AUTO_LIMIT = 20;
const VERSION_MIN_GAP_MS = 5 * 60 * 1000;
const VERSION_MIN_DIFF_CHARS = 50;
const _lastSnapshotAt = {};
const _lastSnapshotContent = {};

function listVersionsByNote(noteId) {
  return new Promise((resolve, reject) => {
    if (!_idb || !noteId) { resolve([]); return; }
    try {
      const tx = _idb.transaction('versions', 'readonly');
      const idx = tx.objectStore('versions').index('byNote');
      const r = idx.getAll(noteId);
      r.onsuccess = () => resolve((r.result || []).sort((a, b) => b.ts - a.ts));
      r.onerror = () => reject(r.error);
    } catch (e) { resolve([]); }
  });
}

async function pruneAutoVersions(noteId) {
  const all = await listVersionsByNote(noteId);
  const auto = all.filter(v => !v.label);
  const stale = auto.slice(VERSION_AUTO_LIMIT);
  for (const v of stale) {
    try { await idbDelete('versions', v.key); } catch (e) { logError(e, 'idb-version-prune'); }
  }
}

async function dedupeVersionsForNote(noteId) {
  const all = await listVersionsByNote(noteId);
  const seen = new Set();
  const toDelete = [];
  for (const v of all) {
    const sig = (v.title || '') + '' + (v.content || '');
    if (seen.has(sig)) toDelete.push(v.key);
    else seen.add(sig);
  }
  for (const k of toDelete) {
    try { await idbDelete('versions', k); } catch (e) { logError(e, 'idb-version-dedupe'); }
  }
  return toDelete.length;
}

async function snapshotNote(snap, opts = {}) {
  if (!snap || !snap.id) return false;
  if (!_idb) return false;
  const label = opts.label || null;
  const force = !!opts.force;
  const content = snap.content || '';
  const title = snap.title || '';
  const ts = Date.now();
  if (!force && !label) {
    if (!content && !title) return false;
    const lastTs = _lastSnapshotAt[snap.id] || 0;
    const lastContent = _lastSnapshotContent[snap.id];
    if (lastContent !== undefined && lastContent === content) return false;
    const gap = ts - lastTs;
    const diff = lastContent === undefined ? Infinity : Math.abs(content.length - lastContent.length);
    if (gap < VERSION_MIN_GAP_MS && diff < VERSION_MIN_DIFF_CHARS) return false;
  }
  const rec = { key: snap.id + '_' + ts, noteId: snap.id, ts, title, content, label };
  try { await idbPut('versions', rec); }
  catch (e) { logError(e, 'idb-version-put'); return false; }
  _lastSnapshotAt[snap.id] = ts;
  _lastSnapshotContent[snap.id] = content;
  if (!label) await pruneAutoVersions(snap.id);
  await dedupeVersionsForNote(snap.id);
  return true;
}

async function getAllVersions() {
  if (!_idb) return [];
  try { return await idbGetAll('versions'); }
  catch (e) { logError(e, 'idb-version-getall'); return []; }
}

async function migrateLegacyRestoreLabel() {
  if (!_idb) return;
  try {
    const flag = await idbGet('meta', 'restoreLabelMigrated');
    if (flag && flag.value) return;
    const all = await idbGetAll('versions');
    const noteIds = new Set();
    for (const v of all) {
      if (v.label === '恢复前') {
        noteIds.add(v.noteId);
        try { await idbPut('versions', { ...v, label: null }); }
        catch (e) { logError(e, 'idb-version-relabel'); }
      }
    }
    for (const id of noteIds) {
      await pruneAutoVersions(id);
      await dedupeVersionsForNote(id);
    }
    await idbPut('meta', { key: 'restoreLabelMigrated', value: true });
  } catch (e) { logError(e, 'restore-label-migrate'); }
}

async function bulkPutVersions(arr) {
  if (!_idb || !Array.isArray(arr)) return 0;
  let n = 0;
  for (const v of arr) {
    if (!v || !v.noteId || !v.ts) continue;
    const rec = {
      key: v.key || (v.noteId + '_' + v.ts),
      noteId: v.noteId,
      ts: v.ts,
      title: v.title || '',
      content: v.content || '',
      label: v.label || null
    };
    try { await idbPut('versions', rec); n++; }
    catch (e) { logError(e, 'idb-version-bulk'); }
  }
  return n;
}

let _versionListCache = [];
let _versionSelectedKey = null;

async function openVersionModal() {
  if (!currentNote) { showToast('请先选择一篇笔记'); return; }
  document.getElementById('versionNoteTitle').textContent = currentNote.title || '无题';
  document.getElementById('versionRestoreBtn').disabled = true;
  await refreshVersionList();
  document.getElementById('versionModalBg').classList.add('show');
}

function closeVersionModal() {
  document.getElementById('versionModalBg').classList.remove('show');
  _versionSelectedKey = null;
}

async function refreshVersionList() {
  if (!currentNote) return;
  await dedupeVersionsForNote(currentNote.id);
  _versionListCache = await listVersionsByNote(currentNote.id);
  const listEl = document.getElementById('versionList');
  if (!_versionListCache.length) {
    listEl.innerHTML = '<div style="color:var(--ink-mute);padding:20px 8px;text-align:center;font-size:12px;">暂无历史版本<br>编辑保存后会自动记录</div>';
    document.getElementById('versionPreviewMeta').textContent = '';
    document.getElementById('versionPreviewTitle').textContent = '';
    document.getElementById('versionPreviewContent').textContent = '';
    document.getElementById('versionRestoreBtn').disabled = true;
    return;
  }
  listEl.innerHTML = _versionListCache.map(v => {
    const time = formatFullDate(v.ts);
    const labelHtml = v.label
      ? `<span class="version-item-tag" style="background:var(--accent);color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;">${escapeHtml(v.label)}</span>`
      : '<span class="version-item-auto" style="color:var(--ink-mute);font-size:10px;margin-left:6px;">自动</span>';
    const len = (v.content || '').length;
    const titleSnip = escapeHtml((v.title || '无题').slice(0, 36));
    return `<div class="version-item" data-key="${v.key}" style="padding:8px 10px;border-radius:6px;cursor:pointer;border:1px solid transparent;margin-bottom:4px;">
      <div class="version-item-time" style="font-size:12px;font-weight:500;">${time}${labelHtml}</div>
      <div class="version-item-meta" style="font-size:11px;color:var(--ink-mute);margin-top:2px;">${len} 字符 · ${titleSnip}</div>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.version-item').forEach(el => {
    el.addEventListener('click', () => selectVersionItem(el.dataset.key));
  });
  selectVersionItem(_versionListCache[0].key);
}

function selectVersionItem(key) {
  _versionSelectedKey = key;
  const v = _versionListCache.find(x => x.key === key);
  if (!v) return;
  document.querySelectorAll('#versionList .version-item').forEach(el => {
    el.classList.toggle('active', el.dataset.key === key);
  });
  const labelTxt = v.label ? ' · ' + v.label : ' · 自动';
  document.getElementById('versionPreviewMeta').textContent = `${formatFullDate(v.ts)} · ${(v.content || '').length} 字符${labelTxt}`;
  document.getElementById('versionPreviewTitle').textContent = v.title || '无题';
  document.getElementById('versionPreviewContent').textContent = v.content || '';
  document.getElementById('versionRestoreBtn').disabled = false;
}

async function manualSnapshotCurrent() {
  if (!currentNote) { showToast('请先选择一篇笔记'); return; }
  currentNote.title = document.getElementById('titleInput').value;
  currentNote.content = document.getElementById('contentInput').value;
  currentNote.updatedAt = Date.now();
  saveNotes();
  const ok = await snapshotNote(
    { id: currentNote.id, title: currentNote.title, content: currentNote.content },
    { label: '手动', force: true }
  );
  if (ok) { showToast('已保存当前为版本'); await refreshVersionList(); }
  else showToast('保存版本失败');
}

function confirmRestoreSelectedVersion() {
  if (!_versionSelectedKey || !currentNote) return;
  const v = _versionListCache.find(x => x.key === _versionSelectedKey);
  if (!v) return;
  showModal(
    '恢复到此版本？',
    `将把当前笔记替换为 ${formatFullDate(v.ts)} 的版本。当前内容会自动保存为新版本，可再次回退。`,
    async () => {
      try {
        await snapshotNote(
          { id: currentNote.id, title: currentNote.title || '', content: currentNote.content || '' },
          { force: true }
        );
      } catch (e) { logError(e, 'snapshot-pre-restore'); }
      currentNote.title = v.title || '';
      currentNote.content = v.content || '';
      currentNote.updatedAt = Date.now();
      saveNotes();
      document.getElementById('titleInput').value = currentNote.title;
      document.getElementById('contentInput').value = currentNote.content;
      if (isPreviewMode) applyNotePreview(currentNote);
      updateWordCount();
      renderNotesList();
      document.getElementById('editorDate').textContent = formatFullDate(currentNote.updatedAt);
      document.getElementById('editorStatus').textContent = '已保存';
      closeVersionModal();
      showToast('已恢复到所选版本');
    }
  );
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

// THEME_KEY / FONT_* / 字体应用逻辑已移到 js/appearance.js

// ===================== 本地文件句柄存储（File System Access API）=====================
// FileSystemFileHandle 不能 JSON 序列化，必须放进 IndexedDB。
const FH_DB_NAME = 'marginote.fileHandles';
const FH_STORE = 'handles';
function fhOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FH_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FH_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function fhPut(noteId, handle) {
  const db = await fhOpenDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(FH_STORE, 'readwrite');
    tx.objectStore(FH_STORE).put(handle, noteId);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function fhGet(noteId) {
  const db = await fhOpenDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(FH_STORE, 'readonly');
    const r = tx.objectStore(FH_STORE).get(noteId);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}
async function fhDelete(noteId) {
  const db = await fhOpenDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(FH_STORE, 'readwrite');
    tx.objectStore(FH_STORE).delete(noteId);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function fhVerifyPermission(handle, write) {
  const opts = { mode: write ? 'readwrite' : 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

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
        content: `这是一本属于你的数字笔记本。**Marginote** 取自 *marginal note*（页边批注），是阅读时灵感的栖息地。

## 它能做什么

- 用 **笔记本** 把内容分门别类（左侧栏即可新建/管理）
- 创建、编辑和组织笔记
- 用 *Markdown* 语法格式化文字
- 通过 \`#标签\` 二级分类
- **收藏**重要的笔记
- 全文 **搜索**
- 一键 **导出/导入** JSON 备份

## 待办事项

左栏「待办」可创建任务，支持优先级、截止时间和系统级提醒（提前 N 分 × 重复 K 次）。笔记里也能写 \`- [ ]\` 创建待办行。

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

// 兜底：用 JS 强制把 data-color 的值落到 background-color。
// 背景：WebView2 在 Tauri 2 release 下偶尔会丢失 inline style="background:..."
// 的解析（参见 12b5cee 的 textContent → innerHTML CSSOM 修复）。
// 用 setProperty('background-color', c, 'important') 走 CSSOM 直写路径，
// 比 inline 解析更可靠；并且对静态 + 动态色点统一适用。
function paintDotColors(scope) {
  const root = scope || document;
  const sel = '.nb-dot[data-color], .note-nb-dot[data-color], '
            + '.todo-status-dot[data-color], .color-swatch[data-color], '
            + '.theme-card-swatch[data-color]';
  root.querySelectorAll(sel).forEach(el => {
    const c = el.getAttribute('data-color');
    if (c) el.style.setProperty('background-color', c, 'important');
  });
}

// 平台判定 + 快捷键标签替换。
// 默认 HTML 里写的是 ⌘（给 Mac 浏览器用），Win/Linux/桌面版 .exe 上换成 Ctrl。
function isMacLike() {
  try {
    const ua = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
    return /Mac|iPhone|iPad|iPod/i.test(ua);
  } catch { return false; }
}
function applyShortcutLabels() {
  if (isMacLike()) return; // Mac 保留 ⌘
  // 1) 空状态提示里的 <kbd>⌘</kbd>
  document.querySelectorAll('.kbd kbd').forEach(el => {
    if (el.textContent === '⌘') el.textContent = 'Ctrl';
  });
  // 2) 编辑器工具栏 title="加粗 (⌘B)" 这类
  document.querySelectorAll('[title]').forEach(el => {
    const t = el.getAttribute('title');
    if (t && t.indexOf('⌘') !== -1) {
      el.setAttribute('title', t.replace(/⌘/g, 'Ctrl+'));
    }
  });
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

// 列表项预览：画板显示缩略图（不显示场景 JSON），普通笔记显示文本摘要
function noteListPreviewHtml(n) {
  if (n.type === 'drawing') {
    const ref = n.thumb && /^img:([a-z0-9]+)$/i.test(n.thumb) ? n.thumb.slice(4) : null;
    const img = ref && images[ref];
    if (img && img.dataUrl) {
      return `<div class="note-preview note-preview-thumb"><img src="${img.dataUrl}" alt="画板缩略图" style="max-width:100%;max-height:90px;border-radius:6px;border:1px solid var(--rule-soft);"></div>`;
    }
    return `<div class="note-preview" style="font-style:italic;color:var(--ink-mute);">空白画板</div>`;
  }
  const preview = stripMarkdown(n.content || '').slice(0, 100);
  return preview ? `<div class="note-preview">${escapeHtml(preview)}</div>` : '';
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
    const tags = (n.tags || []).slice(0, 3).map(t =>
      `<span class="note-tag">${escapeHtml(t)}</span>`
    ).join('');
    const isActive = currentNote && currentNote.id === n.id;
    const nb = getNotebook(n.notebookId);
    const nbBadge = (showNbBadge && nb)
      ? `<span class="note-nb-badge"><span class="note-nb-dot" data-color="${nb.color}" style="background-color:${nb.color}"></span>${escapeHtml(nb.name)}</span>`
      : '';
    return `
      <div class="note-item ${isActive ? 'active' : ''}" data-id="${n.id}" title="${escapeHtml(n.title || '无题')}">
        <div class="note-item-head">
          <div class="note-title" title="${escapeHtml(n.title || '无题')}">${n.starred ? '<span class="note-pin">★</span>' : ''}${n.type === 'drawing' ? '✎ ' : ''}${escapeHtml(n.title || '无题')}</div>
          <div class="note-date">${date}</div>
        </div>
        ${noteListPreviewHtml(n)}
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
        <span class="nb-dot" data-color="${nb.color}" style="background-color:${nb.color}"></span>
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
  paintDotColors(container);
  if (typeof paintFontStyles === 'function') paintFontStyles(container);

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
  // 用 setProperty + 'important' 走 CSSOM 直写路径，避开 WebView2 inline 漏洞
  document.getElementById('currentNbDot').style.setProperty('background-color', dotColor, 'important');

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
  if (typeof paintFontStyles === 'function') paintFontStyles(container);

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
  pvBtn.classList.remove('active');
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
    btn.classList.remove('active');
    btn.setAttribute('data-tip', '编辑');
  } else {
    ta.style.display = '';
    pv.style.display = 'none';
    btn.classList.add('active');
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
    clearAlarmsByPrefix(`mtodo:${id}:`).then(() => syncRemindersToExt());
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
  clearAlarmsByPrefix(`mtodo:${id}:`).then(() => syncRemindersToExt());
  renderTodos();
  renderTodoCounts();
  updateCollectionCount();
  showToast('已删除待办');
}

// ===================== 主题 / 字体 / 设置标签页 =====================
// 已移到 js/appearance.js

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
    `<div class="color-swatch ${c === pickedColor ? 'selected' : ''}" data-color="${c}" style="background-color:${c}"></div>`
  ).join('');
  paintDotColors(picker);
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
  // 画板类型笔记交给 Excalidraw 模块处理（drawing.js）
  if (note && note.type === 'drawing' && typeof window.openDrawing === 'function') {
    currentNote = note;
    currentTodo = null;
    return window.openDrawing(note);
  }
  // 切回普通笔记时收起画板视图（若打开过）
  const _dw = document.getElementById('drawingWrap');
  if (_dw) _dw.style.display = 'none';
  currentNote = note;
  currentTodo = null;
  isPreviewMode = true;
  if (note && note.id) {
    listVersionsByNote(note.id).then(arr => {
      if (arr.length) {
        _lastSnapshotAt[note.id] = arr[0].ts;
        _lastSnapshotContent[note.id] = arr[0].content || '';
      } else {
        delete _lastSnapshotAt[note.id];
        delete _lastSnapshotContent[note.id];
      }
    }).catch(() => {});
  }
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('editorWrap').style.display = 'block';
  document.getElementById('todoEditorWrap').style.display = 'none';
  document.getElementById('app').classList.add('show-editor');

  document.getElementById('titleInput').value = note.title || '';
  document.getElementById('contentInput').value = note.content || '';
  document.getElementById('editorDate').textContent = formatFullDate(note.updatedAt);
  document.getElementById('editorStatus').textContent = '已保存';
  document.getElementById('htmlModeBtn')?.classList.toggle('active', note.format === 'html');

  // 笔记本徽标
  const nb = getNotebook(note.notebookId);
  const nbEl = document.getElementById('editorNbBadge');
  if (nb) {
    nbEl.innerHTML = `<span class="nb-dot" data-color="${nb.color}" style="background-color:${nb.color}"></span>${escapeHtml(nb.name)}`;
    const folder = getFolder(note.folderId);
    if (folder) nbEl.innerHTML += ` · ${escapeHtml(folder.name)}`;
    paintDotColors(nbEl);
  } else {
    nbEl.innerHTML = '';
  }

  const starBtn = document.getElementById('starBtn');
  starBtn.classList.toggle('starred', !!note.starred);
  starBtn.setAttribute('data-tip', note.starred ? '取消收藏' : '收藏');

  const modeBtn = document.getElementById('modeBtn');
  modeBtn.classList.remove('active');
  modeBtn.setAttribute('data-tip', '编辑');

  // 默认预览模式
  applyNotePreview(note);
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

async function openLocalFile() {
  if (!('showOpenFilePicker' in window)) {
    showToast('当前浏览器不支持本地文件读写 API');
    return;
  }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Markdown / 文本文件',
        accept: {
          'text/markdown': ['.md', '.markdown'],
          'text/plain': ['.txt']
        }
      }],
      multiple: false,
      excludeAcceptAllOption: false
    });
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
      showToast('打开文件失败');
    }
    return;
  }

  let text;
  try {
    const file = await handle.getFile();
    text = await file.text();
  } catch (e) {
    console.error(e);
    showToast('读取文件失败');
    return;
  }

  // 选定归属笔记本（与 createNote 同逻辑）
  let targetNbId;
  if (currentView.startsWith('folder:')) {
    const f = getFolder(currentView.slice(7));
    targetNbId = f ? f.notebookId : (notebooks[0] ? notebooks[0].id : null);
  } else if (currentView.startsWith('nb:')) {
    targetNbId = currentView.slice(3);
  } else if (notebooks.length > 0) {
    targetNbId = notebooks[0].id;
    if (currentView !== 'all') switchView('all');
  } else {
    const nb = { id: uid(), name: '默认', color: '#525252', createdAt: Date.now() };
    notebooks.push(nb);
    targetNbId = nb.id;
    saveData();
    renderNotebooks();
  }

  const baseName = handle.name.replace(/\.(md|markdown|txt)$/i, '');
  const note = {
    id: uid(),
    notebookId: targetNbId,
    folderId: currentView.startsWith('folder:') ? currentView.slice(7) : null,
    title: baseName,
    content: text,
    tags: [],
    starred: false,
    deleted: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    linkedFile: { name: handle.name, syncedAt: Date.now() }
  };
  notes.unshift(note);
  try {
    await fhPut(note.id, handle);
  } catch (e) {
    console.error('persist handle failed', e);
    showToast('文件已读入，但句柄保存失败（重启扩展后将无法写回）');
  }
  saveData();
  selectNote(note);
  renderNotesList();
  renderNotebooks();
  showToast(`已打开 ${handle.name}`);
}

// 写回磁盘（autoSave 触发后调用）。失败不会阻断本地保存。
async function syncLinkedFile(note) {
  if (!note || !note.linkedFile) return;
  let handle;
  try {
    handle = await fhGet(note.id);
  } catch (e) {
    console.error('fhGet failed', e);
    return;
  }
  if (!handle) return;
  try {
    if (!(await fhVerifyPermission(handle, true))) {
      showToast('未获得本地文件写入权限');
      return;
    }
    const writable = await handle.createWritable();
    await writable.write(note.content || '');
    await writable.close();
    note.linkedFile.syncedAt = Date.now();
    saveData();
  } catch (e) {
    console.error('sync linked file failed', e);
    showToast('写回本地文件失败');
  }
}

// 中栏列表当前项原地更新：编辑笔记时只改当前项的 标题/预览/日期/标签，
// 不重建整列 innerHTML，避免每次保存重放 .note-item 的 fadeIn 动画导致闪烁。
// 列表成员或顺序变化时回退到全量 renderNotesList()。
function updateActiveNoteListItem() {
  const container = document.getElementById('notesList');
  if (!container || !currentNote) { renderNotesList(); return; }
  const desired = getFilteredNotes();
  const domItems = container.querySelectorAll('.note-item');
  if (desired.length !== domItems.length) { renderNotesList(); return; }
  for (let i = 0; i < desired.length; i++) {
    if (desired[i].id !== domItems[i].dataset.id) { renderNotesList(); return; }
  }
  const el = container.querySelector(`.note-item[data-id="${currentNote.id}"]`);
  if (!el) { renderNotesList(); return; }
  const n = currentNote;
  const showNbBadge = !currentView.startsWith('nb:') && !currentView.startsWith('folder:');
  const nb = getNotebook(n.notebookId);
  const tags = (n.tags || []).slice(0, 3).map(t => `<span class="note-tag">${escapeHtml(t)}</span>`).join('');
  const nbBadge = (showNbBadge && nb)
    ? `<span class="note-nb-badge"><span class="note-nb-dot" data-color="${nb.color}" style="background-color:${nb.color}"></span>${escapeHtml(nb.name)}</span>`
    : '';
  // 仅替换 .note-item 的内部，不重建元素本身 → 不重放 fadeIn，点击监听也保留
  el.setAttribute('title', escapeHtml(n.title || '无题'));
  el.innerHTML = `
        <div class="note-item-head">
          <div class="note-title" title="${escapeHtml(n.title || '无题')}">${n.starred ? '<span class="note-pin">★</span>' : ''}${n.type === 'drawing' ? '✎ ' : ''}${escapeHtml(n.title || '无题')}</div>
          <div class="note-date">${formatDate(n.updatedAt)}</div>
        </div>
        ${noteListPreviewHtml(n)}
        <div class="note-foot">
          ${nbBadge}
          ${tags ? `<div class="note-tags">${tags}</div>` : ''}
        </div>`;
  if (typeof updateCollectionCount === 'function') updateCollectionCount();
}

function autoSave() {
  if (!currentNote) return;
  document.getElementById('editorStatus').textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const newTitle = document.getElementById('titleInput').value;
    const newContent = document.getElementById('contentInput').value;
    const oldTitle = currentNote.title || '';
    const oldContent = currentNote.content || '';
    const changed = newTitle !== oldTitle || newContent !== oldContent;
    if (changed && (oldContent || oldTitle)) {
      try { await snapshotNote({ id: currentNote.id, title: oldTitle, content: oldContent }); }
      catch (e) { logError(e, 'snapshot-autosave'); }
    }
    currentNote.title = newTitle;
    currentNote.content = newContent;
    currentNote.updatedAt = Date.now();
    saveNotes();
    document.getElementById('editorDate').textContent = formatFullDate(currentNote.updatedAt);
    document.getElementById('editorStatus').textContent = '已保存';
    updateActiveNoteListItem();
    if (currentNote.linkedFile) {
      syncLinkedFile(currentNote);
    }
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
        if (currentNote.linkedFile) {
          fhDelete(currentNote.id).catch(err => console.error('fhDelete failed', err));
        }
        // 画板永久删除：清理缩略图，避免图片仓孤儿
        if (currentNote.type === 'drawing' && currentNote.thumb && /^img:([a-z0-9]+)$/i.test(currentNote.thumb)) {
          const tid = currentNote.thumb.slice(4);
          try { delete images[tid]; } catch (e) {}
          try { idbDelete('images', tid); } catch (e) {}
        }
        notes = notes.filter(n => n.id !== currentNote.id);
      } else {
        currentNote.deleted = true;
        currentNote.updatedAt = Date.now();
      }
      saveData();
      currentNote = null;
      document.getElementById('emptyState').style.display = 'flex';
      document.getElementById('editorWrap').style.display = 'none';
      const _dw = document.getElementById('drawingWrap'); if (_dw) _dw.style.display = 'none';
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
          <span class="nb-dot" data-color="${nb.color}" style="background-color:${nb.color}"></span>
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
  paintDotColors(menu);
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
  if (nb) {
    nbEl.innerHTML = `<span class="nb-dot" data-color="${nb.color}" style="background-color:${nb.color}"></span>${escapeHtml(nb.name)}`;
    paintDotColors(nbEl);
  }
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
  if (nb) {
    nbEl.innerHTML = `<span class="nb-dot" data-color="${nb.color}" style="background-color:${nb.color}"></span>${escapeHtml(nb.name)} · ${escapeHtml(folder.name)}`;
    paintDotColors(nbEl);
  }
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
    modeBtn.classList.remove('active');
    modeBtn.setAttribute('data-tip', '编辑');
  } else {
    ta.style.display = '';
    pv.style.display = 'none';
    modeBtn.classList.add('active');
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
    breaks: true,
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

function applyNotePreview(note, contentOverride) {
  const el = document.getElementById('preview');
  if (!el) return;
  if (!note) { el.innerHTML = ''; return; }
  const content = contentOverride !== undefined ? contentOverride : (note.content || '');
  if (note.format === 'html') {
    el.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.className = 'html-preview-frame';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    iframe.style.cssText = 'width:100%;border:0;background:#fff;display:block;min-height:60vh';
    iframe.srcdoc = content;
    el.appendChild(iframe);
  } else {
    el.innerHTML = renderMarkdown(content);
  }
}

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

  // 2.5 分隔线：当 `---` / `***` / `___` 紧跟非空行时，markdown-it 会把上一行解析为 setext H2，
  // 导致分隔线“消失”/被误读。这里主动在其前面插入空行，保证恒为 thematic break。
  {
    const arr = processed.split('\n');
    const out = [];
    const hrRe = /^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
    for (let i = 0; i < arr.length; i++) {
      if (hrRe.test(arr[i]) && i > 0 && arr[i - 1].trim() !== '') out.push('');
      out.push(arr[i]);
    }
    processed = out.join('\n');
  }

  // 3. markdown-it 渲染（出错回退到转义文本）
  const renderer = getMdRenderer();
  let html;
  if (renderer) {
    try { html = renderer.render(processed); }
    catch (e) { logError(e, 'markdown-render'); html = '<pre>' + escapeHtml(processed) + '</pre>'; }
  } else {
    html = '<pre>' + escapeHtml(processed) + '</pre>';
  }

  // 4. 任务列表 post-process（同时处理紧凑 <li>[ ] 和松散 <li><p>[ ] 两种渲染）
  // 注入 modified-checkbox 类，CSS 用 :before/:after 绘制方框 + 对勾
  html = html
    .replace(/<li>(\s*<p>)?\[ \]\s+/g,
      (_m, p) => `<li class="task-item">${p || ''}<input type="checkbox" class="modified-checkbox" disabled> `)
    .replace(/<li>(\s*<p>)?\[x\]\s+/gi,
      (_m, p) => `<li class="task-item task-done">${p || ''}<input type="checkbox" class="modified-checkbox" checked disabled> `);

  // 5. DOMPurify XSS 清洗
  if (window.DOMPurify) {
    html = window.DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel', 'disabled', 'checked'],
      ALLOWED_URI_REGEXP: SAFE_URI_RE,
      FORBID_TAGS: ['style', 'iframe', 'frame', 'object', 'embed', 'form', 'button', 'script'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur']
    });
  }

  // 6. 动态注入 modified-checkbox 类（防御性，兼容历史数据 / 未匹配的 li 结构）
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  applyTaskCheckboxClasses(tmp);
  return tmp.innerHTML;
}

// 渲染后处理 markdown 待办 checkbox：
//   1. 父级 <li> 标记 task-item / task-done（CSS 伪元素绘制方框 + 对勾）
//   2. 直接 REMOVE 原生 <input> 节点 — 彻底消除浏览器原生 checkbox 的视觉痕迹
//      （备用 CSS 已加 vanish-checkbox class + 极端隐藏，做双保险）
function applyTaskCheckboxClasses(rootEl) {
  if (!rootEl || !rootEl.querySelectorAll) return;
  rootEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.classList.add('modified-checkbox', 'vanish-checkbox');
    const li = cb.closest('li');
    if (li) {
      if (!li.classList.contains('task-item')) li.classList.add('task-item');
      const isChecked = cb.checked || cb.hasAttribute('checked');
      if (isChecked && !li.classList.contains('task-done')) {
        li.classList.add('task-done');
      }
    }
    // 清掉空白文本节点（avoid 残留 ' '/`\n` 推开布局）
    const next = cb.nextSibling;
    cb.remove();
    if (next && next.nodeType === 3 && /^\s+$/.test(next.nodeValue)) next.remove();
  });
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
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
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
    case 'codeblock': newText = `\`\`\`\n${sel || '代码'}\n\`\`\``; break;
    case 'quote': newText = `> ${sel || '引用文字'}`; break;
    case 'list': newText = `- ${sel || '列表项'}`; break;
    case 'checkbox': newText = `- [ ] ${sel || '待办事项'}`; break;
    case 'link': newText = `[${sel || '链接文字'}](https://)`; break;
    case 'hr': newText = `\n\n---\n\n`; break;
  }

  ta.focus();
  // 使用 execCommand('insertText') 保留浏览器原生 undo 栈，
  // 避免直接 ta.value=... 清空历史导致 Ctrl+Z 失效。
  let inserted = false;
  try { inserted = document.execCommand('insertText', false, newText); } catch { inserted = false; }
  if (!inserted) {
    ta.value = before + newText + after;
    const fb = start + newText.length + cursorOffset;
    ta.setSelectionRange(fb, fb);
  } else if (cursorOffset !== 0) {
    const pos = ta.selectionStart + cursorOffset;
    ta.setSelectionRange(pos, pos);
  }
  autoSave();
  updateWordCount();
}

function insertAtCursor(ta, text) {
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (ok) return;
  // 回退：execCommand 不可用时手动拼接（会丢失 undo 栈，仅作兜底）
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
  const pos = start + text.length;
  ta.setSelectionRange(pos, pos);
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
        applyNotePreview(currentNote, ta.value);
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

// ===================== Markdown 编辑增强（Tab 缩进 + 列表续行）=====================
function attachMarkdownEditor(textareaId) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  ta.addEventListener('keydown', (e) => {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const v = ta.value;

    if (e.key === 'Tab') {
      e.preventDefault();
      if (start !== end) {
        // 多行选择：缩进 / 反缩进所选行
        const lineStart = v.lastIndexOf('\n', start - 1) + 1;
        const sel = v.slice(lineStart, end);
        const replaced = e.shiftKey
          ? sel.replace(/^(?: {1,2}|\t)/gm, '')
          : sel.replace(/^/gm, '  ');
        ta.value = v.slice(0, lineStart) + replaced + v.slice(end);
        ta.selectionStart = lineStart;
        ta.selectionEnd = lineStart + replaced.length;
      } else if (e.shiftKey) {
        // 单行反缩进
        const ls = v.lastIndexOf('\n', start - 1) + 1;
        const m = v.slice(ls).match(/^( {1,2}|\t)/);
        if (m) {
          const cut = m[0].length;
          ta.value = v.slice(0, ls) + v.slice(ls + cut);
          ta.selectionStart = ta.selectionEnd = Math.max(ls, start - cut);
        }
      } else {
        // 插入两空格
        ta.value = v.slice(0, start) + '  ' + v.slice(end);
        ta.selectionStart = ta.selectionEnd = start + 2;
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const ls = v.lastIndexOf('\n', start - 1) + 1;
      const line = v.slice(ls, start);
      // 匹配 -, *, +, 1., 2. 等列表前缀，可选 [ ] / [x] checkbox
      const m = line.match(/^(\s*)(([-*+]|\d+\.)\s+)(\[[ xX]\]\s+)?(.*)$/);
      if (!m) return;
      const indent = m[1];
      const bulletRaw = m[2];
      const checkbox = m[4] || '';
      const content = m[5];
      if (!content) {
        // 空 bullet 行：退出列表 → 删本行前缀
        e.preventDefault();
        ta.value = v.slice(0, ls) + v.slice(start);
        ta.selectionStart = ta.selectionEnd = ls;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      // 续行：自增数字序号；checkbox 总是空 [ ]
      e.preventDefault();
      let nextBullet = bulletRaw;
      const numM = bulletRaw.match(/^(\d+)\.(\s+)$/);
      if (numM) nextBullet = (parseInt(numM[1], 10) + 1) + '.' + numM[2];
      const nextCb = checkbox ? '[ ] ' : '';
      const insert = '\n' + indent + nextBullet + nextCb;
      ta.value = v.slice(0, start) + insert + v.slice(end);
      ta.selectionStart = ta.selectionEnd = start + insert.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
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
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(binary);
}

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

async function exportAll(opts) {
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
    const isDrawing = n.type === 'drawing';
    const fileExt = isDrawing ? '.excalidraw' : '.md';
    let fileBase = safeName(n.title || (isDrawing ? 'untitled-drawing' : 'untitled'));
    let key = dir + '/' + fileBase + fileExt;
    let count = usedNames.get(key) || 0;
    if (count > 0) fileBase = fileBase + '-' + (count + 1);
    usedNames.set(key, count + 1);
    const path = (dir ? dir + '/' : '') + fileBase + fileExt;
    if (isDrawing) {
      zip.file(path, drawingToFile(n));
      return;
    }
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

  // 笔记历史版本
  let versionCount = 0;
  try {
    const allVersions = await getAllVersions();
    const aliveIds = new Set(aliveNotes.map(n => n.id));
    const filtered = allVersions.filter(v => aliveIds.has(v.noteId));
    if (filtered.length) {
      zip.file('_versions.json', JSON.stringify(filtered, null, 2));
      versionCount = filtered.length;
    }
  } catch (e) { logError(e, 'export-versions'); }

  const blob = await zip.generateAsync({ type: 'blob' });
  const backupName = `marginote-backup-${new Date().toISOString().slice(0,10)}.zip`;
  const summary = `${aliveNotes.length} 篇笔记 + ${usedImgIds.size} 张图${versionCount ? ' + ' + versionCount + ' 历史版本' : ''}`;
  // 自动备份(opts.toWorkdir)优先写入工作目录 _backups/，用户能找到路径；
  // 未设工作目录或写入失败时回退浏览器下载。手动导出默认下载。
  if (opts && opts.toWorkdir && typeof workdirAvailable === 'function' && workdirAvailable()
      && _workdirCfg.enabled && fsApi() && await fsApi().hasDir()) {
    try {
      const b64 = await blobToBase64(blob);
      if (await fsApi().writeBinary('_backups/' + backupName, b64)) {
        showToast('已自动备份到工作目录 _backups/' + backupName);
        return true;
      }
    } catch (e) { logError(e, 'auto-backup-workdir'); }
  }
  downloadBlob(blob, backupName);
  showToast(`已导出 ${summary}`);
  return true;
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
          // 历史版本（旧备份无此字段则跳过）
          const versionsFile = zip.file('_versions.json');
          if (versionsFile) {
            try {
              const versionsArr = JSON.parse(await versionsFile.async('string'));
              if (Array.isArray(versionsArr)) await bulkPutVersions(versionsArr);
            } catch (err) { logError(err, 'import-versions'); }
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
const AI_ACTIONS_KEY = 'marginote.aiActions';
const AI_ACTIONS_DEFAULTS = [
  { id: 'title',       label: '🏷 标题总结',     mode: 'title',   system: '## 任务：生成精准标题\n1. 根据内容提炼一个 20 字以内的自然语言标题。\n2. 标题需要使用简洁的中文，精准概括内容主题，不要使用任何前缀或分隔符（如破折号、冒号、竖线等）。\n3. **直接返回纯标题文本一行**，不要添加任何前后缀、解释或额外内容，不要使用 emoji。' },
  { id: 'polish',      label: '✨ 润色优化',     mode: 'replace', system: '## 角色：专业中文写作助手\n**任务：** 提升内容的逻辑性与易读性，保持原文核心信息不变。\n**要求：** \n- **禁止添加标题：** 不要为内容添加 # 标题、章节名或任何形式的标题。\n- **分段：** 将长段落按逻辑点拆分，增加行间距感。\n- **强调：** 对核心概念进行 **加粗**。\n- **列表：** 若文中包含多个并列观点，请转化为 Markdown 列表。\n- **直接输出：** 仅返回优化后的 Markdown 内容。' },
  { id: 'summarize',   label: '📝 总结要点',     mode: 'append',  system: '## 角色：首席笔记速记员\n**任务：** 提炼原文关键信息，以总结形式追加到原文末尾。\n**重要：** 不要覆盖或修改原文内容，总结部分放在原文的后面。\n**总结结构要求：**\n- **## 📝 要点总结**：使用列表列出关键点。\n- **## 🔜 结论/下一步**：简短说明后续动作。\n- **标注：** 关键信息必须 **加粗**。' },
  { id: 'expand',      label: '📖 扩写丰富',     mode: 'replace', system: '## 角色：资深内容编辑\n**任务：** 增加深度与细节。\n**逻辑：** 使用 `###` 子标题对扩写后的各部分进行分类，并增加具体的应用场景或原理说明，确保 Markdown 层级清晰。' },
  { id: 'continue',    label: '✍️ 智能续写',     mode: 'append',  system: '## 角色：逻辑严密的续写专家\n**任务：** 保持风格一致并向下延伸。\n**要求：** 衔接紧凑，如果前文有 Markdown 格式（如列表或代码块），请保持格式的一致性继续输出。' },
  { id: 'grammar',     label: '🩹 修正语法',     mode: 'replace', system: '## 角色：专业校对员\n**任务：** 修正错别字与标点。\n**视觉优化：** 确保中英文之间有空格，统一 Markdown 符号的使用。仅返回修正后的全文。' },
  { id: 'translateEn', label: '🌐 翻译为英文',   mode: 'replace', system: '## Role: Professional Translator\n**Task:** Translate to natural English.\n**Formatting:** Use standard Markdown. Apply **bolding** for keywords to help quick scanning. Only output the translation.' },
  { id: 'translateZh', label: '🇨🇳 翻译为中文',   mode: 'replace', system: '## 角色：地道翻译官\n**任务：** 翻译为流畅中文。\n**规范：** 增加适当的分段和 **重点加粗**，确保技术术语准确。直接输出结果。' },
  { id: 'custom',      label: '⚙ 自定义指令…',   mode: 'custom' }
];
let AI_ACTIONS = AI_ACTIONS_DEFAULTS.map(a => ({ ...a }));

function loadAiActionOverrides() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(AI_ACTIONS_KEY)) || {}; } catch { stored = {}; }

  // 兼容老版本：旧 shape 为 {id: {label, system}}，新 shape 为 {overrides, custom, disabled}
  let overrides = {}, customList = [], disabled = [];
  if (stored && (stored.overrides || stored.custom || stored.disabled)) {
    overrides = stored.overrides || {};
    customList = Array.isArray(stored.custom) ? stored.custom : [];
    disabled = Array.isArray(stored.disabled) ? stored.disabled : [];
  } else if (stored && typeof stored === 'object') {
    overrides = stored;
  }

  AI_ACTIONS = AI_ACTIONS_DEFAULTS.map(def => {
    const o = overrides[def.id];
    return {
      ...def,
      label: o && typeof o.label === 'string' && o.label.trim() ? o.label : def.label,
      system: o && typeof o.system === 'string' ? o.system : def.system,
      enabled: !disabled.includes(def.id),
    };
  });

  customList.forEach(c => {
    if (!c || !c.id || AI_ACTIONS.some(x => x.id === c.id)) return;
    AI_ACTIONS.push({
      id: c.id,
      label: typeof c.label === 'string' && c.label.trim() ? c.label : '自定义指令',
      mode: c.mode === 'append' ? 'append' : 'replace',
      system: typeof c.system === 'string' ? c.system : '',
      enabled: !disabled.includes(c.id),
      isCustom: true,
    });
  });

  const ci = AI_ACTIONS.findIndex(a => a.id === 'custom');
  if (ci >= 0) {
    const [ce] = AI_ACTIONS.splice(ci, 1);
    ce.enabled = true;
    AI_ACTIONS.push(ce);
  }
}

function saveAiActionOverrides() {
  const overrides = {};
  const customList = [];
  const disabled = [];
  AI_ACTIONS.forEach(a => {
    if (a.mode === 'custom') return;
    if (a.isCustom) {
      customList.push({ id: a.id, label: a.label, mode: a.mode, system: a.system });
    } else {
      const def = AI_ACTIONS_DEFAULTS.find(d => d.id === a.id);
      if (def && (a.label !== def.label || a.system !== def.system)) {
        overrides[a.id] = { label: a.label, system: a.system };
      }
    }
    if (a.enabled === false) disabled.push(a.id);
  });
  try {
    localStorage.setItem(AI_ACTIONS_KEY, JSON.stringify({ overrides, custom: customList, disabled }));
  } catch {}
}

function resetAiActionOverrides() {
  try { localStorage.removeItem(AI_ACTIONS_KEY); } catch {}
  loadAiActionOverrides();
}

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
  const hdrsEl = document.getElementById('aiFormHeaders');
  if (hdrsEl) hdrsEl.value = p.customHeaders ? JSON.stringify(p.customHeaders) : '';
  document.getElementById('aiFormSystem').value = p.system || '';
  document.getElementById('aiFormTemp').value = p.temperature ?? 0.7;
  const mmCb = document.getElementById('aiFormMultimodal');
  if (mmCb) mmCb.checked = !!p.multimodal;
  const csEl = document.getElementById('aiFormContextSize');
  if (csEl) csEl.value = p.contextSize || '';
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
  let customHeaders = null;
  const hdrsVal = (document.getElementById('aiFormHeaders')?.value || '').trim();
  if (hdrsVal) { try { customHeaders = JSON.parse(hdrsVal); } catch { showToast('自定义请求头格式错误，需 JSON 对象'); return; } }
  const system = document.getElementById('aiFormSystem').value;
  const temperature = parseFloat(document.getElementById('aiFormTemp').value);
  const mmCb = document.getElementById('aiFormMultimodal');
  const multimodal = !!(mmCb && mmCb.checked);
  if (!name) { showToast('请填写名称'); return; }
  if (!endpoint) { showToast('请填写接口地址'); return; }
  if (!model) { showToast('请填写模型 ID'); return; }
  const contextSize = parseInt(document.getElementById('aiFormContextSize')?.value) || 0;
  const fields = { name, endpoint, model, apiKey, proxyPrefix, customHeaders, system, temperature: isNaN(temperature) ? 0.7 : temperature, multimodal, contextSize };
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
  showToast('已保存');
}


async function testModelContextSize() {
  const endpoint = document.getElementById('aiFormEndpoint').value.trim();
  const model = document.getElementById('aiFormModel').value.trim();
  const apiKey = document.getElementById('aiFormKey').value;
  const proxyPrefix = document.getElementById('aiFormProxy').value.trim();
  let customHeaders = null;
  const hdrsVal = (document.getElementById('aiFormHeaders')?.value || '').trim();
  if (hdrsVal) { try { customHeaders = JSON.parse(hdrsVal); } catch {} }
  if (!endpoint || !model) { showToast('\u8bf7\u5148\u586b\u5199\u63a5\u53e3\u5730\u5740\u548c\u6a21\u578b ID'); return; }
  const statusEl = document.getElementById('aiContextTestStatus');
  const btn = document.getElementById('aiContextTestBtn');
  btn.disabled = true;
  statusEl.textContent = '\u51c6\u5907\u6d4b\u8bd5\u2026';
  let url = endpoint;
  if (/\/v\d+\/?$/.test(url)) url = url.replace(/\/?$/, '/chat/completions');
  if (proxyPrefix && !/^(http|socks)/i.test(proxyPrefix)) {
    if (proxyPrefix.includes('{url}')) url = proxyPrefix.replace('{url}', encodeURIComponent(url));
    else if (proxyPrefix.includes('{ENDPOINT}')) url = proxyPrefix.replace('{ENDPOINT}', url);
  }
  const hdrs = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (apiKey || '') };
  if (customHeaders) Object.assign(hdrs, customHeaders);
  const isHttpNL = /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url);
  const usePF = isHttpNL && window.mn?.platform?.fetch;
  if (usePF) { try { await window.mn.ready; } catch {} }
  function genPad(sK) {
    const lines = []; let len = 0; const tgt = sK * 4000;
    for (let i = 0; len < tgt; i++) {
      const l = 'Line ' + String(i).padStart(5,'0') + ': The quick brown fox jumps over the lazy dog and five boxing wizards jump quickly.\n';
      lines.push(l); len += l.length;
    }
    return lines.join('');
  }
  async function tryK(sK) {
    const msgs = [{ role:'system', content:'Reply with exactly one word: OK' },{ role:'user', content:'Ignore padding below. Reply ONLY: OK\n\n' + genPad(sK) }];
    const bodyStr = JSON.stringify({ model, messages: msgs, temperature:0, max_tokens:5, stream:false });
    try {
      if (usePF) {
        const res = await mn.platform.fetch(url, { method:'POST', headers:hdrs, body:bodyStr }, null);
        if (!res.ok) { const b = res.body || res.error || ''; const m = b.match(/maximum[^0-9]*(\d{3,})/i) || b.match(/max[_ ]tokens?[^0-9]*(\d{4,})/i); return m ? { ok:false, limit:Math.floor(parseInt(m[1])/1000) } : { ok:false }; }
        return { ok:true };
      }
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), sK > 64 ? 60000 : 30000);
      const res = await fetch(url, { method:'POST', headers:hdrs, body:bodyStr, signal:ctrl.signal });
      clearTimeout(tm);
      if (!res.ok) { const t = await res.text().catch(()=>''); const m = t.match(/maximum[^0-9]*(\d{3,})/i) || t.match(/max[_ ]tokens?[^0-9]*(\d{4,})/i); return m ? { ok:false, limit:Math.floor(parseInt(m[1])/1000) } : { ok:false }; }
      const d = await res.json();
      return { ok:!!(d?.choices?.[0]?.message?.content) };
    } catch { return { ok:false }; }
  }
  try {
    statusEl.textContent = '\u9a8c\u8bc1\u8fde\u63a5\u2026';
    const r0 = await tryK(1);
    if (!r0.ok) { statusEl.textContent = '\u274c \u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u914d\u7f6e'; btn.disabled = false; return; }
    const sizes = [2,4,8,16,32,64,128,256];
    let last = 1, prog = '1K\u2713 ';
    for (const sK of sizes) {
      prog += sK + 'K\u2026'; statusEl.textContent = prog;
      const r = await tryK(sK);
      if (r.ok) { last = sK; prog = prog.replace(sK+'K\u2026', sK+'K\u2713 '); statusEl.textContent = prog; }
      else {
        prog = prog.replace(sK+'K\u2026', sK+'K\u2717'); statusEl.textContent = prog;
        if (r.limit) { last = r.limit; statusEl.textContent += ' (API:\u2248' + r.limit + 'K)'; break; }
        let lo = last, hi = sK;
        while (hi - lo > 1) { const mid = Math.floor((lo+hi)/2); statusEl.textContent = prog + ' \u2192' + mid + 'K\u2026'; const rm = await tryK(mid); if (rm.ok) lo = mid; else { if (rm.limit) { lo = rm.limit; break; } hi = mid; } }
        last = lo; break;
      }
    }
    document.getElementById('aiFormContextSize').value = last;
    statusEl.textContent = '\u2705 \u7ea6 ' + last + 'K';
  } catch (e) { statusEl.textContent = '\u274c ' + (e.message || '\u6d4b\u8bd5\u51fa\u9519'); }
  btn.disabled = false;
}

function openAiSettings() {
  renderAiPresetSelect();
  renderAiProviderList();
  closeAiProviderForm();
  openSettingsModal('ai');
}

function closeAiSettings() { closeSettingsModal(); }

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
  let endpoint = provider.endpoint;
  if (endpoint && /\/v\d+\/?$/.test(endpoint)) endpoint = endpoint.replace(/\/?$/, '/chat/completions');
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
  // 仅扩展端需要清理 chrome.proxy 全局设置；桌面端不存在该状态
  if (!isExtensionContext()) return;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      await chrome.runtime.sendMessage({ type: 'clearProxy' });
    }
  } catch (e) { logError(e, 'clear-proxy-on-startup'); }
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
  const hdrs = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (p.apiKey || '') };
  if (p.customHeaders && typeof p.customHeaders === 'object') Object.assign(hdrs, p.customHeaders);

  function parseAiResponse(text) {
    let raw = (typeof text === 'string' ? text : '').trim();
    if (!raw) throw new Error('AI 返回空响应，请检查模型服务是否正常');
    if (raw.startsWith('data: ')) {
      let combined = '';
      for (const line of raw.split('\n')) {
        const l = line.trim();
        if (l.startsWith('data: ') && l !== 'data: [DONE]') {
          try { const chunk = JSON.parse(l.slice(6)); const delta = chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.message?.content || ''; combined += delta; } catch {}
        }
      }
      if (combined) return combined.trim();
    }
    try {
      const data = JSON.parse(raw);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content.trim();
      if (data?.choices?.[0]?.delta?.content) return data.choices[0].delta.content.trim();
      if (data?.response) return String(data.response).trim();
      if (data?.result) return String(data.result).trim();
      throw new Error('返回数据缺少 choices[0].message.content');
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (raw.length > 20) return raw;
        throw new Error('AI 返回无法解析: ' + raw.slice(0, 200));
      }
      throw e;
    }
  }

  const proxyParsed = parseProxyUrl(p.proxyPrefix || '');
  const isHttpNonLocal = /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\/|$)/i.test(url);
  if (proxyParsed.kind === 'http' || isHttpNonLocal) {
    try { if (window.mn && window.mn.ready) await window.mn.ready; } catch {}
    let res;
    try {
      res = await mn.platform.fetch(url, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify(body)
      }, proxyParsed.kind === 'http' ? {
        providerHost: (() => { try { return new URL(p.endpoint).hostname; } catch { return ''; } })(),
        host: proxyParsed.host,
        port: proxyParsed.port,
        scheme: proxyParsed.scheme,
        user: proxyParsed.user,
        pass: proxyParsed.pass
      } : null);
    } catch (e) {
      throw new Error('\u65e0\u6cd5\u8fde\u63a5\u5e73\u53f0\u540e\u53f0: ' + (e.message || e));
    }
    if (!res.ok) {
      if (res.error) throw new Error(res.error);
      throw new Error(`HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`);
    }
    return parseAiResponse(res.body);
  }
  // HTTPS / localhost \u2192 \u76f4\u63a5 fetch
  const res = await fetch(url, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const text = await res.text();
  return parseAiResponse(text);
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
        applyNotePreview(currentNote);
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
      applyNotePreview(currentNote);
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

// ===================== 平台环境 + 提醒 =====================
function isExtensionContext() {
  return !!(window.mn && window.mn.platform && window.mn.platform.kind === 'extension');
}
function isDesktopContext() {
  return !!(window.mn && window.mn.platform && window.mn.platform.kind === 'desktop');
}
function platformAvailable() {
  return !!(window.mn && window.mn.platform && window.mn.platform.kind !== 'unknown');
}

// 清掉所有以 prefix 开头的 alarm（扩展和桌面统一走 mn.platform）
async function clearAlarmsByPrefix(prefix) {
  if (!platformAvailable()) return;
  try {
    const all = await mn.platform.alarms.getAll();
    await Promise.all(
      all.filter(a => a.name.startsWith(prefix))
         .map(a => mn.platform.alarms.clear(a.name))
    );
  } catch (e) { /* swallow */ }
}

function syncRemindersToExt() {
  if (!platformAvailable()) return;
  const data = todos.filter(t => !t.done && t.dueDate).map(t => ({
    id: t.id, text: t.text, dueDate: t.dueDate, done: t.done,
    remindBeforeMin: t.remindBeforeMin || 0,
    remindCount: t.remindCount || 1,
    remindIntervalMin: t.remindIntervalMin || 5
  }));
  // fire-and-forget，错误忽略
  mn.platform.storage.set('marginoteTodos', data).catch(() => {});
}

async function scheduleTodoReminders(t) {
  if (!platformAvailable()) return;
  await clearAlarmsByPrefix(`mtodo:${t.id}:`);
  if (t.done || !t.dueDate || !t.remindBeforeMin) { syncRemindersToExt(); return; }
  const count = Math.max(1, t.remindCount || 1);
  const interval = Math.max(1, t.remindIntervalMin || 5);
  for (let i = 0; i < count; i++) {
    const offsetMin = t.remindBeforeMin - i * interval;
    const when = t.dueDate - offsetMin * 60000;
    if (when > Date.now()) {
      await mn.platform.alarms.create(`mtodo:${t.id}:${i}`, when);
    }
  }
  syncRemindersToExt();
}

async function rescheduleAllAlarms() {
  if (!platformAvailable()) return;
  await clearAlarmsByPrefix('mtodo:');
  for (const t of todos) {
    if (t.done || !t.dueDate || !t.remindBeforeMin) continue;
    const count = Math.max(1, t.remindCount || 1);
    const interval = Math.max(1, t.remindIntervalMin || 5);
    for (let i = 0; i < count; i++) {
      const offsetMin = t.remindBeforeMin - i * interval;
      const when = t.dueDate - offsetMin * 60000;
      if (when > Date.now()) {
        await mn.platform.alarms.create(`mtodo:${t.id}:${i}`, when);
      }
    }
  }
  syncRemindersToExt();
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
  const isDesktop = isDesktopContext();
  const url = typeof location !== 'undefined' ? location.href : '';
  let extId = '';
  try { extId = chrome?.runtime?.id || ''; } catch {}
  let mode, pathHint;
  if (isDesktop) {
    mode = '桌面应用 (Tauri / WebView2)';
    pathHint = '加载真实路径中…'; // 占位，refreshStorageTab 会异步改写
  } else if (isExt) {
    mode = '浏览器扩展';
    pathHint = '存于扩展私有 IndexedDB / Local Storage（位于浏览器 profile：~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/<id> 或 %LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Local Extension Settings\\<id>）';
  } else {
    mode = '独立网页';
    pathHint = '存于浏览器 profile 的 Local Storage（按 origin 分隔）';
  }
  return { mode, origin: location.origin, extId, url, pathHint, isDesktop, isExt };
}

function refreshStorageTab() {
  const info = getStorageOriginInfo();
  const size = estimateLocalStorageBytes();
  const counts = {
    notes: notes.length,
    todos: todos.length,
    notebooks: notebooks.length,
    folders: folders.length,
    images: Object.keys(images).length
  };
  const statsLine = `笔记 ${counts.notes} · 待办 ${counts.todos} · 笔记本 ${counts.notebooks} · 文件夹 ${counts.folders} · 图片 ${counts.images}`;
  const infoEl = document.getElementById('storageInfo');
  if (!infoEl) return;

  // 桌面端：异步拿真实 Tauri app_data_dir / kv 路径，扩展端 / 网页保留旧字段
  if (info.isDesktop && window.mn?.platform?.desktop?.getAppPaths) {
    infoEl.innerHTML = `
      <div><span class="key">运行模式</span><span class="val">${escapeHtml(info.mode)}</span></div>
      <div><span class="key">数据统计</span><span class="val">${statsLine}</span></div>
      <div><span class="key">占用大小</span><span class="val">${formatBytes(size)} <span style="color:var(--ink-mute);font-size:10px;">(WebView2 localStorage)</span></span></div>
      <div><span class="key">应用数据目录</span><span class="val" id="storagePathDataDir">加载中…</span></div>
      <div><span class="key">marginote.dat</span><span class="val" id="storagePathKvFile">加载中…</span></div>
      <div><span class="key">localStorage</span><span class="val" id="storagePathWebview">加载中…</span></div>
    `;
    window.mn.platform.desktop.getAppPaths().then(p => {
      if (!p) return;
      const dd = document.getElementById('storagePathDataDir');
      const kf = document.getElementById('storagePathKvFile');
      const wv = document.getElementById('storagePathWebview');
      if (dd) dd.textContent = p.data_dir || '—';
      if (kf) kf.textContent = p.kv_file || '—';
      if (wv) wv.textContent = p.webview_dir || '—';
    });
  } else {
    infoEl.innerHTML = `
      <div><span class="key">运行模式</span><span class="val">${escapeHtml(info.mode)}</span></div>
      <div><span class="key">扩展 ID</span><span class="val">${escapeHtml(info.extId || '-')}</span></div>
      <div><span class="key">Origin</span><span class="val">${escapeHtml(info.origin)}</span></div>
      <div><span class="key">占用大小</span><span class="val">${formatBytes(size)}</span></div>
      <div><span class="key">数据统计</span><span class="val">${statsLine}</span></div>
      <div style="margin-top:8px;color:var(--ink-mute);font-size:10px;">${escapeHtml(info.pathHint)}</div>
    `;
  }

  const ab = getAutoBackup();
  const daysEl = document.getElementById('storageAutoDays');
  if (daysEl) daysEl.value = ab.intervalDays;
  const lastEl = document.getElementById('storageLastBackup');
  if (lastEl) lastEl.textContent = ab.lastBackupAt ? formatFullDate(ab.lastBackupAt) : '从未';
  renderErrorLog();
}

function openStorageModal() {
  refreshStorageTab();
  openSettingsModal('data');
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

function closeStorageModal() { closeSettingsModal(); }

async function checkAutoBackup() {
  const ab = getAutoBackup();
  if (!ab.intervalDays || ab.intervalDays <= 0) return;
  const elapsed = Date.now() - (ab.lastBackupAt || 0);
  if (elapsed < ab.intervalDays * 86400000) return;
  try {
    await exportAll({ toWorkdir: true });
    ab.lastBackupAt = Date.now();
    saveAutoBackup(ab);
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
  // 等平台 bridge 加载完成（扩展走 chrome.*，桌面走 Tauri）
  if (window.mn && window.mn.ready) await window.mn.ready;

  loadErrorLog();
  loadData();
  // 清理历史版本注入的「功能说明书」笔记（含 marginote 旧 ID）
  purgeLegacyManualNotes();
  loadAiConfig();
  await initImagesIdb();
  migrateInlineImages();
  migrateLegacyRestoreLabel();
  if (isExtensionContext()) document.body.classList.add('is-ext');
  if (isDesktopContext()) {
    document.body.classList.add('is-desktop');
    initDesktopSettings();
  }
  await rescheduleAllAlarms();
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

  // 主题恢复（默认 · 黑白；旧 'mono' 已迁移到 'light'）
  let savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  if (savedTheme === 'mono') savedTheme = 'light';
  applyTheme(THEMES[savedTheme] ? savedTheme : 'light');

  // 静态色点（待办状态点等）一次性 JS 强制上色，规避 WebView2 inline 解析漏洞
  paintDotColors(document);

  // 桌面/Windows 把 Mac 的 ⌘ 改成 Ctrl（默认 HTML 里写的是 ⌘，给 Mac 浏览器用）
  applyShortcutLabels();

  // 统一设置模态框
  document.getElementById('settingsBtn').addEventListener('click', () => openSettingsModal('appearance'));
  document.getElementById('settingsModalClose').addEventListener('click', closeSettingsModal);
  document.getElementById('settingsModalCloseX').addEventListener('click', closeSettingsModal);
  // settingsModalBg click-to-close removed
  document.querySelectorAll('#settingsTabs .settings-tab').forEach(btn => {
    btn.addEventListener('click', () => setSettingsTab(btn.dataset.tab));
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

  // 字体设置
  loadFontSettings();
  const fontSel = document.getElementById('fontSelect');
  if (fontSel) fontSel.addEventListener('change', () => applyFont(fontSel.value));
  const fontRange = document.getElementById('fontSizeRange');
  if (fontRange) fontRange.addEventListener('input', () => applyFontSize(fontRange.value));

  // 存储 / 备份（合并到设置模态框）
  // 注：旧版本在「数据·备份」页有重复的导出/导入按钮，已下线；现在只在「导入·导出」页保留一份。
  // 这里保留 null-safe 绑定，避免老 HTML 缓存还残留按钮时报错。
  const storageExportBtn = document.getElementById('storageExportBtn');
  if (storageExportBtn) storageExportBtn.addEventListener('click', () => {
    exportAll();
    const ab = getAutoBackup();
    ab.lastBackupAt = Date.now();
    saveAutoBackup(ab);
    document.getElementById('storageLastBackup').textContent = formatFullDate(ab.lastBackupAt);
  });
  const storageImportBtn = document.getElementById('storageImportBtn');
  if (storageImportBtn) storageImportBtn.addEventListener('click', () => {
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

  // AI 入口（合并到设置模态框）
  document.getElementById('aiAddBtn').addEventListener('click', () => openAiProviderForm(null));
  document.getElementById('aiFormCancel').addEventListener('click', closeAiProviderForm);
  document.getElementById('aiFormSave').addEventListener('click', saveAiProviderForm);
  document.getElementById('aiContextTestBtn')?.addEventListener('click', testModelContextSize);
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
document.getElementById('openFileBtn').addEventListener('click', openLocalFile);
  document.getElementById('newDrawingBtn')?.addEventListener('click', () => {
    if (typeof window.createDrawing === 'function') window.createDrawing();
  });

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
  const htmlBtn = document.getElementById('htmlModeBtn');
  if (htmlBtn) htmlBtn.addEventListener('click', () => {
    if (!currentNote) return;
    currentNote.format = (currentNote.format === 'html') ? 'md' : 'html';
    currentNote.updatedAt = Date.now();
    saveData();
    htmlBtn.classList.toggle('active', currentNote.format === 'html');
    if (isPreviewMode) applyNotePreview(currentNote);
    if (typeof showToast === 'function') showToast(currentNote.format === 'html' ? 'HTML 模式已开启（预览渲染网页）' : '已切回 Markdown');
  });
  document.getElementById('copyBtn').addEventListener('click', copyContent);
  document.getElementById('deleteBtn').addEventListener('click', deleteCurrent);
  document.getElementById('moveBtn').addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('moveMenu');
    if (menu.style.display === 'block') hideMoveMenu();
    else openMoveMenu(e.currentTarget);
  });

  // 导入·导出页的"导出全部"——同时记录 lastBackupAt（自动备份用），原"数据·备份"页的同名按钮已下线
  document.getElementById('exportBtn').addEventListener('click', () => {
    exportAll();
    const ab = getAutoBackup();
    ab.lastBackupAt = Date.now();
    saveAutoBackup(ab);
    const last = document.getElementById('storageLastBackup');
    if (last) last.textContent = formatFullDate(ab.lastBackupAt);
  });
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

  // 历史版本
  document.getElementById('historyBtn').addEventListener('click', openVersionModal);
  document.getElementById('versionModalClose').addEventListener('click', closeVersionModal);
  document.getElementById('versionSnapBtn').addEventListener('click', manualSnapshotCurrent);
  document.getElementById('versionRestoreBtn').addEventListener('click', confirmRestoreSelectedVersion);
  document.getElementById('versionModalBg').addEventListener('click', e => {
    if (e.target.id === 'versionModalBg') closeVersionModal();
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

  // Markdown 编辑增强：Tab 缩进 + 列表回车续行
  attachMarkdownEditor('contentInput');
  attachMarkdownEditor('todoEditContent');

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
      document.getElementById('settingsModalBg').classList.remove('show');
      document.getElementById('assistantModalBg').classList.remove('show');
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
    const nbBadge = (showNbBadge && nb) ? `<span class="note-nb-badge"><span class="note-nb-dot" data-color="${nb.color}" style="background-color:${nb.color}"></span>${escapeHtml(nb.name)}</span>` : '';
    const titleHtml = terms.length ? highlightTerms(n.title || '无题', terms) : escapeHtml(n.title || '无题');
    const previewHtml = preview ? (terms.length ? highlightTerms(preview, terms) : escapeHtml(preview)) : '';
    return `
      <div class="note-item ${isActive ? 'active' : ''} ${compact ? 'compact' : ''}" data-id="${n.id}" role="button" tabindex="0">
        <div class="note-item-head">
          <div class="note-title" title="${escapeHtml(n.title || '无题')}">${n.starred ? '<span class="note-pin">★</span>' : ''}${titleHtml}</div>
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
  paintDotColors(container);
  if (typeof paintFontStyles === 'function') paintFontStyles(container);
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

async function _simulateStreamEmit(text, onDelta, chunkSize = 12, delayMs = 6) {
  if (!text || typeof onDelta !== 'function') return;
  let acc = '';
  for (let i = 0; i < text.length; i += chunkSize) {
    const piece = text.slice(i, i + chunkSize);
    acc += piece;
    try { onDelta(piece, acc); } catch {}
    if (i + chunkSize < text.length) await new Promise(r => setTimeout(r, delayMs));
  }
}
callAi = async function(messages, opts) {
  const p = getActiveProvider();
  if (!p) throw new Error('未配置 AI 模型');
  if (opts && opts.stream === false) return _origCallAi(messages, opts);
  // HTTP / SOCKS 代理 → 必须走平台后台桥（不做 SSE），响应回来后模拟流式回放
  // 桌面版 WebView2 不支持 http:// 直连 fetch → 走平台桥（Rust reqwest），模拟流式
  // 浏览器插件 / HTTPS / localhost → 使用原生 fetch + SSE 真流式
  {
    const urlEarly = resolveAiUrl(p);
    const proxyParsedEarly = parseProxyUrl(p.proxyPrefix || '');
    const isHttpNonLocal = /^http:\/\//i.test(urlEarly) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(urlEarly);
    const isDesktop = !!(window.mn && window.mn.platform && window.mn.platform.kind === 'desktop');
    const needBridge = proxyParsedEarly.kind === 'http' || (isDesktop && isHttpNonLocal);
    if (needBridge) {
      const result = await _origCallAi(messages, Object.assign({}, opts, { stream: false }));
      if (opts && typeof opts.onDelta === 'function' && typeof result === 'string') {
        await _simulateStreamEmit(result, opts.onDelta);
      }
      return result;
    }
  }
  const body = { model: p.model, messages, temperature: (opts && opts.temperature) ?? p.temperature ?? 0.7, stream: true };
  _aiAbortCtrl = new AbortController();
  const cancelBtn = document.getElementById('aiCancelBtn');
  if (cancelBtn) cancelBtn.classList.add('show');
  try {
    const url = resolveAiUrl(p);
    const hdrs = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (p.apiKey || '') };
    if (p.customHeaders && typeof p.customHeaders === 'object') Object.assign(hdrs, p.customHeaders);
    const res = await fetch(url, {
      method: 'POST',
      headers: hdrs,
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
      if (typeof c === 'string' && opts?.onDelta) await _simulateStreamEmit(c, opts.onDelta);
      return typeof c === 'string' ? c.trim() : '';
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '', streamDone = false;
    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { streamDone = true; try { reader.cancel(); } catch {} break; }
        try {
          const obj = JSON.parse(payload);
          const d = obj?.choices?.[0]?.delta;
          const content = d?.content;
          const reasoning = d?.reasoning_content;
          if (content) {
            full += content;
            if (opts && typeof opts.onDelta === 'function') opts.onDelta(content, full);
          } else if (reasoning && opts && typeof opts.onDelta === 'function') {
            opts.onDelta('', full);
          }
        } catch {}
      }
    }
    return full.trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('已取消');
    throw e;
  } finally {
    if (cancelBtn) cancelBtn.classList.remove('show');
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
  // 先占位提示以避免长时间空白
  if (ta) { const orig = ta.value; ta.value = (baseContent || orig) + '\n\n⏳ AI 生成中…'; ta.scrollTop = ta.scrollHeight; }

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
          if (isPreviewMode) applyNotePreview(currentNote);
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
let _splitScrollLock = 0;
function _splitSync() {
  const ta = document.getElementById('contentInput');
  const pv = document.getElementById('preview');
  if (pv && ta) pv.innerHTML = renderMarkdown(ta.value);
}
function _splitScrollFromTa() {
  if (_splitScrollLock) return;
  const ta = document.getElementById('contentInput');
  const pv = document.getElementById('preview');
  if (!pv || !ta) return;
  const r = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
  _splitScrollLock = 1;
  pv.scrollTop = r * Math.max(0, pv.scrollHeight - pv.clientHeight);
  requestAnimationFrame(() => { _splitScrollLock = 0; });
}
function _splitScrollFromPv() {
  if (_splitScrollLock) return;
  const ta = document.getElementById('contentInput');
  const pv = document.getElementById('preview');
  if (!pv || !ta) return;
  const r = pv.scrollTop / Math.max(1, pv.scrollHeight - pv.clientHeight);
  _splitScrollLock = 1;
  ta.scrollTop = r * Math.max(0, ta.scrollHeight - ta.clientHeight);
  requestAnimationFrame(() => { _splitScrollLock = 0; });
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
    ta.addEventListener('scroll', _splitScrollFromTa);
    pv.addEventListener('scroll', _splitScrollFromPv);
  } else {
    ta.removeEventListener('input', _splitSync);
    ta.removeEventListener('scroll', _splitScrollFromTa);
    pv.removeEventListener('scroll', _splitScrollFromPv);
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
  const oc = document.getElementById('outlineClose');
  if (oc) oc.addEventListener('click', toggleOutline);
  const sb = document.getElementById('splitBtn');
  if (sb) sb.addEventListener('click', toggleSplitView);

  // 双击切换 编辑/预览：
  //   预览模式下双击渲染文字 -> 切回编辑
  //   编辑模式下双击非输入区空白 -> 切到预览
  const FORM_SEL = 'input, textarea, select, button, .icon-btn, .tag-pill, .tag-input-wrap, .editor-toolbar, .modal, .outline-panel';
  function bindDblToggle(rootId, previewId, isPreviewFn, toggleFn, isActiveFn) {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.addEventListener('dblclick', (e) => {
      if (!isActiveFn()) return;
      const t = e.target;
      const previewEl = document.getElementById(previewId);
      const inPreview = previewEl && previewEl.contains(t);
      if (isPreviewFn() && inPreview) {
        toggleFn();
      } else if (!isPreviewFn() && !t.closest(FORM_SEL)) {
        toggleFn();
      }
    });
  }
  bindDblToggle('editor',         'preview',     () => isPreviewMode,     togglePreview,     () => !!currentNote);
  bindDblToggle('todoEditorWrap', 'todoPreview', () => isTodoPreviewMode, toggleTodoPreview, () => !!currentTodo);

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

// 打开 storage modal 时刷新工作目录状态
const _origOpenStorageModal = openStorageModal;
openStorageModal = function() {
  _origOpenStorageModal();
  renderWorkDirInfo();
};

// ==========================================================
// v1.4 工作目录（双向）—— 笔记/待办以 .md 存在本地目录
// 扩展端走 mn.platform.fs（File System Access），桌面端走原生 Rust fs。
// 与「本地文件夹同步」(v1.3 单向备份) 区别：工作目录是双向的——
//   · 启动 / 手动扫描：读目录里的 .md 合并进应用（拖入的 md 会出现）
//   · 新增 / 修改：写回目录（卸载软件/扩展不删这些文件）
// ==========================================================
const WORKDIR_KEY = 'marginote.workdir';
let _workdirCfg = { enabled: false, lastSyncAt: 0, name: null };
try { Object.assign(_workdirCfg, JSON.parse(localStorage.getItem(WORKDIR_KEY) || '{}')); } catch {}
function saveWorkdirCfg() { try { localStorage.setItem(WORKDIR_KEY, JSON.stringify(_workdirCfg)); } catch {} }

let _workdirTimer = null;
const TODO_DIR = '待办';
const WORKDIR_META = '_marginote/meta.json';

function fsApi() { return (window.mn && mn.platform && mn.platform.fs) || null; }
function workdirAvailable() { const f = fsApi(); return !!(f && f.isAvailable && f.isAvailable()); }

// 笔记 → 工作目录内的相对路径（笔记本/文件夹/标题.md）
function noteRelPath(note, usedPaths) {
  const nb = getNotebook(note.notebookId);
  const folder = getFolder(note.folderId);
  const parts = [];
  if (nb) parts.push(safeName(nb.name));
  if (folder) parts.push(safeName(folder.name));
  let base = safeName(note.title || 'untitled');
  let rel = (parts.length ? parts.join('/') + '/' : '') + base;
  if (usedPaths) {
    let n = 1, cand = rel;
    while (usedPaths.has(cand + '.md')) { n++; cand = rel + '-' + n; }
    rel = cand;
    usedPaths.add(rel + '.md');
  }
  return rel + '.md';
}

// 画板 → 工作目录内的相对路径（笔记本/文件夹/标题.excalidraw）
function drawingRelPath(note, usedPaths) {
  const nb = getNotebook(note.notebookId);
  const folder = getFolder(note.folderId);
  const parts = [];
  if (nb) parts.push(safeName(nb.name));
  if (folder) parts.push(safeName(folder.name));
  let base = safeName(note.title || 'untitled-drawing');
  let rel = (parts.length ? parts.join('/') + '/' : '') + base;
  if (usedPaths) {
    let n = 1, cand = rel;
    while (usedPaths.has(cand + '.excalidraw')) { n++; cand = rel + '-' + n; }
    rel = cand;
    usedPaths.add(rel + '.excalidraw');
  }
  return rel + '.excalidraw';
}

// 画板 note → .excalidraw 文件内容（场景 JSON + 注入 _mn 元信息便于回读归属）
function drawingToFile(note) {
  let scene = {};
  try { scene = note.content ? JSON.parse(note.content) : {}; } catch { scene = {}; }
  if (typeof scene !== 'object' || scene === null) scene = {};
  scene._mn = {
    id: note.id,
    title: note.title || '未命名画板',
    notebookId: note.notebookId || null,
    folderId: note.folderId || null,
    tags: note.tags || [],
    starred: !!note.starred,
    createdAt: note.createdAt || Date.now(),
    updatedAt: note.updatedAt || Date.now()
  };
  return JSON.stringify(scene, null, 2);
}

// 待办 → markdown（带状态 front-matter）
function todoToMarkdown(t) {
  const lines = [
    '---',
    `text: ${(t.text || '').replace(/\n/g, ' ')}`,
    `done: ${!!t.done}`,
    t.dueDate ? `dueDate: ${new Date(t.dueDate).toISOString()}` : '',
    `createdAt: ${new Date(t.createdAt || Date.now()).toISOString()}`,
    t.completedAt ? `completedAt: ${new Date(t.completedAt).toISOString()}` : '',
    `id: ${t.id}`,
    '---',
    ''
  ].filter(Boolean);
  return lines.join('\n') + '\n' + expandImageRefs(t.content || '', { mode: 'inline' });
}

// 写出全部数据到工作目录（app → disk）
async function workdirWriteAll(silent) {
  const fs = fsApi();
  if (!fs) { if (!silent) showToast('当前环境不支持工作目录'); return false; }
  if (!await fs.hasDir()) { if (!silent) showToast('未绑定工作目录或无权限'); return false; }
  try {
    const usedPaths = new Set();
    const usedImgIds = new Set();
    const collectIds = (text) => {
      const re = /!\[[^\]]*\]\(img:([a-z0-9]+)\)/gi; let m;
      while ((m = re.exec(text || '')) !== null) usedImgIds.add(m[1]);
    };
    // 笔记（画板写 .excalidraw，普通笔记写 .md）
    const idToPath = {};
    for (const n of notes.filter(x => !x.deleted)) {
      if (n.type === 'drawing') {
        const rel = drawingRelPath(n, usedPaths);
        idToPath[n.id] = rel;
        await fs.writeText(rel, drawingToFile(n));
        continue;
      }
      const rel = noteRelPath(n, usedPaths);
      idToPath[n.id] = rel;
      collectIds(n.content);
      await fs.writeText(rel, noteToMarkdown(n, { mode: 'inline' }));
    }
    // 待办（统一放 待办/ 子目录）
    const usedTodo = new Set();
    for (const t of todos) {
      let base = safeName(t.text || 'todo'); let rel = TODO_DIR + '/' + base; let n = 1;
      while (usedTodo.has(rel + '.md')) { n++; rel = TODO_DIR + '/' + base + '-' + n; }
      usedTodo.add(rel + '.md');
      collectIds(t.content);
      await fs.writeText(rel + '.md', todoToMarkdown(t));
    }
    // 图片资产
    for (const id of usedImgIds) {
      const img = images[id];
      if (!img || !img.dataUrl) continue;
      const m = img.dataUrl.match(/^data:[^;]+;base64,(.+)$/);
      if (!m) continue;
      const ext = img.ext || detectExtFromDataUrl(img.dataUrl);
      await fs.writeBinary('_assets/' + id + ext, m[1]);
    }
    // 元数据：笔记本/文件夹/被删笔记/图片元信息/路径映射
    await fs.writeText(WORKDIR_META, JSON.stringify({
      version: 'v1.4',
      exportedAt: Date.now(),
      notebooks, folders,
      deletedNotes: notes.filter(n => n.deleted),
      imagesMeta: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, { name: v.name, ext: v.ext, createdAt: v.createdAt }])),
      noteFiles: idToPath
    }, null, 2));

    _workdirCfg.lastSyncAt = Date.now();
    saveWorkdirCfg();
    renderWorkDirInfo();
    if (!silent) showToast('已写入工作目录');
    return true;
  } catch (e) {
    logError(e, 'workdir-write');
    if (!silent) showToast('写入工作目录失败：' + (e && e.message), e && e.stack);
    return false;
  }
}

// 从工作目录读入并合并（disk → app）。返回新增笔记数。
async function workdirImportAll(silent) {
  const fs = fsApi();
  if (!fs) { if (!silent) showToast('当前环境不支持工作目录'); return 0; }
  if (!await fs.hasDir()) { if (!silent) showToast('未绑定工作目录或无权限'); return 0; }
  let added = 0, updated = 0;
  try {
    // 先读元数据（恢复笔记本/文件夹/图片元）
    let meta = {};
    try {
      const metaTxt = await fs.readText(WORKDIR_META);
      if (metaTxt) meta = JSON.parse(metaTxt);
    } catch {}
    if (Array.isArray(meta.notebooks)) {
      meta.notebooks.forEach(nb => { if (!notebooks.find(x => x.id === nb.id || x.name === nb.name)) notebooks.push(nb); });
    }
    if (Array.isArray(meta.folders)) {
      meta.folders.forEach(f => { if (!folders.find(x => x.id === f.id)) folders.push(f); });
    }
    const imagesMeta = (meta.imagesMeta && typeof meta.imagesMeta === 'object') ? meta.imagesMeta : {};

    const entries = await fs.list();
    const mdFiles = entries.filter(e => !e.dir && /\.(md|markdown)$/i.test(e.path) && !e.path.startsWith('_'));
    const drawFiles = entries.filter(e => !e.dir && /\.excalidraw$/i.test(e.path) && !e.path.startsWith('_'));
    const assetFiles = entries.filter(e => !e.dir && /^_assets\//i.test(e.path));

    // 资产先读入 images 映射（供 _assets 路径引用解析）
    for (const a of assetFiles) {
      try {
        const fname = a.path.split('/').pop();
        const id = fname.replace(/\.[^.]+$/, '');
        const ext = '.' + (fname.split('.').pop() || 'png');
        if (images[id]) continue;
        const b64 = await fs.readBinary(a.path);
        if (!b64) continue;
        const mi = imagesMeta[id] || {};
        images[id] = { name: mi.name || fname, ext: mi.ext || ext, createdAt: mi.createdAt || Date.now(), dataUrl: `data:${mimeFromExt(ext)};base64,${b64}` };
        await idbPut('images', { id, ...images[id] });
      } catch (e) { logError(e, 'workdir-asset:' + a.path); }
    }

    for (const f of mdFiles) {
      const text = await fs.readText(f.path);
      if (text == null) continue;
      const segs = f.path.split('/').filter(Boolean);
      const isTodo = segs[0] === TODO_DIR;
      const { meta: fm, content } = parseMarkdownFile(text);
      if (isTodo) {
        const id = fm.id || uid();
        const existing = todos.find(t => t.id === id);
        const todo = {
          id,
          text: fm.text || segs[segs.length - 1].replace(/\.(md|markdown)$/i, ''),
          content: ingestImageDataUrls(ingestAssetPathRefs(content)),
          done: fm.done === true || fm.done === 'true',
          dueDate: fm.dueDate ? new Date(fm.dueDate).getTime() : null,
          createdAt: fm.createdAt ? new Date(fm.createdAt).getTime() : Date.now(),
          completedAt: fm.completedAt ? new Date(fm.completedAt).getTime() : null
        };
        if (existing) { Object.assign(existing, todo); updated++; }
        else { todos.push(todo); added++; }
        continue;
      }
      const nbName = fm.notebook || (segs.length > 1 ? segs[0] : null);
      const folderName = fm.folder || (segs.length > 2 ? segs[1] : null);
      const nb = ensureNotebookByName(nbName);
      const folder = folderName ? ensureFolderByName(nb.id, folderName) : null;
      let body = ingestImageDataUrls(ingestAssetPathRefs(content));
      const id = fm.id || uid();
      const existing = notes.find(n => n.id === id);
      const note = {
        id,
        notebookId: nb.id,
        folderId: folder ? folder.id : null,
        title: fm.title || segs[segs.length - 1].replace(/\.(md|markdown)$/i, ''),
        content: body,
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        starred: !!fm.starred,
        deleted: false,
        createdAt: fm.createdAt ? new Date(fm.createdAt).getTime() : Date.now(),
        updatedAt: fm.updatedAt ? new Date(fm.updatedAt).getTime() : Date.now()
      };
      if (existing) {
        // 仅当磁盘更新时间较新才覆盖，避免回退正在编辑的内容
        if ((note.updatedAt || 0) >= (existing.updatedAt || 0)) { Object.assign(existing, note); updated++; }
      } else {
        notes.push(note); added++;
      }
    }

    // 画板 .excalidraw → type:'drawing' 笔记
    for (const f of drawFiles) {
      const text = await fs.readText(f.path);
      if (text == null) continue;
      let scene = {};
      try { scene = JSON.parse(text); } catch { scene = {}; }
      const mn = (scene && scene._mn) || {};
      const segs = f.path.split('/').filter(Boolean);
      const nbName = (segs.length > 1) ? segs[0] : null;
      const folderName = (segs.length > 2) ? segs[1] : null;
      let nbId = mn.notebookId, folderId = mn.folderId;
      if (!nbId) { const nb = ensureNotebookByName(nbName); nbId = nb.id; if (folderName) folderId = ensureFolderByName(nb.id, folderName).id; }
      const id = mn.id || uid();
      // 写回 note.content 时去掉 _mn（保持纯场景），但保留它做归属
      let pureContent = text;
      try { const s2 = JSON.parse(text); delete s2._mn; pureContent = JSON.stringify(s2); } catch {}
      const existing = notes.find(n => n.id === id);
      const note = {
        id,
        notebookId: nbId,
        folderId: folderId || null,
        type: 'drawing',
        title: mn.title || segs[segs.length - 1].replace(/\.excalidraw$/i, ''),
        content: pureContent,
        thumb: existing ? existing.thumb : '',
        tags: Array.isArray(mn.tags) ? mn.tags : [],
        starred: !!mn.starred,
        deleted: false,
        createdAt: mn.createdAt ? new Date(mn.createdAt).getTime() : Date.now(),
        updatedAt: mn.updatedAt ? new Date(mn.updatedAt).getTime() : Date.now()
      };
      if (existing) {
        if ((note.updatedAt || 0) >= (existing.updatedAt || 0)) { Object.assign(existing, note); updated++; }
      } else { notes.push(note); added++; }
    }

    saveData();
    renderNotebooks();
    renderTagFilters();
    if (currentView.startsWith('todo:')) renderTodos(); else renderNotesList();
    renderTodoCounts();
    _workdirCfg.lastSyncAt = Date.now();
    saveWorkdirCfg();
    renderWorkDirInfo();
    if (!silent) showToast(`已从工作目录导入：新增 ${added}、更新 ${updated}`);
    return added;
  } catch (e) {
    logError(e, 'workdir-import');
    if (!silent) showToast('导入工作目录失败：' + (e && e.message), e && e.stack);
    return 0;
  }
}

async function pickWorkDir() {
  const fs = fsApi();
  if (!fs || !workdirAvailable()) { showToast('当前环境不支持选择工作目录'); return; }
  try {
    const res = await fs.pickDir();
    if (!res) return; // 用户取消
    _workdirCfg.name = res.name;
    _workdirCfg.enabled = true;
    saveWorkdirCfg();
    showToast('已选择工作目录：' + res.name);
    // 先把目录里已有 .md 导入，再把当前数据写回，达成双向合并
    await workdirImportAll(true);
    await workdirWriteAll(true);
    renderWorkDirInfo();
    showToast('工作目录已就绪 ✓');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    logError(e, 'pick-workdir');
    showToast('选择失败：' + (e && e.message));
  }
}

async function forgetWorkDir() {
  const fs = fsApi();
  showModal('停用工作目录？', '将不再把改动写入本地目录（已写出的文件保留在磁盘，不会删除）。', async () => {
    try { if (fs) await fs.forget(); } catch {}
    _workdirCfg = { enabled: false, lastSyncAt: 0, name: null };
    saveWorkdirCfg();
    renderWorkDirInfo();
    showToast('已停用工作目录');
  });
}

function renderWorkDirInfo() {
  const el = document.getElementById('workDirInfo');
  if (!el) return;
  if (!workdirAvailable()) {
    el.innerHTML = '<span style="color:var(--ink-mute);">当前环境不支持工作目录</span>';
    return;
  }
  if (!_workdirCfg.enabled || !_workdirCfg.name) {
    el.innerHTML = '<span style="color:var(--ink-mute);">未启用（数据仅存本机应用内）</span>';
  } else {
    const last = _workdirCfg.lastSyncAt ? formatFullDate(_workdirCfg.lastSyncAt) : '从未';
    el.innerHTML = `<div><span class="key">路径</span><span class="val" style="word-break:break-all;">${escapeHtml(_workdirCfg.name)}</span></div>
      <div><span class="key">上次同步</span><span class="val">${last}</span></div>`;
  }
}

// hook saveData → 工作目录启用时 debounce 写回
const _origSaveDataWorkdir = saveData;
saveData = function() {
  _origSaveDataWorkdir();
  if (_workdirCfg.enabled && workdirAvailable()) {
    clearTimeout(_workdirTimer);
    _workdirTimer = setTimeout(() => workdirWriteAll(true), 3000);
  }
};

// 启动：若已启用工作目录，自动从磁盘导入（拖入的 md 会出现）
(async function initWorkDir() {
  if (!workdirAvailable() || !_workdirCfg.enabled) return;
  let tries = 0;
  while (!_idb && tries < 50) { await new Promise(r => setTimeout(r, 100)); tries++; }
  try {
    const fs = fsApi();
    if (fs && await fs.hasDir()) {
      _workdirCfg.name = (await fs.dirName()) || _workdirCfg.name;
      await workdirImportAll(true);
    }
  } catch (e) { logError(e, 'init-workdir'); }
  renderWorkDirInfo();
})();

function bindWorkDir() {
  const pickBtn = document.getElementById('pickWorkDirBtn');
  const syncBtn = document.getElementById('syncWorkDirBtn');
  const scanBtn = document.getElementById('scanWorkDirBtn');
  const offBtn = document.getElementById('forgetWorkDirBtn');
  if (pickBtn) pickBtn.addEventListener('click', pickWorkDir);
  if (syncBtn) syncBtn.addEventListener('click', () => workdirWriteAll(false));
  if (scanBtn) scanBtn.addEventListener('click', () => workdirImportAll(false));
  if (offBtn) offBtn.addEventListener('click', forgetWorkDir);
}
bindWorkDir();

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

// ---------- 清理历史版本自动注入的功能说明书笔记 ----------
function purgeLegacyManualNotes() {
  if (!Array.isArray(notes) || !notes.length) return;
  const before = notes.length;
  notes = notes.filter(n => {
    if (!n) return false;
    const id = String(n.id || '');
    if (id.startsWith('marginote-manual-') || id.startsWith('marginalia-manual-')) return false;
    if (/功能说明书/.test(n.title || '')) return false;
    return true;
  });
  // 同步清掉过期标志
  try {
    localStorage.removeItem('marginote.manualGenerated');
    localStorage.removeItem('marginalia.manualGenerated');
  } catch {}
  if (notes.length !== before) saveData();
}

// ===================== 桌面专属设置 =====================
const HOTKEY_PREF_KEY = 'marginote.desktop.hotkey';
const HOTKEY_DEFAULT = 'Ctrl+Shift+M';

async function initDesktopSettings() {
  if (!isDesktopContext()) return;

  // 注册（默认或用户保存的）全局快捷键
  let combo = HOTKEY_DEFAULT;
  try { combo = localStorage.getItem(HOTKEY_PREF_KEY) || HOTKEY_DEFAULT; } catch {}
  try { await mn.platform.desktop.registerHotkey(combo); } catch (e) { logError(e, 'hotkey-register'); }

  // 等 DOM 渲染好（设置 modal 即使未打开，元素也存在）
  const hotkeyInput = document.getElementById('desktopHotkey');
  const hotkeyBtn   = document.getElementById('desktopHotkeySave');
  const hotkeyStatus = document.getElementById('desktopHotkeyStatus');
  const autostart   = document.getElementById('desktopAutostart');

  if (hotkeyInput) hotkeyInput.value = combo;

  if (hotkeyBtn && hotkeyInput) {
    hotkeyBtn.addEventListener('click', async () => {
      const newCombo = (hotkeyInput.value || '').trim();
      if (!newCombo) { hotkeyStatus.textContent = '请输入有效快捷键'; return; }
      try {
        await mn.platform.desktop.registerHotkey(newCombo);
        try { localStorage.setItem(HOTKEY_PREF_KEY, newCombo); } catch {}
        hotkeyStatus.textContent = '✓ 已应用：' + newCombo;
        showToast('快捷键已更新');
      } catch (e) {
        hotkeyStatus.textContent = '✗ 注册失败：' + (e.message || e);
      }
    });
  }

  if (autostart) {
    try {
      autostart.checked = await mn.platform.desktop.getAutostart();
    } catch (e) { logError(e, 'autostart-read'); }
    autostart.addEventListener('change', async () => {
      try {
        await mn.platform.desktop.setAutostart(autostart.checked);
        showToast(autostart.checked ? '已开启开机自启' : '已关闭开机自启');
      } catch (e) {
        autostart.checked = !autostart.checked;
        showToast('设置失败：' + (e.message || e));
      }
    });
  }
}

// ==========================================================
// v1.2.1 修复批：编辑区缩放 / 拖拽排序 / hr 渲染 / AI 指令管理
// ==========================================================

// ---------- 立即加载 AI 指令覆盖（在 init 之前，确保菜单使用最新值） ----------
try { loadAiActionOverrides(); } catch {}

// ---------- 通用拖拽排序 helper ----------
// container: 容器元素；itemSelector: 子项选择器（每个子项需有 data-drag-key="<id>"）
// onReorder(srcKey, dstKey): 调用方负责修改数据并重新渲染
function enableDragReorder(container, itemSelector, onReorder) {
  if (!container) return;
  const items = container.querySelectorAll(itemSelector);
  if (!items.length) return;
  items.forEach(el => {
    if (el.dataset.dragBound === '1') return;
    el.dataset.dragBound = '1';
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      if (e.target && e.target.closest && e.target.closest('button,input,textarea,a,select')) {
        e.preventDefault();
        return;
      }
      const key = el.dataset.dragKey;
      if (!key) { e.preventDefault(); return; }
      el.classList.add('drag-dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-marginote-drag', key);
        e.dataTransfer.setData('text/plain', key);
      } catch {}
      window._mnDragKey = key;
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('drag-dragging');
      container.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      window._mnDragKey = null;
    });
    el.addEventListener('dragover', (e) => {
      const src = window._mnDragKey;
      if (!src) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      if (el.dataset.dragKey !== src) el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const src = window._mnDragKey || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      const dst = el.dataset.dragKey;
      window._mnDragKey = null;
      if (!src || !dst || src === dst) return;
      onReorder(src, dst);
    });
  });
}

function reorderArrayById(arr, srcId, dstId) {
  const si = arr.findIndex(x => x.id === srcId);
  const di = arr.findIndex(x => x.id === dstId);
  if (si < 0 || di < 0) return false;
  const [item] = arr.splice(si, 1);
  const newDi = arr.findIndex(x => x.id === dstId);
  arr.splice(newDi, 0, item);
  return true;
}
window.enableDragReorder = enableDragReorder;
window.reorderArrayById = reorderArrayById;

// ---------- 笔记本 / 待办 拖拽排序 包装 ----------
const _origRenderNotebooks_v121 = renderNotebooks;
renderNotebooks = function() {
  _origRenderNotebooks_v121.apply(this, arguments);
  const c = document.getElementById('notebooksList');
  if (!c) return;
  c.querySelectorAll('.rail-item[data-nb]').forEach(el => { el.dataset.dragKey = el.dataset.nb; });
  enableDragReorder(c, '.rail-item[data-nb]', (src, dst) => {
    if (reorderArrayById(notebooks, src, dst)) {
      saveData();
      renderNotebooks();
    }
  });
};

const _origRenderTodos_v121 = (typeof renderTodos === 'function') ? renderTodos : null;
if (_origRenderTodos_v121) {
  renderTodos = function() {
    _origRenderTodos_v121.apply(this, arguments);
    const c = document.getElementById('todoList');
    if (!c) return;
    c.querySelectorAll('.todo-row[data-id]').forEach(el => { el.dataset.dragKey = el.dataset.id; });
    enableDragReorder(c, '.todo-row[data-id]', (src, dst) => {
      if (reorderArrayById(todos, src, dst)) {
        saveData();
        renderTodos();
      }
    });
  };
}

// ---------- 编辑区 Ctrl+滚轮 缩放 ----------
const EDITOR_ZOOM_KEY = 'marginote.editorZoom';
let _editorZoom = (function() {
  const n = parseFloat(localStorage.getItem(EDITOR_ZOOM_KEY));
  return isFinite(n) && n > 0 ? Math.max(0.5, Math.min(3, n)) : 1.0;
})();
function applyEditorZoom() {
  document.documentElement.style.setProperty('--editor-zoom', _editorZoom.toFixed(2));
}
function bumpEditorZoom(delta) {
  const next = Math.max(0.5, Math.min(3, Math.round((_editorZoom + delta) * 100) / 100));
  if (next === _editorZoom) return;
  _editorZoom = next;
  applyEditorZoom();
  try { localStorage.setItem(EDITOR_ZOOM_KEY, String(_editorZoom)); } catch {}
  if (typeof showToast === 'function') showToast(`编辑区缩放 ${Math.round(_editorZoom * 100)}%`);
}
function bindEditorZoomTargets() {
  const ids = ['contentInput', 'preview', 'todoEditContent', 'todoPreview'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.dataset.zoomBound === '1') return;
    el.dataset.zoomBound = '1';
    el.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      bumpEditorZoom(e.deltaY < 0 ? 0.1 : -0.1);
    }, { passive: false });
  });
}

// ---------- AI 指令管理 modal ----------
function openAiActionManager() {
  if (typeof hideAiMenu === 'function') hideAiMenu();
  const oldBg = document.getElementById('aiActionManagerBg');
  if (oldBg) oldBg.remove();
  const bg = document.createElement('div');
  bg.id = 'aiActionManagerBg';
  bg.className = 'modal-bg';
  bg.innerHTML = `
      <div class="modal" style="max-width: 760px; width: 92%; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden;">
      <h2 style="margin: 0 0 8px; flex-shrink: 0;">AI 指令管理</h2>
      <p style="color: var(--ink-mute); font-size: 12px; margin: 0 0 10px; flex-shrink: 0;">
        编辑预设指令的标题与系统提示词；可启用 / 关闭指令（关闭后在 AI 优化菜单中隐藏），或新增自定义指令。
      </p>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-shrink: 0;">
        <button class="modal-btn primary" id="aiActionAddBtn">＋ 新增指令</button>
        <button class="modal-btn" id="aiActionResetBtn">恢复默认</button>
      </div>
      <div id="aiActionList" class="ai-action-list" style="flex: 1; overflow-y: auto; padding-right: 4px; min-height: 0;"></div>
      <div class="modal-actions" style="display:flex; justify-content: flex-end; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--rule-soft); flex-shrink: 0;">
        <button class="modal-btn" id="aiActionCloseBtn">取消</button>
        <button class="modal-btn primary" id="aiActionSaveBtn">保存</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click', (e) => { if (e.target.id === 'aiActionManagerBg') bg.classList.remove('show'); });
  bg.querySelector('#aiActionCloseBtn').addEventListener('click', () => bg.classList.remove('show'));
  bg.querySelector('#aiActionAddBtn').addEventListener('click', () => {
    const newAction = {
      id: 'custom-' + (typeof uid === 'function' ? uid() : Math.random().toString(36).slice(2, 8)),
      label: '🛠 新指令',
      mode: 'replace',
      system: '',
      enabled: true,
      isCustom: true,
    };
    const ci = AI_ACTIONS.findIndex(a => a.id === 'custom');
    if (ci >= 0) AI_ACTIONS.splice(ci, 0, newAction);
    else AI_ACTIONS.push(newAction);
    renderAiActionList();
    setTimeout(() => {
      const row = bg.querySelector(`.ai-action-row[data-id="${CSS.escape(newAction.id)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        const lbl = row.querySelector('.ai-action-label');
        if (lbl) lbl.focus();
      }
    }, 0);
  });
  bg.querySelector('#aiActionResetBtn').addEventListener('click', () => {
    if (!confirm('确定恢复全部预设指令为默认？已自定义的修改与新增指令会丢失。')) return;
    resetAiActionOverrides();
    renderAiActionList();
    showToast('已恢复默认指令');
  });
  bg.querySelector('#aiActionSaveBtn').addEventListener('click', () => {
    const list = bg.querySelector('#aiActionList');
    list.querySelectorAll('.ai-action-row').forEach(row => {
      const id = row.dataset.id;
      const a = AI_ACTIONS.find(x => x.id === id);
      if (!a) return;
      const labelInput = row.querySelector('.ai-action-label');
      const sysInput = row.querySelector('.ai-action-system');
      const enabledCb = row.querySelector('.ai-action-enabled');
      const modeSel = row.querySelector('.ai-action-mode');
      if (labelInput) a.label = labelInput.value.trim() || a.label;
      if (sysInput && a.mode !== 'custom') a.system = sysInput.value;
      if (modeSel && a.isCustom) a.mode = modeSel.value === 'append' ? 'append' : 'replace';
      if (enabledCb && a.mode !== 'custom') a.enabled = enabledCb.checked;
    });
    saveAiActionOverrides();
    showToast('指令已保存');
    bg.classList.remove('show');
  });
  renderAiActionList();
  bg.classList.add('show');
}

function renderAiActionList() {
  const list = document.getElementById('aiActionList');
  if (!list) return;
  list.innerHTML = AI_ACTIONS.map(a => {
    const def = AI_ACTIONS_DEFAULTS.find(d => d.id === a.id) || a;
    if (a.mode === 'custom') {
      return `
        <div class="ai-action-row" data-id="${a.id}" style="padding: 10px 0; border-bottom: 1px solid var(--rule-soft);">
          <div style="display:flex; gap:8px; align-items:center;">
            <input class="ai-action-label" type="text" value="${escapeHtml(a.label)}"
              style="flex:1; padding:6px 8px; border:1px solid var(--rule); background: var(--paper); color: var(--ink); border-radius: 4px;">
            <span style="color:var(--ink-mute); font-size: 11px;">自定义指令入口（始终启用）</span>
          </div>
        </div>`;
    }
    const isCustom = !!a.isCustom;
    return `
      <div class="ai-action-row" data-id="${a.id}" style="padding: 8px 0; border-bottom: 1px solid var(--rule-soft);">
        <div style="display:flex; gap:8px; align-items:center; margin-bottom: 4px; flex-wrap: wrap;">
          <label style="display:flex; align-items:center; gap:4px; font-size: 11px; color: var(--ink-mute); cursor: pointer; user-select: none; white-space: nowrap;">
            <input class="ai-action-enabled" type="checkbox" ${a.enabled === false ? '' : 'checked'}>
            <span>启用</span>
          </label>
          <input class="ai-action-label" type="text" value="${escapeHtml(a.label)}"
            style="flex:1; min-width: 120px; padding:4px 8px; border:1px solid var(--rule); background: var(--paper); color: var(--ink); border-radius: 4px; font-size: 13px;">
          ${isCustom ? `
            <select class="ai-action-mode" style="padding: 4px; border:1px solid var(--rule); background: var(--paper); color: var(--ink); border-radius: 4px; font-size: 12px;">
              <option value="replace" ${a.mode === 'replace' ? 'selected' : ''}>替换</option>
              <option value="append" ${a.mode === 'append' ? 'selected' : ''}>追加</option>
            </select>
            <button class="modal-btn ai-action-delete" data-del-id="${a.id}" style="padding: 4px 10px; font-size: 12px;">删除</button>
          ` : `<span style="font-size: 11px; color: var(--ink-mute); white-space: nowrap;">${escapeHtml(a.mode === 'title' ? '设标题' : a.mode === 'append' ? '追加' : '替换')}</span>`}
        </div>
        <textarea class="ai-action-system" rows="4"
          style="width:100%; box-sizing: border-box; padding: 6px 8px; border:1px solid var(--rule); background: var(--paper); color: var(--ink); border-radius: 4px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; resize: vertical;">${escapeHtml(a.system || '')}</textarea>
      </div>`;
  }).join('');
  list.querySelectorAll('.ai-action-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.delId;
      const idx = AI_ACTIONS.findIndex(x => x.id === id);
      if (idx < 0) return;
      if (!confirm('删除该自定义指令？保存后将永久移除。')) return;
      AI_ACTIONS.splice(idx, 1);
      renderAiActionList();
    });
  });
}
window.openAiActionManager = openAiActionManager;

// ---------- openAiMenu 过滤禁用 + 注入 指令管理 ----------
const _origOpenAiMenu_v121 = openAiMenu;
openAiMenu = function(anchor) {
  _origOpenAiMenu_v121.call(this, anchor);
  const menu = document.getElementById('aiMenu');
  if (!menu) return;
  AI_ACTIONS.forEach(a => {
    if (a.mode === 'custom') return;
    if (a.enabled === false) {
      const sel = `button[data-action="${(window.CSS && CSS.escape) ? CSS.escape(a.id) : a.id}"]`;
      const btn = menu.querySelector(sel);
      if (btn) btn.remove();
    }
  });
  const settingsBtn = menu.querySelector('button[data-action="settings"]');
  if (settingsBtn && !menu.querySelector('button[data-action="manage-actions"]')) {
    const mgr = document.createElement('button');
    mgr.dataset.action = 'manage-actions';
    mgr.textContent = '🧩 指令管理…';
    mgr.addEventListener('click', () => {
      if (typeof hideAiMenu === 'function') hideAiMenu();
      openAiActionManager();
    });
    settingsBtn.parentNode.insertBefore(mgr, settingsBtn);
  }
};

// ---------- openAiCustomModal 增加提示 ----------
const _origOpenAiCustomModal_v121 = openAiCustomModal;
openAiCustomModal = function() {
  _origOpenAiCustomModal_v121.apply(this, arguments);
  const ta = document.getElementById('aiCustomInput');
  if (ta) {
    ta.placeholder = '例如：把这段改写成更精炼的对话风格\n\n建议在 prompt 中明确：直接返回修改后的正文，不要无关注释。';
  }
  const modal = document.querySelector('#aiCustomModalBg .modal');
  if (modal && !modal.querySelector('.ai-custom-hint')) {
    const hint = document.createElement('div');
    hint.className = 'ai-custom-hint';
    hint.style.cssText = 'color: var(--ink-mute); font-size: 11px; margin: -4px 0 8px; line-height: 1.5;';
    hint.innerHTML = '提示：建议在指令末尾加入特色提示词，例如「<b>直接返回修改后的正文，不要无关注释</b>」，可获得更稳定的输出。';
    const ti = modal.querySelector('textarea#aiCustomInput');
    if (ti && ti.parentNode) ti.parentNode.insertBefore(hint, ti);
  }
};

// ---------- CSS（拖拽视觉 + 编辑区缩放变量） ----------
(function injectV121Style() {
  if (document.getElementById('v121-style')) return;
  const style = document.createElement('style');
  style.id = 'v121-style';
  style.textContent = `
    .drag-dragging { opacity: 0.45; }
    .rail-item.drag-over, .todo-row.drag-over, .ai-session-item.drag-over {
      outline: 2px dashed var(--accent, #888);
      outline-offset: -2px;
      background: var(--rule-soft, rgba(0,0,0,0.04));
    }
    [draggable="true"].rail-item, [draggable="true"].todo-row, [draggable="true"].ai-session-item {
      -webkit-user-drag: element;
    }
    #contentInput, #preview, #todoEditContent, #todoPreview {
      zoom: var(--editor-zoom, 1);
    }
    .ai-action-row textarea:focus, .ai-action-row input:focus {
      outline: none;
      border-color: var(--accent, #888) !important;
    }
  `;
  document.head.appendChild(style);
})();

// ---------- 多模态：把笔记中的 img:<id> 解析为 vision-style content 数组 ----------
function _resolveContentImages(content) {
  if (!content || typeof content !== 'string') return [];
  const out = [];
  const re = /!\[([^\]]*)\]\(img:([a-z0-9]+)\)/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const img = (typeof images === 'object' && images) ? images[m[2]] : null;
    if (img && img.dataUrl) out.push({ alt: m[1], dataUrl: img.dataUrl });
  }
  return out;
}

async function buildMultimodalUserContent(provider, title, content, extraImages) {
  const header = (title ? `标题：${title}\n\n` : '') + (content || '(空)');
  if (!provider || !provider.multimodal) return header;
  const imgs = _resolveContentImages(content);
  const extra = Array.isArray(extraImages) ? extraImages : [];
  if (!imgs.length && !extra.length) return header;
  const downscale = (typeof window._downscaleImage === 'function')
    ? window._downscaleImage
    : (async (u) => u);
  const parts = [{ type: 'text', text: header }];
  for (const im of imgs) {
    const url = await downscale(im.dataUrl, 1280, 0.85);
    parts.push({ type: 'image_url', image_url: { url } });
  }
  for (const im of extra) {
    const url = await downscale(im.dataUrl, 1280, 0.85);
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}
window.buildMultimodalUserContent = buildMultimodalUserContent;

const _origRunAiActionInternal_v121mm = _runAiActionInternal;
_runAiActionInternal = async function(action) {
  const provider = getActiveProvider();
  if (!provider || !provider.multimodal) {
    return _origRunAiActionInternal_v121mm.call(this, action);
  }
  if (!provider) { showToast('未配置 AI 模型'); openAiSettings(); return; }
  const isTodo = !!currentTodo, isNote = !!currentNote;
  if (!isTodo && !isNote) { showToast('请先选择笔记或待办'); return; }
  const target = isTodo ? 'todo:' + currentTodo.id : 'note:' + currentNote.id;
  const title = isTodo ? (currentTodo.text || '') : (currentNote.title || '');
  const content = isTodo ? (currentTodo.content || '') : (currentNote.content || '');
  pushAiUndoSnapshot(target, { title, content, ts: Date.now() });
  const userContent = await buildMultimodalUserContent(provider, title, content);
  const messages = [];
  const sysParts = [];
  if (provider.system) sysParts.push(provider.system);
  if (action.system) sysParts.push(action.system);
  if (sysParts.length) messages.push({ role: 'system', content: sysParts.join('\n\n') });
  messages.push({ role: 'user', content: userContent });

  setAiBusy(true);
  const ta = isTodo ? document.getElementById('todoEditContent') : document.getElementById('contentInput');
  const baseContent = action.mode === 'append' ? (content + (content ? '\n\n' : '')) : '';
  try {
    const reply = await callAi(messages, {
      stream: true,
      onDelta: (d, full) => {
        if (isTodo) {
          currentTodo.content = baseContent + full;
          if (ta) ta.value = currentTodo.content;
          if (isTodoPreviewMode) document.getElementById('todoPreview').innerHTML = renderMarkdown(currentTodo.content);
        } else {
          currentNote.content = baseContent + full;
          if (ta) ta.value = currentNote.content;
          if (isPreviewMode) applyNotePreview(currentNote);
        }
      }
    });
    if (isTodo) {
      currentTodo.content = baseContent + reply;
      saveData();
      const st = document.getElementById('todoEditStatus'); if (st) st.textContent = '已保存 · AI 已应用';
      renderTodos();
    } else {
      currentNote.content = baseContent + reply;
      currentNote.updatedAt = Date.now();
      saveData();
      const st = document.getElementById('editorStatus'); if (st) st.textContent = '已保存 · AI 已应用';
      updateWordCount();
      renderNotesList();
    }
    showToast('AI 已优化 ✓ 可在 AI 菜单撤销');
  } catch (e) {
    logError(e, 'ai-stream-mm');
    showToast('AI 失败：' + (e.message || e), e && e.stack);
  } finally {
    setAiBusy(false);
  }
};

// ---------- AI 标题总结：仅更新笔记标题栏，不改正文 ----------
function cleanTitleText(s) {
  if (!s) return '';
  let line = String(s).split('\n').map(x => x.trim()).find(x => x.length) || '';
  line = line.replace(/^#+\s*/, '').trim();
  line = line.replace(/^["'「『]+|["'」』]+$/g, '').trim();
  line = line.replace(/^(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}️‍]+)\s*/u, '').trim();
  if (line.length > 60) line = line.slice(0, 60);
  return line;
}

async function runAiTitleAction(action) {
  const provider = getActiveProvider();
  if (!provider) { showToast('未配置 AI 模型'); openAiSettings(); return; }
  const isTodo = !!currentTodo, isNote = !!currentNote;
  if (!isTodo && !isNote) { showToast('请先选择笔记或待办'); return; }
  const target = isTodo ? 'todo:' + currentTodo.id : 'note:' + currentNote.id;
  const oldTitle = isTodo ? (currentTodo.text || '') : (currentNote.title || '');
  const content = isTodo ? (currentTodo.content || '') : (currentNote.content || '');
  pushAiUndoSnapshot(target, { title: oldTitle, content, ts: Date.now() });
  const userContent = await buildMultimodalUserContent(provider, oldTitle, content);
  const messages = [];
  const sysParts = [];
  if (provider.system) sysParts.push(provider.system);
  if (action.system) sysParts.push(action.system);
  if (sysParts.length) messages.push({ role: 'system', content: sysParts.join('\n\n') });
  messages.push({ role: 'user', content: userContent });

  setAiBusy(true);
  const titleInput = isTodo ? null : document.getElementById('titleInput');
  try {
    const reply = await callAi(messages, {
      stream: true,
      onDelta: (d, full) => {
        const t = cleanTitleText(full);
        if (!isTodo && titleInput) titleInput.value = t;
      }
    });
    const clean = cleanTitleText(reply) || oldTitle;
    if (isTodo) {
      currentTodo.text = clean;
      saveData();
      renderTodos();
      const st = document.getElementById('todoEditStatus');
      if (st) st.textContent = '已保存 · AI 已更新标题';
    } else {
      currentNote.title = clean;
      currentNote.updatedAt = Date.now();
      saveData();
      if (titleInput) titleInput.value = clean;
      const st = document.getElementById('editorStatus');
      if (st) st.textContent = '已保存 · AI 已更新标题';
      renderNotesList();
    }
    showToast('AI 标题已应用 ✓ 可在 AI 菜单撤销');
  } catch (e) {
    logError(e, 'ai-title');
    showToast('AI 失败：' + (e.message || e), e && e.stack);
  } finally {
    setAiBusy(false);
  }
}

const _origRunAiAction_v121title = runAiAction;
runAiAction = async function(action) {
  if (action && (action.mode === 'title' || action.id === 'title')) {
    return runAiTitleAction(action);
  }
  return _origRunAiAction_v121title.call(this, action);
};

// ---------- 图片放大 Lightbox ----------
(function initLightbox() {
  const bg = document.getElementById('lightboxBg');
  const img = document.getElementById('lightboxImg');
  const scaleEl = document.getElementById('lightboxScale');
  const closeBtn = document.getElementById('lightboxClose');
  const zoomInBtn = document.getElementById('lightboxZoomIn');
  const zoomOutBtn = document.getElementById('lightboxZoomOut');
  const resetBtn = document.getElementById('lightboxReset');

  if (!bg || !img) return;

  let currentScale = 1;
  const SCALE_STEP = 0.25;
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 5;

  function updateScale() {
    img.style.transform = `scale(${currentScale})`;
    scaleEl.textContent = Math.round(currentScale * 100) + '%';
  }

  function openLightbox(src) {
    img.src = src;
    currentScale = 1;
    updateScale();
    bg.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    bg.classList.remove('show');
    document.body.style.overflow = '';
    img.src = '';
  }

  function zoomIn() {
    currentScale = Math.min(MAX_SCALE, currentScale + SCALE_STEP);
    updateScale();
  }

  function zoomOut() {
    currentScale = Math.max(MIN_SCALE, currentScale - SCALE_STEP);
    updateScale();
  }

  function resetZoom() {
    currentScale = 1;
    updateScale();
  }

  closeBtn.addEventListener('click', closeLightbox);
  zoomInBtn.addEventListener('click', e => { e.stopPropagation(); zoomIn(); });
  zoomOutBtn.addEventListener('click', e => { e.stopPropagation(); zoomOut(); });
  resetBtn.addEventListener('click', e => { e.stopPropagation(); resetZoom(); });

  bg.addEventListener('click', e => {
    if (e.target === bg) closeLightbox();
  });

  img.addEventListener('click', e => e.stopPropagation());

  bg.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.deltaY < 0) zoomIn();
    else zoomOut();
  }, { passive: false });

  document.addEventListener('keydown', e => {
    if (!bg.classList.contains('show')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === '+' || e.key === '=') zoomIn();
    else if (e.key === '-') zoomOut();
    else if (e.key === '0') resetZoom();
  });

  document.addEventListener('click', e => {
    const target = e.target;
    if (target.tagName !== 'IMG') return;
    const isInPreview = target.closest('.preview') || target.closest('#todoPreview');
    if (!isInPreview) return;
    const src = target.src || target.dataset.src;
    if (!src) return;
    e.preventDefault();
    openLightbox(src);
  });

  window.openImageLightbox = openLightbox;
  window.closeImageLightbox = closeLightbox;
})();

applyEditorZoom();
bindEditorZoomTargets();

init()
  .then(() => {
    if (typeof syncProxyToBackground === 'function') syncProxyToBackground();
    bindEditorZoomTargets();
  })
  .catch(e => { logError(e, 'init'); console.error(e); });

// AI 助手代码已移到 js/assistant.js
const _ASSISTANT_MOVED = 'see js/assistant.js';

