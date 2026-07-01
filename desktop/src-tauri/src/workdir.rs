// Marginote 桌面端「工作目录」原生文件系统。
//
// 选中的工作目录绝对路径持久化在 marginote.dat 的 `workdir` key（复用 storage 模块）。
// 前端 mn.platform.fs.* 调用这里的 cmd_workdir_* 命令读写笔记 .md / 图片 / 元数据。
//
// 安全：所有相对路径都经 sanitize_rel 规范化，禁止 `..` 逃逸出工作目录根。

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Component, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::storage;

const WORKDIR_KEY: &str = "workdir";

#[derive(Debug, Serialize)]
pub struct FsEntry {
    pub path: String,
    pub dir: bool,
    pub mtime: i64,
}

// 读取已持久化的工作目录根路径
fn workdir_root(app: &AppHandle) -> Option<PathBuf> {
    match storage::get(app, WORKDIR_KEY) {
        serde_json::Value::String(s) if !s.is_empty() => {
            let p = PathBuf::from(s);
            if p.is_dir() {
                Some(p)
            } else {
                None
            }
        }
        _ => None,
    }
}

// 把相对路径规范化并拼到根；拒绝 `..` / 绝对路径逃逸
fn resolve_rel(root: &PathBuf, rel: &str) -> Result<PathBuf, String> {
    let relp = PathBuf::from(rel.replace('\\', "/"));
    let mut out = root.clone();
    for comp in relp.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            Component::ParentDir => return Err("路径不允许包含 ..".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("不允许绝对路径".into())
            }
        }
    }
    Ok(out)
}

fn walk(base: &PathBuf, dir: &PathBuf, out: &mut Vec<FsEntry>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let rel = match path.strip_prefix(base) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if meta.is_dir() {
            out.push(FsEntry { path: rel, dir: true, mtime });
            walk(base, &path, out);
        } else {
            out.push(FsEntry { path: rel, dir: false, mtime });
        }
    }
}

// ---------- 命令 ----------

// 弹原生目录选择器；选中则持久化并返回绝对路径（None=用户取消）
#[tauri::command]
pub async fn cmd_workdir_pick(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    let Some(fp) = folder else { return Ok(None) };
    // tauri v2 返回 FilePath（Path|Url 枚举）；目录选择器只会是 Path 变体。
    let path = match fp.as_path() {
        Some(p) => p.to_path_buf(),
        None => return Err("路径解析失败".into()),
    };
    if !path.is_dir() {
        return Err("所选不是有效目录".into());
    }
    let full = path.to_string_lossy().to_string();
    storage::set(
        &app,
        WORKDIR_KEY.into(),
        serde_json::Value::String(full.clone()),
    )?;
    Ok(Some(full))
}

// 返回已绑定目录的绝对路径（None=未绑定或路径失效）
#[tauri::command]
pub async fn cmd_workdir_status(app: AppHandle) -> Result<Option<String>, String> {
    Ok(workdir_root(&app).map(|p| p.to_string_lossy().to_string()))
}

// 解绑（仅清 key，不删磁盘文件）
#[tauri::command]
pub async fn cmd_workdir_forget(app: AppHandle) -> Result<(), String> {
    storage::remove(&app, WORKDIR_KEY)
}

// 递归列出全部条目
#[tauri::command]
pub async fn cmd_workdir_list(app: AppHandle) -> Result<Vec<FsEntry>, String> {
    let Some(root) = workdir_root(&app) else { return Ok(vec![]) };
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    Ok(out)
}

#[tauri::command]
pub async fn cmd_workdir_read_text(app: AppHandle, rel: String) -> Result<Option<String>, String> {
    let Some(root) = workdir_root(&app) else { return Ok(None) };
    let p = resolve_rel(&root, &rel)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn cmd_workdir_write_text(app: AppHandle, rel: String, text: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else { return Err("未绑定工作目录".into()) };
    let p = resolve_rel(&root, &rel)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    fs::write(&p, text).map_err(|e| format!("write {}: {e}", p.display()))
}

#[tauri::command]
pub async fn cmd_workdir_read_binary(app: AppHandle, rel: String) -> Result<Option<String>, String> {
    let Some(root) = workdir_root(&app) else { return Ok(None) };
    let p = resolve_rel(&root, &rel)?;
    match fs::read(&p) {
        Ok(bytes) => Ok(Some(base64::engine::general_purpose::STANDARD.encode(bytes))),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn cmd_workdir_write_binary(app: AppHandle, rel: String, b64: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else { return Err("未绑定工作目录".into()) };
    let p = resolve_rel(&root, &rel)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    fs::write(&p, bytes).map_err(|e| format!("write {}: {e}", p.display()))
}

#[tauri::command]
pub async fn cmd_workdir_remove(app: AppHandle, rel: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else { return Err("未绑定工作目录".into()) };
    let p = resolve_rel(&root, &rel)?;
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("rmdir: {e}"))
    } else if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("rm: {e}"))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn cmd_workdir_mkdir(app: AppHandle, rel: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else { return Err("未绑定工作目录".into()) };
    let p = resolve_rel(&root, &rel)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir: {e}"))
}

#[tauri::command]
pub async fn cmd_workdir_move(app: AppHandle, from: String, to: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else { return Err("未绑定工作目录".into()) };
    let src = resolve_rel(&root, &from)?;
    let dst = resolve_rel(&root, &to)?;
    if let Some(parent) = dst.parent() { let _ = std::fs::create_dir_all(parent); }
    std::fs::rename(&src, &dst).map_err(|e| format!("move: {e}"))
}
