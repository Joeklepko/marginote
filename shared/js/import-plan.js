// 导入决策纯逻辑：决定哪些磁盘文件需要读取解析。核心原则：应用尚未载入的文件一律读取，
// 绝不因 mtime 早于某阈值而跳过（修复"磁盘有文件却不导入"）。双导出，便于离线测试。
(function (root) {
  const NOTE_RE = /\.(md|markdown|excalidraw)$/i;
  function planImport({ entries, loadedByPath }) {
    loadedByPath = loadedByPath || {};
    const toRead = [];
    for (const e of (entries || [])) {
      if (e.dir) continue;
      if (!NOTE_RE.test(e.path)) continue;
      if (e.path.startsWith('_') || e.path.startsWith('回收站/')) continue;
      const loaded = loadedByPath[e.path];
      if (!loaded) { toRead.push(e); continue; }                 // 未载入 → 必读
      if ((e.mtime || 0) !== (loaded.mtime || 0)) toRead.push(e); // mtime 变 → 读；否则跳过
    }
    return { toRead };
  }
  const api = { planImport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.importPlan = api;
})(typeof window !== 'undefined' ? window : null);
