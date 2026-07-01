const t = require('../shared/js/trash-core.js');
let p = 0, f = 0; const ck = (n, c) => { c ? (p++, console.log('✓', n)) : (f++, console.log('✗ FAIL', n)); };

ck('trashName 拼接', t.trashName('ab12', '笔记.md') === 'ab12__笔记.md');
ck('restoreTarget 原路径空闲直接用', t.restoreTarget('工作/a.md', new Set()) === '工作/a.md');
ck('restoreTarget 冲突加序号', t.restoreTarget('工作/a.md', new Set(['工作/a.md'])) === '工作/a-1.md');
ck('restoreTarget 连续冲突', t.restoreTarget('工作/a.md', new Set(['工作/a.md','工作/a-1.md'])) === '工作/a-2.md');
ck('restoreTarget 无扩展名(目录)冲突', t.restoreTarget('工作', new Set(['工作'])) === '工作-1');
const DAY = 86400000;
ck('isExpired 未过期', t.isExpired(1000, 1000 + 29 * DAY) === false);
ck('isExpired 刚过期', t.isExpired(1000, 1000 + 31 * DAY) === true);
const idx = [{ deletedAt: 0 }, { deletedAt: 100 * DAY }];
const part = t.partitionExpired(idx, 40 * DAY);
ck('partitionExpired 分区', part.expired.length === 1 && part.kept.length === 1 && part.kept[0].deletedAt === 100 * DAY);

console.log(`\n=== ${p} passed, ${f} failed ===`); process.exit(f ? 1 : 0);
