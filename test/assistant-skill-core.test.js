const assert = require('node:assert/strict');
const policy = require('../shared/js/tool-policy-core.js');
const skills = require('../shared/js/assistant-skill-core.js');

for (const profile of Object.values(skills.PROFILES)) {
  assert.ok(!profile.tools.includes('quick_note'));
  assert.ok(!profile.tools.includes('quick_todo'));
  assert.ok(!profile.tools.includes('find_note'));
  assert.ok(!profile.tools.includes('list_todos'));
}

assert.equal(skills.VERSION, 2);
assert.deepEqual(
  Object.keys(skills.PROFILES).sort(),
  ['general', 'memory', 'note_query', 'note_write', 'todo_query', 'todo_write']
);
assert.deepEqual(skills.unreachableToolNames(), [], '每个助手工具都必须归属至少一个 Skill');

for (const profile of Object.values(skills.PROFILES)) {
  assert.equal(new Set(profile.tools).size, profile.tools.length, `${profile.id} 不应包含重复工具`);
  assert.ok(profile.maxSteps > 0 && profile.maxSteps <= 12, `${profile.id} 必须限制最大步骤`);
  assert.ok(profile.promptRules.length > 0, `${profile.id} 必须声明专属 Prompt 规则`);
  if (profile.mutationPolicy === 'read-only') {
    assert.ok(profile.tools.every(name => !policy.isWrite(name)), `${profile.id} 不得包含写工具`);
  }
}

const todoQuery = skills.selectToolNames({ kind: 'todo_query' });
assert.ok(todoQuery.includes('search_todos'));
assert.ok(!todoQuery.includes('create_todo'), '待办查询 Skill 不应再意外开放创建工具');

const noteWrite = skills.PROFILES.note_write.tools;
for (const name of ['create_from_template', 'auto_title_notes', 'merge_notes', 'translate']) {
  assert.ok(noteWrite.includes(name), `${name} 应通过笔记整理 Skill 正常可达`);
}
const noteCapture = skills.selectionForIntent({ kind: 'note_write', capabilities: ['capture'] });
assert.ok(noteCapture.tools.includes('create_note'));
assert.ok(noteCapture.tools.includes('append_to_note'));
assert.ok(noteCapture.tools.includes('update_note'));
assert.ok(!noteCapture.tools.includes('delete_note'));
assert.ok(noteCapture.promptRules.some(rule => rule.includes('高置信匹配')));
assert.ok(noteCapture.promptRules.some(rule => rule.includes('先 get_note 读取全文')));

const noteBatchMove = skills.selectToolNames({ kind: 'note_write', capabilities: ['organize', 'batch'] });
assert.ok(noteBatchMove.includes('batch_move_notes'));
assert.ok(!noteBatchMove.includes('batch_delete_notes'));
const noteBatchDelete = skills.selectToolNames({ kind: 'note_write', capabilities: ['delete', 'batch'] });
assert.ok(noteBatchDelete.includes('batch_delete_notes'));
assert.ok(noteBatchDelete.includes('query_notes'));
assert.ok(noteBatchDelete.includes('delete_notes_by_query'));

const todoComplete = skills.selectToolNames({ kind: 'todo_write', capabilities: ['complete', 'batch'] });
assert.ok(todoComplete.includes('batch_complete_todos'));
assert.ok(!todoComplete.includes('batch_delete_todos'));
const noteQuery = skills.selectToolNames({ kind: 'note_query' });
for (const name of ['count_notes', 'list_starred', 'query_notes']) assert.ok(noteQuery.includes(name));

assert.deepEqual(skills.selectToolNames({ kind: 'memory', memoryAction: 'save' }), ['save_memory']);
assert.deepEqual(skills.selectToolNames({ kind: 'memory', memoryAction: 'read' }), ['recall_memory']);
assert.deepEqual(skills.selectToolNames({ kind: 'memory', memoryAction: 'delete' }), ['recall_memory', 'delete_memory']);
assert.equal(skills.maxSteps({ kind: 'memory' }, 200), 3);
assert.equal(skills.maxSteps({ kind: 'note_query' }, 16), 6);
assert.equal(skills.maxSteps({ kind: 'note_query' }, 128), 8);
