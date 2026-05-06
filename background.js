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

// ===== AI 模型代理（chrome.proxy + 仅作用于各 provider host）=====
const PROXY_KEY = 'marginoteProxyV2';

async function applyProxyRules(rules) {
  if (!rules || !rules.length) return clearProxy();
  const lines = rules.map(r => {
    const h = JSON.stringify(r.providerHost);
    const dom = JSON.stringify('.' + r.providerHost);
    return `if (host === ${h} || dnsDomainIs(host, ${dom})) return "${r.scheme} ${r.proxyHost}:${r.proxyPort}";`;
  });
  const pac = `function FindProxyForURL(url, host) { ${lines.join(' ')} return "DIRECT"; }`;
  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: pac } },
    scope: 'regular'
  });
  const authMap = {};
  rules.forEach(r => {
    if (r.user) authMap[r.proxyHost + ':' + r.proxyPort] = { username: r.user, password: r.pass || '' };
  });
  await chrome.storage.local.set({ [PROXY_KEY]: { rules, authMap, ts: Date.now() } });
}

async function clearProxy() {
  try { await chrome.proxy.settings.set({ value: { mode: 'system' }, scope: 'regular' }); }
  catch (e) { console.warn('clear proxy fail', e); }
  await chrome.storage.local.remove(PROXY_KEY);
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg && msg.type === 'applyProxyRules') {
    applyProxyRules(msg.rules).then(() => send({ ok: true })).catch(e => send({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'clearProxy') {
    clearProxy().then(() => send({ ok: true }));
    return true;
  }
});

// 重启恢复
chrome.runtime.onStartup.addListener(async () => {
  const cfg = (await chrome.storage.local.get(PROXY_KEY))[PROXY_KEY];
  if (cfg && cfg.rules) applyProxyRules(cfg.rules).catch(() => {});
});

// 代理 auth
if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  chrome.webRequest.onAuthRequired.addListener(
    async (details, callback) => {
      try {
        if (!details.isProxy) { callback({}); return; }
        const cfg = (await chrome.storage.local.get(PROXY_KEY))[PROXY_KEY];
        if (!cfg || !cfg.authMap) { callback({}); return; }
        const ch = details.challenger || {};
        const key = (ch.host || '') + ':' + (ch.port || '');
        const cred = cfg.authMap[key];
        if (cred) callback({ authCredentials: cred });
        else callback({});
      } catch { callback({}); }
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking']
  );
}
