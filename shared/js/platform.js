// shared/js/platform.js
// 平台抽象接口契约（mn.platform）。
// 真实现由 bridge-loader.js 在运行时注入：扩展端用 chrome.*，桌面端用 Tauri。
// 业务代码使用前必须先 `await mn.ready`，否则方法返回 reject。

(function () {
  if (typeof window === 'undefined') return;
  window.mn = window.mn || {};

  const NOT_READY = () =>
    Promise.reject(new Error('mn.platform: bridge not loaded yet — await mn.ready first'));

  window.mn.platform = {
    kind: 'unknown',                         // 'extension' | 'desktop'

    storage: {
      get: NOT_READY,                        // (key) → Promise<any|null>
      set: NOT_READY,                        // (key, value) → Promise<void>
      remove: NOT_READY,                     // (key) → Promise<void>
      keys: NOT_READY,                       // () → Promise<string[]>
    },

    alarms: {
      create: NOT_READY,                     // (name, whenMs) → Promise<void>
      clear: NOT_READY,                      // (name) → Promise<void>
      getAll: NOT_READY,                     // () → Promise<{name, scheduledTime}[]>
      onFire: () => {},                      // (cb) → void  （扩展端 no-op，桌面端订阅事件）
    },

    notify: NOT_READY,                       // (title, body, opts?) → Promise<void>

    fetch: NOT_READY,                        // (url, init?, proxyConfig?) → Promise<{ok, status, body, error?}>

    // 在外部打开 URL（系统浏览器/新标签页），避免在应用 webview 内导航导致"陷在网页里出不来"。
    // 默认走 window.open（扩展/纯网页适用）；桌面端在 platform-desktop.js 覆盖为 Tauri shell open。
    openExternal: (url) => { try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) {} return Promise.resolve(true); },

    window: {
      focus: NOT_READY,                      // () → Promise<void>
      minimize: NOT_READY,
      hide: NOT_READY,
    },

    desktop: {
      isAvailable: false,
      getAutostart: () => Promise.resolve(false),
      setAutostart: () => Promise.resolve(),
      registerHotkey: () => Promise.resolve(),
      unregisterHotkey: () => Promise.resolve(),
      getAppPaths: () => Promise.resolve(null),     // () → Promise<{data_dir, kv_file, webview_dir}|null>
      setWindowTheme: () => Promise.resolve(),       // (mode: 'dark'|'light'|'system') → Promise<void>
    },

    // 工作目录文件系统（v1.3 → v1.4）。
    // 扩展端用 File System Access API（句柄存 IndexedDB）；桌面端用 Tauri 原生
    // 命令（绝对路径存 kv）。两端实现签名一致，业务代码只调 mn.platform.fs.*。
    // relPath 一律用 '/' 分隔的相对路径，相对工作目录根。
    fs: {
      isAvailable: () => false,                 // () → bool：当前平台是否支持工作目录
      pickDir: () => Promise.resolve(null),     // () → Promise<{name}|null>：弹选择器，持久化所选目录
      hasDir: () => Promise.resolve(false),     // () → Promise<bool>：是否已绑定且可访问
      dirName: () => Promise.resolve(null),     // () → Promise<string|null>：已绑定目录显示名
      forget: () => Promise.resolve(),          // () → Promise<void>：解绑（不删磁盘文件）
      list: () => Promise.resolve([]),          // () → Promise<{path, mtime, dir}[]>：递归列出全部条目
      readText: () => Promise.resolve(null),    // (relPath) → Promise<string|null>
      writeText: () => Promise.resolve(false),  // (relPath, text) → Promise<bool>
      readBinary: () => Promise.resolve(null),  // (relPath) → Promise<base64|null>
      writeBinary: () => Promise.resolve(false),// (relPath, base64) → Promise<bool>
      remove: () => Promise.resolve(false),     // (relPath) → Promise<bool>
      mkdir: () => Promise.resolve(false),      // (relPath) → Promise<bool>
      move: () => Promise.resolve(false),       // (fromRel, toRel) → Promise<bool>
    },
  };

  // mn.ready —— bridge 实现末尾会 resolve 它
  window.mn.ready = new Promise(resolve => {
    window.mn._readyResolve = resolve;
  });
})();
