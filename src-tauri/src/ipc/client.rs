use std::collections::VecDeque;
use std::sync::Arc;

use ::tauri::{AppHandle, Emitter};
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};
use std::process::Command;

use crate::ipc::protocol::*;
use crate::process_util::SilentCommandExt;

/// Request sent from Tauri commands to the IPC writer task.
struct IpcRequest {
    message: ClientMessage,
    /// If Some, the response is sent back here. If None (for WriteToPty), fire-and-forget.
    reply: Option<oneshot::Sender<ServerMessage>>,
}

/// IPC client that connects to the Racemo server daemon.
pub struct IpcClient {
    request_tx: mpsc::Sender<IpcRequest>,
}

impl IpcClient {
    /// Connect to the server. Spawns background tasks for reading/writing.
    pub async fn connect(socket_path: &str, app_handle: AppHandle) -> Result<Self, String> {
        #[cfg(unix)]
        let stream = UnixStream::connect(socket_path)
            .await
            .map_err(|e| format!("Failed to connect to server: {e}"))?;

        #[cfg(windows)]
        let stream = {
            use tokio::net::windows::named_pipe::ClientOptions;
            ClientOptions::new()
                .open(socket_path)
                .map_err(|e| format!("Failed to connect to named pipe: {e}"))?
        };

        let (reader, writer) = tokio::io::split(stream);
        let writer = Arc::new(TokioMutex::new(writer));

        // Channel for Tauri commands to send requests.
        let (request_tx, mut request_rx) = mpsc::channel::<IpcRequest>(256);

        // Pending responses waiting for reply from server (FIFO order).
        let pending: Arc<TokioMutex<VecDeque<oneshot::Sender<ServerMessage>>>> =
            Arc::new(TokioMutex::new(VecDeque::new()));

        // Writer task: send ClientMessages to the server.
        let writer_clone = writer.clone();
        let pending_clone = pending.clone();
        tokio::spawn(async move {
            while let Some(req) = request_rx.recv().await {
                if let Some(reply) = req.reply {
                    pending_clone.lock().await.push_back(reply);
                }
                let mut w = writer_clone.lock().await;
                if write_frame(&mut *w, &req.message).await.is_err() {
                    log::error!("Failed to write to server");
                    break;
                }
            }
        });

        // Reader task: read ServerMessages from the server.
        let reader = Arc::new(TokioMutex::new(reader));
        let pending_clone = pending.clone();
        tokio::spawn(async move {
            let mut r = reader.lock().await;
            loop {
                match read_frame::<_, ServerMessage>(&mut *r).await {
                    Ok(Some(msg)) => {
                        match &msg {
                            // PtyOutput and PtyExit are broadcast messages — emit as Tauri events.
                            ServerMessage::PtyOutput { pane_id, data } => {
                                let _ = app_handle.emit(
                                    "pty-output",
                                    serde_json::json!({
                                        "pane_id": pane_id,
                                        "data": data,
                                    }),
                                );
                                continue;
                            }
                            ServerMessage::PtyExit { pane_id } => {
                                let _ = app_handle.emit(
                                    "pty-exit",
                                    serde_json::json!({ "pane_id": pane_id }),
                                );
                                continue;
                            }
                            ServerMessage::FsChange { ref events } => {
                                let _ = app_handle.emit(
                                    "fs-change",
                                    serde_json::to_value(events).unwrap_or_default(),
                                );
                                continue;
                            }
                            ServerMessage::SessionUpdated { ref session } => {
                                // Broadcast-only: always emit as Tauri event (never consume from pending queue).
                                let _ = app_handle.emit(
                                    "session-updated",
                                    serde_json::to_value(session).unwrap_or_default(),
                                );
                                continue;
                            }
                            // Server-side hosting status → forward as Tauri event
                            ServerMessage::RemoteStatusChanged { status, pairing_code, error } => {
                                let _ = app_handle.emit("remote-host-status", serde_json::json!({
                                    "status": status,
                                    "pairing_code": pairing_code,
                                    "error": error,
                                }));
                                continue;
                            }
                            // Account-based connection request → prompt user for approval
                            ServerMessage::AccountConnectionRequest { room_code, from_login, from_device } => {
                                let _ = app_handle.emit("remote-connection-request", serde_json::json!({
                                    "room_code": room_code,
                                    "from_login": from_login,
                                    "from_device": from_device,
                                }));
                                continue;
                            }
                            // Account-based client connected
                            ServerMessage::AccountClientConnected { room_code, from_login, from_device } => {
                                let _ = app_handle.emit("remote-client-connected", serde_json::json!({
                                    "room_code": room_code,
                                    "from_login": from_login,
                                    "from_device": from_device,
                                }));
                                continue;
                            }
                            // Account-based client disconnected
                            ServerMessage::AccountClientDisconnected { room_code } => {
                                let _ = app_handle.emit("remote-client-disconnected", serde_json::json!({
                                    "room_code": room_code,
                                }));
                                continue;
                            }
                            // 원격 클라이언트가 에디터에서 파일을 열었음 → 호스트에서도 열기
                            ServerMessage::RemoteEditorOpen { path } => {
                                let _ = app_handle.emit("remote:editor-open", serde_json::json!({
                                    "path": path,
                                }));
                                continue;
                            }
                            // 원격 클라이언트가 에디터 탭을 닫았음 → 호스트에서도 닫기
                            ServerMessage::RemoteEditorClose { path } => {
                                let _ = app_handle.emit("remote:editor-close", serde_json::json!({
                                    "path": path,
                                }));
                                continue;
                            }
                            // PTY가 원격 클라이언트에 의해 min(호스트, 원격)으로 리사이즈됨 → 로컬 xterm도 동기화
                            ServerMessage::PtyResized { pane_id, rows, cols } => {
                                let _ = app_handle.emit("pty-resized", serde_json::json!({
                                    "pane_id": pane_id,
                                    "rows": rows,
                                    "cols": cols,
                                }));
                                continue;
                            }
                            _ => {}
                        }

                        // For request-response messages, send to the first pending reply.
                        let mut queue = pending_clone.lock().await;
                        if let Some(reply) = queue.pop_front() {
                            let _ = reply.send(msg);
                        }
                    }
                    Ok(None) => {
                        log::info!("Server connection closed");
                        let _ = app_handle.emit("ipc-disconnected", ());
                        break;
                    }
                    Err(e) => {
                        log::error!("Error reading server message: {e}");
                        let _ = app_handle.emit("ipc-disconnected", ());
                        break;
                    }
                }
            }
        });

        Ok(Self { request_tx })
    }

    /// Check if the IPC channel is still open.
    pub fn is_connected(&self) -> bool {
        !self.request_tx.is_closed()
    }

    /// Send a message and wait for the response.
    pub async fn request(&self, msg: ClientMessage) -> Result<ServerMessage, String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.request_tx
            .send(IpcRequest {
                message: msg,
                reply: Some(reply_tx),
            })
            .await
            .map_err(|_| "IPC channel closed".to_string())?;

        reply_rx
            .await
            .map_err(|_| "IPC response channel closed".to_string())
    }

    /// Send a fire-and-forget message (used for WriteToPty for performance).
    pub async fn send(&self, msg: ClientMessage) -> Result<(), String> {
        self.request_tx
            .send(IpcRequest {
                message: msg,
                reply: None,
            })
            .await
            .map_err(|_| "IPC channel closed".to_string())
    }
}

// ── Public server lifecycle functions ────────────────────────────

use std::sync::Mutex;
static SERVER_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);


/// 실행 중인 서버 프로세스를 강제 종료. 업데이터 실행 전에 호출.
pub fn kill_server() {
    let mut guard = SERVER_CHILD.lock().expect("mutex poisoned");
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        log::info!("racemo-server process killed for update");
    }
}

/// 서버 바이너리를 찾아서 실행. Child 핸들을 보관.
fn spawn_server(_app_handle: &AppHandle) -> Result<(), String> {
    let mut exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get current exe path: {e}"))?;
    exe_path.pop();

    #[cfg(windows)]
    let bin_name = "racemo-server.exe";
    #[cfg(not(windows))]
    let bin_name = "racemo-server";

    exe_path.push(bin_name);

    if !exe_path.exists() {
        return Err(format!("Server binary not found: {:?}", exe_path));
    }

    log::info!("Spawning server from: {:?}", exe_path);

    let child = {
        #[cfg(windows)]
        {
            use std::process::Stdio;
            Command::new(&exe_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .silent()
                .spawn()
                .map_err(|e| format!("Failed to spawn server: {e}"))?
        }
        #[cfg(not(windows))]
        {
            Command::new(&exe_path)
                .silent()
                .spawn()
                .map_err(|e| format!("Failed to spawn server: {e}"))?
        }
    };

    *SERVER_CHILD.lock().map_err(|e| format!("mutex poisoned: {e}"))? = Some(child);
    Ok(())
}

/// Orchestrate server startup and connection.
///
/// 1. 기존 서버(orphan 포함)가 있으면 Shutdown 전송 후 종료 대기
/// 2. 새 서버 spawn → 연결
pub async fn setup_ipc(
    app_handle: AppHandle,
    ipc_state: Arc<TokioMutex<Option<IpcClient>>>,
) {
    *ipc_state.lock().await = None;
    let socket_path = default_socket_path();

    // 기존 서버가 살아있으면 그대로 재연결 — 세션/PTY 상태 보존
    if let Ok(existing) = IpcClient::connect(&socket_path, app_handle.clone()).await {
        log::info!("Found existing racemo-server — reconnecting (sessions preserved)");
        *ipc_state.lock().await = Some(existing);
        let _ = app_handle.emit("ipc-ready", ());
        return;
    }

    // 서버가 없으면 새로 spawn
    log::info!("Spawning racemo-server...");
    if let Err(e) = spawn_server(&app_handle) {
        log::error!("Failed to spawn server: {e}");
    } else {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    // 연결 재시도
    let mut delay_ms = 100u64;
    for attempt in 0..8 {
        if attempt > 0 {
            log::info!("Connection attempt {} failed, retrying in {}ms", attempt + 1, delay_ms);
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }

        match IpcClient::connect(&socket_path, app_handle.clone()).await {
            Ok(client) => {
                log::info!("Connected to racemo-server on attempt {}", attempt + 1);
                *ipc_state.lock().await = Some(client);
                let _ = app_handle.emit("ipc-ready", ());
                return;
            }
            Err(e) => {
                if attempt < 7 {
                    if attempt < 2 {
                        log::info!("Connection attempt {} failed: {e}, retrying...", attempt + 1);
                    } else {
                        log::warn!("Connection attempt {} failed: {e}, retrying...", attempt + 1);
                    }
                    if attempt >= 4 {
                        delay_ms = (delay_ms * 2).min(5000);
                    }
                } else {
                    log::error!("Failed to connect to server after 8 attempts: {e}");
                }
            }
        }
    }
}
