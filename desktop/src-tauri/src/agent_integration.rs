use serde_json::{json, Value};
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

fn cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current) = env::current_exe() {
        if let Some(directory) = current.parent() {
            #[cfg(target_os = "windows")]
            candidates.push(directory.join("marginote-cli.exe"));
            #[cfg(not(target_os = "windows"))]
            candidates.push(directory.join("marginote-cli"));
        }
    }
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            #[cfg(target_os = "windows")]
            candidates.push(directory.join("marginote-cli.exe"));
            #[cfg(not(target_os = "windows"))]
            candidates.push(directory.join("marginote-cli"));
        }
    }
    candidates
}

fn find_cli() -> Result<PathBuf, String> {
    cli_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "未找到 marginote-cli；请重新运行 Marginote 安装包修复安装".into())
}

fn command_args(
    action: &str,
    client: Option<&str>,
    config_dir: Option<&str>,
) -> Result<Vec<String>, String> {
    let client = client.unwrap_or("");
    let config_dir = config_dir.map(str::trim).filter(|value| !value.is_empty());
    let mut args = match action {
        "status" => vec!["integrate".into(), "status".into()],
        "doctor" => vec!["doctor".into()],
        "show" if matches!(client, "codeagent" | "codex" | "claude" | "generic") => {
            vec!["integrate".into(), "show".into(), client.into()]
        }
        "install" if matches!(client, "codeagent" | "codex" | "claude") => {
            vec!["integrate".into(), "install".into(), client.into()]
        }
        "remove" if matches!(client, "codeagent" | "codex" | "claude") => {
            vec!["integrate".into(), "remove".into(), client.into()]
        }
        "show" | "install" | "remove" => return Err("不支持的 Agent 客户端".into()),
        _ => return Err("不支持的 Agent 集成操作".into()),
    };
    if let Some(path) = config_dir {
        let supports_path = matches!(action, "status" | "doctor")
            || matches!(action, "install" | "remove") && client == "codeagent";
        if !supports_path {
            return Err("CodeAgent 配置目录仅适用于 CodeAgent 状态、诊断、安装和移除".into());
        }
        if path.contains('\0') {
            return Err("CodeAgent 配置目录包含无效字符".into());
        }
        args.push("--codeagent-dir".into());
        args.push(path.into());
    }
    args.push("--json".into());
    Ok(args)
}

fn run_cli(path: &Path, args: &[String]) -> Result<Output, String> {
    let mut command = Command::new(path);
    command.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .output()
        .map_err(|error| format!("启动 {} 失败：{error}", path.display()))
}

fn execute(
    action: String,
    client: Option<String>,
    config_dir: Option<String>,
) -> Result<Value, String> {
    let path = find_cli()?;
    let args = command_args(&action, client.as_deref(), config_dir.as_deref())?;
    let output = run_cli(&path, &args)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let exit_code = output.status.code().unwrap_or(-1);
    if let Ok(mut value) = serde_json::from_str::<Value>(&stdout) {
        if let Some(object) = value.as_object_mut() {
            object.insert("exitCode".into(), Value::from(exit_code));
            object.insert(
                "cliPath".into(),
                Value::String(path.to_string_lossy().to_string()),
            );
            if !stderr.is_empty() {
                object.insert("stderr".into(), Value::String(stderr));
            }
        }
        return Ok(value);
    }
    Ok(json!({
        "ok": output.status.success(),
        "exitCode": exit_code,
        "cliPath": path.to_string_lossy(),
        "data": if stdout.is_empty() { Value::Null } else { Value::String(stdout) },
        "error": if output.status.success() || stderr.is_empty() { Value::Null } else { Value::String(stderr) }
    }))
}

#[tauri::command]
pub async fn cmd_agent_integration(
    action: String,
    client: Option<String>,
    config_dir: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || execute(action, client, config_dir))
        .await
        .map_err(|error| format!("Agent 集成任务异常：{error}"))?
}

#[tauri::command]
pub async fn cmd_agent_pick_config_dir(app: AppHandle) -> Result<Option<String>, String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .as_path()
        .ok_or_else(|| "CodeAgent 配置目录路径解析失败".to_string())?;
    if !path.is_dir() {
        return Err("所选路径不是有效目录".into());
    }
    let path = path
        .canonicalize()
        .map_err(|error| format!("无法解析 CodeAgent 配置目录：{error}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowlisted_agent_actions_can_run() {
        assert_eq!(
            command_args("install", Some("codeagent"), None).unwrap(),
            ["integrate", "install", "codeagent", "--json"]
        );
        assert_eq!(
            command_args("show", Some("codex"), None).unwrap(),
            ["integrate", "show", "codex", "--json"]
        );
        assert!(command_args("install", Some("generic"), None).is_err());
        assert_eq!(
            command_args("remove", Some("claude"), None).unwrap(),
            ["integrate", "remove", "claude", "--json"]
        );
        assert!(command_args("shell", Some("codex"), None).is_err());
        assert!(command_args("show", Some("../../cmd.exe"), None).is_err());
    }

    #[test]
    fn codeagent_directory_is_forwarded_as_one_process_argument() {
        assert_eq!(
            command_args(
                "install",
                Some("codeagent"),
                Some("C:\\Users\\demo user\\.cac")
            )
            .unwrap(),
            [
                "integrate",
                "install",
                "codeagent",
                "--codeagent-dir",
                "C:\\Users\\demo user\\.cac",
                "--json"
            ]
        );
        assert!(command_args("install", Some("codex"), Some("C:\\.cac")).is_err());
    }
}
