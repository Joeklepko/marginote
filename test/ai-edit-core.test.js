const core = require('../shared/js/ai-edit-core.js');
const assert = require('node:assert/strict');

assert.equal(core.composeContent('原文', '新文', 'replace'), '新文');
assert.equal(core.composeContent('原文', '补充', 'append'), '原文\n\n补充');

const first = { id: 'n1', content: '安全原文', updatedAt: 1 };
const second = { id: 'n2', content: '另一篇', updatedAt: 1 };
const edit = core.createTextEdit(first, 'replace', 'note');
assert.equal(edit.draft('流式草稿'), '流式草稿');
assert.equal(first.content, '安全原文', '流式草稿不得提前修改目标');

let current = first;
current = second;
edit.commit('最终内容', 99);
assert.equal(first.content, '最终内容', '提交应写入启动时捕获的目标');
assert.equal(first.updatedAt, 99);
assert.equal(current.content, '另一篇', '切换后的当前笔记不得被误写');

const selectedTarget = { content: '开头 需要润色 结尾', updatedAt: 1 };
const selectedEdit = core.createTextEdit(selectedTarget, 'replace', 'note', {
  selection: { start: 3, end: 7 }
});
assert.equal(selectedEdit.input, '需要润色');
assert.equal(selectedEdit.draft('已润色'), '开头 已润色 结尾');
selectedEdit.commit('最终文本', 9);
assert.equal(selectedTarget.content, '开头 最终文本 结尾');
assert.equal(selectedTarget.updatedAt, 9);

const appendSelection = core.createTextEdit({ content: 'A段B' }, 'append', 'note', {
  selection: { start: 1, end: 2 }
});
assert.equal(appendSelection.draft('总结'), 'A段\n\n总结B');
assert.equal(core.normalizeSelection({ start: 2, end: 2 }, 5), null, '空选择应回退为全文操作');
