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
marginote-cli note append <NOTE_ID> "补充：验收已完成"

# 删除会进入 Marginote 回收站；必须显式确认
marginote-cli note delete <NOTE_ID> --yes
```

### 待办

```powershell
marginote-cli todo list --status active
marginote-cli todo list --status overdue
marginote-cli todo create "提交周报" --due "2026-08-03T09:00:00+08:00" --remind-before 30
marginote-cli todo update <TODO_ID> --text "提交最终周报" --due "2026-08-03T10:00:00+08:00"
marginote-cli todo complete <TODO_ID>
marginote-cli todo complete <TODO_ID> --undo
marginote-cli todo delete <TODO_ID> --yes
```

截止时间建议使用带时区的 ISO 8601 格式，避免 agent 与本机时区理解不一致。

### 笔记本与统一搜索

```powershell
marginote-cli notebook list
marginote-cli notebook create "新项目" --color "#0d9488"
marginote-cli notebook rename "新项目" "项目 A"
marginote-cli search "验收结果"
```

## 给 code agent 使用

所有命令都支持全局 `--json`，成功和失败使用固定信封：

```json
{"ok":true,"data":{"id":"..."}}
```

```json
{"ok":false,"error":"错误说明"}
```

agent 可先运行 `marginote-cli schema --json` 自发现能力。高级场景可直接调用白名单工具：

```powershell
marginote-cli call create_note --args '{"title":"来自 agent","content":"已完成接口联调","notebookName":"工作","tags":["agent"]}' --json
```

可以把下面这段加入项目的 `CLAUDE.md` / agent 指令：

```text
当我要求记录、查找或更新个人笔记和待办时，使用 marginote-cli。
先运行 marginote-cli schema --json 了解能力，所有自动化调用加 --json。
修改前用 note list/search 或 todo list 找到准确 ID；删除只在我明确要求时使用 --yes。
不要直接读写 Marginote 的 WebView2 数据文件。
```

## 同步与安全

- CLI 的操作在 Marginote WebView 内执行，与内置 AI 助手复用同一组工具和同一份实时数据。
- CLI 写入后，应用界面立即可见；已配置工作目录时会继续走原有的 Markdown 双向写回；待办提醒也会重新调度。
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
