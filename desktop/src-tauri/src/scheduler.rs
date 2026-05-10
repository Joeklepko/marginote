// 闹钟调度器：用 tokio 实现的 chrome.alarms 替代品。
// 每个 alarm 对应一个 tokio task，到点后从 store 读取 marginoteTodos 找到对应 todo
// 并通过 tauri-plugin-notification 弹出系统通知。
//
// alarm name 形如 "mtodo:<todoId>:<index>"，与扩展端约定一致。

use crate::commands::AlarmInfo;
use crate::storage;
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tokio::task::JoinHandle;

const TODO_KEY: &str = "marginoteTodos";

// 进程内 alarm 注册表（name → handle + scheduled_time）
struct AlarmEntry {
    handle: JoinHandle<()>,
    scheduled_ms: i64,
}

static REGISTRY: Lazy<Mutex<HashMap<String, AlarmEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Deserialize)]
struct TodoSnapshot {
    id: String,
    text: Option<String>,
    #[serde(rename = "dueDate")]
    due_date: Option<i64>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_todo_id_from_alarm(name: &str) -> Option<&str> {
    // alarm name: "mtodo:<todoId>:<index>"
    let stripped = name.strip_prefix("mtodo:")?;
    Some(stripped.split(':').next().unwrap_or(""))
}

fn load_todos(app: &AppHandle) -> Vec<TodoSnapshot> {
    let v = storage::get(app, TODO_KEY);
    serde_json::from_value::<Vec<TodoSnapshot>>(v).unwrap_or_default()
}

fn fire_notification(app: &AppHandle, alarm_name: &str) {
    let todos = load_todos(app);
    let todo_id = parse_todo_id_from_alarm(alarm_name).unwrap_or("");
    let todo = todos.iter().find(|t| t.id == todo_id);

    let (title, body) = if let Some(t) = todo {
        let label = t.text.clone().unwrap_or_else(|| "（无标题）".into());
        let body_text = match t.due_date {
            Some(due) => {
                let min_left = (due - now_ms()) / 60_000;
                if min_left > 60 {
                    format!("{} 小时后到期", min_left / 60)
                } else if min_left > 0 {
                    format!("{} 分钟后到期", min_left)
                } else if min_left == 0 {
                    "现在到期".into()
                } else {
                    format!("已逾期 {} 分钟", -min_left)
                }
            }
            None => "无截止时间".into(),
        };
        (format!("待办提醒：{label}"), body_text)
    } else {
        ("待办提醒".into(), format!("alarm: {}", alarm_name))
    };

    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

pub async fn set_alarm(app: &AppHandle, name: String, when_ms: i64) -> Result<(), String> {
    // 已存在同名 alarm 则先取消
    let _ = clear_alarm(app, name.clone()).await;

    let delay_ms = when_ms - now_ms();
    if delay_ms <= 0 {
        // 已过期：直接触发一次
        fire_notification(app, &name);
        return Ok(());
    }
    let delay = Duration::from_millis(delay_ms as u64);
    let app_clone = app.clone();
    let name_clone = name.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        fire_notification(&app_clone, &name_clone);
        REGISTRY
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&name_clone));
    });

    if let Ok(mut reg) = REGISTRY.lock() {
        reg.insert(
            name,
            AlarmEntry {
                handle,
                scheduled_ms: when_ms,
            },
        );
    }
    Ok(())
}

pub async fn clear_alarm(_app: &AppHandle, name: String) -> Result<(), String> {
    if let Ok(mut reg) = REGISTRY.lock() {
        if let Some(entry) = reg.remove(&name) {
            entry.handle.abort();
        }
    }
    Ok(())
}

pub async fn list_alarms(_app: &AppHandle) -> Result<Vec<AlarmInfo>, String> {
    let reg = REGISTRY
        .lock()
        .map_err(|e| format!("registry lock: {e}"))?;
    Ok(reg
        .iter()
        .map(|(name, entry)| AlarmInfo {
            name: name.clone(),
            scheduled_time: entry.scheduled_ms,
        })
        .collect())
}
