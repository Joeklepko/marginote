const { planImport } = require('../shared/js/import-plan.js');
let p = 0, f = 0; const ck = (n, c) => { c ? (p++, console.log('✓', n)) : (f++, console.log('✗ FAIL', n)); };
const paths = (r) => r.toRead.map(e => e.path).sort();

const entries = [
  { path: '工作/a.md', dir: false, mtime: 100 },
  { path: '工作/b.md', dir: false, mtime: 200 },
  { path: '回收站/x.md', dir: false, mtime: 300 },
  { path: '_assets/i.png', dir: false, mtime: 300 },
  { path: '工作', dir: true, mtime: 0 },
];
// a 已载入且 mtime 相同 → 跳过；b 未载入 → 必读
let r = planImport({ entries, loadedByPath: { '工作/a.md': { mtime: 100 } } });
ck('未载入的 b 必读', paths(r).includes('工作/b.md'));
ck('已载入未变的 a 跳过', !paths(r).includes('工作/a.md'));
ck('回收站文件被排除', !paths(r).includes('回收站/x.md'));
ck('下划线资产被排除', !paths(r).includes('_assets/i.png'));
ck('目录项被排除', r.toRead.every(e => !e.dir));
// a 已载入但 mtime 变了 → 读
r = planImport({ entries, loadedByPath: { '工作/a.md': { mtime: 99 } } });
ck('已载入但 mtime 变的 a 要读', paths(r).includes('工作/a.md'));
// 关键回归：外部拷入旧 mtime 文件，未载入 → 必读（修复 bug）
r = planImport({ entries: [{ path: '旧/c.md', dir: false, mtime: 1 }], loadedByPath: {} });
ck('旧 mtime 未载入文件必读', paths(r).includes('旧/c.md'));

console.log(`\n=== ${p} passed, ${f} failed ===`); process.exit(f ? 1 : 0);
