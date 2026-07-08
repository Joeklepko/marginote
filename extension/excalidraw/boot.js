// Excalidraw 宿主页引导脚本（必须在 react/excalidraw 之前执行）。
//
// 为什么是独立文件而不是内联 <script>：
//   Chrome 扩展 MV3 的 extension_pages CSP 是 `script-src 'self'`，会拦截
//   一切内联脚本与内联 onerror= 事件属性。内联脚本被拦 → 这段垫片不执行 →
//   ExcalidrawLib 不挂载 → 画板空白/无工具栏。改成外部 .js 即可在
//   `script-src 'self'` 下正常运行（桌面 Tauri 的 CSP 也兼容）。
//
// 职责：
//   1) process 垫片：Excalidraw UMD 内部引用 process.env.NODE_ENV，未定义会抛
//      ReferenceError 导致库不挂载。
//   2) EXCALIDRAW_ASSET_PATH：字体/语言包/分包从本地 ./vendor/excalidraw-assets/
//      加载（库会自动在该 base 后拼接 "excalidraw-assets/..."），避开 CDN —
//      MV3 / Tauri 的 CSP 都不允许走外网。
//   3) 资源加载诊断：用捕获阶段的 error 监听代替被 CSP 拦掉的内联 onerror=，
//      记录 404 的脚本名与运行时错误，供 app.js 精确报错。
(function () {
  'use strict';
  window.process = window.process || { env: {} };
  if (!window.process.env) window.process.env = {};
  if (!window.process.env.NODE_ENV) window.process.env.NODE_ENV = 'production';

  // 资源就在宿主页同级的 ./vendor/ 下（已随仓库/打包内置，无需联网）。
  window.EXCALIDRAW_ASSET_PATH = './vendor/';

  window.__loadErr = [];
  // 捕获阶段(true)才能收到 <script>/<link> 这类资源的 error 事件（不冒泡）。
  window.addEventListener('error', function (e) {
    try {
      var t = e && e.target;
      if (t && t.tagName === 'SCRIPT' && t.src) {
        window.__loadErr.push(t.src.split('/').pop());
      } else if (t && t.tagName === 'LINK' && t.href) {
        window.__loadErr.push(t.href.split('/').pop());
      } else if (e && e.message) {
        window.__runtimeErr = e.message;
      }
    } catch (x) {}
  }, true);
  // Promise 异常（Excalidraw 的字体/分包是异步加载，失败常以 rejection 形式出现）
  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && e.reason;
      window.__runtimeErr = (r && (r.message || r)) ? String(r.message || r) : 'unhandledrejection';
    } catch (x) {}
  });
})();
