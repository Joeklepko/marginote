// Marginote AI 助手的纯逻辑核心。
// 保持无 DOM / 无存储依赖，便于 Node 测试，也避免把检索与提示词策略继续堆在 UI 文件里。
(function (root, factory) {
  const skills = (root && root.MarginoteAssistantSkillCore)
    || (typeof module === 'object' && module.exports ? require('./assistant-skill-core.js') : null);
  const api = factory(skills);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteAssistantCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SkillCore) {
  if (!SkillCore) throw new Error('MarginoteAssistantSkillCore 未加载');
  const QUERY_NOISE = /(?:帮我|请问|麻烦|能不能|可以不可以|我想知道|告诉我|查一下|找一下|搜索一下|看一下|把下面(?:这段)?(?:话|内容)?|把以下(?:这段)?(?:话|内容)?|把这段(?:话|内容)?|记录一下|记下来|记一笔|写个笔记|写一篇笔记|存下来|保存一下|笔记里|笔记中|相关笔记|相关内容|是什么|是啥|怎么样|怎样|如何|为什么|什么时候|哪一天|多少|有没有|是否|一下|的话|呢|吗|啊|呀|吧)/g;
  const WRITE_RE = /(新建|创建|保存|添加|加入|修改|更新|改成|删除|移到|移动|重命名|归类|整理成|收藏|取消收藏|打标签|清理|润色|改写|续写|翻译)/;
  const RECORD_WRITE_RE = /(?:^|我想|请|帮我|麻烦|把这个|把这段|把以下内容)(?:记录|记下)|(?:记录|记下)(?:一篇|一笔|一下|来|下来|为笔记|到.{0,10}笔记)|(?:写进|存到|追加到|加到|放到).{0,10}(?:笔记|记录)|(?:写(?:一篇|个|条).{0,4}(?:笔记|记录)|记一笔|写下来|存下来|新增.{0,4}(?:笔记|记录))/;
  // “任务调度”“提醒功能”等也可能只是笔记主题；只有明确的个人待办语境才切到待办域。
  const TODO_RE = /(?:待办|截止|到期|今日安排|今天要做|本周要做|已完成|未完成|提醒我|(?:我的|查看|列出|有哪些|新建|创建|设置|今天|明天|本周).{0,6}(?:任务|提醒)|(?:任务|提醒).{0,6}(?:清单|列表|到期|截止|完成|未完成))/;
  const NOTE_QUERY_RE = /(查|找|搜|检索|笔记|记录里|之前写|提到|关于|回顾|总结|归纳|研究|什么时候|是什么|多少|为什么|怎么)/;
  const EFFICIENCY_RE = /(番茄钟|专注.*分钟|每日简报|今日简报|笔记统计|字数统计)/;
  const TODO_IMPLICIT_WRITE_RE = /(?:提醒我|设置?提醒|设个提醒|稍后提醒|(?:^|请|帮我|把|将|批量)完成.{0,6}(?:待办|任务)|标记为已完成)/;
  const MEMORY_DELETE_RE = /(?:删除|清除|忘掉).{0,10}(?:记忆|偏好|习惯|你记住的)|(?:记忆|偏好|习惯).{0,10}(?:删除|清除|忘掉)/;
  const MEMORY_SAVE_RE = /(?:请|帮我)?(?:记住|记得住|保存为记忆|保存到记忆|加入记忆)|(?:以后|今后).{0,10}(?:(?:请|要|都)?(?:记住|按照|称呼|使用)|叫我|称我为)/;
  const MEMORY_READ_RE = /(?:你|还)?记得.{0,10}(?:我|什么)|(?:查看|列出|查询|告诉我).{0,10}(?:记忆|偏好|习惯)|(?:我的|关于我的).{0,6}(?:偏好|习惯)/;

  function normalizeText(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function queryKeywords(value) {
    const original = normalizeText(value);
    const cleaned = original
      .replace(/[？?。.,，、!！:：;；"'“”‘’「」『』()（）\[\]{}<>《》]/g, ' ')
      .replace(QUERY_NOISE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || original;
  }

  function tokenize(value) {
    const text = queryKeywords(value);
    const out = new Set();
    const latin = text.match(/[a-z0-9][a-z0-9._+#/-]*/g) || [];
    latin.forEach(x => { if (x.length > 1 || /\d/.test(x)) out.add(x); });
    const chunks = text.match(/[\u3400-\u9fff]+/g) || [];
    for (const chunk of chunks) {
      if (chunk.length <= 4) out.add(chunk);
      for (let size = 2; size <= Math.min(3, chunk.length); size++) {
        for (let i = 0; i <= chunk.length - size; i++) out.add(chunk.slice(i, i + size));
      }
    }
    return [...out].slice(0, 48);
  }

  function classifyMemoryAction(value) {
    const text = normalizeText(value);
    if (MEMORY_DELETE_RE.test(text)) return 'delete';
    if (MEMORY_SAVE_RE.test(text)) return 'save';
    if (MEMORY_READ_RE.test(text)) return 'read';
    return null;
  }

  function classifyNoteCapabilities(value) {
    const text = normalizeText(value);
    const capabilities = new Set();
    const organizationTarget = /(?:笔记本|文件夹|标签)/.test(text);
    const existingNoteTarget = /(?:写进|存到|追加到|补充到|保存到|记录到|加到|放到).{0,12}(?:笔记|记录)/.test(text);
    if (/(?:新建|创建|新增|记录|记下|记一笔|写下来|存下来|写.{0,4}(?:笔记|记录)|保存|添加|加入)/.test(text) && !organizationTarget && !existingNoteTarget) capabilities.add('capture');
    if (existingNoteTarget || /(?:修改|更新|改成|追加|补充|续写|润色|改写|翻译|清理|优化|自动标题|整理成|添加.{0,8}(?:内容|段落))/.test(text)) capabilities.add('edit');
    if (/(?:移到|移动|重命名|归类|收藏|取消收藏|打标签|标签|文件夹|笔记本|合并|复制|归档)/.test(text)) capabilities.add('organize');
    // 删除条件通常会夹在动作和对象之间（例如“删除所有标题为空或者内容为空的笔记”）。
    // 不再用固定字符距离判断，避免复杂但明确的删除请求丢失最关键的权限能力。
    if (/(?:删除|清空)/.test(text) && /(?:笔记|记录|笔记本)/.test(text)) capabilities.add('delete');
    if (/(?:批量|这些|全部|所有|多篇|多条)/.test(text)) capabilities.add('batch');
    if (!capabilities.size) capabilities.add('edit');
    return [...capabilities];
  }

  function classifyTodoCapabilities(value) {
    const text = normalizeText(value);
    const capabilities = new Set();
    if (/(?:新建|创建|添加|记录|提醒我|设置?提醒|设个提醒|稍后提醒)/.test(text)) capabilities.add('capture');
    if (/(?:修改|更新|改成|延期|延后|推迟|改期|调整).{0,12}(?:待办|任务|提醒)|(?:待办|任务|提醒).{0,12}(?:修改|更新|延期|延后|推迟|改期|调整)/.test(text)) capabilities.add('edit');
    if (/(?:完成|标记为已完成)/.test(text)) capabilities.add('complete');
    if (/(?:删除|清空).{0,12}(?:待办|任务|提醒)|(?:待办|任务|提醒).{0,12}(?:删除|清空)/.test(text)) capabilities.add('delete');
    if (/(?:批量|这些|全部|所有|多项|多条)/.test(text)) capabilities.add('batch');
    if (!capabilities.size) capabilities.add('edit');
    return [...capabilities];
  }

  function classifyIntent(value) {
    const text = normalizeText(value);
    const memoryAction = classifyMemoryAction(text);
    const directTarget = text.match(/(?:新建|创建|添加|记录|保存|修改|删除|翻译|润色)\s*(笔记|待办|任务)/)?.[1] || '';
    const explicitNoteAction = directTarget === '笔记' || /笔记.{0,4}(新建|创建|修改|删除|翻译|润色)/.test(text);
    const explicitTodoAction = directTarget === '待办' || directTarget === '任务' || /(待办|任务).{0,4}(新建|创建|完成|删除|修改)/.test(text);
    const isTodo = directTarget ? directTarget !== '笔记' : (explicitNoteAction && !explicitTodoAction ? false : TODO_RE.test(text));
    const isWrite = WRITE_RE.test(text) || RECORD_WRITE_RE.test(text) || (isTodo && TODO_IMPLICIT_WRITE_RE.test(text)) || memoryAction === 'save' || memoryAction === 'delete';
    const isEfficiency = EFFICIENCY_RE.test(text);
    const isNoteQuery = !isEfficiency && (NOTE_QUERY_RE.test(text) || (!isTodo && !isWrite));
    let kind = 'general';
    if (memoryAction && !explicitNoteAction && !explicitTodoAction) kind = 'memory';
    else if (isTodo && isWrite) kind = 'todo_write';
    else if (isTodo) kind = 'todo_query';
    else if (isWrite) kind = 'note_write';
    else if (isNoteQuery) kind = 'note_query';
    const capabilities = kind === 'note_write'
      ? classifyNoteCapabilities(text)
      : kind === 'todo_write' ? classifyTodoCapabilities(text) : [];
    return {
      kind,
      isTodo,
      isWrite,
      isEfficiency,
      memoryAction,
      capabilities,
      prefetchNotes: !memoryAction
        && (isNoteQuery || (kind === 'note_write' && capabilities.includes('capture')))
        && !/^\s*(你好|hello|hi|在吗)[!！?？。\s]*$/i.test(text),
      query: queryKeywords(text)
    };
  }

  function selectToolNames(intent) {
    return SkillCore.selectToolNames(intent);
  }

  function planAssistantTurn(value, attachments, contextK) {
    let intent = classifyIntent(value);
    const items = Array.isArray(attachments) ? attachments : [];
    const todoAttachment = items.some(item => item?.type === 'todo');
    const noteAttachment = items.some(item => item?.type === 'note' || item?.type === 'selection');
    if (intent.isWrite && todoAttachment && !noteAttachment) {
      intent = {
        ...intent,
        kind: 'todo_write',
        isTodo: true,
        prefetchNotes: false,
        capabilities: classifyTodoCapabilities(value)
      };
    }
    const skill = SkillCore.selectionForIntent(intent);
    return Object.freeze({
      intent: Object.freeze(intent),
      skill,
      allowedToolNames: skill.tools,
      maxToolSteps: SkillCore.maxSteps(intent, contextK)
    });
  }

  function isToolAllowed(name, allowedToolNames) {
    if (typeof name !== 'string' || !name) return false;
    if (allowedToolNames instanceof Set) return allowedToolNames.has(name);
    return Array.isArray(allowedToolNames) && allowedToolNames.includes(name);
  }

  async function resolveNoteAttachmentImages(attachments, getNote, resolveContentImages) {
    const noteAttachments = (Array.isArray(attachments) ? attachments : []).filter(item => item && item.type === 'note');
    const groups = await Promise.all(noteAttachments.map(async attachment => {
      const note = typeof getNote === 'function' ? getNote(attachment.id) : null;
      if (!note || typeof resolveContentImages !== 'function') return [];
      const images = await resolveContentImages(note.content || '');
      return Array.isArray(images) ? images : [];
    }));
    return groups.flat();
  }

  function rankNotes(noteList, notebookList, query, limit, offset) {
    const notes = (noteList || []).filter(n => !n.deleted);
    const notebooks = new Map((notebookList || []).map(n => [n.id, normalizeText(n.name)]));
    const phrase = queryKeywords(query);
    const tokens = tokenize(query);
    const start = Math.max(0, Number.parseInt(offset, 10) || 0);
    const pageSize = Math.max(1, Number.parseInt(limit, 10) || 12);
    if (!phrase || !tokens.length) {
      return notes.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(start, start + pageSize).map(n => ({ note: n, score: 0, tokens }));
    }

    const fields = notes.map(note => ({
      note,
      title: normalizeText(note.title),
      content: normalizeText(note.content),
      tags: normalizeText((note.tags || []).join(' ')),
      notebook: notebooks.get(note.notebookId) || ''
    }));
    const docFreq = new Map();
    for (const token of tokens) {
      let count = 0;
      for (const f of fields) if ((f.title + ' ' + f.content + ' ' + f.tags + ' ' + f.notebook).includes(token)) count++;
      docFreq.set(token, count);
    }
    const now = Date.now();
    const ranked = [];
    for (const f of fields) {
      let score = 0;
      if (f.title === phrase) score += 80;
      else if (f.title.includes(phrase)) score += 36;
      if (f.tags.includes(phrase)) score += 24;
      if (f.notebook.includes(phrase)) score += 12;
      if (f.content.includes(phrase)) score += 16;
      let matched = 0;
      for (const token of tokens) {
        const df = docFreq.get(token) || 0;
        if (!df) continue;
        const idf = Math.log((notes.length + 1) / (df + 0.5)) + 1;
        let weight = 0;
        if (f.title.includes(token)) weight = 8;
        else if (f.tags.includes(token)) weight = 6;
        else if (f.notebook.includes(token)) weight = 4;
        else if (f.content.includes(token)) weight = 2;
        if (weight) { score += weight * idf * Math.min(token.length, 3) / 2; matched++; }
      }
      if (!score) continue;
      score *= 0.75 + 0.25 * (matched / Math.max(tokens.length, 1));
      const ageDays = Math.max(0, (now - (f.note.updatedAt || f.note.createdAt || 0)) / 86400000);
      score += 1 / (1 + ageDays / 30);
      ranked.push({ note: f.note, score, tokens });
    }
    ranked.sort((a, b) => b.score - a.score || (b.note.updatedAt || 0) - (a.note.updatedAt || 0));
    return ranked.slice(start, start + pageSize);
  }

  const NOTE_QUERY_FIELD_TYPES = Object.freeze({
    id: 'text', title: 'text', content: 'text', notebook: 'text', tag: 'text', type: 'text',
    starred: 'boolean', title_length: 'number', content_length: 'number',
    created_at: 'date', updated_at: 'date'
  });
  const NOTE_QUERY_OPERATORS = Object.freeze({
    text: new Set(['empty', 'not_empty', 'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with']),
    boolean: new Set(['equals', 'not_equals']),
    number: new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
    date: new Set(['before', 'after', 'on_or_before', 'on_or_after'])
  });

  function normalizeNoteCondition(value) {
    if (!value || typeof value !== 'object') throw new Error('where 中的条件必须是对象');
    const fieldAliases = { createdAt: 'created_at', updatedAt: 'updated_at', titleLength: 'title_length', contentLength: 'content_length', tags: 'tag' };
    const operatorAliases = { eq: 'equals', ne: 'not_equals', includes: 'contains', blank: 'empty', notBlank: 'not_empty' };
    const rawField = String(value.field || '').trim();
    const field = fieldAliases[rawField] || rawField;
    const type = NOTE_QUERY_FIELD_TYPES[field];
    if (!type) throw new Error(`不支持的笔记查询字段：${rawField || '(空)'}`);
    const rawOperator = String(value.operator || value.op || '').trim();
    let operator = operatorAliases[rawOperator] || rawOperator;
    if (!operator) operator = type === 'number' ? 'eq' : 'equals';
    // 数字字段沿用简短比较符，文本字段的 eq/ne 则转为可读形式。
    if (type === 'number' && operator === 'equals') operator = 'eq';
    if (type === 'number' && operator === 'not_equals') operator = 'ne';
    if (type !== 'number' && operator === 'eq') operator = 'equals';
    if (!NOTE_QUERY_OPERATORS[type].has(operator)) throw new Error(`字段 ${field} 不支持操作符 ${operator}`);
    if (!['empty', 'not_empty'].includes(operator) && value.value === undefined) throw new Error(`条件 ${field}.${operator} 缺少 value`);
    let expected = value.value;
    if (type === 'number') {
      expected = Number(expected);
      if (!Number.isFinite(expected)) throw new Error(`条件 ${field}.${operator} 的 value 必须是数字`);
    } else if (type === 'boolean') {
      if (expected !== true && expected !== false) throw new Error(`条件 ${field}.${operator} 的 value 必须是布尔值`);
    } else if (type === 'date') {
      expected = typeof expected === 'number' ? expected : Date.parse(String(expected || ''));
      if (!Number.isFinite(expected)) throw new Error(`条件 ${field}.${operator} 的 value 必须是时间戳或 ISO8601`);
    } else if (!['empty', 'not_empty'].includes(operator)) expected = normalizeText(expected);
    return { field, operator, value: expected };
  }

  function normalizeNoteQuery(value) {
    const source = value && typeof value === 'object' ? value : {};
    const where = (Array.isArray(source.where) ? source.where : []).slice(0, 12).map(normalizeNoteCondition);
    return {
      query: String(source.query || '').trim(),
      where,
      combine: source.combine === 'any' ? 'any' : 'all',
      cursor: Math.max(0, Number.parseInt(source.cursor, 10) || 0),
      limit: Math.max(1, Math.min(100, Number.parseInt(source.limit, 10) || 50))
    };
  }

  function noteConditionMatches(note, notebookName, condition) {
    let actual;
    if (condition.field === 'notebook') actual = notebookName || '';
    else if (condition.field === 'tag') actual = Array.isArray(note.tags) ? note.tags : [];
    else if (condition.field === 'title_length') actual = String(note.title || '').length;
    else if (condition.field === 'content_length') actual = String(note.content || '').length;
    else if (condition.field === 'created_at') actual = Number(note.createdAt) || 0;
    else if (condition.field === 'updated_at') actual = Number(note.updatedAt) || 0;
    else if (condition.field === 'starred') actual = !!note.starred;
    else if (condition.field === 'type') actual = note.type || 'markdown';
    else actual = String(note[condition.field] || '');

    if (Array.isArray(actual)) {
      const values = actual.map(normalizeText);
      if (condition.operator === 'empty') return values.length === 0;
      if (condition.operator === 'not_empty') return values.length > 0;
      if (condition.operator === 'equals') return values.includes(condition.value);
      if (condition.operator === 'not_equals') return !values.includes(condition.value);
      if (condition.operator === 'contains') return values.some(item => item.includes(condition.value));
      if (condition.operator === 'not_contains') return values.every(item => !item.includes(condition.value));
      if (condition.operator === 'starts_with') return values.some(item => item.startsWith(condition.value));
      if (condition.operator === 'ends_with') return values.some(item => item.endsWith(condition.value));
    }
    if (typeof actual === 'string') {
      const text = normalizeText(actual);
      if (condition.operator === 'empty') return !text;
      if (condition.operator === 'not_empty') return !!text;
      if (condition.operator === 'equals') return text === condition.value;
      if (condition.operator === 'not_equals') return text !== condition.value;
      if (condition.operator === 'contains') return text.includes(condition.value);
      if (condition.operator === 'not_contains') return !text.includes(condition.value);
      if (condition.operator === 'starts_with') return text.startsWith(condition.value);
      if (condition.operator === 'ends_with') return text.endsWith(condition.value);
    }
    if (typeof actual === 'boolean') return condition.operator === 'equals' ? actual === condition.value : actual !== condition.value;
    if (condition.operator === 'eq') return actual === condition.value;
    if (condition.operator === 'ne') return actual !== condition.value;
    if (condition.operator === 'lt' || condition.operator === 'before') return actual < condition.value;
    if (condition.operator === 'lte' || condition.operator === 'on_or_before') return actual <= condition.value;
    if (condition.operator === 'gt' || condition.operator === 'after') return actual > condition.value;
    if (condition.operator === 'gte' || condition.operator === 'on_or_after') return actual >= condition.value;
    return false;
  }

  function selectNotesByQuery(noteList, notebookList, value) {
    const noteQuery = normalizeNoteQuery(value);
    const notebookNames = new Map((notebookList || []).map(notebook => [notebook.id, notebook.name || '']));
    const active = (noteList || []).filter(note => note && !note.deleted);
    const ordered = noteQuery.query
      ? rankNotes(active, notebookList, noteQuery.query, active.length || 1, 0).map(item => item.note)
      : active.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id || '').localeCompare(String(b.id || '')));
    const selected = ordered.filter(note => {
      if (!noteQuery.where.length) return true;
      const matches = noteQuery.where.map(condition => noteConditionMatches(note, notebookNames.get(note.notebookId) || '', condition));
      return noteQuery.combine === 'any' ? matches.some(Boolean) : matches.every(Boolean);
    });
    return { noteQuery, notes: selected };
  }

  function queryNotes(noteList, notebookList, value) {
    const { noteQuery, notes } = selectNotesByQuery(noteList, notebookList, value);
    const page = notes.slice(noteQuery.cursor, noteQuery.cursor + noteQuery.limit);
    const nextCursor = noteQuery.cursor + page.length < notes.length ? noteQuery.cursor + page.length : null;
    const notebookNames = new Map((notebookList || []).map(notebook => [notebook.id, notebook.name || '']));
    return {
      query: { query: noteQuery.query || null, where: noteQuery.where, combine: noteQuery.combine },
      total: notes.length,
      cursor: noteQuery.cursor,
      limit: noteQuery.limit,
      nextCursor,
      hasMore: nextCursor !== null,
      items: page.map(note => ({
        id: note.id,
        title: note.title || '(无标题)',
        snippet: String(note.content || '').trim().replace(/\s+/g, ' ').slice(0, 240),
        notebookName: notebookNames.get(note.notebookId) || '',
        tags: Array.isArray(note.tags) ? note.tags : [],
        starred: !!note.starred,
        type: note.type || 'markdown',
        createdAt: note.createdAt,
        updatedAt: note.updatedAt
      }))
    };
  }

  function historyLimit(contextK) {
    if (contextK <= 16) return 8;
    if (contextK <= 64) return 16;
    if (contextK <= 128) return 24;
    return 32;
  }

  function selectRecentHistory(messages, contextK) {
    const source = Array.isArray(messages) ? messages : [];
    const selected = source.slice(-historyLimit(contextK));
    const firstUser = selected.findIndex(m => m && m.role === 'user');
    return firstUser > 0 ? selected.slice(firstUser) : selected;
  }

  function selectRelevantMemories(memories, value, intent, limit) {
    const source = Array.isArray(memories) ? memories : [];
    const maxItems = Math.max(1, Math.min(50, Number(limit) || 10));
    const keywords = tokenize(value);
    const relevant = keywords.length
      ? source.filter(memory => keywords.some(keyword => normalizeText(`${memory?.key || ''} ${memory?.value || ''}`).includes(keyword)))
      : [];
    const preferences = source.filter(memory => memory?.category === 'preference');
    const candidates = intent?.memoryAction === 'read' || intent?.memoryAction === 'delete'
      ? source
      : [...preferences, ...relevant];
    const seen = new Set();
    return candidates.filter(memory => {
      const key = `${memory?.category || ''}:${memory?.key || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(-maxItems);
  }

  function stripLeadingThinking(value) {
    let output = typeof value === 'string' ? value : '';
    if (/^\s*<think(?:ing)?>/i.test(output)) {
      output = /<\/think(?:ing)?>/i.test(output)
        ? output.replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
        : '';
    } else {
      output = output.replace(/^\s*<\/think(?:ing)?>\s*/i, '');
    }
    return output.trim();
  }

  function normalizeToolActions(actions, maxActions) {
    const limit = Math.max(0, Math.min(32, Number.isFinite(Number(maxActions)) ? Math.floor(Number(maxActions)) : 8));
    const source = Array.isArray(actions) ? actions : [];
    if (limit === 0) return { actions: [], truncated: source.length > 0 };
    const normalized = [];
    for (const action of source) {
      if (!action || typeof action !== 'object') continue;
      const tool = typeof action.tool === 'string' ? action.tool : action.name;
      if (typeof tool !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tool)) continue;
      const candidateArgs = action.args ?? action.arguments;
      const args = candidateArgs && typeof candidateArgs === 'object' && !Array.isArray(candidateArgs) ? candidateArgs : {};
      normalized.push({ tool, args });
      if (normalized.length >= limit) break;
    }
    return { actions: normalized, truncated: source.length > normalized.length && normalized.length >= limit };
  }

  function salvageToolCalls(value, knownToolNames, maxActions) {
    const raw = typeof value === 'string' ? value : '';
    if (!raw) return { actions: [], truncated: false };
    const known = knownToolNames ? new Set(knownToolNames) : null;
    const found = [];
    const pattern = /["']?(?:tool|name)["']?\s*:\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g;
    let match;
    while ((match = pattern.exec(raw))) {
      const tool = match[1];
      if (known && !known.has(tool)) continue;
      let args = {};
      const rest = raw.slice(pattern.lastIndex);
      const argsMatch = rest.match(/["']?(?:args|arguments)["']?\s*:\s*(\{)/);
      if (argsMatch) {
        const start = rest.indexOf('{', argsMatch.index);
        let depth = 0;
        let end = -1;
        let quoted = false;
        let escaped = false;
        for (let index = start; index < rest.length; index++) {
          const char = rest[index];
          if (escaped) { escaped = false; continue; }
          if (char === '\\' && quoted) { escaped = true; continue; }
          if (char === '"') { quoted = !quoted; continue; }
          if (quoted) continue;
          if (char === '{') depth++;
          else if (char === '}' && --depth === 0) { end = index; break; }
        }
        if (end > start) {
          try { args = JSON.parse(rest.slice(start, end + 1)); } catch {}
        }
      }
      found.push({ tool, args });
    }
    return normalizeToolActions(found, maxActions);
  }

  function parseAssistantReply(value, options = {}) {
    const raw = stripLeadingThinking(value);
    if (!raw) return { reply: '', actions: [], actionsTruncated: false };
    const maxActions = options.maxActions ?? 8;
    let jsonText = raw;
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) jsonText = fence[1].trim();
    const first = jsonText.indexOf('{');
    const last = jsonText.lastIndexOf('}');
    if (first >= 0 && last > first) jsonText = jsonText.slice(first, last + 1);
    try {
      const envelope = JSON.parse(jsonText);
      if (typeof envelope.reply !== 'string' && !Array.isArray(envelope.actions)) {
        const salvaged = salvageToolCalls(raw, options.knownToolNames, maxActions);
        if (salvaged.actions.length) return { reply: '', actions: salvaged.actions, actionsTruncated: salvaged.truncated };
      }
      const normalized = normalizeToolActions(envelope.actions, maxActions);
      return { reply: typeof envelope.reply === 'string' ? envelope.reply : '', actions: normalized.actions, actionsTruncated: normalized.truncated };
    } catch {
      const replyMatch = raw.match(/"reply"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
      if (replyMatch) {
        const reply = replyMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const actionsMatch = raw.match(/"actions"\s*:\s*(\[[\s\S]*?\])/);
        let actions = [];
        if (actionsMatch) { try { actions = JSON.parse(actionsMatch[1]); } catch {} }
        let normalized = normalizeToolActions(actions, maxActions);
        if (!normalized.actions.length) normalized = salvageToolCalls(raw, options.knownToolNames, maxActions);
        return { reply, actions: normalized.actions, actionsTruncated: normalized.truncated };
      }
      const salvaged = salvageToolCalls(raw, options.knownToolNames, maxActions);
      if (salvaged.actions.length) return { reply: '', actions: salvaged.actions, actionsTruncated: salvaged.truncated };
      return { reply: raw, actions: [], actionsTruncated: false };
    }
  }

  function stableJson(value, seen = new Set()) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    const output = Array.isArray(value)
      ? `[${value.map(item => stableJson(item, seen)).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return output;
  }

  function toolCallSignature(name, args) {
    return `${String(name || '')}|${stableJson(args || {})}`;
  }

  function contextLimit(contextK, small, medium, large) {
    const size = Number(contextK) || 10;
    if (size <= 16) return small;
    if (size <= 64) return medium;
    if (size <= 128) return large;
    return Math.round(large * Math.min(size / 128, 10));
  }

  function stringifyToolResult(result) {
    const json = JSON.stringify(result);
    return typeof json === 'string' ? json : String(result ?? '');
  }

  function compressToolResult(name, result, contextK) {
    const limit = (small, medium, large) => contextLimit(contextK, small, medium, large);
    try {
      if (name === 'list_notebooks' && Array.isArray(result)) return result.map(item => `${item.name}(${item.noteCount ?? '?'}篇)`).join(', ');
      if (['search_notes', 'list_recent_notes', 'list_starred'].includes(name) && Array.isArray(result)) return result.map(item => `「${item.title || '无标题'}」`).join(', ');
      if (name === 'query_notes' && result) return `结构化查询匹配${result.total || 0}篇：${(result.items || []).map(item => `「${item.title || '无标题'}」`).join(', ')}`;
      if (['search_todos', 'list_todos'].includes(name) && Array.isArray(result)) return result.map(item => `${item.done ? '✓' : '○'}${(item.text || '').slice(0, limit(30, 80, 200))}`).join('; ');
      if (name === 'get_note' && result) return `「${result.title || ''}」nb:${result.notebookName || ''} tags:${(result.tags || []).join(',')} content:${(result.content || '').slice(0, limit(300, 1000, 4000))}`;
      if (name === 'get_todo' && result) return `${result.done ? '✓' : '○'}「${result.text || ''}」due:${result.dueAt || ''} note:${result.note || ''}`;
      if (name === 'list_tags' && Array.isArray(result)) return result.map(item => `${item.tag}(${item.count})`).join(', ');
      if (name === 'export_note' && result) return `「${result.title || ''}」\n${(result.markdown || '').slice(0, limit(500, 2000, 6000))}`;
      if (name === 'research' && result) return `found:${result.found} summary:${(result.summary || '').slice(0, limit(400, 1500, 5000))}`;
      if (name === 'daily_briefing' && result) return (result.briefing || '').slice(0, limit(500, 2000, 6000));
      if (name === 'note_stats' && result) return stringifyToolResult(result);
    } catch {}
    return stringifyToolResult(result).slice(0, limit(500, 2000, 6000));
  }

  function toolResultForContext(name, result, contextK) {
    if (Number(contextK) >= 64) return stringifyToolResult(result).slice(0, contextLimit(contextK, 4000, 12000, 30000));
    return compressToolResult(name, result, contextK);
  }

  function summarizeToolResult(name, result, options = {}) {
    if (!result) return '';
    const formatDate = typeof options.formatDate === 'function' ? options.formatDate : value => new Date(value).toISOString();
    const summaries = {
      create_note: () => `笔记「${result.title || ''}」已创建`, create_todo: () => `待办「${result.text || ''}」${result.dueAt ? ' · ' + formatDate(new Date(result.dueAt).getTime()) : ''}`,
      update_note: () => `笔记「${result.title || ''}」已更新`, update_todo: () => `待办「${result.text || ''}」已更新`,
      list_notebooks: () => `${result.length || 0} 个笔记本`, search_notes: () => `${result.length || 0} 篇笔记`, query_notes: () => `结构化查询匹配 ${result.total || 0} 篇笔记`, search_todos: () => `${result.length || 0} 条待办`,
      create_notebook: () => `笔记本「${result.name || ''}」${result.existed ? '已存在' : '已创建'}`, rename_notebook: () => `笔记本「${result.oldName || ''}」→「${result.newName || ''}」`,
      delete_notebook: () => `笔记本「${result.deleted || ''}」已删除，${result.movedCount || 0} 篇笔记移至「${result.movedNotesTo || ''}」`, move_note: () => `笔记「${result.title || ''}」已移至「${result.notebookName || ''}」`,
      delete_note: () => `笔记「${result.title || ''}」已删除`, get_note: () => `笔记「${result.title || ''}」内容已获取`, get_todo: () => `待办「${result.text || ''}」详情已获取`, optimize_text: () => '已优化文本',
      save_memory: () => `记忆「${result.key || ''}」已保存`, recall_memory: () => `${result.length || 0} 条记忆`, delete_memory: () => `记忆${result.deleted ? '已删除' : '未找到'}`,
      batch_move_notes: () => `${result.success || 0} 篇笔记已移至「${result.notebookName || ''}」`, batch_update_notes: () => `${result.success || 0} 篇笔记已更新`, batch_complete_todos: () => `${result.success || 0} 条待办已完成`, batch_delete_notes: () => `${result.success || 0} 篇笔记已删除`, delete_notes_by_query: () => `${result.success || 0} 篇匹配笔记已删除${result.skippedChanged ? `，${result.skippedChanged} 篇因数据已变化而跳过` : ''}`,
      add_tags: () => `笔记「${result.title || ''}」添加 ${result.added || 0} 个标签`, remove_tags: () => `笔记「${result.title || ''}」移除 ${result.removed || 0} 个标签`, list_tags: () => `${result.length || 0} 个标签`,
      daily_briefing: () => '今日简报已生成', note_stats: () => `统计：${result.totalNotes || 0} 篇笔记 / ${result.totalCharacters || 0} 字`, create_from_template: () => `从${result.template || ''}模板创建「${result.title || ''}」`, summarize_note: () => `笔记「${result.title || ''}」摘要已生成`,
      create_folder: () => `文件夹「${result.name || ''}」${result.existed ? '已存在' : '已创建'}`, move_note_to_folder: () => `笔记「${result.title || ''}」已移入「${result.folderName || ''}」`, list_todos: () => `${result.length || 0} 条待办`,
      complete_todo: () => `待办「${result.text || ''}」已完成`, delete_todo: () => `待办「${result.text || ''}」已删除`, batch_delete_todos: () => `${result.success || 0} 条待办已删除`, find_note: () => result.found ? `找到笔记「${result.title || ''}」` : '未找到匹配笔记',
      quick_note: () => `快速笔记「${result.title || ''}」已创建`, quick_todo: () => `待办「${result.text || ''}」已创建`, auto_title_notes: () => `${result.success || 0} 篇无标题笔记已自动命名`, list_recent_notes: () => `${result.length || 0} 篇最近笔记`,
      count_notes: () => `${result.notebookName || ''}共 ${result.count || 0} 篇笔记`, research: () => `从 ${result.found || 0} 篇笔记中提取了关键信息`, translate: () => `已翻译为${result.targetLang || ''}`, extract_keywords: () => `关键词：${(result.keywords || []).slice(0, 5).join('、')}`,
      translate_note: () => `笔记「${result.originalTitle || ''}」已翻译为${result.lang || ''}`, append_to_note: () => result.skippedDuplicate ? `笔记「${result.title || ''}」已包含相同内容，未重复追加` : `已追加 ${result.appended || 0} 字到「${result.title || ''}」`, duplicate_note: () => `笔记「${result.title || ''}」已复制`, merge_notes: () => `${result.mergedCount || 0} 篇笔记已合并为「${result.title || ''}」`,
      star_note: () => `笔记「${result.title || ''}」${result.starred ? '已收藏' : '已取消收藏'}`, list_starred: () => `${result.length || 0} 篇收藏笔记`, word_count: () => result.noteId ? `「${result.title || ''}」${result.chars || 0} 字` : `共 ${result.totalChars || 0} 字`, clean_text: () => `笔记「${result.title || ''}」已清理`,
      export_note: () => `笔记「${result.title || ''}」已导出`, pomodoro: () => result.started ? `番茄钟已开始 ${result.duration}分钟` : result.stopped ? '番茄钟已停止' : (result.active ? `剩余 ${result.remaining} 分钟` : '无进行中的番茄钟')
    };
    return summaries[name]?.() || '';
  }

  function searchResultsForTool(name, result) {
    if (name === 'search_notes' && Array.isArray(result)) {
      return result.map(item => ({ kind: 'note', id: item.id, title: item.title, snippet: item.snippet, updatedAt: item.updatedAt }));
    }
    if (name === 'query_notes' && Array.isArray(result?.items)) {
      return result.items.map(item => ({ kind: 'note', id: item.id, title: item.title, snippet: item.snippet, updatedAt: item.updatedAt }));
    }
    if (name === 'search_todos' && Array.isArray(result)) {
      return result.map(item => ({ kind: 'todo', id: item.id, title: item.text, snippet: item.done ? '已完成' : '进行中', dueAt: item.dueAt }));
    }
    if (name === 'list_notebooks' && Array.isArray(result)) {
      return result.map(item => ({ kind: 'notebook', id: item.id, title: item.name }));
    }
    if (name === 'research' && Array.isArray(result?.sources)) {
      return result.sources.map(item => ({ kind: 'note', id: item.id, title: item.title, snippet: item.notebook ? `来自「${item.notebook}」` : '' }));
    }
    return [];
  }

  function dedupeSearchResults(results) {
    const seen = new Set();
    return (Array.isArray(results) ? results : []).filter(item => {
      const key = `${item?.kind || ''}:${item?.id || ''}`;
      if (!item?.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function toolResultTarget(name, result) {
    if (!result?.id) return {};
    if (['create_note', 'quick_note', 'update_note', 'append_to_note', 'duplicate_note', 'translate_note', 'clean_text', 'optimize_text'].includes(name)) {
      return { targetType: 'note', targetId: String(result.id) };
    }
    if (['create_todo', 'quick_todo', 'update_todo'].includes(name)) {
      return { targetType: 'todo', targetId: String(result.id) };
    }
    return {};
  }

  function summarizeToolLogForHistory(toolLog) {
    return (Array.isArray(toolLog) ? toolLog : []).map(item => {
      const status = item?.ok ? '✓' : '✗';
      const target = item?.ok && item?.targetType && item?.targetId
        ? `(${item.targetType} id:${item.targetId})`
        : '';
      return `${item?.tool || 'unknown'}${status}${target}`;
    }).join(',');
  }

  function planNoteAppend(existingContent, incomingText) {
    const existing = String(existingContent || '');
    const incoming = String(incomingText || '').trim();
    if (!incoming) throw new Error('text 必填');
    const normalizedIncoming = normalizeText(incoming);
    const duplicate = existing.split(/\n{2,}/).some(block => normalizeText(block) === normalizedIncoming);
    if (duplicate) return { content: existing, appended: 0, skippedDuplicate: true };
    return {
      content: existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${incoming}` : incoming,
      appended: incoming.length,
      skippedDuplicate: false
    };
  }

  function createTokenUsage() {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false };
  }

  function mergeTokenUsage(current, next) {
    const base = current || createTokenUsage();
    const usage = next || {};
    const inputTokens = (Number(base.inputTokens) || 0) + (Number(usage.inputTokens) || 0);
    const outputTokens = (Number(base.outputTokens) || 0) + (Number(usage.outputTokens) || 0);
    return {
      inputTokens,
      outputTokens,
      totalTokens: (Number(base.totalTokens) || 0) + (Number(usage.totalTokens) || Number(usage.inputTokens) + Number(usage.outputTokens) || 0),
      estimated: !!base.estimated || !!usage.estimated
    };
  }

  function buildTurnMetrics(options = {}) {
    const metrics = {
      retrieved: Math.max(0, Number(options.retrieved) || 0),
      modelCalls: Math.max(0, Number(options.modelCalls) || 0),
      elapsedMs: Math.max(0, Math.round(Number(options.elapsedMs) || 0))
    };
    const usage = options.usage;
    if (usage && Number(usage.totalTokens) > 0) {
      metrics.inputTokens = Math.max(0, Number(usage.inputTokens) || 0);
      metrics.outputTokens = Math.max(0, Number(usage.outputTokens) || 0);
      metrics.totalTokens = Math.max(0, Number(usage.totalTokens) || metrics.inputTokens + metrics.outputTokens);
      metrics.tokenEstimated = !!usage.estimated;
    }
    return metrics;
  }

  function compactConversation(messages, threshold, keep, omissionMessage) {
    const source = Array.isArray(messages) ? messages : [];
    if (source.length <= threshold) return source.slice();
    return [
      ...source.slice(0, 2),
      { role: 'user', content: omissionMessage || '（前序步骤已省略，继续完成任务，不要重复已做过的操作）' },
      ...source.slice(2).slice(-Math.max(1, keep))
    ];
  }

  function claimsSuccessfulWrite(reply) {
    const text = String(reply || '');
    return /(创建|新建|保存|存入|记住|加入|添加|归类|记录到|建好|存好)/.test(text)
      && /(笔记|待办|记忆|笔记本|分组|随笔)/.test(text)
      && (/(已|成功|好了|完成|完毕)/.test(text) || /(?:创建|新建|保存|存入|加入|添加|归类|记录)(?:好|了)/.test(text));
  }

  function classifyAssistantError(error) {
    const message = String(error?.message || error || '未知错误');
    if (message === '已取消' || /(?:aborted|aborterror|用户取消)/i.test(message)) return { kind: 'cancelled', message };
    if (/\b429\b|per 1 minute|per minute|rate limit|too many requests/i.test(message)) return { kind: 'rate_limit', message };
    if (/context length|maximum context|too many tokens|token limit|上下文.{0,8}(?:超|过长)|\b413\b/i.test(message)) return { kind: 'context_limit', message };
    if (/failed to fetch|networkerror|network request|timeout|timed out|连接失败|网络错误/i.test(message)) return { kind: 'network', message };
    return { kind: 'unexpected', message };
  }

  function assistantFailureReply(error, partialReply) {
    const failure = classifyAssistantError(error);
    const partial = String(partialReply || '');
    const prefix = partial ? `${partial}\n\n` : '';
    if (failure.kind === 'cancelled') return { ...failure, reply: `${prefix}_（已中止生成）_`, shouldLog: false };
    if (failure.kind === 'rate_limit') return { ...failure, reply: `${prefix}⚠️ 触发了 AI 接口的调用频率限制。请稍后重试；若经常出现，可在「设置 → AI」更换配额更高的模型。`, shouldLog: false };
    if (failure.kind === 'context_limit') return { ...failure, reply: `${prefix}⚠️ 本轮发送给模型的上下文过长。请新建会话、减少附件，或把任务拆成更小步骤后重试。`, shouldLog: false };
    if (failure.kind === 'network') return { ...failure, reply: `${prefix}⚠️ 无法连接 AI 服务。请检查网络、模型地址和 API Key 后重试。`, shouldLog: true };
    return { ...failure, reply: `出错：${failure.message}`, shouldLog: true };
  }

  return {
    normalizeText,
    queryKeywords,
    tokenize,
    classifyMemoryAction,
    classifyNoteCapabilities,
    classifyTodoCapabilities,
    classifyIntent,
    selectToolNames,
    planAssistantTurn,
    isToolAllowed,
    resolveNoteAttachmentImages,
    rankNotes,
    normalizeNoteCondition,
    normalizeNoteQuery,
    noteConditionMatches,
    selectNotesByQuery,
    queryNotes,
    historyLimit,
    selectRecentHistory,
    selectRelevantMemories,
    stripLeadingThinking,
    normalizeToolActions,
    salvageToolCalls,
    parseAssistantReply,
    toolCallSignature,
    contextLimit,
    compressToolResult,
    toolResultForContext,
    summarizeToolResult,
    searchResultsForTool,
    dedupeSearchResults,
    toolResultTarget,
    summarizeToolLogForHistory,
    planNoteAppend,
    createTokenUsage,
    mergeTokenUsage,
    buildTurnMetrics,
    compactConversation,
    claimsSuccessfulWrite,
    classifyAssistantError,
    assistantFailureReply
  };
});
