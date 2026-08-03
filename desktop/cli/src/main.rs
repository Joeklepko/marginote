use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod integration;
mod mcp;

use integration::{AgentClient, InstallableAgentClient};

// Must match tauri.conf.json's identifier so both processes find the endpoint.
const APP_ID: &str = "com.marginote.app";
const ENDPOINT_FILE: &str = "cli-endpoint.json";
const CONNECT_RETRIES: usize = 80;

#[derive(Clone, Copy)]
struct CliCallPolicy {
    name: &'static str,
    destructive: bool,
}

// 与 shared/js/tool-policy-core.js 的 cliCallNames 保持一致；Node 回归测试会跨语言校验。
// schema、raw call 白名单和删除确认均从此表派生，避免三份手写列表互相漂移。
const CLI_CALL_POLICIES: &[CliCallPolicy] = &[
    CliCallPolicy {
        name: "list_notebooks",
        destructive: false,
    },
    CliCallPolicy {
        name: "search_notes",
        destructive: false,
    },
    CliCallPolicy {
        name: "search_todos",
        destructive: false,
    },
    CliCallPolicy {
        name: "create_note",
        destructive: false,
    },
    CliCallPolicy {
        name: "create_todo",
        destructive: false,
    },
    CliCallPolicy {
        name: "batch_move_notes",
        destructive: false,
    },
    CliCallPolicy {
        name: "batch_update_notes",
        destructive: false,
    },
    CliCallPolicy {
        name: "batch_complete_todos",
        destructive: false,
    },
    CliCallPolicy {
        name: "batch_delete_notes",
        destructive: true,
    },
    CliCallPolicy {
        name: "batch_delete_todos",
        destructive: true,
    },
    CliCallPolicy {
        name: "update_todo",
        destructive: false,
    },
    CliCallPolicy {
        name: "create_notebook",
        destructive: false,
    },
    CliCallPolicy {
        name: "rename_notebook",
        destructive: false,
    },
    CliCallPolicy {
        name: "delete_notebook",
        destructive: true,
    },
    CliCallPolicy {
        name: "move_note",
        destructive: false,
    },
    CliCallPolicy {
        name: "delete_note",
        destructive: true,
    },
    CliCallPolicy {
        name: "get_note",
        destructive: false,
    },
    CliCallPolicy {
        name: "get_todo",
        destructive: false,
    },
    CliCallPolicy {
        name: "add_tags",
        destructive: false,
    },
    CliCallPolicy {
        name: "remove_tags",
        destructive: false,
    },
    CliCallPolicy {
        name: "list_tags",
        destructive: false,
    },
    CliCallPolicy {
        name: "note_stats",
        destructive: false,
    },
    CliCallPolicy {
        name: "list_todos",
        destructive: false,
    },
    CliCallPolicy {
        name: "complete_todo",
        destructive: false,
    },
    CliCallPolicy {
        name: "delete_todo",
        destructive: true,
    },
    CliCallPolicy {
        name: "append_to_note",
        destructive: false,
    },
    CliCallPolicy {
        name: "star_note",
        destructive: false,
    },
    CliCallPolicy {
        name: "word_count",
        destructive: false,
    },
    CliCallPolicy {
        name: "export_note",
        destructive: false,
    },
    CliCallPolicy {
        name: "status",
        destructive: false,
    },
    CliCallPolicy {
        name: "search_all",
        destructive: false,
    },
    CliCallPolicy {
        name: "list_notes",
        destructive: false,
    },
    CliCallPolicy {
        name: "update_note_cli",
        destructive: false,
    },
    CliCallPolicy {
        name: "rename_notebook_cli",
        destructive: false,
    },
    CliCallPolicy {
        name: "delete_notebook_cli",
        destructive: true,
    },
];

#[derive(Parser, Debug)]
#[command(
    name = "marginote-cli",
    version,
    about = "从终端和 AI agent 访问 Marginote 笔记与待办",
    long_about = None,
    after_help = "示例:\n  marginote-cli note create \"会议记录\" --stdin --notebook 工作\n  marginote-cli note list --query 项目 --json\n  marginote-cli todo create \"明天提交周报\" --due 2026-08-02T09:00:00+08:00\n  marginote-cli todo complete <ID>"
)]
struct Cli {
    /// 输出稳定的 JSON 信封，适合 CodeAgent、Claude Code 等 agent 解析
    #[arg(long, global = true)]
    json: bool,

    /// Marginote 未运行时不自动启动
    #[arg(long, global = true)]
    no_start: bool,

    /// 仅返回写入计划，不修改任何数据
    #[arg(long, global = true)]
    dry_run: bool,

    /// 幂等请求 ID；重试同一写操作时复用该值，避免重复创建
    #[arg(long, global = true)]
    request_id: Option<String>,

    #[command(subcommand)]
    command: TopCommand,
}

#[derive(Subcommand, Debug)]
enum TopCommand {
    /// 检查桌面应用和 CLI 桥状态
    Status,
    /// 同时搜索笔记和待办
    Search(SearchArgs),
    /// 管理笔记
    Note {
        #[command(subcommand)]
        command: NoteCommand,
    },
    /// 管理待办
    Todo {
        #[command(subcommand)]
        command: TodoCommand,
    },
    /// 管理笔记本
    Notebook {
        #[command(subcommand)]
        command: NotebookCommand,
    },
    /// 直接调用受支持的工具；用于高级 agent 集成
    Call(CallArgs),
    /// 输出机器可读的命令能力说明，不需要启动 Marginote
    Schema,
    /// 输出可直接粘贴给 CodeAgent/Claude Code/Codex 的使用说明
    Instructions,
    /// 以标准输入输出运行本地 MCP Server
    Mcp(McpArgs),
    /// 诊断主程序、CLI 桥、工作目录和 MCP 能力
    Doctor(DoctorArgs),
    /// 配置 CodeAgent、Codex、Claude Code 或其他 MCP 客户端
    Integrate {
        #[command(subcommand)]
        command: IntegrateCommand,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum McpProfile {
    /// 默认核心工具集，减少模型上下文占用和工具选择歧义
    Core,
    /// 完整细粒度工具集，适合笔记本管理和高级自动化
    Full,
}

#[derive(Args, Debug)]
struct McpArgs {
    /// MCP 工具集；默认 core，兼容旧的 `marginote-cli mcp` 配置
    #[arg(long, value_enum, default_value_t = McpProfile::Core)]
    profile: McpProfile,
}

#[derive(Args, Debug)]
struct DoctorArgs {
    /// CodeAgent 配置根目录；不指定时读取环境变量或检测已存在的当前用户 .cac
    #[arg(long, value_name = "PATH")]
    codeagent_dir: Option<PathBuf>,
}

#[derive(Subcommand, Debug)]
enum IntegrateCommand {
    /// 检查本机 Agent 命令和现有 Marginote 配置
    Status {
        /// CodeAgent 配置根目录；不指定时读取环境变量或检测已存在的当前用户 .cac
        #[arg(long, value_name = "PATH")]
        codeagent_dir: Option<PathBuf>,
    },
    /// 输出指定客户端的安装命令与配置片段
    Show {
        #[arg(value_enum)]
        client: AgentClient,
    },
    /// 安装用户级 Marginote MCP 集成；CodeAgent 使用 .cac 本地插件
    Install {
        #[arg(value_enum)]
        client: InstallableAgentClient,
        /// CodeAgent 配置根目录（包含 settings.json 或 plugins 目录）
        #[arg(long, value_name = "PATH")]
        codeagent_dir: Option<PathBuf>,
    },
    /// 移除用户级 Marginote MCP 集成；不删除 Marginote 数据
    Remove {
        #[arg(value_enum)]
        client: InstallableAgentClient,
        /// CodeAgent 配置根目录（包含 settings.json 或 plugins 目录）
        #[arg(long, value_name = "PATH")]
        codeagent_dir: Option<PathBuf>,
    },
}

#[derive(Args, Debug)]
struct SearchArgs {
    /// 搜索词
    query: String,
    /// 每类最多返回多少项
    #[arg(long, default_value_t = 20)]
    limit: usize,
}

#[derive(Subcommand, Debug)]
enum NoteCommand {
    /// 列出或搜索笔记
    List(NoteListArgs),
    /// 获取一篇笔记的完整内容
    Get(IdArgs),
    /// 创建笔记
    Create(NoteCreateArgs),
    /// 修改笔记
    Update(NoteUpdateArgs),
    /// 追加正文
    Append(NoteAppendArgs),
    /// 将笔记移入回收站
    Delete(DeleteArgs),
    /// 导出完整 Markdown；默认写到标准输出
    Export(NoteExportArgs),
}

#[derive(Args, Debug)]
struct NoteListArgs {
    #[arg(long, default_value = "")]
    query: String,
    #[arg(long)]
    notebook: Option<String>,
    #[arg(long = "tag")]
    tags: Vec<String>,
    #[arg(long)]
    starred: bool,
    #[arg(long, default_value_t = 20)]
    limit: usize,
    /// 返回带 nextCursor 的分页信封
    #[arg(long)]
    paged: bool,
    /// 上一页返回的游标；需同时使用 --paged
    #[arg(long, requires = "paged")]
    cursor: Option<String>,
}

#[derive(Args, Debug)]
struct IdArgs {
    /// 笔记或待办 ID
    id: String,
}

#[derive(Args, Debug)]
struct NoteCreateArgs {
    /// 笔记标题
    title: String,
    /// 直接指定正文
    #[arg(long)]
    content: Option<String>,
    /// 从任意本机可读的 UTF-8 文件读取正文（不限于 Marginote 工作目录）
    /// 文件可以使用绝对路径或相对当前终端目录的路径，不限于 Marginote 工作目录
    #[arg(long = "content-file")]
    content_file: Option<PathBuf>,
    /// 从标准输入读取正文
    #[arg(long)]
    stdin: bool,
    /// 目标笔记本名称；不存在时自动创建
    #[arg(long)]
    notebook: Option<String>,
    /// 标签，可重复指定
    #[arg(long = "tag")]
    tags: Vec<String>,
    /// 创建后收藏
    #[arg(long)]
    starred: bool,
}

#[derive(Args, Debug)]
struct NoteUpdateArgs {
    id: String,
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    content: Option<String>,
    /// 文件可以使用绝对路径或相对当前终端目录的路径，不限于 Marginote 工作目录
    #[arg(long = "content-file")]
    content_file: Option<PathBuf>,
    #[arg(long)]
    stdin: bool,
    /// 将给定正文追加到末尾，而不是替换
    #[arg(long)]
    append: bool,
    #[arg(long)]
    notebook: Option<String>,
    #[arg(long = "tag")]
    add_tags: Vec<String>,
    #[arg(long = "remove-tag")]
    remove_tags: Vec<String>,
    #[arg(long, conflicts_with = "unstar")]
    star: bool,
    #[arg(long, conflicts_with = "star")]
    unstar: bool,
}

#[derive(Args, Debug)]
struct NoteAppendArgs {
    id: String,
    /// 要追加的正文；也可用 --file 或 --stdin
    text: Option<String>,
    /// 从任意本机可读的 UTF-8 文件读取追加内容；--content-file 为同义名
    /// 文件可以使用绝对路径或相对当前终端目录的路径，不限于 Marginote 工作目录
    #[arg(long, visible_alias = "content-file")]
    file: Option<PathBuf>,
    #[arg(long)]
    stdin: bool,
}

#[derive(Args, Debug)]
struct DeleteArgs {
    id: String,
    /// 确认执行删除
    #[arg(long)]
    yes: bool,
}

#[derive(Args, Debug)]
struct NoteExportArgs {
    id: String,
    /// 写入 UTF-8 Markdown 文件，而不是标准输出
    #[arg(short, long)]
    output: Option<PathBuf>,
    /// 允许覆盖已存在的输出文件
    #[arg(long, requires = "output")]
    force: bool,
}

#[derive(Subcommand, Debug)]
enum TodoCommand {
    /// 列出或搜索待办
    List(TodoListArgs),
    /// 获取待办详情
    Get(IdArgs),
    /// 创建待办
    Create(TodoCreateArgs),
    /// 修改待办
    Update(TodoUpdateArgs),
    /// 完成待办；--undo 可恢复为未完成
    Complete(TodoCompleteArgs),
    /// 删除待办
    Delete(DeleteArgs),
}

#[derive(Args, Debug)]
struct TodoListArgs {
    #[arg(long, default_value = "")]
    query: String,
    /// active、done、overdue 或 all
    #[arg(long, default_value = "all")]
    status: String,
    /// today、week 或 overdue
    #[arg(long)]
    due: Option<String>,
    #[arg(long, default_value_t = 50)]
    limit: usize,
    /// 返回带 nextCursor 的分页信封
    #[arg(long)]
    paged: bool,
    /// 上一页返回的游标；需同时使用 --paged
    #[arg(long, requires = "paged")]
    cursor: Option<String>,
}

#[derive(Args, Debug)]
struct TodoCreateArgs {
    /// 待办标题
    text: String,
    #[arg(long)]
    content: Option<String>,
    /// 文件可以使用绝对路径或相对当前终端目录的路径，不限于 Marginote 工作目录
    #[arg(long = "content-file")]
    content_file: Option<PathBuf>,
    #[arg(long)]
    stdin: bool,
    /// ISO 8601 时间，如 2026-08-02T09:00:00+08:00
    #[arg(long)]
    due: Option<String>,
    #[arg(long = "remind-before", default_value_t = 0)]
    remind_before: i64,
    #[arg(long = "remind-count", default_value_t = 1)]
    remind_count: i64,
    #[arg(long = "remind-interval", default_value_t = 5)]
    remind_interval: i64,
}

#[derive(Args, Debug)]
struct TodoUpdateArgs {
    id: String,
    #[arg(long)]
    text: Option<String>,
    #[arg(long)]
    content: Option<String>,
    /// 文件可以使用绝对路径或相对当前终端目录的路径，不限于 Marginote 工作目录
    #[arg(long = "content-file")]
    content_file: Option<PathBuf>,
    #[arg(long)]
    stdin: bool,
    /// ISO 8601 时间；空字符串可清除截止时间
    #[arg(long)]
    due: Option<String>,
    #[arg(long = "remind-before")]
    remind_before: Option<i64>,
    #[arg(long = "remind-count")]
    remind_count: Option<i64>,
    #[arg(long = "remind-interval")]
    remind_interval: Option<i64>,
}

#[derive(Args, Debug)]
struct TodoCompleteArgs {
    id: String,
    #[arg(long)]
    undo: bool,
}

#[derive(Subcommand, Debug)]
enum NotebookCommand {
    List,
    Create(NotebookCreateArgs),
    Rename(NotebookRenameArgs),
    Delete(NotebookDeleteArgs),
}

#[derive(Args, Debug)]
struct NotebookCreateArgs {
    name: String,
    #[arg(long)]
    color: Option<String>,
}

#[derive(Args, Debug)]
struct NotebookRenameArgs {
    /// 笔记本 ID 或精确名称
    notebook: String,
    new_name: String,
    #[arg(long)]
    color: Option<String>,
}

#[derive(Args, Debug)]
struct NotebookDeleteArgs {
    /// 笔记本 ID 或精确名称
    notebook: String,
    #[arg(long)]
    yes: bool,
}

#[derive(Args, Debug)]
struct CallArgs {
    /// 工具名，可用 schema 查看白名单
    tool: String,
    /// JSON 对象参数
    #[arg(long, default_value = "{}")]
    args: String,
    /// 确认调用删除类工具
    #[arg(long)]
    yes: bool,
}

#[derive(Debug, Deserialize)]
struct EndpointInfo {
    protocol: u8,
    port: u16,
    token: String,
    #[allow(dead_code)]
    pid: u32,
    #[allow(dead_code)]
    version: String,
}

#[derive(Debug, Serialize)]
struct WireRequest<'a> {
    token: &'a str,
    #[serde(rename = "requestId")]
    request_id: &'a str,
    command: &'a str,
    args: &'a Value,
}

#[derive(Debug, Deserialize, Serialize)]
struct WireResponse {
    ok: bool,
    #[serde(default, rename = "requestId")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn fail(message: impl AsRef<str>, code: i32, json_output: bool, request_id: Option<&str>) -> ! {
    if json_output {
        println!(
            "{}",
            json!({ "ok": false, "requestId": request_id, "error": message.as_ref() })
        );
    } else {
        eprintln!("错误：{}", message.as_ref());
    }
    std::process::exit(code);
}

fn read_content(
    inline: &Option<String>,
    file: &Option<PathBuf>,
    from_stdin: bool,
) -> Result<Option<String>, String> {
    let selected =
        usize::from(inline.is_some()) + usize::from(file.is_some()) + usize::from(from_stdin);
    if selected > 1 {
        return Err("--content、--content-file/--file 和 --stdin 只能选一个".into());
    }
    if let Some(value) = inline {
        return Ok(Some(value.clone()));
    }
    if let Some(path) = file {
        return fs::read_to_string(path)
            .map(Some)
            .map_err(|error| format!("读取 {} 失败：{error}", path.display()));
    }
    if from_stdin {
        let mut value = String::new();
        io::stdin()
            .read_to_string(&mut value)
            .map_err(|error| format!("读取标准输入失败：{error}"))?;
        return Ok(Some(value));
    }
    Ok(None)
}

fn insert_if_some(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value);
    }
}

fn cli_call_policy(tool: &str) -> Option<CliCallPolicy> {
    CLI_CALL_POLICIES
        .iter()
        .copied()
        .find(|policy| policy.name == tool)
}

fn confirmed_args(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.insert("_confirmed".into(), Value::Bool(true));
    }
    value
}

fn request_for(
    command: &TopCommand,
    dry_run: bool,
) -> Result<(String, Value, &'static str), String> {
    match command {
        TopCommand::Status => Ok(("status".into(), json!({}), "status")),
        TopCommand::Search(args) => Ok((
            "search_all".into(),
            json!({ "query": args.query, "limit": args.limit }),
            "search",
        )),
        TopCommand::Schema
        | TopCommand::Instructions
        | TopCommand::Mcp(_)
        | TopCommand::Doctor(_)
        | TopCommand::Integrate { .. } => unreachable!("local command"),
        TopCommand::Call(args) => {
            let policy = cli_call_policy(&args.tool)
                .ok_or_else(|| format!("CLI 工具不在白名单中：{}", args.tool))?;
            let mut value: Value = serde_json::from_str(&args.args)
                .map_err(|error| format!("--args 不是有效 JSON：{error}"))?;
            if !value.is_object() {
                return Err("--args 必须是 JSON 对象".into());
            }
            if policy.destructive {
                if !args.yes && !dry_run {
                    return Err("调用删除类工具需要显式传入 --yes".into());
                }
                value = confirmed_args(value);
            }
            Ok((args.tool.clone(), value, "call"))
        }
        TopCommand::Note { command } => match command {
            NoteCommand::List(args) => Ok((
                "list_notes".into(),
                json!({
                    "query": args.query,
                    "notebookName": args.notebook,
                    "tags": args.tags,
                    "starred": args.starred,
                    "limit": args.limit,
                    "paged": args.paged,
                    "cursor": args.cursor
                }),
                "note-list",
            )),
            NoteCommand::Get(args) => Ok(("get_note".into(), json!({ "id": args.id }), "note-get")),
            NoteCommand::Create(args) => {
                let content = read_content(&args.content, &args.content_file, args.stdin)?
                    .unwrap_or_default();
                Ok((
                    "create_note".into(),
                    json!({
                        "title": args.title,
                        "content": content,
                        "notebookName": args.notebook,
                        "tags": args.tags,
                        "starred": args.starred
                    }),
                    "note-write",
                ))
            }
            NoteCommand::Update(args) => {
                let content = read_content(&args.content, &args.content_file, args.stdin)?;
                if args.title.is_none()
                    && content.is_none()
                    && args.notebook.is_none()
                    && args.add_tags.is_empty()
                    && args.remove_tags.is_empty()
                    && !args.star
                    && !args.unstar
                {
                    return Err("没有指定任何修改内容".into());
                }
                let mut map = Map::new();
                map.insert("id".into(), json!(args.id));
                insert_if_some(&mut map, "title", args.title.clone().map(Value::String));
                insert_if_some(&mut map, "content", content.map(Value::String));
                insert_if_some(
                    &mut map,
                    "notebookName",
                    args.notebook.clone().map(Value::String),
                );
                if args.append {
                    map.insert("append".into(), Value::Bool(true));
                }
                if !args.add_tags.is_empty() {
                    map.insert("addTags".into(), json!(args.add_tags));
                }
                if !args.remove_tags.is_empty() {
                    map.insert("removeTags".into(), json!(args.remove_tags));
                }
                if args.star || args.unstar {
                    map.insert("starred".into(), Value::Bool(args.star));
                }
                Ok(("update_note_cli".into(), Value::Object(map), "note-write"))
            }
            NoteCommand::Append(args) => {
                let content = read_content(&args.text, &args.file, args.stdin)?
                    .ok_or_else(|| "请提供追加文本，或使用 --file/--stdin".to_string())?;
                Ok((
                    "append_to_note".into(),
                    json!({ "noteId": args.id, "text": content }),
                    "note-write",
                ))
            }
            NoteCommand::Delete(args) => {
                if !args.yes && !dry_run {
                    return Err("删除需要显式传入 --yes".into());
                }
                Ok((
                    "delete_note".into(),
                    confirmed_args(json!({ "id": args.id })),
                    "note-write",
                ))
            }
            NoteCommand::Export(args) => Ok((
                "export_note".into(),
                json!({ "noteId": args.id }),
                "note-export",
            )),
        },
        TopCommand::Todo { command } => match command {
            TodoCommand::List(args) => Ok((
                "search_todos".into(),
                json!({ "query": args.query, "status": args.status, "due": args.due, "limit": args.limit, "paged": args.paged, "cursor": args.cursor }),
                "todo-list",
            )),
            TodoCommand::Get(args) => Ok(("get_todo".into(), json!({ "id": args.id }), "todo-get")),
            TodoCommand::Create(args) => {
                let content = read_content(&args.content, &args.content_file, args.stdin)?
                    .unwrap_or_default();
                Ok((
                    "create_todo".into(),
                    json!({
                        "text": args.text,
                        "content": content,
                        "dueAt": args.due,
                        "remindBeforeMin": args.remind_before,
                        "remindCount": args.remind_count,
                        "remindIntervalMin": args.remind_interval
                    }),
                    "todo-write",
                ))
            }
            TodoCommand::Update(args) => {
                let content = read_content(&args.content, &args.content_file, args.stdin)?;
                if args.text.is_none()
                    && content.is_none()
                    && args.due.is_none()
                    && args.remind_before.is_none()
                    && args.remind_count.is_none()
                    && args.remind_interval.is_none()
                {
                    return Err("没有指定任何修改内容".into());
                }
                let mut map = Map::new();
                map.insert("id".into(), json!(args.id));
                insert_if_some(&mut map, "text", args.text.clone().map(Value::String));
                insert_if_some(&mut map, "content", content.map(Value::String));
                insert_if_some(&mut map, "dueAt", args.due.clone().map(Value::String));
                insert_if_some(
                    &mut map,
                    "remindBeforeMin",
                    args.remind_before.map(|v| json!(v)),
                );
                insert_if_some(&mut map, "remindCount", args.remind_count.map(|v| json!(v)));
                insert_if_some(
                    &mut map,
                    "remindIntervalMin",
                    args.remind_interval.map(|v| json!(v)),
                );
                Ok(("update_todo".into(), Value::Object(map), "todo-write"))
            }
            TodoCommand::Complete(args) => Ok((
                "update_todo".into(),
                json!({ "id": args.id, "done": !args.undo }),
                "todo-write",
            )),
            TodoCommand::Delete(args) => {
                if !args.yes && !dry_run {
                    return Err("删除需要显式传入 --yes".into());
                }
                Ok((
                    "delete_todo".into(),
                    confirmed_args(json!({ "id": args.id })),
                    "todo-write",
                ))
            }
        },
        TopCommand::Notebook { command } => match command {
            NotebookCommand::List => Ok(("list_notebooks".into(), json!({}), "notebook-list")),
            NotebookCommand::Create(args) => Ok((
                "create_notebook".into(),
                json!({ "name": args.name, "color": args.color }),
                "notebook-write",
            )),
            NotebookCommand::Rename(args) => Ok((
                "rename_notebook_cli".into(),
                json!({
                    "notebookRef": args.notebook,
                    "newName": args.new_name,
                    "newColor": args.color
                }),
                "notebook-write",
            )),
            NotebookCommand::Delete(args) => {
                if !args.yes && !dry_run {
                    return Err("删除需要显式传入 --yes".into());
                }
                Ok((
                    "delete_notebook_cli".into(),
                    confirmed_args(json!({ "notebookRef": args.notebook })),
                    "notebook-write",
                ))
            }
        },
    }
}

fn schema() -> Value {
    let call_tools: Vec<&str> = CLI_CALL_POLICIES.iter().map(|policy| policy.name).collect();
    let destructive_tools: Vec<&str> = CLI_CALL_POLICIES
        .iter()
        .filter(|policy| policy.destructive)
        .map(|policy| policy.name)
        .collect();
    json!({
        "name": "marginote-cli",
        "version": env!("CARGO_PKG_VERSION"),
        "jsonEnvelope": {
            "success": { "ok": true, "requestId": "mn-...", "data": {} },
            "failure": { "ok": false, "requestId": "mn-...", "error": "message" }
        },
        "commands": [
            "status", "search <query>",
            "instructions", "mcp [--profile core|full]", "doctor",
            "integrate status|show <codeagent|codex|claude|generic>|install|remove <codeagent|codex|claude>",
            "note list [--paged --cursor <cursor>]|get|create|update|append|delete|export",
            "todo list [--paged --cursor <cursor>]|get|create|update|complete|delete",
            "notebook list|create|rename|delete",
            "call <tool> --args <json>"
        ],
        "statusFields": {
            "writable": "false 时禁止继续写入，应向用户报告 storageError",
            "storageMode": "workdir | blocked | unknown",
            "storageError": "最近一次本地文件库错误"
        },
        "defaultPermissions": {
            "search": true,
            "read": true,
            "nonDestructiveWrite": true,
            "perOperationConfirmationRequired": false,
            "destructiveWriteRequiresYes": true
        },
        "fileInput": {
            "restrictedToMarginoteWorkdir": false,
            "absolutePaths": true,
            "relativePaths": true,
            "stdin": true,
            "encoding": "UTF-8",
            "description": "--content-file/--file 由 CLI 直接读取任意本机可读文件，不要求源文件位于 Marginote 工作目录"
        },
        "safety": {
            "destructiveCallsRequireYes": true,
            "destructiveTools": destructive_tools,
            "dryRun": "全局 --dry-run 只返回计划，不修改数据",
            "idempotency": "全局 --request-id；重试同一写入时复用，保留 24 小时"
        },
        "mcp": {
            "transport": "stdio",
            "command": "marginote-cli mcp",
            "defaultProfile": "core",
            "fullCommand": "marginote-cli mcp --profile full",
            "toolDiscovery": "MCP tools/list",
            "serverInstructions": true,
            "destructiveConfirmation": "删除工具必须传 confirmed=true"
        },
        "callTools": call_tools,
        "examples": [
            "marginote-cli --json note list --query 项目",
            "printf '# 内容' | marginote-cli note create '新笔记' --stdin --notebook 工作 --tag agent",
            "marginote-cli note export <NOTE_ID> --output note.md",
            "marginote-cli todo create '提交周报' --due 2026-08-02T09:00:00+08:00",
            "marginote-cli call create_note --args '{\"title\":\"来自 agent\",\"content\":\"正文\"}' --json"
        ]
    })
}

fn print_local_data(data: Value, json_output: bool) {
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "ok": true, "requestId": null, "data": data }))
                .unwrap()
        );
    } else if let Some(text) = data.as_str() {
        println!("{text}");
    } else {
        println!("{}", serde_json::to_string_pretty(&data).unwrap());
    }
}

fn agent_instructions() -> &'static str {
    r#"当用户要求记录、查找、整理或更新个人笔记和待办时，使用 marginote-cli。

操作规则：
1. 用户已默认授权使用 Marginote CLI 查找、读取以及新建、追加、修改等非删除写入；无需逐次询问或先做 dry-run。首次使用运行 `marginote-cli status --json`，需要能力清单时运行 `marginote-cli schema --json`。
2. 自动化调用一律加 `--json`，只解析 stdout 的 JSON，并根据退出码判断成功；不要从自然语言输出猜测结果。
3. 记录内容前先用 `marginote-cli note list --query <关键词> --json` 搜索语义相关笔记：高度相关时优先 `note append/update`，无合适笔记时再 `note create`。修改前必须找到准确 ID。
4. 普通写入直接执行；批量覆盖等高风险非删除操作可按需使用 `--dry-run`。正式写入设置稳定的 `--request-id`，不确定结果重试时必须复用同一个 ID。
5. 删除只在用户明确要求后加 `--yes`；不要擅自删除、覆盖导出文件或复用 requestId 执行不同参数。
6. 长正文使用 `--content-file` 或 `--stdin`。CLI 可以直接读取任意本机可读的绝对或相对路径，源文件无需位于 Marginote 工作目录；不要因为当前工作目录不同而拒绝同步。导出笔记使用 `note export <ID>`，写文件时用 `--output`。
7. 批量整理使用 schema 白名单中的 batch_* 工具；批量删除仍必须 `--yes`。
8. 不要直接读写 Marginote 的 WebView2、LevelDB 或端点令牌文件；只通过 marginote-cli 操作。
9. `status --json` 返回 `writable:false` 时立即停止写入，报告 `storageError`，不要盲目重试或绕过保护。
10. 命令失败时把 JSON error 和 requestId 告诉用户，不要声称已经写入成功。"#
}

fn data_dir() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("MARGINOTE_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    dirs::data_dir()
        .map(|path| path.join(APP_ID))
        .ok_or_else(|| "无法确定 Marginote 应用数据目录；可设置 MARGINOTE_DATA_DIR".into())
}

fn resolve_request_id(value: Option<&str>) -> Result<String, String> {
    let request_id = match value {
        Some(value) => value.trim().to_string(),
        None => {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            format!("mn-{}-{nanos:x}", std::process::id())
        }
    };
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.' | ':'))
    {
        return Err("--request-id 仅允许 1-128 个字母、数字、-、_、.、:".into());
    }
    Ok(request_id)
}

fn read_endpoint() -> Result<EndpointInfo, String> {
    let path = data_dir()?.join(ENDPOINT_FILE);
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("尚未找到 CLI 端点 {}：{error}", path.display()))?;
    let endpoint: EndpointInfo =
        serde_json::from_str(&raw).map_err(|error| format!("CLI 端点文件损坏：{error}"))?;
    if endpoint.protocol != 1 || endpoint.token.len() < 32 {
        return Err("CLI 端点协议不兼容".into());
    }
    Ok(endpoint)
}

fn send_once(command: &str, args: &Value, request_id: &str) -> Result<WireResponse, String> {
    let endpoint = read_endpoint()?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), endpoint.port);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(350))
        .map_err(|error| format!("无法连接 Marginote：{error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(185)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let request = WireRequest {
        token: &endpoint.token,
        request_id,
        command,
        args,
    };
    serde_json::to_writer(&mut stream, &request)
        .map_err(|error| format!("编码请求失败：{error}"))?;
    stream
        .write_all(b"\n")
        .map_err(|error| format!("发送请求失败：{error}"))?;
    stream
        .flush()
        .map_err(|error| format!("发送请求失败：{error}"))?;

    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| format!("读取 Marginote 响应失败：{error}"))?;
    if line.is_empty() {
        return Err("Marginote 未返回响应".into());
    }
    serde_json::from_str(&line).map_err(|error| format!("Marginote 响应无效：{error}"))
}

fn app_candidates(cli_exe: &Path) -> Vec<PathBuf> {
    if let Some(value) = env::var_os("MARGINOTE_APP") {
        return vec![PathBuf::from(value)];
    }
    let dir = cli_exe.parent().unwrap_or_else(|| Path::new("."));
    #[cfg(target_os = "windows")]
    let names = ["Marginote.exe", "marginote.exe"];
    #[cfg(not(target_os = "windows"))]
    let names = ["marginote", "Marginote"];
    names
        .into_iter()
        .map(|name| dir.join(name))
        .filter(|path| path != cli_exe)
        .collect()
}

fn launch_app() -> Result<(), String> {
    let cli_exe = env::current_exe().map_err(|error| format!("无法定位 CLI：{error}"))?;
    let app = app_candidates(&cli_exe)
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "找不到 Marginote 主程序；可设置 MARGINOTE_APP 指向 Marginote.exe".to_string()
        })?;
    let mut command = ProcessCommand::new(&app);
    command
        .arg("--cli-background")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 {} 失败：{error}", app.display()))
}

fn send_with_start(
    command: &str,
    args: &Value,
    request_id: &str,
    no_start: bool,
) -> Result<WireResponse, String> {
    if no_start {
        return send_once(command, args, request_id);
    }
    if let Ok(response) = send_once(command, args, request_id) {
        return Ok(response);
    }
    let launch_error = launch_app().err();
    let mut last_error = String::new();
    for _ in 0..CONNECT_RETRIES {
        thread::sleep(Duration::from_millis(150));
        match send_once(command, args, request_id) {
            Ok(response) => return Ok(response),
            Err(error) => last_error = error,
        }
    }
    if let Some(error) = launch_error {
        Err(format!("{error}；{last_error}"))
    } else {
        Err(format!("Marginote 启动后仍无法连接：{last_error}"))
    }
}

fn print_human(kind: &str, data: &Value) {
    if kind == "note-export" {
        print!(
            "{}",
            data.get("markdown").and_then(Value::as_str).unwrap_or("")
        );
        if !data
            .get("markdown")
            .and_then(Value::as_str)
            .unwrap_or("")
            .ends_with('\n')
        {
            println!();
        }
        return;
    }
    if kind == "note-get" {
        println!(
            "# {}",
            data.get("title")
                .and_then(Value::as_str)
                .unwrap_or("(无标题)")
        );
        if let Some(id) = data.get("id").and_then(Value::as_str) {
            println!("ID: {id}");
        }
        if let Some(notebook) = data.get("notebookName").and_then(Value::as_str) {
            println!("笔记本: {notebook}");
        }
        println!();
        print!(
            "{}",
            data.get("content").and_then(Value::as_str).unwrap_or("")
        );
        if !io::stdout().is_terminal()
            || !data
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .ends_with('\n')
        {
            println!();
        }
        return;
    }
    if let Some(items) = data.get("items").and_then(Value::as_array) {
        print_human(kind, &Value::Array(items.clone()));
        if let Some(cursor) = data.get("nextCursor").and_then(Value::as_str) {
            println!("下一页 cursor: {cursor}");
        }
        return;
    }
    if let Some(items) = data.as_array() {
        if items.is_empty() {
            println!("未找到结果");
            return;
        }
        for item in items {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("-");
            let label = item
                .get("title")
                .or_else(|| item.get("text"))
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("-");
            let extra = item
                .get("notebookName")
                .and_then(Value::as_str)
                .unwrap_or("");
            if extra.is_empty() {
                println!("{id}\t{label}");
            } else {
                println!("{id}\t{label}\t[{extra}]");
            }
        }
        return;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(data).unwrap_or_else(|_| data.to_string())
    );
}

fn export_target(command: &TopCommand) -> Option<(&Path, bool)> {
    match command {
        TopCommand::Note {
            command: NoteCommand::Export(args),
        } => args.output.as_deref().map(|path| (path, args.force)),
        _ => None,
    }
}

fn write_export(path: &Path, markdown: &str, force: bool) -> Result<(), String> {
    if path.exists() && !force {
        return Err(format!(
            "输出文件已存在：{}；如需覆盖请加 --force",
            path.display()
        ));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if parent.is_some_and(|parent| !parent.is_dir()) {
        return Err(format!("输出目录不存在：{}", parent.unwrap().display()));
    }
    fs::write(path, markdown.as_bytes())
        .map_err(|error| format!("写入导出文件 {} 失败：{error}", path.display()))
}

fn main() {
    let cli = Cli::parse();
    if matches!(cli.command, TopCommand::Schema) {
        let data = schema();
        if cli.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({ "ok": true, "data": data })).unwrap()
            );
        } else {
            println!("{}", serde_json::to_string_pretty(&data).unwrap());
        }
        return;
    }
    if matches!(cli.command, TopCommand::Instructions) {
        print_local_data(json!({ "text": agent_instructions() }), cli.json);
        return;
    }
    if let TopCommand::Mcp(args) = &cli.command {
        if let Err(error) = mcp::run(cli.no_start, args.profile) {
            eprintln!("Marginote MCP Server 退出：{error}");
            std::process::exit(3);
        }
        return;
    }
    if let TopCommand::Doctor(args) = &cli.command {
        print_local_data(
            integration::doctor(cli.no_start, args.codeagent_dir.as_deref()),
            cli.json,
        );
        return;
    }
    if let TopCommand::Integrate { command } = &cli.command {
        let result = match command {
            IntegrateCommand::Status { codeagent_dir } => {
                Ok(integration::status(codeagent_dir.as_deref()))
            }
            IntegrateCommand::Show { client } => Ok(integration::show(*client)),
            IntegrateCommand::Install {
                client,
                codeagent_dir,
            } => integration::install(*client, codeagent_dir.as_deref()),
            IntegrateCommand::Remove {
                client,
                codeagent_dir,
            } => integration::remove(*client, codeagent_dir.as_deref()),
        };
        match result {
            Ok(data) => print_local_data(data, cli.json),
            Err(error) => fail(error, 3, cli.json, None),
        }
        return;
    }

    let request_id = resolve_request_id(cli.request_id.as_deref())
        .unwrap_or_else(|error| fail(error, 2, cli.json, None));
    let (command, mut args, kind) = request_for(&cli.command, cli.dry_run)
        .unwrap_or_else(|error| fail(error, 2, cli.json, Some(&request_id)));
    if cli.dry_run {
        if let Some(map) = args.as_object_mut() {
            map.insert("_dryRun".into(), Value::Bool(true));
        }
    }
    let response = send_with_start(&command, &args, &request_id, cli.no_start)
        .unwrap_or_else(|error| fail(error, 3, cli.json, Some(&request_id)));
    if !response.ok {
        fail(
            response
                .error
                .unwrap_or_else(|| "Marginote 操作失败".into()),
            4,
            cli.json,
            response.request_id.as_deref().or(Some(&request_id)),
        );
    }
    let mut data = response.data.unwrap_or(Value::Null);
    if let Some((path, force)) = export_target(&cli.command) {
        if cli.dry_run {
            data = json!({
                "dryRun": true,
                "command": "export_note",
                "output": path.to_string_lossy(),
                "overwrite": force
            });
            if !cli.json {
                println!("预演：导出笔记到 {}（未写入文件）", path.display());
                return;
            }
        } else {
            let markdown = data
                .get("markdown")
                .and_then(Value::as_str)
                .ok_or_else(|| "Marginote 导出响应缺少 markdown".to_string())
                .unwrap_or_else(|error| fail(error, 4, cli.json, Some(&request_id)));
            write_export(path, markdown, force)
                .unwrap_or_else(|error| fail(error, 2, cli.json, Some(&request_id)));
            data = json!({
                "id": data.get("id"),
                "title": data.get("title"),
                "output": path.to_string_lossy(),
                "bytes": markdown.len()
            });
            if !cli.json {
                println!("已导出到 {}", path.display());
                return;
            }
        }
    }
    if cli.json {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({ "ok": true, "requestId": request_id, "data": data })
            )
            .unwrap()
        );
    } else {
        print_human(kind, &data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_create_maps_to_agent_friendly_request() {
        let cli = Cli::try_parse_from([
            "marginote-cli",
            "note",
            "create",
            "联调记录",
            "--content",
            "完成",
            "--notebook",
            "工作",
            "--tag",
            "agent",
            "--json",
        ])
        .unwrap();
        let (command, args, _) = request_for(&cli.command, false).unwrap();
        assert_eq!(command, "create_note");
        assert_eq!(args["title"], "联调记录");
        assert_eq!(args["notebookName"], "工作");
        assert_eq!(args["tags"][0], "agent");
        assert!(cli.json);
    }

    #[test]
    fn instructions_are_available_without_the_desktop_app() {
        let cli = Cli::try_parse_from(["marginote-cli", "instructions", "--json"]).unwrap();
        assert!(matches!(cli.command, TopCommand::Instructions));
        assert!(cli.json);
        assert!(agent_instructions().contains("--request-id"));
        assert!(agent_instructions().contains("不要直接读写"));
        assert!(agent_instructions().contains("writable:false"));
        assert!(agent_instructions().contains("note append/update"));
        assert!(agent_instructions().contains("默认授权"));
        assert!(agent_instructions().contains("无需位于 Marginote 工作目录"));
    }

    #[test]
    fn note_export_maps_to_markdown_tool_and_local_target() {
        let cli = Cli::try_parse_from([
            "marginote-cli",
            "note",
            "export",
            "note-1",
            "--output",
            "note.md",
        ])
        .unwrap();
        let (command, args, kind) = request_for(&cli.command, false).unwrap();
        assert_eq!(command, "export_note");
        assert_eq!(args["noteId"], "note-1");
        assert_eq!(kind, "note-export");
        let (path, force) = export_target(&cli.command).unwrap();
        assert_eq!(path, Path::new("note.md"));
        assert!(!force);
    }

    #[test]
    fn note_append_accepts_content_file_alias() {
        let cli = Cli::try_parse_from([
            "marginote-cli",
            "note",
            "append",
            "note-1",
            "--content-file",
            "sync.md",
        ])
        .unwrap();
        match cli.command {
            TopCommand::Note {
                command: NoteCommand::Append(args),
            } => assert_eq!(args.file.as_deref(), Some(Path::new("sync.md"))),
            _ => panic!("expected note append"),
        }
    }

    #[test]
    fn content_file_accepts_any_os_readable_absolute_path() {
        let path = env::temp_dir().join(format!(
            "marginote-cli-input-{}-{}.txt",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::write(&path, "来自工作目录外的内容").unwrap();
        let content = read_content(&None, &Some(path.clone()), false).unwrap();
        assert_eq!(content.as_deref(), Some("来自工作目录外的内容"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn export_does_not_overwrite_without_force() {
        let path = env::temp_dir().join(format!(
            "marginote-cli-export-{}-{}.md",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        write_export(&path, "first", false).unwrap();
        assert!(write_export(&path, "second", false)
            .unwrap_err()
            .contains("--force"));
        write_export(&path, "second", true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn deletion_requires_explicit_confirmation() {
        let cli = Cli::try_parse_from(["marginote-cli", "note", "delete", "n1"]).unwrap();
        assert!(request_for(&cli.command, false)
            .unwrap_err()
            .contains("--yes"));
        assert!(request_for(&cli.command, true).is_ok());
    }

    #[test]
    fn raw_destructive_call_requires_explicit_confirmation() {
        let cli = Cli::try_parse_from([
            "marginote-cli",
            "call",
            "delete_note",
            "--args",
            "{\"id\":\"n1\"}",
        ])
        .unwrap();
        assert!(request_for(&cli.command, false)
            .unwrap_err()
            .contains("--yes"));

        let confirmed = Cli::try_parse_from([
            "marginote-cli",
            "call",
            "delete_note",
            "--args",
            "{\"id\":\"n1\"}",
            "--yes",
        ])
        .unwrap();
        let (command, args, _) = request_for(&confirmed.command, false).unwrap();
        assert_eq!(command, "delete_note");
        assert_eq!(args["_confirmed"], true);
    }

    #[test]
    fn schema_matches_binary_version() {
        assert_eq!(schema()["version"], env!("CARGO_PKG_VERSION"));
        let schema = schema();
        let call_tools = schema["callTools"].as_array().unwrap();
        assert_eq!(call_tools.len(), CLI_CALL_POLICIES.len());
        assert!(call_tools.iter().any(|item| item == "create_note"));
        assert!(schema["statusFields"]["writable"].is_string());
        assert_eq!(schema["defaultPermissions"]["search"], true);
        assert_eq!(schema["defaultPermissions"]["read"], true);
        assert_eq!(schema["defaultPermissions"]["nonDestructiveWrite"], true);
        assert_eq!(
            schema["defaultPermissions"]["perOperationConfirmationRequired"],
            false
        );
        assert_eq!(schema["fileInput"]["restrictedToMarginoteWorkdir"], false);
        assert_eq!(schema["fileInput"]["absolutePaths"], true);
        assert_eq!(schema["mcp"]["transport"], "stdio");
        assert_eq!(schema["mcp"]["defaultProfile"], "core");
        assert_eq!(
            schema["mcp"]["fullCommand"],
            "marginote-cli mcp --profile full"
        );
        assert_eq!(schema["mcp"]["serverInstructions"], true);
        assert_eq!(
            schema["safety"]["destructiveTools"]
                .as_array()
                .unwrap()
                .len(),
            CLI_CALL_POLICIES
                .iter()
                .filter(|policy| policy.destructive)
                .count()
        );
    }

    #[test]
    fn raw_unknown_call_is_rejected_before_connecting() {
        let cli =
            Cli::try_parse_from(["marginote-cli", "call", "unknown_tool", "--args", "{}"]).unwrap();
        assert!(request_for(&cli.command, false)
            .unwrap_err()
            .contains("不在白名单"));
    }

    #[test]
    fn request_id_is_stable_and_validated() {
        assert_eq!(
            resolve_request_id(Some("agent:release-124")).unwrap(),
            "agent:release-124"
        );
        assert!(resolve_request_id(Some("contains space")).is_err());
        assert!(resolve_request_id(None).unwrap().starts_with("mn-"));
    }

    #[test]
    fn global_automation_flags_parse() {
        let cli = Cli::try_parse_from([
            "marginote-cli",
            "note",
            "create",
            "记录",
            "--dry-run",
            "--request-id",
            "agent-1",
        ])
        .unwrap();
        assert!(cli.dry_run);
        assert_eq!(cli.request_id.as_deref(), Some("agent-1"));
    }

    #[test]
    fn paged_note_list_maps_cursor() {
        let cli = Cli::try_parse_from([
            "marginote-cli",
            "note",
            "list",
            "--limit",
            "10",
            "--paged",
            "--cursor",
            "mn1:20",
        ])
        .unwrap();
        let (command, args, _) = request_for(&cli.command, false).unwrap();
        assert_eq!(command, "list_notes");
        assert_eq!(args["paged"], true);
        assert_eq!(args["cursor"], "mn1:20");
    }

    #[test]
    fn agent_integration_commands_parse_without_starting_marginote() {
        let mcp = Cli::try_parse_from(["marginote-cli", "mcp"]).unwrap();
        assert!(matches!(
            mcp.command,
            TopCommand::Mcp(McpArgs {
                profile: McpProfile::Core
            })
        ));
        let full = Cli::try_parse_from(["marginote-cli", "mcp", "--profile", "full"]).unwrap();
        assert!(matches!(
            full.command,
            TopCommand::Mcp(McpArgs {
                profile: McpProfile::Full
            })
        ));

        let install =
            Cli::try_parse_from(["marginote-cli", "integrate", "install", "codex", "--json"])
                .unwrap();
        assert!(matches!(
            install.command,
            TopCommand::Integrate {
                command: IntegrateCommand::Install {
                    client: InstallableAgentClient::Codex,
                    codeagent_dir: None
                }
            }
        ));
        assert!(install.json);

        let codeagent = Cli::try_parse_from([
            "marginote-cli",
            "integrate",
            "install",
            "codeagent",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            codeagent.command,
            TopCommand::Integrate {
                command: IntegrateCommand::Install {
                    client: InstallableAgentClient::CodeAgent,
                    codeagent_dir: None
                }
            }
        ));

        let configured_codeagent = Cli::try_parse_from([
            "marginote-cli",
            "integrate",
            "install",
            "codeagent",
            "--codeagent-dir",
            "C:\\Users\\demo\\.cac",
        ])
        .unwrap();
        assert!(matches!(
            configured_codeagent.command,
            TopCommand::Integrate {
                command: IntegrateCommand::Install {
                    client: InstallableAgentClient::CodeAgent,
                    codeagent_dir: Some(_)
                }
            }
        ));
    }
}
