const { planReconciliation } = require('../shared/js/workdir-core.js');
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
