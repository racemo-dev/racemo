pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/racemo.remote.rs"));
}

pub mod client;
pub mod pairing;
pub mod signaling;
pub mod webrtc_conn;
pub mod host;
pub mod server_host;

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

pub const DEFAULT_SIGNALING_URL: &str = "wss://racemo-signal.fly.dev";
pub const DEFAULT_SIGNALING_BASE_URL: &str = "https://racemo-signal.fly.dev";

/// Remote connection state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteConnectionState {
    Disconnected,
    Connecting,
    WaitingApproval,
    Connected,
    Failed(String),
}

/// Connected remote client info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteClient {
    pub id: String,
    pub name: String,
    #[serde(rename = "connectedAt")]
    pub connected_at: i64,
    pub state: RemoteConnectionState,
    #[serde(rename = "attachedSessionId")]
    pub attached_session_id: Option<String>,
}

/// Per-device client connection slot (multi-connection support).
pub struct ClientSlot {
    pub client: client::RemoteClient,
    pub close_tx: Option<tokio::sync::oneshot::Sender<()>>,
    pub signaling_close_tx: Option<tokio::sync::mpsc::UnboundedSender<signaling::OutCmd>>,
    pub close_done_rx: Option<tokio::sync::oneshot::Receiver<()>>,
    pub gen: u64,
}

/// State for the remote hosting session.
pub struct RemoteHostingState {
    /// Host side: sharing this device's terminal.
    pub host_status: RemoteConnectionState,
    pub pairing_code: Option<String>,

    /// Client side: multiple device connections keyed by device_id.
    pub clients: HashMap<String, ClientSlot>,
    /// Reverse lookup: pane_id → device_id (populated from session list events).
    pub pane_to_device: HashMap<String, String>,
    /// Reverse lookup: session_id → device_id (populated from session list events).
    pub session_to_device: HashMap<String, String>,
    /// Monotonically increasing generation counter for stale detection.
    pub next_gen: u64,
}

impl RemoteHostingState {
    /// Find the client that owns a given pane_id.
    pub fn client_for_pane(&self, pane_id: &str) -> Option<&client::RemoteClient> {
        let device_id = self.pane_to_device.get(pane_id)?;
        self.clients.get(device_id).map(|s| &s.client)
    }

    /// Find the client that owns a given session_id.
    pub fn client_for_session(&self, session_id: &str) -> Option<&client::RemoteClient> {
        let device_id = self.session_to_device.get(session_id)?;
        self.clients.get(device_id).map(|s| &s.client)
    }

    /// Register pane_ids and session_id mappings for a device.
    /// Clears stale mappings for this device before inserting new ones.
    pub fn register_device_sessions(
        &mut self,
        device_id: &str,
        sessions: &[client::RemoteSessionInfo],
    ) {
        // Clear stale mappings for this device first
        self.pane_to_device.retain(|_, v| v != device_id);
        self.session_to_device.retain(|_, v| v != device_id);
        // Insert fresh mappings
        for session in sessions {
            self.session_to_device.insert(session.id.clone(), device_id.to_string());
            for pane_id in &session.pane_ids {
                self.pane_to_device.insert(pane_id.clone(), device_id.to_string());
            }
        }
    }

    /// Register pane_ids from a layout update for a device.
    pub fn register_layout_panes(&mut self, device_id: &str, pane_ids: &[String]) {
        for pane_id in pane_ids {
            self.pane_to_device.insert(pane_id.clone(), device_id.to_string());
        }
    }

    /// Remove all mappings for a device.
    pub fn unregister_device(&mut self, device_id: &str) {
        self.pane_to_device.retain(|_, v| v != device_id);
        self.session_to_device.retain(|_, v| v != device_id);
    }
}

impl Default for RemoteHostingState {
    fn default() -> Self {
        Self {
            host_status: RemoteConnectionState::Disconnected,
            pairing_code: None,
            clients: HashMap::new(),
            pane_to_device: HashMap::new(),
            session_to_device: HashMap::new(),
            next_gen: 0,
        }
    }
}

pub type RemoteState = std::sync::Arc<tokio::sync::Mutex<RemoteHostingState>>;
