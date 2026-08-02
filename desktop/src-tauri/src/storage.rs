// 简易 KV 文件存储：marginote.dat 是 app_data_dir 下一个 JSON 对象。
// 用作 mn.platform.storage 的桌面端持久化（仅供 Rust + 前端共享 key 使用，
// 例如 alarm 触发时 Rust 读 `marginoteTodos` 找到 todo 元数据）。
//
// 不替代 localStorage —— app.js 的笔记/笔记本/图片/todos bulk 数据继续走
// WebView 自带的 localStorage，桌面端原生支持。

use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::atomic_file;

pub const FILE: &str = "marginote.dat";

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

fn read_object(p: &Path) -> Result<Value, String> {
    let raw = match fs::read_to_string(p) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Value::Object(Map::new()));
        }
        Err(error) => return Err(format!("read {}: {error}", p.display())),
    };
    let value: Value =
        serde_json::from_str(&raw).map_err(|error| format!("decode {}: {error}", p.display()))?;
    if !value.is_object() {
        return Err(format!(
            "decode {}: root must be a JSON object",
            p.display()
        ));
    }
    Ok(value)
}

fn write_object(p: &Path, data: &Value) -> Result<(), String> {
    if !data.is_object() {
        return Err("storage root must be a JSON object".into());
    }
    let s = serde_json::to_string(data).map_err(|e| format!("encode: {e}"))?;
    atomic_file::write(p, s.as_bytes()).map_err(|e| format!("write {}: {e}", p.display()))
}

fn set_at_path(p: &Path, key: String, value: Value) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let mut data = read_object(p)?;
    data.as_object_mut()
        .expect("read_object always returns an object")
        .insert(key, value);
    write_object(p, &data)
}

fn remove_at_path(p: &Path, key: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let mut data = read_object(p)?;
    data.as_object_mut()
        .expect("read_object always returns an object")
        .remove(key);
    write_object(p, &data)
}

pub fn load(app: &AppHandle) -> Value {
    let Ok(_guard) = LOCK.lock() else {
        return Value::Object(Map::new());
    };
    let Ok(p) = path(app) else {
        return Value::Object(Map::new());
    };
    match read_object(&p) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Marginote storage load failed: {error}");
            Value::Object(Map::new())
        }
    }
}

pub fn get(app: &AppHandle, key: &str) -> Value {
    load(app).get(key).cloned().unwrap_or(Value::Null)
}

pub fn set(app: &AppHandle, key: String, value: Value) -> Result<(), String> {
    set_at_path(&path(app)?, key, value)
}

pub fn remove(app: &AppHandle, key: &str) -> Result<(), String> {
    remove_at_path(&path(app)?, key)
}

pub fn keys(app: &AppHandle) -> Vec<String> {
    load(app)
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "marginote-storage-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        dir.join(FILE)
    }

    #[test]
    fn concurrent_updates_do_not_lose_keys() {
        let path = Arc::new(test_path("concurrent"));
        let mut threads = Vec::new();
        for index in 0..24 {
            let path = Arc::clone(&path);
            threads.push(thread::spawn(move || {
                set_at_path(&path, format!("key-{index}"), Value::from(index))
            }));
        }
        for handle in threads {
            handle.join().expect("thread").expect("set");
        }

        let data = read_object(&path).expect("read object");
        assert_eq!(data.as_object().expect("object").len(), 24);
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn invalid_json_is_never_overwritten_by_set() {
        let path = test_path("invalid");
        fs::write(&path, b"{broken").expect("seed invalid file");
        let result = set_at_path(&path, "new-key".into(), Value::Bool(true));

        assert!(result.is_err());
        assert_eq!(fs::read(&path).expect("read raw"), b"{broken");
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }
}
