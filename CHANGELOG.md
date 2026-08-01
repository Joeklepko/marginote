# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.4] - 2026-08-01

Windows 桌面版新增面向 Claude Code、Codex 等本地 agent 的正式 CLI，并与内置 AI 助手共享实时数据和业务规则。

### 界面优化

- 笔记的编辑 / 预览只通过右上角明确按钮切换，取消内容和空白区域的双击切换，避免双击选词、复制时误触。
- 顶部操作区按实际可用宽度自适应：笔记本窄窗口保留 `...`，大屏 / 宽窗口直接展示 HTML、双栏、阅读、复制、历史和导出操作。
- 修复阅读模式缩放：标题与正文会真实同步缩放；阅读页任意位置支持 `Ctrl + 滚轮`，并增加可见的缩放按钮和百分比。
- 阅读模式不再使用过窄的固定正文列，改为约占窗口 88%（超宽屏最大 1920px）；普通编辑 / 预览区改由字体引擎执行真实缩放，并增加常驻缩放控件。

### 新功能

- **`marginote-cli.exe` 随安装包分发**：提供笔记、待办、笔记本的查询 / 创建 / 修改 / 追加 / 完成 / 删除，以及统一搜索、能力自发现和受控原始工具调用；Release 同时附带独立 CLI 文件。
- **Agent 友好协议**：所有命令支持 `--json` 固定信封；`schema --json` 可离线发现命令与白名单工具；明确退出码，正文支持参数、UTF-8 文件和 stdin。
- **开箱即用**：NSIS 安装时把 CLI 加入当前用户 PATH，卸载时自动清理；Marginote 未运行时 CLI 自动拉起后台实例。

### 架构与安全

- **复用内置 AI 工具**：CLI 请求由 WebView 内现有 `ASSISTANT_TOOLS` 执行，应用界面、内置 AI、工作目录和待办提醒看到的是同一次变更。
- **安全本机桥**：Rust 仅监听 `127.0.0.1` 随机端口，每次启动生成 256-bit 随机令牌；不直接并发修改 WebView2 LevelDB。
- **独立 CLI crate / Tauri sidecar**：CLI 无 GUI 运行时依赖，通过构建脚本自动生成带 target triple 的 sidecar，Windows CI 可复现打包。
- **隐藏窗口可用**：请求事件可唤醒托盘后台 WebView，并有启动竞态轮询兜底。

### 完善

- `create_note` 支持标签和收藏；`create_todo` / `update_todo` 支持正文、提醒次数与间隔。
- CLI 更新待办后会重新调度提醒，删除待办会同步清理已注册闹钟。
- 新增 CLI 分发层单测、Rust 桥单测和完整中文使用文档。

### 发布

- Chrome 扩展：v1.2.4
- Windows 桌面版：v1.2.4（内置 `marginote-cli.exe`）

## [1.2.3] - 2026-06-30

AI 助手体验优化 + 批量删除 + prompt 精简 + 对话气泡美化；并整合多模型健壮性、128K 上下文、流式与记忆管理优化；笔记自动归类、中文搜索召回、多行输入框。

### 画板 / 稳定性

- **修复图片多时到处 out of memory 崩溃**：此前启动会把所有图片以 **base64 dataUrl 全量常驻内存**（base64 比二进制大约 37%、且压在 WebView2 渲染进程有限的 JS 堆上），渲染含图笔记时还会把同一张图的大 base64 内联进 `<img src="data:...">` DOM——图片一多，基线内存贴近上限，随便点几下（记忆面板、删除、打开链接等任何操作）都会把它顶爆。改为**内存里用 Blob 对象 URL**（二进制放堆外、`images` 表只留极短的 `blob:` URL、渲染 `<img src="blob:...">` 不再内联大 base64）；base64 仍保存在 IndexedDB 中供导出/写盘使用。带回退：blob 创建失败则退回 base64，不影响显示。
- **移除画板（Excalidraw 手绘图）功能**：其自托管运行时约 4.4MB，在 WebView2 里加载/销毁 iframe 易把渲染进程内存推爆导致 out of memory 崩溃（尤其删除画板时），故整体移除：去掉「新建画板」入口、不再加载任何 Excalidraw 运行时、删除内置的 vendor 资源（减小安装包）。已有的画板笔记打开时显示占位提示并可删除；旧 `.excalidraw` 文件的磁盘同步不受影响。
- **修复启动不久 out of memory 崩溃**：已绑定工作目录时不再执行"自动 zip 全量备份"——工作目录本身就是笔记的实时磁盘备份，再用 JSZip 把所有笔记+图片打包进内存会在图片较多时把 WebView2 渲染进程内存峰值抬高数倍而崩溃。

### 工作目录·回收站（桌面）

- **删除进回收站、可恢复、30 天**：绑定工作目录后，删除笔记/笔记本改为把对应文件/整个文件夹移入工作目录下的 `回收站/`（索引 `_marginote/trash.json`），从活跃列表移除。**删笔记本**改为整个笔记本目录进回收站、可整体恢复（不再"搬到默认本"）；未绑定工作目录时仍保留旧行为（笔记搬默认本），避免无回收站时丢数据。批量删除同样进回收站。
- **软件内回收站视图**：设置 → 工作目录 →「🗑 回收站」，可浏览已删项（类型/名称/剩余天数）、一键**恢复**（移回原路径并重新导入）或**彻底删除**。
- **30 天自动清理**：启动时清除删除超过 30 天的回收站项。
- **删除用真实路径**：删笔记按导入记录的真实路径 `_srcPath` 操作，不再按当前元数据重算（标题/结构变化时会删错、留孤儿）。
- **未设工作目录时启动引导**：桌面端未绑定工作目录会提示选择（选择后自动把现有本地数据迁移写入该目录）。

### 新功能

- **批量删除笔记**：新增 `batch_delete_notes` 工具，AI 可一次删除多篇笔记（不再逐条删导致遗漏）
- **搜索结果扩大**：`search_notes` 默认返回 30 条（原 10 条），最大支持 100 条，确保批量操作覆盖完整
- **对话流式输出**：助手主对话复用 SSE 流式管线，实时显示「思考中→回复预览」，消除等待白屏；新增浮动「中止生成」按钮（中止保留已生成的部分回复）

### 本次修复

- **笔记自动归类**：AI 记笔记不再一律丢进「随笔」——系统提示词列出现有笔记本并要求按内容选最贴切的一个，无合适的则新建；`quick_note` 在指定笔记本不存在时自动新建（原会静默落回默认本）
- **中文搜索召回**：`search_notes` 增加 2-gram 模糊匹配 + 相关度排序，解决大模型不加空格直搜（如「用药上线时间」）命中不到笔记（如《用药交付时间》）的问题；refusal 兜底改为代码内直接执行检索并注入结果，不再依赖模型自觉重搜
- **多行输入框**：AI 对话输入框随内容自动增高（上限内滚动），便于录入大段文字；保持 Enter 换行、Ctrl/⌘+Enter 发送
- **外链在浏览器打开**：笔记/待办/AI 对话中的网址链接点击后改为在系统默认浏览器（桌面）/ 新标签页（扩展）打开，不再在应用内 webview 整页导航导致「陷在网页里、只能退出应用才能回到笔记」；新增 `mn.platform.openExternal`（桌面走 tauri-plugin-shell），并全局捕获拦截 http(s) 外链
- **启动不再闪空白**：`init` 改为先用同步数据（localStorage）渲染首屏，再去等平台 bridge / 图片仓 / 闹钟等异步初始化，消除「先显示空笔记页、过一会才刷出数据」
- **主题仅点击应用**：外观设置的主题改为只有点击才应用，移除原先「鼠标划过即实时预览切换主题」（极易误触、页面来回闪）
- **修复 Windows 构建失败**：提交 `Cargo.lock` 并锁定 `time = 0.3.51`，规避新版 `time 0.3.52` 破坏 `cookie 0.18.1` 编译（`Parsable::parse` 参数变更）导致的 CI 构建中断

### 冷启动加速

- **字体非阻塞加载**：Google Fonts 样式表改为 `media="print" onload` 异步加载（含大体积中文字体 Noto Serif SC），首屏立即用系统字体渲染、网络字体到位后平滑替换，离线/慢网不再白屏卡住——这是冷启动「打开后很久才显示内容」的主因
- **jszip 延迟加载**：仅备份/导入用的 `jszip`（97KB）改 `defer`，移出首屏关键路径
- **工作目录增量导入**：启动时不再全量读取+解析磁盘上所有 `.md`，改为按 mtime 只导入自上次导入后有变动的文件（手动「扫描」仍全量）；显著减少绑定了工作目录时的启动 I/O

### 修复

- **删除/移动笔记后工作目录旧文件与空文件夹残留（导致删掉的笔记本"复活"）**：删除笔记本、删除/移动笔记时，写回工作目录只写当前文件、不清理旧路径，残留的 `.md` 会在下次导入时被读回、重建已删的笔记本/笔记；且删笔记本后磁盘上对应的**文件夹本身也不会被删除**。改为写回时：① 按 meta 记录的 `noteFiles`/`todoFiles` 对账，删除「上次写过、这次不再占用」的旧文件路径（移动/重命名/删除/删笔记本均覆盖）；② 再删除**变空的目录**（删笔记本/文件夹后其空目录一并清掉）。均只动 Marginote 自己写过的路径、只删完全不含文件的目录，绝不碰用户外部新增的文件/目录，路径互换也不误删
- **删笔记本后 Windows 目录还在、扫描后"复活"；删笔记留下删不掉的孤儿文件**：① `delete_notebook`（AI 与界面）此前只改内存不碰磁盘，现改为**直接删除磁盘上的笔记本文件夹**（含未导入的孤儿文件；活跃笔记已搬到默认本并随后写回，不丢）；② `delete_note` 此前按当前元数据**重算**路径去删、易删错，改为优先用导入时记录的真实路径 `_srcPath`；③ 导入时遇到"对应已删除笔记(墓碑)的残留文件"直接从磁盘清掉（此前会被跳过 → 既不显示、又让目录非空删不掉、还会在扫描时复活）；④ 提示词纠正：判断笔记本是否存在以当前列表为准，不再因旧对话说过"已删除"就拒绝再删
- **AI 助手删一条笔记却执行 20 步、撞接口限流（HTTP 429）**：删除"无标题/空"笔记时它没有可搜的标题/内容，模型反复 search 找不到 id、原地打转直到撞每分钟调用上限。修复：① 系统提示的「笔记索引」每条**带上 (id:xxx)**，模型可直接对任意笔记（含无标题空笔记）`delete_note({id})`，无需反复搜索；② 主循环加**防打转守卫**——重复发起完全相同的工具调用即停、单轮工具步数封顶 15（留在 20/min 限制之下）；③ 命中 HTTP 429 时给出友好提示（等约 1 分钟再试）而非报错
- **AI 助手"口头假装完成"（说已创建笔记但实际没存）**：模型有时只在回复里描述"已帮你创建笔记…归类为随笔"，却没有真正发出创建工具调用（或工具执行失败），导致笔记本、磁盘、记忆里都查无此项。新增守卫：本轮没有任何写工具真正成功、回复却声称创建/保存了笔记/待办/记忆时，改为明确提示"实际并未创建/保存成功"（并附失败原因），不再误导；系统提示词也增加"严禁无工具调用就声称已完成"的硬性约束
- **工作目录里的部分文件不导入（笔记本显示空、连带删不掉目录）**：此前的"按 mtime 增量导入"会跳过修改时间早于上次导入阈值的文件（如从别处拷入、保留旧修改时间的文件），导致这些笔记永远不被载入 → 笔记本在软件里显示为空 → 删它时软件以为无内容、没清磁盘 → 目录残留删不掉。改为**全量可靠导入**：应用尚未载入的文件一律读取，绝不因 mtime 跳过；仅对"已载入且 mtime 未变"的文件跳过重复解析（提速）。新增纯逻辑模块 `import-plan`（含单测），并排除 `回收站/`、`_` 前缀目录

### 多模型健壮性

- **工具调用抢救解析**：从 minimax 等模型的非标准 / 原生 `tool_call` 文本中抢救工具调用，修复「搜索不执行、原始文本被当回复」；兼容原生 `message.tool_calls`
- **检索兜底**：模型未检索就给「无法找到」类回答时，强制其先 `search_notes` 再作答
- **思维链剥离**：剥离推理模型（deepseek-v4-flash / minimax2.7 等）输出开头的 `<think>` 块，避免污染回复 / 上下文 / 笔记（仅锚定开头，不误删正文中合法的 `<think>`）
- **上下文大小「一键测试」修复**：探针放宽 `max_tokens`、兼容 `reasoning_content`，并区分「连不上」与「连上但未返回验证码」

### 优化

- **128K 上下文调优**：`_ctxLimit` 按上下文比例放大检索 / 历史预算；系统提示词常驻段（笔记索引 / 待办 / 记忆）封顶不随上下文膨胀；放开「每轮仅 1 工具」限制，独立工具可一轮并列
- **记忆管理**：统一写入入口（同 key 覆盖、value 限长、总量封顶）；`recall_memory` 支持按类别筛选 + 按更新排序；记忆随工作目录持久化 / 跨设备同步；提示词标注类别并强化「主动记忆 / 作答前参考」
- **内联笔记 AI 提示词**：扩写等动作统一加 Markdown 保护（代码块 / 引用 / 列表原样）+ 语言一致性 + 不编造约束；AI 撤销快照上限 10→50
- **系统提示词精简**：工具描述压缩 50%+、笔记概览从 50 篇/100字 缩减为 30 篇/60字、移除冗长示例段，适配 40K 上下文的本地模型
- **原生弹窗替换为应用内组件**：新建/重命名/删除分组与会话、清空历史不再弹 `tauri.localhost` 对话框，改为内联编辑 / 应用内 `showModal`
- **中侧栏 UI**：「新分组 / 新会话」强制单行；分组项补重命名 / 删除图标
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
