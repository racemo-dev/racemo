use tauri::State;
use crate::ipc::protocol::{ClientMessage, ServerMessage, ShellType};
use crate::layout::SplitDirection;
use crate::session::Session;
use super::{ipc, IpcState};
use serde::{Deserialize, Serialize};

/// Helper: extract Session from ServerMessage or return error.
fn extract_session(msg: ServerMessage) -> Result<Session, String> {
    match msg {
        ServerMessage::SessionCreated { session } => Ok(session),
        ServerMessage::SessionAttached { session } => Ok(session),
        ServerMessage::SessionUpdated { session } => Ok(session),
        ServerMessage::SessionModified { session } => Ok(session),
        ServerMessage::Error { code, message } => Err(format!("{code:?}: {message}")),
        other => Err(format!("Unexpected server response: {other:?}")),
    }
}

/// Create a new session with a single terminal pane.
#[tauri::command]
pub async fn create_session(
    name: Option<String>,
    working_dir: Option<String>,
    shell: Option<ShellType>,
    rows: u16,
    cols: u16,
    state: State<'_, IpcState>,
) -> Result<Session, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::CreateSession {
            name,
            working_dir,
            shell,
            rows,
            cols,
        })
        .await?;
    extract_session(msg)
}

/// Get a session by listing and finding the first one (convenience).
#[tauri::command]
pub async fn get_session(
    session_id: String,
    state: State<'_, IpcState>,
) -> Result<Session, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::AttachSession { session_id })
        .await?;
    extract_session(msg)
}

/// List all sessions.
#[tauri::command]
pub async fn list_sessions(state: State<'_, IpcState>) -> Result<Vec<Session>, String> {
    let client = ipc(&state).await?;
    let msg = client.request(ClientMessage::ListSessions).await?;
    match msg {
        ServerMessage::SessionList { sessions } => Ok(sessions),
        ServerMessage::Error { message, .. } => Err(message),
        other => Err(format!("Unexpected response: {other:?}")),
    }
}

/// Attach to an existing session (used on reconnection).
#[tauri::command]
pub async fn attach_session(
    session_id: String,
    state: State<'_, IpcState>,
) -> Result<Session, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::AttachSession { session_id })
        .await?;
    extract_session(msg)
}

/// Get the last active session ID from the server.
#[tauri::command]
pub async fn get_active_session_id(state: State<'_, IpcState>) -> Result<Option<String>, String> {
    let client = ipc(&state).await?;
    let msg = client.request(ClientMessage::GetActiveSessionId).await?;
    match msg {
        ServerMessage::ActiveSessionId { session_id } => Ok(session_id),
        ServerMessage::Error { message, .. } => Err(message),
        other => Err(format!("Unexpected response: {other:?}")),
    }
}

/// Switch the active session (client-side only, just attach).
#[tauri::command]
pub async fn switch_session(
    session_id: String,
    state: State<'_, IpcState>,
) -> Result<Session, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::AttachSession { session_id })
        .await?;
    extract_session(msg)
}

/// Close an entire session (tab). Kills all PTYs in the session.
#[tauri::command]
pub async fn close_session(
    session_id: String,
    state: State<'_, IpcState>,
) -> Result<Option<Session>, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::CloseSession { session_id })
        .await?;
    match msg {
        ServerMessage::SessionClosed { remaining } => Ok(remaining),
        ServerMessage::Error { message, .. } => Err(message),
        other => Err(format!("Unexpected response: {other:?}")),
    }
}

/// Rename a session (tab).
#[tauri::command]
pub async fn rename_session(
    session_id: String,
    name: String,
    state: State<'_, IpcState>,
) -> Result<(), String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::RenameSession { session_id, name })
        .await?;
    match msg {
        ServerMessage::SessionRenamed => Ok(()),
        ServerMessage::Error { message, .. } => Err(message),
        _ => Ok(()),
    }
}

/// Split a pane horizontally or vertically.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn split_pane(
    session_id: String,
    pane_id: String,
    direction: SplitDirection,
    shell: Option<ShellType>,
    rows: u16,
    cols: u16,
    before: bool,
    state: State<'_, IpcState>,
) -> Result<Session, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::SplitPane {
            session_id,
            pane_id,
            direction,
            shell,
            rows,
            cols,
            before,
        })
        .await?;
    extract_session(msg)
}

/// Close a pane. Returns the updated session.
#[tauri::command]
pub async fn close_pane(
    session_id: String,
    pane_id: String,
    state: State<'_, IpcState>,
) -> Result<Session, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::ClosePane {
            session_id,
            pane_id,
        })
        .await?;
    extract_session(msg)
}

/// Resize a split node's ratio.
#[tauri::command]
pub async fn resize_pane(
    session_id: String,
    split_id: String,
    ratio: f64,
    state: State<'_, IpcState>,
) -> Result<Session, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::ResizePane {
            session_id,
            split_id,
            ratio,
        })
        .await?;
    extract_session(msg)
}

/// Write user input data to a specific PTY.
#[tauri::command]
pub async fn write_to_pty(
    pane_id: String,
    data: Vec<u8>,
    state: State<'_, IpcState>,
) -> Result<(), String> {
    let client = ipc(&state).await?;
    client
        .send(ClientMessage::WriteToPty { pane_id, data })
        .await
}

/// PTY 출력 소비 완료 ack — 서버 흐름 제어에 크레딧 반환 (fire-and-forget).
#[tauri::command]
pub async fn ack_pty_output(
    pane_id: String,
    bytes: u64,
    state: State<'_, IpcState>,
) -> Result<(), String> {
    let client = ipc(&state).await?;
    client
        .send(ClientMessage::AckPtyOutput { pane_id, bytes })
        .await
}

/// 이 연결의 미ack 카운터 전체 리셋 — 웹뷰 리로드 후 영구 일시정지 방지.
#[tauri::command]
pub async fn reset_pty_acks(state: State<'_, IpcState>) -> Result<(), String> {
    let client = ipc(&state).await?;
    client.send(ClientMessage::ResetPtyAcks).await
}

/// Resize the PTY terminal dimensions.
#[tauri::command]
pub async fn resize_pty(
    pane_id: String,
    rows: u16,
    cols: u16,
    state: State<'_, IpcState>,
) -> Result<(), String> {
    let client = ipc(&state).await?;
    client
        .send(ClientMessage::ResizePty {
            pane_id,
            rows,
            cols,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::{ErrorCode, ServerMessage};
    use crate::session::Session;

    fn make_session() -> Session {
        Session::new(Some("test".to_string()), "pane-1".to_string(), None)
    }

    #[test]
    fn extract_session_created() {
        let s = make_session();
        let msg = ServerMessage::SessionCreated { session: s.clone() };
        let result = extract_session(msg).unwrap();
        assert_eq!(result.id, s.id);
    }

    #[test]
    fn extract_session_attached() {
        let s = make_session();
        let msg = ServerMessage::SessionAttached { session: s.clone() };
        let result = extract_session(msg).unwrap();
        assert_eq!(result.id, s.id);
    }

    #[test]
    fn extract_session_updated() {
        let s = make_session();
        let msg = ServerMessage::SessionUpdated { session: s.clone() };
        let result = extract_session(msg).unwrap();
        assert_eq!(result.id, s.id);
    }

    #[test]
    fn extract_session_modified() {
        let s = make_session();
        let msg = ServerMessage::SessionModified { session: s.clone() };
        let result = extract_session(msg).unwrap();
        assert_eq!(result.id, s.id);
    }

    #[test]
    fn extract_session_error_returns_err() {
        let msg = ServerMessage::Error {
            code: ErrorCode::SessionNotFound,
            message: "not found".to_string(),
        };
        let err = extract_session(msg).unwrap_err();
        assert!(err.contains("not found"), "error message should contain 'not found': {err}");
    }

    #[test]
    fn extract_session_unexpected_returns_err() {
        let msg = ServerMessage::SessionList { sessions: vec![] };
        let err = extract_session(msg).unwrap_err();
        assert!(err.contains("Unexpected"), "should say Unexpected: {err}");
    }
}

/// Respawn a PTY with a different shell. Kills the existing PTY and starts a new one.
#[tauri::command]
pub async fn respawn_pty(
    session_id: String,
    pane_id: String,
    shell: ShellType,
    rows: u16,
    cols: u16,
    state: State<'_, IpcState>,
) -> Result<Session, String> {
    let client = ipc(&state).await?;
    let msg = client
        .request(ClientMessage::RespawnPty {
            session_id,
            pane_id,
            shell,
            rows,
            cols,
        })
        .await?;
    extract_session(msg)
}

/// Save the last executed command for a pane into sessions.json.
#[tauri::command]
pub async fn set_pane_last_command(
    session_id: String,
    pane_id: String,
    command: String,
    state: State<'_, IpcState>,
) -> Result<(), String> {
    let client = ipc(&state).await?;
    client
        .request(ClientMessage::SetPaneLastCommand { session_id, pane_id, command })
        .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneProcessInfo {
    pub pane_id: String,
    pub session_id: String,
    pub session_name: Option<String>,
    pub pid: u32,
    pub command: String,
    pub ports: Vec<u16>,
}

/// List all processes with listening ports that are descendants of any active pane's shell.
#[tauri::command]
pub async fn list_pane_processes(state: State<'_, IpcState>) -> Result<Vec<PaneProcessInfo>, String> {
    let client = ipc(&state).await?;
    let msg = client.request(ClientMessage::ListPaneProcesses).await?;
    let panes = match msg {
        ServerMessage::PaneChildPids { panes } => panes,
        ServerMessage::Error { message, .. } => return Err(message),
        other => return Err(format!("Unexpected response: {other:?}")),
    };

    #[cfg(unix)]
    {
        // `ps`/`lsof` are blocking syscalls; offload off the tokio runtime worker.
        tokio::task::spawn_blocking(move || scan_pane_processes(panes))
            .await
            .map_err(|e| format!("scan task join failed: {e}"))?
    }

    #[cfg(not(unix))]
    {
        let _ = panes;
        Ok(vec![])
    }
}

#[cfg(unix)]
fn scan_pane_processes(
    panes: Vec<crate::ipc::protocol::PaneChildInfo>,
) -> Result<Vec<PaneProcessInfo>, String> {
    // Build pid→ppid map from `ps` output
    let ps_out = std::process::Command::new("ps")
        .args(["-e", "-o", "pid=,ppid=,comm="])
        .output()
        .map_err(|e| format!("ps failed: {e}"))?;
    let ps_str = String::from_utf8_lossy(&ps_out.stdout);

    let mut pid_to_ppid: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut pid_to_comm: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
    for line in ps_str.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            if let (Ok(pid), Ok(ppid)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                pid_to_ppid.insert(pid, ppid);
                pid_to_comm.insert(pid, parts[2..].join(" "));
            }
        }
    }

    // Build children map
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (&pid, &ppid) in &pid_to_ppid {
        children.entry(ppid).or_default().push(pid);
    }

    // BFS to find all descendants of a given root PID
    let descendants = |root: u32| -> Vec<u32> {
        let mut result = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(root);
        while let Some(pid) = queue.pop_front() {
            if pid != root {
                result.push(pid);
            }
            if let Some(kids) = children.get(&pid) {
                for &kid in kids {
                    queue.push_back(kid);
                }
            }
        }
        result
    };

    // Get all listening TCP ports via lsof
    let lsof_out = std::process::Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-n", "-P", "-F", "pcn"])
        .output()
        .map_err(|e| format!("lsof failed: {e}"))?;
    let lsof_str = String::from_utf8_lossy(&lsof_out.stdout);

    // Parse lsof -F output: p<pid>\nc<cmd>\nn<addr:port>
    let mut pid_ports: std::collections::HashMap<u32, Vec<u16>> = std::collections::HashMap::new();
    let mut cur_pid: Option<u32> = None;
    for line in lsof_str.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            cur_pid = rest.parse::<u32>().ok();
        } else if line.starts_with('n') {
            if let Some(pid) = cur_pid {
                // Format: *:3000 or 127.0.0.1:3000
                if let Some(port_str) = line.rsplit(':').next() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        pid_ports.entry(pid).or_default().push(port);
                    }
                }
            }
        }
    }

    let mut result = Vec::new();
    for pane in panes {
        let Some(shell_pid) = pane.child_pid else { continue };
        let desc = descendants(shell_pid);
        for pid in desc {
            let ports = pid_ports.get(&pid).cloned().unwrap_or_default();
            if ports.is_empty() {
                continue;
            }
            result.push(PaneProcessInfo {
                pane_id: pane.pane_id.clone(),
                session_id: pane.session_id.clone(),
                session_name: pane.session_name.clone(),
                pid,
                command: pid_to_comm.get(&pid).cloned().unwrap_or_default(),
                ports,
            });
        }
    }
    Ok(result)
}

/// Send SIGTERM to a process by PID. If the PID is its own process-group leader
/// (i.e. the shell put it in a dedicated job), signal the whole group so worker
/// children die with it. Otherwise the pgid would equal the shell's pgid and
/// `killpg` would take down the user's interactive shell.
#[tauri::command]
pub fn kill_pane_process(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, killpg, Signal};
        use nix::unistd::Pid;
        let nix_pid = Pid::from_raw(pid as i32);
        match nix::unistd::getpgid(Some(nix_pid)) {
            Ok(pgid) if pgid == nix_pid => killpg(pgid, Signal::SIGTERM)
                .map_err(|e| format!("killpg failed: {e}")),
            _ => kill(nix_pid, Signal::SIGTERM)
                .map_err(|e| format!("kill failed: {e}")),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("kill_pane_process not supported on this platform".to_string())
    }
}
