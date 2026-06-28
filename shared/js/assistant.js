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
const ASSISTANT_HISTORY_MAX = 40;
// 数据结构：assistantGroups = [{id, name, createdAt, sessions: [{id, name, createdAt, messages: [...]}]}]
let assistantGroups = [];
let assistantActiveGroupId = null;
let assistantActiveSessionId = null;
let assistantBusy = false;
let assistantInAiView = false;

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
      return `<span class="attach-pill image" title="图片附件 — 点击移除" data-remove="${i}" style="display:inline-flex;align-items:center;gap:4px;">
        <img src="${a.dataUrl}" style="width:20px;height:20px;object-fit:cover;border-radius:3px;vertical-align:middle">
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
function loadMemories() { try { return JSON.parse(localStorage.getItem(MEMORY_KEY)) || []; } catch { return []; } }
function saveMemories(arr) { localStorage.setItem(MEMORY_KEY, JSON.stringify(arr)); }

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
    desc: '列出笔记本。无参数',
    run: () => notebooks.map(nb => ({ id: nb.id, name: nb.name, color: nb.color }))
  },
  search_notes: {
    desc: '搜索笔记。{query?, limit?(默认30)}',
    run: ({ query, limit }) => {
      const q = String(query || '').trim().toLowerCase();
      const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 30));
      let list = notes.filter(n => !n.deleted);
      if (q) {
        const terms = q.split(/\s+/).filter(Boolean);
        list = list.filter(n => {
          const title = (n.title || '').toLowerCase();
          const content = (n.content || '').toLowerCase();
          return terms.some(t => title.includes(t) || content.includes(t));
        });
        if (!list.length) {
          list = notes.filter(n => !n.deleted).filter(n => {
            const chars = q.replace(/\s+/g, '').split('');
            const blob = ((n.title || '') + (n.content || '')).toLowerCase();
            return chars.every(c => blob.includes(c));
          });
        }
      }
      return list
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, lim)
        .map(n => {
          const nb = notebooks.find(x => x.id === n.notebookId);
          return { id: n.id, title: n.title || '(无标题)', snippet: extractSnippet(n.content, q, 200), notebookName: nb?.name || '', tags: n.tags || [], updatedAt: n.updatedAt };
        });
    }
  },
  search_todos: {
    desc: '搜索待办。{query?, status?"active"|"done"|"overdue"|"all", due?"today"|"overdue"|"week", limit?}',
    run: ({ query, status, due, limit }) => {
      const q = String(query || '').trim().toLowerCase();
      const lim = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
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
      return list.sort((a, b) => (a.dueDate || Infinity) - (b.dueDate || Infinity)).slice(0, lim).map(t => ({ id: t.id, text: t.text, done: !!t.done, dueAt: t.dueDate ? new Date(t.dueDate).toISOString() : null, remindBeforeMin: t.remindBeforeMin || 0, contentPreview: (t.content || '').slice(0, 100) }));
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
    desc: '删除笔记本（笔记移到默认本）。{notebookId?|notebookName?}',
    run: ({ notebookId, notebookName }) => {
      let nb = null;
      if (notebookId) nb = notebooks.find(x => x.id === notebookId);
      else if (notebookName) nb = notebooks.find(x => x.name === notebookName);
      if (!nb) throw new Error('笔记本未找到');
      if (notebooks.length <= 1) throw new Error('至少保留一个笔记本');
      const defaultNb = notebooks.find(x => x.id !== nb.id);
      const movedCount = notes.filter(n => n.notebookId === nb.id).length;
      notes.forEach(n => { if (n.notebookId === nb.id) n.notebookId = defaultNb.id; });
      folders = folders.filter(f => f.notebookId !== nb.id);
      notebooks = notebooks.filter(x => x.id !== nb.id);
      saveData(); renderNotebooks(); renderNotesList();
      return { deleted: nb.name, movedNotesTo: defaultNb.name, movedCount };
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
    desc: '删除笔记。{id}',
    run: ({ id }) => {
      const n = notes.find(x => x.id === id);
      if (!n) throw new Error('笔记未找到：' + (id || '(未指定)'));
      n.deleted = true;
      n.updatedAt = Date.now();
      saveData();
      renderNotesList();
      return { id: n.id, title: n.title || '(无标题)', deleted: true };
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
    desc: '保存记忆。{key, value, category?"preference"|"fact"|"context"|"other"}',
    run: ({ key, value, category }) => {
      if (!key || !value) throw new Error('key 和 value 必填');
      const arr = loadMemories();
      const idx = arr.findIndex(m => m.key === key);
      const entry = { key: String(key), value: String(value), category: category || 'other', createdAt: idx >= 0 ? arr[idx].createdAt : Date.now(), updatedAt: Date.now() };
      if (idx >= 0) arr[idx] = entry; else arr.push(entry);
      saveMemories(arr);
      return { key: entry.key, category: entry.category, saved: true };
    }
  },
  recall_memory: {
    desc: '查找记忆。{query?}不传返回全部',
    run: ({ query }) => {
      let arr = loadMemories();
      if (query) {
        const q = String(query).toLowerCase();
        arr = arr.filter(m => m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q));
      }
      return arr.map(m => ({ key: m.key, value: m.value, category: m.category, updatedAt: m.updatedAt }));
    }
  },
  delete_memory: {
    desc: '删除记忆。{key}',
    run: ({ key }) => {
      if (!key) throw new Error('key 必填');
      const arr = loadMemories();
      const len = arr.length;
      const filtered = arr.filter(m => m.key !== key);
      saveMemories(filtered);
      return { deleted: len - filtered.length > 0, key };
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
    run: ({ noteIds }) => {
      if (!Array.isArray(noteIds) || !noteIds.length) throw new Error('noteIds 必填');
      let success = 0, failed = 0;
      const details = [];
      for (const id of noteIds) {
        const n = notes.find(x => x.id === id);
        if (n && !n.deleted) { n.deleted = true; n.updatedAt = Date.now(); success++; details.push({ id, title: n.title || '(无标题)' }); }
        else { failed++; }
      }
      saveData(); renderNotesList();
      return { success, failed, details };
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
      const recentNotes = notes.filter(n => !n.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5).map(n => ({ id: n.id, title: n.title || '(无标题)', updatedAt: n.updatedAt }));
      const memories = loadMemories().slice(-5).map(m => ({ key: m.key, value: m.value, category: m.category }));
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
        topTags: Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, count]) => ({ tag, count })),
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
        { role: 'user', content: (n.content || '').slice(0, 4000) }
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
  }
};

function buildAssistantSystemPrompt() {
  const now = new Date();
  const tools = Object.entries(ASSISTANT_TOOLS).map(([n, t]) => `- ${n}: ${t.desc}`).join('\n');
  let attachInfo = '';
  if (pendingAttachments.length) {
    const parts = [];
    let imgCount = 0;
    for (const a of pendingAttachments) {
      if (a.type === 'note') { const n = notes.find(x => x.id === a.id); if (n) parts.push(`[笔记附件: id=${n.id}, 标题=${n.title || '(无标题)'}, 内容=${(n.content || '').slice(0, 2000)}]`); }
      else if (a.type === 'todo') { const t = todos.find(x => x.id === a.id); if (t) parts.push(`[待办附件: id=${t.id}, 标题=${t.text}, 完成=${t.done ? '是' : '否'}, 内容=${(t.content || '').slice(0, 2000)}, 截止=${t.dueDate ? new Date(t.dueDate).toISOString() : '无'}]`); }
      else if (a.type === 'image') { imgCount++; }
    }
    if (imgCount) parts.push(`[图片附件: ${imgCount} 张（已作为 image_url 部分附在最后一条用户消息中，请直接读取并理解）]`);
    if (parts.length) { attachInfo = '\n\n【当前附件】\n' + parts.join('\n') + '\n【注意】修改附件内容时使用 update_note / update_todo，不传 id 时自动使用附件中的第一个对应类型。'; }
  }

  const activeNotes = notes.filter(n => !n.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  let noteIndex = '';
  if (activeNotes.length) {
    const top = activeNotes.slice(0, 30);
    noteIndex = '\n\n【笔记概览】共 ' + activeNotes.length + ' 篇（近 ' + top.length + ' 篇）\n';
    noteIndex += top.map((n, i) => {
      const nb = notebooks.find(x => x.id === n.notebookId);
      const summary = stripMarkdown(n.content).slice(0, 60);
      return `${i + 1}. ${n.title || '(无标题)'}${nb ? ' [' + nb.name + ']' : ''}${summary ? ' — ' + summary : ''}`;
    }).join('\n');
  }

  const activeTodos = todos.filter(t => !t.done);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const todayTodos = activeTodos.filter(t => t.dueDate && t.dueDate >= todayStart.getTime() && t.dueDate <= todayEnd.getTime());
  const overdueTodos = activeTodos.filter(t => t.dueDate && t.dueDate < todayStart.getTime());
  let todoOverview = '';
  if (todos.length) {
    todoOverview = '\n\n【待办概要】未完成：' + activeTodos.length + ' 条' +
      (todayTodos.length ? '（今日截止 ' + todayTodos.length + ' 条）' : '') +
      (overdueTodos.length ? '（已过期 ' + overdueTodos.length + ' 条）' : '');
    if (todayTodos.length) {
      todoOverview += '\n今日截止：\n' + todayTodos.map(t => '- ' + t.text + (t.dueDate ? '（截止 ' + new Date(t.dueDate).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '）' : '')).join('\n');
    }
    if (overdueTodos.length) {
      todoOverview += '\n已过期：\n' + overdueTodos.slice(0, 10).map(t => '- ' + t.text + (t.dueDate ? '（原定 ' + new Date(t.dueDate).toLocaleDateString('zh-CN') + '）' : '')).join('\n');
    }
  }

  const memArr = loadMemories();
  let memorySection = '';
  if (memArr.length) {
    const catLabel = { preference: '偏好', fact: '事实', context: '上下文', other: '其他' };
    const top = memArr.slice(-20);
    memorySection = '\n\n【记忆】共 ' + memArr.length + ' 条（最近 ' + top.length + ' 条）\n' +
      top.map(m => `- [${catLabel[m.category] || '其他'}] ${m.key}：${m.value}`).join('\n');
  }

  return `你是 Marginote 笔记 AI 助手。当前：${now.toLocaleString('zh-CN')}
笔记本${notebooks.length}个 笔记${activeNotes.length}篇 待办${todos.length}条${attachInfo}${noteIndex}${todoOverview}${memorySection}

【工具】
${tools}

【协议】仅输出JSON：{"reply":"Markdown回复","actions":[{"tool":"名","args":{}}]}
无工具调用时 actions 设 []。每次只调一个工具，多步分轮执行。

【规则】
- 笔记概览仅供定位，用户问具体内容时必须 search_notes 搜索
- 查笔记内容：search_notes → 根据snippet回答；仅snippet不足时才 get_note
- 删除/移动多篇：search_notes({limit:50+}) → batch_delete_notes/batch_move_notes（一次传所有ID）
- 批量改标题：search_notes → batch_update_notes({noteIds, titles:{"id1":"标题1","id2":"标题2"}})，不要逐篇 get_note
- 搜索无果时换关键词重试
- 用户表达偏好时主动 save_memory
- 珍惜每轮工具调用，避免重复搜索相同关键词
- 回复用 Markdown（标题/列表/粗体），简洁直接`;
}

// ===================== 渲染 =====================

function parseAssistantReply(raw) {
  if (!raw) return { reply: '', actions: [] };
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { const obj = JSON.parse(s); return { reply: typeof obj.reply === 'string' ? obj.reply : '', actions: Array.isArray(obj.actions) ? obj.actions : [] }; }
  catch { return { reply: raw, actions: [] }; }
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
  box.scrollTop = box.scrollHeight;
}

function renderAssistantMessage(m) {
  const role = m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'bot');
  const roleLabel = m.role === 'user' ? '我' : (m.role === 'system' ? '工具' : 'AI');
  const bubbleContent = role === 'bot' && m.content && typeof renderMarkdown === 'function'
    ? renderMarkdown(m.content)
    : escapeHtml(m.content || '');
  let html = `<div class="assistant-msg ${role}"><span class="role">${roleLabel}</span><div class="bubble">${bubbleContent}</div>`;
  if (m.attachments && m.attachments.length) {
    html += '<div class="msg-attachments">';
    for (const a of m.attachments) {
      if (a.type === 'image') {
        // 尝试从 pendingAttachments 中找回 dataUrl 显示大图
        const matchedImg = typeof pendingAttachments !== 'undefined' ? pendingAttachments.find(p => p.type === 'image' && p.name === a.title) : null;
        if (matchedImg && matchedImg.dataUrl) {
          html += '<div class="msg-image-attach" style="margin-top:6px; max-width:260px;"><img src="' + matchedImg.dataUrl + '" data-full-img="' + matchedImg.dataUrl + '" class="chat-img-preview" style="width:100%; max-height:200px; object-fit:contain; border-radius:8px; border:1px solid var(--rule-soft); cursor:zoom-in;" title="点击放大查看"></div>';
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

function setAssistantTyping(on) {
  const box = document.getElementById('assistantChat');
  if (!box) return;
  box.querySelectorAll('.assistant-typing-msg').forEach(el => el.remove());
  if (on) {
    const div = document.createElement('div');
    div.className = 'assistant-msg bot assistant-typing-msg';
    div.innerHTML = `<span class="role">AI</span><div class="bubble"><span class="assistant-typing"><span></span><span></span><span></span></span> <span style="color:var(--ink-mute);font-size:11px;">思考中…</span></div>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }
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
  return '';
}

// 流式中从未完成 JSON 中提取 "reply": "...部分..." 的可见字符
// 若找不到 JSON reply 字段则回退到显示纯净文本（避免推理模型前端空白）
function _extractStreamingReply(s) {
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

async function runAssistantTurn(userInput) {
  if (assistantBusy) { showToast('AI 正在思考中...'); return; }
  if (!getActiveProvider()) { showToast('请先在「设置 → AI」中配置模型'); openSettingsModal('ai'); return; }

  // 持久化到会话历史里的附件快照不写 dataUrl（避免 localStorage 膨胀 + 渲染缺字段崩溃）
  const attachSnapshot = pendingAttachments.length
    ? pendingAttachments.map(a => a.type === 'image'
        ? { type: 'image', title: a.name || '图片' }
        : { type: a.type, id: a.id, title: a.title })
    : undefined;
  pushAssistantMessage('user', userInput, attachSnapshot ? { attachments: attachSnapshot } : undefined);

  const sysPrompt = buildAssistantSystemPrompt();
  const ctx = [{ role: 'system', content: sysPrompt }];
  const s = getActiveSession();
  const recent = (s?.messages || []).slice(-12);
  const provider = getActiveProvider();
  const mm = !!(provider && provider.multimodal);
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
    else if (m.role === 'assistant') ctx.push({ role: 'assistant', content: m.raw || m.content });
    else if (m.role === 'system') ctx.push({ role: 'user', content: '【工具结果】' + m.content });
  }

  assistantBusy = true;
  try {
    let iter = 0;
    while (iter++ < 20) {
      setAssistantTyping(true);
      let raw;
      try {
        raw = await callAi(ctx, {
          temperature: 0.3,
          stream: false
        });
      } finally { setAssistantTyping(false); }

      const parsed = parseAssistantReply(raw);
      const actionMeta = [];
      const searchResults = [];

      for (const a of (parsed.actions || [])) {
        const name = a.tool || a.name;
        const args = a.args || a.arguments || {};
        try {
          const result = await runAssistantTool(name, args);
          actionMeta.push({ tool: name, summary: summarizeActionResult(name, result) });
          if (name === 'search_notes' && Array.isArray(result)) for (const r of result) searchResults.push({ kind: 'note', id: r.id, title: r.title, snippet: r.snippet, updatedAt: r.updatedAt });
          else if (name === 'search_todos' && Array.isArray(result)) for (const r of result) searchResults.push({ kind: 'todo', id: r.id, title: r.text, snippet: r.done ? '已完成' : '进行中', dueAt: r.dueAt });
          else if (name === 'list_notebooks' && Array.isArray(result)) for (const r of result) searchResults.push({ kind: 'notebook', id: r.id, title: r.name });
          const resultStr = JSON.stringify(result).slice(0, 1500);
          ctx.push({ role: 'assistant', content: raw });
          ctx.push({ role: 'user', content: '【工具结果】' + name + ': ' + resultStr });
          pushAssistantMessage('system', name + ': ' + resultStr);
        } catch (e) {
          actionMeta.push({ tool: name, error: e.message || String(e) });
          ctx.push({ role: 'assistant', content: raw });
          ctx.push({ role: 'user', content: '【工具错误】' + name + ': ' + (e.message || e) });
        }
      }

      pushAssistantMessage('assistant', parsed.reply || '', { actions: actionMeta.length ? actionMeta : undefined, searchResults: searchResults.length ? searchResults : undefined, raw });
      if (!parsed.actions || !parsed.actions.length) break;
    }
  } catch (e) {
    pushAssistantMessage('assistant', '出错：' + (e.message || String(e)));
    if (typeof logError === 'function') logError(e, 'assistant');
  } finally {
    assistantBusy = false;
    setAssistantTyping(false);
  }
}

// ===================== 左侧栏：AI 分组渲染 =====================

function renderAssistantRail() {
  const el = document.getElementById('assistantGroupListRail');
  if (!el) return;
  el.innerHTML = assistantGroups.map(g => {
    const isActive = assistantInAiView && g.id === assistantActiveGroupId;
    const sessionCount = (g.sessions || []).length;
    return `<div class="rail-item ${isActive ? 'active' : ''}" data-view="ai:${escapeHtml(g.id)}" data-ai-group="${escapeHtml(g.id)}" role="button" tabindex="0">
      <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" style="width:14px;height:14px;flex-shrink:0"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12c0 4.4-4 8-9 8a9.4 9.4 0 01-3.5-.7L3 21l1.5-4.3A8.3 8.3 0 013 12c0-4.4 4-8 9-8s9 3.6 9 8z"/></svg>
      <span class="rail-item-label" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
      <span class="rail-item-count">${sessionCount}</span>
      <span class="nb-actions">
        <button data-action="edit-group" data-gid="${escapeHtml(g.id)}" title="重命名">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button data-action="delete-group" data-gid="${escapeHtml(g.id)}" title="删除">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7M3 7h18M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>
        </button>
      </span>
    </div>`;
  }).join('');

  el.querySelectorAll('.rail-item[data-ai-group] button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const gid = btn.dataset.gid;
      const g = assistantGroups.find(x => x.id === gid);
      if (!g) return;
      if (action === 'edit-group') {
        const item = btn.closest('.rail-item');
        startInlineRename(item, '.rail-item-label', g.name, (val) => renameAssistantGroup(gid, val));
      } else if (action === 'delete-group') {
        if (confirm('删除分组「' + g.name + '」？该分组下所有会话将一并删除。')) deleteAssistantGroup(gid);
      }
    });
  });

  // v1.2.1 拖拽排序：AI 分组
  if (typeof window.enableDragReorder === 'function') {
    el.querySelectorAll('.rail-item[data-ai-group]').forEach(it => { it.dataset.dragKey = it.dataset.aiGroup; });
    window.enableDragReorder(el, '.rail-item[data-ai-group]', (src, dst) => {
      if (window.reorderArrayById(assistantGroups, src, dst)) {
        saveAssistantGroups();
        renderAssistantRail();
      }
    });
  }
}

// ===================== 中侧栏：会话列表渲染 =====================

function renderAssistantSessions() {
  const titleEl = document.getElementById('aiSessionsTitle');
  const listEl = document.getElementById('aiSessionsList');
  if (!listEl) return;
  const g = getActiveGroup();
  if (titleEl) titleEl.textContent = g?.name || 'AI 分组';
  if (!g) { listEl.innerHTML = ''; return; }
  listEl.innerHTML = (g.sessions || []).map(s => {
    const isActive = s.id === assistantActiveSessionId;
    const msgCount = (s.messages || []).length;
    return `<div class="ai-session-item ${isActive ? 'active' : ''}" data-sid="${escapeHtml(s.id)}">
      <span class="session-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
      <span class="session-meta">${msgCount}</span>
      <span class="session-actions">
        <button class="session-action-btn" data-action="rename" title="重命名"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="session-action-btn" data-action="delete" title="删除"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6M3 7h18M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg></button>
      </span>
    </div>`;
  }).join('');

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
      const sid = btn.closest('.ai-session-item')?.dataset.sid;
      const s = (g.sessions || []).find(x => x.id === sid);
      if (!s) return;
      const item = btn.closest('.ai-session-item');
      startInlineRename(item, '.session-name', s.name, (val) => renameAssistantSession(g.id, sid, val));
    });
  });
  listEl.querySelectorAll('.session-action-btn[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = btn.closest('.ai-session-item')?.dataset.sid;
      if (!sid) return;
      if (confirm('删除该会话？')) deleteAssistantSession(g.id, sid);
    });
  });

  // v1.2.1 拖拽排序：AI 会话
  if (typeof window.enableDragReorder === 'function') {
    listEl.querySelectorAll('.ai-session-item').forEach(it => { it.dataset.dragKey = it.dataset.sid; });
    window.enableDragReorder(listEl, '.ai-session-item', (src, dst) => {
      if (window.reorderArrayById(g.sessions || [], src, dst)) {
        saveAssistantGroups();
        renderAssistantSessions();
      }
    });
  }
}

// 兼容旧名（runAssistantTurn 等其它代码若引用）
function renderAssistantGroups() { renderAssistantRail(); if (assistantInAiView) renderAssistantSessions(); }

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
  if (app) app.classList.add('ai-view');
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

  // 新建分组（左侧栏）
  const newGroupBtn = document.getElementById('newAssistantGroupBtn');
  if (newGroupBtn) newGroupBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const g = createAssistantGroup('新分组');
    setTimeout(() => {
      const item = document.querySelector(`.rail-item[data-ai-group="${g.id}"]`);
      if (item) startInlineRename(item, '.rail-item-label', g.name, (val) => renameAssistantGroup(g.id, val));
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

  // 新建对话（助手侧栏头部 "+新对话" 按钮）
  const assistantNewGrpBtn = document.getElementById('assistantNewGroupBtn');
  if (assistantNewGrpBtn) assistantNewGrpBtn.addEventListener('click', () => {
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
  if (clearBtn) clearBtn.addEventListener('click', () => { if (confirm('清空当前会话历史？')) clearActiveSessionHistory(); });

  // 记忆管理面板
  const memBtn = document.getElementById('assistantMemoryBtn');
  const memPanel = document.getElementById('assistantMemoryPanel');
  const memChat = document.getElementById('assistantChat');
  const memInputRow = document.getElementById('assistantInputRow');
  const memAttachRow = document.getElementById('assistantAttachments');
  if (memBtn && memPanel) {
    function renderMemoryList() {
      const list = document.getElementById('memoryList');
      if (!list) return;
      const arr = loadMemories();
      const catLabel = { preference: '偏好', fact: '事实', context: '上下文', other: '其他' };
      if (!arr.length) { list.innerHTML = '<div class="memory-empty">暂无记忆<br><span style="font-size:11px">和 AI 助手对话时说"记住…"即可自动保存</span></div>'; return; }
      list.innerHTML = arr.map((m, i) => `<div class="memory-item" data-idx="${i}"><span class="mem-cat">${catLabel[m.category] || '其他'}</span><div class="mem-body"><div class="mem-key">${escapeHtml(m.key)}</div><div class="mem-val">${escapeHtml(m.value)}</div></div><button class="mem-del" data-key="${escapeHtml(m.key)}" title="删除">✕</button></div>`).join('');
      list.querySelectorAll('.mem-del').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.key;
          const mArr = loadMemories().filter(x => x.key !== key);
          saveMemories(mArr);
          renderMemoryList();
        });
      });
    }
    memBtn.addEventListener('click', () => {
      const showing = memPanel.style.display !== 'none';
      if (showing) {
        memPanel.style.display = 'none';
        if (memChat) memChat.style.display = '';
        if (memInputRow) memInputRow.style.display = '';
        if (memAttachRow) memAttachRow.style.display = '';
      } else {
        memPanel.style.display = '';
        if (memChat) memChat.style.display = 'none';
        if (memInputRow) memInputRow.style.display = 'none';
        if (memAttachRow) memAttachRow.style.display = 'none';
        renderMemoryList();
      }
    });
    const memClose = document.getElementById('memoryPanelClose');
    if (memClose) memClose.addEventListener('click', () => memBtn.click());
    const memAddBtn = document.getElementById('memoryAddBtn');
    if (memAddBtn) memAddBtn.addEventListener('click', () => {
      const keyEl = document.getElementById('memoryKeyInput');
      const valEl = document.getElementById('memoryValueInput');
      const catEl = document.getElementById('memoryCategoryInput');
      const key = (keyEl?.value || '').trim();
      const value = (valEl?.value || '').trim();
      if (!key || !value) { if (typeof showToast === 'function') showToast('请填写关键词和内容'); return; }
      const arr = loadMemories();
      const idx = arr.findIndex(m => m.key === key);
      const entry = { key, value, category: catEl?.value || 'other', createdAt: idx >= 0 ? arr[idx].createdAt : Date.now(), updatedAt: Date.now() };
      if (idx >= 0) arr[idx] = entry; else arr.push(entry);
      saveMemories(arr);
      if (keyEl) keyEl.value = '';
      if (valEl) valEl.value = '';
      renderMemoryList();
    });
  }

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
  const submit = () => {
    const v = (input?.value || '').trim();
    if (!v) return;
    if (input) input.value = '';
    runAssistantTurn(v);
  };
  if (send) send.addEventListener('click', submit);
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });

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
