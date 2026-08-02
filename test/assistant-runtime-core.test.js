const assert = require('node:assert/strict');
const core = require('../shared/js/assistant-core.js');

const knownTools = ['search_notes', 'create_note', 'update_todo'];

const standard = core.parseAssistantReply(
  '<think>内部推理，不应显示</think>```json\n{"reply":"找到结果","actions":[{"name":"search_notes","arguments":{"query":"项目"}}]}\n```',
  { knownToolNames: knownTools }
);
assert.equal(standard.reply, '找到结果');
assert.deepEqual(standard.actions, [{ tool: 'search_notes', args: { query: '项目' } }]);

const malformed = core.parseAssistantReply(
  'minimax:tool_call ["tool":"create_note", "args":{"title":"包含 } 的标题","content":"正文"}]',
  { knownToolNames: knownTools }
);
assert.deepEqual(malformed.actions, [{ tool: 'create_note', args: { title: '包含 } 的标题', content: '正文' } }]);
assert.equal(malformed.reply, '');

const unknown = core.parseAssistantReply(
  'tool: "not_a_real_tool", args: {"value":1}',
  { knownToolNames: knownTools }
);
assert.deepEqual(unknown.actions, []);

const manyActions = JSON.stringify({
  reply: '批量处理',
  actions: Array.from({ length: 6 }, (_, index) => ({ tool: 'create_note', args: { title: String(index) } }))
});
const limited = core.parseAssistantReply(manyActions, { knownToolNames: knownTools, maxActions: 2 });
assert.equal(limited.actions.length, 2);
assert.equal(limited.actionsTruncated, true);
const exhausted = core.parseAssistantReply(manyActions, { knownToolNames: knownTools, maxActions: 0 });
assert.deepEqual(exhausted.actions, []);
assert.equal(exhausted.actionsTruncated, true);

assert.equal(
  core.toolCallSignature('create_note', { content: '正文', title: '标题' }),
  core.toolCallSignature('create_note', { title: '标题', content: '正文' }),
  '参数键顺序不同的相同调用必须得到同一签名'
);

const messages = [
  { role: 'system', content: '规则' },
  { role: 'user', content: '本地上下文' },
  ...Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) }))
];
const compacted = core.compactConversation(messages, 6, 3, '已压缩');
assert.equal(compacted.length, 6);
assert.deepEqual(compacted.slice(0, 2), messages.slice(0, 2));
assert.equal(compacted[2].content, '已压缩');
assert.deepEqual(compacted.slice(-3), messages.slice(-3));

assert.equal(core.summarizeToolResult('create_note', { title: '周报' }), '笔记「周报」已创建');
assert.equal(core.summarizeToolResult('search_notes', [{}, {}]), '2 篇笔记');
assert.match(core.compressToolResult('get_note', { title: '周报', content: '内容', tags: [] }, 16), /周报/);
assert.equal(core.claimsSuccessfulWrite('已经帮你创建并保存笔记。'), true);
assert.equal(core.claimsSuccessfulWrite('我可以帮你创建笔记。'), false);

assert.deepEqual(core.planNoteAppend('第一段', '第二段'), {
  content: '第一段\n\n第二段', appended: 3, skippedDuplicate: false
});
assert.deepEqual(core.planNoteAppend('第一段\n\n第二段', '  第二段  '), {
  content: '第一段\n\n第二段', appended: 0, skippedDuplicate: true
});
assert.match(core.summarizeToolResult('append_to_note', { title: '项目', appended: 0, skippedDuplicate: true }), /未重复追加/);

assert.equal(core.stripLeadingThinking('<thinking>secret</thinking>answer'), 'answer');
assert.equal(core.stripLeadingThinking('<think>未结束'), '');
assert.equal(core.stripLeadingThinking('</think>answer'), 'answer');

const rateLimit = core.assistantFailureReply(new Error('HTTP 429 rate limit'), '已完成第一步');
assert.equal(rateLimit.kind, 'rate_limit');
assert.match(rateLimit.reply, /已完成第一步/);
assert.equal(rateLimit.shouldLog, false);
assert.equal(core.assistantFailureReply(new Error('maximum context length exceeded')).kind, 'context_limit');
assert.equal(core.assistantFailureReply(new Error('Failed to fetch')).kind, 'network');
assert.equal(core.assistantFailureReply(new Error('已取消')).kind, 'cancelled');
assert.equal(core.assistantFailureReply(new Error('bad response')).kind, 'unexpected');

assert.deepEqual(core.searchResultsForTool('search_todos', [{ id: 't1', text: '提交周报', done: false, dueAt: 9 }]), [
  { kind: 'todo', id: 't1', title: '提交周报', snippet: '进行中', dueAt: 9 }
]);
assert.deepEqual(core.dedupeSearchResults([
  { kind: 'note', id: 'n1' }, { kind: 'note', id: 'n1' }, { kind: 'todo', id: 'n1' }
]), [{ kind: 'note', id: 'n1' }, { kind: 'todo', id: 'n1' }]);
assert.deepEqual(core.toolResultTarget('create_note', { id: 12 }), { targetType: 'note', targetId: '12' });

let usage = core.createTokenUsage();
usage = core.mergeTokenUsage(usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12, estimated: false });
usage = core.mergeTokenUsage(usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8, estimated: true });
assert.deepEqual(usage, { inputTokens: 15, outputTokens: 5, totalTokens: 20, estimated: true });
assert.deepEqual(core.buildTurnMetrics({ retrieved: 2, modelCalls: 2, elapsedMs: 123.7, usage }), {
  retrieved: 2,
  modelCalls: 2,
  elapsedMs: 124,
  inputTokens: 15,
  outputTokens: 5,
  totalTokens: 20,
  tokenEstimated: true
});
