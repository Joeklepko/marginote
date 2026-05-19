# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0-desktop] - 2026-05-10

### Added
- **Windows 桌面版**（Tauri 2 + WebView2，`.exe` 安装包约 12MB）
- 系统托盘图标：左键单击显示窗口、菜单可显示 / 退出
- 关闭最小化到托盘：× 不退出、托盘菜单"退出"才真正结束进程
- 全局快捷键：默认 `Ctrl+Shift+M` 唤起（可在「设置 → 桌面」自定义）
- 开机自启选项（仅桌面版）
- 单实例：第二次启动自动唤起首个窗口
- 数据迁移：从 Chrome 扩展导出 zip 在桌面版导入即可
- GitHub Actions 自动构建：推 `dev_exe` 分支即出 `.exe` artifact，打 tag 自动发 Release

### Changed
- 仓库结构重组为 monorepo：`shared/`（应用核心）+ `extension/`（Chrome 壳）+ `desktop/`（Tauri 壳）
- 引入 `mn.platform` 平台抽象层，业务代码不再直接调 `chrome.*`，扩展和桌面共享 90%+ 代码
- 数据存储：扩展端继续 `chrome.storage.local`；桌面端用 `marginote.dat`（在 `%APPDATA%\com.marginote.app\`）
- AI 代理 fetch 桌面端走 Rust `reqwest`，比扩展端 PAC 脚本更稳定，HTTP/HTTPS/SOCKS 都支持

### Notes
- 扩展版（master 分支）功能完全不受影响，老用户继续用扩展无障碍
- 详细设计与实施方案见 [`docs/superpowers/specs/2026-05-10-windows-desktop-design.md`](docs/superpowers/specs/2026-05-10-windows-desktop-design.md)

## [1.1.0] - 2026-05-07

### Added
- 全部待办：移到顶栏「全部笔记」下方，命名「全部待办」
- 笔记 / 待办列表卡片化样式：每条独立背景 + 边框 + 阴影，悬停 / 选中态升级
- 字体定制：6 种字体族（Fraunces 衬线、Inter 无衬线、苹方黑体、楷体、宋体、系统默认）+ 13–20 px 字号滑块 + 实时预览
- 统一「设置」入口：左下「设置」按钮 + 5 标签页（外观 / 字体 / AI / 数据·备份 / 导入·导出）
- AI 助手：左下侧栏 AI 助手按钮 + 聊天模态框，支持工具调用（新建笔记 / 待办、搜索笔记 / 待办、列出笔记本、文本改写）。多轮 tool-calling 协议
- Skill 文档 `skills/ai-assistant.md` 描述 AI 助手能力规格、工具协议、时间解析规则、范例

### Changed
- 重命名 Marginalia → Marginote（界面、品牌、AI prompt、skill 文档）
- 拆分代码：`js/appearance.js`（主题 / 字体 / 设置标签页）、`js/assistant.js`（AI 助手）从 app.js 独立
- 错误日志区扩大：min-height 200 px、max-height 360 px
- 设置模态框 tab 切换时按需刷新，解决从「设置」直接进入主题 / AI / 数据时内容空白问题

### Fixed
- 设置模态框打开时主题列表为空、自定义颜色显示黑色
- AI 设置中下拉框无内容
- 数据·备份页存储信息空白

## [1.0.0] - 2026-05-06

Initial public release under the **Marginote** name.

### Features
- Markdown editor with auto-save (400ms debounce)
- Notebook → folder → note hierarchy with tags, favorites, recycle bin
- Todo list with system-level reminders (lead time, repeat count, interval)
- 10+ themes (light / dark / eye-care / morandi / high-contrast)
- AI optimization with multi-provider support (DeepSeek / Kimi / OpenAI / Ollama / custom proxy)
- Image paste/drag with base64 inline or `_assets/` directory
- Full-text search across title, content, tags, and notebooks
- One-click zip export / import (notes + images + todos + config)
- Periodic auto-backup to download directory
- File System Access API for local folder sync
- Reading mode (focus full-screen)
- Split-pane editor (markdown + preview)
- Document outline panel
- Mobile-responsive layout
- Accessibility: focus-visible scoped to interactive controls only — text inputs use caret as focus indicator

### Notes
- Extension does **not** override the new tab page. Open via toolbar icon. To restore the override, add `"chrome_url_overrides": { "newtab": "index.html" }` to `manifest.json`.
- All data stored locally via `chrome.storage.local`. No telemetry, no remote scripts.
