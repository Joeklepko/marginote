const assert = require('node:assert/strict');
const fs = require('node:fs');
const policy = require('../shared/js/tool-policy-core.js');

function assistantToolNames(file) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('const ASSISTANT_TOOLS = {');
  const end = source.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, `${file} 中应存在 ASSISTANT_TOOLS`);
  return [...source.slice(start, end).matchAll(/^  ([a-zA-Z_][a-zA-Z0-9_]*): \{/gm)]
    .map(match => match[1])
    .sort();
}

const registered = policy.assistantToolNames().sort();
assert.deepEqual(assistantToolNames('shared/js/assistant.js'), registered, '桌面助手工具必须全部登记策略');
assert.deepEqual(assistantToolNames('extension/js/assistant.js'), registered, '扩展助手工具必须全部登记策略');

assert.equal(policy.getPolicy('create_note').transaction, 'repository');
assert.equal(policy.getPolicy('delete_note').access, 'destructive');
assert.equal(policy.getPolicy('query_notes').access, 'read');
assert.equal(policy.getPolicy('delete_notes_by_query').access, 'destructive');
assert.equal(policy.getPolicy('delete_notes_by_query').cli, false);
assert.equal(policy.getPolicy('save_memory').workdirProjection, true);
assert.equal(policy.isWrite('quick_todo'), true, 'quick_todo 不能再漏记为只读工具');
assert.equal(policy.getPolicy('quick_todo').aliasOf, 'create_todo');
assert.equal(policy.getPolicy('quick_note').deprecated, true);
assert.deepEqual(policy.getPolicy('find_note').replacedBy, ['search_notes', 'get_note']);
assert.ok(!policy.assistantPromptToolNames().includes('quick_note'), '兼容别名不应继续占用模型工具上下文');
assert.ok(!policy.assistantPromptToolNames().includes('find_note'), '可由原子工具组合的旧工具不应继续暴露给模型');
assert.equal(policy.isWrite('pomodoro'), true, '番茄钟会修改本地状态，应归类为写操作');
assert.equal(policy.projectsToWorkdir('pomodoro'), false, '番茄钟不应触发笔记工作目录全量写回');
assert.equal(policy.getPolicy('update_note_cli').cli, 'virtual');
assert.equal(policy.getPolicy('update_note_cli').assistant, false);
assert.equal(policy.getPolicy('unknown_tool'), null);

const cliCalls = policy.cliCallNames();
assert.equal(new Set(cliCalls).size, cliCalls.length, 'CLI 调用白名单不应重复');
assert.ok(cliCalls.includes('create_note'));
assert.ok(cliCalls.includes('export_note'));
assert.ok(cliCalls.includes('batch_update_notes'));
assert.equal(policy.isDestructive('batch_delete_notes'), true);
assert.ok(cliCalls.includes('update_note_cli'));
assert.ok(!cliCalls.includes('optimize_text'));

const rustSource = fs.readFileSync('desktop/cli/src/main.rs', 'utf8');
const rustPolicyBlock = rustSource.slice(
  rustSource.indexOf('const CLI_CALL_POLICIES:'),
  rustSource.indexOf('\n];', rustSource.indexOf('const CLI_CALL_POLICIES:')) + 3
);
const rustPolicies = [...rustPolicyBlock.matchAll(/CliCallPolicy\s*\{\s*name:\s*"([^"]+)",\s*destructive:\s*(true|false),?\s*\}/g)]
  .map(match => ({ name: match[1], destructive: match[2] === 'true' }));
assert.deepEqual(
  rustPolicies.map(item => item.name).sort(),
  cliCalls.slice().sort(),
  'Rust CLI raw call 白名单必须与共享策略一致'
);
assert.deepEqual(
  rustPolicies.filter(item => item.destructive).map(item => item.name).sort(),
  cliCalls.filter(policy.isDestructive).sort(),
  'Rust CLI 删除确认策略必须与共享策略一致'
);

assert.throws(
  () => policy.assertAssistantTools({ ...Object.fromEntries(registered.map(name => [name, {}])), unregistered_write: {} }),
  /未登记: unregistered_write/,
  '新增工具缺少策略时必须立即失败'
);
