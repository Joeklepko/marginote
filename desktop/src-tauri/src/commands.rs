// Marginote 桌面 Tauri 命令实现。
// fetch: reqwest（每请求独立 Client，支持 HTTP/HTTPS/SOCKS 代理 + Basic Auth）
// alarms: 委托给 scheduler 模块（tokio 定时任务）
// window: 直接 Tauri Window API

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

use crate::{scheduler, storage};

// ---------- 类型 ----------

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

#[derive(Debug, Serialize, Clone)]
pub struct AlarmInfo {
    pub name: String,
    #[serde(rename = "scheduledTime")]
    pub scheduled_time: i64,
}

// ---------- fetch ----------

#[tauri::command]
pub async fn cmd_fetch(
    url: String,
    method: Option<String>,
    headers: Option<serde_json::Value>,
    body: Option<String>,
    proxy: Option<ProxyConfig>,
) -> Result<FetchResponse, String> {
    let method = method.unwrap_or_else(|| "POST".into()).to_uppercase();

    // 构建 Client（按需带代理）
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .danger_accept_invalid_certs(false);

    if let Some(p) = proxy {
        let proxy_url = format!("{}://{}:{}", p.scheme, p.host, p.port);
        let mut rp = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("invalid proxy url '{}': {}", proxy_url, e))?;
        if let Some(user) = p.user.as_deref() {
            if !user.is_empty() {
                rp = rp.basic_auth(user, p.pass.as_deref().unwrap_or(""));
            }
        }
        builder = builder.proxy(rp);
    }

    let client = builder
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    // 拼请求
    let mut req = match method.as_str() {
        "GET" => client.get(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        _ => client.post(&url),
    };

    if let Some(hdrs) = headers {
        if let Some(obj) = hdrs.as_object() {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    req = req.header(k, s);
                }
            }
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    // 发请求
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let ok = resp.status().is_success();
            let body = resp.text().await.unwrap_or_default();
            Ok(FetchResponse { ok, status, body, error: None })
        }
        Err(e) => Ok(FetchResponse {
            ok: false,
            status: 0,
            body: String::new(),
            error: Some(format!("{e}")),
        }),
    }
}

// ---------- alarms ----------

#[tauri::command]
pub async fn cmd_alarm_set(app: AppHandle, name: String, when_ms: i64) -> Result<(), String> {
    scheduler::set_alarm(&app, name, when_ms).await
}

#[tauri::command]
pub async fn cmd_alarm_clear(app: AppHandle, name: String) -> Result<(), String> {
    scheduler::clear_alarm(&app, name).await
}

#[tauri::command]
pub async fn cmd_alarm_list(app: AppHandle) -> Result<Vec<AlarmInfo>, String> {
    scheduler::list_alarms(&app).await
}

// ---------- window ----------

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

// ---------- key-value 存储（marginote.dat）----------

#[tauri::command]
pub async fn cmd_kv_get(app: AppHandle, key: String) -> Result<Value, String> {
    Ok(storage::get(&app, &key))
}

#[tauri::command]
pub async fn cmd_kv_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    storage::set(&app, key, value)
}

#[tauri::command]
pub async fn cmd_kv_remove(app: AppHandle, key: String) -> Result<(), String> {
    storage::remove(&app, &key)
}

#[tauri::command]
pub async fn cmd_kv_keys(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(storage::keys(&app))
}
