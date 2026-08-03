use serde_json::{json, Map, Value};
use std::io::{self, BufRead, BufReader, BufWriter, Write};

use super::{confirmed_args, send_with_start, McpProfile};

const SERVER_INSTRUCTIONS: &str = "Marginote 是用户的本地笔记与待办库。用户询问可能来自既有笔记的事实时，应先搜索再回答；记录信息前先搜索语义相关笔记，高度相关时优先追加或更新，无合适笔记时再创建并选择合适的笔记本。读取和非删除写入已默认授权。删除工具仅在用户明确要求后调用，并将 confirmed 设为 true。写入前可调用 status；writable=false 时停止写入并报告 storageError。不要直接修改 Marginote 工作目录元数据或应用内部文件。";

const CORE_TOOL_NAMES: &[&str] = &[
    "status",
    "search_all",
    "get_note",
    "create_note",
    "update_note",
    "delete_note",
    "search_todos",
    "get_todo",
    "create_todo",
    "update_todo",
    "delete_todo",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Read,
    Write,
    Destructive,
}

struct ToolSpec {
    name: &'static str,
    command: &'static str,
    description: &'static str,
    input_schema: Value,
    access: Access,
}

fn string(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn integer(description: &str, minimum: i64, maximum: i64) -> Value {
    json!({ "type": "integer", "description": description, "minimum": minimum, "maximum": maximum })
}

fn boolean(description: &str) -> Value {
    json!({ "type": "boolean", "description": description })
}

fn strings(description: &str) -> Value {
    json!({ "type": "array", "description": description, "items": { "type": "string" } })
}

fn object(properties: Vec<(&str, Value)>, required: &[&str]) -> Value {
    let properties = properties
        .into_iter()
        .map(|(name, schema)| (name.to_string(), schema))
        .collect::<Map<String, Value>>();
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn destructive_object(mut schema: Value) -> Value {
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        properties.insert(
            "confirmed".into(),
            boolean("仅当用户明确要求删除时设为 true"),
        );
    }
    if let Some(required) = schema.get_mut("required").and_then(Value::as_array_mut) {
        required.push(Value::String("confirmed".into()));
    }
    schema
}

fn enum_string(description: &str, values: &[&str]) -> Value {
    json!({ "type": "string", "description": description, "enum": values })
}

fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "status",
            command: "status",
            description: "检查 Marginote 连接、工作目录、可写状态和数据统计。",
            input_schema: object(vec![], &[]),
            access: Access::Read,
        },
        ToolSpec {
            name: "search_all",
            command: "search_all",
            description: "同时搜索笔记与待办。直接询问用户知识时应优先使用。",
            input_schema: object(
                vec![
                    ("query", string("搜索词或自然语言关键词")),
                    ("limit", integer("每类最多返回数量", 1, 200)),
                ],
                &["query"],
            ),
            access: Access::Read,
        },
        ToolSpec {
            name: "list_notes",
            command: "list_notes",
            description: "搜索或筛选笔记，返回 ID、标题、摘要和笔记本。",
            input_schema: object(
                vec![
                    (
                        "query",
                        string("标题、正文或标签关键词；可留空列出最近笔记"),
                    ),
                    ("notebookName", string("精确笔记本名称")),
                    ("tags", strings("必须包含的标签")),
                    ("starred", boolean("仅返回收藏笔记")),
                    ("limit", integer("本页数量", 1, 200)),
                    ("paged", boolean("返回 nextCursor")),
                    ("cursor", string("上一页返回的不透明游标")),
                ],
                &[],
            ),
            access: Access::Read,
        },
        ToolSpec {
            name: "get_note",
            command: "get_note",
            description: "按 ID 读取一篇笔记的完整正文和元数据。",
            input_schema: object(vec![("id", string("笔记 ID"))], &["id"]),
            access: Access::Read,
        },
        ToolSpec {
            name: "create_note",
            command: "create_note",
            description: "创建笔记。创建前应先搜索相似笔记；标题应具体可检索。",
            input_schema: object(
                vec![
                    ("title", string("具体、可检索的笔记标题")),
                    ("content", string("Markdown 正文")),
                    ("notebookName", string("合适的已有或新笔记本名称")),
                    ("tags", strings("标签")),
                    ("starred", boolean("是否收藏")),
                ],
                &["title", "content", "notebookName"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "update_note",
            command: "update_note_cli",
            description: "修改笔记标题、正文、笔记本、标签或收藏状态；append=true 时追加正文。",
            input_schema: object(
                vec![
                    ("id", string("笔记 ID")),
                    ("title", string("新标题")),
                    ("content", string("新正文或要追加的正文")),
                    ("append", boolean("是否把 content 追加到原正文")),
                    ("notebookName", string("移动到此笔记本，不存在时创建")),
                    ("addTags", strings("要添加的标签")),
                    ("removeTags", strings("要移除的标签")),
                    ("starred", boolean("收藏状态")),
                ],
                &["id"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "append_to_note",
            command: "append_to_note",
            description: "向既有笔记末尾追加 Markdown 内容，适合相关内容持续记录。",
            input_schema: object(
                vec![("noteId", string("笔记 ID")), ("text", string("追加内容"))],
                &["noteId", "text"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "delete_note",
            command: "delete_note",
            description: "删除一篇笔记并移入回收站。仅在用户明确要求时调用。",
            input_schema: destructive_object(object(vec![("id", string("笔记 ID"))], &["id"])),
            access: Access::Destructive,
        },
        ToolSpec {
            name: "search_todos",
            command: "search_todos",
            description: "搜索和筛选待办。",
            input_schema: object(
                vec![
                    ("query", string("待办标题或正文关键词")),
                    (
                        "status",
                        enum_string("状态", &["active", "done", "overdue", "all"]),
                    ),
                    (
                        "due",
                        enum_string("截止范围", &["today", "week", "overdue"]),
                    ),
                    ("limit", integer("最多返回数量", 1, 200)),
                ],
                &[],
            ),
            access: Access::Read,
        },
        ToolSpec {
            name: "get_todo",
            command: "get_todo",
            description: "按 ID 读取待办完整详情。",
            input_schema: object(vec![("id", string("待办 ID"))], &["id"]),
            access: Access::Read,
        },
        ToolSpec {
            name: "create_todo",
            command: "create_todo",
            description: "创建待办，可设置截止时间和重复提醒。",
            input_schema: object(
                vec![
                    ("text", string("待办标题")),
                    ("content", string("待办详情")),
                    ("dueAt", string("带时区的 ISO 8601 截止时间")),
                    ("remindBeforeMin", integer("提前提醒分钟数", 0, 525_600)),
                    ("remindCount", integer("提醒总次数", 1, 100)),
                    (
                        "remindIntervalMin",
                        integer("重复提醒间隔分钟数", 1, 525_600),
                    ),
                ],
                &["text"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "update_todo",
            command: "update_todo",
            description: "修改待办标题、详情、完成状态、截止时间和提醒设置。",
            input_schema: object(
                vec![
                    ("id", string("待办 ID")),
                    ("text", string("新标题")),
                    ("content", string("新详情")),
                    ("done", boolean("完成状态")),
                    ("dueAt", string("带时区的 ISO 8601 截止时间；空字符串清除")),
                    ("remindBeforeMin", integer("提前提醒分钟数", 0, 525_600)),
                    ("remindCount", integer("提醒总次数", 1, 100)),
                    (
                        "remindIntervalMin",
                        integer("重复提醒间隔分钟数", 1, 525_600),
                    ),
                ],
                &["id"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "complete_todo",
            command: "complete_todo",
            description: "完成指定待办。",
            input_schema: object(vec![("id", string("待办 ID"))], &["id"]),
            access: Access::Write,
        },
        ToolSpec {
            name: "delete_todo",
            command: "delete_todo",
            description: "删除待办。仅在用户明确要求时调用。",
            input_schema: destructive_object(object(vec![("id", string("待办 ID"))], &["id"])),
            access: Access::Destructive,
        },
        ToolSpec {
            name: "list_notebooks",
            command: "list_notebooks",
            description: "列出所有笔记本及笔记数量。",
            input_schema: object(vec![], &[]),
            access: Access::Read,
        },
        ToolSpec {
            name: "create_notebook",
            command: "create_notebook",
            description: "创建笔记本；同名笔记本存在时直接返回它。",
            input_schema: object(
                vec![
                    ("name", string("笔记本名称")),
                    ("color", string("十六进制颜色")),
                ],
                &["name"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "rename_notebook",
            command: "rename_notebook_cli",
            description: "按 ID 或精确名称重命名笔记本。",
            input_schema: object(
                vec![
                    ("notebookRef", string("笔记本 ID 或精确名称")),
                    ("newName", string("新名称")),
                    ("newColor", string("可选的新颜色")),
                ],
                &["notebookRef", "newName"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "delete_notebook",
            command: "delete_notebook_cli",
            description: "删除笔记本。仅在用户明确要求时调用。",
            input_schema: destructive_object(object(
                vec![("notebookRef", string("笔记本 ID 或精确名称"))],
                &["notebookRef"],
            )),
            access: Access::Destructive,
        },
        ToolSpec {
            name: "batch_move_notes",
            command: "batch_move_notes",
            description: "把多篇笔记批量移动到指定笔记本。",
            input_schema: object(
                vec![
                    ("noteIds", strings("笔记 ID 列表")),
                    ("notebookName", string("目标笔记本名称")),
                ],
                &["noteIds", "notebookName"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "batch_update_notes",
            command: "batch_update_notes",
            description: "批量添加或移除标签，也可添加标题前缀。",
            input_schema: object(
                vec![
                    ("noteIds", strings("笔记 ID 列表")),
                    ("addTags", strings("要添加的标签")),
                    ("removeTags", strings("要移除的标签")),
                    ("titlePrefix", string("标题前缀")),
                ],
                &["noteIds"],
            ),
            access: Access::Write,
        },
        ToolSpec {
            name: "batch_complete_todos",
            command: "batch_complete_todos",
            description: "批量完成待办。",
            input_schema: object(vec![("todoIds", strings("待办 ID 列表"))], &["todoIds"]),
            access: Access::Write,
        },
        ToolSpec {
            name: "batch_delete_notes",
            command: "batch_delete_notes",
            description: "批量删除笔记并移入回收站。仅在用户明确要求时调用。",
            input_schema: destructive_object(object(
                vec![("noteIds", strings("笔记 ID 列表"))],
                &["noteIds"],
            )),
            access: Access::Destructive,
        },
        ToolSpec {
            name: "batch_delete_todos",
            command: "batch_delete_todos",
            description: "批量删除待办。仅在用户明确要求时调用。",
            input_schema: destructive_object(object(
                vec![("todoIds", strings("待办 ID 列表"))],
                &["todoIds"],
            )),
            access: Access::Destructive,
        },
    ]
}

fn listed_tool(tool: ToolSpec) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "inputSchema": tool.input_schema,
        "annotations": {
            "title": tool.name,
            "readOnlyHint": tool.access == Access::Read,
            "destructiveHint": tool.access == Access::Destructive,
            "idempotentHint": tool.access == Access::Read,
            "openWorldHint": false
        }
    })
}

fn batch_manage_tool() -> Value {
    json!({
        "name": "batch_manage",
        "description": "批量移动或整理笔记、完成待办；仅在用户明确要求时批量删除。根据 action 填写对应 ID 和参数。",
        "inputSchema": object(
            vec![
                ("action", enum_string("批处理动作", &["move_notes", "update_notes", "complete_todos", "delete_notes", "delete_todos"])),
                ("noteIds", strings("move/update/delete_notes 使用的笔记 ID 列表")),
                ("todoIds", strings("complete/delete_todos 使用的待办 ID 列表")),
                ("notebookName", string("move_notes 的目标笔记本名称")),
                ("addTags", strings("update_notes 要添加的标签")),
                ("removeTags", strings("update_notes 要移除的标签")),
                ("titlePrefix", string("update_notes 的标题前缀")),
                ("confirmed", boolean("delete_notes/delete_todos 仅在用户明确要求删除时设为 true")),
            ],
            &["action"],
        ),
        "annotations": {
            "title": "batch_manage",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false
        }
    })
}

fn listed_tools(profile: McpProfile) -> Vec<Value> {
    let mut tools = tool_specs()
        .into_iter()
        .filter(|tool| profile == McpProfile::Full || CORE_TOOL_NAMES.contains(&tool.name))
        .map(listed_tool)
        .collect::<Vec<_>>();
    if profile == McpProfile::Core {
        tools.push(batch_manage_tool());
    }
    tools
}

fn select_batch_arguments(
    arguments: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<Value, String> {
    let mut selected = Map::new();
    for key in required {
        let value = arguments
            .get(*key)
            .cloned()
            .ok_or_else(|| format!("batch_manage 缺少参数：{key}"))?;
        selected.insert((*key).into(), value);
    }
    for key in optional {
        if let Some(value) = arguments.get(*key) {
            selected.insert((*key).into(), value.clone());
        }
    }
    Ok(Value::Object(selected))
}

fn batch_manage_request(arguments: Value) -> Result<(&'static str, Value), String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "工具参数必须是 JSON 对象".to_string())?;
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "batch_manage 缺少字符串参数：action".to_string())?;
    match action {
        "move_notes" => Ok((
            "batch_move_notes",
            select_batch_arguments(arguments, &["noteIds", "notebookName"], &[])?,
        )),
        "update_notes" => Ok((
            "batch_update_notes",
            select_batch_arguments(
                arguments,
                &["noteIds"],
                &["addTags", "removeTags", "titlePrefix"],
            )?,
        )),
        "complete_todos" => Ok((
            "batch_complete_todos",
            select_batch_arguments(arguments, &["todoIds"], &[])?,
        )),
        "delete_notes" | "delete_todos" => {
            if !arguments
                .get("confirmed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err("批量删除仅在用户明确要求后调用，并必须传入 confirmed=true".into());
            }
            let (command, ids) = if action == "delete_notes" {
                ("batch_delete_notes", "noteIds")
            } else {
                ("batch_delete_todos", "todoIds")
            };
            Ok((
                command,
                confirmed_args(select_batch_arguments(arguments, &[ids], &[])?),
            ))
        }
        _ => Err(format!("未知 batch_manage action：{action}")),
    }
}

fn tool_request(
    profile: McpProfile,
    name: &str,
    mut arguments: Value,
) -> Result<(&'static str, Value), String> {
    if profile == McpProfile::Core && name == "batch_manage" {
        return batch_manage_request(arguments);
    }
    let tool = tool_specs()
        .into_iter()
        .find(|tool| {
            tool.name == name
                && (profile == McpProfile::Full || CORE_TOOL_NAMES.contains(&tool.name))
        })
        .ok_or_else(|| format!("未知 Marginote MCP 工具：{name}"))?;
    if !arguments.is_object() {
        return Err("工具参数必须是 JSON 对象".into());
    }
    if tool.access == Access::Destructive {
        let confirmed = arguments
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !confirmed {
            return Err("删除工具仅在用户明确要求后调用，并必须传入 confirmed=true".into());
        }
        if let Some(map) = arguments.as_object_mut() {
            map.remove("confirmed");
        }
        arguments = confirmed_args(arguments);
    }
    Ok((tool.command, arguments))
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(id: Value, code: i64, message: impl AsRef<str>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.as_ref() }
    })
}

fn tool_result(data: Value) -> Value {
    let text = serde_json::to_string(&data).unwrap_or_else(|_| "null".into());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": data,
        "isError": false
    })
}

fn tool_error(message: impl AsRef<str>) -> Value {
    json!({
        "content": [{ "type": "text", "text": message.as_ref() }],
        "isError": true
    })
}

fn mcp_request_id(id: &Value) -> String {
    // 同一 MCP Server 进程内，客户端若因超时重发相同 JSON-RPC id，复用桥的
    // 幂等缓存而不是重复创建。进程 ID 用于隔离同时运行的不同 MCP 客户端。
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in id.to_string().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("mcp:{}:{hash:016x}", std::process::id())
}

fn handle_message(message: Value, no_start: bool, profile: McpProfile) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method.is_empty() {
        return id.map(|id| jsonrpc_error(id, -32600, "无效的 JSON-RPC 请求"));
    }

    match method {
        "initialize" => {
            let id = id?;
            let protocol_version = message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            Some(jsonrpc_result(
                id,
                json!({
                    "protocolVersion": protocol_version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "marginote",
                        "title": "Marginote 本地笔记与待办",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": SERVER_INSTRUCTIONS
                }),
            ))
        }
        "notifications/initialized" | "notifications/cancelled" => None,
        "ping" => id.map(|id| jsonrpc_result(id, json!({}))),
        "tools/list" => id.map(|id| jsonrpc_result(id, json!({ "tools": listed_tools(profile) }))),
        "tools/call" => {
            let id = id?;
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let arguments = message
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let (command, arguments) = match tool_request(profile, name, arguments) {
                Ok(request) => request,
                Err(error) => return Some(jsonrpc_result(id, tool_error(error))),
            };
            let request_id = mcp_request_id(&id);
            match send_with_start(command, &arguments, &request_id, no_start) {
                Ok(response) if response.ok => Some(jsonrpc_result(
                    id,
                    tool_result(response.data.unwrap_or(Value::Null)),
                )),
                Ok(response) => Some(jsonrpc_result(
                    id,
                    tool_error(
                        response
                            .error
                            .unwrap_or_else(|| "Marginote 操作失败".into()),
                    ),
                )),
                Err(error) => Some(jsonrpc_result(id, tool_error(error))),
            }
        }
        _ => id.map(|id| jsonrpc_error(id, -32601, format!("不支持的方法：{method}"))),
    }
}

pub fn run(no_start: bool, profile: McpProfile) -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    for line in reader.lines() {
        let line = line.map_err(|error| format!("读取 MCP 请求失败：{error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(message) => handle_message(message, no_start, profile),
            Err(error) => Some(jsonrpc_error(
                Value::Null,
                -32700,
                format!("JSON 解析失败：{error}"),
            )),
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut writer, &response)
                .map_err(|error| format!("编码 MCP 响应失败：{error}"))?;
            writer
                .write_all(b"\n")
                .map_err(|error| format!("写入 MCP 响应失败：{error}"))?;
            writer
                .flush()
                .map_err(|error| format!("刷新 MCP 响应失败：{error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_returns_tools_capability_and_instructions() {
        let response = handle_message(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2025-06-18" }
            }),
            true,
            McpProfile::Core,
        )
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(
            response["result"]["capabilities"]["tools"]["listChanged"],
            false
        );
        assert!(response["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("先搜索"));
    }

    #[test]
    fn tools_are_typed_and_include_core_note_workflow() {
        let tools = listed_tools(McpProfile::Core);
        let create = tools
            .iter()
            .find(|tool| tool["name"] == "create_note")
            .unwrap();
        assert_eq!(create["inputSchema"]["type"], "object");
        assert_eq!(create["annotations"]["readOnlyHint"], false);
        assert!(tools.iter().any(|tool| tool["name"] == "search_all"));
        assert!(tools.iter().any(|tool| tool["name"] == "batch_manage"));
        assert!(!tools.iter().any(|tool| tool["name"] == "append_to_note"));
        assert_eq!(tools.len(), 12);

        let full_tools = listed_tools(McpProfile::Full);
        assert!(full_tools
            .iter()
            .any(|tool| tool["name"] == "append_to_note"));
        assert!(!full_tools.iter().any(|tool| tool["name"] == "batch_manage"));
        assert_eq!(full_tools.len(), 23);
    }

    #[test]
    fn destructive_tools_require_explicit_confirmation_before_connecting() {
        let error =
            tool_request(McpProfile::Core, "delete_note", json!({ "id": "n1" })).unwrap_err();
        assert!(error.contains("confirmed=true"));
        let (command, arguments) = tool_request(
            McpProfile::Core,
            "delete_note",
            json!({ "id": "n1", "confirmed": true }),
        )
        .unwrap();
        assert_eq!(command, "delete_note");
        assert_eq!(arguments["_confirmed"], true);
        assert!(arguments.get("confirmed").is_none());
    }

    #[test]
    fn public_update_tool_reuses_cli_transaction_command() {
        let (command, arguments) = tool_request(
            McpProfile::Core,
            "update_note",
            json!({ "id": "n1", "content": "追加", "append": true }),
        )
        .unwrap();
        assert_eq!(command, "update_note_cli");
        assert_eq!(arguments["append"], true);
    }

    #[test]
    fn every_mcp_tool_maps_to_an_allowlisted_cli_command() {
        let mut names = std::collections::HashSet::new();
        for tool in tool_specs() {
            assert!(names.insert(tool.name), "重复 MCP 工具名：{}", tool.name);
            assert!(
                super::super::cli_call_policy(tool.command).is_some(),
                "MCP 工具 {} 映射到未授权命令 {}",
                tool.name,
                tool.command
            );
        }
    }

    #[test]
    fn core_profile_consolidates_batch_operations_and_keeps_delete_confirmation() {
        let (command, arguments) = tool_request(
            McpProfile::Core,
            "batch_manage",
            json!({
                "action": "update_notes",
                "noteIds": ["n1", "n2"],
                "addTags": ["已整理"]
            }),
        )
        .unwrap();
        assert_eq!(command, "batch_update_notes");
        assert_eq!(arguments["addTags"][0], "已整理");

        let error = tool_request(
            McpProfile::Core,
            "batch_manage",
            json!({ "action": "delete_notes", "noteIds": ["n1"] }),
        )
        .unwrap_err();
        assert!(error.contains("confirmed=true"));

        let (command, arguments) = tool_request(
            McpProfile::Core,
            "batch_manage",
            json!({
                "action": "delete_todos",
                "todoIds": ["t1"],
                "confirmed": true
            }),
        )
        .unwrap();
        assert_eq!(command, "batch_delete_todos");
        assert_eq!(arguments["_confirmed"], true);
    }

    #[test]
    fn core_profile_rejects_full_only_tool_calls() {
        let error = tool_request(McpProfile::Core, "append_to_note", json!({})).unwrap_err();
        assert!(error.contains("未知 Marginote MCP 工具"));
        assert!(tool_request(
            McpProfile::Full,
            "append_to_note",
            json!({ "noteId": "n1", "text": "追加" })
        )
        .is_ok());
    }

    #[test]
    fn repeated_jsonrpc_id_gets_stable_bridge_request_id() {
        let id = json!("turn-42");
        assert_eq!(mcp_request_id(&id), mcp_request_id(&id));
        assert!(mcp_request_id(&id).starts_with("mcp:"));
        assert_ne!(mcp_request_id(&id), mcp_request_id(&json!("turn-43")));
    }
}
