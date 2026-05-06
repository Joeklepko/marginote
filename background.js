// Marginote service worker — action 点击聚焦 / 待办提醒
const APP_URL = chrome.runtime.getURL('index.html');
const APP_PATTERN = chrome.runtime.getURL('*'); // 匹配本扩展所有 tab
const REMIND_KEY = 'marginoteTodos';
const ALARM_PREFIX = 'mtodo:';

async function focusOrOpenApp() {
  // 查找所有本扩展的 tab（包括 newtab override 触发的）
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: APP_PATTERN }); } catch (e) {}
  if (!tabs.length) {
    await chrome.tabs.create({ url: APP_URL });
    return;
  }
  // 优先聚焦当前活动窗口里的；否则第一个
  let target = tabs[0];
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    const inWin = tabs.find(t => t.windowId === win.id);
    if (inWin) target = inWin;
  } catch (e) {}
  try {
    await chrome.tabs.update(target.id, { active: true });
    if (target.windowId) await chrome.windows.update(target.windowId, { focused: true });
  } catch (e) {
    // 极端情况：tab 已被关闭，回退新建
    await chrome.tabs.create({ url: APP_URL });
  }
}

chrome.action.onClicked.addListener(focusOrOpenApp);

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: APP_URL });
});

// ===== 待办提醒 =====
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const id = alarm.name.slice(ALARM_PREFIX.length).split(':')[0];
  const data = (await chrome.storage.local.get(REMIND_KEY))[REMIND_KEY] || [];
  const t = data.find(x => x.id === id);
  if (!t || t.done) return;
  const minLeft = Math.round((t.dueDate - Date.now()) / 60000);
  let body;
  if (minLeft > 60) body = `${Math.round(minLeft / 60)} 小时后到期`;
  else if (minLeft > 0) body = `${minLeft} 分钟后到期`;
  else if (minLeft === 0) body = '现在到期';
  else body = `已逾期 ${-minLeft} 分钟`;
  chrome.notifications.create('marginote-' + alarm.name, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '待办提醒：' + (t.text || '无标题'),
    message: body,
    priority: 1,
    requireInteraction: minLeft <= 0
  });
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith('marginote-')) return;
  await focusOrOpenApp();
  chrome.notifications.clear(notifId);
});

// 启动时清理过期 alarm
chrome.runtime.onStartup.addListener(async () => {
  const all = await chrome.alarms.getAll();
  const now = Date.now();
  for (const a of all) {
    if (a.name.startsWith(ALARM_PREFIX) && a.scheduledTime < now - 86400000) {
      chrome.alarms.clear(a.name);
    }
  }
});

// ===== AI 模型代理（仅临时用于单次请求，不持久化影响浏览器全局）=====
function buildPac(proxyHost, proxyPort, scheme, providerHost) {
  const h = JSON.stringify(providerHost);
  const dom = JSON.stringify('.' + providerHost);
  return `function FindProxyForURL(url, host) { if (host === ${h} || dnsDomainIs(host, ${dom})) return "${scheme} ${proxyHost}:${proxyPort}"; return "DIRECT"; }`;
}

async function setProxyTemporarily(proxyConfig) {
  const { providerHost, proxyHost, proxyPort, scheme } = proxyConfig;
  const pac = buildPac(proxyHost, proxyPort, scheme, providerHost);
  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: pac } },
    scope: 'regular'
  });
}

async function clearProxy() {
  try { await chrome.proxy.settings.set({ value: { mode: 'system' }, scope: 'regular' }); }
  catch (e) { console.warn('clear proxy fail', e); }
}

// 代理鉴权缓存（仅用于当前单次请求）
let pendingAuth = null;

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  // 临时代理 + 一次 fetch
  if (msg && msg.type === 'proxyFetch') {
    const { url, method, headers, body, proxyConfig } = msg;
    const authKey = proxyConfig.host + ':' + proxyConfig.port;
    if (proxyConfig.user) {
      pendingAuth = { [authKey]: { username: proxyConfig.user, password: proxyConfig.pass || '' } };
    }
    setProxyTemporarily(proxyConfig)
      .then(() => {
        // 用 AbortController 避免长时间挂起
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const fetchOpts = { method: method || 'POST', headers, signal: controller.signal };
        if (body) fetchOpts.body = body;
        return fetch(url, fetchOpts).then(async res => {
          clearTimeout(timer);
          // 读取响应（可能是 JSON 或文本）
          const text = await res.text();
          return { ok: res.ok, status: res.status, body: text };
        });
      })
      .then(result => {
        pendingAuth = null;
        clearProxy().then(() => send(result)).catch(() => send(result));
      })
      .catch(err => {
        pendingAuth = null;
        clearProxy().then(() => send({ ok: false, error: String(err) })).catch(() => send({ ok: false, error: String(err) }));
      });
    return true; // 保持 channel 开放
  }

  // 旧版兼容：保留但不触发浏览器全局代理（只重置为 system）
  if (msg && msg.type === 'applyProxyRules') {
    clearProxy().then(() => send({ ok: true })).catch(e => send({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'clearProxy') {
    clearProxy().then(() => send({ ok: true }));
    return true;
  }
});

// 代理 auth（仅用于通过 background fetch 的单次请求）
if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  chrome.webRequest.onAuthRequired.addListener(
    async (details, callback) => {
      try {
        if (!details.isProxy) { callback({}); return; }
        if (!pendingAuth) { callback({}); return; }
        const ch = details.challenger || {};
        const key = (ch.host || '') + ':' + (ch.port || '');
        const cred = pendingAuth[key];
        if (cred) callback({ authCredentials: cred });
        else callback({});
      } catch { callback({}); }
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking']
  );
}
