// Marginote AI 助手的纯逻辑核心。
// 保持无 DOM / 无存储依赖，便于 Node 测试，也避免把检索与提示词策略继续堆在 UI 文件里。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteAssistantCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const QUERY_NOISE = /(?:帮我|请问|麻烦|能不能|可以不可以|我想知道|告诉我|查一下|找一下|搜索一下|看一下|笔记里|笔记中|相关笔记|相关内容|是什么|是啥|怎么样|怎样|如何|为什么|什么时候|哪一天|多少|有没有|是否|一下|的话|呢|吗|啊|呀|吧)/g;
  const WRITE_RE = /(新建|创建|记录|保存|添加|加入|修改|更新|改成|删除|移到|移动|重命名|归类|整理成|收藏|取消收藏|打标签|完成待办|清理|润色|改写|续写|翻译)/;
  const TODO_RE = /(待办|任务|提醒|截止|到期|今日安排|今天要做|本周要做|已完成|未完成)/;
  const NOTE_QUERY_RE = /(查|找|搜|检索|笔记|记录里|之前写|提到|关于|回顾|总结|归纳|研究|什么时候|是什么|多少|为什么|怎么)/;
  const EFFICIENCY_RE = /(番茄钟|专注.*分钟|每日简报|今日简报|笔记统计|字数统计)/;

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

  function classifyIntent(value) {
    const text = normalizeText(value);
    const directTarget = text.match(/(?:新建|创建|添加|记录|保存|修改|删除|翻译|润色)\s*(笔记|待办|任务)/)?.[1] || '';
    const explicitNoteAction = directTarget === '笔记' || /笔记.{0,4}(新建|创建|修改|删除|翻译|润色)/.test(text);
    const explicitTodoAction = directTarget === '待办' || directTarget === '任务' || /(待办|任务).{0,4}(新建|创建|完成|删除|修改)/.test(text);
    const isTodo = directTarget ? directTarget !== '笔记' : (explicitNoteAction && !explicitTodoAction ? false : TODO_RE.test(text));
    const isWrite = WRITE_RE.test(text);
    const isEfficiency = EFFICIENCY_RE.test(text);
    const isNoteQuery = !isEfficiency && (NOTE_QUERY_RE.test(text) || (!isTodo && !isWrite));
    let kind = 'general';
    if (isTodo && isWrite) kind = 'todo_write';
    else if (isTodo) kind = 'todo_query';
    else if (isWrite) kind = 'note_write';
    else if (isNoteQuery) kind = 'note_query';
    return {
      kind,
      isTodo,
      isWrite,
      isEfficiency,
      prefetchNotes: isNoteQuery && !/^\s*(你好|hello|hi|在吗)[!！?？。\s]*$/i.test(text),
      query: queryKeywords(text)
    };
  }

  function selectToolNames(intent) {
    const query = ['search_notes', 'get_note', 'find_note', 'research', 'list_recent_notes'];
    const noteWrite = ['create_note', 'quick_note', 'update_note', 'append_to_note', 'delete_note', 'move_note', 'add_tags', 'remove_tags', 'star_note', 'summarize_note', 'translate_note', 'optimize_text', 'clean_text', 'duplicate_note', 'batch_update_notes', 'batch_delete_notes'];
    const todo = ['search_todos', 'list_todos', 'get_todo', 'create_todo', 'quick_todo', 'update_todo', 'complete_todo', 'delete_todo', 'batch_complete_todos', 'batch_delete_todos'];
    const common = ['list_notebooks', 'save_memory', 'recall_memory'];
    let names;
    if (intent?.kind === 'todo_write') names = [...todo, ...query.slice(0, 2), ...common];
    else if (intent?.kind === 'todo_query') names = [...todo.slice(0, 4), ...query.slice(0, 2), ...common];
    else if (intent?.kind === 'note_write') names = [...noteWrite, ...query, ...common, 'create_notebook', 'rename_notebook', 'delete_notebook', 'create_folder', 'move_note_to_folder', 'batch_move_notes'];
    else if (intent?.kind === 'note_query') names = [...query, 'search_todos', ...common, 'summarize_note', 'extract_keywords', 'export_note', 'word_count', 'list_tags'];
    else names = [...query, ...todo.slice(0, 4), ...noteWrite.slice(0, 4), ...common, 'daily_briefing', 'note_stats', 'pomodoro'];
    return [...new Set(names)];
  }

  function rankNotes(noteList, notebookList, query, limit) {
    const notes = (noteList || []).filter(n => !n.deleted);
    const notebooks = new Map((notebookList || []).map(n => [n.id, normalizeText(n.name)]));
    const phrase = queryKeywords(query);
    const tokens = tokenize(query);
    if (!phrase || !tokens.length) {
      return notes.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit || 12).map(n => ({ note: n, score: 0, tokens }));
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
    return ranked.slice(0, Math.max(1, limit || 12));
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

  return { normalizeText, queryKeywords, tokenize, classifyIntent, selectToolNames, rankNotes, historyLimit, selectRecentHistory };
});
