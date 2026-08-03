# Marginote CLI

Marginote 1.2.4 起，Windows 安装包自带 `marginote-cli.exe`。它适合日常终端操作，也为 Claude Code、Codex 等 code agent 提供稳定的笔记/待办接口。

## 开始使用

安装或升级 Marginote 后，打开一个**新的** PowerShell / CMD 窗口：

```powershell
marginote-cli status
marginote-cli --help
marginote-cli schema --json
```

安装器会把 CLI 所在目录加入当前用户的 `PATH`。如果旧终端暂时找不到命令，重开终端即可。CLI 会连接正在运行的 Marginote；软件未运行时会自动在后台启动，无需手动打开窗口。

`status --json` 会同时返回工作目录和可写状态。`writable:false` 表示 Marginote 为保护本地文件而暂停了写入，agent 应停止并把 `storageError` 告诉用户。

CLI 默认授权查找、读取以及新建、追加、修改等非删除写入，不需要逐次确认，也不要求先执行 `--dry-run`。删除仍需 `--yes`。`status --json` 的 `permissions` 字段可供 agent 直接识别这些能力。

### 全局参数

全局参数可以放在子命令前后：

| 参数 | 用途 |
|---|---|
| `--json` | 使用稳定的 JSON 信封输出；agent 调用时应始终启用 |
| `--no-start` | Marginote 未运行时不自动启动 |
| `--dry-run` | 只返回写入计划，不修改数据；普通写入不要求预演 |
| `--request-id <ID>` | 指定幂等请求 ID；不确定结果的重试必须复用同一 ID |

## 常用命令

### 笔记

```powershell
# 最近笔记 / 搜索
marginote-cli note list
marginote-cli note list --query "发布计划" --notebook 工作 --tag 项目

# 读取全文
marginote-cli note get <NOTE_ID>

# 创建：短正文、文件正文、管道正文三选一
marginote-cli note create "会议记录" --content "结论：按计划发布" --notebook 工作 --tag 会议
marginote-cli note create "调研" --content-file .\research.md --notebook 工作
Get-Content .\daily.md -Raw | marginote-cli note create "今日日志" --stdin

# 修改、追加、移动和收藏
marginote-cli note update <NOTE_ID> --title "新标题" --notebook 归档 --tag 已整理 --star
marginote-cli note update <NOTE_ID> --content "替换后的完整正文"
marginote-cli note update <NOTE_ID> --content-file .\replacement.md
Get-Content .\replacement.md -Raw | marginote-cli note update <NOTE_ID> --stdin
marginote-cli note update <NOTE_ID> --content "追加段落" --append
marginote-cli note update <NOTE_ID> --remove-tag 待整理 --unstar
marginote-cli note append <NOTE_ID> "补充：验收已完成"
marginote-cli note append <NOTE_ID> --content-file .\more.md
Get-Content .\more.md -Raw | marginote-cli note append <NOTE_ID> --stdin

# 导出完整 Markdown（含 front matter）；不指定文件时输出到 stdout
marginote-cli note export <NOTE_ID> --output .\note.md
marginote-cli note export <NOTE_ID> > .\note.md

# 删除会进入 Marginote 回收站；必须显式确认
marginote-cli note delete <NOTE_ID> --yes
```

`--content-file`（以及 `note append` 的 `--file`）由 CLI 直接读取，支持绝对路径和相对当前终端目录的路径，不限制在 Marginote 工作目录内，也不检查文件扩展名。只要当前用户对源文件具有操作系统读取权限，就可以直接同步到笔记中：

```powershell
marginote-cli note create "外部分析报告" --content-file "D:\projects\reports\analysis.md" --notebook 工作 --json
marginote-cli note append <NOTE_ID> --content-file "C:\Users\me\Desktop\追加内容.txt" --json
```

`note create`、`note update` 的 `--content`、`--content-file` 和 `--stdin` 三选一。`note append` 的位置参数正文、`--file/--content-file` 和 `--stdin` 同样三选一。`note update --content` 默认替换完整正文，加 `--append` 才会追加；`--tag` 可重复添加标签，`--remove-tag` 可重复移除标签。

列表默认保持简洁数组格式。需要可靠地遍历大量结果时使用 `--paged --json`，并把响应中的 `data.nextCursor` 原样传给下一次调用：

```powershell
marginote-cli note list --paged --limit 50 --json
marginote-cli note list --paged --limit 50 --cursor "mn1:50" --json
marginote-cli todo list --status all --paged --limit 50 --json
```

游标是不透明、带版本的值，不应由 agent 自行计算。单次搜索目前最多扫描 200 条匹配记录；结果超过该窗口时应缩小搜索词、笔记本或标签范围。

### 待办

```powershell
marginote-cli todo list --status active
marginote-cli todo list --status overdue
marginote-cli todo list --query "周报" --due week
marginote-cli todo get <TODO_ID>

marginote-cli todo create "提交周报" --content "包含本周项目进度" --due "2026-08-03T09:00:00+08:00" --remind-before 30
marginote-cli todo create "处理分析清单" --content-file "D:\projects\reports\tasks.md"
Get-Content .\tasks.md -Raw | marginote-cli todo create "处理分析清单" --stdin

marginote-cli todo update <TODO_ID> --text "提交最终周报" --due "2026-08-03T10:00:00+08:00"
marginote-cli todo update <TODO_ID> --content-file .\todo-detail.md
marginote-cli todo update <TODO_ID> --due ""
marginote-cli todo complete <TODO_ID>
marginote-cli todo complete <TODO_ID> --undo
marginote-cli todo delete <TODO_ID> --yes
```

`todo list --status` 支持 `active`、`done`、`overdue`、`all`，`--due` 支持 `today`、`week`、`overdue`。截止时间建议使用带时区的 ISO 8601 格式，避免 agent 与本机时区理解不一致；`todo update --due ""` 可清除截止时间。

创建或修改待办时可配置提醒：

| 参数 | 含义 | 创建时默认值 |
|---|---|---:|
| `--remind-before <分钟>` | 在截止时间前多少分钟开始提醒 | `0` |
| `--remind-count <次数>` | 提醒总次数 | `1` |
| `--remind-interval <分钟>` | 多次提醒之间的间隔 | `5` |

`todo create/update` 的 `--content`、`--content-file` 和 `--stdin` 三选一。待办删除是不可自动推断的破坏性操作，必须在用户明确要求时添加 `--yes`。

### 笔记本与统一搜索

```powershell
marginote-cli notebook list
marginote-cli notebook create "新项目" --color "#0d9488"
marginote-cli notebook rename "新项目" "项目 A"
marginote-cli notebook rename "项目 A" "项目归档" --color "#64748b"
marginote-cli notebook delete "项目归档" --yes
marginote-cli search "验收结果"
```

`notebook rename/delete` 接受笔记本 ID 或精确名称。删除必须传 `--yes`；正式执行前可使用全局 `--dry-run` 查看计划。

## 给 code agent 使用

所有命令都支持全局 `--json`，成功和失败使用固定信封：

```json
{"ok":true,"requestId":"mn-...","data":{"id":"..."}}
```

```json
{"ok":false,"requestId":"mn-...","error":"错误说明"}
```

agent 可先运行 `marginote-cli schema --json` 自发现能力。高级场景可直接调用白名单工具：

```powershell
marginote-cli call create_note --args '{"title":"来自 agent","content":"已完成接口联调","notebookName":"工作","tags":["agent"]}' --json
```

如果要把完整规则直接交给 Claude Code/Codex，无需复制本文，运行：

```powershell
marginote-cli instructions
```

该命令完全离线，不要求 Marginote 已启动；`--json` 会把说明放在 `data.text` 中。

`call` 同样遵守删除保护；调用 `delete_note`、`delete_todo`、`delete_notebook` 等删除工具时必须额外传入 `--yes`，否则退出码为 `2`，不会向 Marginote 发出请求。

批处理也通过白名单 `call` 提供，适合 agent 在一次事务中整理多条记录：

```powershell
marginote-cli call batch_update_notes --args '{"noteIds":["n1","n2"],"addTags":["已整理"]}' --json
marginote-cli call batch_move_notes --args '{"noteIds":["n1","n2"],"notebookName":"归档"}' --json
marginote-cli call batch_complete_todos --args '{"todoIds":["t1","t2"]}' --json
marginote-cli call batch_delete_notes --args '{"noteIds":["n1","n2"]}' --yes --json
```

批量删除与单条删除一样必须显式 `--yes`。批量非删除写入由统一事务提交，中途异常会整体回滚。

当前 `call` 白名单按用途如下；具体参数以 `marginote-cli schema --json` 和对应版本的 `--help` 为准：

| 类别 | 工具 |
|---|---|
| 查询与读取 | `status`、`search_all`、`search_notes`、`search_todos`、`list_notes`、`list_todos`、`list_notebooks`、`list_tags`、`get_note`、`get_todo`、`note_stats`、`word_count`、`export_note` |
| 笔记写入 | `create_note`、`update_note_cli`、`append_to_note`、`move_note`、`add_tags`、`remove_tags`、`star_note`、`batch_move_notes`、`batch_update_notes` |
| 待办写入 | `create_todo`、`update_todo`、`complete_todo`、`batch_complete_todos` |
| 笔记本写入 | `create_notebook`、`rename_notebook`、`rename_notebook_cli` |
| 删除 | `delete_note`、`delete_todo`、`delete_notebook`、`delete_notebook_cli`、`batch_delete_notes`、`batch_delete_todos` |

`update_note_cli`、`rename_notebook_cli` 和 `delete_notebook_cli` 是 CLI 组合能力，适合通过 `call` 使用；未知工具会在连接 Marginote 前被拒绝。所有删除类工具都需要 `--yes`。

### 安全预演与幂等重试

所有写命令支持全局 `--dry-run`。它只返回将执行的命令、参数、读写等级和事务方式，不修改数据；预演删除时不需要 `--yes`：

```powershell
marginote-cli note create "发布记录" --content "准备发布" --dry-run --json
marginote-cli note delete <NOTE_ID> --dry-run --json
```

自动化写入建议设置稳定的 `--request-id`。同一操作因网络或超时重试时复用同一个 ID，Marginote 会在 24 小时内直接返回首次成功结果，不会重复创建；同一 ID 若对应不同命令或参数会被拒绝：

```powershell
marginote-cli note create "发布记录" --content "1.2.4" --request-id "agent:release-1.2.4" --json
```

未指定时 CLI 会自动生成唯一 ID，并在 JSON 信封的 `requestId` 字段返回。Agent 应记录该字段用于不确定结果的安全重试。

也可以把下面这段简版规则加入项目的 `CLAUDE.md` / agent 指令：

```text
当我要求记录、查找或更新个人笔记和待办时，使用 marginote-cli。
Marginote CLI 已默认授权查找、读取和非删除写入，无需逐次询问或先 dry-run；所有自动化调用加 --json。
先运行 marginote-cli status --json 查看连接与存储状态；正式写入设置 --request-id，重试同一操作时复用它。
--content-file 可直接读取任意本机可读的绝对或相对路径，不限于 Marginote 工作目录；不要因当前工作目录不同而拒绝同步。
记录前先搜索相关笔记：高度相关则 append/update，否则 create；修改前必须找到准确 ID。
删除只在我明确要求时使用 --yes。
不要直接读写 Marginote 的 WebView2 数据文件。
```

## 同步与安全

- CLI 的操作在 Marginote WebView 内执行，与内置 AI 助手复用同一组工具和同一份实时数据。
- CLI 写入后，应用界面立即可见，并通过统一事务直接落到 Markdown 工作目录；待办提醒也会重新调度。
- 创建、修改、追加、移动、标签和收藏等非破坏性写入经过统一 UnitOfWork。`note update` 即使组合了正文、追加、移动、标签和收藏，也只提交一次；中途任一步失败会整体回滚。
- WebView 会按 `requestId + 命令参数指纹` 缓存最近 100 个成功写入结果（最长 24 小时）；缓存会先落本地再回复 CLI，因此即使客户端在响应前断开，安全重试也不会重复写入。
- 每次成功事务会在 Marginote“数据 · 备份 → 最近 AI / CLI 变更”中留下 `cs-...` 编号和字段摘要，完整记录会随 ZIP 导出。移动到磁盘回收站的删除仍使用独立确认与回收站语义。
- 本机桥只监听 `127.0.0.1`，每次应用启动生成 256-bit 随机令牌。端口与令牌文件只放在当前用户的应用数据目录。
- CLI 不直接修改 WebView2 LevelDB，避免多进程并发造成数据损坏。

## 退出码与排障

| 退出码 | 含义 |
|---:|---|
| `0` | 成功 |
| `2` | 参数或输入内容错误 |
| `3` | 无法启动/连接 Marginote |
| `4` | Marginote 拒绝操作或业务校验失败 |

如果 CLI 无法自动找到主程序，可临时设置 `MARGINOTE_APP` 为 `Marginote.exe` 的完整路径。调试隔离环境时可用 `MARGINOTE_DATA_DIR` 指定端点目录；日常使用无需设置。

遇到写入失败时先运行：

```powershell
marginote-cli status --json
```

- `data.writable: true`：CLI 已具备普通写入权限，继续根据返回的业务错误排查参数或目标 ID。
- `data.writable: false`：Marginote 因真实的本地存储错误进入保护状态；查看 `data.storageError`，不要通过直接修改 WebView2 数据绕过。
- 源文件不在 Marginote 工作目录不是错误；`--content-file` 只受当前 Windows 用户的操作系统文件读取权限约束。
