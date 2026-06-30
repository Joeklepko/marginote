// shared/js/platform-desktop.js
// Tauri 实现，仅在桌面 WebView2 上下文内生效。
// 由 bridge-loader.js 在检测到 window.__TAURI__ 时动态加载。

(function () {
  if (typeof window === 'undefined' || !window.mn) return;

  // Tauri 2 的 invoke 入口有两种来源：
  //   - window.__TAURI__.core.invoke    （仅当 tauri.conf.json `withGlobalTauri: true` 时存在）
  //   - window.__TAURI_INTERNALS__.invoke（v2 始终注入；结构是 `.invoke`，不是 `.core.invoke`）
  // 旧实现只读 `tauri.core.invoke`，在 v2 默认配置下整个 desktop 桥接会静默失败 →
  // platform.kind 留在 'unknown'，存储信息走"独立网页"分支，标题栏不切主题，等等。
  const T = window.__TAURI__;
  const TI = window.__TAURI_INTERNALS__;
  const invoke =
    (T && T.core && typeof T.core.invoke === 'function' && T.core.invoke) ||
    (TI && typeof TI.invoke === 'function' && TI.invoke) ||
    null;
  if (!invoke) {
    console.warn('platform-desktop: invoke unavailable (neither __TAURI__.core nor __TAURI_INTERNALS__)');
    if (window.mn._readyResolve) window.mn._readyResolve();
    return;
  }
  // window.* / webviewWindow.* 命名空间（仅在 withGlobalTauri:true 时挂在 __TAURI__）
  const tauriWin = (T && T.window) || (TI && TI.window) || null;
  const tauriWebviewWin = (T && T.webviewWindow) || (TI && TI.webviewWindow) || null;

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

  // ===== 流式 fetch（SSE → Tauri events）=====
  platform.cmd_stream_fetch = async function (url, streamId, method, headers, body) {
    try {
      await invoke('cmd_stream_fetch', {
        url,
        streamId,
        method: method || 'POST',
        headers: headers || null,
        body: body || null,
      });
    } catch (e) {
      console.warn('cmd_stream_fetch fail', e);
      throw e;
    }
  };

  // ===== openExternal（系统默认浏览器打开外链，避免在主 webview 内导航把应用"顶掉"）=====
  // 走 tauri-plugin-shell 的 open 命令（capabilities 已授权 shell:allow-open）。
  platform.openExternal = async function (url) {
    try { await invoke('plugin:shell|open', { path: url }); return true; }
    catch (e) { console.warn('openExternal fail', e); return false; }
  };

  // ===== window =====
  platform.window = {
    async focus() { try { await invoke('cmd_window_focus'); } catch (e) {} },
    async minimize() {
      try {
        const w = tauriWin?.getCurrentWindow?.() || tauriWebviewWin?.getCurrentWebviewWindow?.();
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
    async getAppPaths() {
      // { data_dir, kv_file, webview_dir }
      try { return await invoke('cmd_get_app_paths'); }
      catch (e) { return null; }
    },
    async setWindowTheme(mode) {
      // mode: 'dark' | 'light' | 'system'
      try { await invoke('cmd_set_window_theme', { mode: mode || 'system' }); }
      catch (e) { /* 旧版本无此命令时静默失败 */ }
    },
  };

  // ===== fs（工作目录：Tauri 原生文件系统）=====
  // 选中的绝对路径由 Rust 持久化在 marginote.dat 的 workdir key。
  // 路径有效则重启后无需重新授权（原生 fs 不像浏览器有句柄过期问题）。
  platform.fs = {
    isAvailable() { return true; },
    async pickDir() {
      try {
        const name = await invoke('cmd_workdir_pick');
        return name ? { name } : null;
      } catch (e) { console.warn('workdir_pick fail', e); return null; }
    },
    async hasDir() {
      try { return !!(await invoke('cmd_workdir_status')); }
      catch (e) { return false; }
    },
    async dirName() {
      try { return (await invoke('cmd_workdir_status')) || null; }
      catch (e) { return null; }
    },
    async forget() {
      try { await invoke('cmd_workdir_forget'); } catch (e) {}
    },
    async list() {
      try { return (await invoke('cmd_workdir_list')) || []; }
      catch (e) { return []; }
    },
    async readText(relPath) {
      try { return await invoke('cmd_workdir_read_text', { rel: relPath }); }
      catch (e) { return null; }
    },
    async writeText(relPath, text) {
      try { await invoke('cmd_workdir_write_text', { rel: relPath, text }); return true; }
      catch (e) { console.warn('workdir_write_text fail', e); return false; }
    },
    async readBinary(relPath) {
      try { return await invoke('cmd_workdir_read_binary', { rel: relPath }); }
      catch (e) { return null; }
    },
    async writeBinary(relPath, base64) {
      try { await invoke('cmd_workdir_write_binary', { rel: relPath, b64: base64 }); return true; }
      catch (e) { console.warn('workdir_write_binary fail', e); return false; }
    },
    async remove(relPath) {
      try { await invoke('cmd_workdir_remove', { rel: relPath }); return true; }
      catch (e) { return false; }
    },
  };

  if (window.mn._readyResolve) window.mn._readyResolve();
})();
