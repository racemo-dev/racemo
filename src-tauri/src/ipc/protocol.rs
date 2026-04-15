use serde::{Deserialize, Serialize};
use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub use crate::layout::{PaneNode, SplitDirection, ShellType};
use crate::session::Session;

// ShellType moved to layout.rs

// ── Client → Server messages ────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub enum ClientMessage {
    // Session management
    CreateSession {
        name: Option<String>,
        working_dir: Option<String>,
        shell: Option<ShellType>,
        rows: u16,
        cols: u16,
    },
    ListSessions,
    AttachSession {
        session_id: String,
    },
    DetachSession {
        session_id: String,
    },
    CloseSession {
        session_id: String,
    },
    RenameSession {
        session_id: String,
        name: String,
    },

    // Pane operations
    SplitPane {
        session_id: String,
        pane_id: String,
        direction: SplitDirection,
        shell: Option<ShellType>,
        rows: u16,
        cols: u16,
        before: bool,
    },
    ClosePane {
        session_id: String,
        pane_id: String,
    },
    ResizePane {
        session_id: String,
        split_id: String,
        ratio: f64,
    },
    ResizePty {
        pane_id: String,
        rows: u16,
        cols: u16,
    },
    /// Remote client PTY resize — applied as min(host, remote) to prevent host display breakage.
    RemoteResizePty {
        pane_id: String,
        rows: u16,
        cols: u16,
    },

    // PTY I/O
    WriteToPty {
        pane_id: String,
        data: Vec<u8>,
    },

    /// Respawn a PTY with a different shell (kills existing PTY and starts new one)
    RespawnPty {
        session_id: String,
        pane_id: String,
        shell: ShellType,
        rows: u16,
        cols: u16,
    },

    // Pane metadata
    SetPaneLastCommand {
        session_id: String,
        pane_id: String,
        command: String,
    },

    // Connection management
    Ping,
    Shutdown,
    GetActiveSessionId,

    // Remote hosting (server-side WebRTC)
    StartHosting,
    StopHosting,
    GetHostingStatus,
    StartAccountHosting {
        jwt: String,
        device_name: String,
    },
    /// Approve or reject an incoming account-based connection request.
    ApproveAccountConnection {
        room_code: String,
        approved: bool,
    },

    /// Update the set of watched directories and editor file for fs change notifications.
    UpdateWatchedPaths {
        dirs: Vec<String>,
        editor_file: Option<String>,
    },
}

// ── Server → Client messages ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ServerMessage {
    // Session responses
    SessionCreated {
        session: Session,
    },
    SessionList {
        sessions: Vec<Session>,
    },
    SessionAttached {
        session: Session,
    },
    SessionDetached {
        session_id: String,
    },
    SessionClosed {
        remaining: Option<Session>,
    },
    SessionRenamed,
    SessionUpdated {
        session: Session,
    },
    /// Direct response to SplitPane/ClosePane/ResizePane requests (not broadcast).
    SessionModified {
        session: Session,
    },

    // PTY I/O
    PtyOutput {
        pane_id: String,
        data: Vec<u8>,
    },
    PtyExit {
        pane_id: String,
    },

    // Errors
    Error {
        code: ErrorCode,
        message: String,
    },

    // Connection management
    Pong,
    Ok,
    ActiveSessionId {
        session_id: Option<String>,
    },

    // Remote hosting responses
    HostingStarted {
        pairing_code: String,
    },
    HostingStopped,
    HostingStatus {
        status: String,
        pairing_code: Option<String>,
    },
    RemoteStatusChanged {
        status: String,
        pairing_code: Option<String>,
        error: Option<String>,
    },
    /// Incoming account-based connection request requiring user approval.
    AccountConnectionRequest {
        room_code: String,
        from_login: String,
        from_device: String,
    },
    /// A client has connected in account-based hosting mode.
    AccountClientConnected {
        room_code: String,
        from_login: String,
        from_device: String,
    },
    /// A client has disconnected in account-based hosting mode.
    AccountClientDisconnected {
        room_code: String,
    },

    /// Remote client opened a file in the editor → host should open it too.
    RemoteEditorOpen {
        path: String,
    },

    /// Remote client closed a file in the editor → host should close it too.
    RemoteEditorClose {
        path: String,
    },

    /// File system change notification (watched directories/files).
    FsChange {
        events: Vec<FsChangeEvent>,
    },

    /// PTY size changed on the host — remote clients should match this size.
    PtyResized {
        pane_id: String,
        rows: u16,
        cols: u16,
    },
}

/// A single file system change event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsChangeEvent {
    pub path: String,
    pub kind: String, // "created" | "removed" | "modified" | "renamed"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ErrorCode {
    SessionNotFound,
    PaneNotFound,
    PtySpawnFailed,
    InvalidOperation,
    InternalError,
}

// ── Length-prefixed MessagePack framing ──────────────────────────
//
// Wire format: [4 bytes big-endian length][MessagePack payload]

/// Write a frame: 4-byte big-endian length prefix + MessagePack payload.
pub async fn write_frame<W, T>(writer: &mut W, msg: &T) -> io::Result<()>
where
    W: AsyncWriteExt + Unpin,
    T: Serialize,
{
    let payload = rmp_serde::to_vec(msg)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let len = payload.len() as u32;
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}

/// Read a frame: 4-byte big-endian length prefix + MessagePack payload.
/// Returns None on clean EOF.
pub async fn read_frame<R, T>(reader: &mut R) -> io::Result<Option<T>>
where
    R: AsyncReadExt + Unpin,
    T: for<'de> Deserialize<'de>,
{
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len_buf) as usize;

    // Sanity check: reject messages > 16 MB
    if len > 16 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Frame too large: {len} bytes"),
        ));
    }

    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;

    let msg: T = rmp_serde::from_slice(&payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(msg))
}

// ── Platform-specific paths ──────────────────────────────────────

#[cfg(unix)]
mod platform_paths {
    pub fn default_socket_path() -> String {
        "/tmp/racemo.sock".to_string()
    }

    pub fn pid_file_path() -> String {
        "/tmp/racemo.pid".to_string()
    }
}

#[cfg(windows)]
mod platform_paths {
    pub fn default_socket_path() -> String {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string());
        format!(r"\\.\pipe\racemo-{}.pipe", user)
    }

    pub fn pid_file_path() -> String {
        let temp = std::env::var("TEMP").unwrap_or_else(|_| r"C:\Windows\Temp".to_string());
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string());
        format!(r"{}\racemo-{}.pid", temp, user)
    }
}

/// Get the default socket path for the current user.
pub fn default_socket_path() -> String {
    if let Ok(path) = std::env::var("RACEMO_SOCKET_PATH") {
        return path;
    }
    platform_paths::default_socket_path()
}

/// Get the PID file path for the server daemon.
pub fn pid_file_path() -> String {
    platform_paths::pid_file_path()
}
