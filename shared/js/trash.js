// 回收站操作（桌面）：把删除的文件/目录移入 回收站/，索引存 _marginote/trash.json，
// 支持恢复、彻底删、30 天清理。依赖 fsApi() 与 window.trashCore。
(function () {
  const TRASH_DIR = '回收站';
  const TRASH_INDEX = '_marginote/trash.json';
  let _uidSeq = 0;
  function _uid() { _uidSeq++; return (typeof uid === 'function' ? uid() : 't' + Date.now().toString(36)) + '-' + _uidSeq; }

  async function loadTrashIndex() {
    const fs = fsApi(); if (!fs) return [];
    try { const t = await fs.readText(TRASH_INDEX); const a = t ? JSON.parse(t) : []; return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  async function saveTrashIndex(arr) {
    const fs = fsApi(); if (!fs) return;
    try { await fs.writeText(TRASH_INDEX, JSON.stringify(arr || [], null, 2)); } catch {}
  }
  async function moveToTrash({ path, type, name }) {
    const fs = fsApi(); if (!fs || !path) return null;
    const store = TRASH_DIR + '/' + window.trashCore.trashName(_uid(), name || (path.split('/').pop() || 'item'));
    const ok = await fs.move(path, store);
    if (!ok) return null;
    const entry = { trashPath: store, originalPath: path, type: type || 'note', name: name || path.split('/').pop(), deletedAt: (typeof nowMs === 'function' ? nowMs() : new Date().getTime()) };
    const idx = await loadTrashIndex(); idx.push(entry); await saveTrashIndex(idx);
    return entry;
  }
  async function restoreFromTrash(trashPath, existingPathsSet) {
    const fs = fsApi(); if (!fs) return null;
    const idx = await loadTrashIndex();
    const e = idx.find(x => x.trashPath === trashPath); if (!e) return null;
    const target = window.trashCore.restoreTarget(e.originalPath, existingPathsSet || new Set());
    const ok = await fs.move(trashPath, target); if (!ok) return null;
    await saveTrashIndex(idx.filter(x => x.trashPath !== trashPath));
    return target;
  }
  async function permanentDelete(trashPath) {
    const fs = fsApi(); if (!fs) return;
    try { await fs.remove(trashPath); } catch {}
    const idx = await loadTrashIndex();
    await saveTrashIndex(idx.filter(x => x.trashPath !== trashPath));
  }
  async function purgeExpired(now) {
    const fs = fsApi(); if (!fs) return 0;
    const idx = await loadTrashIndex();
    const { expired, kept } = window.trashCore.partitionExpired(idx, now, 30);
    for (const e of expired) { try { await fs.remove(e.trashPath); } catch {} }
    if (expired.length) await saveTrashIndex(kept);
    return expired.length;
  }
  window.trash = { loadTrashIndex, saveTrashIndex, moveToTrash, restoreFromTrash, permanentDelete, purgeExpired, TRASH_DIR, TRASH_INDEX };
})();
