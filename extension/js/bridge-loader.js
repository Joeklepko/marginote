// shared/js/bridge-loader.js
// 检测运行环境，动态加载对应 bridge 实现。
// 加载完成后由 bridge 自身调用 mn._readyResolve()。

(function () {
  if (typeof window === 'undefined' || !window.mn) return;

  const isTauri =
    typeof window.__TAURI__ !== 'undefined' ||
    typeof window.__TAURI_INTERNALS__ !== 'undefined';
  const src = isTauri ? 'js/platform-desktop.js' : 'js/platform-extension.js';

  const s = document.createElement('script');
  s.src = src;
  s.async = false;                         // 保持执行顺序

  s.onerror = () => {
    console.error('mn.platform: bridge script failed to load:', src);
    if (window.mn._readyResolve) window.mn._readyResolve();
  };

  document.head.appendChild(s);
})();
