// 工作目录对账纯逻辑。只把 meta.json 记录为 Marginote 曾经管理过、且磁盘上
// 已不存在的条目视为外部删除；本地新建但尚未写盘的条目不在映射中，不会误删。
(function (root) {
  function idPathEntries(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value).filter(([id, path]) => (
      typeof id === 'string' && id.length > 0 && typeof path === 'string' && path.length > 0
    ));
  }

  function asSet(value) {
    return value instanceof Set ? value : new Set(value || []);
  }

  function planReconciliation({
    noteFiles,
    todoFiles,
    presentPaths,
    seenNoteIds,
    seenTodoIds,
  } = {}) {
    const paths = asSet(presentPaths);
    const noteIds = asSet(seenNoteIds);
    const todoIds = asSet(seenTodoIds);
    const missingNoteIds = [];
    const missingTodoIds = [];

    for (const [id, path] of idPathEntries(noteFiles)) {
      // A file moved outside Marginote still carries its front-matter id. Treat
      // that as a move, not a deletion.
      if (!paths.has(path) && !noteIds.has(id)) missingNoteIds.push(id);
    }
    for (const [id, path] of idPathEntries(todoFiles)) {
      if (!paths.has(path) && !todoIds.has(id)) missingTodoIds.push(id);
    }

    return { missingNoteIds, missingTodoIds };
  }

  const api = { planReconciliation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MarginoteWorkdirCore = api;
})(typeof window !== 'undefined' ? window : null);
