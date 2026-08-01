// Pure editor UI calculations shared by the browser runtime and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteEditorUiCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ACTIONS_EXPANDED_MIN_WIDTH = 1280;
  const COMPACT_TOOLBAR_MAX_WIDTH = 1040;
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

  function readingLayout(viewportWidth) {
    const viewport = Number(viewportWidth);
    const safeViewport = Number.isFinite(viewport) && viewport > 0 ? Math.max(320, viewport) : 1280;
    const width = Math.min(1920, safeViewport * 0.88);
    const horizontalPadding = Math.max(32, Math.min(96, safeViewport * 0.045));
    return {
      width: Math.round(width * 100) / 100,
      horizontalPadding: Math.round(horizontalPadding * 100) / 100,
      contentWidth: Math.round(Math.max(0, width - horizontalPadding * 2) * 100) / 100
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
