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
    },
  };

  // mn.ready —— bridge 实现末尾会 resolve 它
  window.mn.ready = new Promise(resolve => {
    window.mn._readyResolve = resolve;
  });
})();
