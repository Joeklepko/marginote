use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::thread;
use std::time::Duration;

// Must match tauri.conf.json's identifier so both processes find the endpoint.
const APP_ID: &str = "com.marginote.app";
const ENDPOINT_FILE: &str = "cli-endpoint.json";
const CONNECT_RETRIES: usize = 80;

#[derive(Parser, Debug)]
#[command(
    name = "marginote-cli",
    version,
    about = "从终端和 AI agent 访问 Marginote 笔记与待办",
    long_about = None,
    after_help = "示例:\n  marginote-cli note create \"会议记录\" --stdin --notebook 工作\n  marginote-cli note list --query 项目 --json\n  marginote-cli todo create \"明天提交周报\" --due 2026-08-02T09:00:00+08:00\n  marginote-cli todo complete <ID>"
)]
struct Cli {
    /// 输出稳定的 JSON 信封，适合 Claude Code 等 agent 解析
    #[arg(long, global = true)]
    json: bool,

    /// Marginote 未运行时不自动启动
    #[arg(long, global = true)]
    no_start: bool,

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
    /// 从 UTF-8 文件读取正文
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
    #[arg(long)]
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
}

#[derive(Args, Debug)]
struct TodoCreateArgs {
    /// 待办标题
    text: String,
    #[arg(long)]
    content: Option<String>,
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
    command: &'a str,
    args: &'a Value,
}

#[derive(Debug, Deserialize, Serialize)]
struct WireResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn fail(message: impl AsRef<str>, code: i32, json_output: bool) -> ! {
    if json_output {
        println!("{}", json!({ "ok": false, "error": message.as_ref() }));
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

fn request_for(command: &TopCommand) -> Result<(String, Value, &'static str), String> {
    match command {
        TopCommand::Status => Ok(("status".into(), json!({}), "status")),
        TopCommand::Search(args) => Ok((
            "search_all".into(),
            json!({ "query": args.query, "limit": args.limit }),
            "search",
        )),
        TopCommand::Schema => unreachable!("schema is local"),
        TopCommand::Call(args) => {
            let value: Value = serde_json::from_str(&args.args)
                .map_err(|error| format!("--args 不是有效 JSON：{error}"))?;
            if !value.is_object() {
                return Err("--args 必须是 JSON 对象".into());
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
                    "limit": args.limit
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
                if !args.yes {
                    return Err("删除需要显式传入 --yes".into());
                }
                Ok(("delete_note".into(), json!({ "id": args.id }), "note-write"))
            }
        },
        TopCommand::Todo { command } => match command {
            TodoCommand::List(args) => Ok((
                "search_todos".into(),
                json!({ "query": args.query, "status": args.status, "due": args.due, "limit": args.limit }),
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
                if !args.yes {
                    return Err("删除需要显式传入 --yes".into());
                }
                Ok(("delete_todo".into(), json!({ "id": args.id }), "todo-write"))
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
                if !args.yes {
                    return Err("删除需要显式传入 --yes".into());
                }
                Ok((
                    "delete_notebook_cli".into(),
                    json!({ "notebookRef": args.notebook }),
                    "notebook-write",
                ))
            }
        },
    }
}

fn schema() -> Value {
    json!({
        "name": "marginote-cli",
        "version": env!("CARGO_PKG_VERSION"),
        "jsonEnvelope": { "success": { "ok": true, "data": {} }, "failure": { "ok": false, "error": "message" } },
        "commands": [
            "status", "search <query>",
            "note list|get|create|update|append|delete",
            "todo list|get|create|update|complete|delete",
            "notebook list|create|rename|delete",
            "call <tool> --args <json>"
        ],
        "callTools": [
            "list_notebooks", "create_notebook", "rename_notebook", "delete_notebook", "rename_notebook_cli", "delete_notebook_cli",
            "list_notes", "search_notes", "get_note", "create_note", "update_note_cli", "append_to_note", "move_note", "delete_note", "add_tags", "remove_tags", "star_note",
            "search_todos", "list_todos", "get_todo", "create_todo", "update_todo", "complete_todo", "delete_todo",
            "search_all", "list_tags", "note_stats", "word_count"
        ],
        "examples": [
            "marginote-cli --json note list --query 项目",
            "printf '# 内容' | marginote-cli note create '新笔记' --stdin --notebook 工作 --tag agent",
            "marginote-cli todo create '提交周报' --due 2026-08-02T09:00:00+08:00",
            "marginote-cli call create_note --args '{\"title\":\"来自 agent\",\"content\":\"正文\"}' --json"
        ]
    })
}

fn data_dir() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("MARGINOTE_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    dirs::data_dir()
        .map(|path| path.join(APP_ID))
        .ok_or_else(|| "无法确定 Marginote 应用数据目录；可设置 MARGINOTE_DATA_DIR".into())
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

fn send_once(command: &str, args: &Value) -> Result<WireResponse, String> {
    let endpoint = read_endpoint()?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), endpoint.port);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(350))
        .map_err(|error| format!("无法连接 Marginote：{error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(65)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let request = WireRequest {
        token: &endpoint.token,
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

fn send_with_start(command: &str, args: &Value, no_start: bool) -> Result<WireResponse, String> {
    if no_start {
        return send_once(command, args);
    }
    if let Ok(response) = send_once(command, args) {
        return Ok(response);
    }
    let launch_error = launch_app().err();
    let mut last_error = String::new();
    for _ in 0..CONNECT_RETRIES {
        thread::sleep(Duration::from_millis(150));
        match send_once(command, args) {
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

    let (command, args, kind) =
        request_for(&cli.command).unwrap_or_else(|error| fail(error, 2, cli.json));
    let response = send_with_start(&command, &args, cli.no_start)
        .unwrap_or_else(|error| fail(error, 3, cli.json));
    if !response.ok {
        fail(
            response
                .error
                .unwrap_or_else(|| "Marginote 操作失败".into()),
            4,
            cli.json,
        );
    }
    let data = response.data.unwrap_or(Value::Null);
    if cli.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "ok": true, "data": data })).unwrap()
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
        let (command, args, _) = request_for(&cli.command).unwrap();
        assert_eq!(command, "create_note");
        assert_eq!(args["title"], "联调记录");
        assert_eq!(args["notebookName"], "工作");
        assert_eq!(args["tags"][0], "agent");
        assert!(cli.json);
    }

    #[test]
    fn deletion_requires_explicit_confirmation() {
        let cli = Cli::try_parse_from(["marginote-cli", "note", "delete", "n1"]).unwrap();
        assert!(request_for(&cli.command).unwrap_err().contains("--yes"));
    }

    #[test]
    fn schema_matches_binary_version() {
        assert_eq!(schema()["version"], env!("CARGO_PKG_VERSION"));
        assert!(schema()["callTools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "create_note"));
    }
}
