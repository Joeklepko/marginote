# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-05-12

相对 v1.2.0 的小版本修复 + 体验增强。

### 新功能

- **编辑区缩放**：右侧栏笔记/待办编辑区与预览支持 `Ctrl + 鼠标滚轮` 缩放，比例自动持久化（50%–300%）
- **拖拽排序**：左侧栏「笔记本」「AI 分组 / 会话」与中栏「待办列表」子项支持鼠标拖拽调整顺序
- **AI 指令管理**：「AI 优化」下拉新增「🧩 指令管理」入口，可查看 / 编辑预设指令的标题与系统提示词，支持「恢复默认」
- **AI 系统提示词升级**：内置 `🏷 标题总结` 等 8 个预设全面重写为 Markdown 结构化模板，输出更稳定

### 修复

- **`---` 分隔线渲染**：在前文紧贴非空行时，markdown-it 会把上一行误识为 setext H2 导致分隔线消失；现已自动补足空行，恒渲染为 `<hr>`
- **Ctrl+Z 撤销失效**：插入图片 / 工具栏「引用」「分隔线」等操作切到 `execCommand('insertText')`，保留浏览器原生 undo 栈
- **AI 自定义指令**：弹窗新增「直接返回修改后的正文，不要无关注释」等特色提示词建议，降低无关前后缀输出概率

### 发布

- Chrome 扩展：v1.2.1（自包含，下载后直接加载 `extension/` 目录）
- Windows 桌面版：v1.2.1（Tauri + WebView2，安装包约 12 MB）
- 已配置的 AI 模型、笔记数据全部沿用 v1.2.0；首次启动会读取覆盖后的指令配置

## [1.2.0] - 2026-05-11

相对 v1.1.0 的主要变化。

### 新功能

- **Windows 桌面版**：打包为 `.exe` 安装包，支持系统托盘、全局快捷键、开机自启、单实例、关闭最小化到托盘
- **AI 助手全面重构**：从底部按钮升级为左侧栏独立分组（与「笔记本」同级），分组下可建多个会话，会话间历史互不干扰；对话可附加笔记或待办，AI 直接操作附件内容
- **HTML 笔记**：编辑器工具栏新增「HTML 模式」按钮，开启后预览直接以网页形式渲染（适合粘贴邮件模板、网页快照等）
- **中侧栏折叠**：双击左栏项可折叠中侧栏，腾出空间专注阅读 / 对话
- **字体定制**：6 种字体（含系统默认、宋体、楷体等）+ 13–20px 字号滑块，实时预览

### 体验优化

- 「设置」按钮始终钉底，不再随笔记数量变化
- 左栏滚动条默认隐藏，鼠标移入才显示
- 折叠任意 section 后，下方内容自动上移，不留空白
- AI 助手分组项缩进展示层级关系，hover 显示重命名 / 删除按钮
- 默认示例文案改为「旅游攻略」

### 修复

- 笔记本点击折叠 / 中侧栏完全隐藏的多项视觉问题
- 扩展端字体大小设置不生效
- 桌面版 `.exe` 启动后空白
- 附件标签布局、深色主题色块、设置弹窗滚动等细节

### 发布

- Chrome 扩展：v1.2.0（自包含，下载后直接加载 `extension/` 目录）
- Windows 桌面版：v1.2.0（Tauri + WebView2，安装包约 12 MB）
- 老版本扩展数据 / 单会话 AI 历史自动迁移，无需手动操作

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
