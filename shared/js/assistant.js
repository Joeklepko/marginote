// =====================================================================
// AI 助手（Skill 系统：工具调用 + 多会话 + 附件 + 内嵌面板）
// 依赖（来自 app.js 的全局）：
//   - 状态：notebooks, notes, todos
//   - 工具函数：uid, escapeHtml, formatFullDate, showToast, logError
//   - 数据：saveData, selectNote, scheduleTodoReminders
//   - 渲染：renderNotebooks, renderNotesList, renderTodos, renderTodoCounts
//   - AI：getActiveProvider, callAi
//   - 设置：openSettingsModal
// =====================================================================
const ASSISTANT_GROUPS_KEY = 'marginote.assistantGroups';
const ASSISTANT_HISTORY_MAX = 200;
// 数据结构：assistantGroups = [{id, name, createdAt, sessions: [{id, name, createdAt, messages: [...]}]}]
let assistantGroups = [];
let assistantActiveGroupId = null;

function _ctxLimit(small, medium, large) {
  const p = typeof getActiveProvider === 'function' ? getActiveProvider() : null;
  const k = (p && p.contextSize > 0) ? p.contextSize : 10;
  if (k <= 16) return small;
  if (k <= 64) return medium;
  // 64K 以上按上下文比例放大 large 档,以 96K 为基准单调递增:
  //   96K→1.0×  128K≈1.33×  140K≈1.46×  200K≈2.08×,上限 12×。
  // 用户当前模型多为 128K~200K,旧逻辑把它们全压成同一套 large 值,偏保守,这里解锁更大检索/历史预算。
  return Math.round(large * Math.min(Math.max(k, 96) / 96, 12));
}
let assistantActiveSessionId = null;
let assistantBusy = false;
let assistantInAiView = false;
let recordingMode = false;
let recordingBuffer = [];

// ===================== 分组/会话管理 =====================

function loadAssistantGroups() {
  try {
    const raw = localStorage.getItem(ASSISTANT_GROUPS_KEY);
    assistantGroups = raw ? JSON.parse(raw) : [];
  } catch { assistantGroups = []; }

  // 迁移：旧版 group.messages → group.sessions[0].messages
  let migrated = false;
  for (const g of assistantGroups) {
    if (Array.isArray(g.messages) && !Array.isArray(g.sessions)) {
      g.sessions = [{ id: uid(), name: '默认会话', createdAt: g.createdAt || Date.now(), messages: g.messages }];
      delete g.messages;
      migrated = true;
    } else if (!Array.isArray(g.sessions)) {
      g.sessions = [{ id: uid(), name: '默认会话', createdAt: Date.now(), messages: [] }];
      migrated = true;
    }
  }

  // 更旧版（无 group），迁移单一会话历史
  if (!assistantGroups.length) {
    try {
      const oldRaw = localStorage.getItem('marginote.assistantHistory');
      const oldMessages = oldRaw ? JSON.parse(oldRaw) : [];
      if (oldMessages.length) {
        assistantGroups = [{
          id: uid(), name: '默认分组', createdAt: Date.now(),
          sessions: [{ id: uid(), name: '默认会话', createdAt: Date.now(), messages: oldMessages }]
        }];
        localStorage.removeItem('marginote.assistantHistory');
        migrated = true;
      }
    } catch {}
  }

  if (!assistantGroups.length) {
    assistantGroups = [{
      id: uid(), name: '默认分组', createdAt: Date.now(),
      sessions: [{ id: uid(), name: '默认会话', createdAt: Date.now(), messages: [] }]
    }];
  }
  assistantActiveGroupId = assistantGroups[0].id;
  assistantActiveSessionId = assistantGroups[0].sessions[0]?.id || null;
  if (migrated) saveAssistantGroups();
}

function getActiveGroup() {
  let g = assistantGroups.find(x => x.id === assistantActiveGroupId);
  if (!g) { g = assistantGroups[0]; assistantActiveGroupId = g?.id || null; }
  return g;
}

function getActiveSession() {
  const g = getActiveGroup();
  if (!g) return null;
  let s = g.sessions.find(x => x.id === assistantActiveSessionId);
  if (!s) { s = g.sessions[0]; assistantActiveSessionId = s?.id || null; }
  return s;
}

function saveAssistantGroups() {
  try {
    const clean = assistantGroups.map(g => ({
      id: g.id, name: g.name, createdAt: g.createdAt,
      sessions: (g.sessions || []).map(s => ({
        id: s.id, name: s.name, createdAt: s.createdAt,
        messages: (s.messages || []).slice(-ASSISTANT_HISTORY_MAX)
      }))
    }));
    localStorage.setItem(ASSISTANT_GROUPS_KEY, JSON.stringify(clean));
  } catch {}
}

// 内联重命名（替代 prompt() 弹窗）
function startInlineRename(container, nameSelector, currentName, onConfirm) {
  const nameEl = container.querySelector(nameSelector);
  if (!nameEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-rename-input';
  input.value = currentName;
  nameEl.style.display = 'none';
  nameEl.parentNode.insertBefore(input, nameEl);
  input.focus();
  input.select();
  let done = false;
  function finish(val) {
    if (done) return;
    done = true;
    input.remove();
    nameEl.style.display = '';
    if (val && val.trim()) onConfirm(val.trim());
  }
  input.addEventListener('blur', () => finish(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); done = true; input.remove(); nameEl.style.display = ''; }
  });
}

function createAssistantGroup(name) {
  const g = {
    id: uid(), name: String(name || '新分组').trim(), createdAt: Date.now(),
    sessions: [{ id: uid(), name: '新会话', createdAt: Date.now(), messages: [] }]
  };
  assistantGroups.unshift(g);
  assistantActiveGroupId = g.id;
  assistantActiveSessionId = g.sessions[0].id;
  saveAssistantGroups();
  renderAssistantRail();
  if (assistantInAiView) { renderAssistantSessions(); renderAssistantChat(); }
  return g;
}

function deleteAssistantGroup(id) {
  if (assistantGroups.length <= 1) { showToast('至少保留一个分组'); return; }
  assistantGroups = assistantGroups.filter(g => g.id !== id);
  if (assistantActiveGroupId === id) {
    assistantActiveGroupId = assistantGroups[0].id;
    assistantActiveSessionId = assistantGroups[0].sessions[0]?.id || null;
  }
  saveAssistantGroups();
  renderAssistantRail();
  if (assistantInAiView) { renderAssistantSessions(); renderAssistantChat(); }
}

function renameAssistantGroup(id, name) {
  const g = assistantGroups.find(x => x.id === id);
  if (g) { g.name = String(name || '未命名').trim(); }
  saveAssistantGroups();
  renderAssistantRail();
  if (assistantInAiView) renderAssistantSessions();
}

function createAssistantSession(groupId, name) {
  const g = assistantGroups.find(x => x.id === groupId);
  if (!g) return null;
  const s = { id: uid(), name: String(name || '新会话').trim(), createdAt: Date.now(), messages: [] };
  g.sessions.unshift(s);
  assistantActiveSessionId = s.id;
  saveAssistantGroups();
  renderAssistantRail();
  renderAssistantSessions();
  renderAssistantChat();
  return s;
}

function deleteAssistantSession(groupId, sessionId) {
  const g = assistantGroups.find(x => x.id === groupId);
  if (!g) return;
  if (g.sessions.length <= 1) { showToast('该分组至少保留一个会话'); return; }
  g.sessions = g.sessions.filter(s => s.id !== sessionId);
  if (assistantActiveSessionId === sessionId) {
    assistantActiveSessionId = g.sessions[0].id;
  }
  saveAssistantGroups();
  renderAssistantRail();
  renderAssistantSessions();
  renderAssistantChat();
}

function renameAssistantSession(groupId, sessionId, name) {
  const g = assistantGroups.find(x => x.id === groupId);
  if (!g) return;
  const s = g.sessions.find(x => x.id === sessionId);
  if (s) { s.name = String(name || '未命名').trim(); }
  saveAssistantGroups();
  renderAssistantSessions();
}

function clearActiveSessionHistory() {
  const s = getActiveSession();
  if (!s) return;
  s.messages = [];
  saveAssistantGroups();
  renderAssistantChat();
  renderAssistantSessions();
}

// ===================== 附件管理 =====================

let pendingAttachments = [];   // [{type: 'note'|'todo', id, title} | {type:'image', dataUrl, name}]

function addPendingAttachment(type, id, title) {
  if (pendingAttachments.some(a => a.type === type && a.id === id)) return;
  pendingAttachments.push({ type, id, title: String(title || '') });
  renderPendingAttachments();
}

function addPendingImage(dataUrl, name) {
  if (!dataUrl) return;
  pendingAttachments.push({ type: 'image', dataUrl, name: String(name || 'image') });
  renderPendingAttachments();
}

// 把图片缩放到 maxDim 边长以内并压成 jpeg，避免上送 base64 过大触发 413
async function _downscaleImage(dataUrl, maxDim = 1280, quality = 0.85) {
  if (!dataUrl || typeof dataUrl !== 'string') return dataUrl;
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (!w || !h) { resolve(dataUrl); return; }
          const longest = Math.max(w, h);
          // 超过阈值才重压，避免小图无谓损耗
          if (longest <= maxDim && dataUrl.length < 200 * 1024) { resolve(dataUrl); return; }
          const ratio = Math.min(1, maxDim / longest);
          const nw = Math.max(1, Math.round(w * ratio));
          const nh = Math.max(1, Math.round(h * ratio));
          const canvas = document.createElement('canvas');
          canvas.width = nw; canvas.height = nh;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, nw, nh);
          const out = canvas.toDataURL('image/jpeg', quality);
          resolve(out && out.length < dataUrl.length ? out : dataUrl);
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch { resolve(dataUrl); }
  });
}
window._downscaleImage = _downscaleImage;

function removePendingAttachment(index) {
  pendingAttachments.splice(index, 1);
  renderPendingAttachments();
}

function clearPendingAttachments() {
  pendingAttachments = [];
  renderPendingAttachments();
}

function renderPendingAttachments() {
  const el = document.getElementById('assistantAttachments');
  if (!el) return;
  if (!pendingAttachments.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = pendingAttachments.map((a, i) => {
    if (a.type === 'image') {
      return `<span class="attach-pill image" title="图片附件 — 点击移除" data-remove="${i}">
        <span class="attach-type-badge" style="background:#fef3c7;color:#92400e;">IMG</span>
        ${escapeHtml((a.name || 'image').slice(0, 20))}
      </span>`;
    }
    const badge = a.type === 'note' ? '<span class="attach-type-badge note">md</span>' : '<span class="attach-type-badge todo">✓</span>';
    const title = a.title || '';
    return `<span class="attach-pill" title="${escapeHtml(a.type === 'note' ? '笔记' : '待办')}: ${escapeHtml(title)} — 点击移除" data-remove="${i}">${badge}${escapeHtml(title.slice(0, 24))}${title.length > 24 ? '…' : ''}</span>`;
  }).join('');
  el.querySelectorAll('.attach-pill').forEach(pill => {
    pill.addEventListener('click', () => removePendingAttachment(parseInt(pill.dataset.remove)));
  });
}

function openAttachmentPicker() {
  const modal = document.getElementById('attachmentPickerBg');
  if (!modal) return;
  renderAttachmentPickerContent();
  modal.classList.add('show');
}

function closeAttachmentPicker() {
  document.getElementById('attachmentPickerBg')?.classList.remove('show');
}

function renderAttachmentPickerContent() {
  const list = document.getElementById('attachmentPickerList');
  if (!list) return;

  const activeNotes = notes.filter(n => !n.deleted);
  const activeTodos = todos.slice();

  // 图片上传
  const imgAttached = pendingAttachments.filter(a => a.type === 'image');
  let html = '<div style="padding:4px 0 10px;"><button class="modal-btn" id="attachImagePickBtn" type="button">本地上传</button></div>';
  if (imgAttached.length) {
    html += '<div style="display:flex; flex-wrap:wrap; gap:8px;">';
    for (let i = 0; i < pendingAttachments.length; i++) {
      const a = pendingAttachments[i];
      if (a.type !== 'image') continue;
      html += `<div class="attach-image-tile" data-remove-idx="${i}" title="${escapeHtml(a.name || 'image')} — 点击移除" style="position:relative; cursor:pointer; border:1px solid var(--rule); border-radius:6px; overflow:hidden; width:56px; height:56px;">
        <img src="${a.dataUrl}" style="width:100%; height:100%; object-fit:cover; display:block;">
        <span style="position:absolute; top:2px; right:4px; background:rgba(0,0,0,0.55); color:#fff; font-size:11px; line-height:14px; padding:0 4px; border-radius:7px;">✕</span>
      </div>`;
    }
    html += '</div>';
  }

  html += '<div class="attach-picker-section"><div class="attach-picker-title">📝 笔记</div>';
  if (!activeNotes.length) {
    html += '<div class="attach-picker-empty">暂无笔记</div>';
  } else {
    for (const n of activeNotes.slice(0, 50)) {
      const selected = pendingAttachments.some(a => a.type === 'note' && a.id === n.id);
      html += `<div class="attach-picker-item ${selected ? 'selected' : ''}" data-type="note" data-id="${escapeHtml(n.id)}" data-title="${escapeHtml(n.title || '(无标题)')}">${escapeHtml(n.title || '(无标题)')}</div>`;
    }
  }
  html += '</div>';

  html += '<div class="attach-picker-section"><div class="attach-picker-title">✅ 待办</div>';
  if (!activeTodos.length) {
    html += '<div class="attach-picker-empty">暂无待办</div>';
  } else {
    for (const t of activeTodos.slice(0, 50)) {
      const selected = pendingAttachments.some(a => a.type === 'todo' && a.id === t.id);
      html += `<div class="attach-picker-item ${selected ? 'selected' : ''}" data-type="todo" data-id="${escapeHtml(t.id)}" data-title="${escapeHtml(t.text || '(无标题)')}">${escapeHtml(t.text || '(无标题)')}</div>`;
    }
  }
  html += '</div>';

  list.innerHTML = html;
  const pickBtn = list.querySelector('#attachImagePickBtn');
  const fileEl = document.getElementById('assistantImageFile');
  if (pickBtn && fileEl) pickBtn.addEventListener('click', () => fileEl.click());
  list.querySelectorAll('.attach-image-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const idx = parseInt(tile.dataset.removeIdx, 10);
      if (!isNaN(idx)) removePendingAttachment(idx);
      renderAttachmentPickerContent();
    });
  });
  list.querySelectorAll('.attach-picker-item').forEach(item => {
    item.addEventListener('click', () => {
      const type = item.dataset.type;
      const id = item.dataset.id;
      const title = item.dataset.title;
      if (item.classList.contains('selected')) {
        const idx = pendingAttachments.findIndex(a => a.type === type && a.id === id);
        if (idx >= 0) removePendingAttachment(idx);
      } else {
        addPendingAttachment(type, id, title);
      }
      renderAttachmentPickerContent();
    });
  });
}

// ===================== 辅助函数 =====================

const MEMORY_KEY = 'marginote.assistant.memory';
const MEMORY_MAX = 300;          // 记忆总条数上限（超出按最旧更新丢弃）
const MEMORY_VALUE_MAX = 600;    // 单条 value 字符上限，防止单条撑爆系统提示词
const MEMORY_CATEGORIES = ['preference', 'fact', 'context', 'other'];
const MEMORY_CAT_LABEL = { preference: '偏好', fact: '事实', context: '背景', other: '其他' };
function loadMemories() { try { return JSON.parse(localStorage.getItem(MEMORY_KEY)) || []; } catch { return []; } }
function saveMemories(arr) { localStorage.setItem(MEMORY_KEY, JSON.stringify(arr)); }
// 统一的记忆写入入口（AI 工具与手动添加共用）：同 key 覆盖并保留 createdAt、key/value 限长、
// category 归一化、总量封顶时按 updatedAt 升序丢弃最旧。返回写入的条目。
function upsertMemory(key, value, category) {
  key = String(key == null ? '' : key).trim().slice(0, 80);
  value = String(value == null ? '' : value).trim().slice(0, MEMORY_VALUE_MAX);
  if (!key || !value) throw new Error('key 和 value 必填');
  const cat = MEMORY_CATEGORIES.includes(category) ? category : 'other';
  const arr = loadMemories();
  const idx = arr.findIndex(m => m.key === key);
  const now = Date.now();
  const entry = { key, value, category: cat, createdAt: idx >= 0 ? (arr[idx].createdAt || now) : now, updatedAt: now };
  if (idx >= 0) arr[idx] = entry; else arr.push(entry);
  if (arr.length > MEMORY_MAX) {
    arr.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    arr.splice(0, arr.length - MEMORY_MAX);
  }
  saveMemories(arr);
  return entry;
}

function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[-]{3,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSnippet(content, query, maxLen = 200) {
  const plain = stripMarkdown(content);
  if (!query) return plain.slice(0, maxLen).replace(/\s+/g, ' ');
  const lower = plain.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let bestIdx = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx >= 0) { bestIdx = idx; break; }
  }
  if (bestIdx >= 0) {
    const start = Math.max(0, bestIdx - 40);
    return (start > 0 ? '...' : '') + plain.slice(start, start + maxLen).replace(/\s+/g, ' ');
  }
  return plain.slice(0, maxLen).replace(/\s+/g, ' ');
}

// ===================== 工具定义 =====================

const ASSISTANT_TOOLS = {
  list_notebooks: {
    desc: '列出笔记本(含笔记数)。无参数',
    run: () => notebooks.map(nb => {
      const count = notes.filter(n => !n.deleted && n.notebookId === nb.id).length;
      return { id: nb.id, name: nb.name, color: nb.color, noteCount: count };
    })
  },
  search_notes: {
    desc: '搜索笔记(标题+正文,支持中文模糊匹配,按相关度排序)。{query?, limit?(默认30)}',
    run: ({ query, limit }) => {
      const q = String(query || '').trim().toLowerCase();
      const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || _ctxLimit(30, 50, 80)));
      let list = notes.filter(n => !n.deleted);
      if (q) {
        const terms = q.split(/\s+/).filter(Boolean);
        // 2-gram 词块：应对中文无空格查询。例如"用药上线时间"拆出"用药/药上/上线/线时/时间",
        // 即可命中标题"用药交付时间"(共享"用药"+"时间")——这正是大模型不加空格直搜时找不到笔记的根因。
        const grams = new Set();
        for (const t of terms) { const s = t.replace(/\s/g, ''); if (s.length < 2) { if (s) grams.add(s); } else for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2)); }
        const scoreOf = (n) => {
          const title = (n.title || '').toLowerCase();
          const content = (n.content || '').toLowerCase();
          let s = 0;
          for (const t of terms) { if (title.includes(t)) s += 10; else if (content.includes(t)) s += 5; }   // 整词命中,标题权重高于正文
          if (!s) { for (const g of grams) { if (title.includes(g)) s += 2; else if (content.includes(g)) s += 1; } }  // 退化到词块模糊
          return s;
        };
        const scored = list.map(n => ({ n, s: scoreOf(n) })).filter(x => x.s > 0);
        if (scored.length) {
          scored.sort((a, b) => b.s - a.s || (b.n.updatedAt || 0) - (a.n.updatedAt || 0));   // 相关度优先,更新时间次之
          list = scored.map(x => x.n);
        } else {
          // 最后兜底:字符子序列(极宽松),按更新时间排序
          const chars = q.replace(/\s+/g, '').split('');
          list = list.filter(n => { const blob = ((n.title || '') + (n.content || '')).toLowerCase(); return chars.every(c => blob.includes(c)); })
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        }
      } else {
        list = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }
      return list.slice(0, lim).map(n => {
        const nb = notebooks.find(x => x.id === n.notebookId);
        return { id: n.id, title: n.title || '(无标题)', snippet: extractSnippet(n.content, q, _ctxLimit(200, 400, 800)), notebookName: nb?.name || '', tags: n.tags || [], updatedAt: n.updatedAt };
      });
    }
  },
  search_todos: {
    desc: '搜索待办。{query?, status?"active"|"done"|"overdue"|"all", due?"today"|"overdue"|"week", limit?}',
    run: ({ query, status, due, limit }) => {
      const q = String(query || '').trim().toLowerCase();
      const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || _ctxLimit(10, 30, 50)));
      const now = Date.now();
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
      let list = todos.slice();
      if (status === 'active') list = list.filter(t => !t.done);
      else if (status === 'done') list = list.filter(t => t.done);
      else if (status === 'overdue') list = list.filter(t => !t.done && t.dueDate && t.dueDate < now);
      if (due === 'today') list = list.filter(t => t.dueDate && t.dueDate >= todayStart.getTime() && t.dueDate <= todayEnd.getTime());
      else if (due === 'overdue') list = list.filter(t => !t.done && t.dueDate && t.dueDate < todayStart.getTime());
      else if (due === 'week') { const weekEnd = todayEnd.getTime() + 6 * 86400000; list = list.filter(t => t.dueDate && t.dueDate >= todayStart.getTime() && t.dueDate <= weekEnd); }
      if (q) list = list.filter(t => (t.text || '').toLowerCase().includes(q) || (t.content || '').toLowerCase().includes(q));
      return list.sort((a, b) => (a.dueDate || Infinity) - (b.dueDate || Infinity)).slice(0, lim).map(t => ({ id: t.id, text: t.text, done: !!t.done, dueAt: t.dueDate ? new Date(t.dueDate).toISOString() : null, remindBeforeMin: t.remindBeforeMin || 0, contentPreview: (t.content || '').slice(0, _ctxLimit(100, 200, 500)) }));
    }
  },
  create_note: {
    desc: '新建笔记。{title, content?, notebookName?}',
    run: ({ title, content, notebookName }) => {
      let nb = null;
      if (notebookName) {
        nb = notebooks.find(x => x.name === notebookName) || null;
        if (!nb) { nb = { id: uid(), name: String(notebookName), color: '#525252', createdAt: Date.now() }; notebooks.push(nb); }
      } else {
        nb = notebooks[0] || null;
        if (!nb) { nb = { id: uid(), name: '默认', color: '#525252', createdAt: Date.now() }; notebooks.push(nb); }
      }
      const note = { id: uid(), notebookId: nb.id, folderId: null, title: String(title || '无标题'), content: String(content || ''), tags: [], starred: false, deleted: false, createdAt: Date.now(), updatedAt: Date.now() };
      notes.unshift(note);
      saveData();
      renderNotebooks();
      renderNotesList();
      return { id: note.id, title: note.title, notebookId: nb.id, notebookName: nb.name };
    }
  },
  create_todo: {
    desc: '新建待办。{text, dueAt?:ISO8601, remindBeforeMin?}',
    run: ({ text, dueAt, remindBeforeMin }) => {
      if (!text) throw new Error('text 必填');
      let dueDate = null;
      if (dueAt) { const d = new Date(dueAt); if (!isNaN(d.getTime())) dueDate = d.getTime(); }
      const t = { id: uid(), text: String(text), content: '', done: false, dueDate, remindBeforeMin: parseInt(remindBeforeMin, 10) || 0, remindCount: 1, remindIntervalMin: 5, createdAt: Date.now(), completedAt: null };
      todos.push(t);
      saveData();
      try { scheduleTodoReminders(t); } catch {}
      renderTodos();
      renderTodoCounts();
      return { id: t.id, text: t.text, dueAt: dueDate ? new Date(dueDate).toISOString() : null, remindBeforeMin: t.remindBeforeMin };
    }
  },
  update_note: {
    desc: '修改笔记。{id?, title?, content?}不传id用附件',
    run: ({ id, title, content }) => {
      if (!id && pendingAttachments.length) { const att = pendingAttachments.find(a => a.type === 'note'); if (att) id = att.id; }
      const n = notes.find(x => x.id === id);
      if (!n) throw new Error('笔记未找到：' + (id || '(未指定)'));
      if (typeof title === 'string') n.title = title;
      if (typeof content === 'string') n.content = content;
      n.updatedAt = Date.now();
      saveData();
      renderNotesList();
      if (typeof selectNote === 'function' && id === (window._currentNoteId || '')) { selectNote(n); }
      return { id: n.id, title: n.title };
    }
  },
  update_todo: {
    desc: '修改待办。{id?, text?, content?, done?, dueAt?}不传id用附件',
    run: ({ id, text, content, done, dueAt }) => {
      if (!id && pendingAttachments.length) { const att = pendingAttachments.find(a => a.type === 'todo'); if (att) id = att.id; }
      const t = todos.find(x => x.id === id);
      if (!t) throw new Error('待办未找到：' + (id || '(未指定)'));
      if (typeof text === 'string') t.text = text;
      if (typeof content === 'string') t.content = content;
      if (typeof done === 'boolean') { t.done = done; if (done) t.completedAt = Date.now(); else t.completedAt = null; }
      if (dueAt !== undefined) { const d = new Date(dueAt); if (!isNaN(d.getTime())) t.dueDate = d.getTime(); else t.dueDate = null; }
      saveData();
      renderTodos();
      renderTodoCounts();
      return { id: t.id, text: t.text, done: !!t.done };
    }
  },
  create_notebook: {
    desc: '新建笔记本。{name, color?}',
    run: ({ name, color }) => {
      if (!name) throw new Error('name 必填');
      const existing = notebooks.find(x => x.name === name);
      if (existing) return { id: existing.id, name: existing.name, color: existing.color, existed: true };
      const nb = { id: uid(), name: String(name), color: String(color || '#525252'), createdAt: Date.now() };
      notebooks.push(nb);
      saveData();
      renderNotebooks();
      return { id: nb.id, name: nb.name, color: nb.color };
    }
  },
  rename_notebook: {
    desc: '重命名笔记本。{notebookId?|notebookName?, newName, newColor?}',
    run: ({ notebookId, notebookName, newName, newColor }) => {
      if (!newName) throw new Error('newName 必填');
      let nb = null;
      if (notebookId) nb = notebooks.find(x => x.id === notebookId);
      else if (notebookName) nb = notebooks.find(x => x.name === notebookName);
      if (!nb) throw new Error('笔记本未找到：' + (notebookName || notebookId || '(未指定)'));
      const oldName = nb.name;
      nb.name = String(newName);
      if (newColor) nb.color = String(newColor);
      saveData();
      renderNotebooks();
      return { id: nb.id, oldName, newName: nb.name, color: nb.color };
    }
  },
  delete_notebook: {
    desc: '删除笔记本。{notebookId?|notebookName?}（工作目录下整个移入回收站可整体恢复；否则笔记搬到默认本）',
    run: async ({ notebookId, notebookName }) => {
      let nb = null;
      if (notebookId) nb = notebooks.find(x => x.id === notebookId);
      else if (notebookName) nb = notebooks.find(x => x.name === notebookName);
      if (!nb) throw new Error('笔记本未找到');
      if (notebooks.length <= 1) throw new Error('至少保留一个笔记本');
      const cnt = notes.filter(n => n.notebookId === nb.id && !n.deleted).length;
      const fs = typeof fsApi === 'function' ? fsApi() : null;
      const onWorkdir = !!(fs && await fs.hasDir() && window.trash);
      if (onWorkdir) {
        // 整个笔记本目录移入回收站（连同其中的笔记文件，可在回收站整体恢复）
        try { await window.trash.moveToTrash({ path: safeName(nb.name), type: 'notebook', name: nb.name }); } catch (e) { logError && logError(e, 'trash-nb'); }
        notes = notes.filter(n => n.notebookId !== nb.id);
        folders = folders.filter(f => f.notebookId !== nb.id);
        notebooks = notebooks.filter(x => x.id !== nb.id);
        saveData(); renderNotebooks(); renderNotesList();
        return { deleted: nb.name, trashed: true, noteCount: cnt };
      }
      // 非工作目录（扩展等）：保留旧行为——笔记搬到默认本，避免无回收站时丢数据
      const defaultNb = notebooks.find(x => x.id !== nb.id);
      notes.forEach(n => { if (n.notebookId === nb.id) n.notebookId = defaultNb.id; });
      folders = folders.filter(f => f.notebookId !== nb.id);
      notebooks = notebooks.filter(x => x.id !== nb.id);
      saveData(); renderNotebooks(); renderNotesList();
      return { deleted: nb.name, movedNotesTo: defaultNb.name, movedCount: cnt };
    }
  },
  move_note: {
    desc: '移动笔记。{noteId, notebookId?|notebookName?}',
    run: ({ noteId, notebookId, notebookName }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到：' + (noteId || '(未指定)'));
      let targetNb = null;
      if (notebookId) targetNb = notebooks.find(x => x.id === notebookId);
      else if (notebookName) targetNb = notebooks.find(x => x.name === notebookName);
      if (!targetNb) throw new Error('目标笔记本未找到：' + (notebookName || notebookId || '(未指定)'));
      n.notebookId = targetNb.id;
      n.updatedAt = Date.now();
      saveData();
      renderNotesList();
      return { id: n.id, title: n.title || '(无标题)', notebookId: targetNb.id, notebookName: targetNb.name };
    }
  },
  delete_note: {
    desc: '删除笔记（移入回收站，可恢复）。{id}',
    run: async ({ id }) => {
      const n = notes.find(x => x.id === id);
      if (!n) throw new Error('笔记未找到：' + (id || '(未指定)'));
      const title = n.title || '(无标题)';
      const fs = typeof fsApi === 'function' ? fsApi() : null;
      const onWorkdir = !!(fs && await fs.hasDir() && window.trash);
      if (onWorkdir) {
        // 桌面回收站：把文件移入 回收站/，从活跃列表移除（可在回收站视图恢复）
        const p = n._srcPath || (n.type === 'drawing' ? drawingRelPath(n) : noteRelPath(n));
        try { await window.trash.moveToTrash({ path: p, type: 'note', name: title + (n.type === 'drawing' ? '.excalidraw' : '.md') }); } catch (e) { logError && logError(e, 'trash-note'); }
        notes = notes.filter(x => x.id !== id);
      } else {
        n.deleted = true; n.updatedAt = Date.now();
      }
      saveData();
      renderNotesList();
      return { id, title, deleted: true, trashed: onWorkdir };
    }
  },
  optimize_text: {
    desc: 'AI改写文本。{text, instruction}',
    run: async ({ text, instruction }) => {
      if (!text || !instruction) throw new Error('text 与 instruction 必填');
      const out = await callAi([{ role: 'system', content: '你是中文写作助手。按用户的指令直接重写给定文本，仅输出最终结果，不解释。' }, { role: 'user', content: `指令：${instruction}\n\n原文：\n${text}` }], { stream: false });
      return { result: out };
    }
  },
  get_note: {
    desc: '获取笔记全文。{id}',
    run: ({ id }) => {
      const n = notes.find(x => x.id === id && !x.deleted);
      if (!n) throw new Error('笔记未找到：' + (id || '(未指定)'));
      const nb = notebooks.find(x => x.id === n.notebookId);
      return { id: n.id, title: n.title || '(无标题)', content: n.content || '', notebookName: nb?.name || '', tags: n.tags || [], starred: !!n.starred, updatedAt: n.updatedAt };
    }
  },
  get_todo: {
    desc: '获取待办详情。{id}',
    run: ({ id }) => {
      const t = todos.find(x => x.id === id);
      if (!t) throw new Error('待办未找到：' + (id || '(未指定)'));
      return { id: t.id, text: t.text, content: t.content || '', done: !!t.done, dueDate: t.dueDate ? new Date(t.dueDate).toISOString() : null, remindBeforeMin: t.remindBeforeMin || 0, createdAt: t.createdAt, completedAt: t.completedAt };
    }
  },

  // ——— 记忆系统 ———
  save_memory: {
    desc: '记住用户的持久信息供以后对话使用(同一 key 覆盖更新,value 请简洁)。{key:"简短标识", value:"内容", category?:"preference"长期偏好/习惯|"fact"关于用户的事实|"context"项目或工作背景|"other"}',
    run: ({ key, value, category }) => {
      const e = upsertMemory(key, value, category);
      return { key: e.key, category: e.category, saved: true };
    }
  },
  recall_memory: {
    desc: '查找已保存的记忆(按最近更新排序)。{query?:关键词, category?:"preference"|"fact"|"context"|"other"} 均不传则返回全部',
    run: ({ query, category }) => {
      let arr = loadMemories();
      if (MEMORY_CATEGORIES.includes(category)) arr = arr.filter(m => m.category === category);
      if (query) {
        const q = String(query).toLowerCase();
        arr = arr.filter(m => (m.key || '').toLowerCase().includes(q) || (m.value || '').toLowerCase().includes(q));
      }
      return arr
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(m => ({ key: m.key, value: m.value, category: m.category, updatedAt: m.updatedAt ? new Date(m.updatedAt).toISOString().slice(0, 10) : undefined }));
    }
  },
  delete_memory: {
    desc: '删除一条记忆。{key}',
    run: ({ key }) => {
      key = String(key == null ? '' : key).trim();
      if (!key) throw new Error('key 必填');
      const arr = loadMemories();
      const filtered = arr.filter(m => m.key !== key);
      saveMemories(filtered);
      return { deleted: arr.length - filtered.length > 0, key };
    }
  },

  // ——— 批量操作 ———
  batch_move_notes: {
    desc: '批量移动笔记。{noteIds[], notebookId?|notebookName?}',
    run: ({ noteIds, notebookId, notebookName }) => {
      if (!Array.isArray(noteIds) || !noteIds.length) throw new Error('noteIds 必填且不能为空');
      let nb = null;
      if (notebookId) nb = notebooks.find(x => x.id === notebookId);
      else if (notebookName) nb = notebooks.find(x => x.name === notebookName);
      if (!nb) throw new Error('目标笔记本未找到');
      let success = 0, failed = 0;
      const details = [];
      for (const id of noteIds) {
        const n = notes.find(x => x.id === id && !x.deleted);
        if (n) { n.notebookId = nb.id; n.updatedAt = Date.now(); success++; details.push({ id, title: n.title, moved: true }); }
        else { failed++; details.push({ id, moved: false, error: '未找到' }); }
      }
      saveData(); renderNotesList();
      return { success, failed, notebookName: nb.name, details };
    }
  },
  batch_update_notes: {
    desc: '批量更新笔记。{noteIds[], addTags?[], removeTags?[], titlePrefix?, titles?:{"noteId":"新标题"}}',
    run: ({ noteIds, addTags, removeTags, titlePrefix, titles }) => {
      if (!Array.isArray(noteIds) || !noteIds.length) throw new Error('noteIds 必填');
      let success = 0, failed = 0;
      for (const id of noteIds) {
        const n = notes.find(x => x.id === id && !x.deleted);
        if (!n) { failed++; continue; }
        if (titles && typeof titles === 'object' && titles[id]) n.title = String(titles[id]).trim();
        if (Array.isArray(addTags)) { if (!n.tags) n.tags = []; for (const t of addTags) if (!n.tags.includes(t)) n.tags.push(t); }
        if (Array.isArray(removeTags)) { n.tags = (n.tags || []).filter(t => !removeTags.includes(t)); }
        if (titlePrefix && n.title && !n.title.startsWith(titlePrefix)) n.title = titlePrefix + n.title;
        n.updatedAt = Date.now(); success++;
      }
      saveData(); renderNotesList();
      return { success, failed };
    }
  },
  batch_complete_todos: {
    desc: '批量完成待办。{todoIds[]}',
    run: ({ todoIds }) => {
      if (!Array.isArray(todoIds) || !todoIds.length) throw new Error('todoIds 必填');
      let success = 0, failed = 0;
      for (const id of todoIds) {
        const t = todos.find(x => x.id === id);
        if (t && !t.done) { t.done = true; t.completedAt = Date.now(); success++; }
        else { failed++; }
      }
      saveData(); renderTodos(); renderTodoCounts();
      return { success, failed };
    }
  },
  batch_delete_notes: {
    desc: '批量删除笔记。{noteIds[]}',
    run: async ({ noteIds }) => {
      if (!Array.isArray(noteIds) || !noteIds.length) throw new Error('noteIds 必填');
      const fs = typeof fsApi === 'function' ? fsApi() : null;
      const onWorkdir = !!(fs && await fs.hasDir() && window.trash);
      let success = 0, failed = 0;
      const details = [];
      const toRemove = [];
      for (const id of noteIds) {
        const n = notes.find(x => x.id === id && !x.deleted);
        if (!n) { failed++; continue; }
        const title = n.title || '(无标题)';
        if (onWorkdir) {
          // 移入磁盘回收站 + 稍后从活跃列表移除（用真实路径 _srcPath，避免删错）
          const p = n._srcPath || (n.type === 'drawing' ? drawingRelPath(n) : noteRelPath(n));
          try { await window.trash.moveToTrash({ path: p, type: 'note', name: title + (n.type === 'drawing' ? '.excalidraw' : '.md') }); } catch (e) { logError && logError(e, 'trash-batch'); }
          toRemove.push(id);
        } else {
          n.deleted = true; n.updatedAt = Date.now();
        }
        success++; details.push({ id, title });
      }
      if (toRemove.length) { const rm = new Set(toRemove); notes = notes.filter(x => !rm.has(x.id)); }
      saveData(); renderNotesList();
      return { success, failed, details, trashed: onWorkdir };
    }
  },

  // ——— 标签管理 ———
  add_tags: {
    desc: '添加标签。{noteId, tags[]}',
    run: ({ noteId, tags }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      if (!Array.isArray(tags) || !tags.length) throw new Error('tags 必填');
      if (!n.tags) n.tags = [];
      let added = 0;
      for (const t of tags) { if (!n.tags.includes(t)) { n.tags.push(t); added++; } }
      n.updatedAt = Date.now(); saveData(); renderNotesList();
      return { id: n.id, title: n.title, tags: n.tags, added };
    }
  },
  remove_tags: {
    desc: '移除标签。{noteId, tags[]}',
    run: ({ noteId, tags }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      if (!Array.isArray(tags)) throw new Error('tags 必填');
      const before = (n.tags || []).length;
      n.tags = (n.tags || []).filter(t => !tags.includes(t));
      n.updatedAt = Date.now(); saveData(); renderNotesList();
      return { id: n.id, title: n.title, tags: n.tags, removed: before - n.tags.length };
    }
  },
  list_tags: {
    desc: '列出所有标签及数量。无参数',
    run: () => {
      const map = {};
      notes.filter(n => !n.deleted).forEach(n => (n.tags || []).forEach(t => { map[t] = (map[t] || 0) + 1; }));
      return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
    }
  },

  // ——— 实用技能 ———
  daily_briefing: {
    desc: '今日简报。无参数',
    run: () => {
      const now = new Date();
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
      const activeTodos = todos.filter(t => !t.done);
      const todayTodos = activeTodos.filter(t => t.dueDate && t.dueDate >= todayStart.getTime() && t.dueDate <= todayEnd.getTime());
      const overdueTodos = activeTodos.filter(t => t.dueDate && t.dueDate < todayStart.getTime());
      const recentNotes = notes.filter(n => !n.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, _ctxLimit(5, 15, 30)).map(n => ({ id: n.id, title: n.title || '(无标题)', updatedAt: n.updatedAt }));
      const memories = loadMemories().slice(-_ctxLimit(5, 15, 30)).map(m => ({ key: m.key, value: m.value, category: m.category }));
      return {
        date: now.toLocaleDateString('zh-CN'),
        todayTodos: todayTodos.map(t => ({ id: t.id, text: t.text, dueAt: t.dueDate ? new Date(t.dueDate).toISOString() : null })),
        overdueTodos: overdueTodos.map(t => ({ id: t.id, text: t.text, dueAt: t.dueDate ? new Date(t.dueDate).toISOString() : null })),
        pendingCount: activeTodos.length,
        recentNotes,
        memories
      };
    }
  },
  note_stats: {
    desc: '笔记统计。无参数',
    run: () => {
      const active = notes.filter(n => !n.deleted);
      const byNb = {};
      active.forEach(n => {
        const nb = notebooks.find(x => x.id === n.notebookId);
        const name = nb ? nb.name : '(未分类)';
        byNb[name] = (byNb[name] || 0) + 1;
      });
      const tagMap = {};
      active.forEach(n => (n.tags || []).forEach(t => { tagMap[t] = (tagMap[t] || 0) + 1; }));
      const totalChars = active.reduce((s, n) => s + (n.content || '').length, 0);
      const sorted = active.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return {
        totalNotes: active.length,
        totalCharacters: totalChars,
        byNotebook: Object.entries(byNb).map(([name, count]) => ({ name, count })),
        topTags: Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, _ctxLimit(10, 30, 50)).map(([tag, count]) => ({ tag, count })),
        mostRecent: sorted[0] ? { title: sorted[0].title, updatedAt: sorted[0].updatedAt } : null,
        leastRecent: sorted.length > 1 ? { title: sorted[sorted.length - 1].title, updatedAt: sorted[sorted.length - 1].updatedAt } : null,
        totalTodos: todos.length,
        pendingTodos: todos.filter(t => !t.done).length,
        completedTodos: todos.filter(t => t.done).length
      };
    }
  },
  create_from_template: {
    desc: '模板创建笔记。{template:"meeting"|"diary"|"reading"|"weekly", title?, notebookName?}',
    run: ({ template, title, notebookName }) => {
      const templates = {
        meeting: { title: '会议纪要', content: `# 会议纪要\n\n**日期**：${new Date().toLocaleDateString('zh-CN')}\n**参会人**：\n**地点/方式**：\n\n## 议题\n\n1. \n\n## 讨论要点\n\n- \n\n## 决议事项\n\n- [ ] \n\n## 下一步行动\n\n- [ ] ` },
        diary: { title: '日记', content: `# ${new Date().toLocaleDateString('zh-CN')} 日记\n\n## 今日心情\n\n\n\n## 今日要事\n\n- \n\n## 收获与反思\n\n\n\n## 明日计划\n\n- [ ] ` },
        reading: { title: '读书笔记', content: `# 读书笔记\n\n**书名**：\n**作者**：\n**阅读日期**：${new Date().toLocaleDateString('zh-CN')}\n\n## 核心观点\n\n- \n\n## 精彩摘录\n\n> \n\n## 我的思考\n\n\n\n## 行动计划\n\n- [ ] ` },
        weekly: { title: '周报', content: `# 周报 ${new Date().toLocaleDateString('zh-CN')}\n\n## 本周完成\n\n- \n\n## 进行中\n\n- \n\n## 遇到的问题\n\n- \n\n## 下周计划\n\n- [ ] \n\n## 需要协助\n\n- ` }
      };
      const tpl = templates[template];
      if (!tpl) throw new Error('未知模板：' + template + '。可选：meeting / diary / reading / weekly');
      const finalTitle = title || tpl.title + ' ' + new Date().toLocaleDateString('zh-CN');
      let nb = null;
      if (notebookName) nb = notebooks.find(x => x.name === notebookName);
      if (!nb) nb = notebooks[0];
      if (!nb) { nb = { id: uid(), name: '默认', color: '#525252', createdAt: Date.now() }; notebooks.push(nb); }
      const note = { id: uid(), notebookId: nb.id, folderId: null, title: finalTitle, content: tpl.content, tags: [], starred: false, deleted: false, createdAt: Date.now(), updatedAt: Date.now() };
      notes.unshift(note); saveData(); renderNotebooks(); renderNotesList();
      return { id: note.id, title: note.title, template, notebookName: nb.name };
    }
  },
  summarize_note: {
    desc: 'AI总结笔记。{id}',
    run: async ({ id }) => {
      const n = notes.find(x => x.id === id && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      if (!(n.content || '').trim()) throw new Error('笔记内容为空，无法总结');
      const summary = await callAi([
        { role: 'system', content: '你是摘要助手。用中文将给定文本总结为 3-5 个要点，每个要点一行，以 • 开头。仅输出要点，不加前缀标题。' },
        { role: 'user', content: (n.content || '').slice(0, _ctxLimit(4000, 12000, 30000)) }
      ], { stream: false });
      return { id: n.id, title: n.title || '(无标题)', summary };
    }
  },

  // ——— 文件夹管理 ———
  create_folder: {
    desc: '创建文件夹。{name, notebookName?}',
    run: ({ name, notebookName }) => {
      if (!name) throw new Error('name 必填');
      let nb = notebookName ? notebooks.find(x => x.name === notebookName) : notebooks[0];
      if (!nb) throw new Error('笔记本未找到');
      const existing = folders.find(f => f.notebookId === nb.id && f.name === name);
      if (existing) return { id: existing.id, name: existing.name, notebookName: nb.name, existed: true };
      const f = { id: uid(), notebookId: nb.id, name: String(name), createdAt: Date.now() };
      folders.push(f); saveData(); renderNotebooks();
      return { id: f.id, name: f.name, notebookName: nb.name };
    }
  },
  move_note_to_folder: {
    desc: '移动笔记到文件夹。{noteId, folderId?|folderName?}',
    run: ({ noteId, folderId, folderName }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      let f = null;
      if (folderId) f = folders.find(x => x.id === folderId);
      else if (folderName) f = folders.find(x => x.name === folderName && x.notebookId === n.notebookId) || folders.find(x => x.name === folderName);
      if (!f) throw new Error('文件夹未找到：' + (folderName || folderId || '(未指定)'));
      n.folderId = f.id;
      if (f.notebookId !== n.notebookId) n.notebookId = f.notebookId;
      n.updatedAt = Date.now(); saveData(); renderNotesList();
      return { id: n.id, title: n.title, folderId: f.id, folderName: f.name };
    }
  },
  list_todos: {
    desc: '列出待办。{status?"active"|"done"|"all"}默认active',
    run: ({ status } = {}) => {
      const st = status || 'active';
      let pool = st === 'all' ? todos : st === 'done' ? todos.filter(t => t.done) : todos.filter(t => !t.done);
      return pool.slice(0, _ctxLimit(50, 100, 200)).map(t => ({ id: t.id, text: t.text, done: t.done, dueAt: t.dueDate ? new Date(t.dueDate).toISOString() : null, content: (t.content || '').slice(0, _ctxLimit(100, 200, 500)) }));
    }
  },
  complete_todo: {
    desc: '完成待办。{id?或text?模糊匹配}',
    run: ({ id, text }) => {
      let t;
      if (id) t = todos.find(x => x.id === id);
      else if (text) t = todos.filter(x => !x.done).find(x => x.text.includes(text));
      if (!t) throw new Error('未找到待办');
      t.done = true; t.updatedAt = Date.now();
      saveData(); if (typeof renderTodos === 'function') renderTodos();
      return { id: t.id, text: t.text };
    }
  },
  delete_todo: {
    desc: '删除待办。{id?或text?模糊匹配}',
    run: ({ id, text }) => {
      let idx = -1;
      if (id) idx = todos.findIndex(x => x.id === id);
      else if (text) idx = todos.findIndex(x => x.text.includes(text));
      if (idx < 0) throw new Error('未找到待办');
      const removed = todos.splice(idx, 1)[0];
      saveData(); if (typeof renderTodos === 'function') renderTodos();
      return { id: removed.id, text: removed.text };
    }
  },
  batch_delete_todos: {
    desc: '批量删除待办。{todoIds[]}',
    run: ({ todoIds }) => {
      if (!Array.isArray(todoIds) || !todoIds.length) throw new Error('todoIds 必填');
      let success = 0, failed = 0;
      for (const id of todoIds) {
        const idx = todos.findIndex(x => x.id === id);
        if (idx < 0) { failed++; continue; }
        todos.splice(idx, 1); success++;
      }
      saveData(); if (typeof renderTodos === 'function') renderTodos();
      return { success, failed };
    }
  },
  find_note: {
    desc: '搜索并返回笔记全文。{query}一步完成搜索+获取',
    run: ({ query }) => {
      if (!query) throw new Error('query 必填');
      const results = ASSISTANT_TOOLS.search_notes.run({ query, limit: 5 });
      if (!results.length) return { found: false, message: '未找到匹配笔记' };
      const best = results[0];
      const full = notes.find(n => n.id === best.id);
      if (!full) return { found: false, message: '笔记已删除' };
      const nb = notebooks.find(x => x.id === full.notebookId);
      return { found: true, id: full.id, title: full.title, content: (full.content || '').slice(0, _ctxLimit(3000, 10000, 30000)), notebook: nb?.name, tags: full.tags, updatedAt: full.updatedAt, otherResults: results.slice(1).map(r => ({ id: r.id, title: r.title })) };
    }
  },
  quick_note: {
    desc: '快速记笔记(自动提取标题)。{text, notebookName?:按内容选一个合适的笔记本,不存在会自动新建;不传则落入第一个笔记本}',
    run: ({ text, notebookName }) => {
      if (!text || !text.trim()) throw new Error('text 必填');
      const lines = text.trim().split('\n');
      const title = lines[0].slice(0, 50).trim();
      const content = lines.length > 1 ? lines.slice(1).join('\n').trim() : text.trim();
      let nbId = notebooks[0]?.id;
      if (notebookName) {
        let nb = notebooks.find(x => x.name === notebookName);
        // 指定了笔记本名但不存在 → 新建(而非静默落回"随笔")。这样 AI 可按内容归类到合适/新建的笔记本。
        if (!nb) { nb = { id: uid(), name: String(notebookName), color: '#525252', createdAt: Date.now() }; notebooks.push(nb); if (typeof renderNotebooks === 'function') renderNotebooks(); }
        nbId = nb.id;
      }
      const n = { id: uid(), notebookId: nbId, folderId: null, title, content, tags: [], starred: false, deleted: false, createdAt: Date.now(), updatedAt: Date.now() };
      notes.push(n); saveData(); renderNotesList();
      const nbName = (notebooks.find(x => x.id === nbId) || {}).name || '';
      return { id: n.id, title: n.title, notebookName: nbName };
    }
  },
  quick_todo: {
    desc: '快速建待办。{text, dueAt?:ISO8601}',
    run: ({ text, dueAt }) => {
      if (!text || !text.trim()) throw new Error('text 必填');
      const t = { id: uid(), text: text.trim(), content: '', done: false, createdAt: Date.now(), updatedAt: Date.now() };
      if (dueAt) { t.dueDate = new Date(dueAt).getTime(); }
      todos.push(t); saveData(); if (typeof renderTodos === 'function') renderTodos();
      return { id: t.id, text: t.text, dueAt: t.dueDate ? new Date(t.dueDate).toISOString() : null };
    }
  },
  auto_title_notes: {
    desc: '自动给无标题笔记生成标题。{notebookName?, limit?(默认50)}',
    run: ({ notebookName, limit } = {}) => {
      let pool = notes.filter(n => !n.deleted && (!n.title || !n.title.trim()));
      if (notebookName) { const nb = notebooks.find(x => x.name === notebookName); if (nb) pool = pool.filter(n => n.notebookId === nb.id); }
      const max = Math.min(limit || _ctxLimit(50, 100, 200), 300);
      pool = pool.slice(0, max);
      let success = 0;
      const titled = [];
      for (const n of pool) {
        const text = stripMarkdown(n.content || '').trim();
        if (!text) continue;
        const newTitle = text.slice(0, 30).replace(/\n.*/s, '').trim();
        if (!newTitle) continue;
        n.title = newTitle; n.updatedAt = Date.now();
        titled.push({ id: n.id, title: newTitle }); success++;
      }
      if (success) { saveData(); renderNotesList(); }
      return { success, titled };
    }
  },
  list_recent_notes: {
    desc: '最近更新的笔记。{limit?(默认10)}',
    run: ({ limit } = {}) => {
      const max = Math.min(limit || _ctxLimit(10, 20, 50), _ctxLimit(100, 200, 500));
      return notes.filter(n => !n.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, max).map(n => {
        const nb = notebooks.find(x => x.id === n.notebookId);
        return { id: n.id, title: n.title || '(无标题)', notebook: nb?.name, snippet: stripMarkdown(n.content).slice(0, _ctxLimit(80, 200, 400)), updatedAt: n.updatedAt };
      });
    }
  },
  count_notes: {
    desc: '统计笔记数量。{notebookName?, tag?}',
    run: ({ notebookName, tag } = {}) => {
      let pool = notes.filter(n => !n.deleted);
      if (notebookName) { const nb = notebooks.find(x => x.name === notebookName); if (nb) pool = pool.filter(n => n.notebookId === nb.id); }
      if (tag) pool = pool.filter(n => (n.tags || []).includes(tag));
      return { count: pool.length, notebookName: notebookName || '全部', tag: tag || null };
    }
  },
  research: {
    desc: '跨笔记研究总结。{query, limit?(默认5)}搜索多篇笔记提取关键信息+出处',
    run: async ({ query, limit }) => {
      if (!query) throw new Error('query 必填');
      const max = Math.min(limit || _ctxLimit(5, 10, 20), _ctxLimit(30, 50, 100));
      const results = ASSISTANT_TOOLS.search_notes.run({ query, limit: max });
      if (!results.length) return { found: 0, summary: '未找到相关笔记', sources: [] };
      const sources = [];
      let combined = '';
      for (const r of results) {
        const n = notes.find(x => x.id === r.id);
        if (!n) continue;
        const content = (n.content || '').slice(0, _ctxLimit(2000, 8000, 20000));
        const nb = notebooks.find(x => x.id === n.notebookId);
        sources.push({ id: n.id, title: n.title || '(无标题)', notebook: nb?.name });
        combined += `\n\n【${n.title || '无标题'}】\n${content}`;
      }
      const summary = await callAi([
        { role: 'system', content: '你是研究助手。根据以下多篇笔记内容，针对用户的查询提取关键信息并总结。用Markdown格式：先总结要点，再分条列出关键信息。简洁直接。' },
        { role: 'user', content: `查询：${query}\n\n相关笔记：${combined.slice(0, _ctxLimit(8000, 24000, 60000))}` }
      ], { stream: false });
      return { found: sources.length, summary, sources };
    }
  },

  // ——— 翻译 & 提取 ———
  translate: {
    desc: 'AI翻译文本。{text, to?"en"|"zh"|"ja"|"ko"|"fr"|"de"}',
    run: async ({ text, to }) => {
      if (!text) throw new Error('text 必填');
      const lang = { en: '英文', zh: '中文', ja: '日文', ko: '韩文', fr: '法文', de: '德文' }[to || 'en'] || to || '英文';
      const result = await callAi([
        { role: 'system', content: `你是翻译助手。将用户的文本翻译为${lang}，仅输出翻译结果。` },
        { role: 'user', content: text.slice(0, _ctxLimit(4000, 12000, 30000)) }
      ], { stream: false });
      return { translated: result, targetLang: lang };
    }
  },
  extract_keywords: {
    desc: 'AI提取关键词。{text?或noteId?}',
    run: async ({ text, noteId }) => {
      let src = text;
      if (!src && noteId) { const n = notes.find(x => x.id === noteId && !x.deleted); if (n) src = (n.title || '') + '\n' + (n.content || ''); }
      if (!src || !src.trim()) throw new Error('text 或 noteId 必填');
      const result = await callAi([
        { role: 'system', content: '提取5-10个关键词，用逗号分隔，仅输出关键词。' },
        { role: 'user', content: src.slice(0, _ctxLimit(3000, 10000, 30000)) }
      ], { stream: false });
      return { keywords: result.split(/[,，、\s]+/).filter(Boolean) };
    }
  },
  translate_note: {
    desc: '翻译笔记并保存为新笔记。{noteId, to?"en"|"zh"}',
    run: async ({ noteId, to }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      const lang = { en: '英文', zh: '中文', ja: '日文', ko: '韩文' }[to || 'en'] || to || '英文';
      const translated = await callAi([
        { role: 'system', content: `翻译为${lang}，保持Markdown格式，仅输出翻译。` },
        { role: 'user', content: (n.content || '').slice(0, _ctxLimit(6000, 20000, 50000)) }
      ], { stream: false });
      const titleTr = await callAi([
        { role: 'system', content: `翻译为${lang}，仅输出翻译。` },
        { role: 'user', content: n.title || '无标题' }
      ], { stream: false });
      const newNote = { id: uid(), notebookId: n.notebookId, folderId: n.folderId, title: titleTr.trim(), content: translated, tags: [...(n.tags || []), lang], starred: false, deleted: false, createdAt: Date.now(), updatedAt: Date.now() };
      notes.unshift(newNote); saveData(); renderNotesList();
      return { id: newNote.id, title: newNote.title, originalTitle: n.title, lang };
    }
  },

  // ——— 笔记增强 ———
  append_to_note: {
    desc: '追加内容到笔记末尾。{noteId?或noteTitle?, text}',
    run: ({ noteId, noteTitle, text }) => {
      if (!text) throw new Error('text 必填');
      let n;
      if (noteId) n = notes.find(x => x.id === noteId && !x.deleted);
      else if (noteTitle) n = notes.find(x => !x.deleted && (x.title || '').includes(noteTitle));
      if (!n) throw new Error('笔记未找到');
      n.content = (n.content || '') + '\n\n' + text;
      n.updatedAt = Date.now(); saveData(); renderNotesList();
      return { id: n.id, title: n.title, appended: text.length };
    }
  },
  duplicate_note: {
    desc: '复制笔记。{noteId, newTitle?}',
    run: ({ noteId, newTitle }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      const copy = { id: uid(), notebookId: n.notebookId, folderId: n.folderId, title: newTitle || (n.title || '无标题') + ' (副本)', content: n.content || '', tags: [...(n.tags || [])], starred: false, deleted: false, createdAt: Date.now(), updatedAt: Date.now() };
      notes.unshift(copy); saveData(); renderNotesList();
      return { id: copy.id, title: copy.title, originalId: n.id };
    }
  },
  merge_notes: {
    desc: '合并多篇笔记为一篇。{noteIds[], newTitle?, deleteOriginals?}',
    run: ({ noteIds, newTitle, deleteOriginals }) => {
      if (!Array.isArray(noteIds) || noteIds.length < 2) throw new Error('至少选择2篇笔记');
      const found = noteIds.map(id => notes.find(x => x.id === id && !x.deleted)).filter(Boolean);
      if (found.length < 2) throw new Error('有效笔记不足2篇');
      const merged = found.map(n => `## ${n.title || '无标题'}\n\n${n.content || ''}`).join('\n\n---\n\n');
      const title = newTitle || found.map(n => n.title || '无标题').join(' + ');
      const allTags = [...new Set(found.flatMap(n => n.tags || []))];
      const newNote = { id: uid(), notebookId: found[0].notebookId, folderId: null, title, content: merged, tags: allTags, starred: false, deleted: false, createdAt: Date.now(), updatedAt: Date.now() };
      notes.unshift(newNote);
      if (deleteOriginals) found.forEach(n => { n.deleted = true; n.updatedAt = Date.now(); });
      saveData(); renderNotesList();
      return { id: newNote.id, title: newNote.title, mergedCount: found.length, deletedOriginals: !!deleteOriginals };
    }
  },
  star_note: {
    desc: '收藏/取消收藏笔记。{noteId, starred?}不传starred则切换',
    run: ({ noteId, starred }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      n.starred = typeof starred === 'boolean' ? starred : !n.starred;
      n.updatedAt = Date.now(); saveData(); renderNotesList();
      return { id: n.id, title: n.title, starred: n.starred };
    }
  },
  list_starred: {
    desc: '列出收藏笔记。无参数',
    run: () => {
      return notes.filter(n => !n.deleted && n.starred).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, _ctxLimit(30, 80, 200)).map(n => {
        const nb = notebooks.find(x => x.id === n.notebookId);
        return { id: n.id, title: n.title || '(无标题)', notebook: nb?.name, updatedAt: n.updatedAt };
      });
    }
  },
  word_count: {
    desc: '统计笔记字数。{noteId?}不传统计全部',
    run: ({ noteId } = {}) => {
      if (noteId) {
        const n = notes.find(x => x.id === noteId && !x.deleted);
        if (!n) throw new Error('笔记未找到');
        const text = stripMarkdown(n.content || '');
        return { noteId: n.id, title: n.title, chars: text.length, words: text.split(/\s+/).filter(Boolean).length };
      }
      const active = notes.filter(n => !n.deleted);
      const totalChars = active.reduce((s, n) => s + stripMarkdown(n.content || '').length, 0);
      return { totalNotes: active.length, totalChars };
    }
  },
  clean_text: {
    desc: 'AI清理文本（去冗余/格式化）。{noteId}',
    run: async ({ noteId }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      if (!(n.content || '').trim()) throw new Error('笔记内容为空');
      const cleaned = await callAi([
        { role: 'system', content: '清理以下文本：去除冗余、修正格式、保持原意、输出Markdown。仅输出结果。' },
        { role: 'user', content: (n.content || '').slice(0, _ctxLimit(6000, 20000, 50000)) }
      ], { stream: false });
      n.content = cleaned; n.updatedAt = Date.now(); saveData(); renderNotesList();
      return { id: n.id, title: n.title, cleaned: true };
    }
  },
  export_note: {
    desc: '导出笔记为文本。{noteId}返回完整Markdown',
    run: ({ noteId }) => {
      const n = notes.find(x => x.id === noteId && !x.deleted);
      if (!n) throw new Error('笔记未找到');
      const nb = notebooks.find(x => x.id === n.notebookId);
      const meta = `---\ntitle: ${n.title || '无标题'}\nnotebook: ${nb?.name || ''}\ntags: ${(n.tags || []).join(', ')}\ndate: ${new Date(n.updatedAt || n.createdAt).toISOString()}\n---\n\n`;
      return { id: n.id, title: n.title, markdown: meta + (n.content || '') };
    }
  },

  // ——— 番茄钟 ———
  pomodoro: {
    desc: '番茄钟计时。{action:"start"|"stop"|"status", minutes?(默认25), task?}',
    run: ({ action, minutes, task }) => {
      const key = 'marginote.pomodoro';
      const now = Date.now();
      if (action === 'start') {
        const dur = Math.max(1, Math.min(120, parseInt(minutes, 10) || 25));
        const pom = { task: task || '专注工作', startedAt: now, duration: dur, endAt: now + dur * 60000 };
        localStorage.setItem(key, JSON.stringify(pom));
        return { started: true, task: pom.task, duration: dur, endAt: new Date(pom.endAt).toLocaleTimeString('zh-CN') };
      }
      if (action === 'stop') {
        const raw = localStorage.getItem(key);
        localStorage.removeItem(key);
        if (!raw) return { stopped: true, message: '没有进行中的番茄钟' };
        const pom = JSON.parse(raw);
        const elapsed = Math.round((now - pom.startedAt) / 60000);
        return { stopped: true, task: pom.task, elapsed, completed: now >= pom.endAt };
      }
      // status
      const raw = localStorage.getItem(key);
      if (!raw) return { active: false };
      const pom = JSON.parse(raw);
      const remaining = Math.max(0, Math.round((pom.endAt - now) / 60000));
      return { active: true, task: pom.task, remaining, completed: remaining === 0 };
    }
  }
};

// ===================== Sub-Agent 子任务引擎 =====================

async function runSubAgent(step, stepIndex, totalSteps) {
  const subTools = Object.entries(ASSISTANT_TOOLS)
    .filter(([n]) => n !== 'sub_agent')
    .map(([n, t]) => `${n}:${t.desc}`)
    .join('\n');

  const activeNotes = notes.filter(n => !n.deleted);
  const sysPrompt = `你是Marginote子任务执行器。直接执行指定任务，不要询问。
笔记本${notebooks.length} 笔记${activeNotes.length} 待办${todos.length}
工具:\n${subTools}
协议:仅输出JSON{"reply":"结果","actions":[{"tool":"名","args":{}}]}
无工具时actions=[]。相互独立的工具可一轮并列多个;有依赖的分多轮。任何问题先search_notes搜索。`;

  const ctx = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `子任务${stepIndex + 1}/${totalSteps}: ${step.task}${step.context ? '\n上下文: ' + step.context : ''}` }
  ];

  let result = { reply: '', toolResults: [] };
  let iter = 0;
  while (iter++ < _ctxLimit(8, 15, 20)) {
    let raw;
    try {
      raw = await callAi(ctx, { temperature: 0.2, stream: false });
    } catch (e) {
      result.reply = '子任务执行错误: ' + (e.message || e);
      break;
    }
    const parsed = parseAssistantReply(raw);
    if (parsed.reply) result.reply = parsed.reply;

    if (!parsed.actions || !parsed.actions.length) break;

    for (const a of parsed.actions) {
      const name = a.tool || a.name;
      const args = a.args || a.arguments || {};
      try {
        const toolResult = await runAssistantTool(name, args);
        const resultStr = JSON.stringify(toolResult).slice(0, _ctxLimit(1200, 5000, 16000));
        result.toolResults.push({ tool: name, summary: summarizeActionResult(name, toolResult) });
        ctx.push({ role: 'assistant', content: raw });
        ctx.push({ role: 'user', content: '工具结果:' + name + ':' + resultStr });
      } catch (e) {
        result.toolResults.push({ tool: name, error: e.message || String(e) });
        ctx.push({ role: 'assistant', content: raw });
        ctx.push({ role: 'user', content: '工具错误:' + name + ':' + (e.message || e) });
      }
    }
  }
  return result;
}

// 注册 sub_agent 工具
ASSISTANT_TOOLS.sub_agent = {
  desc: '拆解复杂任务为子步骤独立执行。{steps:[{task:"描述",context?"上下文"}],summary?"汇总说明"}',
  run: async ({ steps, summary }) => {
    if (!Array.isArray(steps) || !steps.length) throw new Error('steps 必填');
    if (steps.length > 20) throw new Error('子任务最多20个');
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const r = await runSubAgent(step, i, steps.length);
      results.push({ step: step.task, reply: r.reply, actions: r.toolResults });
    }
    return { completed: results.length, summary: summary || '子任务全部执行完毕', results };
  }
};

function buildAssistantSystemPrompt() {
  const now = new Date();
  const toolEntries = Object.entries(ASSISTANT_TOOLS);
  const toolGroups = {
    '查询': ['search_notes','search_todos','find_note','get_note','get_todo','list_notebooks','list_tags','list_todos','list_recent_notes','list_starred','count_notes','word_count'],
    '创建': ['create_note','create_todo','quick_note','quick_todo','create_notebook','create_folder','create_from_template'],
    '修改': ['update_note','update_todo','rename_notebook','move_note','move_note_to_folder','add_tags','remove_tags','star_note','append_to_note'],
    '批量': ['batch_move_notes','batch_update_notes','batch_complete_todos','batch_delete_notes','batch_delete_todos','auto_title_notes','merge_notes'],
    '删除': ['delete_note','delete_notebook','delete_todo','duplicate_note','export_note'],
    'AI': ['optimize_text','summarize_note','research','translate','translate_note','extract_keywords','clean_text'],
    '记忆': ['save_memory','recall_memory','delete_memory'],
    '效率': ['daily_briefing','note_stats','pomodoro','sub_agent']
  };
  let tools = '';
  for (const [group, names] of Object.entries(toolGroups)) {
    const items = names.map(n => { const t = ASSISTANT_TOOLS[n]; return t ? `${n}:${t.desc}` : null; }).filter(Boolean);
    if (items.length) tools += `[${group}] ${items.join(' | ')}\n`;
  }
  const ungrouped = toolEntries.filter(([n]) => !Object.values(toolGroups).flat().includes(n));
  if (ungrouped.length) tools += ungrouped.map(([n, t]) => `${n}:${t.desc}`).join(' | ');

  let attachInfo = '';
  if (pendingAttachments.length) {
    const parts = [];
    let imgCount = 0;
    for (const a of pendingAttachments) {
      if (a.type === 'note') { const n = notes.find(x => x.id === a.id); if (n) parts.push(`[笔记:id=${n.id},${n.title || '无标题'},${(n.content || '').slice(0, _ctxLimit(1500, 5000, 16000))}]`); }
      else if (a.type === 'todo') { const t = todos.find(x => x.id === a.id); if (t) parts.push(`[待办:id=${t.id},${t.text},${t.done?'完成':'未完成'}${t.dueDate?',截止'+new Date(t.dueDate).toISOString():''}]`); }
      else if (a.type === 'image') { imgCount++; }
    }
    if (imgCount) parts.push(`[图片${imgCount}张,在最后消息image_url中]`);
    if (parts.length) { attachInfo = '\n附件:' + parts.join(';') + '\n修改附件用update_note/update_todo,不传id自动匹配附件'; }
  }

  const activeNotes = notes.filter(n => !n.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  let noteIndex = '';
  if (activeNotes.length) {
    // 笔记索引是【每轮都重发】的常驻开销,不随上下文放大(否则 128K 时会膨胀到数百条×数百字、单独吃掉
    // ~20% 窗口)。这里硬性封顶:最多 150 条标题、每条摘要 ≤120 字;需要更多细节让模型 search_notes 检索。
    const top = activeNotes.slice(0, Math.min(_ctxLimit(20, 150, 150), 150));
    noteIndex = '\n\n笔记(' + activeNotes.length + '篇,近' + top.length + '篇,含 id 可直接操作):\n';
    noteIndex += top.map((n, i) => {
      const nb = notebooks.find(x => x.id === n.notebookId);
      const summary = stripMarkdown(n.content).slice(0, Math.min(_ctxLimit(40, 80, 120), 120));
      return `${i + 1}.(id:${n.id})${n.title || '无标题'}${nb ? '[' + nb.name + ']' : ''}${summary ? '—' + summary : ''}`;
    }).join('\n');
  }

  const activeTodos = todos.filter(t => !t.done);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const todayTodos = activeTodos.filter(t => t.dueDate && t.dueDate >= todayStart.getTime() && t.dueDate <= todayEnd.getTime());
  const overdueTodos = activeTodos.filter(t => t.dueDate && t.dueDate < todayStart.getTime());
  let todoOverview = '';
  if (todos.length) {
    todoOverview = '\n\n待办:未完成' + activeTodos.length + '条';
    if (todayTodos.length) todoOverview += ',今日' + todayTodos.length + '条';
    if (overdueTodos.length) todoOverview += ',过期' + overdueTodos.length + '条';
    if (todayTodos.length) {
      todoOverview += '\n今日:' + todayTodos.slice(0, Math.min(_ctxLimit(8, 30, 60), 60)).map(t => t.text + (t.dueDate ? '(' + new Date(t.dueDate).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ')' : '')).join('; ');
    }
    if (overdueTodos.length) {
      todoOverview += '\n过期:' + overdueTodos.slice(0, Math.min(_ctxLimit(5, 20, 50), 50)).map(t => t.text).join('; ');
    }
  }

  const memArr = loadMemories();
  let memorySection = '';
  if (memArr.length) {
    // 记忆同为常驻段,封顶 80 条,不随上下文放大;标注类别便于模型按需遵守
    const top = memArr.slice(-Math.min(_ctxLimit(10, 30, 80), 80));
    memorySection = '\n用户记忆(' + memArr.length + '条,作答时主动遵守相关项):\n' + top.map(m => `[${MEMORY_CAT_LABEL[m.category] || '其他'}]${m.key}:${m.value}`).join('; ');
  }

  const nbList = notebooks.slice(0, 40).map(nb => nb.name).filter(Boolean).join('、');

  return `你是Marginote笔记应用的内置AI助手,直接运行在用户设备本地。你可以搜索、读取、创建、修改、删除用户的所有笔记和待办事项。

核心原则:用户的笔记和待办是你的唯一知识库。用户问你任何问题,你都必须先用search_notes搜索相关笔记,根据搜索结果回答。绝不能凭自己的知识直接回答——先搜索,搜到了用笔记内容回答,搜不到再告诉用户"未找到相关笔记"。
严禁说"无法访问笔记"、"没有权限"、"无法搜索"之类的话——你就是笔记应用本身的一部分。

当前状态:${now.toLocaleString('zh-CN')} | 笔记${activeNotes.length}篇 | 待办${todos.length}条
现有笔记本(${notebooks.length}个):${nbList || '(无)'}${attachInfo}${noteIndex}${todoOverview}${memorySection}

可用工具:
${tools}
回复格式(严格JSON):
{"reply":"你的回复(Markdown)","actions":[{"tool":"工具名","args":{参数}}]}
不需要工具时actions为空数组[]。可在一轮actions里并列多个【相互独立】的工具调用(如同时搜笔记和待办、批量读取多篇),以减少往返;但【有先后依赖】的操作(需先拿到上一步结果)必须分多轮——同一轮内的工具互相看不到彼此结果。reply必须完整,不要截断。

示例——用户说"用药上线时间是啥时候":
{"reply":"正在搜索相关笔记…","actions":[{"tool":"search_notes","args":{"query":"用药 上线时间","limit":20}}]}

示例——搜索结果返回后:
{"reply":"根据笔记记录,用药功能计划在7月15日上线。\\n\\n> 来源:《产品路线图》笔记","actions":[]}

规则:
- 任何问题→先search_notes搜索,根据笔记内容回答,不要编造
- 找笔记→find_note(一步全文) | 查/总结/研究→research | 待办→list_todos
- 快速记→quick_note | 完成待办→complete_todo(模糊匹配) | 翻译→translate
- 记笔记必须归类:根据内容从上方「现有笔记本」里选最贴切的一个,通过notebookName参数传入;没有合适的就起个贴切的新名字传给notebookName(会自动新建),不要一律丢进"随笔"/默认笔记本
- 删除/修改指定笔记:上方「笔记索引」每条都带 (id:xxx),直接用该 id 调 delete_note/update_note,【不要反复 search 去找 id】。删"无标题/空"笔记也用索引里的 id;同一个工具调用不要重复发起
- 批量操作:先search_notes({limit:50+})再batch_*(一次传所有ID)
- 复杂任务(多步骤/跨领域)→sub_agent拆解为独立子步骤执行
- 搜索无果→换关键词重试
- 【严禁口头假装完成】要创建/保存/删除/修改,必须在本次 actions 里真的发出对应工具调用;绝不能在没有工具调用的情况下声称"已创建/已保存/已记录"。正确做法:先发出工具调用,拿到工具结果后,下一轮再据结果告知用户是否成功
- 判断笔记/笔记本是否存在,一律以当前「现有笔记本」列表和实际 list_notebooks/search_notes 结果为准;不要因为之前对话里说过"已删除"就断定它不存在——磁盘扫描导入等操作可能让它重新出现,用户让你删就直接尝试删
- 记忆:用户透露持久偏好/习惯/关于自己的事实/项目背景时,主动save_memory记住(value简洁,选对category);回答涉及个人偏好的问题前,先看上方「用户记忆」,不足再recall_memory;过时的用save_memory覆盖同名key或delete_memory删除
- 回复用Markdown,简洁直接,不要废话`;
}

// ===================== 渲染 =====================

function parseAssistantReply(raw) {
  if (!raw) return { reply: '', actions: [] };
  // 先剥离推理模型思维链（流式对话不经 parseAiResponse，必须在此兜底，否则 <think> 里的花括号
  // 会让下面按 first{…last} 截取 JSON 失败、甚至把思考当回复显示）
  if (typeof stripThinking === 'function') raw = stripThinking(raw);
  if (!raw) return { reply: '', actions: [] };
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(s);
    // 解析成功但不是 {reply,actions} 信封（例如截到的是工具调用里的裸 args 对象）→ 回退抢救
    if (typeof obj.reply !== 'string' && !Array.isArray(obj.actions)) {
      const salv = salvageToolCalls(raw);
      if (salv.length) return { reply: '', actions: salv };
    }
    return { reply: typeof obj.reply === 'string' ? obj.reply : '', actions: Array.isArray(obj.actions) ? obj.actions : [] };
  }
  catch {
    const m = raw.match(/"reply"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
    if (m) {
      let reply = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const am = raw.match(/"actions"\s*:\s*(\[[\s\S]*?\])/);
      let actions = [];
      if (am) { try { actions = JSON.parse(am[1]); } catch {} }
      if (!actions.length) actions = salvageToolCalls(raw);
      return { reply, actions };
    }
    // 抢救非标准格式（如 minimax 的 `minimax:tool_call` + 裸 `["tool": "x", "args": {...}]`，
    // 这类输出既不是合法 JSON 信封、也没有 "reply" 字段，旧逻辑会把整段原文当最终回复显示、
    // 导致工具根本不执行）。能抢救到工具调用就只回 actions，丢弃噪声文本。
    const salvaged = salvageToolCalls(raw);
    if (salvaged.length) return { reply: '', actions: salvaged };
    return { reply: raw, actions: [] };
  }
}

// 从任意文本中抢救工具调用：扫描所有 "tool":"名" 片段，并就近提取其后的 "args":{...}
// （用花括号配平来容忍后面跟着的非法字符）。容忍 minimax 等模型的非标准 tool-call 包裹。
function salvageToolCalls(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  const re = /["']?(?:tool|name)["']?\s*:\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g;
  let m;
  while ((m = re.exec(raw))) {
    const tool = m[1];
    if (!ASSISTANT_TOOLS[tool]) continue;          // 只认识真实工具名，避免误伤
    let args = {};
    const rest = raw.slice(re.lastIndex);
    const am = rest.match(/["']?(?:args|arguments)["']?\s*:\s*(\{)/);
    if (am) {
      const start = rest.indexOf('{', am.index);
      let depth = 0, end = -1;
      for (let i = start; i < rest.length; i++) {
        const c = rest[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > start) { try { args = JSON.parse(rest.slice(start, end + 1)); } catch {} }
    }
    out.push({ tool, args });
  }
  return out;
}

async function runAssistantTool(name, args) {
  const t = ASSISTANT_TOOLS[name];
  if (!t) throw new Error('未知工具：' + name);
  return await t.run(args || {});
}

function renderAssistantChat() {
  const box = document.getElementById('assistantChat');
  if (!box) return;
  const s = getActiveSession();
  if (!s || !s.messages.length) {
    box.innerHTML = `<div class="assistant-empty"><div>问我点什么吧 👋</div><div class="examples"><ul style="list-style:none; padding:0;"><li data-ex="帮我新建一个待办「查阅机票」，明天15:00完成，提前2小时提醒">· 帮我新建一个待办「查阅机票」，明天15:00完成，提前2小时提醒</li><li data-ex="查一下和「旅游攻略」相关的笔记">· 查一下和「旅游攻略」相关的笔记</li><li data-ex="新建一篇笔记「会议纪要」，内容写：今天讨论了 Q3 路线图。">· 新建一篇笔记「会议纪要」，内容写：今天讨论了 Q3 路线图</li><li data-ex="列出所有未完成的待办">· 列出所有未完成的待办</li></ul></div></div>`;
    box.querySelectorAll('.examples li').forEach(li => {
      li.addEventListener('click', () => { document.getElementById('assistantInput').value = li.dataset.ex || ''; document.getElementById('assistantInput').focus(); });
    });
    return;
  }
  box.innerHTML = s.messages.map(m => renderAssistantMessage(m)).join('');
  box.querySelectorAll('.result-item[data-note-id]').forEach(el => {
    el.addEventListener('click', () => { const n = notes.find(x => x.id === el.dataset.noteId); if (n) { hideAssistantPanel(); selectNote(n); } });
  });
  box.querySelectorAll('.assistant-receipt-open[data-target-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.targetId;
      if (btn.dataset.targetType === 'note') {
        const n = notes.find(x => x.id === id && !x.deleted);
        if (n) { hideAssistantPanel(); selectNote(n); }
      } else if (btn.dataset.targetType === 'todo') {
        const t = todos.find(x => x.id === id);
        if (t) { hideAssistantPanel(); switchView(t.done ? 'todo:done' : 'todo:active'); selectTodo(t); }
      }
    });
  });
  box.scrollTop = box.scrollHeight;
}

function renderAssistantMessage(m) {
  const role = m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'bot');
  const roleLabel = m.role === 'user' ? '我' : (m.role === 'system' ? '工具' : 'AI');
  const bubbleContent = role === 'bot' && m.content && typeof renderMarkdown === 'function'
    ? renderMarkdown(m.content)
    : escapeHtml(m.content || '');
  let html = `<div class="assistant-msg ${role}"><span class="role">${roleLabel}</span><div class="bubble">`;
  const receipts = (m.toolLog || []).filter(t => t.isWrite);
  if (receipts.length) {
    html += '<div class="assistant-receipts">';
    for (const t of receipts) {
      const targetButton = t.ok && t.targetType && t.targetId
        ? `<button class="assistant-receipt-open" data-target-type="${escapeHtml(t.targetType)}" data-target-id="${escapeHtml(t.targetId)}">打开${t.targetType === 'note' ? '笔记' : '待办'}</button>`
        : '';
      html += `<div class="assistant-receipt ${t.ok ? 'ok' : 'err'}"><span class="assistant-receipt-icon">${t.ok ? '✓' : '!'}</span><span class="assistant-receipt-text">${escapeHtml(t.ok ? (t.summary || '操作已完成') : ('写入失败：' + (t.summary || t.tool)))}</span>${targetButton}</div>`;
    }
    html += '</div>';
  }
  // 工具执行过程（新格式：折叠展示）
  if (m.toolLog && m.toolLog.length) {
    const okCount = m.toolLog.filter(t => t.ok).length;
    const errCount = m.toolLog.length - okCount;
    const summaryText = `执行过程 (${m.toolLog.length} 步${errCount ? '，' + errCount + ' 失败' : ''})`;
    html += `<details class="tool-exec-log"><summary>${escapeHtml(summaryText)}</summary><div class="tool-steps">`;
    for (const t of m.toolLog) { html += `<div class="tool-step ${t.ok ? 'ok' : 'err'}">${t.ok ? '✓' : '✗'} ${escapeHtml(t.tool)}: ${escapeHtml(t.summary || '')}</div>`; }
    html += '</div></details>';
  }
  html += bubbleContent + '</div>';
  if (m.attachments && m.attachments.length) {
    html += '<div class="msg-attachments">';
    for (const a of m.attachments) {
      if (a.type === 'image') {
        // 尝试从 pendingAttachments 中找回 dataUrl 显示大图
        const matchedImg = typeof pendingAttachments !== 'undefined' ? pendingAttachments.find(p => p.type === 'image' && p.name === a.title) : null;
        if (matchedImg && matchedImg.dataUrl) {
          html += '<div class="msg-image-attach" style="margin-top:6px; max-width:120px;"><img src="' + matchedImg.dataUrl + '" data-full-img="' + matchedImg.dataUrl + '" class="chat-img-preview" style="width:100%; max-height:80px; object-fit:cover; border-radius:6px; border:1px solid var(--rule-soft); cursor:zoom-in;" title="点击放大查看"></div>';
        } else {
          html += '<span class="msg-attach-pill" title="图片附件: ' + escapeHtml(a.title || '图片') + '"><span class="attach-type-badge image">图片</span>' + escapeHtml(String(a.title || '图片').slice(0, 30)) + '</span>';
        }
        continue;
      }
      const badge = a.type === 'note' ? '<span class="attach-type-badge note">md</span>' : '<span class="attach-type-badge todo">✓</span>';
      const title = a.title || '';
      html += `<span class="msg-attach-pill" title="${escapeHtml(a.type === 'note' ? '笔记' : '待办')}: ${escapeHtml(title)}">${badge}${escapeHtml(title.slice(0, 30))}</span>`;
    }
    html += '</div>';
  }
  if (m.actions && m.actions.length) {
    html += '<div class="actions">';
    for (const a of m.actions) { const cls = a.error ? 'err' : 'ok'; const label = a.error ? `${a.tool} ✗ ${a.error}` : `${a.tool} ✓ ${a.summary || ''}`; html += `<span class="action-pill ${cls}">${escapeHtml(label)}</span>`; }
    html += '</div>';
  }
  if (m.searchResults && m.searchResults.length) {
    html += '<div class="result-list">';
    for (const r of m.searchResults) { const meta = r.dueAt ? `截止 ${formatFullDate(new Date(r.dueAt).getTime())}` : (r.updatedAt ? `更新 ${formatFullDate(r.updatedAt)}` : ''); const dataAttr = r.kind === 'note' ? `data-note-id="${escapeHtml(r.id)}"` : ''; const title = r.title || r.text || '(无标题)'; html += `<div class="result-item" ${dataAttr}><div class="title">${escapeHtml(title)}</div>${r.snippet ? `<div class="meta">${escapeHtml(r.snippet)}</div>` : ''}${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}</div>`; }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function pushAssistantMessage(role, content, extra) {
  const s = getActiveSession();
  if (!s) return;
  const m = { role, content: String(content || ''), ts: Date.now() };
  if (extra) Object.assign(m, extra);
  s.messages.push(m);
  saveAssistantGroups();
  renderAssistantChat();
  if (assistantInAiView) renderAssistantSessions();
  return m;
}

function setAssistantTyping(on, stepInfo) {
  const box = document.getElementById('assistantChat');
  if (!box) return;
  if (!on) { box.querySelectorAll('.assistant-typing-msg').forEach(el => el.remove()); return; }
  const info = stepInfo || '思考中…';
  // 流式期间 onDelta 高频调用：已有气泡就只更新提示文字，避免每个 token 重建整段 DOM 造成抖动
  const existing = box.querySelector('.assistant-typing-msg .assistant-typing-hint');
  if (existing) { existing.innerHTML = info; box.scrollTop = box.scrollHeight; return; }
  box.querySelectorAll('.assistant-typing-msg').forEach(el => el.remove());
  const div = document.createElement('div');
  div.className = 'assistant-msg bot assistant-typing-msg';
  div.innerHTML = `<span class="role">AI</span><div class="bubble"><span class="assistant-typing"><span></span><span></span><span></span></span> <span class="assistant-typing-hint" style="color:var(--ink-mute);font-size:11px;">${info}</span></div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function summarizeActionResult(name, result) {
  if (!result) return '';
  if (name === 'create_note') return `笔记「${result.title || ''}」已创建`;
  if (name === 'create_todo') return `待办「${result.text || ''}」${result.dueAt ? ' · ' + formatFullDate(new Date(result.dueAt).getTime()) : ''}`;
  if (name === 'update_note') return `笔记「${result.title || ''}」已更新`;
  if (name === 'update_todo') return `待办「${result.text || ''}」已更新`;
  if (name === 'list_notebooks') return `${(result || []).length} 个笔记本`;
  if (name === 'search_notes') return `${(result || []).length} 篇笔记`;
  if (name === 'search_todos') return `${(result || []).length} 条待办`;
  if (name === 'create_notebook') return `笔记本「${result.name || ''}」${result.existed ? '已存在' : '已创建'}`;
  if (name === 'rename_notebook') return `笔记本「${result.oldName || ''}」→「${result.newName || ''}」`;
  if (name === 'delete_notebook') return `笔记本「${result.deleted || ''}」已删除，${result.movedCount || 0} 篇笔记移至「${result.movedNotesTo || ''}」`;
  if (name === 'move_note') return `笔记「${result.title || ''}」已移至「${result.notebookName || ''}」`;
  if (name === 'delete_note') return `笔记「${result.title || ''}」已删除`;
  if (name === 'get_note') return `笔记「${result.title || ''}」内容已获取`;
  if (name === 'get_todo') return `待办「${result.text || ''}」详情已获取`;
  if (name === 'optimize_text') return `已优化文本`;
  if (name === 'save_memory') return `记忆「${result.key || ''}」已保存`;
  if (name === 'recall_memory') return `${(result || []).length} 条记忆`;
  if (name === 'delete_memory') return `记忆${result.deleted ? '已删除' : '未找到'}`;
  if (name === 'batch_move_notes') return `${result.success || 0} 篇笔记已移至「${result.notebookName || ''}」`;
  if (name === 'batch_update_notes') return `${result.success || 0} 篇笔记已更新`;
  if (name === 'batch_complete_todos') return `${result.success || 0} 条待办已完成`;
  if (name === 'batch_delete_notes') return `${result.success || 0} 篇笔记已删除`;
  if (name === 'add_tags') return `笔记「${result.title || ''}」添加 ${result.added || 0} 个标签`;
  if (name === 'remove_tags') return `笔记「${result.title || ''}」移除 ${result.removed || 0} 个标签`;
  if (name === 'list_tags') return `${(result || []).length} 个标签`;
  if (name === 'daily_briefing') return `今日简报已生成`;
  if (name === 'note_stats') return `统计：${result.totalNotes || 0} 篇笔记 / ${result.totalCharacters || 0} 字`;
  if (name === 'create_from_template') return `从${result.template || ''}模板创建「${result.title || ''}」`;
  if (name === 'summarize_note') return `笔记「${result.title || ''}」摘要已生成`;
  if (name === 'create_folder') return `文件夹「${result.name || ''}」${result.existed ? '已存在' : '已创建'}`;
  if (name === 'move_note_to_folder') return `笔记「${result.title || ''}」已移入「${result.folderName || ''}」`;
  if (name === 'list_todos') return `${(result || []).length} 条待办`;
  if (name === 'complete_todo') return `待办「${result.text || ''}」已完成`;
  if (name === 'delete_todo') return `待办「${result.text || ''}」已删除`;
  if (name === 'batch_delete_todos') return `${result.success || 0} 条待办已删除`;
  if (name === 'find_note') return result.found ? `找到笔记「${result.title || ''}」` : '未找到匹配笔记';
  if (name === 'quick_note') return `快速笔记「${result.title || ''}」已创建`;
  if (name === 'quick_todo') return `待办「${result.text || ''}」已创建`;
  if (name === 'auto_title_notes') return `${result.success || 0} 篇无标题笔记已自动命名`;
  if (name === 'list_recent_notes') return `${(result || []).length} 篇最近笔记`;
  if (name === 'count_notes') return `${result.notebookName || ''}共 ${result.count || 0} 篇笔记`;
  if (name === 'research') return `从 ${result.found || 0} 篇笔记中提取了关键信息`;
  if (name === 'translate') return `已翻译为${result.targetLang || ''}`;
  if (name === 'extract_keywords') return `关键词：${(result.keywords || []).slice(0, 5).join('、')}`;
  if (name === 'translate_note') return `笔记「${result.originalTitle || ''}」已翻译为${result.lang || ''}`;
  if (name === 'append_to_note') return `已追加 ${result.appended || 0} 字到「${result.title || ''}」`;
  if (name === 'duplicate_note') return `笔记「${result.title || ''}」已复制`;
  if (name === 'merge_notes') return `${result.mergedCount || 0} 篇笔记已合并为「${result.title || ''}」`;
  if (name === 'star_note') return `笔记「${result.title || ''}」${result.starred ? '已收藏' : '已取消收藏'}`;
  if (name === 'list_starred') return `${(result || []).length} 篇收藏笔记`;
  if (name === 'word_count') return result.noteId ? `「${result.title || ''}」${result.chars || 0} 字` : `共 ${result.totalChars || 0} 字`;
  if (name === 'clean_text') return `笔记「${result.title || ''}」已清理`;
  if (name === 'export_note') return `笔记「${result.title || ''}」已导出`;
  if (name === 'pomodoro') return result.started ? `番茄钟已开始 ${result.duration}分钟` : result.stopped ? '番茄钟已停止' : (result.active ? `剩余 ${result.remaining} 分钟` : '无进行中的番茄钟');
  if (name === 'sub_agent') return `${result.completed || 0} 个子任务已完成`;
  return '';
}

const ASSISTANT_WRITE_TOOLS = new Set(['create_note','update_note','delete_note','quick_note','create_todo','quick_todo','update_todo','delete_todo','create_notebook','delete_notebook','rename_notebook','move_note','move_note_to_folder','batch_move_notes','batch_update_notes','batch_complete_todos','batch_delete_notes','batch_delete_todos','auto_title_notes','merge_notes','star_note','add_tags','remove_tags','append_to_note','duplicate_note','create_folder','create_from_template','translate_note','clean_text','optimize_text','save_memory','delete_memory']);

function assistantToolTarget(name, result) {
  if (!result?.id) return {};
  if (['create_note','quick_note','update_note','append_to_note','duplicate_note','translate_note','clean_text','optimize_text'].includes(name)) {
    return { targetType: 'note', targetId: String(result.id) };
  }
  if (['create_todo','quick_todo','update_todo'].includes(name)) {
    return { targetType: 'todo', targetId: String(result.id) };
  }
  return {};
}

// 为 AI 上下文生成精简摘要（去掉 id/color 等模型不需要的字段，保留关键信息）
function compressForContext(name, result) {
  try {
    if (name === 'list_notebooks' && Array.isArray(result))
      return result.map(nb => `${nb.name}(${nb.noteCount ?? '?'}篇)`).join(', ');
    if ((name === 'search_notes' || name === 'list_recent_notes' || name === 'list_starred') && Array.isArray(result))
      return result.map(n => `「${n.title || '无标题'}」`).join(', ');
    if ((name === 'search_todos' || name === 'list_todos') && Array.isArray(result))
      return result.map(t => `${t.done ? '✓' : '○'}${(t.text || '').slice(0, _ctxLimit(30, 80, 200))}`).join('; ');
    if (name === 'get_note' && result)
      return `「${result.title || ''}」nb:${result.notebookName || ''} tags:${(result.tags || []).join(',')} content:${(result.content || '').slice(0, _ctxLimit(300, 1000, 4000))}`;
    if (name === 'get_todo' && result)
      return `${result.done ? '✓' : '○'}「${result.text || ''}」due:${result.dueAt || ''} note:${result.note || ''}`;
    if (name === 'list_tags' && Array.isArray(result))
      return result.map(t => `${t.tag}(${t.count})`).join(', ');
    if (name === 'export_note' && result)
      return `「${result.title || ''}」\n${(result.markdown || '').slice(0, _ctxLimit(500, 2000, 6000))}`;
    if (name === 'research' && result)
      return `found:${result.found} summary:${(result.summary || '').slice(0, _ctxLimit(400, 1500, 5000))}`;
    if (name === 'daily_briefing' && result)
      return (result.briefing || '').slice(0, _ctxLimit(500, 2000, 6000));
    if (name === 'note_stats' && result)
      return JSON.stringify(result);
  } catch {}
  return JSON.stringify(result).slice(0, _ctxLimit(500, 2000, 6000));
}

// 流式中从未完成 JSON 中提取 "reply": "...部分..." 的可见字符
// 若找不到 JSON reply 字段则回退到显示纯净文本（避免推理模型前端空白）
function _extractStreamingReply(s) {
  if (!s) return '';
  if (typeof stripThinking === 'function') s = stripThinking(s);
  if (!s) return '';
  let body = s;
  const fence = s.match(/```(?:json)?\s*([\s\S]*)/i);
  if (fence) body = fence[1];
  const idx = body.search(/"reply"\s*:\s*"/);
  if (idx < 0) {
    // 回退：若暂未出现 JSON reply 字段，展示最后 200 字符的纯文本（丢弃代码块标记）
    const clean = s.replace(/```[\s\S]*$/g, '').replace(/^[\s\S]*?```(?:json)?\s*/g, '');
    return clean.slice(-200).trim();
  }
  const afterKey = body.slice(idx).match(/"reply"\s*:\s*"([\s\S]*)$/);
  if (!afterKey) return '';
  const raw = afterKey[1];
  let result = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      const nx = raw[i + 1];
      if (nx === 'n') { result += '\n'; i++; }
      else if (nx === 't') { result += '\t'; i++; }
      else if (nx === '"') { result += '"'; i++; }
      else if (nx === '\\') { result += '\\'; i++; }
      else if (nx === 'r') { i++; }
      else if (nx === 'u' && raw.length >= i + 6) {
        const code = parseInt(raw.slice(i + 2, i + 6), 16);
        if (!isNaN(code)) { result += String.fromCharCode(code); i += 5; } else { result += c; }
      }
      else if (nx) { result += nx; i++; }
      continue;
    }
    if (c === '"') break;
    result += c;
  }
  return result;
}

// 流式过程中给打字气泡的提示文案：已出现 reply 文本就实时预览其尾部;否则按阶段显示「思考中/执行中」。
// 经 escapeHtml 转义后塞进 setAssistantTyping 的 innerHTML,防止注入/破坏布局。
// 从用户自然语言问句中提取检索关键词：去掉标点与常见疑问词/虚词,降低噪声。
// 中文无空格分词交给 search_notes 的 2-gram 模糊匹配处理,这里只做粗清洗。
function _queryKeywords(s) {
  const cleaned = String(s || '')
    .replace(/[？?。.,，、!！:：;；"'「」『』()（）]/g, ' ')
    .replace(/是?啥时候|什么时候|哪一?天|是?多少|怎么样?|怎样|如何|为什么|是不是|有没有|是否|可以|能否|帮我|请问|告诉我|我想知道|一下|的话|呢|吗|啊|哦|呀/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || String(s || '').trim();
}

function _streamingHint(full, steps) {
  const preview = _extractStreamingReply(full || '');
  if (preview && preview.trim()) {
    const tail = preview.length > 80 ? '…' + preview.slice(-80) : preview;
    return escapeHtml(tail);
  }
  return steps ? `执行中 (${steps} 步)…` : '思考中…';
}

async function runAssistantTurn(userInput) {
  if (assistantBusy) { showToast('AI 正在思考中...'); return; }

  const trimmed = userInput.trim();
  const inputEl = document.getElementById('assistantInput');

  // --- 录制模式 ---
  if (/^开始记录/.test(trimmed)) {
    recordingMode = true;
    recordingBuffer = [];
    pushAssistantMessage('user', userInput);
    pushAssistantMessage('assistant', '已开始记录模式\n后续你说的内容会暂存，说**"结束记录"**时我会自动整理成笔记或待办。');
    if (inputEl) inputEl.placeholder = '录制中... 说"结束记录"来整理';
    renderAssistantChat();
    return;
  }
  if (/^结束记录/.test(trimmed) && recordingMode) {
    recordingMode = false;
    if (inputEl) inputEl.placeholder = '例如：帮我新建待办「查阅机票」，明天 15:00 完成';
    const captured = [...recordingBuffer];
    recordingBuffer = [];
    if (!captured.length) {
      pushAssistantMessage('user', userInput);
      pushAssistantMessage('assistant', '记录已结束，但没有暂存的内容。');
      renderAssistantChat();
      return;
    }
    pushAssistantMessage('user', userInput);
    renderAssistantChat();
    const combined = captured.map((m, i) => `${i + 1}. ${m}`).join('\n');
    userInput = `以下是我刚才的记录内容（共${captured.length}条），请整理成一篇笔记保存（标题自动生成），如果内容中有明确的待办事项也一并创建待办：\n\n${combined}`;
  } else if (recordingMode) {
    recordingBuffer.push(trimmed);
    pushAssistantMessage('user', userInput);
    pushAssistantMessage('assistant', `已记录第 ${recordingBuffer.length} 条。继续说，或说"结束记录"整理。`);
    renderAssistantChat();
    return;
  }

  if (!getActiveProvider()) { showToast('请先在「设置 → AI」中配置模型'); openSettingsModal('ai'); return; }

  // 持久化到会话历史里的附件快照不写 dataUrl（避免 localStorage 膨胀 + 渲染缺字段崩溃）
  const attachSnapshot = pendingAttachments.length
    ? pendingAttachments.map(a => a.type === 'image'
        ? { type: 'image', title: a.name || '图片' }
        : { type: a.type, id: a.id, title: a.title })
    : undefined;
  if (!/^结束记录/.test(trimmed)) pushAssistantMessage('user', userInput, attachSnapshot ? { attachments: attachSnapshot } : undefined);

  const sysPrompt = buildAssistantSystemPrompt();
  const ctx = [{ role: 'system', content: sysPrompt }];
  const s = getActiveSession();
  const provider = getActiveProvider();
  const mm = !!(provider && provider.multimodal);
  const ctxK = (provider && provider.contextSize > 0) ? provider.contextSize : 10;
  // 128K 模型放宽历史窗口与压缩阈值,更充分利用上下文、减少中途压缩丢历史的频率
  const historyWindow = ctxK <= 16 ? 20 : ctxK <= 64 ? 60 : ctxK <= 128 ? 160 : 240;
  const loopCompressThreshold = ctxK <= 16 ? 40 : ctxK <= 64 ? 120 : ctxK <= 128 ? 600 : 800;
  const loopCompressKeep = Math.floor(loopCompressThreshold * 0.85);
  const recent = (s?.messages || []).slice(-historyWindow);
  // 如果有图片附件但未开启多模态，提醒用户
  const hasImages = pendingAttachments.some(a => a.type === 'image');
  if (hasImages && !mm) {
    if (typeof showToast === 'function') showToast('当前模型未开启「支持图片识别」，图片附件将被忽略。请在 AI 设置中勾选该模型的「支持图片识别」复选框。');
  }
  // 收集图片附件（仅当本轮多模态启用时生效）
  const pendingImages = mm ? pendingAttachments.filter(a => a.type === 'image') : [];
  // 同时也把笔记附件里包含的 img:<id> 拉出来一并发送
  const noteAttachmentImages = mm
    ? pendingAttachments
        .filter(a => a.type === 'note')
        .flatMap(a => {
          const n = notes.find(x => x.id === a.id);
          return n && typeof _resolveContentImages === 'function' ? _resolveContentImages(n.content || '') : [];
        })
    : [];
  // 预先把每张图片缩到 1280px / JPEG，避免 413 + 限速
  const allImagesAll = [...pendingImages, ...noteAttachmentImages];
  const downscaled = [];
  for (const im of allImagesAll) {
    try { downscaled.push(await _downscaleImage(im.dataUrl, 1280, 0.85)); }
    catch { downscaled.push(im.dataUrl); }
  }
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    if (m.role === 'user') {
      const isLast = (i === recent.length - 1);
      if (mm && isLast && downscaled.length) {
        const parts = [{ type: 'text', text: m.content || '' }];
        for (const url of downscaled) parts.push({ type: 'image_url', image_url: { url } });
        ctx.push({ role: 'user', content: parts });
      } else {
        ctx.push({ role: 'user', content: m.content });
      }
    }
    else if (m.role === 'assistant') {
      let ctxContent = m.content || '';
      if (m.toolLog && m.toolLog.length) {
        ctxContent = '[执行了' + m.toolLog.length + '步:' + m.toolLog.map(t => t.tool + (t.ok ? '✓' : '✗')).join(',') + '] ' + ctxContent;
      }
      ctx.push({ role: 'assistant', content: ctxContent });
    }
    else if (m.role === 'system') ctx.push({ role: 'user', content: '【工具结果】' + m.content });
  }

  assistantBusy = true;
  // 这几个状态在 try 外声明,以便 catch（如用户中止）也能读取已生成的部分结果
  let iter = 0;
  const toolLog = [];
  const allSearchResults = [];
  let finalReply = '';
  let forcedSearch = false;            // 兜底：是否已对「未检索就回答」强制纠正过一次
  const callSigs = new Set();          // 已发起过的工具调用签名,用于防打转(重复调用即停)
  const MAX_TOOL_STEPS = 15;           // 一轮对话内工具调用步数上限(留在接口频率限制之下,避免撞 429)
  let thrash = false;
  try {
    while (iter++ < 100) {
      // 上下文压缩：防止极长任务溢出（根据模型上下文大小动态调整）
      if (ctx.length > loopCompressThreshold) {
        const sysMsg = ctx[0];
        const recent = ctx.slice(-loopCompressKeep);
        ctx.length = 0;
        // 用「已执行工具摘要」替代空泛的「前序已省略」，保留操作轨迹避免重复劳动
        const done = toolLog.length ? '已执行:' + toolLog.map(t => t.tool + (t.ok ? '' : '✗')).join(',') + '。' : '';
        ctx.push(sysMsg, { role: 'user', content: '（前序步骤已省略。' + done + '继续完成任务，不要重复已做过的操作）' }, ...recent);
      }

      setAssistantTyping(true, toolLog.length ? `执行中 (${toolLog.length} 步)…` : '');
      let raw;
      try {
        raw = await callAi(ctx, { temperature: 0.3, max_tokens: Math.min(_ctxLimit(2048, 4096, 16384), 16384), stream: true, onDelta: (_d, full) => setAssistantTyping(true, _streamingHint(full, toolLog.length)) });
      } finally { setAssistantTyping(false); }

      const parsed = parseAssistantReply(raw);
      let hasActions = false;

      for (const a of (parsed.actions || [])) {
        const name = a.tool || a.name;
        const args = a.args || a.arguments || {};
        // 防打转：模型重复发起完全相同的工具调用 → 判定空转，停止（否则会一直调用直到撞接口限流）
        const sig = String(name) + '|' + JSON.stringify(args);
        if (callSigs.has(sig)) { thrash = true; break; }
        callSigs.add(sig);
        hasActions = true;
        try {
          const result = await runAssistantTool(name, args);
          const summary = summarizeActionResult(name, result);
          toolLog.push({ tool: name, summary, ok: true, isWrite: ASSISTANT_WRITE_TOOLS.has(name), ...assistantToolTarget(name, result) });
          if (name === 'search_notes' && Array.isArray(result)) for (const r of result) allSearchResults.push({ kind: 'note', id: r.id, title: r.title, snippet: r.snippet, updatedAt: r.updatedAt });
          else if (name === 'search_todos' && Array.isArray(result)) for (const r of result) allSearchResults.push({ kind: 'todo', id: r.id, title: r.text, snippet: r.done ? '已完成' : '进行中', dueAt: r.dueAt });
          else if (name === 'list_notebooks' && Array.isArray(result)) for (const r of result) allSearchResults.push({ kind: 'notebook', id: r.id, title: r.name });
          else if (name === 'research' && result && Array.isArray(result.sources)) for (const r of result.sources) allSearchResults.push({ kind: 'note', id: r.id, title: r.title, snippet: r.notebook ? `来自「${r.notebook}」` : '' });
          // AI 上下文：大模型直传，小模型智能压缩
          const contextResult = ctxK >= 64
            ? JSON.stringify(result).slice(0, _ctxLimit(4000, 12000, 30000))
            : compressForContext(name, result);
          ctx.push({ role: 'assistant', content: JSON.stringify({ actions: [{ tool: name }] }) });
          ctx.push({ role: 'user', content: '【结果】' + name + ': ' + contextResult });
          setAssistantTyping(true, `执行中 (${toolLog.length} 步)…`);
        } catch (e) {
          toolLog.push({ tool: name, summary: e.message || String(e), ok: false, isWrite: ASSISTANT_WRITE_TOOLS.has(name) });
          ctx.push({ role: 'assistant', content: JSON.stringify({ actions: [{ tool: name }] }) });
          ctx.push({ role: 'user', content: '【错误】' + name + ': ' + (e.message || e) });
        }
      }

      finalReply = parsed.reply || finalReply;
      // 防打转：检测到重复调用，或工具步数达到上限 → 停止，避免空转到撞接口频率限制(429)
      if (thrash) {
        finalReply = (finalReply || '') + (finalReply ? '\n\n' : '') + '（已停止：检测到重复的相同操作，为避免空转/触发接口频率限制未继续。若要删除某条笔记，可在「笔记索引」里按其 id 让我删；或把需求说得更具体、换个模型重试。）';
        break;
      }
      if (toolLog.length >= MAX_TOOL_STEPS) {
        finalReply = (finalReply || '') + (finalReply ? '\n\n' : '') + `（已执行 ${toolLog.length} 步并停止，以免触发接口每分钟调用上限。任务可能未完成，请把需求说得更具体或分步进行。）`;
        break;
      }
      if (!hasActions) {
        // 检索兜底：模型一次笔记检索都没做，却给出「无法找到/不知道」之类回答时，
        // 不直接采信——强制要求它先用关键词搜索再作答。只纠正一次，避免死循环。
        const QUERY_TOOLS = ['search_notes','find_note','research','search_todos','list_notebooks','get_note','count_notes'];
        const noSearchYet = allSearchResults.length === 0 && !toolLog.some(t => QUERY_TOOLS.includes(t.tool));
        const looksUnsure = /无法找到|未找到|没有找到|无法确定|不知道|无法访问|没有相关|请提供更多|不清楚|无法回答|无法搜索|没有权限|哪个|是指/.test(finalReply || '');
        if (!forcedSearch && noSearchYet && looksUnsure && trimmed) {
          forcedSearch = true;
          // 不再只是「提示模型去搜」（部分模型不照做/查询写不好）——直接在代码里替它检索一次,
          // 把结果塞回上下文,逼它基于真实笔记重答。配合 search_notes 的中文模糊匹配,大模型也能命中。
          try {
            const result = await runAssistantTool('search_notes', { query: _queryKeywords(trimmed) });
            toolLog.push({ tool: 'search_notes', summary: summarizeActionResult('search_notes', result), ok: true });
            if (Array.isArray(result)) for (const r of result) allSearchResults.push({ kind: 'note', id: r.id, title: r.title, snippet: r.snippet, updatedAt: r.updatedAt });
            if (Array.isArray(result) && result.length) {
              const ctxResult = ctxK >= 64 ? JSON.stringify(result).slice(0, _ctxLimit(4000, 12000, 30000)) : compressForContext('search_notes', result);
              ctx.push({ role: 'user', content: '【系统已自动检索】针对「' + trimmed + '」找到以下相关笔记,请严格依据它们重新作答(找到答案就直接给出并注明来源笔记标题);确属无关再说明未找到。\n【结果】search_notes: ' + ctxResult });
            } else {
              ctx.push({ role: 'user', content: '【系统已自动检索】「' + trimmed + '」无结果。请换更宽泛/不同的关键词再调用一次 search_notes;若仍无则如实告知未找到,不要编造。' });
            }
            finalReply = '';
            continue;
          } catch { /* 检索失败则照常结束 */ }
        }
        break;
      }
    }

    const wroteSomething = toolLog.some(t => t.ok && ASSISTANT_WRITE_TOOLS.has(t.tool));
    if (wroteSomething) {
      try { if (typeof workdirWriteAll === 'function') await workdirWriteAll(true); } catch {}
    }

    // 防"幻觉式成功"：模型在 reply 里声称已创建/保存了笔记/待办/记忆，但本轮没有任何写工具
    // 真正成功执行（模型只是描述结果没调用工具，或工具执行失败）——不能让用户误以为成功了。
    const claimsWrite = /(创建|新建|保存|存入|记住|加入|添加|归类|记录到|建好|存好)/.test(finalReply || '')
      && /(笔记|待办|记忆|笔记本|分组|随笔)/.test(finalReply || '')
      && /(已|成功|帮你|为你|好了|完成)/.test(finalReply || '');
    if (claimsWrite && !wroteSomething) {
      const failed = toolLog.filter(t => !t.ok).map(t => t.tool + (t.summary ? '（' + t.summary + '）' : ''));
      finalReply = '⚠️ 实际并未创建/保存成功——' + (failed.length
        ? '工具执行失败：' + failed.join('；') + '。'
        : '模型只描述了结果，但没有真正调用工具（未产生任何写入）。')
        + '\n\n请再说一次你的需求（例如「记录：<内容>」），或到「设置 → AI」换一个更稳的模型重试。';
    }

    pushAssistantMessage('assistant', finalReply, {
      toolLog: toolLog.length ? toolLog : undefined,
      searchResults: allSearchResults.length ? allSearchResults : undefined
    });
  } catch (e) {
    const msg = e && (e.message || String(e));
    // 用户主动中止：保留已生成的部分回复，不当成错误
    if (msg === '已取消') {
      pushAssistantMessage('assistant', (finalReply ? finalReply + '\n\n' : '') + '_（已中止生成）_',
        { toolLog: toolLog.length ? toolLog : undefined, searchResults: allSearchResults.length ? allSearchResults : undefined });
    } else if (/\b429\b|per 1 minute|per minute|rate limit|too many requests/i.test(msg || '')) {
      // 接口每分钟调用上限:给友好提示,并保留已完成的部分
      pushAssistantMessage('assistant', (finalReply ? finalReply + '\n\n' : '') + '⚠️ 触发了 AI 接口的每分钟调用上限（HTTP 429）。请等约 1 分钟再试；若常出现，可到「设置 → AI」换用配额更高的模型。',
        { toolLog: toolLog.length ? toolLog : undefined, searchResults: allSearchResults.length ? allSearchResults : undefined });
    } else {
      pushAssistantMessage('assistant', '出错：' + msg);
      if (typeof logError === 'function') logError(e, 'assistant');
    }
  } finally {
    assistantBusy = false;
    setAssistantTyping(false);
  }
}

// ===================== 左侧栏：AI 分组渲染 =====================

function renderAssistantRail() {
  const el = document.getElementById('assistantGroupListRail');
  if (el) el.innerHTML = '';
}

// ===================== 中侧栏：分组+会话树形渲染 =====================

function renderAssistantSessions() {
  const titleEl = document.getElementById('aiSessionsTitle');
  const listEl = document.getElementById('aiSessionsList');
  if (!listEl) return;
  if (titleEl) titleEl.textContent = 'AI 助手';

  listEl.innerHTML = assistantGroups.map(g => {
    const isActiveGroup = assistantInAiView && g.id === assistantActiveGroupId;
    const sessionCount = (g.sessions || []).length;
    const chevronD = isActiveGroup ? 'M19 9l-7 7-7-7' : 'M9 5l7 7-7 7';
    const sessionsHtml = isActiveGroup ? (g.sessions || []).map(s => {
      const isActive = s.id === assistantActiveSessionId;
      const msgCount = (s.messages || []).length;
      return `<div class="ai-session-item ${isActive ? 'active' : ''}" data-sid="${escapeHtml(s.id)}" data-gid="${escapeHtml(g.id)}">
        <span class="session-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
        <span class="session-meta">${msgCount}</span>
        <span class="session-actions">
          <button class="session-action-btn" data-action="rename" title="重命名"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="session-action-btn" data-action="delete" title="删除"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6M3 7h18M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg></button>
        </span>
      </div>`;
    }).join('') : '';

    return `<div class="ai-group-section">
      <div class="ai-group-header ${isActiveGroup ? 'active' : ''}" data-ai-group="${escapeHtml(g.id)}">
        <svg class="group-chevron" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="${chevronD}"/></svg>
        <span class="group-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
        <span class="group-count">${sessionCount}</span>
        <span class="group-actions">
          <button class="group-action-btn" data-action="rename" title="重命名分组"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="group-action-btn" data-action="delete" title="删除分组"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6M3 7h18M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg></button>
        </span>
      </div>
      ${sessionsHtml ? '<div class="ai-group-sessions">' + sessionsHtml + '</div>' : ''}
    </div>`;
  }).join('');

  // --- 分组 header 点击/操作图标/右键 ---
  const confirmDeleteGroup = (gid) => {
    const g = assistantGroups.find(x => x.id === gid);
    if (!g) return;
    // 用应用内自定义弹窗替代原生 confirm()（后者在 Tauri webview 里会显示「tauri.localhost 显示」）
    showModal('删除分组', '确定删除分组「' + g.name + '」吗？分组下的会话也会一并删除，且无法恢复。', () => deleteAssistantGroup(gid));
  };
  listEl.querySelectorAll('.ai-group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.group-action-btn')) return;   // 点的是操作图标，交给下面处理
      const gid = header.dataset.aiGroup;
      if (assistantInAiView && gid === assistantActiveGroupId) return;
      enterAiView(gid);
    });
    // 右键也直接走应用内删除确认，不再用 prompt()/confirm()
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      confirmDeleteGroup(header.dataset.aiGroup);
    });
  });
  listEl.querySelectorAll('.group-action-btn[data-action="rename"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const header = btn.closest('.ai-group-header');
      const gid = header?.dataset.aiGroup;
      const g = assistantGroups.find(x => x.id === gid);
      if (!g) return;
      startInlineRename(header, '.group-name', g.name, (val) => renameAssistantGroup(gid, val));
    });
  });
  listEl.querySelectorAll('.group-action-btn[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeleteGroup(btn.closest('.ai-group-header')?.dataset.aiGroup);
    });
  });

  // --- 会话点击/操作 ---
  listEl.querySelectorAll('.ai-session-item').forEach(it => {
    it.addEventListener('click', (e) => {
      if (e.target.closest('.session-action-btn')) return;
      const sid = it.dataset.sid;
      if (sid && sid !== assistantActiveSessionId) {
        assistantActiveSessionId = sid;
        clearPendingAttachments();
        renderAssistantSessions();
        renderAssistantChat();
      }
    });
  });
  listEl.querySelectorAll('.session-action-btn[data-action="rename"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionItem = btn.closest('.ai-session-item');
      const sid = sessionItem?.dataset.sid;
      const gid = sessionItem?.dataset.gid;
      const g = assistantGroups.find(x => x.id === gid);
      const s = g && (g.sessions || []).find(x => x.id === sid);
      if (!s) return;
      startInlineRename(sessionItem, '.session-name', s.name, (val) => renameAssistantSession(g.id, sid, val));
    });
  });
  listEl.querySelectorAll('.session-action-btn[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionItem = btn.closest('.ai-session-item');
      const sid = sessionItem?.dataset.sid;
      const gid = sessionItem?.dataset.gid;
      if (!sid || !gid) return;
      const g = assistantGroups.find(x => x.id === gid);
      const s = g && (g.sessions || []).find(x => x.id === sid);
      showModal('删除会话', '确定删除会话「' + (s?.name || '该会话') + '」吗？此操作无法恢复。', () => deleteAssistantSession(gid, sid));
    });
  });

  // 拖拽排序
  if (typeof window.enableDragReorder === 'function') {
    listEl.querySelectorAll('.ai-group-sessions').forEach(container => {
      const gid = container.previousElementSibling?.dataset?.aiGroup;
      const g = gid && assistantGroups.find(x => x.id === gid);
      if (!g) return;
      container.querySelectorAll('.ai-session-item').forEach(it => { it.dataset.dragKey = it.dataset.sid; });
      window.enableDragReorder(container, '.ai-session-item', (src, dst) => {
        if (window.reorderArrayById(g.sessions || [], src, dst)) {
          saveAssistantGroups();
          renderAssistantSessions();
        }
      });
    });
  }
}

// 兼容旧名
function renderAssistantGroups() { renderAssistantRail(); renderAssistantSessions(); }

// ===================== 进入/退出 AI 视图 =====================

function enterAiView(groupId) {
  const g = assistantGroups.find(x => x.id === groupId);
  if (!g) return;
  assistantActiveGroupId = g.id;
  if (!g.sessions.find(s => s.id === assistantActiveSessionId)) {
    assistantActiveSessionId = g.sessions[0]?.id || null;
  }
  assistantInAiView = true;
  const app = document.getElementById('app');
  if (app) { app.classList.add('ai-view'); app.classList.remove('sidebar-collapsed'); }
  const editor = document.querySelector('.editor');
  if (editor) editor.classList.add('assistant-active');
  renderAssistantRail();
  renderAssistantSessions();
  renderAssistantChat();
  renderPendingAttachments();
  setTimeout(() => document.getElementById('assistantInput')?.focus(), 100);
}

function exitAiView() {
  if (!assistantInAiView) return;
  assistantInAiView = false;
  const app = document.getElementById('app');
  if (app) app.classList.remove('ai-view');
  const editor = document.querySelector('.editor');
  if (editor) editor.classList.remove('assistant-active');
  renderAssistantRail();
}

function showAssistantPanel() {
  const g = getActiveGroup();
  if (g) enterAiView(g.id);
}

function hideAssistantPanel() { exitAiView(); }

// ===================== UI 绑定 =====================

function bindAssistantUi() {
  loadAssistantGroups();
  renderAssistantRail();

  // AI 入口按钮（底部栏）
  const aiBtn = document.getElementById('aiEntryBtn');
  if (aiBtn) aiBtn.addEventListener('click', () => {
    if (assistantInAiView) { exitAiView(); }
    else { showAssistantPanel(); }
  });

  // 新建分组
  const newGroupBtn = document.getElementById('newAssistantGroupBtn');
  if (newGroupBtn) newGroupBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const g = createAssistantGroup('新分组');
    setTimeout(() => {
      const item = document.querySelector(`.ai-group-item[data-ai-group="${g.id}"]`);
      if (item) startInlineRename(item, '.group-name', g.name, (val) => renameAssistantGroup(g.id, val));
    }, 0);
  });

  // 新建会话（中侧栏）
  const newSessionBtn = document.getElementById('newAssistantSessionBtn');
  if (newSessionBtn) newSessionBtn.addEventListener('click', () => {
    const g = getActiveGroup();
    if (!g) return;
    const s = createAssistantSession(g.id, '新会话');
    if (s) {
      setTimeout(() => {
        const item = document.querySelector(`.ai-session-item[data-sid="${s.id}"]`);
        if (item) startInlineRename(item, '.session-name', s.name, (val) => renameAssistantSession(g.id, s.id, val));
      }, 0);
    }
  });

  // 返回按钮（保留兼容）
  const backBtn = document.getElementById('assistantBackBtn');
  if (backBtn) backBtn.addEventListener('click', hideAssistantPanel);

  // 清空当前会话
  const clearBtn = document.getElementById('assistantClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => { showModal('清空会话历史', '确定清空当前会话的全部聊天记录吗？此操作无法恢复。', () => clearActiveSessionHistory()); });

  // 模型选择器
  const modelSelect = document.getElementById('assistantModelSelect');
  function refreshModelSelect() {
    if (!modelSelect) return;
    const providers = (typeof aiConfig !== 'undefined' && aiConfig.providers) ? aiConfig.providers : [];
    const activeId = (typeof aiConfig !== 'undefined') ? aiConfig.activeId : null;
    if (!providers.length) {
      modelSelect.innerHTML = '<option value="">未配置模型</option>';
      return;
    }
    modelSelect.innerHTML = providers.map(p => {
      const label = (p.name || p.model || '模型').slice(0, 30);
      return `<option value="${escapeHtml(p.id)}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  }
  if (modelSelect) {
    refreshModelSelect();
    modelSelect.addEventListener('change', () => {
      const id = modelSelect.value;
      if (id && typeof aiConfig !== 'undefined') {
        aiConfig.activeId = id;
        if (typeof saveAiConfig === 'function') saveAiConfig();
        const p = aiConfig.providers.find(x => x.id === id);
        if (typeof showToast === 'function' && p) showToast('已切换为 ' + (p.name || p.model));
      }
    });
    if (typeof saveAiConfig === 'function') {
      const _origSave = saveAiConfig;
      window.saveAiConfig = function() {
        _origSave();
        try { refreshModelSelect(); } catch {}
      };
    }
  }

  // 记忆管理面板（左侧栏折叠区）
  const memToggle = document.getElementById('aiMemoryToggle');
  const memBody = document.getElementById('aiMemoryBody');
  function renderMemoryList() {
    const list = document.getElementById('memoryList');
    if (!list) return;
    const arr = loadMemories();
    const countEl = document.getElementById('memoryCount');
    if (countEl) countEl.textContent = arr.length;
    const catLabel = MEMORY_CAT_LABEL;
    if (!arr.length) { list.innerHTML = '<div class="memory-empty">暂无记忆<br><span style="font-size:11px">和 AI 对话时说"记住…"即可保存</span></div>'; return; }
    list.innerHTML = arr.map((m, i) => `<div class="memory-item" data-idx="${i}"><span class="mem-cat">${catLabel[m.category] || '其他'}</span><div class="mem-body"><div class="mem-key">${escapeHtml(m.key)}</div><div class="mem-val">${escapeHtml(m.value)}</div></div><button class="mem-del" data-key="${escapeHtml(m.key)}" title="删除">✕</button></div>`).join('');
    list.querySelectorAll('.mem-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const mArr = loadMemories().filter(x => x.key !== key);
        saveMemories(mArr);
        renderMemoryList();
        if (typeof workdirWriteAll === 'function') workdirWriteAll(true);
      });
    });
  }
  if (memToggle && memBody) {
    memToggle.addEventListener('click', () => {
      const open = memBody.style.display !== 'none';
      memBody.style.display = open ? 'none' : '';
      memToggle.classList.toggle('open', !open);
      if (!open) renderMemoryList();
    });
  }
  const memAddBtn = document.getElementById('memoryAddBtn');
  if (memAddBtn) memAddBtn.addEventListener('click', () => {
    const keyEl = document.getElementById('memoryKeyInput');
    const valEl = document.getElementById('memoryValueInput');
    const catEl = document.getElementById('memoryCategoryInput');
    const key = (keyEl?.value || '').trim();
    const value = (valEl?.value || '').trim();
    if (!key || !value) { if (typeof showToast === 'function') showToast('请填写关键词和内容'); return; }
    try { upsertMemory(key, value, catEl?.value); }            // 与 AI 工具共用同一写入逻辑(限长/去重/封顶)
    catch (e) { if (typeof showToast === 'function') showToast(e.message || '保存失败'); return; }
    if (keyEl) keyEl.value = '';
    if (valEl) valEl.value = '';
    renderMemoryList();
    if (typeof workdirWriteAll === 'function') workdirWriteAll(true);   // 落盘到工作目录
  });
  // 初始化记忆计数
  const initCount = document.getElementById('memoryCount');
  if (initCount) initCount.textContent = loadMemories().length;

  // 附件
  const attachBtn = document.getElementById('assistantAttachBtn');
  if (attachBtn) attachBtn.addEventListener('click', openAttachmentPicker);

  const attachClose = document.getElementById('attachmentPickerClose');
  if (attachClose) attachClose.addEventListener('click', closeAttachmentPicker);
  const attachBg = document.getElementById('attachmentPickerBg');
  if (attachBg) attachBg.addEventListener('click', e => { if (e.target.id === 'attachmentPickerBg') closeAttachmentPicker(); });

  // 图片附件：picker 模态内的本地文件
  const imageFile = document.getElementById('assistantImageFile');
  if (imageFile) {
    imageFile.addEventListener('change', async () => {
      const files = Array.from(imageFile.files || []);
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = reject;
            r.readAsDataURL(f);
          });
          addPendingImage(dataUrl, f.name);
        } catch (e) {
          if (typeof showToast === 'function') showToast('图片读取失败');
        }
      }
      imageFile.value = '';
      renderAttachmentPickerContent();
    });
  }
  const inputForPaste = document.getElementById('assistantInput');
  if (inputForPaste) {
    inputForPaste.addEventListener('paste', async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      let consumed = false;
      for (const it of items) {
        if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (!f) continue;
          consumed = true;
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result);
              r.onerror = reject;
              r.readAsDataURL(f);
            });
            addPendingImage(dataUrl, f.name || ('pasted-' + Date.now() + '.png'));
          } catch {}
        }
      }
      if (consumed) e.preventDefault();
    });
  }

  // 发送
  const send = document.getElementById('assistantSendBtn');
  const input = document.getElementById('assistantInput');
  // 输入框随内容自动增高(上限由 CSS max-height 控制,超出内部滚动);发送后复位
  const autoGrowInput = () => { if (!input) return; input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; };
  const submit = () => {
    const v = (input?.value || '').trim();
    if (!v) return;
    if (input) { input.value = ''; input.style.height = 'auto'; }
    runAssistantTurn(v);
  };
  if (send) send.addEventListener('click', submit);
  if (input) {
    input.addEventListener('input', autoGrowInput);
    // 保持 Enter=换行、Cmd/Ctrl+Enter=发送:用户常需录入多段长文本,Enter 直接发送易误触
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
  }

  // Esc 退出 AI 视图
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && assistantInAiView) { e.stopPropagation(); exitAiView(); }
  });

  // rail 委托：AI 项进入/同分组双击折叠/非 AI 项退出 AI 视图
  (function setupSidebarCollapse() {
    let lastRailId = null;
    const app = document.getElementById('app');
    const rail = document.querySelector('.rail');
    if (!rail || !app) return;
    const getRailId = (el) => {
      if (el.dataset.view) return 'view:' + el.dataset.view;
      const nb = el.closest('[data-nb]');
      if (nb && nb.dataset.nb) return 'nb:' + nb.dataset.nb;
      const fd = el.closest('[data-folder]');
      if (fd && fd.dataset.folder) return 'folder:' + fd.dataset.folder;
      return null;
    };
    rail.addEventListener('click', (e) => {
      const item = e.target.closest('.rail-item, .rail-folder-item');
      if (!item) return;
      const rid = getRailId(item);
      if (!rid) return;
      const view = item.dataset.view || '';
      const isAi = view.startsWith('ai:');
      if (isAi) {
        const gid = view.slice(3);
        if (!assistantInAiView || gid !== assistantActiveGroupId) {
          enterAiView(gid);
        }
      } else if (assistantInAiView) {
        exitAiView();
      }
      if (rid === lastRailId) {
        app.classList.toggle('sidebar-collapsed');
      } else {
        app.classList.remove('sidebar-collapsed');
      }
      lastRailId = rid;
    });
  })();

  // 聊天图片点击 → 全屏灯箱查看
  const chatBox = document.getElementById('assistantChat');
  if (chatBox) {
    chatBox.addEventListener('click', (e) => {
      const img = e.target.closest('.chat-img-preview');
      if (!img) return;
      const src = img.dataset.fullImg || img.src;
      if (!src) return;
      // 创建灯箱
      const overlay = document.createElement('div');
      overlay.className = 'img-lightbox';
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
      const lbImg = document.createElement('img');
      lbImg.src = src;
      lbImg.style.cssText = 'max-width:94vw;max-height:94vh;object-fit:contain;border-radius:4px;box-shadow:0 4px 48px rgba(0,0,0,0.5);';
      overlay.appendChild(lbImg);
      overlay.addEventListener('click', () => overlay.remove());
      document.addEventListener('keydown', function closeEsc(ev) {
        if (ev.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', closeEsc); }
      });
      document.body.appendChild(overlay);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindAssistantUi);
} else {
  bindAssistantUi();
}
