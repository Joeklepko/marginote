// shared/js/platform-extension.js
// chrome.* 实现，仅在 Chrome 扩展上下文内生效。
// 由 bridge-loader.js 动态加载。

(function () {
  if (typeof window === 'undefined' || !window.mn) return;

  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  if (!hasChrome) {
    // 通过 file:// 或本地服务器直接打开 index.html 调试场景：用浏览器原生 fetch 兜底
    console.warn('platform-extension: chrome runtime unavailable, using direct fetch fallback');
    const platform = window.mn.platform;
    platform.kind = 'web';
    platform.fetch = async function (url, init) {
      init = init || {};
      try {
        const res = await fetch(url, {
          method: init.method || 'POST',
          headers: init.headers || {},
          body: init.body || null,
        });
        const body = await res.text();
        return { ok: res.ok, status: res.status, body };
      } catch (e) {
        return { ok: false, status: 0, body: '', error: String(e) };
      }
    };
    if (window.mn._readyResolve) window.mn._readyResolve();
    return;
  }

  const platform = window.mn.platform;
  platform.kind = 'extension';

  // ===== storage =====
  platform.storage = {
    get(key) {
      return new Promise(res => {
        try {
          chrome.storage.local.get(key, items => {
            const has = items && Object.prototype.hasOwnProperty.call(items, key);
            res(has ? items[key] : null);
          });
        } catch (e) { res(null); }
      });
    },
    set(key, value) {
      return new Promise(res => {
        try { chrome.storage.local.set({ [key]: value }, () => res()); }
        catch (e) { res(); }
      });
    },
    remove(key) {
      return new Promise(res => {
        try { chrome.storage.local.remove(key, () => res()); }
        catch (e) { res(); }
      });
    },
    keys() {
      return new Promise(res => {
        try { chrome.storage.local.get(null, all => res(Object.keys(all || {}))); }
        catch (e) { res([]); }
      });
    },
  };

  // ===== alarms =====
  // 扩展端：alarm 触发由 background.js 接收并直接弹通知，前端无需 onFire
  platform.alarms = {
    create(name, whenMs) {
      return new Promise(res => {
        try {
          if (chrome.alarms) chrome.alarms.create(name, { when: whenMs });
        } catch (e) { /* swallow */ }
        res();
      });
    },
    clear(name) {
      return new Promise(res => {
        try {
          if (chrome.alarms) chrome.alarms.clear(name, () => res());
          else res();
        } catch (e) { res(); }
      });
    },
    getAll() {
      return new Promise(res => {
        try {
          if (!chrome.alarms) { res([]); return; }
          chrome.alarms.getAll(all =>
            res((all || []).map(a => ({ name: a.name, scheduledTime: a.scheduledTime })))
          );
        } catch (e) { res([]); }
      });
    },
    onFire(_cb) { /* no-op: background.js handles firing */ },
  };

  // ===== notify =====
  platform.notify = function (title, body, opts) {
    return new Promise(res => {
      try {
        if (!chrome.notifications) { res(); return; }
        const id = 'marginote-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        chrome.notifications.create(id, {
          type: 'basic',
          iconUrl: (opts && opts.iconUrl) || 'icons/icon128.png',
          title: title || '',
          message: body || '',
          requireInteraction: !!(opts && opts.requireInteraction),
        }, () => res());
      } catch (e) { res(); }
    });
  };

  // ===== fetch (走 background) =====
  platform.fetch = function (url, init, proxyConfig) {
    init = init || {};
    return new Promise((resolve, reject) => {
      const msg = proxyConfig
        ? {
            type: 'proxyFetch',
            url,
            method: init.method || 'POST',
            headers: init.headers || {},
            body: init.body || null,
            proxyConfig,
          }
        : {
            type: 'simpleFetch',
            url,
            method: init.method || 'POST',
            headers: init.headers || {},
            body: init.body || null,
          };
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'sendMessage failed'));
            return;
          }
          if (!res) { reject(new Error('background returned no response')); return; }
          resolve(res);
        });
      } catch (e) { reject(e); }
    });
  };

  // ===== window =====
  // 扩展端：聚焦由 background.js 监听 action 点击处理；前端调用是 no-op
  platform.window = {
    focus() { return Promise.resolve(); },
    minimize() { return Promise.resolve(); },
    hide() { return Promise.resolve(); },
  };

  // ===== desktop（stub）=====
  platform.desktop.isAvailable = false;

  if (window.mn._readyResolve) window.mn._readyResolve();
})();
