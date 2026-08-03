//! Durable same-directory file replacement used by the KV store and workdir.
//!
//! Data is written and flushed to a uniquely named sibling first. The final
//! rename/replace is atomic, so a crash cannot leave the destination half-written.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

fn temp_path(path: &Path) -> io::Result<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid file name"))?;
    let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), id)))
}

#[cfg(not(windows))]
fn replace(temp: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temp, destination)
}

#[cfg(windows)]
fn replace(temp: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temp_wide: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both pointers reference NUL-terminated UTF-16 buffers that remain
    // alive for the duration of the synchronous Win32 call.
    let ok = unsafe {
        MoveFileExW(
            temp_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        let replace_error = io::Error::last_os_error();
        // Windows 上某些编辑器、杀毒软件和同步盘会允许写入已打开文件，
        // 但不授予 MoveFileEx 替换所需的 delete-sharing，从而返回 os error 5。
        // 仅在目标确实存在且替换被拒绝时退回原位写入；真正的只读文件仍会
        // 在 OpenOptions::open 处失败，不会绕过文件系统权限。
        if replace_error.kind() == io::ErrorKind::PermissionDenied && destination.is_file() {
            let fallback = (|| {
                let mut source = fs::File::open(temp)?;
                let mut target = OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(destination)?;
                io::copy(&mut source, &mut target)?;
                target.sync_all()?;
                drop(target);
                fs::remove_file(temp)
            })();
            if fallback.is_ok() {
                return Ok(());
            }
        }
        Err(replace_error)
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory"))?;
    fs::create_dir_all(parent)?;

    // create_new protects another writer's temporary file even if a stale file
    // happens to use a similar name. Retry a few times for completeness.
    let mut last_error = None;
    for _ in 0..8 {
        let temp = temp_path(path)?;
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            replace(&temp, path)?;
            sync_parent(path)
        })();

        match result {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => {
                let _ = fs::remove_file(&temp);
                return Err(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| io::Error::other("unable to allocate temporary file")))
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
            "marginote-atomic-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn replaces_existing_file_without_leaving_temp_files() {
        let dir = test_dir("replace");
        let path = dir.join("data.json");
        write(&path, b"old").expect("initial write");
        write(&path, b"new value").expect("replacement write");

        assert_eq!(fs::read(&path).expect("read"), b"new value");
        let names: Vec<_> = fs::read_dir(&dir)
            .expect("list")
            .flatten()
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(
            names,
            vec![path.file_name().expect("file name").to_os_string()]
        );
        fs::remove_dir_all(dir).expect("cleanup");
    }
}
