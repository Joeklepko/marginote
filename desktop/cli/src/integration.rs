use clap::ValueEnum;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Output};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{app_candidates, data_dir, read_endpoint, resolve_request_id, send_with_start};

const CODEAGENT_PLUGIN_KEY: &str = "marginote@local";
const CODEAGENT_PLUGIN_NAME: &str = "marginote";
const CODEAGENT_DIR_ENV: &str = "MARGINOTE_CODEAGENT_DIR";

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum AgentClient {
    #[value(name = "codeagent")]
    CodeAgent,
    Codex,
    Claude,
    Generic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum InstallableAgentClient {
    #[value(name = "codeagent")]
    CodeAgent,
    Codex,
    Claude,
}

impl InstallableAgentClient {
    fn client(self) -> AgentClient {
        match self {
            Self::CodeAgent => AgentClient::CodeAgent,
            Self::Codex => AgentClient::Codex,
            Self::Claude => AgentClient::Claude,
        }
    }
}

impl AgentClient {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CodeAgent => "codeagent",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Generic => "generic",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::CodeAgent => "CodeAgent",
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
            Self::Generic => "其他 MCP 客户端",
        }
    }

    fn executable(self) -> Option<&'static str> {
        match self {
            Self::CodeAgent => Some("codeagent"),
            Self::Codex => Some("codex"),
            Self::Claude => Some("claude"),
            Self::Generic => None,
        }
    }
}

fn executable_suffixes() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &[".exe", ".cmd", ".bat", ""]
    }
    #[cfg(not(target_os = "windows"))]
    {
        &[""]
    }
}

fn find_command(name: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(name);
    if direct.components().count() > 1 && direct.is_file() {
        return Some(direct);
    }
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        for suffix in executable_suffixes() {
            let candidate = directory.join(format!("{name}{suffix}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn config_candidates(client: AgentClient) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    match client {
        AgentClient::CodeAgent => vec![],
        AgentClient::Codex => vec![home.join(".codex").join("config.toml")],
        AgentClient::Claude => vec![
            home.join(".claude.json"),
            home.join(".claude").join("settings.json"),
        ],
        AgentClient::Generic => vec![],
    }
}

fn configured_path(client: AgentClient) -> Option<PathBuf> {
    config_candidates(client).into_iter().find(|path| {
        fs::read_to_string(path).is_ok_and(|text| {
            let lower = text.to_ascii_lowercase();
            lower.contains("marginote") && lower.contains("marginote-cli")
        })
    })
}

fn validate_codeagent_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!(
            "CodeAgent 配置目录不存在或不是目录：{}",
            path.display()
        ));
    }
    let root = path
        .canonicalize()
        .map_err(|error| format!("无法解析 CodeAgent 配置目录 {}：{error}", path.display()))?;
    if !root.join("settings.json").is_file() && !root.join("plugins").is_dir() {
        return Err(format!(
            "{} 不是可识别的 CodeAgent 配置根目录；请选择包含 settings.json 或 plugins 目录的根目录（通常名为 .cac）",
            root.display()
        ));
    }
    Ok(root)
}

fn resolve_codeagent_root(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        return validate_codeagent_root(path);
    }
    if let Some(path) = env::var_os(CODEAGENT_DIR_ENV) {
        return validate_codeagent_root(Path::new(&path))
            .map_err(|error| format!("环境变量 {CODEAGENT_DIR_ENV} 指向的目录无效：{error}"));
    }
    if let Some(default) = dirs::home_dir().map(|home| home.join(".cac")) {
        if default.is_dir() {
            return validate_codeagent_root(&default);
        }
    }
    Err(format!(
        "未找到 CodeAgent 配置根目录；请在 Marginote 设置 → Agent 集成中选择目录，或传入 --codeagent-dir / 设置 {CODEAGENT_DIR_ENV}"
    ))
}

fn codeagent_installed_path(root: &Path) -> PathBuf {
    root.join("plugins").join("installed_plugins.json")
}

fn codeagent_settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
}

fn codeagent_plugin_dir(root: &Path) -> PathBuf {
    root.join("plugins")
        .join("cache")
        .join("local")
        .join(CODEAGENT_PLUGIN_NAME)
        .join(env!("CARGO_PKG_VERSION"))
}

fn read_json_object(path: &Path, default: Value) -> Result<Value, String> {
    if !path.is_file() {
        return Ok(default);
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} 不是有效 JSON，已停止修改：{error}", path.display()))?;
    if !value.is_object() {
        return Err(format!(
            "{} 的根节点不是 JSON 对象，已停止修改",
            path.display()
        ));
    }
    Ok(value)
}

fn backup_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("无法为 {} 生成备份路径", path.display()))?;
    Ok(path.with_file_name(format!("{file_name}.marginote.bak")))
}

fn protected_write(path: &Path, bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法确定 {} 的父目录", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建 {} 失败：{error}", parent.display()))?;

    let backup = if path.is_file() {
        let backup = backup_path(path)?;
        fs::copy(path, &backup).map_err(|error| {
            format!(
                "备份 {} 到 {} 失败，已停止修改：{error}",
                path.display(),
                backup.display()
            )
        })?;
        Some(backup)
    } else {
        None
    };

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(
        ".marginote-{}-{}-{stamp}.tmp",
        std::process::id(),
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("config")
    ));
    let write_result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("创建临时文件 {} 失败：{error}", temp.display()))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("写入临时文件 {} 失败：{error}", temp.display()))?;

        #[cfg(not(target_os = "windows"))]
        fs::rename(&temp, path)
            .map_err(|error| format!("替换 {} 失败：{error}", path.display()))?;
        #[cfg(target_os = "windows")]
        {
            fs::copy(&temp, path)
                .map_err(|error| format!("替换 {} 失败：{error}", path.display()))?;
            if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
                let _ = file.sync_all();
            }
            fs::remove_file(&temp)
                .map_err(|error| format!("清理临时文件 {} 失败：{error}", temp.display()))?;
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result.map(|_| backup)
}

fn write_json(path: &Path, value: &Value) -> Result<Option<PathBuf>, String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("编码 {} 失败：{error}", path.display()))?;
    bytes.push(b'\n');
    protected_write(path, &bytes)
}

fn utc_timestamp() -> String {
    let total_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = total_seconds / 86_400;
    let seconds = total_seconds % 86_400;
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    let hour = seconds / 3_600;
    let minute = (seconds % 3_600) / 60;
    let second = seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn codeagent_mcp_config(cli_path: &Path) -> Value {
    json!({
        "mcpServers": {
            "marginote": {
                "type": "stdio",
                "command": cli_path.to_string_lossy(),
                "args": ["mcp"]
            }
        }
    })
}

fn codeagent_skill() -> &'static str {
    r#"---
name: marginote
description: 主动查询、记录和整理用户的 Marginote 本地笔记与待办。
---

# Marginote 工作流

- 用户直接询问可能来自个人知识库的事实时，先调用 `search_all`，再根据结果回答。
- 记录信息前先搜索语义相关笔记；高度相关时用 `update_note` 且 `append=true`，无合适笔记时才 `create_note`。
- 新建笔记选择具体标题和合适的 `notebookName`；不存在的笔记本会自动创建。
- 普通读取和非删除写入已授权。删除仅在用户明确要求时执行，并传 `confirmed=true`。
- 批量整理使用 `batch_manage`。写入失败或 `writable=false` 时停止并报告错误，不要绕过 Marginote CLI 直接修改数据文件。
"#
}

fn install_codeagent_at(root: &Path, cli_path: &Path) -> Result<Value, String> {
    let installed_path = codeagent_installed_path(root);
    let settings_path = codeagent_settings_path(root);
    let plugin_dir = codeagent_plugin_dir(root);
    let mcp_path = plugin_dir.join(".mcp.json");
    let extension_path = plugin_dir.join("codeagent-extension.json");
    let skill_path = plugin_dir.join("skills").join("marginote").join("SKILL.md");

    let mut installed = read_json_object(&installed_path, json!({ "version": 2, "plugins": {} }))?;
    let mut settings = read_json_object(&settings_path, json!({}))?;
    let installed_object = installed.as_object_mut().expect("validated object");
    let plugins = installed_object
        .entry("plugins")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            format!(
                "{} 的 plugins 字段不是对象，已停止修改",
                installed_path.display()
            )
        })?;
    let records = plugins
        .entry(CODEAGENT_PLUGIN_KEY)
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| {
            format!(
                "{} 中 {} 的记录不是数组，已停止修改",
                installed_path.display(),
                CODEAGENT_PLUGIN_KEY
            )
        })?;
    let installed_at = records
        .iter()
        .find(|record| record.get("scope").and_then(Value::as_str) == Some("user"))
        .and_then(|record| record.get("installedAt"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(utc_timestamp);
    records.retain(|record| record.get("scope").and_then(Value::as_str) != Some("user"));
    records.push(json!({
        "scope": "user",
        "installPath": plugin_dir.to_string_lossy(),
        "version": env!("CARGO_PKG_VERSION"),
        "installedAt": installed_at,
        "lastUpdated": utc_timestamp(),
        "gitCommitSha": ""
    }));

    let enabled_plugins = settings
        .as_object_mut()
        .expect("validated object")
        .entry("enabledPlugins")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            format!(
                "{} 的 enabledPlugins 字段不是对象，已停止修改",
                settings_path.display()
            )
        })?;
    enabled_plugins.insert(CODEAGENT_PLUGIN_KEY.into(), Value::Bool(true));

    write_json(&mcp_path, &codeagent_mcp_config(cli_path))?;
    write_json(
        &extension_path,
        &json!({
            "name": CODEAGENT_PLUGIN_NAME,
            "displayName": "Marginote",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "连接本地 Marginote 笔记与待办的 MCP 插件"
        }),
    )?;
    protected_write(&skill_path, codeagent_skill().as_bytes())?;
    let installed_backup = write_json(&installed_path, &installed)?;
    let settings_backup = match write_json(&settings_path, &settings) {
        Ok(backup) => backup,
        Err(error) => {
            if let Some(backup) = installed_backup.as_deref() {
                let _ = fs::copy(backup, &installed_path);
            } else {
                let _ = fs::remove_file(&installed_path);
            }
            return Err(error);
        }
    };

    Ok(json!({
        "client": "codeagent",
        "installed": true,
        "alreadyConfigured": false,
        "pluginKey": CODEAGENT_PLUGIN_KEY,
        "pluginPath": plugin_dir.to_string_lossy(),
        "configPath": mcp_path.to_string_lossy(),
        "installedRegistry": installed_path.to_string_lossy(),
        "settingsPath": settings_path.to_string_lossy(),
        "backups": [
            installed_backup.map(|path| path.to_string_lossy().to_string()),
            settings_backup.map(|path| path.to_string_lossy().to_string())
        ],
        "profile": "core",
        "toolCount": 12,
        "restartRequired": true
    }))
}

fn remove_codeagent_at(root: &Path) -> Result<Value, String> {
    let installed_path = codeagent_installed_path(root);
    let settings_path = codeagent_settings_path(root);
    let mut installed = installed_path
        .is_file()
        .then(|| read_json_object(&installed_path, json!({})))
        .transpose()?;
    let mut settings = settings_path
        .is_file()
        .then(|| read_json_object(&settings_path, json!({})))
        .transpose()?;
    let plugin_dir = installed
        .as_ref()
        .and_then(|value| value.get("plugins"))
        .and_then(Value::as_object)
        .and_then(|plugins| plugins.get(CODEAGENT_PLUGIN_KEY))
        .and_then(Value::as_array)
        .and_then(|records| {
            records
                .iter()
                .find(|record| record.get("scope").and_then(Value::as_str) == Some("user"))
        })
        .and_then(|record| record.get("installPath"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| codeagent_plugin_dir(root));
    let mut changed = false;

    if let Some(value) = installed.as_mut() {
        if let Some(plugins) = value.get_mut("plugins").and_then(Value::as_object_mut) {
            let remove_key = if let Some(records) = plugins.get_mut(CODEAGENT_PLUGIN_KEY) {
                let records = records.as_array_mut().ok_or_else(|| {
                    format!(
                        "{} 中 {} 的记录不是数组，已停止修改",
                        installed_path.display(),
                        CODEAGENT_PLUGIN_KEY
                    )
                })?;
                let before = records.len();
                records
                    .retain(|record| record.get("scope").and_then(Value::as_str) != Some("user"));
                changed |= records.len() != before;
                records.is_empty()
            } else {
                false
            };
            if remove_key {
                plugins.remove(CODEAGENT_PLUGIN_KEY);
            }
        }
    }
    if let Some(value) = settings.as_mut() {
        if let Some(enabled) = value
            .get_mut("enabledPlugins")
            .and_then(Value::as_object_mut)
        {
            changed |= enabled.remove(CODEAGENT_PLUGIN_KEY).is_some();
        }
    }

    if !changed {
        return Ok(json!({
            "client": "codeagent",
            "removed": true,
            "alreadyRemoved": true,
            "pluginKey": CODEAGENT_PLUGIN_KEY,
            "cacheRetained": true,
            "cachePath": plugin_dir.to_string_lossy(),
            "backups": [],
            "restartRequired": false
        }));
    }

    let installed_backup = if let Some(value) = installed.as_ref() {
        write_json(&installed_path, value)?
    } else {
        None
    };
    let settings_backup = if let Some(value) = settings.as_ref() {
        match write_json(&settings_path, value) {
            Ok(backup) => backup,
            Err(error) => {
                if let Some(backup) = installed_backup.as_deref() {
                    let _ = fs::copy(backup, &installed_path);
                }
                return Err(error);
            }
        }
    } else {
        None
    };

    Ok(json!({
        "client": "codeagent",
        "removed": true,
        "alreadyRemoved": !changed,
        "pluginKey": CODEAGENT_PLUGIN_KEY,
        "cacheRetained": true,
        "cachePath": plugin_dir.to_string_lossy(),
        "backups": [
            installed_backup.map(|path| path.to_string_lossy().to_string()),
            settings_backup.map(|path| path.to_string_lossy().to_string())
        ],
        "restartRequired": changed
    }))
}

fn codeagent_status_at(root: &Path) -> Value {
    let installed_path = codeagent_installed_path(root);
    let settings_path = codeagent_settings_path(root);
    let expected_plugin_dir = codeagent_plugin_dir(root);
    let installed_result =
        read_json_object(&installed_path, json!({ "version": 2, "plugins": {} }));
    let settings_result = read_json_object(&settings_path, json!({}));
    let registered_record = installed_result.as_ref().ok().and_then(|value| {
        value
            .get("plugins")
            .and_then(Value::as_object)
            .and_then(|plugins| plugins.get(CODEAGENT_PLUGIN_KEY))
            .and_then(Value::as_array)
            .and_then(|records| {
                records
                    .iter()
                    .find(|record| record.get("scope").and_then(Value::as_str) == Some("user"))
            })
    });
    let registered = registered_record.is_some();
    let installed_version = registered_record
        .and_then(|record| record.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let plugin_dir = registered_record
        .and_then(|record| record.get("installPath"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| expected_plugin_dir.clone());
    let mcp_path = plugin_dir.join(".mcp.json");
    let enabled = settings_result.as_ref().is_ok_and(|value| {
        value
            .pointer("/enabledPlugins")
            .and_then(Value::as_object)
            .and_then(|plugins| plugins.get(CODEAGENT_PLUGIN_KEY))
            .and_then(Value::as_bool)
            == Some(true)
    });
    let registry_error = installed_result.err().or_else(|| settings_result.err());
    let configured = registered && enabled && mcp_path.is_file();
    let version_current = installed_version.as_deref() == Some(env!("CARGO_PKG_VERSION"));
    let path_current = plugin_dir == expected_plugin_dir;
    let update_available = configured && (!version_current || !path_current);
    let repair_required = registry_error.is_none() && registered && !configured;
    json!({
        "id": "codeagent",
        "label": "CodeAgent",
        "rootPath": root.to_string_lossy(),
        "rootRequired": false,
        "detected": root.is_dir() || find_command("codeagent").is_some(),
        "executable": find_command("codeagent").map(|path| path.to_string_lossy().to_string()),
        "configured": configured,
        "registered": registered,
        "enabled": enabled,
        "installedVersion": installed_version,
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "versionCurrent": version_current,
        "updateAvailable": update_available,
        "repairRequired": repair_required,
        "pluginKey": CODEAGENT_PLUGIN_KEY,
        "pluginPath": plugin_dir.to_string_lossy(),
        "expectedPluginPath": expected_plugin_dir.to_string_lossy(),
        "configPath": mcp_path.is_file().then(|| mcp_path.to_string_lossy().to_string()),
        "registryError": registry_error
    })
}

fn codeagent_status(explicit_root: Option<&Path>) -> Value {
    match resolve_codeagent_root(explicit_root) {
        Ok(root) => codeagent_status_at(&root),
        Err(error) => json!({
            "id": "codeagent",
            "label": "CodeAgent",
            "detected": find_command("codeagent").is_some(),
            "configured": false,
            "rootRequired": true,
            "registryError": error
        }),
    }
}

fn client_status(client: AgentClient, codeagent_root: Option<&Path>) -> Value {
    if client == AgentClient::CodeAgent {
        return codeagent_status(codeagent_root);
    }
    let executable = client.executable().and_then(find_command);
    let config_path = configured_path(client);
    json!({
        "id": client.as_str(),
        "label": client.label(),
        "detected": executable.is_some(),
        "executable": executable.map(|path| path.to_string_lossy().to_string()),
        "configured": config_path.is_some(),
        "configPath": config_path.map(|path| path.to_string_lossy().to_string())
    })
}

pub fn status(codeagent_root: Option<&Path>) -> Value {
    let cli_path = env::current_exe().ok();
    json!({
        "cli": {
            "available": cli_path.as_ref().is_some_and(|path| path.is_file()),
            "path": cli_path.map(|path| path.to_string_lossy().to_string()),
            "version": env!("CARGO_PKG_VERSION"),
            "mcpCommand": "marginote-cli mcp",
            "mcpProfile": "core",
            "mcpCoreToolCount": 12,
            "mcpFullCommand": "marginote-cli mcp --profile full",
            "mcpFullToolCount": 23
        },
        "clients": [
            client_status(AgentClient::CodeAgent, codeagent_root),
            client_status(AgentClient::Codex, None),
            client_status(AgentClient::Claude, None)
        ]
    })
}

pub fn show(client: AgentClient) -> Value {
    let common_json = json!({
        "mcpServers": {
            "marginote": {
                "type": "stdio",
                "command": "marginote-cli",
                "args": ["mcp"]
            }
        }
    });
    match client {
        AgentClient::CodeAgent => json!({
            "client": client.as_str(),
            "label": client.label(),
            "installCommand": "marginote-cli integrate install codeagent --codeagent-dir <PATH>",
            "removeCommand": "marginote-cli integrate remove codeagent --codeagent-dir <PATH>",
            "pluginKey": CODEAGENT_PLUGIN_KEY,
            "codeagentDirOption": "--codeagent-dir <PATH>",
            "codeagentDirEnvironment": CODEAGENT_DIR_ENV,
            "profile": "core",
            "configFormat": "codeagent-plugin-mcp-json",
            "config": serde_json::to_string_pretty(&common_json).unwrap_or_default(),
            "compatibility": "CodeAgent .cac local plugin"
        }),
        AgentClient::Codex => json!({
            "client": client.as_str(),
            "label": client.label(),
            "installCommand": "codex mcp add marginote -- marginote-cli mcp",
            "profile": "core",
            "configFormat": "toml",
            "config": "[mcp_servers.marginote]\ncommand = \"marginote-cli\"\nargs = [\"mcp\"]\nstartup_timeout_sec = 20\ntool_timeout_sec = 190\n"
        }),
        AgentClient::Claude => json!({
            "client": client.as_str(),
            "label": client.label(),
            "installCommand": "claude mcp add --scope user marginote -- marginote-cli mcp",
            "profile": "core",
            "configFormat": "json",
            "config": serde_json::to_string_pretty(&common_json).unwrap_or_default()
        }),
        AgentClient::Generic => json!({
            "client": client.as_str(),
            "label": client.label(),
            "installCommand": null,
            "profile": "core",
            "configFormat": "json",
            "config": serde_json::to_string_pretty(&common_json).unwrap_or_default()
        }),
    }
}

fn install_args(client: AgentClient) -> Result<Vec<&'static str>, String> {
    match client {
        AgentClient::Claude => Ok(vec![
            "mcp",
            "add",
            "--scope",
            "user",
            "marginote",
            "--",
            "marginote-cli",
            "mcp",
        ]),
        AgentClient::Codex => Ok(vec![
            "mcp",
            "add",
            "marginote",
            "--",
            "marginote-cli",
            "mcp",
        ]),
        AgentClient::CodeAgent => Err("CodeAgent 使用 .cac 本地插件安装，不调用外部命令".into()),
        AgentClient::Generic => Err("通用 MCP 客户端没有统一配置目录，请复制配置手动添加".into()),
    }
}

fn remove_args(client: AgentClient) -> Result<Vec<&'static str>, String> {
    match client {
        AgentClient::Codex => Ok(vec!["mcp", "remove", "marginote"]),
        AgentClient::Claude => Ok(vec!["mcp", "remove", "--scope", "user", "marginote"]),
        AgentClient::CodeAgent => Err("CodeAgent 使用 .cac 本地插件移除，不调用外部命令".into()),
        AgentClient::Generic => Err("通用 MCP 客户端没有统一配置目录，请在客户端中手动移除".into()),
    }
}

fn run_external(executable: &Path, args: &[&str]) -> Result<Output, String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let is_script = executable
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat")
            });
        if is_script {
            let mut command = ProcessCommand::new("cmd.exe");
            command.args(["/D", "/C"]).arg(executable);
            command
        } else {
            let mut command = ProcessCommand::new(executable);
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
            command
        }
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = ProcessCommand::new(executable);

    command
        .args(args)
        .output()
        .map_err(|error| format!("运行 {} 失败：{error}", executable.display()))
}

pub fn install(
    installable: InstallableAgentClient,
    codeagent_root: Option<&Path>,
) -> Result<Value, String> {
    let client = installable.client();
    if client == AgentClient::CodeAgent {
        let root = resolve_codeagent_root(codeagent_root)?;
        let status = codeagent_status_at(&root);
        if status["configured"] == true && status["updateAvailable"] != true {
            return Ok(json!({
                "client": "codeagent",
                "installed": true,
                "alreadyConfigured": true,
                "pluginKey": CODEAGENT_PLUGIN_KEY,
                "configPath": status["configPath"],
                "installedVersion": status["installedVersion"],
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "updated": false,
                "repaired": false,
                "profile": "core",
                "toolCount": 12
            }));
        }
        let cli_path =
            env::current_exe().map_err(|error| format!("无法确定 marginote-cli 路径：{error}"))?;
        let mut result = install_codeagent_at(&root, &cli_path)?;
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "updated".into(),
                Value::Bool(status["updateAvailable"] == true),
            );
            object.insert(
                "repaired".into(),
                Value::Bool(status["registered"] == true && status["updateAvailable"] != true),
            );
            object.insert("previousVersion".into(), status["installedVersion"].clone());
            object.insert("previousPluginPath".into(), status["pluginPath"].clone());
            object.insert(
                "previousCacheRetained".into(),
                Value::Bool(status["registered"] == true),
            );
        }
        return Ok(result);
    }
    if codeagent_root.is_some() {
        return Err("--codeagent-dir 仅适用于 CodeAgent".into());
    }
    if let Some(path) = configured_path(client) {
        return Ok(json!({
            "client": client.as_str(),
            "installed": true,
            "alreadyConfigured": true,
            "configPath": path.to_string_lossy()
        }));
    }
    let executable_name = client
        .executable()
        .ok_or_else(|| "通用 MCP 客户端请使用 integrate show generic 复制配置".to_string())?;
    let executable = find_command(executable_name)
        .ok_or_else(|| format!("未检测到 {}；请先安装并确保命令已加入 PATH", client.label()))?;
    let args = install_args(client)?;
    let output = run_external(&executable, &args)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("{} 集成安装失败：{detail}", client.label()));
    }
    Ok(json!({
        "client": client.as_str(),
        "installed": true,
        "alreadyConfigured": false,
        "output": stdout,
        "restartRequired": true
    }))
}

pub fn remove(
    installable: InstallableAgentClient,
    codeagent_root: Option<&Path>,
) -> Result<Value, String> {
    let client = installable.client();
    if client == AgentClient::CodeAgent {
        let root = resolve_codeagent_root(codeagent_root)?;
        return remove_codeagent_at(&root);
    }
    if codeagent_root.is_some() {
        return Err("--codeagent-dir 仅适用于 CodeAgent".into());
    }
    let executable_name = client
        .executable()
        .ok_or_else(|| "通用 MCP 客户端请在客户端中手动移除配置".to_string())?;
    let executable = find_command(executable_name)
        .ok_or_else(|| format!("未检测到 {}；无法调用其配置命令", client.label()))?;
    let args = remove_args(client)?;
    let output = run_external(&executable, &args)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("{} 集成移除失败：{detail}", client.label()));
    }
    Ok(json!({
        "client": client.as_str(),
        "removed": true,
        "output": stdout,
        "restartRequired": true
    }))
}

pub fn doctor(no_start: bool, codeagent_root: Option<&Path>) -> Value {
    let cli_path = env::current_exe().ok();
    let app_paths = cli_path.as_deref().map(app_candidates).unwrap_or_default();
    let app_path = app_paths.into_iter().find(|path| path.is_file());
    let data_path = data_dir().ok();
    let endpoint_ok = read_endpoint().is_ok();
    let request_id = resolve_request_id(None).unwrap_or_else(|_| "mn-doctor".into());
    let bridge = send_with_start("status", &json!({}), &request_id, no_start);
    let (bridge_ok, bridge_data, bridge_error) = match bridge {
        Ok(response) if response.ok => (true, response.data, None),
        Ok(response) => (false, response.data, response.error),
        Err(error) => (false, None, Some(error)),
    };
    json!({
        "healthy": cli_path.as_ref().is_some_and(|path| path.is_file()) && app_path.is_some() && bridge_ok,
        "checks": {
            "cli": {
                "ok": cli_path.as_ref().is_some_and(|path| path.is_file()),
                "path": cli_path.map(|path| path.to_string_lossy().to_string()),
                "version": env!("CARGO_PKG_VERSION")
            },
            "app": {
                "ok": app_path.is_some(),
                "path": app_path.map(|path| path.to_string_lossy().to_string())
            },
            "dataDirectory": {
                "ok": data_path.as_ref().is_some_and(|path| path.is_dir()),
                "path": data_path.map(|path| path.to_string_lossy().to_string())
            },
            "endpoint": { "ok": endpoint_ok },
            "bridge": {
                "ok": bridge_ok,
                "data": bridge_data,
                "error": bridge_error
            },
            "mcp": {
                "ok": true,
                "transport": "stdio",
                "command": "marginote-cli mcp",
                "profile": "core",
                "toolCount": 12,
                "fullCommand": "marginote-cli mcp --profile full"
            }
        },
        "agents": status(codeagent_root)["clients"].clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_config_uses_official_stdio_table_shape() {
        let config = show(AgentClient::Codex);
        assert!(config["config"]
            .as_str()
            .unwrap()
            .contains("[mcp_servers.marginote]"));
        assert_eq!(
            config["installCommand"],
            "codex mcp add marginote -- marginote-cli mcp"
        );
    }

    #[test]
    fn generic_config_requires_no_extra_runtime() {
        let config = show(AgentClient::Generic);
        let parsed: Value = serde_json::from_str(config["config"].as_str().unwrap()).unwrap();
        assert_eq!(
            parsed["mcpServers"]["marginote"]["command"],
            "marginote-cli"
        );
        assert_eq!(parsed["mcpServers"]["marginote"]["args"][0], "mcp");
    }

    #[test]
    fn codeagent_show_describes_local_cac_plugin() {
        let config = show(AgentClient::CodeAgent);
        let parsed: Value = serde_json::from_str(config["config"].as_str().unwrap()).unwrap();
        assert_eq!(
            config["installCommand"],
            "marginote-cli integrate install codeagent --codeagent-dir <PATH>"
        );
        assert_eq!(config["pluginKey"], CODEAGENT_PLUGIN_KEY);
        assert_eq!(config["compatibility"], "CodeAgent .cac local plugin");
        assert_eq!(
            parsed["mcpServers"]["marginote"]["command"],
            "marginote-cli"
        );
        assert_eq!(parsed["mcpServers"]["marginote"]["args"][0], "mcp");
    }

    #[test]
    fn install_commands_delegate_to_agent_clis() {
        assert!(install_args(AgentClient::CodeAgent).is_err());
        assert_eq!(
            install_args(AgentClient::Codex).unwrap()[0..3],
            ["mcp", "add", "marginote"]
        );
        assert!(install_args(AgentClient::Claude)
            .unwrap()
            .windows(2)
            .any(|values| values == ["--scope", "user"]));
        assert!(install_args(AgentClient::Generic).is_err());
        assert_eq!(
            remove_args(AgentClient::Codex).unwrap(),
            ["mcp", "remove", "marginote"]
        );
        assert!(remove_args(AgentClient::Claude)
            .unwrap()
            .windows(2)
            .any(|values| values == ["--scope", "user"]));
        assert!(remove_args(AgentClient::CodeAgent).is_err());
    }

    fn test_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "marginote-codeagent-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("plugins")).unwrap();
        root
    }

    #[test]
    fn codeagent_install_preserves_existing_plugins_and_is_reversible() {
        let root = test_root("install");
        let installed_path = codeagent_installed_path(&root);
        let settings_path = codeagent_settings_path(&root);
        fs::write(
            &installed_path,
            serde_json::to_vec_pretty(&json!({
                "version": 2,
                "plugins": {
                    "codebase-win@aimarket": [{
                        "scope": "user",
                        "installPath": "C:\\existing",
                        "version": "1.0.0"
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            &settings_path,
            serde_json::to_vec_pretty(&json!({
                "permissions": { "allow": ["Bash(*)"] },
                "enabledPlugins": { "codebase-win@aimarket": true }
            }))
            .unwrap(),
        )
        .unwrap();

        let cli_path = PathBuf::from("C:\\Program Files\\Marginote\\marginote-cli.exe");
        let result = install_codeagent_at(&root, &cli_path).unwrap();
        assert_eq!(result["installed"], true);
        let installed: Value =
            serde_json::from_str(&fs::read_to_string(&installed_path).unwrap()).unwrap();
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert!(installed["plugins"]["codebase-win@aimarket"].is_array());
        assert!(installed["plugins"][CODEAGENT_PLUGIN_KEY].is_array());
        assert_eq!(settings["permissions"]["allow"][0], "Bash(*)");
        assert_eq!(settings["enabledPlugins"]["codebase-win@aimarket"], true);
        assert_eq!(settings["enabledPlugins"][CODEAGENT_PLUGIN_KEY], true);

        let plugin_dir = codeagent_plugin_dir(&root);
        let mcp: Value =
            serde_json::from_str(&fs::read_to_string(plugin_dir.join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(
            mcp["mcpServers"]["marginote"]["command"],
            cli_path.to_string_lossy().as_ref()
        );
        assert!(plugin_dir
            .join("skills")
            .join("marginote")
            .join("SKILL.md")
            .is_file());
        assert_eq!(codeagent_status_at(&root)["configured"], true);
        assert!(backup_path(&installed_path).unwrap().is_file());
        assert!(backup_path(&settings_path).unwrap().is_file());

        let removed = remove_codeagent_at(&root).unwrap();
        assert_eq!(removed["removed"], true);
        assert_eq!(removed["cacheRetained"], true);
        let installed: Value =
            serde_json::from_str(&fs::read_to_string(&installed_path).unwrap()).unwrap();
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert!(installed["plugins"]["codebase-win@aimarket"].is_array());
        assert!(installed["plugins"].get(CODEAGENT_PLUGIN_KEY).is_none());
        assert_eq!(settings["enabledPlugins"]["codebase-win@aimarket"], true);
        assert!(settings["enabledPlugins"]
            .get(CODEAGENT_PLUGIN_KEY)
            .is_none());
        assert!(plugin_dir.is_dir());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn codeagent_upgrade_switches_registry_and_retains_previous_cache() {
        let root = test_root("upgrade");
        let installed_path = codeagent_installed_path(&root);
        let settings_path = codeagent_settings_path(&root);
        let old_plugin_dir = root
            .join("plugins")
            .join("cache")
            .join("local")
            .join(CODEAGENT_PLUGIN_NAME)
            .join("1.2.3");
        fs::create_dir_all(&old_plugin_dir).unwrap();
        fs::write(
            old_plugin_dir.join(".mcp.json"),
            serde_json::to_vec_pretty(&codeagent_mcp_config(Path::new(
                "C:\\Old Marginote\\marginote-cli.exe",
            )))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            &installed_path,
            serde_json::to_vec_pretty(&json!({
                "version": 2,
                "plugins": {
                    (CODEAGENT_PLUGIN_KEY): [{
                        "scope": "user",
                        "installPath": old_plugin_dir.to_string_lossy(),
                        "version": "1.2.3",
                        "installedAt": "2026-01-01T00:00:00.000Z"
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            &settings_path,
            serde_json::to_vec_pretty(&json!({
                "enabledPlugins": { (CODEAGENT_PLUGIN_KEY): true }
            }))
            .unwrap(),
        )
        .unwrap();

        let before = codeagent_status_at(&root);
        assert_eq!(before["configured"], true);
        assert_eq!(before["installedVersion"], "1.2.3");
        assert_eq!(before["updateAvailable"], true);

        let result = install(InstallableAgentClient::CodeAgent, Some(&root)).unwrap();
        assert_eq!(result["updated"], true);
        assert_eq!(result["previousVersion"], "1.2.3");
        assert_eq!(result["previousCacheRetained"], true);
        assert!(old_plugin_dir.is_dir());

        let installed: Value =
            serde_json::from_str(&fs::read_to_string(&installed_path).unwrap()).unwrap();
        let record = &installed["plugins"][CODEAGENT_PLUGIN_KEY][0];
        assert_eq!(record["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            record["installPath"],
            codeagent_plugin_dir(&root).to_string_lossy().as_ref()
        );
        let after = codeagent_status_at(&root);
        assert_eq!(after["configured"], true);
        assert_eq!(after["updateAvailable"], false);
        let repeated = install(InstallableAgentClient::CodeAgent, Some(&root)).unwrap();
        assert_eq!(repeated["alreadyConfigured"], true);
        assert_eq!(repeated["updated"], false);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn codeagent_install_never_overwrites_invalid_user_json() {
        let root = test_root("invalid");
        let installed_path = codeagent_installed_path(&root);
        let settings_path = codeagent_settings_path(&root);
        fs::write(&installed_path, br#"{"version":2,"plugins":{}}"#).unwrap();
        fs::write(&settings_path, b"{ invalid").unwrap();

        let error = install_codeagent_at(&root, Path::new("marginote-cli.exe")).unwrap_err();
        assert!(error.contains("不是有效 JSON"));
        assert_eq!(fs::read_to_string(&settings_path).unwrap(), "{ invalid");
        assert!(!codeagent_plugin_dir(&root).exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn status_reports_core_and_full_mcp_profiles() {
        let status = status(None);
        assert_eq!(status["cli"]["mcpProfile"], "core");
        assert_eq!(status["cli"]["mcpCoreToolCount"], 12);
        assert_eq!(status["cli"]["mcpFullToolCount"], 23);
        assert_eq!(
            status["cli"]["mcpFullCommand"],
            "marginote-cli mcp --profile full"
        );
    }

    #[test]
    fn explicit_codeagent_root_is_validated_and_reported() {
        let root = test_root("explicit-root");
        let resolved = resolve_codeagent_root(Some(&root)).unwrap();
        assert_eq!(resolved, root.canonicalize().unwrap());

        let status = status(Some(&root));
        let codeagent = &status["clients"][0];
        assert_eq!(codeagent["rootRequired"], false);
        assert_eq!(
            codeagent["rootPath"],
            root.canonicalize().unwrap().to_string_lossy().as_ref()
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn invalid_explicit_codeagent_root_is_never_created() {
        let root = env::temp_dir().join(format!(
            "marginote-missing-codeagent-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let error = resolve_codeagent_root(Some(&root)).unwrap_err();
        assert!(error.contains("不存在"));
        assert!(!root.exists());
    }
}
