const { planReconciliation, allocateStablePaths, isCompatiblePath } = require('../shared/js/workdir-core.js');
const assert = require('node:assert/strict');

let plan = planReconciliation({
  noteFiles: { n1: '工作/a.md', n2: '工作/b.md' },
  todoFiles: { t1: '待办/x.md' },
  presentPaths: new Set(['工作/a.md']),
});
assert.deepEqual(plan.missingNoteIds, ['n2']);
assert.deepEqual(plan.missingTodoIds, ['t1']);

plan = planReconciliation({
  noteFiles: { n1: '旧目录/a.md' },
  todoFiles: { t1: '待办/旧.md' },
  presentPaths: [],
  seenNoteIds: ['n1'],
  seenTodoIds: ['t1'],
});
assert.deepEqual(plan, { missingNoteIds: [], missingTodoIds: [] });

plan = planReconciliation({
  noteFiles: { managed: '工作/managed.md' },
  presentPaths: [],
  // A local-only note is intentionally absent from noteFiles and therefore
  // cannot appear in the deletion plan.
  seenNoteIds: ['local-only'],
});
assert.deepEqual(plan.missingNoteIds, ['managed']);

assert.deepEqual(planReconciliation({
  noteFiles: null,
  todoFiles: [],
  presentPaths: null,
}), { missingNoteIds: [], missingTodoIds: [] });

assert.equal(isCompatiblePath('工作/问题-2.md', '工作/问题.md'), true);
assert.equal(isCompatiblePath('工作/问题.md', '阅读/问题.md'), false);
assert.equal(isCompatiblePath('工作/问题.excalidraw', '工作/问题.md'), false);

let paths = allocateStablePaths([
  { id: 'old', preferredPath: '工作/问题.md' },
  { id: 'new', preferredPath: '工作/问题.md' },
], { old: '工作/问题.md' });
assert.deepEqual(paths, { old: '工作/问题.md', new: '工作/问题-2.md' });

paths = allocateStablePaths([
  { id: 'old', preferredPath: '工作/问题.md' },
  { id: 'new', preferredPath: '工作/问题.md' },
], { old: '工作/问题-2.md' }, new Set(['工作/问题.md']));
assert.deepEqual(paths, { old: '工作/问题-2.md', new: '工作/问题-3.md' });

paths = allocateStablePaths(
  [{ id: 'renamed', preferredPath: '阅读/新标题.md' }],
  { renamed: '工作/旧标题.md' }
);
assert.deepEqual(paths, { renamed: '阅读/新标题.md' });

const bulkItems = Array.from({ length: 350 }, (_, index) => ({
  id: `issue-${index}`,
  preferredPath: '问题分析/未命名问题.md',
}));
const bulkPaths = allocateStablePaths(bulkItems, {});
assert.equal(new Set(Object.values(bulkPaths)).size, 350, '350 篇同名笔记必须各自获得独立文件');
assert.equal(bulkPaths['issue-0'], '问题分析/未命名问题.md');
assert.equal(bulkPaths['issue-349'], '问题分析/未命名问题-350.md');
assert.deepEqual(allocateStablePaths(bulkItems, bulkPaths), bulkPaths, '批量写入后路径必须保持稳定');
