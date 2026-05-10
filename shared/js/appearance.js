// =====================================================================
// 主题 / 字体 / 设置标签页
// 依赖（来自 app.js 的全局）：
//   - escapeHtml
//   - 设置面板：renderAiPresetSelect, renderAiProviderList, closeAiProviderForm,
//             refreshStorageTab, renderLocalSyncInfo
// =====================================================================
const THEME_KEY = 'marginote.theme';
const CUSTOM_KEY = 'marginote.themeCustom';
const FONT_KEY = 'marginote.font';
const FONT_SIZE_KEY = 'marginote.fontSize';

const THEMES = {
  light: { name: '默认 · 米黄', mode: 'light', vars: {} },
  dark:  { name: '默认 · 暗夜', mode: 'dark',  vars: {} },
  sepia: { name: '羊皮纸', mode: 'light', vars: {
    '--bg': '#f5e9d4', '--bg-warm': '#ecdab9', '--paper': '#faf0d9',
    '--ink': '#3a2c1a', '--ink-soft': '#5a4a30', '--ink-mute': '#8b7651',
    '--rule': '#d3bc8d', '--rule-soft': '#e2d4af',
    '--accent': '#a85a1f', '--accent-soft': '#c06d2c'
  }},
  solarizedLight: { name: '日和 · Solarized', mode: 'light', vars: {
    '--bg': '#fdf6e3', '--bg-warm': '#eee8d5', '--paper': '#fff9e8',
    '--ink': '#073642', '--ink-soft': '#586e75', '--ink-mute': '#93a1a1',
    '--rule': '#d8d2bd', '--rule-soft': '#ece6d4',
    '--accent': '#cb4b16', '--accent-soft': '#dc6332'
  }},
  solarizedDark: { name: '夜和 · Solarized', mode: 'dark', vars: {
    '--bg': '#002b36', '--bg-warm': '#073642', '--paper': '#0d3a47',
    '--ink': '#fdf6e3', '--ink-soft': '#eee8d5', '--ink-mute': '#93a1a1',
    '--rule': '#114a59', '--rule-soft': '#0c3d4a',
    '--accent': '#cb4b16', '--accent-soft': '#dc6332'
  }},
  nord: { name: '北境 · Nord', mode: 'dark', vars: {
    '--bg': '#2e3440', '--bg-warm': '#3b4252', '--paper': '#434c5e',
    '--ink': '#eceff4', '--ink-soft': '#d8dee9', '--ink-mute': '#8898ad',
    '--rule': '#4c566a', '--rule-soft': '#3f4757',
    '--accent': '#88c0d0', '--accent-soft': '#8fbcbb'
  }},
  dracula: { name: '德古拉', mode: 'dark', vars: {
    '--bg': '#282a36', '--bg-warm': '#343746', '--paper': '#3c3f51',
    '--ink': '#f8f8f2', '--ink-soft': '#e6e6dc', '--ink-mute': '#7a7d8a',
    '--rule': '#44475a', '--rule-soft': '#3a3d4d',
    '--accent': '#ff79c6', '--accent-soft': '#ff92d0'
  }},
  gruvbox: { name: '丘陵 · Gruvbox', mode: 'light', vars: {
    '--bg': '#fbf1c7', '--bg-warm': '#f2e5bc', '--paper': '#fdf4cc',
    '--ink': '#3c3836', '--ink-soft': '#504945', '--ink-mute': '#7c6f64',
    '--rule': '#d5c4a1', '--rule-soft': '#e3d7b3',
    '--accent': '#af3a03', '--accent-soft': '#cc5511'
  }},
  forest: { name: '林间', mode: 'dark', vars: {
    '--bg': '#1e2820', '--bg-warm': '#293730', '--paper': '#2f4035',
    '--ink': '#e8eddf', '--ink-soft': '#d3dac4', '--ink-mute': '#8a9786',
    '--rule': '#3a4d40', '--rule-soft': '#34453b',
    '--accent': '#a3be8c', '--accent-soft': '#b4cb9e'
  }},
  mono: { name: '黑白', mode: 'light', vars: {
    '--bg': '#fafafa', '--bg-warm': '#f0f0f0', '--paper': '#ffffff',
    '--ink': '#1a1a1a', '--ink-soft': '#404040', '--ink-mute': '#888888',
    '--rule': '#dadada', '--rule-soft': '#ebebeb',
    '--accent': '#1a1a1a', '--accent-soft': '#3a3a3a'
  }},
  rose: { name: '玫瑰', mode: 'light', vars: {
    '--bg': '#fdf2f4', '--bg-warm': '#f7e3e7', '--paper': '#ffffff',
    '--ink': '#3a1f24', '--ink-soft': '#5e3942', '--ink-mute': '#a07a82',
    '--rule': '#e9c8cf', '--rule-soft': '#f1d7dd',
    '--accent': '#c2185b', '--accent-soft': '#d9356f'
  }},
  ocean: { name: '深海', mode: 'dark', vars: {
    '--bg': '#0f1c2e', '--bg-warm': '#162638', '--paper': '#1c2e44',
    '--ink': '#e8f0f8', '--ink-soft': '#cad7e6', '--ink-mute': '#7d8da3',
    '--rule': '#2a3e57', '--rule-soft': '#22344a',
    '--accent': '#5ec5d7', '--accent-soft': '#76d2e0'
  }}
};

const THEME_VAR_NAMES = ['--bg','--bg-warm','--paper','--ink','--ink-soft','--ink-mute','--rule','--rule-soft','--accent','--accent-soft','--highlight'];
const REGION_VAR_MAP = {
  rail:    { sel: '.rail',    bg: '--bg-warm', ink: '--ink-soft' },
  sidebar: { sel: '.sidebar', bg: '--bg',      ink: '--ink' },
  editor:  { sel: '.editor',  bg: '--paper',   ink: '--ink-soft' }
};
let currentThemePreset = 'mono';

function applyTheme(name) {
  const preset = THEMES[name] || THEMES.light;
  document.body.setAttribute('data-theme', preset.mode);
  THEME_VAR_NAMES.forEach(v => document.body.style.removeProperty(v));
  Object.entries(preset.vars).forEach(([k, v]) => document.body.style.setProperty(k, v));
  currentThemePreset = name;
  localStorage.setItem(THEME_KEY, name);
  let custom = null;
  try { custom = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null'); } catch {}
  applyCustomOverrides(custom);
  const label = document.getElementById('themeLabel');
  if (label) label.textContent = preset.name;
}

function applyCustomOverrides(c) {
  Object.entries(REGION_VAR_MAP).forEach(([region, { sel, bg, ink }]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.removeProperty(bg);
    el.style.removeProperty(ink);
    if (c) {
      const bgVal = c[region + 'Bg'];
      const inkVal = c[region + 'Ink'];
      if (bgVal) el.style.setProperty(bg, bgVal);
      if (inkVal) el.style.setProperty(ink, inkVal);
    }
  });
}

function getCustomTheme() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null') || {}; } catch { return {}; }
}

function saveCustomTheme(c) {
  if (!c || !Object.keys(c).length) localStorage.removeItem(CUSTOM_KEY);
  else localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
  applyCustomOverrides(Object.keys(c || {}).length ? c : null);
}

function rgbToHex(input) {
  if (!input) return null;
  input = input.trim();
  if (input.startsWith('#')) {
    if (input.length === 4) return '#' + input.slice(1).split('').map(c => c + c).join('');
    return input.slice(0, 7);
  }
  const m = input.match(/rgba?\((\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}

function resolveDefaultColor(key) {
  const region = key.replace(/Bg$|Ink$/, '').toLowerCase();
  const map = REGION_VAR_MAP[region];
  if (!map) return '#000000';
  const el = document.querySelector(map.sel);
  if (!el) return '#000000';
  const cs = getComputedStyle(el);
  const prop = key.endsWith('Bg') ? map.bg : map.ink;
  return rgbToHex(cs.getPropertyValue(prop)) || '#000000';
}

function defaultSwatches(mode) {
  return mode === 'dark'
    ? ['#1a1814', '#221f1a', '#2a2620', '#f4efe6', '#e07a3d']
    : ['#f4efe6', '#ede5d6', '#faf6ed', '#1a1814', '#b8431f'];
}

function renderThemeGrid() {
  const grid = document.getElementById('themeGrid');
  if (!grid) return;
  grid.innerHTML = Object.entries(THEMES).map(([key, t]) => {
    const fallback = defaultSwatches(t.mode);
    const swatches = (Object.keys(t.vars).length === 0)
      ? fallback
      : ['--bg', '--bg-warm', '--paper', '--ink', '--accent'].map((v, i) => t.vars[v] || fallback[i]);
    return `
      <div class="theme-card ${key === currentThemePreset ? 'active' : ''}" data-theme="${key}">
        <div class="theme-card-name">${escapeHtml(t.name)}</div>
        <div class="theme-card-swatches">
          ${swatches.map(c => `<div class="theme-card-swatch" style="background:${c}"></div>`).join('')}
        </div>
      </div>`;
  }).join('');
  // 兜底：JS 强制背景色
  grid.querySelectorAll('.theme-card-swatch').forEach(el => {
    const c = el.style.background;
    if (c && c !== '') el.style.setProperty('background-color', c, 'important');
  });
  grid.querySelectorAll('.theme-card').forEach(el => {
    el.addEventListener('click', () => {
      applyTheme(el.dataset.theme);
      renderThemeGrid();
      syncCustomInputs();
    });
  });
}

function syncCustomInputs() {
  const c = getCustomTheme();
  ['railBg', 'railInk', 'sidebarBg', 'sidebarInk', 'editorBg', 'editorInk'].forEach(k => {
    const id = 'custom' + k.charAt(0).toUpperCase() + k.slice(1);
    const el = document.getElementById(id);
    if (el) el.value = c[k] || resolveDefaultColor(k);
  });
}

// ===================== 字体 =====================
const FONT_PRESETS = {
  serif:  "'Fraunces', 'Noto Serif SC', 'Source Han Serif SC', Georgia, serif",
  sans:   "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans SC', sans-serif",
  hei:    "'PingFang SC', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans SC', 'Heiti SC', 'Hiragino Sans GB', sans-serif",
  kai:    "'STKaiti', 'KaiTi', 'KaiTi_GB2312', '楷体', 'BiauKai', serif",
  song:   "'Times New Roman', 'SimSun', '宋体', 'Noto Serif SC', serif",
  system: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
};
let _fontStyleEl = null;
function applyFont(name) {
  const stack = FONT_PRESETS[name] || FONT_PRESETS.serif;
  if (!_fontStyleEl) {
    _fontStyleEl = document.createElement('style');
    _fontStyleEl.id = 'marginote-font-overrides';
    document.head.appendChild(_fontStyleEl);
  }
  _fontStyleEl.textContent = `
    body, button, input, select, textarea,
    .note-title, .note-preview, .note-date,
    .todo-text, .todo-meta,
    .editor, .content-input, .preview,
    .new-note-btn, .filter-tab, .compact-toggle,
    .rail-item-label, .rail-folder-item, .rail-section-title,
    .masthead-title h1, .masthead-title, .meta-line,
    .modal h3, .modal p, .modal label, .modal-btn,
    h1, h2, h3, h4, h5, h6, .nb-name, .toast {
      font-family: ${stack} !important;
    }
  `;
  localStorage.setItem(FONT_KEY, name);
}
function applyFontSize(px) {
  const n = Math.max(13, Math.min(20, parseInt(px, 10) || 16));
  document.body.style.fontSize = n + 'px';
  localStorage.setItem(FONT_SIZE_KEY, String(n));
  const v = document.getElementById('fontSizeValue');
  if (v) v.textContent = n + 'px';
}
function loadFontSettings() {
  const name = localStorage.getItem(FONT_KEY) || 'serif';
  applyFont(name);
  const size = localStorage.getItem(FONT_SIZE_KEY) || '16';
  applyFontSize(size);
  const sel = document.getElementById('fontSelect');
  if (sel) sel.value = name;
  const range = document.getElementById('fontSizeRange');
  if (range) range.value = size;
}

// ===================== 设置标签页 =====================
function setSettingsTab(name) {
  document.querySelectorAll('#settingsTabs .settings-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.settings-pane').forEach(p => {
    p.classList.toggle('active', p.dataset.pane === name);
  });
  const body = document.querySelector('.settings-body');
  if (body) body.scrollTop = 0;
  if (name === 'appearance') {
    renderThemeGrid();
    syncCustomInputs();
  } else if (name === 'font') {
    loadFontSettings();
  } else if (name === 'ai') {
    if (typeof renderAiPresetSelect === 'function') renderAiPresetSelect();
    if (typeof renderAiProviderList === 'function') renderAiProviderList();
    if (typeof closeAiProviderForm === 'function') closeAiProviderForm();
  } else if (name === 'data') {
    if (typeof refreshStorageTab === 'function') refreshStorageTab();
    if (typeof renderLocalSyncInfo === 'function') renderLocalSyncInfo();
  }
}

function openSettingsModal(tab) {
  if (tab) setSettingsTab(tab);
  document.getElementById('settingsModalBg').classList.add('show');
}

function closeSettingsModal() {
  document.getElementById('settingsModalBg').classList.remove('show');
}

function openThemeModal() {
  renderThemeGrid();
  syncCustomInputs();
  openSettingsModal('appearance');
}

function closeThemeModal() { closeSettingsModal(); }
