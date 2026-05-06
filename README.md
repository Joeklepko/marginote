<div align="center">

# 📝 Marginote

**本地优先 · Markdown 笔记 · 待办提醒 · AI 优化 · Chrome 扩展**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](./manifest.json)
[![Chrome](https://img.shields.io/badge/Chrome-supported-success.svg)](https://www.google.com/chrome/)
[![Edge](https://img.shields.io/badge/Edge-supported-success.svg)](https://www.microsoft.com/edge)

*Marginote — 取自 marginal note（页边批注），让灵感落在浏览器侧边，不必离开当前标签页*

[功能](#-核心功能) · [安装](#-安装) · [截图](#-截图) · [AI 配置](#-ai-提供商) · [隐私](#-隐私与数据) · [常见问题](#-faq)

</div>

---

## ✨ 核心功能

| 模块 | 能力 |
|------|------|
| 📓 **笔记** | 三级结构（笔记本 → 文件夹 → 笔记），完整 Markdown，自动保存（400ms 防抖），标签 / 收藏 / 回收站 |
| ✅ **待办** | 优先级、截止时间、**系统级提醒**（提前 N 分 × 重复 K 次 × 间隔 M 分） |
| 🎨 **主题** | 10+ 内置主题（浅色 / 深色 / 护眼 / 莫兰迪 / 高对比），可自定义 |
| 🤖 **AI 优化** | 一键润色 / 翻译 / 摘要 / 续写，多 Provider（DeepSeek / Kimi / OpenAI / Ollama / 自建反代） |
| 🖼️ **图片** | 拖拽 / 粘贴直接入笔，base64 内嵌或 `_assets/` 目录 |
| 💾 **备份** | 一键导出 zip（笔记 + 图片 + 待办 + 配置），定期自动备份到下载目录 |
| 🔍 **搜索** | 全文 + 标题 + 标签 + 笔记本范围过滤 |
| ⌨️ **快捷键** | `Ctrl+N` 新建、`Ctrl+B/I` 加粗斜体、`Ctrl+S` 立即保存、`Ctrl+K` 搜索 |
| 🌐 **离线** | 100% 本地存储（`chrome.storage.local`），无服务端依赖 |

---

## 📥 安装

### 方式一：从源码加载（推荐开发者）

```bash
git clone https://github.com/Joeklepko/marginote.git
```

1. 浏览器打开 `chrome://extensions/`（Edge 用 `edge://extensions/`）
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序** → 选择 `marginote/` 目录
4. 点工具栏 Marginote 图标即可使用

### 方式二：Chrome Web Store

> 🚧 商店上架中

---

## 🖼️ 截图

> _截图位 — 安装后首次打开自动生成示例笔记_

```
┌─────────┬──────────────┬────────────────────────────┐
│ 📁 全部  │ 我的笔记本    │ # 欢迎使用 Marginote        │
│ ⭐ 收藏  │ ─ 工作        │                             │
│ 🗑 回收  │ ─ 学习        │ 这是一款 **本地优先** 的    │
│         │ ─ 灵感        │ Markdown 笔记扩展...        │
│ ✅ 待办  │              │                             │
│ 📓 笔记本│ + 新建笔记    │ - [x] 完成 README           │
│ 🎨 主题  │              │ - [ ] 写测试用例            │
└─────────┴──────────────┴────────────────────────────┘
   Rail        Sidebar              Editor
```

---

## 🤖 AI 提供商

支持 OpenAI 兼容协议，**API Key 仅存本地**。

| Provider | Endpoint 示例 | 备注 |
|----------|---------------|------|
| DeepSeek | `https://api.deepseek.com/v1` | 国内访问稳定，便宜 |
| Kimi（Moonshot） | `https://api.moonshot.cn/v1` | 长上下文友好 |
| OpenAI | `https://api.openai.com/v1` | 官方原版 |
| Ollama | `http://localhost:11434/v1` | 本地模型，零云端 |
| 自建反代 | 任意 OpenAI 兼容地址 | 跨域已加 `<all_urls>` 权限 |

设置入口：左栏 ⚙️ → AI 配置 → 选 Provider + 填 Key + 选模型。

---

## 🔒 隐私与数据

- **零联网**：除主动调用 AI Provider 外，**不发送任何数据**
- **本地存储**：所有内容存于 `chrome.storage.local`，路径见 [文件位置](#存储路径)
- **无遥测**：无统计、无上报、无远程加载脚本
- **CSP 严格**：`script-src 'self'`，禁止内联 / 远程脚本执行

### 存储路径

| OS | 路径 |
|----|------|
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Local Extension Settings\<id>\` |
| macOS | `~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/<id>/` |
| Linux | `~/.config/google-chrome/Default/Local Extension Settings/<id>/` |

> 卸载扩展会清空所有数据。卸载前务必导出 zip。

---

## 🔑 权限说明

| 权限 | 用途 |
|------|------|
| `storage` / `unlimitedStorage` | 突破 5MB 限制，图片 base64 友好 |
| `alarms` | 调度待办提醒 |
| `notifications` | 系统级弹窗 |
| `tabs` | 定位/聚焦已打开的 Marginote 标签 |
| `proxy` / `webRequest` | AI 反代场景所需 |
| `<all_urls>` | 跨域请求 AI Provider（可按需收窄） |

---

## ⌨️ 快捷键

| 操作 | Win / Linux | macOS |
|------|-------------|-------|
| 新建笔记 | `Ctrl + N` | `Cmd + N` |
| 立即保存 | `Ctrl + S` | `Cmd + S` |
| 搜索 | `Ctrl + K` | `Cmd + K` |
| 加粗 | `Ctrl + B` | `Cmd + B` |
| 斜体 | `Ctrl + I` | `Cmd + I` |

---

## 🛠️ 文件结构

```
marginote/
├── manifest.json        # MV3 配置
├── background.js        # service worker (alarms + notifications)
├── index.html           # 主界面
├── app.js               # 主逻辑（约 160KB）
├── manual.md            # 完整功能说明书
├── vendor/jszip.min.js  # zip 编解码
└── icons/icon{16,48,128}.png
```

---

## 📋 FAQ

<details>
<summary><b>新标签页会被占用吗？</b></summary>

不会。v1.0 默认 **不覆盖** 新标签页。点工具栏图标手动打开。如需覆盖，可在 `manifest.json` 添加：

```json
"chrome_url_overrides": { "newtab": "index.html" }
```
</details>

<details>
<summary><b>API Key 安全吗？</b></summary>

API Key 存浏览器本地。**任何能访问该浏览器的人都能读取**（含其他扩展、远程桌面、备份文件）。建议：

- 用最低权限子 Key
- 不绑定高额账户
- 公司机器慎用
</details>

<details>
<summary><b>多设备同步？</b></summary>

不支持自动同步。手动方案：左下角「数据 · 备份」→ 导出 zip → 另一台浏览器导入。
</details>

<details>
<summary><b>升级会丢数据吗？</b></summary>

替换文件后扩展页点 ↻ 重新加载，数据保留。**卸载** 才会清空。
</details>

---

## 🤝 贡献

欢迎 Issue 与 PR。建议先开 Issue 讨论方案再写代码。

```bash
# Fork → clone → 改代码 → 在 chrome://extensions 加载未打包扩展测试
```

---

## 📜 License

[MIT](./LICENSE) © Joeklepko

---

<div align="center">

**喜欢这个项目？给个 ⭐ Star 鼓励一下**

</div>
