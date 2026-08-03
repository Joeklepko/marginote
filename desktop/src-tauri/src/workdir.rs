// Marginote 桌面端「工作目录」原生文件系统。
//
// 选中的工作目录绝对路径持久化在 marginote.dat 的 `workdir` key（复用 storage 模块）。
// 前端 mn.platform.fs.* 调用这里的 cmd_workdir_* 命令读写笔记 .md / 图片 / 元数据。
//
// 安全：所有相对路径都经 sanitize_rel 规范化，禁止 `..` 逃逸出工作目录根。

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{atomic_file, storage};

const WORKDIR_KEY: &str = "workdir";

#[derive(Debug, Serialize)]
pub struct FsEntry {
    pub path: String,
    pub dir: bool,
    pub mtime: i64,
}

#[derive(Debug, Serialize)]
pub struct TextFile {
    pub path: String,
    pub text: String,
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
fn resolve_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("工作目录不可访问 {}: {e}", root.display()))?;
    resolve_rel_from_canonical(&canonical_root, rel)
}

fn resolve_rel_from_canonical(canonical_root: &Path, rel: &str) -> Result<PathBuf, String> {
    let relp = PathBuf::from(rel.replace('\\', "/"));
    let mut out = canonical_root.to_path_buf();
    for comp in relp.components() {
        match comp {
            Component::Normal(seg) => {
                out.push(seg);
                // Existing symlinks are allowed only when their resolved target
                // remains under the selected workdir. This closes the path escape
                // that a purely lexical `..` check cannot prevent.
                if out.exists() {
                    let resolved = out
                        .canonicalize()
                        .map_err(|e| format!("路径不可访问 {}: {e}", out.display()))?;
                    if !resolved.starts_with(canonical_root) {
                        return Err("路径通过符号链接逃逸出工作目录".into());
                    }
                }
            }
            Component::CurDir => {}
            Component::ParentDir => return Err("路径不允许包含 ..".into()),
            Component::RootDir | Component::Prefix(_) => return Err("不允许绝对路径".into()),
        }
    }
    Ok(out)
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<FsEntry>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        // Never traverse directory symlinks while enumerating a workdir. Direct
        // command access is separately guarded by resolve_rel.
        if file_type.is_symlink() {
            continue;
        }
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
            out.push(FsEntry {
                path: rel,
                dir: true,
                mtime,
            });
            walk(base, &path, out);
        } else {
            out.push(FsEntry {
                path: rel,
                dir: false,
                mtime,
            });
        }
    }
}

// ---------- 命令 ----------

// 桌面版始终使用真实文件作为主数据。若用户尚未选择目录，默认创建
// “文档/Marginote”；文档目录不可用时退回应用数据目录下的 Marginote。
// 已绑定的有效目录始终优先，绝不擅自迁移用户选择过的位置。
#[tauri::command]
pub async fn cmd_workdir_ensure(app: AppHandle) -> Result<String, String> {
    if let Some(root) = workdir_root(&app) {
        return Ok(root.to_string_lossy().to_string());
    }

    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("无法确定默认工作目录: {e}"))?;
    let root = base.join("Marginote");
    fs::create_dir_all(&root)
        .map_err(|e| format!("无法创建默认工作目录 {}: {e}", root.display()))?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("无法解析默认工作目录 {}: {e}", root.display()))?;
    let full = root.to_string_lossy().to_string();
    storage::set(
        &app,
        WORKDIR_KEY.into(),
        serde_json::Value::String(full.clone()),
    )?;
    Ok(full)
}

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
    let path = path
        .canonicalize()
        .map_err(|e| format!("无法解析工作目录: {e}"))?;
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
    let Some(root) = workdir_root(&app) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    Ok(out)
}

#[tauri::command]
pub async fn cmd_workdir_read_text(app: AppHandle, rel: String) -> Result<Option<String>, String> {
    let Some(root) = workdir_root(&app) else {
        return Ok(None);
    };
    let p = resolve_rel(&root, &rel)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read {}: {error}", p.display())),
    }
}

fn read_texts_from_root(root: &Path, rels: Vec<String>) -> Result<Vec<TextFile>, String> {
    if rels.len() > 20_000 {
        return Err("一次读取的文本文件过多".into());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("工作目录不可访问 {}: {e}", root.display()))?;
    let mut files = Vec::with_capacity(rels.len());
    for rel in rels {
        let normalized = rel.replace('\\', "/");
        let path = resolve_rel_from_canonical(&canonical_root, &normalized)?;
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        files.push(TextFile {
            path: normalized,
            text,
        });
    }
    Ok(files)
}

// 启动时在 Rust 侧批量读取 Markdown，避免数百篇笔记逐文件往返 WebView IPC。
#[tauri::command]
pub async fn cmd_workdir_read_texts(
    app: AppHandle,
    rels: Vec<String>,
) -> Result<Vec<TextFile>, String> {
    let Some(root) = workdir_root(&app) else {
        return Ok(vec![]);
    };
    tauri::async_runtime::spawn_blocking(move || read_texts_from_root(&root, rels))
        .await
        .map_err(|error| format!("批量读取任务失败: {error}"))?
}

#[tauri::command]
pub async fn cmd_workdir_write_text(
    app: AppHandle,
    rel: String,
    text: String,
) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else {
        return Err("未绑定工作目录".into());
    };
    let p = resolve_rel(&root, &rel)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    atomic_file::write(&p, text.as_bytes()).map_err(|e| format!("write {}: {e}", p.display()))
}

#[tauri::command]
pub async fn cmd_workdir_read_binary(
    app: AppHandle,
    rel: String,
) -> Result<Option<String>, String> {
    let Some(root) = workdir_root(&app) else {
        return Ok(None);
    };
    let p = resolve_rel(&root, &rel)?;
    match fs::read(&p) {
        Ok(bytes) => Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read {}: {error}", p.display())),
    }
}

#[tauri::command]
pub async fn cmd_workdir_write_binary(
    app: AppHandle,
    rel: String,
    b64: String,
) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else {
        return Err("未绑定工作目录".into());
    };
    let p = resolve_rel(&root, &rel)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    atomic_file::write(&p, &bytes).map_err(|e| format!("write {}: {e}", p.display()))
}

#[tauri::command]
pub async fn cmd_workdir_remove(app: AppHandle, rel: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else {
        return Err("未绑定工作目录".into());
    };
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
    let Some(root) = workdir_root(&app) else {
        return Err("未绑定工作目录".into());
    };
    let p = resolve_rel(&root, &rel)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir: {e}"))
}

#[tauri::command]
pub async fn cmd_workdir_move(app: AppHandle, from: String, to: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else {
        return Err("未绑定工作目录".into());
    };
    let src = resolve_rel(&root, &from)?;
    let dst = resolve_rel(&root, &to)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("move: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "marginote-workdir-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn rejects_parent_and_absolute_paths() {
        let root = test_dir("path");
        assert!(resolve_rel(&root, "../outside.md").is_err());
        assert!(resolve_rel(&root, "/outside.md").is_err());
        assert!(resolve_rel(&root, "notes/inside.md")
            .expect("valid path")
            .starts_with(root.canonicalize().expect("canonical root")));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn batch_reads_text_files_and_rejects_escape() {
        let root = test_dir("batch-text");
        fs::create_dir_all(root.join("notes")).expect("create notes");
        fs::write(root.join("notes/a.md"), "A").expect("seed a");
        fs::write(root.join("notes/b.md"), "B").expect("seed b");

        let rows = read_texts_from_root(&root, vec!["notes/a.md".into(), "notes/b.md".into()])
            .expect("batch read");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].path, "notes/a.md");
        assert_eq!(rows[0].text, "A");
        assert!(read_texts_from_root(&root, vec!["../outside.md".into()]).is_err());

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_and_does_not_walk_it() {
        use std::os::unix::fs::symlink;

        let root = test_dir("symlink-root");
        let outside = test_dir("symlink-outside");
        fs::write(outside.join("secret.md"), "secret").expect("seed outside");
        symlink(&outside, root.join("linked")).expect("create symlink");

        assert!(resolve_rel(&root, "linked/secret.md").is_err());
        let mut entries = Vec::new();
        walk(&root, &root, &mut entries);
        assert!(entries
            .iter()
            .all(|entry| !entry.path.starts_with("linked")));

        fs::remove_dir_all(root).expect("cleanup root");
        fs::remove_dir_all(outside).expect("cleanup outside");
    }
}
