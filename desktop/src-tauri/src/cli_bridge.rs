//! Local-only bridge between `marginote-cli` and the desktop WebView.
//!
//! Marginote's canonical live data is owned by the WebView so that the desktop
//! application and its built-in AI assistant always observe the same objects.
//! The CLI therefore never edits WebView2's LevelDB files directly. Instead it
//! sends an authenticated request to this loopback server. The frontend drains
//! the request queue, executes the existing assistant tools, and completes the
//! request through a Tauri command.

use once_cell::sync::Lazy;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const ENDPOINT_FILE: &str = "cli-endpoint.json";
const MAX_REQUEST_BYTES: u64 = 16 * 1024 * 1024;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
struct WireRequest {
    token: String,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRequest {
    pub id: String,
    pub command: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
struct EndpointInfo<'a> {
    protocol: u8,
    port: u16,
    token: &'a str,
    pid: u32,
    version: &'a str,
}

#[derive(Default)]
struct BridgeState {
    queue: Mutex<VecDeque<CliRequest>>,
    pending: Mutex<HashMap<String, mpsc::Sender<CliResponse>>>,
    sequence: AtomicU64,
}

static BRIDGE: Lazy<BridgeState> = Lazy::new(BridgeState::default);

fn error_response(message: impl Into<String>) -> CliResponse {
    CliResponse {
        ok: false,
        data: None,
        error: Some(message.into()),
    }
}

fn write_response(stream: &mut TcpStream, response: &CliResponse) {
    if let Ok(mut encoded) = serde_json::to_vec(response) {
        encoded.push(b'\n');
        let _ = stream.write_all(&encoded);
        let _ = stream.flush();
    }
}

fn handle_connection(mut stream: TcpStream, token: &str, app: &AppHandle) {
    let peer_is_loopback = stream
        .peer_addr()
        .map(|addr| addr.ip().is_loopback())
        .unwrap_or(false);
    if !peer_is_loopback {
        write_response(&mut stream, &error_response("只允许本机连接"));
        return;
    }

    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let read_stream = match stream.try_clone() {
        Ok(value) => value,
        Err(error) => {
            write_response(
                &mut stream,
                &error_response(format!("读取连接失败：{error}")),
            );
            return;
        }
    };
    let mut line = String::new();
    let mut reader = BufReader::new(read_stream).take(MAX_REQUEST_BYTES);
    match reader.read_line(&mut line) {
        Ok(0) => return,
        Ok(_) => {}
        Err(error) => {
            write_response(
                &mut stream,
                &error_response(format!("读取请求失败：{error}")),
            );
            return;
        }
    }

    let wire: WireRequest = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(error) => {
            write_response(
                &mut stream,
                &error_response(format!("请求 JSON 无效：{error}")),
            );
            return;
        }
    };
    if wire.token != token {
        write_response(&mut stream, &error_response("CLI 令牌无效"));
        return;
    }
    if wire.command.trim().is_empty() {
        write_response(&mut stream, &error_response("command 不能为空"));
        return;
    }

    let seq = BRIDGE.sequence.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("{}-{seq}", std::process::id());
    let request = CliRequest {
        id: id.clone(),
        command: wire.command,
        args: wire.args,
    };
    let (sender, receiver) = mpsc::channel();

    if let Ok(mut pending) = BRIDGE.pending.lock() {
        pending.insert(id.clone(), sender);
    } else {
        write_response(&mut stream, &error_response("CLI 响应队列不可用"));
        return;
    }
    if let Ok(mut queue) = BRIDGE.queue.lock() {
        queue.push_back(request);
    } else {
        if let Ok(mut pending) = BRIDGE.pending.lock() {
            pending.remove(&id);
        }
        write_response(&mut stream, &error_response("CLI 请求队列不可用"));
        return;
    }
    // Tauri events wake a hidden WebView immediately; the frontend also polls
    // as a fallback for the short startup window before its listener is ready.
    let _ = app.emit("marginote-cli-pending", ());

    let response = match receiver.recv_timeout(RESPONSE_TIMEOUT) {
        Ok(value) => value,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if let Ok(mut pending) = BRIDGE.pending.lock() {
                pending.remove(&id);
            }
            error_response("Marginote 处理请求超时，请确认桌面应用已正常启动")
        }
        Err(_) => error_response("Marginote 在返回结果前已关闭"),
    };
    write_response(&mut stream, &response);
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn endpoint_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app_data_dir: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("mkdir {}: {error}", dir.display()))?;
    Ok(dir.join(ENDPOINT_FILE))
}

fn write_endpoint(app: &AppHandle, port: u16, token: &str) -> Result<(), String> {
    let path = endpoint_path(app)?;
    let temp_path = path.with_extension("json.tmp");
    let value = EndpointInfo {
        protocol: 1,
        port,
        token,
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION"),
    };
    let encoded =
        serde_json::to_vec(&value).map_err(|error| format!("endpoint encode: {error}"))?;
    fs::write(&temp_path, encoded)
        .map_err(|error| format!("write {}: {error}", temp_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
    }

    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&temp_path, &path).map_err(|error| format!("rename {}: {error}", path.display()))
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|error| format!("CLI listener bind: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("CLI listener address: {error}"))?
        .port();
    let token = random_token();
    write_endpoint(app, port, &token)?;
    let app = app.clone();

    std::thread::Builder::new()
        .name("marginote-cli-listener".into())
        .spawn(move || {
            for connection in listener.incoming() {
                let Ok(stream) = connection else { continue };
                let token = token.clone();
                let app = app.clone();
                let _ = std::thread::Builder::new()
                    .name("marginote-cli-request".into())
                    .spawn(move || handle_connection(stream, &token, &app));
            }
        })
        .map_err(|error| format!("CLI listener thread: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn cmd_cli_take_requests() -> Result<Vec<CliRequest>, String> {
    let mut queue = BRIDGE
        .queue
        .lock()
        .map_err(|error| format!("queue lock: {error}"))?;
    Ok(queue.drain(..).collect())
}

#[tauri::command]
pub fn cmd_cli_complete(
    id: String,
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = BRIDGE
        .pending
        .lock()
        .map_err(|lock_error| format!("pending lock: {lock_error}"))?
        .remove(&id)
        .ok_or_else(|| format!("CLI 请求已过期：{id}"))?;
    sender
        .send(CliResponse { ok, data, error })
        .map_err(|_| format!("CLI 客户端已断开：{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_has_256_bits_in_hex() {
        let token = random_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|value| value.is_ascii_hexdigit()));
    }

    #[test]
    fn response_omits_empty_fields() {
        let encoded = serde_json::to_value(CliResponse {
            ok: true,
            data: Some(serde_json::json!({ "id": "n1" })),
            error: None,
        })
        .unwrap();
        assert_eq!(encoded["ok"], true);
        assert_eq!(encoded["data"]["id"], "n1");
        assert!(encoded.get("error").is_none());
    }
}
