const assert = require('node:assert/strict');
const provider = require('../shared/js/ai-provider-core.js');

const config = {
  model: 'local-model',
  temperature: 0.3,
  apiKey: '',
  customHeaders: { 'X-Trace': 42, 'Bad Header': 'ignored' }
};
const messages = [{ role: 'user', content: '总结这篇笔记' }];

assert.deepEqual(provider.buildChatRequest(config, messages, { max_tokens: 512 }, true), {
  model: 'local-model',
  messages,
  temperature: 0.3,
  stream: true,
  max_tokens: 512
});
assert.deepEqual(provider.buildHeaders(config), {
  'Content-Type': 'application/json',
  'X-Trace': '42'
}, '空密钥不应发送空 Authorization，非法 header 名应被忽略');

const normal = provider.parseChatResponse(JSON.stringify({
  choices: [{ message: { content: '<think>内部推理</think>最终回答' } }],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
}));
assert.equal(normal.content, '最终回答');
assert.deepEqual(normal.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16, estimated: false });

const nativeTool = provider.parseChatData({
  choices: [{ message: { content: null, tool_calls: [
    { function: { name: 'search_notes', arguments: '{"query":"发布"}' } }
  ] } }]
});
assert.deepEqual(JSON.parse(nativeTool.content), {
  reply: '',
  actions: [{ tool: 'search_notes', args: { query: '发布' } }]
});

const sse = provider.parseSseText([
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"create_note","arguments":"{\\"title\\":\\"会"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"议\\"}"}}]}}],"usage":{"prompt_tokens":8,"completion_tokens":3}}',
  'data: [DONE]'
].join('\n'));
assert.deepEqual(JSON.parse(sse.content), {
  reply: '',
  actions: [{ tool: 'create_note', args: { title: '会议' } }]
});
assert.equal(sse.usage.totalTokens, 11);

let emitted;
const estimated = provider.emitUsage({ onUsage: usage => { emitted = usage; } }, messages, '完成', null);
assert.equal(estimated.estimated, true);
assert.deepEqual(emitted, estimated);
assert.ok(estimated.inputTokens > 0 && estimated.outputTokens > 0);

(async () => {
  let attempts = 0;
  const waits = [];
  const retried = await provider.withRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw provider.createHttpError(503, 'busy');
    return 'ok';
  }, { retries: 2, wait: async delay => waits.push(delay) });
  assert.equal(retried, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [600, 1200]);

  attempts = 0;
  await assert.rejects(() => provider.withRetry(async () => {
    attempts += 1;
    throw provider.createHttpError(400, 'bad request');
  }, { retries: 2, wait: async () => {} }), /HTTP 400/);
  assert.equal(attempts, 1, '不可重试错误不应重复调用模型');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
