// Marginote CLI command dispatcher. Pure logic: no DOM/Tauri dependency.
(function (root, factory) {
  const policy = (root && root.MarginoteToolPolicyCore)
    || (typeof module === 'object' && module.exports ? require('./tool-policy-core.js') : null);
  const api = factory(policy);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteCliCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ToolPolicy) {
  if (!ToolPolicy) throw new Error('MarginoteToolPolicyCore 未加载');
  const DIRECT_TOOLS = new Set(ToolPolicy.cliDirectToolNames());
  const DESTRUCTIVE_COMMANDS = new Set(ToolPolicy.cliCallNames().filter(ToolPolicy.isDestructive));
  const TRANSACTIONAL_COMMANDS = new Set(ToolPolicy.cliCallNames().filter(ToolPolicy.usesRepositoryTransaction));

  function ensureObject(value) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('args 必须是对象');
    return value;
  }

  function positiveLimit(value, fallback, max) {
    const parsed = parseInt(value, 10);
    return Math.max(1, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
  }

  function cursorOffset(value) {
    if (value == null || value === '') return 0;
    const match = String(value).match(/^mn1:(\d+)$/);
    if (!match) throw new Error('cursor 无效或版本不兼容');
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('cursor 超出范围');
    return offset;
  }

  function paginate(items, rawLimit, cursor) {
    const limit = positiveLimit(rawLimit, 20, 200);
    const offset = cursorOffset(cursor);
    const source = Array.isArray(items) ? items : [];
    const page = source.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      items: page,
      nextCursor: nextOffset < source.length ? `mn1:${nextOffset}` : null,
      hasMore: nextOffset < source.length
    };
  }

  function compactLabel(value, fallback) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) return fallback || '';
    return text.length > 32 ? text.slice(0, 31) + '…' : text;
  }

  function stableJson(value, seen = new Set()) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    const encoded = Array.isArray(value)
      ? `[${value.map(item => stableJson(item, seen)).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return encoded;
  }

  function requestFingerprint(command, args) {
    const cleanArgs = { ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) };
    delete cleanArgs._confirmed;
    delete cleanArgs._dryRun;
    return `${String(command || '')}|${stableJson(cleanArgs)}`;
  }

  function pruneIdempotencyRecords(records, now = Date.now(), maxRecords = 100, ttlMs = 24 * 60 * 60 * 1000) {
    return (Array.isArray(records) ? records : [])
      .filter(item => item && item.requestId && Number(item.completedAt) > now - ttlMs)
      .sort((a, b) => Number(b.completedAt) - Number(a.completedAt))
      .slice(0, Math.max(1, maxRecords));
  }

  function lookupIdempotencyRecord(records, requestId, fingerprint) {
    const match = (Array.isArray(records) ? records : []).find(item => item?.requestId === requestId);
    if (!match) return { kind: 'miss' };
    if (match.fingerprint !== fingerprint) return { kind: 'conflict' };
    return { kind: 'hit', data: match.data, completedAt: match.completedAt };
  }

  function recordIdempotencyResult(records, entry, options = {}) {
    const remaining = (Array.isArray(records) ? records : []).filter(item => item?.requestId !== entry.requestId);
    return pruneIdempotencyRecords([entry, ...remaining], options.now, options.maxRecords, options.ttlMs);
  }

  function describeCommand(command, rawArgs) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const quoted = value => {
      const label = compactLabel(value, '');
      return label ? `「${label}」` : '';
    };
    const id = () => compactLabel(args.id || args.noteId || args.notebookRef, '指定项目');
    const descriptions = {
      status: () => '检查 Marginote 连接状态',
      search_all: () => `搜索笔记和待办${quoted(args.query)}`,
      list_notes: () => `查询笔记${quoted(args.query)}`,
      search_notes: () => `搜索笔记${quoted(args.query)}`,
      get_note: () => `读取笔记 ${id()}`,
      create_note: () => `新建笔记${quoted(args.title)}`,
      update_note_cli: () => `更新笔记 ${id()}`,
      update_note: () => `更新笔记 ${id()}`,
      append_to_note: () => `追加笔记 ${id()}`,
      move_note: () => `移动笔记 ${id()}`,
      delete_note: () => `删除笔记 ${id()}`,
      add_tags: () => `添加笔记标签 ${id()}`,
      remove_tags: () => `移除笔记标签 ${id()}`,
      star_note: () => `更新笔记收藏 ${id()}`,
      list_tags: () => '读取全部标签',
      search_todos: () => `查询待办${quoted(args.query)}`,
      list_todos: () => '读取待办列表',
      get_todo: () => `读取待办 ${id()}`,
      create_todo: () => `新建待办${quoted(args.text)}`,
      update_todo: () => `更新待办 ${id()}`,
      complete_todo: () => `完成待办 ${id()}`,
      delete_todo: () => `删除待办 ${id()}`,
      list_notebooks: () => '读取笔记本列表',
      create_notebook: () => `新建笔记本${quoted(args.name)}`,
      rename_notebook_cli: () => `重命名笔记本 ${compactLabel(args.notebookRef, '指定笔记本')}`,
      rename_notebook: () => `重命名笔记本 ${id()}`,
      delete_notebook_cli: () => `删除笔记本 ${compactLabel(args.notebookRef, '指定笔记本')}`,
      delete_notebook: () => `删除笔记本 ${id()}`,
      note_stats: () => '统计笔记数据',
      word_count: () => '统计笔记字数',
      export_note: () => `导出笔记 ${id()}`,
      batch_move_notes: () => `批量移动 ${Array.isArray(args.noteIds) ? args.noteIds.length : 0} 篇笔记`,
      batch_update_notes: () => `批量更新 ${Array.isArray(args.noteIds) ? args.noteIds.length : 0} 篇笔记`,
      batch_complete_todos: () => `批量完成 ${Array.isArray(args.todoIds) ? args.todoIds.length : 0} 条待办`,
      batch_delete_notes: () => `批量删除 ${Array.isArray(args.noteIds) ? args.noteIds.length : 0} 篇笔记`,
      batch_delete_todos: () => `批量删除 ${Array.isArray(args.todoIds) ? args.todoIds.length : 0} 条待办`
    };
    const describe = descriptions[String(command || '')];
    return describe ? describe() : `执行 CLI 工具 ${compactLabel(command, 'unknown')}`;
  }

  function createHandler(deps) {
    if (!deps || !deps.tools || typeof deps.snapshot !== 'function') throw new Error('CLI handler dependencies missing');
    const tools = deps.tools;
    const callTool = async (name, args) => {
      const tool = tools[name];
      if (!tool || typeof tool.run !== 'function') throw new Error('当前版本不支持工具：' + name);
      return await tool.run(args || {});
    };

    async function executeCliCommand(command, rawArgs) {
      const args = ensureObject(rawArgs);
      const dryRun = args._dryRun === true;
      if (DESTRUCTIVE_COMMANDS.has(command) && args._confirmed !== true && !dryRun) {
        throw new Error('删除操作缺少显式确认，请在 CLI 中传入 --yes');
      }
      const toolArgs = { ...args };
      delete toolArgs._confirmed;
      delete toolArgs._dryRun;
      const snapshot = deps.snapshot();

      if (dryRun && ToolPolicy.isWrite(command)) {
        const policy = ToolPolicy.getPolicy(command);
        return {
          dryRun: true,
          command,
          description: describeCommand(command, toolArgs),
          access: policy?.access || 'write',
          transaction: policy?.transaction || 'none',
          args: toolArgs
        };
      }

      if (command === 'status') {
        const activeNotes = (snapshot.notes || []).filter(note => !note.deleted);
        return {
          connected: true,
          version: snapshot.version || 'unknown',
          notes: activeNotes.length,
          todos: (snapshot.todos || []).length,
          activeTodos: (snapshot.todos || []).filter(todo => !todo.done).length,
          notebooks: (snapshot.notebooks || []).length,
          workdir: snapshot.workdir || null
        };
      }

      if (command === 'list_notes') {
        const limit = positiveLimit(args.limit, 20, 200);
        const offset = args.paged ? cursorOffset(args.cursor) : 0;
        // Notebook/tag/star filters are applied by the CLI compatibility layer,
        // so paged queries must first fetch the complete tool result window.
        // Otherwise a selective filter could hide matches that live beyond the
        // first unfiltered page and incorrectly report hasMore=false.
        const searchLimit = args.paged ? 200 : Math.min(200, Math.max(limit, 50));
        let result = await callTool('search_notes', { query: args.query || '', limit: searchLimit });
        if (args.notebookName) result = result.filter(note => note.notebookName === args.notebookName);
        if (Array.isArray(args.tags) && args.tags.length) {
          result = result.filter(note => args.tags.every(tag => (note.tags || []).includes(tag)));
        }
        if (args.starred) result = result.filter(note => note.starred);
        return args.paged ? paginate(result, limit, args.cursor) : result.slice(0, limit);
      }

      if (command === 'search_todos' && args.paged) {
        const limit = positiveLimit(args.limit, 20, 200);
        const offset = cursorOffset(args.cursor);
        const result = await callTool('search_todos', {
          query: args.query || '',
          status: args.status,
          due: args.due,
          limit: Math.min(200, offset + limit + 1)
        });
        return paginate(result, limit, args.cursor);
      }

      if (command === 'search_all') {
        const limit = positiveLimit(args.limit, 20, 100);
        const [noteResults, todoResults] = await Promise.all([
          callTool('search_notes', { query: args.query || '', limit }),
          callTool('search_todos', { query: args.query || '', status: 'all', limit })
        ]);
        return { notes: noteResults, todos: todoResults };
      }

      if (command === 'update_note_cli') {
        const id = String(args.id || '');
        if (!id) throw new Error('id 必填');
        let result = null;
        if (args.title !== undefined || (args.content !== undefined && !args.append)) {
          result = await callTool('update_note', {
            id,
            title: args.title,
            content: args.content !== undefined && !args.append ? args.content : undefined
          });
        }
        if (args.append && args.content !== undefined) result = await callTool('append_to_note', { noteId: id, text: args.content });
        if (args.notebookName) result = await callTool('move_note', { noteId: id, notebookName: args.notebookName });
        if (Array.isArray(args.addTags) && args.addTags.length) result = await callTool('add_tags', { noteId: id, tags: args.addTags });
        if (Array.isArray(args.removeTags) && args.removeTags.length) result = await callTool('remove_tags', { noteId: id, tags: args.removeTags });
        if (typeof args.starred === 'boolean') result = await callTool('star_note', { noteId: id, starred: args.starred });
        return result || await callTool('get_note', { id });
      }

      if (command === 'rename_notebook_cli' || command === 'delete_notebook_cli') {
        const reference = String(args.notebookRef || '').trim();
        if (!reference) throw new Error('notebookRef 必填');
        const notebook = (snapshot.notebooks || []).find(item => item.id === reference)
          || (snapshot.notebooks || []).find(item => item.name === reference);
        if (!notebook) throw new Error('笔记本未找到：' + reference);
        if (command === 'rename_notebook_cli') {
          return await callTool('rename_notebook', { notebookId: notebook.id, newName: args.newName, newColor: args.newColor });
        }
        return await callTool('delete_notebook', { notebookId: notebook.id });
      }

      if (!DIRECT_TOOLS.has(command)) throw new Error('CLI 工具不在白名单中：' + command);
      return await callTool(command, toolArgs);
    }

    return async function handleCliCommand(command, rawArgs) {
      const execute = () => executeCliCommand(command, rawArgs);
      if (TRANSACTIONAL_COMMANDS.has(command) && typeof deps.runTransaction === 'function') {
        return await deps.runTransaction(`cli:${command}`, execute, { source: 'cli', command });
      }
      return await execute();
    };
  }

  return {
    DIRECT_TOOLS,
    DESTRUCTIVE_COMMANDS,
    TRANSACTIONAL_COMMANDS,
    createHandler,
    positiveLimit,
    cursorOffset,
    paginate,
    describeCommand,
    requestFingerprint,
    pruneIdempotencyRecords,
    lookupIdempotencyRecord,
    recordIdempotencyResult
  };
});
