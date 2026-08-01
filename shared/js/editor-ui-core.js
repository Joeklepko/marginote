// Pure editor UI calculations shared by the browser runtime and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteEditorUiCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ACTIONS_EXPANDED_MIN_WIDTH = 1120;
  const COMPACT_TOOLBAR_MAX_WIDTH = 900;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 3;

  function shouldExpandEditorActions(toolbarWidth) {
    const width = Number(toolbarWidth);
    return Number.isFinite(width) && width >= ACTIONS_EXPANDED_MIN_WIDTH;
  }

  function shouldUseCompactToolbar(toolbarWidth) {
    const width = Number(toolbarWidth);
    return Number.isFinite(width) && width > 0 && width < COMPACT_TOOLBAR_MAX_WIDTH;
  }

  function normalizeEditorZoom(value) {
    const zoom = Number(value);
    if (!Number.isFinite(zoom) || zoom <= 0) return 1;
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom * 100) / 100));
  }

  function nextEditorZoom(current, delta) {
    return normalizeEditorZoom(normalizeEditorZoom(current) + Number(delta || 0));
  }

  function readingLayout(zoom) {
    const value = normalizeEditorZoom(zoom);
    return {
      zoom: value.toFixed(2),
      width: `calc(${(100 / value).toFixed(4)}% - ${(64 / value).toFixed(2)}px)`,
      maxWidth: `${(760 / value).toFixed(2)}px`,
      padding: `${(80 / value).toFixed(2)}px ${(32 / value).toFixed(2)}px ${(160 / value).toFixed(2)}px`
    };
  }

  return {
    ACTIONS_EXPANDED_MIN_WIDTH,
    COMPACT_TOOLBAR_MAX_WIDTH,
    MIN_ZOOM,
    MAX_ZOOM,
    shouldExpandEditorActions,
    shouldUseCompactToolbar,
    normalizeEditorZoom,
    nextEditorZoom,
    readingLayout
  };
});
