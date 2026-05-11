# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-05-11

> 本版本聚焦：AI 助手三栏结构重构、HTML 笔记预览、左侧栏布局体验打磨。
> 同时发布 Chrome 扩展（1.2.0）与 Windows 桌面版（1.2.0 / Tauri）。

### Added
- **AI 助手三栏结构重构**（左栏分组 → 中栏会话 → 右栏对话）
  - 左侧栏新增独立的 `AI 助手` rail-section（位于「笔记本」下方），支持新建 / 重命名 / 删除分组
  - 中侧栏在选中分组时展示该组下所有会话，支持新建 / 重命名 / 删除会话
  - 右侧栏沿用 AI 对话框，每个会话独立维护消息历史
  - 双击同一分组项可折叠中侧栏（与笔记本一致）
  - AI 分组项 hover 显示内联「重命名 / 删除」按钮（与笔记本「随笔」样式一致）
  - 旧版数据自动迁移：`group.messages` → `group.sessions[0].messages`
- **HTML 笔记预览**：编辑器工具栏新增「HTML 模式」按钮
  - 切换后笔记 `format = 'html'`，文字编辑能力完全保留
  - 预览模式用 sandboxed iframe (`srcdoc` + `allow-scripts allow-forms allow-popups`) 渲染网页
  - 适合粘贴第三方导出 HTML、保存网页快照、撰写邮件模板等场景
- **AI 对话附件**：对话中可附加笔记或待办事项，AI 可直接对附件内容进行操作和修改
- **新增 AI 工具**：`update_todo`（修改待办）、`update_note` 自动匹配附件笔记
- **中侧栏折叠**：双击 rail 项折叠中侧栏（grid-template-columns 切换到 248px 0px 1fr）
- 首次使用的默认示例文案改为「旅游攻略」

### Changed
- 设置默认字体改为「系统默认」、默认字号改为 16px
- Chrome 扩展改为完全自包含，无需运行 `build.sh`，下载后直接加载使用
- AI 助手模态框宽度从 660px 扩展到 880px
- 笔记本侧栏改为 `flex:1` 撑满剩余空间 + 内部滚动，「设置」按钮始终钉底
- 左侧栏滚动条：默认透明，hover 才显出（笔记本 / AI 分组）
- AI 优化按钮新增浅黄底色，提高可见度
- AI 助手分组项 `padding-left: 26px`，与 "AI 助手" 标题形成层级缩进
- 删除中侧栏内的折叠按钮，改为双击 rail 项折叠

### Fixed
- 笔记本项点击折叠未生效（修复 `data-nb` 选择器）
- 中侧栏折叠时未完全隐藏（grid-template-columns 改为 `248px 0px 1fr`）
- 扩展端字体大小设置未生效
- 桌面版 `.exe` 启动后空白（修复 `</style>` 标签缺失）
- AI 助手面板打开时点击笔记或待办自动返回编辑器
- 附件标签布局优化为竖列

### Migration
- 旧版 `marginote.assistantGroups`（一级 `group.messages` 结构）自动迁移为新两层结构
- 更早版本 `marginote.assistantHistory` 单会话历史自动包装为一个默认分组 + 一个默认会话

### Versions
- Chrome 扩展：`extension/manifest.json` v1.2.0
- Windows 桌面版：`desktop/src-tauri/Cargo.toml` v1.2.0 + `desktop/package.json` v1.2.0 + `desktop/src-tauri/tauri.conf.json` v1.2.0

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
