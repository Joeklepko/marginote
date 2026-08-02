// AI 文本编辑事务：流式阶段只计算草稿，成功后才一次性提交到调用开始时捕获的对象。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MarginoteAiEditCore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function normalizeSelection(selection, contentLength) {
    if (!selection || typeof selection !== 'object') return null;
    const start = Math.max(0, Math.min(contentLength, Number(selection.start) || 0));
    const end = Math.max(start, Math.min(contentLength, Number(selection.end) || 0));
    return end > start ? { start, end } : null;
  }

  function composeContent(original, generated, mode, selection) {
    const source = String(original || '');
    const output = String(generated || '');
    const range = normalizeSelection(selection, source.length);
    if (!range) return mode === 'append' ? source + (source ? '\n\n' : '') + output : output;
    const selected = source.slice(range.start, range.end);
    const replacement = mode === 'append'
      ? selected + (selected ? '\n\n' : '') + output
      : output;
    return source.slice(0, range.start) + replacement + source.slice(range.end);
  }

  function createTextEdit(target, mode, kind, options = {}) {
    if (!target || typeof target !== 'object') throw new Error('AI 编辑目标无效');
    const original = String(target.content || '');
    const selection = normalizeSelection(options.selection, original.length);
    return {
      target,
      original,
      selection,
      input: selection ? original.slice(selection.start, selection.end) : original,
      draft(generated) {
        return composeContent(original, generated, mode, selection);
      },
      commit(generated, updatedAt) {
        const content = composeContent(original, generated, mode, selection);
        target.content = content;
        if (kind === 'note') target.updatedAt = updatedAt == null ? Date.now() : updatedAt;
        return content;
      }
    };
  }

  return { normalizeSelection, composeContent, createTextEdit };
});
