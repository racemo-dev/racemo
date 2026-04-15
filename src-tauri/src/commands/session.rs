use tauri::State;
use crate::ipc::protocol::{ClientMessage, ServerMessage, ShellType};
use crate::layout::SplitDirection;
use crate::session::Session;
use super::{ipc, IpcState};

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
