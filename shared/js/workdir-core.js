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

  function splitPath(path) {
    const value = String(path || '').replace(/\\/g, '/');
    const slash = value.lastIndexOf('/');
    const dir = slash >= 0 ? value.slice(0, slash + 1) : '';
    const file = slash >= 0 ? value.slice(slash + 1) : value;
    const dot = file.lastIndexOf('.');
    return {
      dir,
      stem: dot > 0 ? file.slice(0, dot) : file,
      ext: dot > 0 ? file.slice(dot) : '',
    };
  }

  function isCompatiblePath(previous, preferred) {
    if (!previous || !preferred) return false;
    const oldPath = splitPath(previous);
    const target = splitPath(preferred);
    if (oldPath.dir !== target.dir || oldPath.ext !== target.ext) return false;
    return oldPath.stem === target.stem
      || new RegExp('^' + target.stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[2-9][0-9]*$').test(oldPath.stem);
  }

  function withSuffix(path, number) {
    if (number <= 1) return path;
    const value = splitPath(path);
    return value.dir + value.stem + '-' + number + value.ext;
  }

  function safeIso(value, fallback) {
    const candidate = value == null || value === '' ? NaN : new Date(value).getTime();
    const fallbackTime = fallback == null || fallback === '' ? NaN : new Date(fallback).getTime();
    const time = Number.isFinite(candidate)
      ? candidate
      : (Number.isFinite(fallbackTime) ? fallbackTime : Date.now());
    return new Date(time).toISOString();
  }

  function verifySnapshot(input) {
    input = input || {};
    const meta = input.meta && typeof input.meta === 'object' ? input.meta : {};
    const presentPaths = new Set(input.presentPaths || []);
    const issues = [];
    const groups = [
      ['笔记', input.activeNoteIds || [], meta.noteFiles],
      ['回收站笔记', input.deletedNoteIds || [], meta.deletedNoteFiles],
      ['待办', input.todoIds || [], meta.todoFiles]
    ];
    for (const [label, ids, mappingValue] of groups) {
      const mapping = mappingValue && typeof mappingValue === 'object' ? mappingValue : {};
      for (const id of ids) {
        const path = mapping[id];
        if (!path) issues.push(`${label} ${id} 缺少文件映射`);
        else if (!presentPaths.has(path)) issues.push(`${label} ${id} 的文件不存在：${path}`);
      }
    }
    for (const path of input.requiredAssetPaths || []) {
      if (!presentPaths.has(path)) issues.push(`图片资产不存在：${path}`);
    }
    return { ok: issues.length === 0, issues };
  }

  // 为界面实体分配稳定的磁盘路径。已有实体在名称/目录未改变时保留原路径；
  // 新实体遇到重名或外部文件时使用 -2、-3，避免新增内容导致旧文件整体改名。
  function allocateStablePaths(items, previous, reservedPaths) {
    const rows = Array.isArray(items) ? items.filter(item => item && item.id && item.preferredPath) : [];
    const old = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
    const used = asSet(reservedPaths);
    const result = {};

    for (const item of rows) {
      const prior = old[item.id];
      if (!isCompatiblePath(prior, item.preferredPath) || used.has(prior)) continue;
      result[item.id] = prior;
      used.add(prior);
    }
    for (const item of rows) {
      if (result[item.id]) continue;
      let number = 1;
      let candidate = item.preferredPath;
      while (used.has(candidate)) {
        number += 1;
        candidate = withSuffix(item.preferredPath, number);
      }
      result[item.id] = candidate;
      used.add(candidate);
    }
    return result;
  }

  const api = { planReconciliation, allocateStablePaths, isCompatiblePath, withSuffix, safeIso, verifySnapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MarginoteWorkdirCore = api;
})(typeof window !== 'undefined' ? window : null);
