# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.3] - 2026-06-28

AI 助手体验优化 + 批量删除 + prompt 精简 + 对话气泡美化。

### 新功能

- **批量删除笔记**：新增 `batch_delete_notes` 工具，AI 可一次删除多篇笔记（不再逐条删导致遗漏）
- **搜索结果扩大**：`search_notes` 默认返回 30 条（原 10 条），最大支持 100 条，确保批量操作覆盖完整

### 优化

- **AI 对话气泡美化**：Bot 回复支持完整 Markdown 排版（标题分级、列表缩进、代码块高亮、引用块、表格边框、行内代码标签）；去掉 `pre-wrap` 强制保留空白
- **系统提示词精简**：工具描述压缩 50%+、笔记概览从 50 篇/100字 缩减为 30 篇/60字、移除冗长示例段，适配 40K 上下文的本地模型
- **prompt() 弹窗替换为内联编辑**：新建/重命名分组和会话不再弹出 `tauri.localhost` 对话框，改为列表内直接编辑（Enter 确认 / Escape 取消）
- **"+新对话"按钮生效**：助手侧栏的 `assistantNewGroupBtn` 补上缺失的事件处理

### 发布

- Chrome 扩展：v1.2.3（自包含，下载后直接加载 `extension/` 目录）
- Windows 桌面版：v1.2.3（Tauri + WebView2）

## [1.2.2] - 2026-05-29

工作目录（双向）+ 自动备份可定位 + 移除单向备份 + 桌面版历史版本弹窗修复 + UI 优化 + 构建配置调整。

### 实验性

- **Excalidraw 画图增强（step2）**：① 修复画板打开后无法编辑（容器高度塌陷 + canvas 尺寸缓存，改 absolute fill + 挂载后 refresh）；② 画板在工作目录以 `.excalidraw` 纯场景 JSON 双向同步（注入 `_mn` 元信息记归属，与 Obsidian Excalidraw 目录格式兼容），不再被包成 `.md`；zip 备份同样含 `.excalidraw`；③ 列表显示画板缩略图（PNG 存 IndexedDB 图片仓，note.thumb 引用），不再显示场景 JSON；④ 画板内「PNG / SVG」按钮导出整图到图片仓，引用 `![](img:id)` 复制到剪贴板可粘进任意笔记；⑤ 深色主题切换实时联动 iframe（免重载不丢改动）；⑥ 永久删除画板时清理缩略图。

- **内置 Excalidraw 画图（step1 最小可用）**：侧栏「新建画板」创建一块手绘画板（存为 `type:'drawing'` 笔记，内容为 Excalidraw 场景 JSON），通过自托管 iframe + postMessage 与主程序交换数据，React/Excalidraw 全锁在 iframe 内。需先在 `shared/excalidraw/vendor` 运行 `bash fetch.sh` 下载约 3MB 资源（联网一次，之后离线可用）；未安装时画板页会显示安装提示而非白屏。桌面 exe 与 Chrome 插件双端一致。

### 优化

- **设置弹窗改矮改宽**：设置弹窗由 760px 宽 / 88vh 高调整为 920px 宽 / 68vh 高（max-height 78vh），不再又高又窄。
- **工作目录显示绝对路径**：数据 · 备份 的「工作目录」去掉「（推荐）」字样；桌面 exe 下显示所选目录的完整绝对路径（Rust `cmd_workdir_pick` / `cmd_workdir_status` 改为返回绝对路径）。Chrome 扩展受 File System Access API 安全限制只能显示目录名（浏览器不暴露绝对路径）。
- **大屏编辑区加宽**：24 寸 / 高分屏下右侧编辑区进一步加宽（≥1600px 1180px、≥1920px 1400px、≥2200px 1680px、新增 ≥2560px 1920px 档），并放宽 1920px 档的左右内边距。
- **消除中栏列表编辑时闪烁**：以前每次自动保存都会整列 `innerHTML` 重建，触发每个笔记条目的 fadeIn 动画造成屏幕「一闪一闪」。改为编辑当前笔记时只原地更新该列表项的标题/预览/日期/标签（不重建元素、不重放动画）；仅当列表成员或顺序变化时才整列渲染。
- **设置弹窗统一尺寸与排版**：设置弹窗改为固定高度（80vh）+ 内部滚动，切换「外观/AI/数据/导入导出/桌面」子页不再因高度差跳来跳去；并统一各子页正文 / 标签 / 列表的字体与字号。

### 新功能

- **工作目录（双向同步）**：设置 · 数据 新增「工作目录」。选择一个本地目录后，新增 / 修改的笔记与待办会以 `.md` 实时写入该目录（结构：`笔记本/文件夹/标题.md`，待办在 `待办/` 子目录，图片在 `_assets/`，笔记本/文件夹等元信息在 `_marginote/meta.json`）。把外部 `.md` 放进目录后点「扫描导入」即可出现在应用中（双向）；启动时也会自动从目录导入。卸载软件 / 扩展不会删除这些文件。
  - 桌面 exe：走 Tauri 原生文件系统（新增 `cmd_workdir_*` 命令 + `tauri-plugin-dialog` 选目录），所选绝对路径持久化，重启免重新授权。
  - Chrome / Edge 扩展：走 File System Access API（需 100+），目录句柄存 IndexedDB；重装扩展后重新选择同一目录即恢复。
  - 新增 `mn.platform.fs` 平台抽象层，两端实现签名一致。
- **自动备份可定位**：自动备份的 zip 现在写入工作目录的 `_backups/` 子目录（已设工作目录时），用户能直接找到备份文件；未设置工作目录时回退为浏览器下载。

### 变更

- **移除「本地文件夹同步（单向备份）」**：该功能只单向导出 `marginote.json` 且不读取散放的 `.md`，易与「工作目录」混淆；工作目录（双向）已完全覆盖其用途，故删除。原已导出的 `marginote.json` 文件仍保留在磁盘，不受影响。

### 修复

- **历史版本弹窗恢复双栏布局**：桌面 exe 下「历史版本」弹窗原本塌成单栏、看不到右侧版本内容，与 Chrome 插件「左侧版本列表 + 右侧版本预览」不一致。根因是 `openVersionModal()` 里一段 `isDesktopContext()` 专属降级逻辑主动隐藏了预览栏并把列表拉满宽；已移除该分支，桌面与插件走同一套双栏 DOM。
- **弹窗尺寸固定**：弹窗改为固定高度（`82vh`）+ 内部滚动，切换不同长度的历史版本时窗口大小不再忽大忽小；整体宽度从 880px 提到 1040px。
- **左栏文字样式与插件一致**：版本条目的字号 / 字重 / 选中高亮从内联 style 改为 class 规则。
- **WebView2 兜底**：弹窗尺寸、两栏布局、列表文字全部用 `<style>` class（带 `!important`）承载，规避 WebView2(Tauri release) 偶发丢失 inline style 解析导致的布局塌陷；inline style 保留作 Chrome 主路径，数值一致互为兜底。

### 构建

- Windows exe 构建（`build-windows.yml`）触发分支由 `dev_exe` 改为 `dev`（远程已不再有 `dev_exe`）；仍只产出可下载 artifact，公开 Release 仅由 `v*` tag 触发。

## [1.2.1] - 2026-05-12

相对 v1.2.0 的小版本修复 + 体验增强。

### 新功能

- **编辑区缩放**：右侧栏笔记/待办编辑区与预览支持 `Ctrl + 鼠标滚轮` 缩放，比例自动持久化（50%–300%）
- **拖拽排序**：左侧栏「笔记本」「AI 分组 / 会话」与中栏「待办列表」子项支持鼠标拖拽调整顺序
- **AI 指令管理**：「AI 优化」下拉新增「🧩 指令管理」入口，可查看 / 编辑预设指令的标题与系统提示词；支持「＋ 新增指令」自定义全新指令，每条指令旁有「启用」开关，关闭后在菜单中隐藏；支持「恢复默认」
- **AI 系统提示词升级**：内置 `🏷 标题总结` 等 8 个预设全面重写为 Markdown 结构化模板，输出更稳定
- **笔记标题瘦身**：右侧栏编辑区标题字号从 32 → 22px（响应式 26 → 20px），副标题行间距同步收紧，腾出更多正文空间

### 修复

- **`---` 分隔线渲染**：双重根因 — ① markdown-it 在前文紧贴非空行时把上一行误识为 setext H2 → 已在预处理自动补空行；② `.preview hr::after { content: '· · ·' }` 装饰 CSS 把 `<hr>` 画成三个点 → 改为 `border-top` 实线分隔
- **Ctrl+Z 撤销失效**：插入图片 / 工具栏「引用」「分隔线」等操作切到 `execCommand('insertText')`，保留浏览器原生 undo 栈
- **AI 自定义指令**：弹窗新增「直接返回修改后的正文，不要无关注释」等特色提示词建议，降低无关前后缀输出概率
- **AI 设置文案**：精简为「配置 OpenAI 兼容的模型接口」
- **AI 助手对话改为流式输出**：`runAssistantTurn` 接通 `callAi(stream:true)`，边收到 token 边在 typing 气泡实时展示 reply 文本，完成后再走原有 JSON 解析与工具调度
- **「🏷 标题总结」语义修复**：新增 `mode:'title'` 专用通道——AI 优化后仅替换标题栏（笔记 title / 待办 text），正文保持不变；输出自动剥离 `#`、引号与多行
- **Windows 桌面版拖拽不生效**：根因为 Tauri 2 `window.dragDropEnabled` 默认 `true`，OS 级拖拽 handler 抢占 HTML5 内部 dragstart/drop；改为 `false` 后桌面版的笔记本 / AI 分组 / 会话 / 待办列表均可正常拖拽排序
- **去掉「AI 生成中… 点击取消」浮动条**：移除 `#aiCancelBtn` HTML 元素，流式仍在底层运行（仅去掉视觉打扰）

### 多模态（图片识别）

- **provider 新增 `multimodal` 开关**：AI 设置的模型表单加「支持图片识别」复选框；勾选后任意 provider（包括自定义接口）都可作为 vision 通道使用，不再限定具体厂商
- **AI 优化**：开启 multimodal 的 provider 调用「润色 / 总结 / 标题 / 自定义指令」等任意 action 时，自动把笔记里的 `![...](img:xxx)` 图片解析为 dataUrl 并以 OpenAI Vision `image_url` 格式发送
- **AI 助手聊天图片**：picker 弹窗新增「🖼 图片」分区（支持本地多选 + 缩略图预览 + 点击移除），输入框 `Ctrl+V` 粘贴剪贴板图片照常生效；笔记附件中的图片与聊天图片一并以 `image_url` 发送
- **413 / 上下文过大保护**：上送前自动把每张图片缩到 1280px 长边 + JPEG 0.85 重压，避免触发 `Request Entity Too Large`
- **聊天历史不再因图片崩溃**：保存到会话历史的附件快照不再保留 dataUrl，仅留 type/title 元信息；`renderAssistantMessage` 显式处理 `type:'image'`，修复"发图后整个会话不见了"

### 流式输出兜底

- **服务端不支持 SSE 时模拟流式**：`callAi` 包装器在响应 `content-type` 非 `event-stream` 或走 HTTP 后台桥时，会把完整回复按 6 字符 / 14ms 节奏回放到 `onDelta`，让 UI 也有"打字"观感
- **AI 优化 / AI 助手** 任意 provider 现都能看到流式效果（即使后端是一次性返回）

### 标题总结

- prompt 不再要求 emoji 前缀；`cleanTitleText` 额外剥离开头的 emoji 字符；菜单 label 改为「标题总结」
- 输出风格统一为 `[核心主题] - [关键动作/状态]` 纯文本

### 体验

- AI 设置「支持图片识别」复选框去掉冗长解释文字，复选框 / 标签垂直居中对齐
- AI 助手输入框去掉单独的图片按钮，统一从「附件」按钮进入 picker（旧版布局），消除原生 file input 显示「选择文件 / 未选择文件」的视觉打扰

### 存储

- `marginote.aiActions` 升级为 `{overrides, custom, disabled}` 结构，兼容 v1.2.0 老数据自动迁移

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
