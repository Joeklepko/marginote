// OpenAI 兼容 Provider 的请求、响应、SSE、用量估算与重试纯逻辑。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteAiProviderCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 1;

  function stripLeadingThinking(value) {
    let output = typeof value === 'string' ? value : '';
    if (/^\s*<think(?:ing)?>/i.test(output)) {
      output = /<\/think(?:ing)?>/i.test(output)
        ? output.replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
        : '';
    } else output = output.replace(/^\s*<\/think(?:ing)?>\s*/i, '');
    return output.trim();
  }

  function buildChatRequest(provider, messages, options = {}, stream = false) {
    const body = {
      model: String(provider?.model || '').trim(),
      messages: Array.isArray(messages) ? messages : [],
      temperature: Number.isFinite(Number(options.temperature ?? provider?.temperature))
        ? Number(options.temperature ?? provider?.temperature)
        : 0.7,
      stream: !!stream
    };
    const maxTokens = Number(options.max_tokens ?? options.maxTokens);
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.floor(maxTokens);
    if (options.response_format && typeof options.response_format === 'object') body.response_format = options.response_format;
    return body;
  }

  function buildHeaders(provider) {
    const headers = { 'Content-Type': 'application/json' };
    if (provider?.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    if (provider?.customHeaders && typeof provider.customHeaders === 'object' && !Array.isArray(provider.customHeaders)) {
      for (const [name, value] of Object.entries(provider.customHeaders)) {
        if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && value != null) headers[name] = String(value);
      }
    }
    return headers;
  }

  function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0) || 0;
    const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0) || 0;
    const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens) || inputTokens + outputTokens;
    if (!inputTokens && !outputTokens && !totalTokens) return null;
    return { inputTokens, outputTokens, totalTokens, estimated: false };
  }

  function toolCallsToEnvelope(toolCalls, reply) {
    const actions = (Array.isArray(toolCalls) ? toolCalls : []).map(call => {
      let args = {};
      try { args = JSON.parse(call?.function?.arguments || '{}'); } catch {}
      return { tool: call?.function?.name, args };
    }).filter(action => action.tool);
    return actions.length ? JSON.stringify({ reply: typeof reply === 'string' ? reply : '', actions }) : '';
  }

  function parseChatData(data) {
    const message = data?.choices?.[0]?.message;
    const content = message?.content;
    const nativeTools = toolCallsToEnvelope(message?.tool_calls, content);
    if (nativeTools) return { content: nativeTools, usage: normalizeUsage(data?.usage) };
    if (typeof content === 'string') return { content: stripLeadingThinking(content), usage: normalizeUsage(data?.usage) };
    if (typeof data?.choices?.[0]?.delta?.content === 'string') return { content: stripLeadingThinking(data.choices[0].delta.content), usage: normalizeUsage(data?.usage) };
    if (data?.response != null) return { content: String(data.response).trim(), usage: normalizeUsage(data?.usage) };
    if (data?.result != null) return { content: String(data.result).trim(), usage: normalizeUsage(data?.usage) };
    throw new Error('返回数据缺少 choices[0].message.content');
  }

  function createStreamAccumulator() {
    let content = '';
    let usage = null;
    const toolCalls = new Map();
    function push(data) {
      usage = normalizeUsage(data?.usage) || usage;
      const delta = data?.choices?.[0]?.delta || data?.choices?.[0]?.message || {};
      if (typeof delta.content === 'string') content += delta.content;
      for (const call of (Array.isArray(delta.tool_calls) ? delta.tool_calls : [])) {
        const index = Number(call.index) || 0;
        const current = toolCalls.get(index) || { function: { name: '', arguments: '' } };
        if (call?.function?.name) current.function.name += call.function.name;
        if (call?.function?.arguments) current.function.arguments += call.function.arguments;
        toolCalls.set(index, current);
      }
      return { contentDelta: typeof delta.content === 'string' ? delta.content : '', reasoningDelta: delta.reasoning_content || '' };
    }
    function result() {
      const nativeTools = toolCallsToEnvelope([...toolCalls.values()], content);
      return { content: nativeTools || stripLeadingThinking(content), usage };
    }
    return { push, result };
  }

  function parseSseText(text) {
    const accumulator = createStreamAccumulator();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { accumulator.push(JSON.parse(payload)); } catch {}
    }
    return accumulator.result();
  }

  function parseChatResponse(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('AI 返回空响应，请检查模型服务是否正常');
    if (/^data:/m.test(raw)) {
      const parsed = parseSseText(raw);
      if (parsed.content) return parsed;
    }
    try { return parseChatData(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof SyntaxError) {
        if (raw.length > 20) return { content: stripLeadingThinking(raw), usage: null };
        throw new Error('AI 返回无法解析: ' + raw.slice(0, 200));
      }
      throw error;
    }
  }

  function estimateTextTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const remaining = Math.max(0, text.length - cjk);
    return Math.max(1, Math.ceil(cjk * 0.9 + remaining / 4));
  }

  function resolveUsage(messages, output, exactUsage) {
    const exact = normalizeUsage(exactUsage) || exactUsage;
    if (exact && exact.totalTokens != null) return exact;
    const inputTokens = estimateTextTokens(messages);
    const outputTokens = estimateTextTokens(output);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
  }

  function emitUsage(options, messages, output, exactUsage) {
    const usage = resolveUsage(messages, output, exactUsage);
    if (typeof options?.onUsage === 'function') {
      try { options.onUsage(usage); } catch {}
    }
    return usage;
  }

  function createHttpError(status, detail) {
    const error = new Error(`HTTP ${Number(status) || 0}: ${String(detail || '').slice(0, 300)}`);
    error.status = Number(status) || 0;
    return error;
  }

  function isRetryableError(error) {
    const status = Number(error?.status) || Number(String(error?.message || '').match(/HTTP\s+(\d{3})/i)?.[1]) || 0;
    return [408, 425, 429, 500, 502, 503, 504].includes(status)
      || /failed to fetch|networkerror|network request|timeout|timed out|连接失败|网络错误/i.test(String(error?.message || error || ''));
  }

  async function withRetry(operation, options = {}) {
    const retries = Math.max(0, Math.min(3, Number(options.retries) || 0));
    const wait = typeof options.wait === 'function' ? options.wait : delay => new Promise(resolve => setTimeout(resolve, delay));
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { return await operation(attempt); }
      catch (error) {
        lastError = error;
        if (attempt >= retries || !isRetryableError(error)) throw error;
        const delay = Math.min(4000, 600 * (2 ** attempt));
        if (typeof options.onRetry === 'function') options.onRetry({ attempt: attempt + 1, delay, error });
        await wait(delay);
      }
    }
    throw lastError;
  }

  return {
    VERSION,
    stripLeadingThinking,
    buildChatRequest,
    buildHeaders,
    normalizeUsage,
    parseChatData,
    createStreamAccumulator,
    parseSseText,
    parseChatResponse,
    estimateTextTokens,
    resolveUsage,
    emitUsage,
    createHttpError,
    isRetryableError,
    withRetry
  };
});
