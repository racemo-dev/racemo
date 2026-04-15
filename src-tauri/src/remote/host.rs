use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use prost::Message;
use tokio::sync::mpsc;
use webrtc::data_channel::RTCDataChannel;

use crate::ipc::protocol::{ClientMessage, ServerMessage};
use crate::layout::SplitDirection;
use crate::session::Session;
use super::proto;

const HEARTBEAT_INTERVAL_SECS: u64 = 30;

/// Remote host: bridges PTY output from racemo-server to WebRTC Data Channel.
pub struct RemoteHost {
    /// Receives PTY output from the IPC client bridge.
    bridge_rx: mpsc::UnboundedReceiver<ServerMessage>,
    /// Connected remote clients' data channels.
    data_channels: Vec<Arc<RTCDataChannel>>,
}

impl RemoteHost {
    pub fn new(bridge_rx: mpsc::UnboundedReceiver<ServerMessage>) -> Self {
        Self {
            bridge_rx,
            data_channels: Vec::new(),
        }
    }

    /// Add a connected client's data channel.
    pub fn add_client(&mut self, dc: Arc<RTCDataChannel>) {
        self.data_channels.push(dc);
    }

    /// Remove a disconnected client.
    pub fn remove_client(&mut self, label: &str) {
        self.data_channels.retain(|dc| dc.label() != label);
    }

    /// Start the bridge loop: PTY output → Protobuf → Data Channel.
    /// Also sends periodic heartbeats.
    pub async fn run_bridge(&mut self) {
        let mut heartbeat_interval =
            tokio::time::interval(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS));

        log::info!("[bridge] Bridge loop started, {} client(s)", self.data_channels.len());

        let mut bridge_alive = true;
        loop {
            tokio::select! {
                msg = self.bridge_rx.recv(), if bridge_alive => {
                    match msg {
                        Some(ServerMessage::PtyOutput { pane_id, data }) => {
                            log::debug!("[bridge] PtyOutput pane={pane_id} len={}", data.len());
                            let remote_msg = proto::RemoteMessage {
                                payload: Some(proto::remote_message::Payload::TerminalOutput(
                                    proto::TerminalOutput {
                                        pty_id: pane_id,
                                        data,
                                    },
                                )),
                            };
                            let bytes = remote_msg.encode_to_vec();
                            self.send_to_all(&bytes).await;
                        }
                        Some(ServerMessage::PtyExit { pane_id }) => {
                            log::info!("[bridge] PtyExit: {pane_id}");
                            let remote_msg = proto::RemoteMessage {
                                payload: Some(proto::remote_message::Payload::Disconnect(
                                    proto::Disconnect {
                                        reason: format!("PTY exited: {pane_id}"),
                                    },
                                )),
                            };
                            let bytes = remote_msg.encode_to_vec();
                            self.send_to_all(&bytes).await;
                        }
                        Some(ServerMessage::SessionUpdated { session }) => {
                            let layout_json = serde_json::to_string(&session.root_pane).unwrap_or_default();
                            log::info!("[bridge] SessionUpdated session={} panes={}", session.id, session.pane_count);
                            let remote_msg = proto::RemoteMessage {
                                payload: Some(proto::remote_message::Payload::LayoutUpdate(
                                    proto::LayoutUpdate {
                                        session_id: session.id,
                                        layout_json,
                                        pane_count: session.pane_count as u32,
                                    },
                                )),
                            };
                            let bytes = remote_msg.encode_to_vec();
                            self.send_to_all(&bytes).await;
                        }
                        Some(_) => {} // Ignore other messages
                        None => {
                            log::warn!("[bridge] bridge_rx closed (sender dropped), heartbeat-only mode");
                            bridge_alive = false;
                        }
                    }
                }
                _ = heartbeat_interval.tick() => {
                    self.send_heartbeat().await;
                }
            }
        }
    }

    /// Send encoded bytes to all connected data channels.
    async fn send_to_all(&self, bytes: &[u8]) {
        for dc in &self.data_channels {
            dc.send(&bytes::Bytes::copy_from_slice(bytes)).await.ok();
        }
    }

    /// Send a heartbeat message to all connected clients.
    async fn send_heartbeat(&self) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::Heartbeat(
                proto::Heartbeat { timestamp: timestamp as i64 },
            )),
        };
        let bytes = msg.encode_to_vec();
        self.send_to_all(&bytes).await;
    }

    /// Handle incoming data from a remote client's Data Channel.
    pub fn decode_remote_input(data: &[u8]) -> Result<proto::RemoteMessage, String> {
        proto::RemoteMessage::decode(data).map_err(|e| format!("Protobuf decode error: {e}"))
    }

    /// Returns true if the given remote message requires a request-response IPC call
    /// (i.e., we need to relay the response back through the DC).
    pub fn is_request_response(msg: &proto::RemoteMessage) -> bool {
        matches!(
            &msg.payload,
            Some(proto::remote_message::Payload::SessionListRequest(_))
                | Some(proto::remote_message::Payload::SplitPaneRequest(_))
                | Some(proto::remote_message::Payload::ClosePaneRequest(_))
        )
    }

    /// Encode a SessionListResponse from IPC Session data.
    pub fn encode_session_list(sessions: &[Session]) -> Vec<u8> {
        let host_os = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "unknown"
        };
        let session_infos: Vec<proto::SessionInfo> = sessions
            .iter()
            .map(|s| {
                let layout_json = serde_json::to_string(&s.root_pane).unwrap_or_default();
                proto::SessionInfo {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    pane_count: s.pane_count as u32,
                    created_at: s.created_at,
                    pane_ids: s.root_pane.pty_ids(),
                    layout_json,
                    host_os: host_os.to_string(),
                }
            })
            .collect();
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::SessionListResponse(
                proto::SessionListResponse {
                    sessions: session_infos,
                },
            )),
        };
        msg.encode_to_vec()
    }

    /// Convert a decoded remote message into an IPC ClientMessage for racemo-server.
    pub fn to_ipc_message(msg: &proto::RemoteMessage) -> Option<ClientMessage> {
        match &msg.payload {
            Some(proto::remote_message::Payload::TerminalInput(input)) => {
                Some(ClientMessage::WriteToPty {
                    pane_id: input.pty_id.clone(),
                    data: input.data.clone(),
                })
            }
            Some(proto::remote_message::Payload::ResizeRequest(resize)) => {
                Some(ClientMessage::RemoteResizePty {
                    pane_id: resize.pty_id.clone(),
                    rows: resize.rows as u16,
                    cols: resize.cols as u16,
                })
            }
            Some(proto::remote_message::Payload::SessionListRequest(_)) => {
                Some(ClientMessage::ListSessions)
            }
            Some(proto::remote_message::Payload::SplitPaneRequest(req)) => {
                let direction = match req.direction.as_str() {
                    "Vertical" => SplitDirection::Vertical,
                    _ => SplitDirection::Horizontal,
                };
                Some(ClientMessage::SplitPane {
                    session_id: req.session_id.clone(),
                    pane_id: req.pane_id.clone(),
                    direction,
                    shell: None,
                    rows: 24,
                    cols: 80,
                    before: req.before,
                })
            }
            Some(proto::remote_message::Payload::ClosePaneRequest(req)) => {
                Some(ClientMessage::ClosePane {
                    session_id: req.session_id.clone(),
                    pane_id: req.pane_id.clone(),
                })
            }
            Some(proto::remote_message::Payload::ResizePaneRequest(req)) => {
                Some(ClientMessage::ResizePane {
                    session_id: req.session_id.clone(),
                    split_id: req.split_id.clone(),
                    ratio: req.ratio,
                })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protobuf_roundtrip_terminal_input() {
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::TerminalInput(
                proto::TerminalInput {
                    pty_id: "pane-1".to_string(),
                    data: b"ls -la\n".to_vec(),
                },
            )),
        };
        let bytes = msg.encode_to_vec();
        let decoded = RemoteHost::decode_remote_input(&bytes).unwrap();

        match &decoded.payload {
            Some(proto::remote_message::Payload::TerminalInput(input)) => {
                assert_eq!(input.pty_id, "pane-1");
                assert_eq!(input.data, b"ls -la\n");
            }
            _ => panic!("Expected TerminalInput"),
        }
    }

    #[test]
    fn test_to_ipc_write_pty() {
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::TerminalInput(
                proto::TerminalInput {
                    pty_id: "pane-1".to_string(),
                    data: b"hello".to_vec(),
                },
            )),
        };
        let ipc = RemoteHost::to_ipc_message(&msg).unwrap();
        match ipc {
            ClientMessage::WriteToPty { pane_id, data } => {
                assert_eq!(pane_id, "pane-1");
                assert_eq!(data, b"hello");
            }
            _ => panic!("Expected WriteToPty"),
        }
    }

    #[test]
    fn test_to_ipc_resize() {
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::ResizeRequest(
                proto::ResizeRequest {
                    pty_id: "pane-2".to_string(),
                    rows: 24,
                    cols: 80,
                },
            )),
        };
        let ipc = RemoteHost::to_ipc_message(&msg).unwrap();
        match ipc {
            ClientMessage::RemoteResizePty { pane_id, rows, cols } => {
                assert_eq!(pane_id, "pane-2");
                assert_eq!(rows, 24);
                assert_eq!(cols, 80);
            }
            _ => panic!("Expected RemoteResizePty"),
        }
    }

    #[test]
    fn test_to_ipc_list_sessions() {
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::SessionListRequest(
                proto::SessionListRequest {},
            )),
        };
        let ipc = RemoteHost::to_ipc_message(&msg).unwrap();
        match ipc {
            ClientMessage::ListSessions => {}
            _ => panic!("Expected ListSessions"),
        }
    }

    #[test]
    fn test_to_ipc_unknown_returns_none() {
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::Heartbeat(
                proto::Heartbeat { timestamp: 12345 },
            )),
        };
        assert!(RemoteHost::to_ipc_message(&msg).is_none());
    }
}
