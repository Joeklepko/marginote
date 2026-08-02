# Marginote 产品与技术全面审查（2026-08-02）

## 1. 范围、基线与假设

本次审查覆盖 `README.md`、桌面/工作目录设计文档、CLI 文档、package/Cargo/Tauri/Manifest 配置、共享前端、AI 助手、CLI/Rust 桥、存储与全部现有测试。仓库及父级未发现 `AGENTS.md`。

基于现有文档和用户主要使用方式，本报告采用以下假设：

1. Windows `.exe` 是主产品，Chrome/Edge 扩展是兼容形态。
2. 目标用户是需要长期积累个人知识、待办并让本地 Agent 自动读写的知识工作者/开发者。
3. 本地优先、可恢复、可追溯写入优先于云同步和多人协作。
4. CLI 与内置 AI 应共享同一套数据、工具语义、安全规则和操作反馈。
5. 本轮不改变现有数据格式，不删除功能，不执行远程 push。

## 2. 当前架构与功能概览

```text
Windows 安装包 / marginote-cli
        │
        ├─ Tauri/Rust：窗口、托盘、提醒、工作目录、AI 网络桥、CLI 本机令牌桥
        │
        └─ shared/：单页原生 HTML/CSS/JS
             ├─ app.js：笔记、待办、编辑器、导入导出、工作目录、AI 快捷操作
             ├─ assistant.js：对话、意图、检索、工具调用、收据、记忆
             └─ cli-core/bridge：把 CLI 请求映射到同一组 AI 业务工具

Chrome/Edge extension/
        ├─ MV3 background：窗口、通知、代理 fetch
        └─ 一套独立复制的 HTML/JS 前端
```

主要能力已覆盖笔记本/文件夹/标签/收藏/回收站、Markdown 与图片、全文过滤、待办与提醒、ZIP/Markdown 导入导出、历史版本、多个 OpenAI 兼容 Provider、AI 对话/写作动作、工作目录和 Agent CLI。

桌面与 CLI 的关键数据流是：CLI 读取用户应用数据目录内的随机端点文件，通过 `127.0.0.1 + 256-bit token` 请求 Rust 桥；WebView 排队执行 `ASSISTANT_TOOLS`，因此界面、内置 AI 与 CLI 观察同一内存状态。

## 3. 已有优势

- 产品差异点已出现：本地笔记 + 待办提醒 + 内置 AI + Agent CLI 是一条完整方向，不只是聊天侧栏。
- 数据可迁移：Markdown、`_assets/`、frontmatter 和 ZIP 备份便于脱离产品读取。
- 图片系统已经针对 WebView2 OOM 做了 IndexedDB、懒加载和小 LRU 优化。
- AI 已有意图分类、本地预检索、工具白名单、删除确认、写入收据、流式中止和模型调用耗时记录。
- CLI 命令分组清晰，支持 stdin/文件正文、固定 JSON 信封、退出码、能力 schema、未启动自动拉起。
- CLI 不直接写 WebView2 LevelDB；Rust 桥仅监听 loopback，令牌每次启动随机生成。
- Rust 工作目录路径拒绝绝对路径和 `..`；CI 会跑共享 JS、CLI Rust、桌面 Rust 并构建 Windows 安装包。
- 已将若干关键算法抽成浏览器/Node 双导出的纯逻辑模块，测试运行快且不依赖网络。

## 4. 问题与优先级

### P0：数据损失、安全绕过或主流程不可用

| ID | 问题与证据 | 影响 / 原因 | 建议与状态 |
|---|---|---|---|
| P0-1 | 主数据解析异常原本在 `shared/app.js` 的 `loadData()` 中清空数组，随后自动 `saveData()` | 一次截断写入或结构异常即可把可恢复原文覆盖成默认数据 | 已修：`data-core.js` 校验；异常原文先备份，备份失败则禁止覆盖；ZIP 导出包含 `_recovery/` |
| P0-2 | ZIP 图片导入原本只把 `dataUrl` 放入 `images` 内存对象，而 `saveData()` 明确不保存图片 | 导入当次可见，重启后图片消失 | 已修：`addImageRecordPersisted()` 等待写入 IndexedDB 后才完成导入 |
| P0-3 | AI 流式回调原本持续改写全局 `currentNote/currentTodo`；请求失败不回滚，切换笔记后目标引用也会变化 | 半截生成内容污染原文；生成期间切换可误写另一篇笔记 | 已修：`ai-edit-core.js` 实现草稿/提交事务，捕获启动目标，成功后一次提交，失败保持原文 |
| P0-4 | 普通 CLI 删除要求 `--yes`，但 `call delete_* --args ...` 原本不要求确认 | Agent 可绕过产品声明的删除保护 | 已修：Rust CLI 与 `cli-core.js` 双重确认，内部确认字段不会传给业务工具 |
| P0-5 | `extension/index.html` 原本引用不存在的根级 `platform-extension.js` | README 所述“直接加载 extension/”会在启动阶段缺少平台实现 | 已修路径并增加 `static-assets.test.js`，校验两个 HTML 的所有本地脚本存在 |
| P0-6 | “磁盘是桌面唯一数据源”的设计尚未完整落地：工作目录仍是可选，保存仍以 3 秒全量写回为主，文件夹删除尚未统一进磁盘回收站 | 普通 UI 写入和外部文件副作用还未全部进入统一 UnitOfWork | 已完成两步：底层原子写入/外部删除对账，以及 AI/CLI 非破坏性写工具的 Repository、change-set、失败回滚；下一步迁移普通 UI 并实现磁盘 change-set/冲突预览 |

P0-6 剩余的关键证据：`shared/app.js` 中工作目录仍可处于“未启用”状态、`saveData` 仍通过 3 秒 debounce 做全量写回、`deleteFolder()` 仍先修改内存关系；统一 Repository/fileOps 尚未建立。原 merge-only 导入和底层直接覆盖问题已在下一阶段第一步修复。

### P1：明显降低体验、可维护性或规模化能力

| ID | 问题 | 影响 / 原因 | 建议 |
|---|---|---|---|
| P1-1 | 产品定位文案混用“浏览器侧边笔记”和 Windows/Agent 主产品 | 新用户不清楚应该安装什么、核心价值是什么 | 首页统一为“Windows 本地 AI 笔记库 + Agent 接口”，扩展降为兼容入口；本轮已先修 README 主叙事 |
| P1-2 | 新手引导仍主要是一篇示例笔记；没有首次任务清单、工作目录/AI/CLI 渐进引导 | 能打开但难形成“记录—检索—AI—Agent”的首个成功闭环 | 增加 3 步 onboarding：创建第一篇、绑定目录/备份、可选连接 AI/CLI；允许永久跳过 |
| P1-3 | 空列表原本只有文字；高级搜索语法仍未在 UI 充分暴露 | 用户容易把过滤结果为空误判为数据丢失 | 已修上下文 CTA：创建笔记/待办、清除搜索/标签；仍待增加过滤 chip 和可发现的语法帮助 |
| P1-4 | 多文件导入原本并发直改全局数组，任一失败仍可能保存半份数据 | 用户无法信任备份恢复，且缺少冲突决策 | 已修批次级快照/失败回滚、新增图片清理、FileReader 错误、ZIP 文件数/解压体积限制，并延后版本提交；仍待冲突预览、覆盖/保留副本和完整 E2E |
| P1-5 | 搜索仍全量扫描正文并重建整个列表；原本每个输入事件立即执行 | 大库输入仍可能卡顿 | 已加 160ms debounce 和 CLI cursor 信封；下一步建立统一倒排索引/分词服务供 UI、AI、CLI 复用 |
| P1-6 | AI 对话原本需要在列表中手工找附件；快捷动作原本总处理整篇 | 上下文选择割裂且容易发错内容 | 已实现 selection-aware 快捷 AI，并在助手输入区增加一键附加当前笔记/待办/选区及可移除 chip；选区在对话中强制只读，防止模型用整篇更新误覆盖。仍待关联笔记推荐 chip |
| P1-7 | 对话写工具原本只有收据和删除确认，非删除更新没有统一事务/追溯 | 模型误写或中途失败后需要人工逐项修复 | 已增加非破坏性写工具 change-set、失败回滚、AI 收据编号和导出审计；仍待修改预览、整轮撤销，以及把等待模型的 translate/clean 改成 prepare→commit |
| P1-8 | 本地检索是关键词打分 + 最多若干笔记摘要，缺少 chunk、引用位置和相关笔记图谱 | 笔记量大或正文很长时召回与可解释性下降 | 先做段落 chunk + BM25/中文 token；答案附笔记/段落引用；向量检索作为可选增强而非默认依赖 |
| P1-9 | AI 原本仅记录调用次数/耗时，Provider 请求和 SSE 在两端重复 | 成本不可见、错误行为漂移 | 已统一 Provider 请求/Header/SSE/工具调用/重试，展示实际或估算 token、调用数、检索数和耗时；仍待金额预算及上下文裁剪解释 |
| P1-10 | API Key 仍明文保存在本机 Web 存储；原启动会请求 Google Fonts | 本机同源脚本/恶意扩展或备份泄露风险 | 已彻底移除网络字体和 CSP 放行并校正隐私文档；仍待 Windows Credential Manager/Stronghold 与旧配置迁移 |
| P1-11 | CLI 原缺少导出、分页、幂等、dry-run 和批处理；仍缺 folder、ZIP import、NDJSON 文件批处理 | Agent 大批量操作与超时重试能力不完整 | 已增加 Markdown 导出、cursor、`--dry-run`、`--request-id` 24h 去重和白名单批量工具；下一步补 folder/ZIP import、参数 JSON Schema 和 NDJSON |
| P1-12 | CLI 原超时较短且重试可能重复写 | 不确定结果会产生重复记录 | 已统一 `requestId` 响应、180/185 秒超时与成功结果持久化去重；仍待真正的运行中 cancellation，幂等缓存当前限 100 条/24 小时 |
| P1-13 | `shared/app.js` 6846 行、`index.html` 4895 行、`assistant.js` 2596 行；多处函数定义后再重写（如 render/search/todo/AI） | 行为由加载顺序决定，修复容易只覆盖一层；单元测试难隔离 | Repository 核心已先抽出；继续按领域拆 `repositories/notes/todos`、`services/search/import/ai`、`ui/`，逐步替换 monkey patch，不做一次性框架迁移 |
| P1-14 | `shared/` 与 `extension/` 的 app/index/assistant 仍明显不同；原 `extension/build.sh` 是 no-op | 平台间安全/体验修复容易遗漏 | 已将 7 个纯核心设为 shared 单一源，构建同步且 CI 禁止漂移，并补齐扩展 AI 编辑/缩放/工具栏差异；仍待拆分并生成 app/index/assistant 平台无关部分 |
| P1-15 | Rust `storage::set` 原本在锁外 load、仅 save 时加锁，且直接覆盖文件；工作目录正文也直接 `fs::write` | 并发 set 可丢更新，崩溃/掉电可留下截断 JSON/Markdown | 已修：锁覆盖 read-modify-write；KV/工作目录共用临时文件、flush/sync 和跨平台原子替换；并发与损坏保护已有 Rust 测试 |

### P2：完善度与长期演进

| ID | 问题 | 建议 |
|---|---|---|
| P2-1 | UI 大量样式和 SVG 内联在 4887 行 HTML 中 | CSS/组件模板分离，建立 design tokens 与可访问组件 |
| P2-2 | 原本 hover 才显示的笔记本/文件夹/待办操作对键盘不友好；触屏仍需专项复核 | 已加入 `:focus-within` 展示并保留行级键盘打开；下一步统一 aria-label、触屏入口、焦点顺序和对比度测试 |
| P2-3 | 工作目录只在启动扫描，没有文件监听/冲突 UI | 增加 filesystem watcher，外部修改显示“接受/覆盖/对比” |
| P2-4 | 测试偏纯函数，缺少真实 IndexedDB、导入导出 round-trip、AI 流失败、工作目录失败和扩展启动 E2E | 加 Playwright/WebView smoke、fake IndexedDB、临时目录 Rust integration tests |
| P2-5 | 尚无覆盖率门槛和 ESLint/Prettier；原根目录无统一命令，CI 也未跑 clippy | 已增加 `npm run check/test/verify`、JS 语法/生成副本检查及 Rust fmt/clippy CI；下一步逐步引入规则集与覆盖率阈值 |
| P2-6 | 设计文档仍引用旧分支、旧插件/存储方案和已废弃 build 流程 | 文档增加 status/last verified；实现变更必须同步 ADR 和 README |
| P2-7 | 无自动更新和代码签名，SmartScreen 会损害首次安装信任 | 优先代码签名，再加入带签名校验的自动更新与可回退版本 |

## 5. 建议的整体路线图

### 阶段 A：可靠数据内核（最高收益，约 1–2 个迭代）

1. 定义带 `schemaVersion` 的 Note/Todo/Notebook/Folder 数据契约和迁移器。
2. 建立统一 Repository；所有 UI、AI、CLI 写入只经过 Repository。
3. 工作目录写入采用原子文件替换、change-set 和失败回滚。
4. 启动执行双向盘点：新增、修改、缺失、冲突先形成 plan，再 commit。
5. ZIP 导入同样使用 plan/preview/transaction，并做完整 round-trip 测试。

验收：任何一步失败都不会丢原数据；UI/AI/CLI 操作后内存、磁盘、回收站一致；外部删除不会被无提示“复活”。

### 阶段 B：真正融入工作流的 AI（约 1–2 个迭代）

1. 当前笔记/选区/附件/检索结果统一为可见 context chips。
2. 所有写操作输出 diff/计划，创建可撤销 change-set；低风险动作可配置自动应用。
3. 段落级检索与引用；UI、AI、CLI 共用 SearchService。
4. 结构化失败、重试、预算/token/隐私面板；API Key 迁入系统凭据存储。

验收：用户知道 AI 看了什么、改了什么、花费多少，且能一键撤销整轮操作。

### 阶段 C：Agent/CLI 平台化（约 1 个迭代）

1. 原子 `note patch`、`--dry-run`、`--request-id`、分页和 NDJSON batch。
2. 导入/导出、文件夹、回收站恢复等命令补齐。
3. schema 输出参数 JSON Schema、稳定错误码和 destructive 标记。
4. 发布官方 Agent 指令模板；后续可在 CLI 之上提供本地 MCP server，但 CLI 继续作为最稳定底座。

### 阶段 D：架构与工程治理（持续小步）

1. 先抽纯逻辑和 Repository，再拆 UI；每拆一块补测试，避免重写产品。
2. 让 extension 由 shared 构建生成，删除双份业务源。
3. 增加根级 `test/check/build`、lint/format/clippy、导入 round-trip 与 Windows smoke。
4. 代码签名、自动更新和可回退发布。

## 6. 本轮已完成的第二阶段优化

1. 数据损坏保护与结构校验：`shared/js/data-core.js`、`shared/app.js`、`test/data-core.test.js`。
2. ZIP 图片可靠持久化与恢复副本随 ZIP 导出：`shared/app.js`。
3. AI 流式草稿事务、固定目标与失败恢复：`shared/js/ai-edit-core.js`、`shared/app.js`、`test/ai-edit-core.test.js`。
4. CLI 高级删除双重确认及 schema 安全信息：`desktop/cli/src/main.rs`、`shared/js/cli-core.js`、相关测试与文档。
5. Chrome 扩展平台脚本路径与静态资源完整性回归：`extension/index.html`、`test/static-assets.test.js`。
6. README 的主产品定位、分支、架构、存储与隐私声明已按当前实现校正。

## 7. 验证记录

- 修改前基线：6 个 Node 测试脚本通过；CLI Rust 3 项通过；桌面 Rust 4 项通过；全部现有 JS 语法检查通过。
- 最终全量回归：16 个 Node 测试文件、CLI Rust 11 项、桌面 Rust 9 项全部通过。
- 质量门禁：共享端与扩展端全部 JS 语法检查、两个 Rust workspace 的 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 全部通过。
- CLI 实际调用：无 `--yes` 的 `call delete_note` 返回退出码 2 和标准 JSON 错误；`schema --json` 正确输出危险工具清单与确认规则。
- 桌面 release 构建：本轮修改后的 `npm run tauri -- build --no-bundle` 成功，生成 `desktop/src-tauri/target/release/marginote`。
- Windows 验证边界：新原子文件模块已使用 `x86_64-pc-windows-msvc` 目标单独编译通过；全项目交叉检查在第三方 `ring` 构建前置处因 Linux 主机没有 MSVC `lib.exe` 中止，因此仍需 Windows CI/实机生成并安装验证 `.exe`。

## 8. 下一阶段执行记录：可靠数据内核第一步

1. 主数据增加 `schemaVersion: 1`；无版本的旧数据兼容迁移，未来版本数据会触发原文保护并拒绝旧客户端覆盖。
2. 新增 `atomic_file.rs`：同目录唯一临时文件、`write_all`、`sync_all`、原子替换；Windows 使用 `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`。
3. `storage.rs` 的锁覆盖完整 read-modify-write；JSON 损坏或根结构异常时拒绝 set/remove，保留原文件。
4. `workdir.rs` 的文本和二进制写入复用原子替换；读取区分“不存在”和真实 I/O 错误；禁止 `..`、绝对路径和符号链接逃逸，扫描不跟随链接。
5. 前端工作目录操作串行化，写失败不再被平台层吞掉；设置页持续显示最近错误，损坏元数据会阻止覆盖。
6. 新增磁盘缺失项对账：仅对 `meta.json` 中已管理的路径生效，外部移动通过内容 ID 识别；删除前备份完整主数据，笔记软删除、待办移除，恢复同 ID 文件可撤销该软删除。
7. 本步结束时尚未完成 Repository/UnitOfWork、单项 change-set/跨文件回滚、实时文件 watcher 和冲突预览；其中 AI/CLI Repository 已在下方第 9 节继续实施。

## 9. 下一阶段执行记录：Repository / UnitOfWork

1. 新增 `repository-core.js`：串行事务队列、四类集合快照、实体级 diff、change-set、一次持久化和执行/提交失败回滚。
2. 内置 AI 的非破坏性同步写工具通过统一 Repository 执行；成功收据展示 `cs-...` 编号。会等待模型的 `translate_note` / `clean_text` 暂不持有事务，防止长请求期间误卷入用户并发编辑。
3. CLI 的创建/更新/追加/移动/标签/收藏等命令通过同一 Repository；复合 `note update` 在一个事务中调用多个底层工具，任一步失败恢复整个操作前快照。
4. 删除工具仍沿用 `--yes`、AI 确认和磁盘回收站流程，不使用仅集合快照回滚，避免磁盘文件已移动而内存反向恢复。
5. 主数据在事务中只提交一次；工作目录在事务结束后进入已有串行写队列，失败持续显示在设置页。这样不会在全量磁盘 I/O 或模型等待期间阻塞/吞掉普通用户编辑。
6. 最近 30 条提交/回滚摘要显示在“数据 · 备份”；IndexedDB 保存带实体前后值的完整记录，ZIP 导出为 `_change_sets.json`。
7. 尚未完成：普通 UI 写入口迁移、prepare→preview→commit、用户整轮撤销、工作目录多文件原子 change-set；CLI 幂等与 dry-run 已在第 10 节完成。

## 10. 后续执行记录：AI/Prompt/Skill/Provider 与 CLI 平台化

1. Prompt、Skill、Provider、工具策略和助手运行时纯逻辑均提取为共享核心；扩展副本由脚本生成，CI 阻止漂移。
2. Skill 改为声明式 Profile + 最小工具权限；创建、编辑、整理、完成、删除和批量动作不再共享宽泛写权限，已废弃别名不进入新 Prompt。
3. Provider 统一请求、Header、SSE、native tool call、重试边界、取消和 token 统计；桌面/扩展显示模型调用、检索结果、耗时和 token。
4. AI 快捷编辑支持选中文本；流式只更新草稿 UI，捕获启动目标，成功一次提交，失败恢复，切换笔记不会误写。
5. CLI 增加 `--dry-run`、`--request-id`、24 小时持久化幂等、180 秒服务超时、cursor 分页、单篇 Markdown 导出和受控批量工具；同一 requestId 复用为不同参数会拒绝。
6. CLI/AI 写入收据显示具体目标和 change-set；CLI 状态栏显示任务、排队、耗时、成功或失败。

## 11. 后续执行记录：产品细节、导入与工程门禁

1. 编辑/预览不再由双击触发；宽屏工具栏按真实可用宽度展开；编辑和全屏阅读缩放均修改真实排版，阅读区域使用约 88% 视口。
2. 笔记/待办空状态增加新建或清除筛选操作；主空页面可直接创建第一篇笔记；搜索输入增加 160ms debounce。
3. ZIP/Markdown/JSON 多文件导入以整批为事务边界；任一读取、解析或主保存失败会恢复原集合并清理新增图片。ZIP 增加压缩输入、文件数和解压体积上限，历史版本仅在主数据成功后提交。
4. Windows 提醒默认常驻，支持关闭、延后 1 小时和延后 1 天；延后状态写回待办并在重启后恢复。
5. 移除 Google Fonts 和对应 CSP 网络放行；两个入口只加载本地脚本与系统字体。
6. 根级统一 `check/test/verify`，CI 执行 JS 语法、核心副本一致性、Node/Rust 测试、Rust fmt/clippy 与 Windows 安装包构建。
