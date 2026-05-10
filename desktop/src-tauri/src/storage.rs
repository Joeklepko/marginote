// 简易 KV 文件存储：marginote.dat 是 app_data_dir 下一个 JSON 对象。
// 用作 mn.platform.storage 的桌面端持久化（仅供 Rust + 前端共享 key 使用，
// 例如 alarm 触发时 Rust 读 `marginoteTodos` 找到 todo 元数据）。
//
// 不替代 localStorage —— app.js 的笔记/笔记本/图片/todos bulk 数据继续走
// WebView 自带的 localStorage，桌面端原生支持。

use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const FILE: &str = "marginote.dat";

// 简单进程内锁，避免并发写竞态（粒度足够）
static LOCK: Mutex<()> = Mutex::new(());

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    Ok(dir.join(FILE))
}

pub fn load(app: &AppHandle) -> Value {
    let p = match path(app) {
        Ok(p) => p,
        Err(_) => return Value::Object(Map::new()),
    };
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Object(Map::new()))
}

pub fn save(app: &AppHandle, data: &Value) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let p = path(app)?;
    let s = serde_json::to_string(data).map_err(|e| format!("encode: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write {}: {e}", p.display()))
}

pub fn get(app: &AppHandle, key: &str) -> Value {
    load(app).get(key).cloned().unwrap_or(Value::Null)
}

pub fn set(app: &AppHandle, key: String, value: Value) -> Result<(), String> {
    let mut data = load(app);
    if let Some(obj) = data.as_object_mut() {
        obj.insert(key, value);
    } else {
        let mut m = Map::new();
        m.insert(key, value);
        data = Value::Object(m);
    }
    save(app, &data)
}

pub fn remove(app: &AppHandle, key: &str) -> Result<(), String> {
    let mut data = load(app);
    if let Some(obj) = data.as_object_mut() {
        obj.remove(key);
    }
    save(app, &data)
}

pub fn keys(app: &AppHandle) -> Vec<String> {
    load(app)
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}
