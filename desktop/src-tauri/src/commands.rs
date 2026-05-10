// Tauri 命令骨架。P2 阶段只是占位以保证 lib.rs 编译；
// P3 会替换为基于 reqwest / tokio 的真实实现。

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct FetchResponse {
    pub ok: bool,
    pub status: u16,
    pub body: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ProxyConfig {
    #[serde(rename = "providerHost")]
    pub provider_host: Option<String>,
    pub host: String,
    pub port: String,
    pub scheme: String,
    pub user: Option<String>,
    pub pass: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AlarmInfo {
    pub name: String,
    #[serde(rename = "scheduledTime")]
    pub scheduled_time: i64,
}

#[tauri::command]
pub async fn cmd_fetch(
    _url: String,
    _method: Option<String>,
    _headers: Option<serde_json::Value>,
    _body: Option<String>,
    _proxy: Option<ProxyConfig>,
) -> Result<FetchResponse, String> {
    Err("cmd_fetch not yet implemented (P3)".into())
}

#[tauri::command]
pub async fn cmd_alarm_set(_name: String, _when_ms: i64) -> Result<(), String> {
    Err("cmd_alarm_set not yet implemented (P3)".into())
}

#[tauri::command]
pub async fn cmd_alarm_clear(_name: String) -> Result<(), String> {
    Err("cmd_alarm_clear not yet implemented (P3)".into())
}

#[tauri::command]
pub async fn cmd_alarm_list() -> Result<Vec<AlarmInfo>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn cmd_window_focus(window: tauri::Window) -> Result<(), String> {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn cmd_window_hide(window: tauri::Window) -> Result<(), String> {
    let _ = window.hide();
    Ok(())
}
