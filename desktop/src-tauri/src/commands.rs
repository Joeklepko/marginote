// Marginote 桌面 Tauri 命令实现。
// fetch: reqwest（每请求独立 Client，支持 HTTP/HTTPS/SOCKS 代理 + Basic Auth）
// alarms: 委托给 scheduler 模块（tokio 定时任务）
// window: 直接 Tauri Window API

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{scheduler, storage};

// 当前已注册的全局快捷键（用于注销时拿到原 combo）
static CURRENT_HOTKEY: Mutex<Option<Shortcut>> = Mutex::new(None);

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
    pub _provider_host: Option<String>,
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
    // 27B 级本地模型在首次加载或长笔记推理时可能超过 60 秒。该路径用于桌面端
    // HTTP/代理请求，适度放宽总超时，前端仍可显示执行状态并处理失败。
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
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

// ---------- 全局快捷键 ----------

#[tauri::command]
pub async fn cmd_register_hotkey(app: AppHandle, combo: String) -> Result<(), String> {
    let shortcut = Shortcut::from_str(&combo).map_err(|e| format!("invalid combo '{combo}': {e:?}"))?;

    // 先注销旧的
    {
        let mut guard = CURRENT_HOTKEY.lock().map_err(|e| format!("lock: {e}"))?;
        if let Some(old) = guard.take() {
            let _ = app.global_shortcut().unregister(old);
        }
        *guard = Some(shortcut);
    }

    let app_clone = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _scut, event| {
            // 只在按下时触发，避免抬起也触发
            if event.state == ShortcutState::Pressed {
                if let Some(w) = app_clone.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .map_err(|e| format!("hotkey register fail: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_unregister_hotkey(app: AppHandle) -> Result<(), String> {
    let mut guard = CURRENT_HOTKEY.lock().map_err(|e| format!("lock: {e}"))?;
    if let Some(old) = guard.take() {
        let _ = app.global_shortcut().unregister(old);
    }
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

// ---------- 应用数据目录（用于设置·数据·备份显示真实路径） ----------

#[derive(Debug, Serialize)]
pub struct AppPaths {
    /// app_data_dir，例：%APPDATA%\com.marginote.app
    pub data_dir: String,
    /// marginote.dat 全路径（mn.platform.storage 写在这里）
    pub kv_file: String,
    /// WebView2 实例目录（笔记 / 待办 bulk 数据走 localStorage 实际落地点）
    pub webview_dir: String,
}

#[tauri::command]
pub async fn cmd_get_app_paths(app: AppHandle) -> Result<AppPaths, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let kv_file = data_dir.join(crate::storage::FILE);
    // WebView2 在 app_data_dir 下的 EBWebView/Default/Local Storage（Tauri 2 默认）
    let webview_dir = data_dir.join("EBWebView").join("Default").join("Local Storage");
    Ok(AppPaths {
        data_dir: data_dir.to_string_lossy().to_string(),
        kv_file: kv_file.to_string_lossy().to_string(),
        webview_dir: webview_dir.to_string_lossy().to_string(),
    })
}

// ---------- 流式 fetch（SSE 逐块推送到前端） ----------

#[derive(Debug, Serialize, Clone)]
pub struct StreamChunk {
    pub stream_id: String,
    pub data: String,        // SSE data payload
    pub done: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn cmd_stream_fetch(
    app: AppHandle,
    url: String,
    stream_id: String,
    method: Option<String>,
    headers: Option<serde_json::Value>,
    body: Option<String>,
) -> Result<(), String> {
    let method = method.unwrap_or_else(|| "POST".into()).to_uppercase();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let mut req = match method.as_str() {
        "GET" => client.get(&url),
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

    let resp = req.send().await.map_err(|e| {
        let _ = app.emit("ai-stream-chunk", StreamChunk {
            stream_id: stream_id.clone(),
            data: String::new(),
            done: true,
            error: Some(format!("{e}")),
        });
        format!("{e}")
    })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let txt = resp.text().await.unwrap_or_default();
        let _ = app.emit("ai-stream-chunk", StreamChunk {
            stream_id: stream_id.clone(),
            data: String::new(),
            done: true,
            error: Some(format!("HTTP {status}: {txt}")),
        });
        return Err(format!("HTTP {status}"));
    }

    // 读取流式响应体的 chunk，逐塊发送给前端
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes).to_string();
                let _ = app.emit("ai-stream-chunk", StreamChunk {
                    stream_id: stream_id.clone(),
                    data: chunk,
                    done: false,
                    error: None,
                });
            }
            Err(e) => {
                let _ = app.emit("ai-stream-chunk", StreamChunk {
                    stream_id: stream_id.clone(),
                    data: String::new(),
                    done: true,
                    error: Some(format!("stream error: {e}")),
                });
                return Err(format!("{e}"));
            }
        }
    }

    let _ = app.emit("ai-stream-chunk", StreamChunk {
        stream_id: stream_id.clone(),
        data: String::new(),
        done: true,
        error: None,
    });

    Ok(())
}

#[tauri::command]
pub async fn cmd_set_window_theme(window: tauri::Window, mode: String) -> Result<(), String> {
    use tauri::Theme;
    let theme = match mode.as_str() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None, // 跟随系统
    };
    window
        .set_theme(theme)
        .map_err(|e| format!("set_theme: {e}"))
}
