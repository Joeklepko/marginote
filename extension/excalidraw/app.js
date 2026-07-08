// Marginote 画板主逻辑（独立文件，MV3 `script-src 'self'` 下可执行）。
// 通过 postMessage 与父窗口（侧栏）交换场景：load / request-save / set-theme /
// request-export / refresh。依赖由 react/react-dom/excalidraw 三个 UMD 提供，
// 由 boot.js 注入 process 垫片与 EXCALIDRAW_ASSET_PATH 后按序加载。
(function () {
  'use strict';

  // 分项诊断：区分“文件 404”与“已加载但未初始化”，便于精确定位
  function missingReason() {
    if (window.__loadErr && window.__loadErr.length) return '脚本文件加载失败(可能 404)：' + window.__loadErr.join(', ');
    if (typeof window.React === 'undefined') return 'React 未定义';
    if (typeof window.ReactDOM === 'undefined') return 'ReactDOM 未定义';
    if (typeof window.ExcalidrawLib === 'undefined') {
      return 'ExcalidrawLib 未定义' + (window.__runtimeErr ? '（运行时错误：' + window.__runtimeErr + '）' : '（excalidraw 包已加载但未初始化）');
    }
    return '';
  }

  // 把环境状态拼成一行，便于在用户机器上（尤其是无法在此复现的 WebView2）定位白屏。
  function diagSnapshot() {
    var root = document.getElementById('root');
    return [
      'React=' + typeof window.React,
      'ReactDOM=' + typeof window.ReactDOM,
      'ExcalidrawLib=' + typeof window.ExcalidrawLib,
      'loadErr=[' + ((window.__loadErr || []).join(',')) + ']',
      'runtimeErr=' + (window.__runtimeErr || '-'),
      'rootKids=' + (root ? root.childElementCount : 'n/a'),
      'assetPath=' + (window.EXCALIDRAW_ASSET_PATH || '-'),
      'ua=' + ((navigator.userAgent || '').slice(0, 70))
    ].join(' | ');
  }

  // 统一的「显示诊断」：把白屏变成可读原因，并上报父窗口。
  function showHint(reason) {
    try { console.error('[mn-excalidraw] 未就绪：' + reason); } catch (e) {}
    const detail = document.getElementById('setup-detail');
    if (detail) detail.textContent = '诊断：' + reason;
    const hint = document.getElementById('setup-hint');
    if (hint) hint.classList.add('show');
    try { parent.postMessage({ source: 'mn-excalidraw', type: 'assets-missing', reason: reason }, '*'); } catch (e) {}
  }
  function hideHint() {
    const hint = document.getElementById('setup-hint');
    if (hint) hint.classList.remove('show');
  }

  const reason = missingReason();
  if (reason) { showHint(reason + ' || ' + diagSnapshot()); return; }

  const Lib = window.ExcalidrawLib;
  const { Excalidraw, serializeAsJSON } = Lib;
  let excalidrawAPI = null;
  let pendingScene = null;   // 父窗口在 ready 之前发来的场景
  let saveTimer = null;
  let thumbTimer = null;
  let readyWatchdog = null;  // 看门狗：超时未就绪则把白屏变成可读诊断

  function postToParent(msg) {
    try { parent.postMessage(Object.assign({ source: 'mn-excalidraw' }, msg), '*'); } catch (e) {}
  }

  function currentSceneJSON() {
    if (!excalidrawAPI) return '';
    try {
      return serializeAsJSON(
        excalidrawAPI.getSceneElements(),
        excalidrawAPI.getAppState(),
        excalidrawAPI.getFiles(),
        'local'
      );
    } catch (e) { return ''; }
  }

  function blobToB64(blob) {
    return new Promise(function (resolve) {
      const r = new FileReader();
      r.onload = function () {
        const s = String(r.result || '');
        const i = s.indexOf('base64,');
        resolve(i >= 0 ? s.slice(i + 7) : '');
      };
      r.onerror = function () { resolve(''); };
      r.readAsDataURL(blob);
    });
  }

  // 生成缩略图 PNG base64（长边 ~320px）。失败返回 ''。
  async function makeThumb() {
    if (!excalidrawAPI || typeof Lib.exportToBlob !== 'function') return '';
    try {
      const elements = excalidrawAPI.getSceneElements();
      if (!elements || !elements.length) return '';
      const blob = await Lib.exportToBlob({
        elements: elements,
        appState: Object.assign({}, excalidrawAPI.getAppState(), { exportBackground: true }),
        files: excalidrawAPI.getFiles(),
        mimeType: 'image/png',
        maxWidthOrHeight: 320,
      });
      return await blobToB64(blob);
    } catch (e) { return ''; }
  }

  // 导出整图 PNG/SVG base64（用于「导出到笔记」，全尺寸）
  async function exportFull(kind) {
    if (!excalidrawAPI) return null;
    const elements = excalidrawAPI.getSceneElements();
    if (!elements || !elements.length) return null;
    const appState = Object.assign({}, excalidrawAPI.getAppState(), { exportBackground: true });
    const files = excalidrawAPI.getFiles();
    try {
      if (kind === 'svg' && typeof Lib.exportToSvg === 'function') {
        const svg = await Lib.exportToSvg({ elements: elements, appState: appState, files: files });
        const str = new XMLSerializer().serializeToString(svg);
        return { ext: '.svg', mime: 'image/svg+xml', b64: btoa(unescape(encodeURIComponent(str))) };
      }
      if (typeof Lib.exportToBlob === 'function') {
        const blob = await Lib.exportToBlob({ elements: elements, appState: appState, files: files, mimeType: 'image/png', maxWidthOrHeight: 2000 });
        return { ext: '.png', mime: 'image/png', b64: await blobToB64(blob) };
      }
    } catch (e) { postToParent({ type: 'error', message: 'export failed: ' + (e && e.message) }); }
    return null;
  }

  function loadSceneJSON(json) {
    if (!excalidrawAPI) { pendingScene = json; return; }
    try {
      const data = (json && json.trim()) ? JSON.parse(json) : { elements: [], appState: {} };
      excalidrawAPI.updateScene({
        elements: data.elements || [],
        appState: Object.assign({}, data.appState || {}, { collaborators: [] }),
      });
      if (data.files && Object.keys(data.files).length) {
        const arr = Object.keys(data.files).map(function (k) { return data.files[k]; });
        try { excalidrawAPI.addFiles(arr); } catch (e) {}
      }
      try { excalidrawAPI.scrollToContent(); } catch (e) {}
      // 加载后强制刷新画布尺寸（修复 canvas rect 缓存为 0 导致无法编辑）
      try { excalidrawAPI.refresh(); } catch (e) {}
    } catch (e) {
      postToParent({ type: 'error', message: 'load scene failed: ' + (e && e.message) });
    }
  }

  // 父 → iframe 消息
  window.addEventListener('message', async function (ev) {
    const d = ev.data;
    if (!d || d.target !== 'mn-excalidraw') return;
    if (d.type === 'load') {
      loadSceneJSON(d.json || '');
    } else if (d.type === 'request-save') {
      postToParent({ type: 'scene', json: currentSceneJSON() });
    } else if (d.type === 'set-theme') {
      if (excalidrawAPI) {
        try { excalidrawAPI.updateScene({ appState: { theme: d.dark ? 'dark' : 'light' } }); } catch (e) {}
      }
    } else if (d.type === 'request-export') {
      const out = await exportFull(d.kind || 'png');
      postToParent({ type: 'export', kind: d.kind || 'png', data: out });
    } else if (d.type === 'refresh') {
      if (excalidrawAPI) { try { excalidrawAPI.refresh(); } catch (e) {} }
    }
  });

  function onChange() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      postToParent({ type: 'scene', json: currentSceneJSON() });
    }, 800);
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(async function () {
      const b64 = await makeThumb();
      if (b64) postToParent({ type: 'thumb', b64: b64 });
    }, 1400);
  }

  function isDark() {
    try { return new URLSearchParams(location.search).get('theme') === 'dark'; }
    catch (e) { return false; }
  }

  // 窗口尺寸变化时刷新画布（容器从 0→有尺寸、或拖动分隔时）
  window.addEventListener('resize', function () {
    if (excalidrawAPI) { try { excalidrawAPI.refresh(); } catch (e) {} }
  });

  const e = window.React.createElement;
  function App() {
    return e(Excalidraw, {
      excalidrawAPI: function (api) {
        excalidrawAPI = api;
        if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
        hideHint();   // 万一看门狗已先弹诊断，就绪后撤掉
        if (pendingScene) { loadSceneJSON(pendingScene); pendingScene = null; }
        // 首帧后再刷新一次，确保拿到正确容器尺寸
        setTimeout(function () { try { api.refresh(); } catch (e) {} }, 60);
        postToParent({ type: 'ready' });
      },
      onChange: onChange,
      theme: isDark() ? 'dark' : 'light',
      langCode: 'zh-CN',
    });
  }

  // 渲染期同步异常（如某依赖被环境拦截）→ 直接显示原因，而不是白屏
  try {
    window.ReactDOM.createRoot(document.getElementById('root')).render(e(App));
  } catch (err) {
    showHint('渲染异常：' + (err && err.message ? err.message : String(err)) + ' || ' + diagSnapshot());
    return;
  }

  // 看门狗：7s 内 Excalidraw 仍未回调 ready（异步分包/字体卡住、运行时报错等），
  // 把白屏替换成一行可读诊断，方便用户把原因发回来定位。
  readyWatchdog = setTimeout(function () {
    if (!excalidrawAPI) showHint('Excalidraw 7s 未就绪（疑似白屏）：' + diagSnapshot());
  }, 7000);
})();
