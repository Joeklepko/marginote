// Marginote CLI command dispatcher. Pure logic: no DOM/Tauri dependency.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteCliCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DIRECT_TOOLS = new Set([
    'list_notebooks', 'create_notebook', 'rename_notebook', 'delete_notebook',
    'search_notes', 'get_note', 'create_note', 'append_to_note', 'move_note',
    'delete_note', 'add_tags', 'remove_tags', 'star_note', 'list_tags',
    'search_todos', 'list_todos', 'get_todo', 'create_todo', 'update_todo',
    'complete_todo', 'delete_todo', 'note_stats', 'word_count'
  ]);

  function ensureObject(value) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('args 必须是对象');
    return value;
  }

  function positiveLimit(value, fallback, max) {
    const parsed = parseInt(value, 10);
    return Math.max(1, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
  }

  function createHandler(deps) {
    if (!deps || !deps.tools || typeof deps.snapshot !== 'function') throw new Error('CLI handler dependencies missing');
    const tools = deps.tools;
    const callTool = async (name, args) => {
      const tool = tools[name];
      if (!tool || typeof tool.run !== 'function') throw new Error('当前版本不支持工具：' + name);
      return await tool.run(args || {});
    };

    return async function handleCliCommand(command, rawArgs) {
      const args = ensureObject(rawArgs);
      const snapshot = deps.snapshot();

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
        let result = await callTool('search_notes', { query: args.query || '', limit: Math.max(limit, 50) });
        if (args.notebookName) result = result.filter(note => note.notebookName === args.notebookName);
        if (Array.isArray(args.tags) && args.tags.length) {
          result = result.filter(note => args.tags.every(tag => (note.tags || []).includes(tag)));
        }
        if (args.starred) result = result.filter(note => note.starred);
        return result.slice(0, limit);
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
      return await callTool(command, args);
    };
  }

  return { DIRECT_TOOLS, createHandler, positiveLimit };
});
