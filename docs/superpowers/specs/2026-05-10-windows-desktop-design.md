# Marginote · Windows 桌面版设计文档

- **作者**：Claude (Haiku 4.5) + 用户合议
- **日期**：2026-05-10
- **目标分支**：`dev_exe`
- **目标版本**：v1.1.0-desktop（与扩展版 v1.1.0 功能等价）

---

## 1. 背景与目标

### 1.1 现状

Marginote 当前是 Chrome MV3 扩展形态的本地优先笔记本：

- 单页 Web 应用（`index.html` 124KB + `app.js` 172KB），原生 HTML/CSS/JS，无构建系统
- Vendor 依赖已本地化：`jszip + markdown-it + DOMPurify`（共 244KB）
- 功能：Markdown 笔记、图片管理、待办提醒、AI 助手（DeepSeek/Kimi/OpenAI 等）、多主题、字体定制
- 数据：100% 本地（`chrome.storage.local`），已自带 zip 备份导出（`exportAll`）+ 导入（`importFiles`）
- Chrome 平台 API 用得很薄：`storage` / `alarms` / `notifications` / `tabs` / `windows` / `runtime` / `proxy` / `webRequest`，业务代码中共 17 处 `chrome.*` 调用

### 1.2 目标

在 `dev_exe` 分支上把 Marginote 打包成 Windows `.exe` 安装版，**保留全部功能**，并提供桌面应用应有的体验（托盘、全局快捷键、开机自启、单实例）。要求：

- 用户在 Windows 下双击 `.exe` 即可安装运行，无需安装 Chrome
- 老用户可通过现有 zip 备份从扩展无缝迁移数据
- 与扩展版共享业务代码——业务功能改一份，两端同步生效
- 通过 GitHub Actions 自动构建和发布

### 1.3 非目标（YAGNI）

- ❌ 自动更新（需要代码签名 + 服务器，先手工下载新版）
- ❌ 代码签名（EV 证书 $200+/年，初期承担 SmartScreen 警告）
- ❌ macOS / Linux 桌面版（只做 Windows）
- ❌ MSI 安装包（NSIS 一种就够）
- ❌ 业务功能扩展（本次仅做平台移植，新功能走单独迭代）

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│              Marginote 应用核心 (shared/)                     │
│  index.html · app.js · vendor/ · icons/                      │
│  js/  ┬──── platform.js (接口契约)                            │
│       ├──── platform-extension.js (chrome.* 实现)             │
│       ├──── platform-desktop.js   (Tauri 实现)                │
│       └──── bridge-loader.js (运行时择一)                     │
└─────────────┬────────────────────────────┬───────────────────┘
              │                             │
   ┌──────────┴──────────┐      ┌───────────┴──────────────┐
   │  扩展薄壳            │      │  Tauri 桌面壳             │
   │  extension/         │      │  desktop/                │
   │ • manifest.json     │      │ • src-tauri/ (Rust)      │
   │ • background.js     │      │ • tauri.conf.json        │
   │ • build.sh (拷 share)│      │   frontendDist→../shared │
   └─────────────────────┘      └──────────────────────────┘
```

**核心设计决策**：引入 `mn.platform` 抽象层，业务代码只调 `mn.platform.*`。两个 bridge 实现都住在 `shared/js/` 里（每个 5–10KB，对方平台是死代码不影响），运行时由 `bridge-loader.js` 根据 `window.__TAURI__` 二选一。这让两端共享 90%+ 代码，未来主干修复也能直接同步到桌面版。

---

## 3. 仓库目录结构

`dev_exe` 分支上的最终布局：

```
marginote/
├── shared/                          ← 单一真相源（被两个壳共用）
│   ├── index.html
│   ├── app.js
│   ├── js/
│   │   ├── platform.js              ← 新增：mn.platform 接口契约
│   │   ├── platform-extension.js    ← 新增：chrome.* 实现（运行在扩展时生效）
│   │   ├── platform-desktop.js      ← 新增：Tauri 实现（运行在桌面时生效）
│   │   ├── bridge-loader.js         ← 新增：运行时检测 window.__TAURI__
│   │   ├── appearance.js
│   │   └── assistant.js
│   ├── vendor/                       ← jszip / markdown-it / DOMPurify
│   ├── icons/
│   └── images/
│
├── extension/                       ← Chrome 扩展壳
│   ├── manifest.json                ← 引用本目录内 shared/* 文件（构建后注入）
│   ├── background.js                ← 原 service worker
│   ├── build.sh                     ← 构建脚本：把 ../shared/* 拷进当前目录
│   └── (打包后会有 index.html / app.js / js/ / vendor/ / icons/ ── .gitignored)
│
├── desktop/                         ← Tauri 桌面壳
│   ├── src-tauri/
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json          ← frontendDist 指向 ../../shared
│   │   ├── build.rs
│   │   ├── src/
│   │   │   ├── main.rs              ← 应用入口、插件注册
│   │   │   ├── commands.rs          ← Tauri 命令（fetch / 闹钟）
│   │   │   ├── tray.rs              ← 系统托盘
│   │   │   └── scheduler.rs         ← 闹钟调度
│   │   └── icons/                   ← Tauri 多尺寸 icon（含 .ico）
│   └── package.json                 ← 仅供 tauri CLI 用
│
├── .github/workflows/
│   └── build-windows.yml            ← Windows .exe 自动构建
│
├── docs/superpowers/specs/
│   └── 2026-05-10-windows-desktop-design.md
│
├── README.md  CHANGELOG.md  manual.md  LICENSE
├── CLAUDE.md  .wolf/  .claude/
└── package.json                     ← 根 workspace（可选）
```

**关键点**：

- **`shared/` 是单一真相源**，业务代码不再触碰 `chrome.*`；两个 bridge 文件（`platform-extension.js` / `platform-desktop.js`）也住在 `shared/js/` 里——它们都很小（每个 5–10KB），两端都打包，运行时由 `bridge-loader.js` 根据 `window.__TAURI__` 是否存在二选一加载
- **扩展打包需要拷贝步骤**：Chrome MV3 manifest 不能用 `../` 跳出扩展目录。`extension/build.sh` 在打包前把 `shared/*` 拷进 `extension/`，让 `extension/` 成为自包含的扩展根。被拷进来的文件加入 `.gitignore`，避免污染版本控制
- **桌面端无构建步骤**：`desktop/src-tauri/tauri.conf.json` 的 `frontendDist` 直接指向 `../../shared`，Tauri 把整个 `shared/` 嵌入 `.exe`
- 旧根目录文件（`index.html / app.js / js/ / vendor/ / icons/ / manifest.json / background.js`）通过 `git mv` 物理移动到新位置；项目级文档（`README.md / CHANGELOG.md / manual.md / LICENSE`）保留在根

---

## 4. API 抽象层（mn.platform）

### 4.1 接口契约

`shared/js/platform.js` 定义运行时无依赖的接口骨架：

```js
window.mn = window.mn || {};
mn.platform = {
  kind: 'extension' | 'desktop',

  storage: {
    get(key)         : Promise<any | null>,
    set(key, value)  : Promise<void>,
    remove(key)      : Promise<void>,
    keys()           : Promise<string[]>,
  },

  alarms: {
    create(name, whenMs)             : Promise<void>,
    clear(name)                      : Promise<void>,
    getAll()                         : Promise<{name, scheduledTime}[]>,
    onFire(callback: (name) => void) : void,
  },

  notify(title, body, opts?: { iconUrl, requireInteraction, onClick })
       : Promise<void>,

  fetch(url, init?, proxyConfig?)
       : Promise<{ ok, status, body }>,

  window: {
    focus()    : Promise<void>,
    minimize() : Promise<void>,
    hide()     : Promise<void>,
  },

  desktop: {
    isAvailable           : boolean,
    getAutostart()        : Promise<boolean>,
    setAutostart(on)      : Promise<void>,
    registerHotkey(combo) : Promise<void>,
    unregisterHotkey()    : Promise<void>,
  },
};
```

### 4.2 两端实现对照

两个 bridge 都住在 `shared/js/` 中，对方平台的 API（`chrome` 或 `window.__TAURI__`）在自己平台不存在时就是死代码。`bridge-loader.js` 在 `index.html` 里跑：

```js
// shared/js/bridge-loader.js
(function () {
  const isTauri = typeof window.__TAURI__ !== 'undefined';
  const src = isTauri ? 'js/platform-desktop.js' : 'js/platform-extension.js';
  const s = document.createElement('script');
  s.src = src; s.async = false;
  document.head.appendChild(s);
})();
```

| 接口 | 扩展端 (`platform-extension.js`) | 桌面端 (`platform-desktop.js`) |
|---|---|---|
| `storage.*` | `chrome.storage.local` | `tauri-plugin-store`（单 JSON 文件 `marginote.dat`） |
| `alarms.*` | `chrome.alarms` + `onAlarm` | Tauri 命令 `cmd_alarm_set` → Rust 端 `tokio::time` 任务 + `app.emit("alarm-fired", name)` |
| `notify` | `chrome.notifications` | `tauri-plugin-notification` |
| `fetch`（普通） | `chrome.runtime.sendMessage('simpleFetch')` | Tauri 命令 `cmd_fetch`（Rust `reqwest`） |
| `fetch`（代理） | `chrome.runtime.sendMessage('proxyFetch')` | `cmd_fetch` 带 `proxy` 参数（reqwest 原生支持每请求代理 + 鉴权） |
| `window.focus / hide` | 通过 `chrome.runtime.sendMessage` 触发 background 处理 | Tauri Window API |
| `desktop.*` | 全部 stub（`isAvailable=false`，调用 no-op） | `tauri-plugin-autostart` + `tauri-plugin-global-shortcut` |

### 4.3 业务代码改动量

- `app.js` 中 17 处 `chrome.*` 调用全部替换为 `mn.platform.*`
- `background.js`（扩展端）继续保留——它不进 `app.js`，只接收 `runtime.sendMessage` 处理 `simpleFetch / proxyFetch / focusOrOpenApp / 闹钟`
- 桌面端 `platform-desktop.js` 调用 Tauri `invoke()`，Rust 端在 `commands.rs` 处理
- 业务逻辑（笔记 CRUD / 待办 / AI 助手 / 主题 / 字体）**完全不动**

### 4.4 加载顺序

`shared/index.html` 头部脚本顺序（业务代码访问 `mn.platform.*` 前必须 bridge 已就绪）：

```html
<!-- 1. vendor -->
<script src="vendor/markdown-it.min.js"></script>
<script src="vendor/purify.min.js"></script>
<script src="vendor/jszip.min.js"></script>

<!-- 2. 平台接口契约（同步） -->
<script src="js/platform.js"></script>

<!-- 3. bridge-loader 同步注入对应实现 -->
<script src="js/bridge-loader.js"></script>

<!-- 4. 业务模块 -->
<script src="js/appearance.js"></script>
<script src="js/assistant.js"></script>
<script src="app.js"></script>
```

注意 `bridge-loader.js` 同步执行 `document.createElement('script')` 并 `appendChild`，即使设置 `async = false`，注入的脚本仍然是异步加载。因此 `app.js` 需要先做一次 **`mn.platform.ready()` 等待**——具体实现：bridge-loader 把一个 Promise 挂到 `window.mn.ready` 上，业务入口在 `await mn.ready` 之后再读 storage。这是 P1 阶段重构时必须处理的一处真实改造。

---

## 5. Tauri 工程详细配置

### 5.1 版本与依赖

- **Tauri**：2.x（最新稳定）
- **Rust**：stable（GitHub Actions 用 `dtolnay/rust-toolchain@stable`）
- **核心 crate**：`tauri`, `serde`, `serde_json`, `tokio`, `reqwest`（带 `rustls-tls` 特性，避免 OpenSSL 依赖）
- **Tauri 插件**：
  - `tauri-plugin-store`：JSON 持久化
  - `tauri-plugin-notification`：系统通知
  - `tauri-plugin-global-shortcut`：全局快捷键
  - `tauri-plugin-autostart`：开机自启
  - `tauri-plugin-single-instance`：单实例

### 5.2 `tauri.conf.json` 关键字段

```json
{
  "productName": "Marginote",
  "version": "1.1.0",
  "identifier": "com.marginote.app",
  "build": {
    "frontendDist": "../../shared",
    "devUrl": null,
    "beforeBuildCommand": null
  },
  "app": {
    "windows": [{
      "label": "main",
      "title": "Marginote · 笔记本",
      "width": 1280, "height": 820,
      "minWidth": 900, "minHeight": 600,
      "decorations": true, "center": true, "visible": true
    }],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: asset:; connect-src 'self' ipc: https: http:"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "windows": {
      "nsis": {
        "installerIcon": "icons/icon.ico",
        "installMode": "currentUser",
        "languages": ["SimplifiedChinese", "English"]
      }
    },
    "icon": ["icons/icon.ico", "icons/32x32.png", "icons/128x128.png", "icons/icon.png"]
  },
  "plugins": {
    "shell": { "open": true }
  }
}
```

### 5.3 `main.rs` 骨架

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            cmd_fetch,
            cmd_alarm_set,
            cmd_alarm_clear,
            cmd_alarm_list,
        ])
        .setup(|app| {
            tray::install(app)?;
            scheduler::restore(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Marginote failed to start");
}
```

### 5.4 桌面专属能力实现策略

| 能力 | 实现方式 | 涉及文件 |
|---|---|---|
| **系统托盘** | `TrayIconBuilder` 创建托盘图标；菜单：「显示主界面」「退出」；左键单击 = 显示窗口 | `src/tray.rs` |
| **关闭最小化到托盘** | 监听 `WindowEvent::CloseRequested` → `api.prevent_close()` + `window.hide()` | `src/main.rs` |
| **单实例** | `tauri-plugin-single-instance` 启动时检测，第二次运行触发回调唤起已有窗口 | `main.rs` 插件注册 |
| **全局快捷键** | `plugin-global-shortcut`，默认 `Ctrl+Shift+M`；用户在 「设置」面板可改 | `platform-desktop.js` 调 `register()` |
| **开机自启** | `plugin-autostart`，前端 `setAutostart(true)` 触发 | 「设置」面板新增开关 |
| **闹钟调度** | `cmd_alarm_set(name, when_ms)` → 后端 `tokio::spawn(async move { sleep_until(when).await; emit("alarm-fired", name) })`；启动时 `scheduler::restore` 从 store 读取未过期闹钟重新调度 | `src/scheduler.rs` |
| **AI 代理 fetch** | `cmd_fetch(url, method, headers, body, proxy?)` → `reqwest::Client::builder()` 按需 `.proxy(reqwest::Proxy::all(url).basic_auth(user, pass))`，30s 超时；每请求独立 Client | `src/commands.rs` |

### 5.5 图标准备

Tauri 需要 `desktop/src-tauri/icons/` 下：

- `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.ico`

**做法**：从已有 `shared/icons/icon128.png` 用 `tauri icon` CLI 一键生成；CI 工作流里在缺失时自动生成兜底。

---

## 6. GitHub Actions 构建发布

### 6.1 工作流文件

`.github/workflows/build-windows.yml`：

```yaml
name: Build Windows .exe

on:
  push:
    branches: [dev_exe]
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Cache Rust deps
        uses: swatinem/rust-cache@v2
        with: { workspaces: 'desktop/src-tauri -> target' }

      - name: Install Tauri CLI
        run: npm install -g @tauri-apps/cli@latest

      - name: Generate icons (if missing)
        run: |
          if (!(Test-Path desktop/src-tauri/icons/icon.ico)) {
            tauri icon shared/icons/icon128.png -o desktop/src-tauri/icons
          }
        shell: pwsh

      - name: Build
        working-directory: desktop
        run: tauri build

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: marginote-windows-exe
          path: desktop/src-tauri/target/release/bundle/nsis/*.exe
          retention-days: 30

      - name: Publish Release
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: desktop/src-tauri/target/release/bundle/nsis/*.exe
          draft: false
          generate_release_notes: true
```

### 6.2 发布流程

| 场景 | 操作 |
|---|---|
| 推送 `dev_exe` 分支 | 自动构建，约 6–10 分钟（首次）/ 3–5 分钟（增量），从 Actions Artifacts 下载 |
| 正式发版 | 打 `v*` tag 推送 → 自动发布到 GitHub Releases |

### 6.3 已知约束

- 不做代码签名 → Windows SmartScreen 首次运行警告"未知发布者"，用户需手动点"仍要运行"
- Artifact 保留 30 天，避免存储爆量
- 仅 Windows，不构建其他平台

---

## 7. 实施阶段拆分

| 阶段 | 内容 | 验证标准 |
|---|---|---|
| **P0 仓库准备** | `git mv` 把代码搬入 `shared/` 与 `extension/`；写 `extension/build.sh`（拷贝 `shared/*` 到 `extension/`）；`.gitignore` 忽略拷入的副本；用 `build.sh` 构建后 Chrome 加载 `extension/` 目录 | Chrome 加载未打包扩展，所有功能（笔记/待办/AI/主题）完全等价 |
| **P1 抽象层落地** | 新建 `shared/js/platform.js` + `platform-extension.js` + `bridge-loader.js`；改 `index.html` 加载顺序；替换 `app.js` 中 17 处 `chrome.*`；引入 `mn.ready` 等待机制 | 扩展功能完全等价于 P0，纯重构 |
| **P2 Tauri 脚手架** | `desktop/src-tauri/` 初始化；`main.rs` 最小骨架开窗口加载 `shared/index.html`；CI 出第一个 .exe | .exe 能装、能开窗口看到 UI（功能不通是预期） |
| **P3 桌面 platform 实现** | 写 `shared/js/platform-desktop.js`；顺序实现 storage → fetch → notify+alarms → window；Rust 端写 `commands.rs` + `scheduler.rs` | .exe 中所有原扩展功能跑通（除桌面专属能力） |
| **P4 桌面专属能力** | 托盘 + 关闭最小化、单实例、全局快捷键、开机自启、设置面板 UI | 托盘行为正确、Ctrl+Shift+M 唤起、自启重启生效、扩展 zip 导入数据完整 |
| **P5 CI + Release** | 完善 workflow、文档、CHANGELOG；打 tag 发 Release | 干净 Windows 机器从 Releases 下载安装首启正常 |

每阶段独立可验证，避免一口气改完无法定位问题。

---

## 8. 数据迁移方案

老用户从扩展迁移到桌面版的路径：

1. **扩展端**：用户在「设置」点「导出备份」 → 下载 `marginote-backup-YYYY-MM-DD.zip`
2. **桌面端**：用户在「设置」点「导入备份」 → 选刚才下载的 zip → 完整恢复笔记 + 图片 + 历史版本

**实现**：完全复用 `app.js` 已有的 `exportAll()` + `importFiles()`——格式不变、代码不动。桌面端只需在「设置」面板新增引导文案：

> 从 Chrome 扩展迁移：先在扩展里点"导出备份"下载 zip，然后在这里点"导入备份"选中该 zip。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Tauri 2.x 插件 API 变动 | 编译错误 | 锁定具体版本号（`Cargo.toml` 用 `=2.x.y`） |
| WebView2 在某些 Win10 版本未预装 | 用户启动失败 | NSIS 安装时检测并提示；Win10 1803+ 一般已预装 |
| Rust 编译时间长拖慢 CI | 用户等待 | `swatinem/rust-cache` 缓存 target，增量 3–5 分钟 |
| 17 处 `chrome.*` 替换遗漏 | 桌面端某功能突然崩 | P1 完成后用 `grep -rnE "chrome\."` 全仓扫描，命中应只剩 `extension/background.js` 和 `shared/js/platform-extension.js` |
| 闹钟跨进程持久化 | 关机后未触发的闹钟丢失 | 启动时 `scheduler::restore` 从 store 读取未过期闹钟重新调度 |
| CSP 太严导致内联样式失败 | 主题/字体功能挂 | 保留 `'unsafe-inline'` for style-src；script-src 严守 `'self'` |
| SmartScreen 警告吓退用户 | 安装率低 | README 加图文说明"点击'更多信息' → '仍要运行'"；后续考虑代码签名 |

---

## 10. 验收标准

- [ ] `dev_exe` 分支推送后，GitHub Actions 自动构建出 `Marginote_1.1.0_x64-setup.exe`
- [ ] 干净 Windows 10/11 机器双击 `.exe`，按提示完成安装（无管理员权限）
- [ ] 启动后所有原扩展功能可用：笔记 CRUD / 图片插入 / 待办新增与提醒 / AI 助手对话 / 主题切换 / 字体设置 / 历史版本
- [ ] 关闭主窗口最小化到托盘；托盘双击恢复；右键菜单可真正退出
- [ ] `Ctrl+Shift+M`（默认）从任何窗口唤起 Marginote
- [ ] 「设置」面板可勾选开机自启并实际生效
- [ ] 从扩展导出的 `marginote-backup-*.zip` 在桌面版可完整导入
- [ ] 同时启动两次 → 第二次自动唤起第一个实例，不重复开窗
- [ ] 待办到期可弹系统通知；点击通知唤起主窗口
- [ ] 扩展版（master 分支）功能完全不受影响

---

## 11. 后续可能的工作（不在本次范围）

- 代码签名 + 自动更新（需要 EV 证书）
- macOS / Linux 桌面版（Tauri 跨平台支持，但用户暂不需要）
- 将 `app.js` 模块化（目前 172KB 单文件，长期可拆为 ES Modules）
- 桌面端独享功能：本地全文索引、文件系统级笔记导出（每篇 .md 单独存盘）
