// 闹钟调度器：用 tokio 实现的 chrome.alarms 替代品。
// 每个 alarm 对应一个 tokio task，到点后从 store 读取 marginoteTodos 找到对应 todo
// 并通过 tauri-plugin-notification 弹出系统通知。
//
// alarm name 形如 "mtodo:<todoId>:<index>"，与扩展端约定一致。

use crate::commands::AlarmInfo;
use crate::storage;
use notify_rust::{Notification, Timeout, Urgency};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri::{AppHandle, Emitter};
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
    #[serde(default)]
    done: bool,
    #[serde(rename = "dueDate")]
    due_date: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReminderSnoozeEvent {
    todo_id: String,
    minutes: i64,
    when_ms: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReminderFiredEvent {
    todo_id: String,
    alarm_name: String,
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

fn snooze_minutes(action: &str) -> Option<i64> {
    match action {
        "snooze-60" => Some(60),
        "snooze-1440" => Some(1440),
        _ => None,
    }
}

fn fire_notification(app: &AppHandle, alarm_name: &str) {
    let todos = load_todos(app);
    let todo_id = parse_todo_id_from_alarm(alarm_name).unwrap_or("");
    let todo = todos.iter().find(|t| t.id == todo_id);

    let Some(todo) = todo else {
        return;
    };
    if todo.done {
        return;
    }

    let label = todo.text.clone().unwrap_or_else(|| "（无标题）".into());
    let body = match todo.due_date {
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
    let title = format!("待办提醒：{label}");
    let todo_id = todo.id.clone();

    let _ = app.emit(
        "marginote-reminder-fired",
        ReminderFiredEvent {
            todo_id: todo_id.clone(),
            alarm_name: alarm_name.to_string(),
        },
    );

    let mut notification = Notification::new();
    notification
        .summary(&title)
        .body(&body)
        .timeout(Timeout::Never)
        .urgency(Urgency::Critical)
        .action("snooze-60", "1 小时后提醒")
        .action("snooze-1440", "1 天后提醒")
        .action("dismiss", "关闭");
    #[cfg(target_os = "windows")]
    notification.app_id(&app.config().identifier);

    let Ok(handle) = notification.show() else {
        return;
    };
    let action_app = app.clone();
    let _ = std::thread::Builder::new()
        .name("marginote-reminder-action".into())
        .spawn(move || {
            handle.wait_for_action(move |action| {
                let Some(minutes) = snooze_minutes(action) else {
                    return;
                };
                let _ = action_app.emit(
                    "marginote-reminder-snooze",
                    ReminderSnoozeEvent {
                        todo_id,
                        minutes,
                        when_ms: now_ms() + minutes * 60_000,
                    },
                );
            });
        });
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
        REGISTRY.lock().ok().and_then(|mut m| m.remove(&name_clone));
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
    let reg = REGISTRY.lock().map_err(|e| format!("registry lock: {e}"))?;
    Ok(reg
        .iter()
        .map(|(name, entry)| AlarmInfo {
            name: name.clone(),
            scheduled_time: entry.scheduled_ms,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alarm_name_keeps_todo_identity_for_snooze() {
        assert_eq!(
            parse_todo_id_from_alarm("mtodo:t-123:snooze"),
            Some("t-123")
        );
        assert_eq!(parse_todo_id_from_alarm("other:t-123:snooze"), None);
    }

    #[test]
    fn only_supported_notification_actions_create_snoozes() {
        assert_eq!(snooze_minutes("snooze-60"), Some(60));
        assert_eq!(snooze_minutes("snooze-1440"), Some(1440));
        assert_eq!(snooze_minutes("dismiss"), None);
    }
}
