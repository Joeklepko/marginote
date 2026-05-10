// =====================================================================
// AI 助手（Skill 系统：工具调用 + 对话 + 多会话 + 附件）
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
let assistantGroups = [];        // [{id, name, createdAt, messages: [...]}]
let assistantActiveGroupId = null;
let assistantBusy = false;

// ===================== 会话组管理 =====================

function loadAssistantGroups() {
  try {
    const raw = localStorage.getItem(ASSISTANT_GROUPS_KEY);
    assistantGroups = raw ? JSON.parse(raw) : [];
  } catch { assistantGroups = []; }
  // 迁移旧版单会话数据
  if (!assistantGroups.length) {
    try {
      const oldRaw = localStorage.getItem('marginote.assistantHistory');
      const oldMessages = oldRaw ? JSON.parse(oldRaw) : [];
      if (oldMessages.length) {
        assistantGroups = [{ id: uid(), name: '默认对话', createdAt: Date.now(), messages: oldMessages }];
        localStorage.removeItem('marginote.assistantHistory');
      }
    } catch {}
  }
  if (!assistantGroups.length) {
    assistantGroups = [{ id: uid(), name: '默认对话', createdAt: Date.now(), messages: [] }];
  }
  assistantActiveGroupId = assistantGroups[0].id;
}

function getActiveGroup() {
  let g = assistantGroups.find(x => x.id === assistantActiveGroupId);
  if (!g) {
    assistantActiveGroupId = assistantGroups[0]?.id;
    g = assistantGroups[0];
  }
  return g;
}

function saveAssistantGroups() {
  try {
    const clean = assistantGroups.map(g => ({
      ...g,
      messages: g.messages.slice(-ASSISTANT_HISTORY_MAX)
    }));
    localStorage.setItem(ASSISTANT_GROUPS_KEY, JSON.stringify(clean));
  } catch {}
}

function createAssistantGroup(name) {
  const g = { id: uid(), name: String(name || '新对话').trim(), createdAt: Date.now(), messages: [] };
  assistantGroups.unshift(g);
  assistantActiveGroupId = g.id;
  saveAssistantGroups();
  renderAssistantGroups();
  renderAssistantChat();
  return g;
}

function deleteAssistantGroup(id) {
  if (assistantGroups.length <= 1) {
    showToast('至少保留一个对话');
    return;
  }
  assistantGroups = assistantGroups.filter(g => g.id !== id);
  if (assistantActiveGroupId === id) {
    assistantActiveGroupId = assistantGroups[0].id;
  }
  saveAssistantGroups();
  renderAssistantGroups();
  renderAssistantChat();
}

function renameAssistantGroup(id, name) {
  const g = assistantGroups.find(x => x.id === id);
  if (g) { g.name = String(name || '未命名').trim(); }
  saveAssistantGroups();
  renderAssistantGroups();
}

function clearActiveGroupHistory() {
  const g = getActiveGroup();
  if (!g) return;
  g.messages = [];
  saveAssistantGroups();
  renderAssistantChat();
}

// ===================== 附件管理 =====================

// 当前待发送消息的附件
let pendingAttachments = [];   // [{type: 'note'|'todo', id, title}]

function addPendingAttachment(type, id, title) {
  // 去重
  if (pendingAttachments.some(a => a.type === type && a.id === id)) return;
  pendingAttachments.push({ type, id, title: String(title || '') });
  renderPendingAttachments();
}

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
    const icon = a.type === 'note' ?
      '<svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" style="width:12px;height:12px"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h12"/></svg>' :
      '<svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" style="width:12px;height:12px"><path stroke-linecap="round" stroke-linejoin="round" d="M9 11l3 3L22 4"/></svg>';
    return `<span class="attach-pill" title="点击移除 ${escapeHtml(a.title)}" data-remove="${i}">${icon} ${escapeHtml(a.title.slice(0, 20))}${a.title.length > 20 ? '…' : ''} ×</span>`;
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

  // 过滤掉已删除和非活跃的
  const activeNotes = notes.filter(n => !n.deleted);
  const activeTodos = todos.slice();

  let html = '<div class="attach-picker-section"><div class="attach-picker-title">📝 笔记</div>';
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
  list.querySelectorAll('.attach-picker-item').forEach(item => {
    item.addEventListener('click', () => {
      const type = item.dataset.type;
      const id = item.dataset.id;
      const title = item.dataset.title;
      if (item.classList.contains('selected')) {
        // 找到并移除
        const idx = pendingAttachments.findIndex(a => a.type === type && a.id === id);
        if (idx >= 0) removePendingAttachment(idx);
      } else {
        addPendingAttachment(type, id, title);
      }
      renderAttachmentPickerContent();
    });
  });
}

// ===================== 工具定义 =====================

const ASSISTANT_TOOLS = {
  list_notebooks: {
    desc: '列出所有笔记本（参数：无）',
    run: () => notebooks.map(nb => ({ id: nb.id, name: nb.name, color: nb.color }))
  },

  search_notes: {
    desc: '搜索笔记。参数：{query: string, limit?: number(默认10)}',
    run: ({ query, limit }) => {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));
      return notes
        .filter(n => !n.deleted)
        .filter(n =>
          (n.title || '').toLowerCase().includes(q) ||
          (n.content || '').toLowerCase().includes(q))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, lim)
        .map(n => ({
          id: n.id,
          title: n.title || '(无标题)',
          snippet: (n.content || '').slice(0, 120).replace(/\s+/g, ' '),
          notebookId: n.notebookId,
          updatedAt: n.updatedAt
        }));
    }
  },

  search_todos: {
    desc: '搜索待办。参数：{query?: string, status?: "active"|"done"|"overdue"|"all", limit?: number}',
    run: ({ query, status, limit }) => {
      const q = String(query || '').trim().toLowerCase();
      const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));
      const now = Date.now();
      let list = todos.slice();
      if (status === 'active') list = list.filter(t => !t.done);
      else if (status === 'done') list = list.filter(t => t.done);
      else if (status === 'overdue') list = list.filter(t => !t.done && t.dueDate && t.dueDate < now);
      if (q) list = list.filter(t => (t.text || '').toLowerCase().includes(q));
      return list
        .sort((a, b) => (a.dueDate || Infinity) - (b.dueDate || Infinity))
        .slice(0, lim)
        .map(t => ({
          id: t.id,
          text: t.text,
          done: !!t.done,
          dueAt: t.dueDate ? new Date(t.dueDate).toISOString() : null,
          remindBeforeMin: t.remindBeforeMin || 0
        }));
    }
  },

  create_note: {
    desc: '新建笔记。参数：{title: string, content?: string, notebookName?: string}',
    run: ({ title, content, notebookName }) => {
      let nb = null;
      if (notebookName) {
        nb = notebooks.find(x => x.name === notebookName) || null;
        if (!nb) {
          nb = { id: uid(), name: String(notebookName), color: '#525252', createdAt: Date.now() };
          notebooks.push(nb);
        }
      } else {
        nb = notebooks[0] || null;
        if (!nb) {
          nb = { id: uid(), name: '默认', color: '#525252', createdAt: Date.now() };
          notebooks.push(nb);
        }
      }
      const note = {
        id: uid(),
        notebookId: nb.id,
        folderId: null,
        title: String(title || '无标题'),
        content: String(content || ''),
        tags: [],
        starred: false,
        deleted: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      notes.unshift(note);
      saveData();
      renderNotebooks();
      renderNotesList();
      return { id: note.id, title: note.title, notebookId: nb.id, notebookName: nb.name };
    }
  },

  create_todo: {
    desc: '新建待办。参数：{text: string, dueAt?: ISO 8601 字符串, remindBeforeMin?: number}',
    run: ({ text, dueAt, remindBeforeMin }) => {
      if (!text) throw new Error('text 必填');
      let dueDate = null;
      if (dueAt) {
        const d = new Date(dueAt);
        if (!isNaN(d.getTime())) dueDate = d.getTime();
      }
      const t = {
        id: uid(),
        text: String(text),
        content: '',
        done: false,
        dueDate,
        remindBeforeMin: parseInt(remindBeforeMin, 10) || 0,
        remindCount: 1,
        remindIntervalMin: 5,
        createdAt: Date.now(),
        completedAt: null
      };
      todos.push(t);
      saveData();
      try { scheduleTodoReminders(t); } catch {}
      renderTodos();
      renderTodoCounts();
      return {
        id: t.id,
        text: t.text,
        dueAt: dueDate ? new Date(dueDate).toISOString() : null,
        remindBeforeMin: t.remindBeforeMin
      };
    }
  },

  update_note: {
    desc: '修改笔记（优先作用于当前附件笔记）。参数：{id?: string, title?: string, content?: string}。不传 id 时自动使用当前附件中的第一篇文章笔记。',
    run: ({ id, title, content }) => {
      // 自动补 id：优先使用当前附件中的笔记
      if (!id && pendingAttachments.length) {
        const att = pendingAttachments.find(a => a.type === 'note');
        if (att) id = att.id;
      }
      const n = notes.find(x => x.id === id);
      if (!n) throw new Error('笔记未找到：' + (id || '(未指定)'));
      if (typeof title === 'string') n.title = title;
      if (typeof content === 'string') n.content = content;
      n.updatedAt = Date.now();
      saveData();
      renderNotesList();
      if (typeof selectNote === 'function' && id === (window._currentNoteId || '')) {
        // 如果当前编辑的正是被修改的笔记，刷新编辑器
        selectNote(n);
      }
      return { id: n.id, title: n.title };
    }
  },

  update_todo: {
    desc: '修改待办（优先作用于当前附件待办）。参数：{id?: string, text?: string, content?: string, done?: boolean, dueAt?: ISO 8601}。不传 id 时自动使用当前附件中的第一个待办。',
    run: ({ id, text, content, done, dueAt }) => {
      // 自动补 id：优先使用当前附件中的待办
      if (!id && pendingAttachments.length) {
        const att = pendingAttachments.find(a => a.type === 'todo');
        if (att) id = att.id;
      }
      const t = todos.find(x => x.id === id);
      if (!t) throw new Error('待办未找到：' + (id || '(未指定)'));
      if (typeof text === 'string') t.text = text;
      if (typeof content === 'string') t.content = content;
      if (typeof done === 'boolean') {
        t.done = done;
        if (done) t.completedAt = Date.now();
        else t.completedAt = null;
      }
      if (dueAt !== undefined) {
        const d = new Date(dueAt);
        if (!isNaN(d.getTime())) t.dueDate = d.getTime();
        else t.dueDate = null;
      }
      saveData();
      renderTodos();
      renderTodoCounts();
      return { id: t.id, text: t.text, done: !!t.done };
    }
  },

  optimize_text: {
    desc: '调用 AI 按 instruction 改写 text。参数：{text: string, instruction: string}',
    run: async ({ text, instruction }) => {
      if (!text || !instruction) throw new Error('text 与 instruction 必填');
      const out = await callAi([
        { role: 'system', content: '你是中文写作助手。按用户的指令直接重写给定文本，仅输出最终结果，不解释。' },
        { role: 'user', content: `指令：${instruction}\n\n原文：\n${text}` }
      ]);
      return { result: out };
    }
  }
};

// ===================== 系统提示词 =====================

function buildAssistantSystemPrompt() {
  const now = new Date();
  const tools = Object.entries(ASSISTANT_TOOLS)
    .map(([n, t]) => `- ${n}: ${t.desc}`)
    .join('\n');

  let attachInfo = '';
  if (pendingAttachments.length) {
    const parts = [];
    for (const a of pendingAttachments) {
      if (a.type === 'note') {
        const n = notes.find(x => x.id === a.id);
        if (n) {
          parts.push(`[笔记附件: id=${n.id}, 标题=${n.title || '(无标题)'}, 内容=${(n.content || '').slice(0, 2000)}]`);
        }
      } else if (a.type === 'todo') {
        const t = todos.find(x => x.id === a.id);
        if (t) {
          parts.push(`[待办附件: id=${t.id}, 标题=${t.text}, 完成=${t.done ? '是' : '否'}, 内容=${(t.content || '').slice(0, 2000)}, 截止=${t.dueDate ? new Date(t.dueDate).toISOString() : '无'}]`);
        }
      }
    }
    if (parts.length) {
      attachInfo = '\n\n【当前附件（用户已将以下笔记/待办附加到对话中）】\n' + parts.join('\n') +
        '\n【注意】当用户要求修改附件中的内容时，请使用 update_note / update_todo 工具直接操作。不传 id 参数时系统会自动使用附件中的第一个对应类型。';
    }
  }

  return `你是 Marginote 笔记应用内置的 AI 助手，帮用户管理笔记和待办。

当前时间（用户本地时区）：${now.toString()}
ISO：${now.toISOString()}
笔记本数：${notebooks.length}，笔记数：${notes.filter(n => !n.deleted).length}，待办数：${todos.length}${attachInfo}

【可用工具】
${tools}

【输出协议】
你的每次回复必须是合法 JSON，仅输出 JSON，不要包裹代码块、不要附加任何文字：
{"reply": "给用户的中文文字回复", "actions": [{"tool": "工具名", "args": { ... }}]}

- reply：给用户看的中文消息
- actions：本轮要执行的工具调用数组，没有就给 []
- 工具结果会以 system 消息回传，你可据此继续回复或追加新 actions
- 当任务完成、不再需要工具时，回复带最终总结，actions 设为空数组

【时间解析】
- 用户给相对时间（"明天3点"、"周五下午2点"）时，请基于"当前时间"换算成 ISO 8601（含时区偏移），写入 dueAt
- "提前2小时提醒" → remindBeforeMin: 120
- 默认时间未指定 AM/PM 时按上下文判断（"3点"通常指当天 15:00 之后；"上午3点"=03:00）

【示例】
用户："帮我新建待办 查阅机票，明天15:00 完成，提前2小时提醒"
你输出：
{"reply":"已为您创建待办","actions":[{"tool":"create_todo","args":{"text":"查阅机票","dueAt":"2026-05-08T15:00:00+08:00","remindBeforeMin":120}}]}

用户："查一下和'内存可靠性'相关的笔记"
你输出：
{"reply":"为您搜索","actions":[{"tool":"search_notes","args":{"query":"内存可靠性"}}]}
（拿到 system 工具结果后，再总结：）
{"reply":"找到 3 篇相关笔记，列在下方。","actions":[]}
`;
}

// ===================== AI 核心逻辑 =====================

function parseAssistantReply(raw) {
  if (!raw) return { reply: '', actions: [] };
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(s);
    return {
      reply: typeof obj.reply === 'string' ? obj.reply : '',
      actions: Array.isArray(obj.actions) ? obj.actions : []
    };
  } catch {
    return { reply: raw, actions: [] };
  }
}

async function runAssistantTool(name, args) {
  const t = ASSISTANT_TOOLS[name];
  if (!t) throw new Error('未知工具：' + name);
  return await t.run(args || {});
}

function renderAssistantChat() {
  const box = document.getElementById('assistantChat');
  if (!box) return;
  const g = getActiveGroup();
  if (!g || !g.messages.length) {
    box.innerHTML = `
      <div class="assistant-empty">
        <div>问我点什么吧 👋</div>
        <div class="examples">
          <ul style="list-style:none; padding:0;">
            <li data-ex="帮我新建一个待办「查阅机票」，明天15:00完成，提前2小时提醒">· 帮我新建一个待办「查阅机票」，明天15:00完成，提前2小时提醒</li>
            <li data-ex="查一下和「内存可靠性」相关的笔记">· 查一下和「内存可靠性」相关的笔记</li>
            <li data-ex="新建一篇笔记「会议纪要」，内容写：今天讨论了 Q3 路线图。">· 新建一篇笔记「会议纪要」，内容写：今天讨论了 Q3 路线图</li>
            <li data-ex="列出所有未完成的待办">· 列出所有未完成的待办</li>
          </ul>
        </div>
      </div>`;
    box.querySelectorAll('.examples li').forEach(li => {
      li.addEventListener('click', () => {
        document.getElementById('assistantInput').value = li.dataset.ex || '';
        document.getElementById('assistantInput').focus();
      });
    });
    return;
  }
  box.innerHTML = g.messages.map(m => renderAssistantMessage(m)).join('');
  box.querySelectorAll('.result-item[data-note-id]').forEach(el => {
    el.addEventListener('click', () => {
      const n = notes.find(x => x.id === el.dataset.noteId);
      if (n) { closeAssistantModal(); selectNote(n); }
    });
  });
  box.scrollTop = box.scrollHeight;
}

function renderAssistantMessage(m) {
  const role = m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'bot');
  const roleLabel = m.role === 'user' ? '我' : (m.role === 'system' ? '工具' : 'AI');
  let html = `<div class="assistant-msg ${role}"><span class="role">${roleLabel}</span><div class="bubble">${escapeHtml(m.content || '')}</div>`;
  // 附件标签
  if (m.attachments && m.attachments.length) {
    html += '<div class="msg-attachments">';
    for (const a of m.attachments) {
      const icon = a.type === 'note' ?
        '<svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" style="width:10px;height:10px"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h12"/></svg>' :
        '<svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" style="width:10px;height:10px"><path stroke-linecap="round" stroke-linejoin="round" d="M9 11l3 3L22 4"/></svg>';
      html += `<span class="msg-attach-pill" data-type="${escapeHtml(a.type)}" data-id="${escapeHtml(a.id)}">${icon} ${escapeHtml(a.title.slice(0, 30))}</span>`;
    }
    html += '</div>';
  }
  if (m.actions && m.actions.length) {
    html += '<div class="actions">';
    for (const a of m.actions) {
      const cls = a.error ? 'err' : 'ok';
      const label = a.error ? `${a.tool} ✗ ${a.error}` : `${a.tool} ✓ ${a.summary || ''}`;
      html += `<span class="action-pill ${cls}">${escapeHtml(label)}</span>`;
    }
    html += '</div>';
  }
  if (m.searchResults && m.searchResults.length) {
    html += '<div class="result-list">';
    for (const r of m.searchResults) {
      const meta = r.dueAt ? `截止 ${formatFullDate(new Date(r.dueAt).getTime())}` : (r.updatedAt ? `更新 ${formatFullDate(r.updatedAt)}` : '');
      const dataAttr = r.kind === 'note' ? `data-note-id="${escapeHtml(r.id)}"` : '';
      const title = r.title || r.text || '(无标题)';
      html += `<div class="result-item" ${dataAttr}><div class="title">${escapeHtml(title)}</div>${r.snippet ? `<div class="meta">${escapeHtml(r.snippet)}</div>` : ''}${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}</div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function pushAssistantMessage(role, content, extra) {
  const g = getActiveGroup();
  if (!g) return;
  const m = { role, content: String(content || ''), ts: Date.now() };
  if (extra) Object.assign(m, extra);
  g.messages.push(m);
  saveAssistantGroups();
  renderAssistantChat();
  return m;
}

function setAssistantTyping(on) {
  const box = document.getElementById('assistantChat');
  if (!box) return;
  box.querySelectorAll('.assistant-typing-msg').forEach(el => el.remove());
  if (on) {
    const div = document.createElement('div');
    div.className = 'assistant-msg bot assistant-typing-msg';
    div.innerHTML = `<span class="role">AI</span><div class="bubble"><span class="assistant-typing"><span></span><span></span><span></span></span></div>`;
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
  if (name === 'optimize_text') return `已优化文本`;
  return '';
}

async function runAssistantTurn(userInput) {
  if (assistantBusy) { showToast('AI 正在思考中...'); return; }
  if (!getActiveProvider()) { showToast('请先在「设置 → AI」中配置模型'); openSettingsModal('ai'); return; }

  // 记录附件快照到消息
  const attachSnapshot = pendingAttachments.length ? [...pendingAttachments] : undefined;
  pushAssistantMessage('user', userInput, attachSnapshot ? { attachments: attachSnapshot } : undefined);

  const sysPrompt = buildAssistantSystemPrompt();
  const ctx = [{ role: 'system', content: sysPrompt }];
  const g = getActiveGroup();
  const recent = (g?.messages || []).slice(-12);
  for (const m of recent) {
    if (m.role === 'user') ctx.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') ctx.push({ role: 'assistant', content: m.content });
    else if (m.role === 'system') ctx.push({ role: 'user', content: '【工具结果】' + m.content });
  }

  assistantBusy = true;
  try {
    let iter = 0;
    while (iter++ < 4) {
      setAssistantTyping(true);
      let raw;
      try { raw = await callAi(ctx, { temperature: 0.3 }); }
      finally { setAssistantTyping(false); }

      const parsed = parseAssistantReply(raw);
      const actionMeta = [];
      const searchResults = [];

      for (const a of (parsed.actions || [])) {
        const name = a.tool || a.name;
        const args = a.args || a.arguments || {};
        try {
          const result = await runAssistantTool(name, args);
          actionMeta.push({ tool: name, summary: summarizeActionResult(name, result) });
          if (name === 'search_notes' && Array.isArray(result)) {
            for (const r of result) searchResults.push({ kind: 'note', id: r.id, title: r.title, snippet: r.snippet, updatedAt: r.updatedAt });
          } else if (name === 'search_todos' && Array.isArray(result)) {
            for (const r of result) searchResults.push({ kind: 'todo', id: r.id, title: r.text, snippet: r.done ? '已完成' : '进行中', dueAt: r.dueAt });
          } else if (name === 'list_notebooks' && Array.isArray(result)) {
            for (const r of result) searchResults.push({ kind: 'notebook', id: r.id, title: r.name });
          }
          ctx.push({ role: 'assistant', content: raw });
          ctx.push({ role: 'user', content: '【工具结果】' + name + ': ' + JSON.stringify(result).slice(0, 1500) });
        } catch (e) {
          actionMeta.push({ tool: name, error: e.message || String(e) });
          ctx.push({ role: 'assistant', content: raw });
          ctx.push({ role: 'user', content: '【工具错误】' + name + ': ' + (e.message || e) });
        }
      }

      pushAssistantMessage('assistant', parsed.reply || '', {
        actions: actionMeta.length ? actionMeta : undefined,
        searchResults: searchResults.length ? searchResults : undefined,
        raw
      });

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

// ===================== 会话组列表渲染 =====================

function renderAssistantGroups() {
  const el = document.getElementById('assistantGroupList');
  if (!el) return;
  const active = assistantActiveGroupId;
  el.innerHTML = assistantGroups.map(g => {
    const isActive = g.id === active;
    const msgCount = (g.messages || []).length;
    return `<div class="assistant-group-item ${isActive ? 'active' : ''}" data-gid="${escapeHtml(g.id)}">
      <span class="group-name">${escapeHtml(g.name || '默认对话')}</span>
      <span class="group-meta">${msgCount} 条</span>
      <span class="group-actions">
        <button class="group-action-btn" data-action="rename" title="重命名">
          <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" style="width:12px;height:12px"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="group-action-btn" data-action="delete" title="删除">
          <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" style="width:12px;height:12px"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6M3 7h18M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>
        </button>
      </span>
    </div>`;
  }).join('');

  // 绑定事件
  el.querySelectorAll('.assistant-group-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // 排除按钮点击
      if (e.target.closest('.group-action-btn')) return;
      const gid = item.dataset.gid;
      if (gid && gid !== assistantActiveGroupId) {
        assistantActiveGroupId = gid;
        // 切换会话时不保留附件
        clearPendingAttachments();
        renderAssistantGroups();
        renderAssistantChat();
      }
    });
  });

  // 重命名
  el.querySelectorAll('.group-action-btn[data-action="rename"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = btn.closest('.assistant-group-item')?.dataset.gid;
      if (!gid) return;
      const g = assistantGroups.find(x => x.id === gid);
      if (!g) return;
      const newName = prompt('新名称：', g.name || '');
      if (newName !== null && newName.trim()) {
        renameAssistantGroup(gid, newName.trim());
      }
    });
  });

  // 删除
  el.querySelectorAll('.group-action-btn[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = btn.closest('.assistant-group-item')?.dataset.gid;
      if (!gid) return;
      if (confirm('确定删除这个对话？')) {
        deleteAssistantGroup(gid);
      }
    });
  });
}

// ===================== 模态框 =====================

function openAssistantModal() {
  renderAssistantGroups();
  renderAssistantChat();
  renderPendingAttachments();
  document.getElementById('assistantModalBg').classList.add('show');
  setTimeout(() => document.getElementById('assistantInput')?.focus(), 80);
}

function closeAssistantModal() {
  document.getElementById('assistantModalBg').classList.remove('show');
}

// ===================== UI 绑定 =====================

function bindAssistantUi() {
  loadAssistantGroups();

  const btn = document.getElementById('aiAssistantBtn');
  if (btn) btn.addEventListener('click', openAssistantModal);
  const closeX = document.getElementById('assistantCloseX');
  if (closeX) closeX.addEventListener('click', closeAssistantModal);

  // 清空当前对话
  const clearBtn = document.getElementById('assistantClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (confirm('清空当前 AI 助手对话历史？')) clearActiveGroupHistory();
  });

  // 新建对话
  const newBtn = document.getElementById('assistantNewGroupBtn');
  if (newBtn) newBtn.addEventListener('click', () => {
    const name = prompt('对话名称：', '新对话');
    if (name !== null) createAssistantGroup(name || '新对话');
  });

  const bg = document.getElementById('assistantModalBg');
  if (bg) bg.addEventListener('click', e => { if (e.target.id === 'assistantModalBg') closeAssistantModal(); });

  // 附件按钮
  const attachBtn = document.getElementById('assistantAttachBtn');
  if (attachBtn) attachBtn.addEventListener('click', openAttachmentPicker);

  // 附件选择器关闭
  const attachClose = document.getElementById('attachmentPickerClose');
  if (attachClose) attachClose.addEventListener('click', closeAttachmentPicker);
  const attachBg = document.getElementById('attachmentPickerBg');
  if (attachBg) attachBg.addEventListener('click', e => { if (e.target.id === 'attachmentPickerBg') closeAttachmentPicker(); });

  const send = document.getElementById('assistantSendBtn');
  const input = document.getElementById('assistantInput');
  const submit = () => {
    const v = (input.value || '').trim();
    if (!v) return;
    input.value = '';
    runAssistantTurn(v);
  };
  if (send) send.addEventListener('click', submit);
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindAssistantUi);
} else {
  bindAssistantUi();
}
