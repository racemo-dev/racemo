use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use prost::Message;
use tokio::sync::{mpsc, oneshot};
use webrtc::data_channel::RTCDataChannel;

use super::proto;

/// Maximum allowed Data Channel message size (16 MB).
const MAX_DC_MESSAGE_SIZE: usize = 16 * 1024 * 1024;

type PendingApiMap = HashMap<String, oneshot::Sender<Result<String, String>>>;

/// Remote client: receives terminal output from host via WebRTC Data Channel
/// and forwards decoded data to the Tauri frontend.
pub struct RemoteClient {
    /// Data channel connected to the host.
    data_channel: Option<Arc<RTCDataChannel>>,
    /// Sends decoded terminal output to the Tauri layer.
    output_tx: mpsc::UnboundedSender<RemoteOutput>,
    /// Pending API request callbacks keyed by request_id.
    pending_api_requests: Arc<std::sync::Mutex<PendingApiMap>>,
    /// Counter for generating unique request IDs.
    request_counter: Arc<AtomicU64>,
    /// Notified when the data channel transitions to Open state.
    dc_open_notify: Arc<tokio::sync::Notify>,
}

/// Session info received from the remote host via protobuf.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteSessionInfo {
    pub id: String,
    pub name: String,
    pub pane_count: u32,
    pub created_at: i64,
    pub pane_ids: Vec<String>,
    pub layout_json: String,
    pub host_os: String,
}

/// Output events from the remote host, forwarded to the frontend.
#[derive(Debug, Clone)]
pub enum RemoteOutput {
    TerminalOutput { pty_id: String, data: Vec<u8> },
    SessionList { sessions: Vec<RemoteSessionInfo> },
    Heartbeat { timestamp: i64 },
    LayoutUpdate { session_id: String, layout_json: String, pane_count: u32 },
    PtyResized { pty_id: String, rows: u16, cols: u16 },
    Disconnected { reason: String },
}

impl RemoteClient {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<RemoteOutput>) {
        let (output_tx, output_rx) = mpsc::unbounded_channel();
        (
            Self {
                data_channel: None,
                output_tx,
                pending_api_requests: Arc::new(std::sync::Mutex::new(HashMap::new())),
                request_counter: Arc::new(AtomicU64::new(1)),
                dc_open_notify: Arc::new(tokio::sync::Notify::new()),
            },
            output_rx,
        )
    }

    /// Set the data channel received from the host via WebRTC.
    pub fn set_data_channel(&mut self, dc: Arc<RTCDataChannel>) {
        let tx = self.output_tx.clone();
        let pending = self.pending_api_requests.clone();

        // Notify waiters when DC opens
        let notify = self.dc_open_notify.clone();
        dc.on_open(Box::new(move || {
            log::info!("[remote-client] DC on_open fired");
            notify.notify_waiters();
            Box::pin(async {})
        }));

        dc.on_message(Box::new(move |msg| {
            log::info!("[remote-client] DC on_message: {} bytes", msg.data.len());
            if msg.data.len() > MAX_DC_MESSAGE_SIZE {
                log::warn!(
                    "[remote-client] Dropping oversized DC message: {} bytes (limit {})",
                    msg.data.len(), MAX_DC_MESSAGE_SIZE,
                );
                return Box::pin(async {});
            }
            match proto::RemoteMessage::decode(msg.data.as_ref()) {
                Ok(remote_msg) => {
                    match remote_msg.payload {
                        Some(proto::remote_message::Payload::TerminalOutput(output)) => {
                            let _ = tx.send(RemoteOutput::TerminalOutput {
                                pty_id: output.pty_id,
                                data: output.data,
                            });
                        }
                        Some(proto::remote_message::Payload::Heartbeat(hb)) => {
                            let _ = tx.send(RemoteOutput::Heartbeat {
                                timestamp: hb.timestamp,
                            });
                        }
                        Some(proto::remote_message::Payload::Disconnect(d)) => {
                            let _ = tx.send(RemoteOutput::Disconnected {
                                reason: d.reason,
                            });
                        }
                        Some(proto::remote_message::Payload::SessionListResponse(resp)) => {
                            log::info!("[remote-client] SessionListResponse: {} sessions", resp.sessions.len());
                            for s in &resp.sessions {
                                log::info!("[remote-client]   session: id={} name={} panes={}", s.id, s.name, s.pane_ids.len());
                            }
                            let sessions: Vec<RemoteSessionInfo> = resp
                                .sessions
                                .iter()
                                .map(|s| RemoteSessionInfo {
                                    id: s.id.clone(),
                                    name: s.name.clone(),
                                    pane_count: s.pane_count,
                                    created_at: s.created_at,
                                    pane_ids: s.pane_ids.clone(),
                                    layout_json: s.layout_json.clone(),
                                    host_os: s.host_os.clone(),
                                })
                                .collect();
                            let _ = tx.send(RemoteOutput::SessionList { sessions });
                        }
                        Some(proto::remote_message::Payload::LayoutUpdate(update)) => {
                            log::info!("[remote-client] LayoutUpdate session={} panes={}", update.session_id, update.pane_count);
                            let _ = tx.send(RemoteOutput::LayoutUpdate {
                                session_id: update.session_id,
                                layout_json: update.layout_json,
                                pane_count: update.pane_count,
                            });
                        }
                        Some(proto::remote_message::Payload::PtyResized(resized)) => {
                            let _ = tx.send(RemoteOutput::PtyResized {
                                pty_id: resized.pty_id,
                                rows: resized.rows as u16,
                                cols: resized.cols as u16,
                            });
                        }
                        Some(proto::remote_message::Payload::ApiResponse(resp)) => {
                            log::info!("[remote-client] ApiResponse id={}", resp.request_id);
                            if let Ok(mut map) = pending.lock() {
                                if let Some(sender) = map.remove(&resp.request_id) {
                                    let result = if resp.error.is_empty() {
                                        Ok(resp.result_json)
                                    } else {
                                        Err(resp.error)
                                    };
                                    let _ = sender.send(result);
                                }
                            }
                        }
                        other => {
                            log::info!("[remote-client] DC unhandled payload: {:?}", other.map(|_| "some"));
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[remote-client] DC protobuf decode error: {e}");
                }
            }
            Box::pin(async {})
        }));

        self.data_channel = Some(dc);
    }

    /// Send terminal input to the host via Data Channel.
    pub async fn send_input(&self, pty_id: &str, data: &[u8]) -> Result<(), String> {
        let dc = self
            .data_channel
            .as_ref()
            .ok_or("No data channel")?;

        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::TerminalInput(
                proto::TerminalInput {
                    pty_id: pty_id.to_string(),
                    data: data.to_vec(),
                },
            )),
        };
        let bytes = msg.encode_to_vec();
        dc.send(&bytes::Bytes::copy_from_slice(&bytes))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Send a resize request to the host.
    pub async fn send_resize(
        &self,
        pty_id: &str,
        rows: u32,
        cols: u32,
    ) -> Result<(), String> {
        let dc = self
            .data_channel
            .as_ref()
            .ok_or("No data channel")?;

        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::ResizeRequest(
                proto::ResizeRequest {
                    pty_id: pty_id.to_string(),
                    rows,
                    cols,
                },
            )),
        };
        let bytes = msg.encode_to_vec();
        dc.send(&bytes::Bytes::copy_from_slice(&bytes))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Send a split pane request to the host.
    pub async fn send_split_pane(
        &self,
        session_id: &str,
        pane_id: &str,
        direction: &str,
        before: bool,
    ) -> Result<(), String> {
        let dc = self
            .data_channel
            .as_ref()
            .ok_or("No data channel")?;

        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::SplitPaneRequest(
                proto::SplitPaneRequest {
                    session_id: session_id.to_string(),
                    pane_id: pane_id.to_string(),
                    direction: direction.to_string(),
                    before,
                },
            )),
        };
        let bytes = msg.encode_to_vec();
        dc.send(&bytes::Bytes::copy_from_slice(&bytes))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Send a resize pane (split ratio) request to the host.
    pub async fn send_resize_pane(
        &self,
        session_id: &str,
        split_id: &str,
        ratio: f64,
    ) -> Result<(), String> {
        let dc = self
            .data_channel
            .as_ref()
            .ok_or("No data channel")?;

        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::ResizePaneRequest(
                proto::ResizePaneRequest {
                    session_id: session_id.to_string(),
                    split_id: split_id.to_string(),
                    ratio,
                },
            )),
        };
        let bytes = msg.encode_to_vec();
        dc.send(&bytes::Bytes::copy_from_slice(&bytes))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Send a close pane request to the host.
    pub async fn send_close_pane(
        &self,
        session_id: &str,
        pane_id: &str,
    ) -> Result<(), String> {
        let dc = self
            .data_channel
            .as_ref()
            .ok_or("No data channel")?;

        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::ClosePaneRequest(
                proto::ClosePaneRequest {
                    session_id: session_id.to_string(),
                    pane_id: pane_id.to_string(),
                },
            )),
        };
        let bytes = msg.encode_to_vec();
        dc.send(&bytes::Bytes::copy_from_slice(&bytes))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Request session list from the host.
    pub async fn request_session_list(&self) -> Result<(), String> {
        let dc = self
            .data_channel
            .as_ref()
            .ok_or("No data channel")?;

        log::info!("[remote-client] Sending SessionListRequest via DC (state: {:?})", dc.ready_state());
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::SessionListRequest(
                proto::SessionListRequest {},
            )),
        };
        let bytes = msg.encode_to_vec();
        log::info!("[remote-client] SessionListRequest encoded: {} bytes", bytes.len());
        match dc.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
            Ok(n) => {
                log::info!("[remote-client] SessionListRequest sent: {n} bytes");
                Ok(())
            }
            Err(e) => {
                log::error!("[remote-client] SessionListRequest send failed: {e}");
                Err(e.to_string())
            }
        }
    }

    /// Send an API request to the host and wait for the response.
    pub async fn send_api_request(&self, method: &str, params_json: &str) -> Result<String, String> {
        let dc = self
            .data_channel
            .as_ref()
            .ok_or("No data channel")?;

        let request_id = format!("req-{}", self.request_counter.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();

        {
            let mut map = self.pending_api_requests.lock().map_err(|e| e.to_string())?;
            map.insert(request_id.clone(), tx);
        }

        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::ApiRequest(
                proto::ApiRequest {
                    request_id: request_id.clone(),
                    method: method.to_string(),
                    params_json: params_json.to_string(),
                },
            )),
        };
        let bytes = msg.encode_to_vec();
        dc.send(&bytes::Bytes::copy_from_slice(&bytes))
            .await
            .map_err(|e| {
                // Clean up pending request on send failure
                if let Ok(mut map) = self.pending_api_requests.lock() {
                    map.remove(&request_id);
                }
                e.to_string()
            })?;

        // Wait for response with 60 second timeout (git push can take a long time)
        match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                Err("API request channel closed".to_string())
            }
            Err(_) => {
                // Clean up on timeout
                if let Ok(mut map) = self.pending_api_requests.lock() {
                    map.remove(&request_id);
                }
                Err("API request timed out".to_string())
            }
        }
    }

    /// Check if data channel is connected.
    pub fn is_connected(&self) -> bool {
        self.data_channel.is_some()
    }

    /// Check if data channel is in Open state (ready to send).
    pub fn is_dc_open(&self) -> bool {
        use webrtc::data_channel::data_channel_state::RTCDataChannelState;
        self.data_channel
            .as_ref()
            .is_some_and(|dc| dc.ready_state() == RTCDataChannelState::Open)
    }

    /// Wait for the data channel to open, with a timeout.
    /// Returns `true` if DC is open, `false` if timed out.
    pub async fn wait_dc_open(&self, timeout: std::time::Duration) -> bool {
        if self.is_dc_open() {
            return true;
        }
        match tokio::time::timeout(timeout, self.dc_open_notify.notified()).await {
            Ok(()) => true,
            Err(_) => self.is_dc_open(),
        }
    }

    /// Close the connection.
    pub fn close(&mut self) {
        self.data_channel = None;
    }
}
