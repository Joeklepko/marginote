// shared/js/platform-desktop.js
// Tauri 实现，仅在桌面 WebView2 上下文内生效。
// 由 bridge-loader.js 在检测到 window.__TAURI__ 时动态加载。

(function () {
  if (typeof window === 'undefined' || !window.mn) return;

  // Tauri 2 的 invoke 在 window.__TAURI__.core.invoke
  const tauri = window.__TAURI__ || window.__TAURI_INTERNALS__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
    console.warn('platform-desktop: window.__TAURI__.core.invoke unavailable');
    if (window.mn._readyResolve) window.mn._readyResolve();
    return;
  }
  const invoke = tauri.core.invoke;

  const platform = window.mn.platform;
  platform.kind = 'desktop';

  // ===== storage =====
  // 走自家 cmd_kv_* 命令（marginote.dat 在 app_data_dir）。
  // 主要为 mn.platform.storage('marginoteTodos') 服务，让 Rust scheduler 也能读到。
  // 普通业务 bulk 数据继续走 WebView 自带的 localStorage。
  platform.storage = {
    async get(key) {
      try {
        const v = await invoke('cmd_kv_get', { key });
        return v == null ? null : v;
      } catch (e) { console.warn('storage.get fail', e); return null; }
    },
    async set(key, value) {
      try { await invoke('cmd_kv_set', { key, value }); }
      catch (e) { console.warn('storage.set fail', e); }
    },
    async remove(key) {
      try { await invoke('cmd_kv_remove', { key }); }
      catch (e) { console.warn('storage.remove fail', e); }
    },
    async keys() {
      try { return (await invoke('cmd_kv_keys')) || []; }
      catch (e) { return []; }
    },
  };

  // ===== alarms =====
  platform.alarms = {
    async create(name, whenMs) {
      try { await invoke('cmd_alarm_set', { name, whenMs }); }
      catch (e) { console.warn('alarms.create fail', e); }
    },
    async clear(name) {
      try { await invoke('cmd_alarm_clear', { name }); }
      catch (e) { console.warn('alarms.clear fail', e); }
    },
    async getAll() {
      try { return (await invoke('cmd_alarm_list')) || []; }
      catch (e) { return []; }
    },
    onFire(_cb) {
      // 桌面端：alarm 触发由 Rust 直接调 tauri-plugin-notification 弹通知，
      // 前端无需订阅；保留接口以兼容。
    },
  };

  // ===== notify（前端主动弹通知，例如 AI 助手提示）=====
  platform.notify = async function (title, body, opts) {
    try {
      // 用 plugin-notification 的 JS API（其 invoke 命令）
      await invoke('plugin:notification|notify', {
        options: {
          title: title || '',
          body: body || '',
        },
      });
    } catch (e) {
      console.warn('notify fail', e);
    }
  };

  // ===== fetch =====
  platform.fetch = async function (url, init, proxyConfig) {
    init = init || {};
    try {
      const res = await invoke('cmd_fetch', {
        url,
        method: init.method || 'POST',
        headers: init.headers || null,
        body: init.body || null,
        proxy: proxyConfig || null,
      });
      return res;
    } catch (e) {
      return { ok: false, status: 0, body: '', error: String(e) };
    }
  };

  // ===== window =====
  platform.window = {
    async focus() { try { await invoke('cmd_window_focus'); } catch (e) {} },
    async minimize() {
      try {
        const w = tauri.window?.getCurrentWindow?.() || tauri.webviewWindow?.getCurrentWebviewWindow?.();
        if (w) await w.minimize();
      } catch (e) {}
    },
    async hide() { try { await invoke('cmd_window_hide'); } catch (e) {} },
  };

  // ===== desktop 专属（hotkey / autostart 在 P4 接通）=====
  platform.desktop = {
    isAvailable: true,
    async getAutostart() {
      try {
        return await invoke('plugin:autostart|is_enabled');
      } catch (e) { return false; }
    },
    async setAutostart(on) {
      try {
        if (on) await invoke('plugin:autostart|enable');
        else await invoke('plugin:autostart|disable');
      } catch (e) { console.warn('autostart fail', e); }
    },
    async registerHotkey(combo) {
      // Rust 端处理：注册 combo + 按下时聚焦窗口
      await invoke('cmd_register_hotkey', { combo });
    },
    async unregisterHotkey() {
      try { await invoke('cmd_unregister_hotkey'); } catch (e) {}
    },
  };

  if (window.mn._readyResolve) window.mn._readyResolve();
})();
