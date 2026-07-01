// 回收站纯逻辑：无 fs / 无 DOM，浏览器与 Node 双可用，便于离线测试。
(function (root) {
  const DAY = 86400000;
  function trashName(uid, origName) { return String(uid) + '__' + String(origName); }
  // 原路径被占用时，在扩展名之前插入 -N（无扩展名/目录则直接追加 -N）
  function restoreTarget(originalPath, existingPathsSet) {
    const has = (p) => existingPathsSet && existingPathsSet.has(p);
    if (!has(originalPath)) return originalPath;
    const slash = originalPath.lastIndexOf('/');
    const dir = slash >= 0 ? originalPath.slice(0, slash + 1) : '';
    const base = slash >= 0 ? originalPath.slice(slash + 1) : originalPath;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let n = 1, cand;
    do { cand = dir + stem + '-' + n + ext; n++; } while (has(cand));
    return cand;
  }
  function isExpired(deletedAt, now, days) { days = days || 30; return (now - (deletedAt || 0)) > days * DAY; }
  function partitionExpired(index, now, days) {
    const expired = [], kept = [];
    for (const e of (index || [])) (isExpired(e.deletedAt, now, days) ? expired : kept).push(e);
    return { expired, kept };
  }
  const api = { trashName, restoreTarget, isExpired, partitionExpired, DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.trashCore = api;
})(typeof window !== 'undefined' ? window : null);
