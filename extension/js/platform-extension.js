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

  // ===== fs（工作目录：File System Access API）=====
  // 目录句柄存在 IndexedDB（marginote / meta / workdirHandle）。重装扩展后
  // 句柄会失效，用户需重新「选择工作目录」选中同一目录即可恢复。
  const WFS_DB = 'marginote', WFS_STORE = 'meta', WFS_KEY = 'workdirHandle';
  let _wdHandle = null;
  let _wdLoaded = false;

  function wfsOpenDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(WFS_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function wfsGetStored() {
    try {
      const db = await wfsOpenDb();
      if (!db.objectStoreNames.contains(WFS_STORE)) return null;
      return await new Promise((res) => {
        const tx = db.transaction(WFS_STORE, 'readonly');
        const r = tx.objectStore(WFS_STORE).get(WFS_KEY);
        r.onsuccess = () => res(r.result ? r.result.value : null);
        r.onerror = () => res(null);
      });
    } catch { return null; }
  }
  async function wfsPutStored(handle) {
    try {
      const db = await wfsOpenDb();
      if (!db.objectStoreNames.contains(WFS_STORE)) return;
      await new Promise((res) => {
        const tx = db.transaction(WFS_STORE, 'readwrite');
        tx.objectStore(WFS_STORE).put({ key: WFS_KEY, value: handle });
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
    } catch {}
  }
  async function wfsDelStored() {
    try {
      const db = await wfsOpenDb();
      if (!db.objectStoreNames.contains(WFS_STORE)) return;
      await new Promise((res) => {
        const tx = db.transaction(WFS_STORE, 'readwrite');
        tx.objectStore(WFS_STORE).delete(WFS_KEY);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
    } catch {}
  }
  async function wfsLoad() {
    if (_wdLoaded) return;
    _wdHandle = await wfsGetStored();
    _wdLoaded = true;
  }
  async function wfsPerm(mode) {
    if (!_wdHandle) return false;
    const opts = { mode: mode || 'readwrite' };
    try {
      if ((await _wdHandle.queryPermission(opts)) === 'granted') return true;
      if ((await _wdHandle.requestPermission(opts)) === 'granted') return true;
    } catch {}
    return false;
  }
  async function wfsResolveFile(relPath, create) {
    if (!_wdHandle) return null;
    const parts = relPath.split('/').filter(Boolean);
    if (!parts.length) return null;
    const fname = parts.pop();
    let dir = _wdHandle;
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg, { create: !!create });
    }
    return { dir, fname };
  }
  async function wfsWalk(dirHandle, prefix, out) {
    for await (const [name, h] of dirHandle.entries()) {
      const rel = prefix ? prefix + '/' + name : name;
      if (h.kind === 'directory') {
        out.push({ path: rel, dir: true, mtime: 0 });
        await wfsWalk(h, rel, out);
      } else {
        let mtime = 0;
        try { mtime = (await h.getFile()).lastModified; } catch {}
        out.push({ path: rel, dir: false, mtime });
      }
    }
  }

  platform.fs = {
    isAvailable() { return typeof window !== 'undefined' && !!window.showDirectoryPicker; },
    async pickDir() {
      if (!window.showDirectoryPicker) return null;
      const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
      _wdHandle = handle; _wdLoaded = true;
      await wfsPutStored(handle);
      return { name: handle.name };
    },
    async hasDir() {
      await wfsLoad();
      if (!_wdHandle) return false;
      return await wfsPerm('readwrite');
    },
    async dirName() {
      await wfsLoad();
      return _wdHandle ? _wdHandle.name : null;
    },
    async forget() {
      _wdHandle = null; _wdLoaded = true;
      await wfsDelStored();
    },
    async list() {
      await wfsLoad();
      if (!_wdHandle || !(await wfsPerm('read'))) return [];
      const out = [];
      try { await wfsWalk(_wdHandle, '', out); } catch {}
      return out;
    },
    async readText(relPath) {
      await wfsLoad();
      if (!_wdHandle || !(await wfsPerm('read'))) return null;
      try {
        const r = await wfsResolveFile(relPath, false);
        if (!r) return null;
        const fh = await r.dir.getFileHandle(r.fname);
        return await (await fh.getFile()).text();
      } catch { return null; }
    },
    async writeText(relPath, text) {
      await wfsLoad();
      if (!_wdHandle || !(await wfsPerm('readwrite'))) return false;
      try {
        const r = await wfsResolveFile(relPath, true);
        const fh = await r.dir.getFileHandle(r.fname, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        return true;
      } catch { return false; }
    },
    async readBinary(relPath) {
      await wfsLoad();
      if (!_wdHandle || !(await wfsPerm('read'))) return null;
      try {
        const r = await wfsResolveFile(relPath, false);
        if (!r) return null;
        const fh = await r.dir.getFileHandle(r.fname);
        const buf = await (await fh.getFile()).arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      } catch { return null; }
    },
    async writeBinary(relPath, base64) {
      await wfsLoad();
      if (!_wdHandle || !(await wfsPerm('readwrite'))) return false;
      try {
        const r = await wfsResolveFile(relPath, true);
        const fh = await r.dir.getFileHandle(r.fname, { create: true });
        const w = await fh.createWritable();
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await w.write(bytes);
        await w.close();
        return true;
      } catch { return false; }
    },
    async remove(relPath) {
      await wfsLoad();
      if (!_wdHandle || !(await wfsPerm('readwrite'))) return false;
      try {
        const r = await wfsResolveFile(relPath, false);
        if (!r) return false;
        await r.dir.removeEntry(r.fname);
        return true;
      } catch { return false; }
    },
  };

  if (window.mn._readyResolve) window.mn._readyResolve();
})();
