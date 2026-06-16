use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use prost::Message;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use webrtc::data_channel::RTCDataChannel;

use crate::ipc::protocol::ServerMessage;
use crate::ipc::server::ServerState;
use crate::remote::host::RemoteHost;
use crate::remote::pairing::generate_pairing_code;
use crate::remote::signaling::{SessionSummary, SignalingClient, SignalingMessage, SignalingSender};
use crate::remote::webrtc_conn::WebRtcManager;
use super::proto;

const HEARTBEAT_INTERVAL_SECS: u64 = 30;
/// Maximum allowed Data Channel message size (16 MB).
/// Messages exceeding this limit are dropped to prevent OOM from malicious peers.
const MAX_DC_MESSAGE_SIZE: usize = 16 * 1024 * 1024;
/// 현재 클라이언트 수가 플랜 제한에 도달했는지 여부를 반환합니다.
/// 여기서 사용되는 `max`는 서버 DeviceRegistered 응답에서 내려온 권위적 값.
fn client_limit_exceeded(current_count: usize, max: usize) -> bool {
    current_count >= max
}

type ApprovalSender = tokio::sync::mpsc::Sender<(String, bool)>;

/// Server-side remote hosting manager.
/// Runs inside racemo-server process, managing WebRTC connections directly.
pub struct RemoteHostManager {
    state: Arc<Mutex<ServerState>>,
    broadcast_tx: broadcast::Sender<ServerMessage>,
    pairing_code: Option<String>,
    status: String,
    stop_flag: Arc<AtomicBool>,
    shared_shutdown: Arc<parking_lot::Mutex<Option<oneshot::Sender<()>>>>,
    hosting_task: Option<JoinHandle<()>>,
    /// Sender for delivering approval decisions (room_code, approved) to the hosting loop.
    pending_approval_tx: Arc<parking_lot::Mutex<Option<ApprovalSender>>>,
    /// Generation counter: incremented on each start_account_based() to detect stale tasks.
    hosting_gen: Arc<AtomicUsize>,
}

impl RemoteHostManager {
    pub fn new(
        state: Arc<Mutex<ServerState>>,
        broadcast_tx: broadcast::Sender<ServerMessage>,
    ) -> Self {
        Self {
            state,
            broadcast_tx,
            pairing_code: None,
            status: "disconnected".to_string(),
            stop_flag: Arc::new(AtomicBool::new(false)),
            shared_shutdown: Arc::new(parking_lot::Mutex::new(None)),
            hosting_task: None,
            pending_approval_tx: Arc::new(parking_lot::Mutex::new(None)),
            hosting_gen: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Start hosting: generate pairing code, spawn background WebRTC task.
    pub async fn start(&mut self, signaling_url: &str) -> Result<String, String> {
        // Stop any existing hosting session
        self.stop().await;

        let code = generate_pairing_code();
        self.pairing_code = Some(code.clone());
        self.status = "connecting".to_string();

        self.stop_flag.store(false, Ordering::Relaxed);
        let (sd_tx, shutdown_rx) = oneshot::channel::<()>();
        *self.shared_shutdown.lock() = Some(sd_tx);

        let state = self.state.clone();
        let broadcast_tx = self.broadcast_tx.clone();
        let signaling_url = signaling_url.to_string();
        let code_clone = code.clone();

        let handle = tokio::spawn(async move {
            hosting_loop(state, broadcast_tx, signaling_url, code_clone, shutdown_rx).await;
        });

        self.hosting_task = Some(handle);
        Ok(code)
    }

    /// Start account-based hosting: register device with JWT and wait for connection requests.
    /// Reconnects automatically on signaling server disconnect (exponential backoff).
    pub async fn start_account_based(
        &mut self,
        signaling_url: &str,
        jwt: &str,
        device_name: &str,
    ) -> Result<(), String> {
        self.stop().await;
        self.stop_flag.store(false, Ordering::Relaxed);
        self.status = "connecting".to_string();

        let gen = self.hosting_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let hosting_gen = self.hosting_gen.clone();
        let stop_flag = self.stop_flag.clone();
        let shared_shutdown = self.shared_shutdown.clone();
        let state = self.state.clone();
        let broadcast_tx = self.broadcast_tx.clone();
        let signaling_url = signaling_url.to_string();
        let jwt = jwt.to_string();
        let device_name = device_name.to_string();

        // Channel for the first attempt to report success/failure synchronously.
        let (first_tx, first_rx) = oneshot::channel::<Result<(), String>>();

        let handle = tokio::spawn(async move {
            let mut attempt = 0u32;
            let mut first_result_tx = Some(first_tx);

            loop {
                if stop_flag.load(Ordering::Relaxed) { break; }
                // Stale task: a new start_account_based() was called, exit immediately.
                if hosting_gen.load(Ordering::SeqCst) != gen { break; }

                // JWT 만료 시 재인증 요청 후 중단
                if crate::auth::jwt_expired(&jwt) {
                    if let Some(tx) = first_result_tx.take() {
                        let _ = tx.send(Err("JWT expired, re-authentication required".to_string()));
                    } else {
                        emit_status(&broadcast_tx, "needs_reauth", None, None);
                    }
                    break;
                }

                // 이번 시도용 채널 생성
                let (sd_tx, sd_rx) = oneshot::channel::<()>();
                *shared_shutdown.lock() = Some(sd_tx);

                let should_retry = account_hosting_loop(
                    state.clone(),
                    broadcast_tx.clone(),
                    signaling_url.clone(),
                    jwt.clone(),
                    device_name.clone(),
                    sd_rx,
                    first_result_tx.take(),
                ).await;

                // If a new start_account_based() was called while we were in the loop,
                // exit without touching shared state (new task owns the channels now).
                if hosting_gen.load(Ordering::SeqCst) != gen { break; }

                *shared_shutdown.lock() = None;

                if !should_retry || stop_flag.load(Ordering::Relaxed) { break; }

                // 지수 백오프: 2s, 4s, 8s, 16s, 32s, 60s(최대)
                attempt += 1;
                let delay_secs = (2u64.pow(attempt.min(6))).min(60);
                log::info!("[server-host:acct] Reconnecting in {delay_secs}s (attempt {attempt})");
                emit_status(&broadcast_tx, "reconnecting", None, None);

                let sf = stop_flag.clone();
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(delay_secs)) => {}
                    _ = async move {
                        while !sf.load(Ordering::Relaxed) {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    } => { break; }
                }
            }
        });

        self.hosting_task = Some(handle);

        // Wait for the first connection attempt result synchronously.
        // This lets the caller (Tauri invoke) return success or error directly.
        match first_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                // First attempt failed — task already exited (returned false).
                self.status = "disconnected".to_string();
                Err(e)
            }
            Err(_) => {
                // Channel dropped without sending — task was aborted or stopped.
                self.status = "disconnected".to_string();
                Err("Hosting cancelled".to_string())
            }
        }
    }

    /// Approve or reject a pending account-based connection request.
    pub fn approve_connection(&self, room_code: &str, approved: bool) {
        if let Some(ref tx) = *self.pending_approval_tx.lock() {
            let _ = tx.try_send((room_code.to_string(), approved));
        }
    }

    /// Stop hosting.
    pub async fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(tx) = self.shared_shutdown.lock().take() {
            let _ = tx.send(());
        }
        *self.pending_approval_tx.lock() = None;
        if let Some(task) = self.hosting_task.take() {
            // Wait for graceful shutdown (WebSocket close frame sent).
            // If the task doesn't finish in 1s, force-abort to prevent
            // stale tasks from corrupting shared state on restart.
            let abort_handle = task.abort_handle();
            if tokio::time::timeout(Duration::from_secs(1), task).await.is_err() {
                log::warn!("[server-host] Hosting task did not finish in 1s, aborting");
                abort_handle.abort();
            }
        }
        self.status = "disconnected".to_string();
        self.pairing_code = None;
    }

    /// Get current status.
    pub fn get_status(&self) -> (String, Option<String>) {
        (self.status.clone(), self.pairing_code.clone())
    }

    /// Update status from the hosting task (called via broadcast).
    pub fn set_status(&mut self, status: &str) {
        self.status = status.to_string();
    }
}

/// Emit a RemoteStatusChanged message via broadcast.
fn emit_status(
    broadcast_tx: &broadcast::Sender<ServerMessage>,
    status: &str,
    pairing_code: Option<String>,
    error: Option<String>,
) {
    let _ = broadcast_tx.send(ServerMessage::RemoteStatusChanged {
        status: status.to_string(),
        pairing_code,
        error,
    });
}

// ── Multi-client types for account-based hosting ────────────────

struct ConnectedClient {
    dc: Arc<RTCDataChannel>,
    #[allow(dead_code)]
    from_login: String,
    #[allow(dead_code)]
    from_device: String,
    /// Sessions this client is subscribed to. Only PTY output for panes
    /// belonging to these sessions will be forwarded.
    subscribed_sessions: std::collections::HashSet<String>,
}

type ClientMap = Arc<Mutex<HashMap<String, ConnectedClient>>>;
type NegotiationMap = Arc<Mutex<HashMap<String, mpsc::Sender<SignalingMessage>>>>;
/// pty_id → session_id 역매핑. PtyOutput 이벤트에서 세션을 식별하는 데 사용.
type PtySessionMap = Arc<Mutex<HashMap<String, String>>>;

/// Register DC message handler for incoming protobuf commands.
fn register_dc_handler(
    dc: &Arc<RTCDataChannel>,
    state: Arc<Mutex<ServerState>>,
    client_map: ClientMap,
    room_code: String,
    broadcast_tx: broadcast::Sender<ServerMessage>,
) {
    let dc_for_reply = dc.clone();
    let history_sent: Arc<parking_lot::Mutex<std::collections::HashSet<String>>> =
        Arc::new(parking_lot::Mutex::new(std::collections::HashSet::new()));
    WebRtcManager::on_data_channel_message(dc, move |msg| {
        let data = &msg.data;
        if data.len() > MAX_DC_MESSAGE_SIZE {
            log::warn!(
                "[server-host:acct] Dropping oversized DC message: {} bytes (limit {})",
                data.len(), MAX_DC_MESSAGE_SIZE,
            );
            return;
        }
        if let Ok(remote_msg) = RemoteHost::decode_remote_input(data) {
            if let Some(proto::remote_message::Payload::ApiRequest(ref req)) = remote_msg.payload {
                if req.method == "open_editor" || req.method == "close_editor" {
                    let chunks = handle_editor_request(req, &broadcast_tx);
                    let dc_reply = dc_for_reply.clone();
                    tokio::spawn(async move {
                        for bytes in chunks {
                            if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                                log::warn!("[server-host:acct] api editor chunk send failed: {e}");
                                break;
                            }
                        }
                    });
                    return;
                }
                if req.method == "git_ai_auto_commit_stream" {
                    let request_id = req.request_id.clone();
                    let params: serde_json::Value = if req.params_json.is_empty() {
                        serde_json::json!({})
                    } else {
                        serde_json::from_str(&req.params_json).unwrap_or(serde_json::json!({}))
                    };
                    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".").to_string();
                    let dc_reply = dc_for_reply.clone();
                    tokio::spawn(async move {
                        handle_streaming_auto_commit(request_id, path, dc_reply).await;
                    });
                    return;
                }
                let req = req.clone();
                let dc_reply = dc_for_reply.clone();
                let state_clone = state.clone();
                tokio::spawn(async move {
                    let chunks = tokio::task::spawn_blocking(move || handle_api_request(&req, &state_clone))
                        .await
                        .unwrap_or_else(|e| {
                            log::error!("[api] spawn_blocking failed: {e}");
                            api_error_response("", "Internal error")
                        });
                    // Send chunks in order. SCTP DataChannel preserves order, so the
                    // receiver sees chunk_seq monotonically increasing per request.
                    for bytes in chunks {
                        if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                            log::warn!("[server-host:acct] api chunk send failed: {e}");
                            break;
                        }
                    }
                });
                return;
            }
            // Handle session subscription: add session to this client's subscribed set.
            if let Some(proto::remote_message::Payload::SessionSelect(ref sel)) = remote_msg.payload {
                let session_id = sel.session_id.clone();
                let mut map = client_map.lock();
                if let Some(client) = map.get_mut(&room_code) {
                    client.subscribed_sessions.insert(session_id.clone());
                    log::info!("[server-host:acct] Client {} subscribed to session {}", room_code, session_id);
                }
                return;
            }
            // PtyHistoryRequest: always send current PTY size, send history on first request only.
            if let Some(proto::remote_message::Payload::PtyHistoryRequest(ref req)) = remote_msg.payload {
                let pty_id = req.pty_id.clone();
                // Mark as seen; fetch size + history under a single lock to avoid TOCTOU.
                let is_first = history_sent.lock().insert(pty_id.clone());
                let (pty_size, history) = state.lock().get_pty_size_and_history(&pty_id, is_first);
                if pty_size.is_none() && history.is_none() {
                    // Explicit "unknown pty" signal: PtyResized(0, 0). Mobile uses
                    // this to bail out of the spinner immediately instead of waiting
                    // for a per-call timeout.
                    let dc_reply = dc_for_reply.clone();
                    let pty_id_clone = pty_id.clone();
                    tokio::spawn(async move {
                        let unknown_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::PtyResized(
                                proto::PtyResized {
                                    pty_id: pty_id_clone,
                                    cols: 0,
                                    rows: 0,
                                },
                            )),
                        };
                        let bytes = unknown_msg.encode_to_vec();
                        if let Err(e) = dc_reply
                            .send(&bytes::Bytes::copy_from_slice(&bytes))
                            .await
                        {
                            log::warn!("[server-host] unknown pty signal send failed: {e}");
                        }
                    });
                    return;
                }
                let dc_reply = dc_for_reply.clone();
                let pty_id_clone = pty_id.clone();
                tokio::spawn(async move {
                    if let Some((rows, cols)) = pty_size {
                        let size_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::PtyResized(proto::PtyResized {
                                pty_id: pty_id_clone.clone(),
                                cols: cols as u32,
                                rows: rows as u32,
                            })),
                        };
                        let bytes = size_msg.encode_to_vec();
                        if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                            log::warn!("[server-host:acct] pty size send failed: {e}");
                            return;
                        }
                    }
                    if let Some(data) = history {
                        if !data.is_empty() {
                            log::info!("[server-host:acct] sending {} bytes history for pane {}", data.len(), pty_id_clone);
                            const CHUNK_SIZE: usize = 32 * 1024;
                            for chunk in data.chunks(CHUNK_SIZE) {
                                let history_msg = proto::RemoteMessage {
                                    payload: Some(proto::remote_message::Payload::TerminalOutput(
                                        proto::TerminalOutput { pty_id: pty_id_clone.clone(), data: chunk.to_vec() },
                                    )),
                                };
                                let bytes = history_msg.encode_to_vec();
                                if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                                    log::warn!("[server-host:acct] history chunk send failed: {e}");
                                    break;
                                }
                            }
                        }
                    }
                });
                return;
            }
            // Validate pane ownership before allowing pane operations. Note
            // that TerminalInput/ResizeRequest use PTY ids, while
            // Split/ClosePaneRequest use pane container ids — these are
            // different UUIDs and must be checked against different maps.
            enum IdKind {
                Pty,
                Pane,
            }
            let id_to_check = match &remote_msg.payload {
                Some(proto::remote_message::Payload::TerminalInput(input)) => {
                    Some((input.pty_id.as_str(), IdKind::Pty))
                }
                Some(proto::remote_message::Payload::ResizeRequest(resize)) => {
                    Some((resize.pty_id.as_str(), IdKind::Pty))
                }
                Some(proto::remote_message::Payload::ClosePaneRequest(req)) => {
                    Some((req.pane_id.as_str(), IdKind::Pane))
                }
                Some(proto::remote_message::Payload::SplitPaneRequest(req)) => {
                    Some((req.pane_id.as_str(), IdKind::Pane))
                }
                _ => None,
            };
            if let Some((id, kind)) = id_to_check {
                let valid = {
                    let s = state.lock();
                    match kind {
                        IdKind::Pty => s.is_valid_pty(id),
                        IdKind::Pane => s.is_valid_pane(id),
                    }
                };
                if !valid {
                    log::warn!("[server-host:acct] unknown id {id} (kind={}) — allowing (may be stale)",
                        match kind { IdKind::Pty => "pty", IdKind::Pane => "pane" });
                }
            }
            let needs_reply = RemoteHost::is_request_response(&remote_msg);
            if let Some(ipc_msg) = RemoteHost::to_ipc_message(&remote_msg) {
                let response = { let mut s = state.lock(); s.handle_message(ipc_msg) };
                if needs_reply {
                    let reply_bytes = match response {
                        ServerMessage::SessionList { ref sessions } => {
                            // Auto-subscribe this client to all sessions so PTY output is forwarded.
                            {
                                let mut map = client_map.lock();
                                if let Some(client) = map.get_mut(&room_code) {
                                    for s in sessions {
                                        client.subscribed_sessions.insert(s.id.clone());
                                    }
                                    log::info!("[server-host:acct] Client {} auto-subscribed to {} sessions", room_code, sessions.len());
                                }
                            }
                            Some(RemoteHost::encode_session_list(sessions))
                        }
                        ServerMessage::SessionUpdated { ref session } => {
                            // Auto-subscribe to this session (handles new sessions from split/create).
                            {
                                let mut map = client_map.lock();
                                if let Some(client) = map.get_mut(&room_code) {
                                    client.subscribed_sessions.insert(session.id.clone());
                                }
                            }
                            let layout_json = serde_json::to_string(&session.root_pane).unwrap_or_default();
                            let layout_msg = proto::RemoteMessage {
                                payload: Some(proto::remote_message::Payload::LayoutUpdate(
                                    proto::LayoutUpdate {
                                        session_id: session.id.clone(),
                                        layout_json,
                                        pane_count: session.pane_count as u32,
                                    },
                                )),
                            };
                            Some(layout_msg.encode_to_vec())
                        }
                        _ => None,
                    };
                    if let Some(bytes) = reply_bytes {
                        let dc_reply = dc_for_reply.clone();
                        tokio::spawn(async move {
                            if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                                log::warn!("[server-host:acct] reply send failed: {e}");
                            }
                        });
                    }
                }
            }
        }
    });
}

/// Broadcast encoded protobuf bytes to ALL connected clients (control messages).
async fn broadcast_to_all_clients(client_map: &ClientMap, bytes: &[u8]) {
    let dcs: Vec<(String, Arc<RTCDataChannel>)> = {
        client_map.lock().iter().map(|(k, v)| (k.clone(), v.dc.clone())).collect()
    };
    for (rc, dc) in &dcs {
        if let Err(e) = dc.send(&bytes::Bytes::copy_from_slice(bytes)).await {
            log::warn!("[server-host:acct] DC send failed for {rc}: {e}");
        }
    }
}

/// Send encoded protobuf bytes only to clients subscribed to the given session.
#[allow(dead_code)]
async fn send_to_subscribed(client_map: &ClientMap, session_id: &str, bytes: &[u8]) {
    let dcs: Vec<(String, Arc<RTCDataChannel>)> = {
        client_map.lock().iter()
            .filter(|(_, c)| c.subscribed_sessions.contains(session_id))
            .map(|(k, v)| (k.clone(), v.dc.clone()))
            .collect()
    };
    for (rc, dc) in &dcs {
        if let Err(e) = dc.send(&bytes::Bytes::copy_from_slice(bytes)).await {
            log::warn!("[server-host:acct] DC send failed for {rc}: {e}");
        }
    }
}

#[allow(dead_code)]
/// Rebuild the pty_id → session_id map from current server state.
fn rebuild_pty_session_map(state: &Arc<Mutex<ServerState>>, pty_session_map: &PtySessionMap) {
    let s = state.lock();
    let mut map = pty_session_map.lock();
    map.clear();
    for session in &s.sessions {
        for pty_id in session.root_pane.pty_ids() {
            map.insert(pty_id, session.id.clone());
        }
    }
}

/// Per-client negotiation task: approve → WebRTC → DC open → add to client_map.
#[allow(clippy::too_many_arguments)]
async fn handle_client_negotiation(
    room_code: String,
    from_login: String,
    from_device: String,
    mut neg_rx: mpsc::Receiver<SignalingMessage>,
    sig_tx: SignalingSender,
    client_map: ClientMap,
    negotiation_map: NegotiationMap,
    state: Arc<Mutex<ServerState>>,
    broadcast_tx: broadcast::Sender<ServerMessage>,
    host_login: String,
    disconnect_tx: mpsc::Sender<String>,
) {
    // Auto-approve same user, auto-reject others (no manual approval step)
    let approved = if !host_login.is_empty() && from_login == host_login {
        log::info!("[server-host:acct:{room_code}] Auto-approving same user: {from_login}");
        true
    } else {
        log::warn!("[server-host:acct:{room_code}] Rejecting connection from different user: {from_login}");
        false
    };

    // 2. Send connection_response
    let response = serde_json::json!({
        "type": "connection_response",
        "approved": approved,
        "room_code": room_code,
    });
    if sig_tx.send(response.to_string()).is_err() {
        negotiation_map.lock().remove(&room_code);
        return;
    }

    if !approved {
        log::info!("[server-host:acct:{room_code}] Connection rejected");
        negotiation_map.lock().remove(&room_code);
        return;
    }
    log::info!("[server-host:acct:{room_code}] Connection approved");

    // 3. Create WebRTC PeerConnection
    let ice_servers = WebRtcManager::default_ice_servers();
    let mut webrtc = match WebRtcManager::new(ice_servers).await {
        Ok(w) => w,
        Err(e) => {
            log::error!("[server-host:acct:{room_code}] WebRTC create failed: {e}");
            negotiation_map.lock().remove(&room_code);
            return;
        }
    };

    // Connection state monitoring → disconnect_tx on failure
    {
        let dtx = disconnect_tx.clone();
        let rc = room_code.clone();
        let notified = Arc::new(std::sync::atomic::AtomicBool::new(false));
        webrtc.on_connection_state_change(move |conn_state| {
            use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
            log::info!("[HOST:conn-state:{rc}] WebRTC state changed → {conn_state:?}");
            match conn_state {
                RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed => {
                    if notified.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
                    log::info!("[HOST:conn-state:{rc}] Client PeerConnection {conn_state:?} — sending disconnect signal");
                    let dtx = dtx.clone();
                    let rc = rc.clone();
                    tokio::spawn(async move { let _ = dtx.send(rc).await; });
                }
                _ => {}
            }
        });
    }

    // 4. ICE candidate forwarding — include room_code
    let signaling_ice_tx = {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let sig_ref = sig_tx.clone();
        let rc = room_code.clone();
        tokio::spawn(async move {
            while let Some(candidate) = rx.recv().await {
                let msg = serde_json::json!({
                    "type": "ice_candidate",
                    "candidate": candidate,
                    "room_code": rc,
                });
                let _ = sig_ref.send(msg.to_string());
            }
        });
        tx
    };
    webrtc.on_ice_candidate(move |candidate| { let _ = signaling_ice_tx.send(candidate); });

    // 5. Create SDP offer
    let offer_sdp = match webrtc.create_offer().await {
        Ok(sdp) => sdp,
        Err(e) => {
            log::error!("[server-host:acct:{room_code}] create offer failed: {e}");
            negotiation_map.lock().remove(&room_code);
            return;
        }
    };

    // Register DC message handler
    if let Some(dc) = webrtc.data_channel() {
        register_dc_handler(&dc, state.clone(), client_map.clone(), room_code.clone(), broadcast_tx.clone());
    }

    let offer_msg = serde_json::json!({
        "type": "sdp_offer",
        "sdp": offer_sdp,
        "room_code": room_code,
    });
    if sig_tx.send(offer_msg.to_string()).is_err() {
        negotiation_map.lock().remove(&room_code);
        return;
    }

    // 6. Wait for SdpAnswer/ICE from neg_rx until DC opens
    let sdp_start = std::time::Instant::now();
    let mut sdp_answer_received = false;
    loop {
        if let Some(dc) = webrtc.data_channel() {
            use webrtc::data_channel::data_channel_state::RTCDataChannelState;
            if dc.ready_state() == RTCDataChannelState::Open {
                break;
            }
        }
        if sdp_start.elapsed() > std::time::Duration::from_secs(15) {
            let pc = webrtc.peer_connection_handle();
            log::error!(
                "[server-host:acct:{room_code}] DC failed to open within 15s \
                 (sdp_answer={sdp_answer_received} \
                  conn={:?} ice={:?} gathering={:?})",
                pc.connection_state(),
                pc.ice_connection_state(),
                pc.ice_gathering_state(),
            );
            negotiation_map.lock().remove(&room_code);
            let _ = webrtc.close().await;
            return;
        }
        tokio::select! {
            msg = neg_rx.recv() => {
                match msg {
                    Some(SignalingMessage::SdpAnswer { sdp, .. }) => {
                        log::info!("[server-host:acct:{room_code}] Received SdpAnswer via neg_rx, setting remote answer");
                        if let Err(e) = webrtc.set_remote_answer(&sdp).await {
                            log::error!("[server-host:acct:{room_code}] set_remote_answer failed: {e}");
                            negotiation_map.lock().remove(&room_code);
                            let _ = webrtc.close().await;
                            return;
                        }
                        sdp_answer_received = true;
                        log::info!("[server-host:acct:{room_code}] Remote answer set successfully");
                    }
                    Some(SignalingMessage::IceCandidate { candidate, .. }) => {
                        if let Err(e) = webrtc.add_ice_candidate(&candidate).await {
                            log::warn!("[server-host:acct:{room_code}] add_ice_candidate failed: {e}");
                        }
                    }
                    None => {
                        log::warn!("[server-host:acct:{room_code}] neg_rx closed during negotiation");
                        negotiation_map.lock().remove(&room_code);
                        let _ = webrtc.close().await;
                        return;
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
        }
    }

    // 7. DC open → add to client_map + emit AccountClientConnected
    log::info!("[server-host:acct:{room_code}] DC open — client connected: {from_login}");
    if let Some(dc) = webrtc.data_channel() {
        let is_first = {
            let mut map = client_map.lock();
            map.insert(room_code.clone(), ConnectedClient {
                dc,
                from_login: from_login.clone(),
                from_device: from_device.clone(),
                subscribed_sessions: std::collections::HashSet::new(),
            });
            map.len() == 1
        };
        if is_first {
            emit_status(&broadcast_tx, "connected", None, None);
        }
        let _ = broadcast_tx.send(ServerMessage::AccountClientConnected {
            room_code: room_code.clone(),
            from_login: from_login.clone(),
            from_device: from_device.clone(),
        });
    }

    // 8. Remove from negotiation_map (negotiation complete)
    negotiation_map.lock().remove(&room_code);

    // 9. Keep webrtc alive until client is removed from client_map (by disconnect_rx in main loop)
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if !client_map.lock().contains_key(&room_code) {
            log::info!("[HOST:cleanup:{room_code}] Client removed from client_map — closing WebRTC");
            break;
        }
    }

    if let Err(e) = webrtc.close().await {
        log::error!("[HOST:cleanup:{room_code}] PeerConnection close failed: {e}");
    } else {
        log::info!("[HOST:cleanup:{room_code}] PeerConnection closed successfully");
    }
    log::info!("[HOST:cleanup:{room_code}] Negotiation task finished");
}

/// Account-based hosting loop: JWT device registration → concurrent client handling.
/// Returns `true` if the loop should retry (transient error), `false` for permanent errors (e.g. plan limit).
///
/// `first_result_tx`: If Some, this is the first attempt — report success/failure synchronously
/// to the caller instead of emitting status events. On error, return `false` (no retry).
#[allow(clippy::too_many_arguments)]
async fn account_hosting_loop(
    state: Arc<Mutex<ServerState>>,
    broadcast_tx: broadcast::Sender<ServerMessage>,
    signaling_url: String,
    jwt: String,
    device_name: String,
    mut shutdown_rx: oneshot::Receiver<()>,
    first_result_tx: Option<oneshot::Sender<Result<(), String>>>,
) -> bool {
    // Percent-encode device_name and sessions
    let extra_params = {
        let enc: String = device_name.bytes().map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                String::from(b as char)
            } else {
                format!("%{:02X}", b)
            }
        }).collect();
        let s = state.lock();
        let sessions_param = if s.sessions.is_empty() {
            String::new()
        } else {
            let sessions: Vec<serde_json::Value> = s.sessions.iter().map(|sess| {
                serde_json::json!({"name": sess.name, "pane_count": sess.pane_count})
            }).collect();
            let json = serde_json::to_string(&sessions).unwrap_or_default();
            let encoded: String = json.bytes().map(|b| {
                if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                    String::from(b as char)
                } else {
                    format!("%{:02X}", b)
                }
            }).collect();
            format!("&sessions={encoded}")
        };
        let os_param = if cfg!(target_os = "macos") {
            "&os=macos"
        } else if cfg!(target_os = "windows") {
            "&os=windows"
        } else {
            "&os=linux"
        };
        format!("&device_name={enc}{sessions_param}{os_param}")
    };

    let host_login = crate::auth::login_from_jwt(&jwt).unwrap_or_default();
    // NOTE: JWT에서 읽은 plan은 미검증값이므로 **UI 로그 용도로만** 사용.
    // 실제 max_clients는 서버가 DeviceRegistered 메시지에서 내려주는 값을 사용한다.
    // 서버 값이 없을 때의 fallback은 가장 보수적인 1 (free 플랜 수준).
    let host_plan = crate::auth::plan_from_jwt(&jwt).unwrap_or_default();
    log::info!("[server-host:acct] (unverified) plan={host_plan} — waiting for server-authoritative max_clients");

    log::info!("[server-host:acct] Connecting to signaling: {signaling_url}");
    let mut signaling = match SignalingClient::connect_with_token(&signaling_url, "host", &jwt, &extra_params).await {
        Ok(s) => s,
        Err(e) => {
            if let Some(tx) = first_result_tx {
                // First attempt: report error synchronously, don't retry.
                log::warn!("[server-host:acct] First connect failed: {e}");
                let _ = tx.send(Err(e));
                return false;
            }
            log::warn!("[server-host:acct] Connect failed (will retry): {e}");
            emit_status(&broadcast_tx, "reconnecting", None, Some(e));
            return true; // transient error, retry after backoff
        }
    };

    // Wait for DeviceRegistered confirmation
    // 서버가 권위적으로 내려주는 max_clients를 여기서 캡처. 없으면 1로 fallback.
    let mut max_clients: usize = 1;
    {
        let mut frt = first_result_tx;
        loop {
            tokio::select! {
                msg = signaling.recv() => {
                    match msg {
                        Some(SignalingMessage::DeviceRegistered { device_id, max_clients: server_max, .. }) => {
                            if let Some(mc) = server_max {
                                // 서버 제공값이 있으면 신뢰. 로컬 JWT decode 결과는 무시.
                                max_clients = mc;
                            }
                            log::info!(
                                "[server-host:acct] Registered as device: {device_id} (max_clients={max_clients}, server-authoritative={})",
                                server_max.is_some()
                            );
                            if let Some(tx) = frt.take() {
                                let _ = tx.send(Ok(()));
                            }
                            break;
                        }
                        Some(SignalingMessage::Error { message, .. }) => {
                            if let Some(tx) = frt.take() {
                                log::warn!("[server-host:acct] First registration error: {message}");
                                let _ = tx.send(Err(message));
                                return false;
                            }
                            log::warn!("[server-host:acct] Registration error (will retry): {message}");
                            emit_status(&broadcast_tx, "reconnecting", None, Some(message));
                            return true;
                        }
                        None => {
                            if let Some(tx) = frt.take() {
                                let _ = tx.send(Err("Connection dropped during registration".to_string()));
                                return false;
                            }
                            return true;
                        }
                        _ => {}
                    }
                }
                _ = &mut shutdown_rx => {
                    signaling.close();
                    if let Some(tx) = frt.take() {
                        let _ = tx.send(Err("Hosting cancelled".to_string()));
                    }
                    return false;
                }
            }
        }
    }

    emit_status(&broadcast_tx, "account_waiting", None, None);
    log::info!("[server-host:acct] Device registered — waiting for connection requests");

    let client_map: ClientMap = Arc::new(Mutex::new(HashMap::new()));
    let negotiation_map: NegotiationMap = Arc::new(Mutex::new(HashMap::new()));
    let pty_session_map: PtySessionMap = Arc::new(Mutex::new(HashMap::new()));
    rebuild_pty_session_map(&state, &pty_session_map);
    let (disconnect_tx, mut disconnect_rx) = mpsc::channel::<String>(16);
    let sig_tx = signaling.clone_tx();

    let mut bridge_rx = broadcast_tx.subscribe();
    let mut heartbeat_interval = tokio::time::interval(
        std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS),
    );

    // 100ms coalescing throttle for `update_sessions` pushes:
    // rapid create/close/rename bursts (e.g. user spamming Cmd+T) collapse
    // into one message rather than flooding the signaling server.
    // First event of a burst sets the deadline; subsequent events inside the
    // window are absorbed (no extension) to guarantee at most one push per
    // 100ms even under continuous load. The timer arm only fires when
    // `sessions_dirty` is true.
    let sessions_debounce = tokio::time::sleep(std::time::Duration::from_millis(100));
    tokio::pin!(sessions_debounce);
    let mut sessions_dirty = false;

    loop {
        tokio::select! {
            msg = signaling.recv() => {
                match msg {
                    Some(SignalingMessage::ConnectionRequest { room_code, from_user, from_device }) => {
                        let from_login = from_user.as_ref().map(|u| u.login.as_str()).unwrap_or("unknown").to_string();
                        let from_device_str = from_device.as_deref().unwrap_or("unknown").to_string();
                        log::info!("[server-host:acct] ConnectionRequest: room={room_code} from={from_login}");

                        // Drain any pending disconnects before checking the limit.
                        // This avoids a race condition where the old client's PeerConnection
                        // has closed but the disconnect hasn't been processed yet.
                        while let Ok(rc) = disconnect_rx.try_recv() {
                            log::info!("[HOST:disconnect] Draining pending disconnect: room={rc}");
                            client_map.lock().remove(&rc);
                            let _ = broadcast_tx.send(ServerMessage::AccountClientDisconnected {
                                room_code: rc,
                            });
                        }

                        // 동시 클라이언트 수 제한 확인
                        let current_count = client_map.lock().len();
                        if client_limit_exceeded(current_count, max_clients) {
                            log::warn!("[HOST:limit] Client limit exceeded: current={current_count} max={max_clients} — rejecting room={room_code} from={from_login}");
                            let rejection = serde_json::json!({
                                "type": "connection_response",
                                "approved": false,
                                "room_code": room_code,
                            });
                            sig_tx.send(rejection.to_string()).ok();
                            continue;
                        }

                        let (neg_tx, neg_rx) = mpsc::channel::<SignalingMessage>(16);
                        negotiation_map.lock().insert(room_code.clone(), neg_tx);

                        tokio::spawn(handle_client_negotiation(
                            room_code,
                            from_login,
                            from_device_str,
                            neg_rx,
                            sig_tx.clone(),
                            client_map.clone(),
                            negotiation_map.clone(),
                            state.clone(),
                            broadcast_tx.clone(),
                            host_login.clone(),
                            disconnect_tx.clone(),
                        ));
                    }
                    Some(SignalingMessage::SdpAnswer { sdp, room_code, .. }) => {
                        let neg_map = negotiation_map.lock();
                        let target_tx = if let Some(rc) = &room_code {
                            log::info!("[server-host:acct] Received SdpAnswer for room: {rc}");
                            neg_map.get(rc.as_str())
                        } else if neg_map.len() == 1 {
                            // Fallback: signaling server didn't inject room_code
                            let Some((rc, tx)) = neg_map.iter().next() else { continue };
                            log::info!("[server-host:acct] Received SdpAnswer (no room_code), routing to sole negotiation: {rc}");
                            Some(tx)
                        } else {
                            log::warn!("[server-host:acct] SdpAnswer without room_code and {} active negotiations — dropping", neg_map.len());
                            None
                        };
                        if let Some(tx) = target_tx {
                            if let Err(e) = tx.try_send(SignalingMessage::SdpAnswer { sdp, room_code }) {
                                log::error!("[server-host:acct] Failed to route SdpAnswer: {e}");
                            }
                        }
                    }
                    Some(SignalingMessage::IceCandidate { candidate, room_code, .. }) => {
                        let neg_map = negotiation_map.lock();
                        let target_tx = if let Some(rc) = &room_code {
                            neg_map.get(rc.as_str())
                        } else if neg_map.len() == 1 {
                            neg_map.iter().next().map(|(_, tx)| tx)
                        } else {
                            None
                        };
                        if let Some(tx) = target_tx {
                            if let Err(e) = tx.try_send(SignalingMessage::IceCandidate { candidate, room_code }) {
                                log::error!("[server-host:acct] Failed to route IceCandidate: {e}");
                            }
                        }
                    }
                    Some(SignalingMessage::PeerMessage { payload }) => {
                        // 현재 v1 에서는 모바일 → 데스크탑 방향 peer_message 사용 사례
                        // 없음. forward-compat 으로 enum 매칭만 하고 로깅. 향후 모바일이
                        // 클라이언트→호스트 이벤트(typing indicator 등)를 보낼 때 여기에
                        // 디스패치 로직 추가.
                        log::debug!("[server-host:acct] received PeerMessage payload={payload}");
                    }
                    Some(SignalingMessage::ClientDisconnected { room_code: rc }) => {
                        // Signaling server notifies us that a client's WebSocket closed.
                        // Remove from client_map immediately so reconnect isn't rejected.
                        let removed = client_map.lock().remove(&rc).is_some();
                        if removed {
                            log::info!("[HOST:sig-disconnect] Client WS closed (signaling): room={rc} — removed from client_map");
                            let _ = broadcast_tx.send(ServerMessage::AccountClientDisconnected {
                                room_code: rc,
                            });
                            if client_map.lock().is_empty() {
                                emit_status(&broadcast_tx, "account_waiting", None, None);
                            }
                        } else {
                            log::debug!("[HOST:sig-disconnect] room={rc} not in client_map (already cleaned up)");
                        }
                    }
                    None => {
                        log::info!("[server-host:acct] Signaling closed");
                        break;
                    }
                    other => {
                        log::debug!("[server-host:acct] Unhandled signaling message: {other:?}");
                    }
                }
            }

            msg = bridge_rx.recv() => {
                match msg {
                    Ok(ServerMessage::PtyOutput { pane_id, data }) => {
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::TerminalOutput(
                                proto::TerminalOutput { pty_id: pane_id, data },
                            )),
                        };
                        broadcast_to_all_clients(&client_map, &remote_msg.encode_to_vec()).await;
                    }
                    Ok(ServerMessage::PtyResized { pane_id: _, rows: _, cols: _ }) => {
                        // Mobile clients get the authoritative PTY size via PtyHistoryRequest
                        // and never send resize back to the host. Forwarding live resize events
                        // pre-populates ptyLastKnownSizeProvider before the terminal screen
                        // mounts, which bypasses the spinner guard and causes duplicate prompt
                        // output on new sessions. Skip — mobile doesn't need this.
                    }
                    Ok(ServerMessage::PtyExit { pane_id }) => {
                        // Signal PTY exit as PtyResized(0, 0) so each mobile client can
                        // bail only for the specific pane it is watching, without
                        // disconnecting unrelated sessions. A full Disconnect here was
                        // wrong: it dropped every connected client whenever any pane closed.
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::PtyResized(
                                proto::PtyResized { pty_id: pane_id, cols: 0, rows: 0 },
                            )),
                        };
                        broadcast_to_all_clients(&client_map, &remote_msg.encode_to_vec()).await;
                    }
                    Ok(ServerMessage::SessionUpdated { session }) => {
                        // Rebuild pty→session map since pane structure changed
                        rebuild_pty_session_map(&state, &pty_session_map);
                        let layout_json = serde_json::to_string(&session.root_pane).unwrap_or_default();
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::LayoutUpdate(
                                proto::LayoutUpdate {
                                    session_id: session.id,
                                    layout_json,
                                    pane_count: session.pane_count as u32,
                                },
                            )),
                        };
                        broadcast_to_all_clients(&client_map, &remote_msg.encode_to_vec()).await;
                        // Pane count changed → signaling server's session snapshot is stale.
                        if !sessions_dirty {
                            sessions_dirty = true;
                            sessions_debounce.as_mut().reset(
                                tokio::time::Instant::now() + std::time::Duration::from_millis(100),
                            );
                        }
                    }
                    Ok(ServerMessage::SessionListChanged) => {
                        // Session was created / closed / renamed. Pane→session map
                        // can change too (new session = new pty), so rebuild it.
                        log::info!("[server-host:acct] SessionListChanged received — marking sessions dirty");
                        rebuild_pty_session_map(&state, &pty_session_map);
                        if !sessions_dirty {
                            sessions_dirty = true;
                            sessions_debounce.as_mut().reset(
                                tokio::time::Instant::now() + std::time::Duration::from_millis(100),
                            );
                        }
                    }
                    Ok(ServerMessage::RemoteStatusChanged { .. }) => {}
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("[server-host:acct] bridge lagged, skipped {n} messages");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        log::error!("[server-host:acct] broadcast closed");
                        break;
                    }
                }
            }

            room_code = disconnect_rx.recv() => {
                if let Some(rc) = room_code {
                    let remaining = {
                        let mut map = client_map.lock();
                        map.remove(&rc);
                        map.len()
                    };
                    log::info!("[HOST:disconnect] Client disconnected: room={rc}, remaining_clients={remaining}");
                    let _ = broadcast_tx.send(ServerMessage::AccountClientDisconnected {
                        room_code: rc,
                    });
                    if remaining == 0 {
                        log::info!("[HOST:disconnect] No clients left — restoring host PTY sizes");
                        { state.lock().clear_all_remote_pty_sizes(); }
                        emit_status(&broadcast_tx, "account_waiting", None, None);
                    }
                }
            }

            _ = heartbeat_interval.tick() => {
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let msg = proto::RemoteMessage {
                    payload: Some(proto::remote_message::Payload::Heartbeat(
                        proto::Heartbeat { timestamp },
                    )),
                };
                broadcast_to_all_clients(&client_map, &msg.encode_to_vec()).await;

                // Ping the signaling server to detect dead TCP connections (e.g. after sleep).
                // The first ping after sleep will trigger a failed write in the outgoing task,
                // which signals the incoming task to stop → signaling.recv() returns None.
                // The next tick (fired immediately by Tokio catching up) will see Err here and break.
                if sig_tx.ping().is_err() {
                    log::warn!("[server-host:acct] Signaling ping failed — connection dead after sleep, reconnecting");
                    break;
                }
            }

            // Debounced UpdateSessions push. Fires 100ms after the last
            // session-changing event; the `if sessions_dirty` guard prevents
            // refiring once the timer has elapsed and we've consumed the dirty bit.
            _ = &mut sessions_debounce, if sessions_dirty => {
                sessions_dirty = false;
                let summaries = snapshot_session_summaries(&state);
                push_update_sessions(&sig_tx, summaries);
                // Also broadcast a fresh SessionListResponse to every connected
                // remote (mobile) client so they don't sit on a stale list when
                // the user closes a session in the desktop UI.
                let sessions_clone: Vec<crate::session::Session> = state.lock().sessions.clone();
                let payload = crate::remote::host::RemoteHost::encode_session_list(&sessions_clone);
                broadcast_to_all_clients(&client_map, &payload).await;
            }

            _ = &mut shutdown_rx => {
                log::info!("[server-host:acct] shutdown signal");
                // Send explicit host_disconnect so the signaling server unregisters
                // our device immediately, before the WebSocket close frame propagates.
                let _ = sig_tx.send(r#"{"type":"host_disconnect"}"#.to_string());
                // Then close WebSocket gracefully.
                signaling.close();
                let dcs: Vec<(String, Arc<RTCDataChannel>)> = {
                    client_map.lock().drain().map(|(k, v)| (k, v.dc)).collect()
                };
                for (_, dc) in dcs {
                    let _ = dc.close().await;
                }
                break;
            }
        }
    }

    signaling.close();
    emit_status(&broadcast_tx, "disconnected", None, None);
    log::info!("[server-host:acct] Account hosting task finished");
    true // connection dropped normally, allow outer loop to retry
}

/// Snapshot the current session list as `Vec<SessionSummary>` for signaling pushes.
fn snapshot_session_summaries(state: &Arc<Mutex<ServerState>>) -> Vec<SessionSummary> {
    state
        .lock()
        .sessions
        .iter()
        .map(|s| SessionSummary {
            name: s.name.clone(),
            pane_count: s.pane_count.max(1) as u32,
        })
        .collect()
}

/// Send an UpdateSessions message to the signaling server. Best-effort: errors
/// are logged but do not break hosting (old signaling servers will ignore the
/// unknown `update_sessions` type — see scenario C in the design doc).
fn push_update_sessions(sig_tx: &SignalingSender, summaries: Vec<SessionSummary>) {
    let count = summaries.len();
    let msg = SignalingMessage::UpdateSessions { sessions: summaries };
    match serde_json::to_string(&msg) {
        Ok(payload) => {
            if let Err(e) = sig_tx.send(payload) {
                log::warn!("[server-host:acct] update_sessions push failed: {e}");
            } else {
                log::info!("[server-host:acct] update_sessions pushed (count={count})");
            }
        }
        Err(e) => {
            log::warn!("[server-host:acct] update_sessions encode failed: {e}");
        }
    }
}

/// Build percent-encoded sessions query param from server state.
fn build_sessions_param(state: &Arc<Mutex<ServerState>>) -> String {
    let s = state.lock();
    if s.sessions.is_empty() {
        return String::new();
    }
    let sessions: Vec<serde_json::Value> = s.sessions.iter().map(|sess| {
        serde_json::json!({"name": sess.name, "pane_count": sess.pane_count})
    }).collect();
    let json = serde_json::to_string(&sessions).unwrap_or_default();
    let encoded: String = json.bytes().map(|b| {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            String::from(b as char)
        } else {
            format!("%{:02X}", b)
        }
    }).collect();
    format!("&sessions={}", encoded)
}

/// Set up WebRTC connection state monitoring + DC close signaling for pairing-based hosting.
fn setup_pairing_connection_monitor(
    webrtc: &mut WebRtcManager,
    broadcast_tx: &broadcast::Sender<ServerMessage>,
    code: &str,
    dc_closed_tx: mpsc::Sender<()>,
    shutting_down: &Arc<std::sync::atomic::AtomicBool>,
    iteration: u32,
) {
    let btx = broadcast_tx.clone();
    let code_for_cb = code.to_string();
    let notified = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let shutting_down_cb = shutting_down.clone();
    webrtc.on_connection_state_change(move |conn_state| {
        use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
        log::info!("[server-host:{iteration}] WebRTC state: {:?}", conn_state);
        match conn_state {
            RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed => {
                if shutting_down_cb.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                if notified.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let btx = btx.clone();
                let code_for_emit = code_for_cb.clone();
                let tx = dc_closed_tx.clone();
                tokio::spawn(async move {
                    emit_status(&btx, "waiting", Some(code_for_emit), None);
                    let _ = tx.send(()).await;
                });
            }
            _ => {}
        }
    });
}

/// Register DC message handler for pairing-based hosting (single-client).
fn register_pairing_dc_handler(
    dc: &Arc<RTCDataChannel>,
    state: Arc<Mutex<ServerState>>,
    broadcast_tx: broadcast::Sender<ServerMessage>,
) {
    let dc_for_reply = dc.clone();
    let history_sent: Arc<parking_lot::Mutex<std::collections::HashSet<String>>> =
        Arc::new(parking_lot::Mutex::new(std::collections::HashSet::new()));
    WebRtcManager::on_data_channel_message(dc, move |msg| {
        let data = &msg.data;
        if data.len() > MAX_DC_MESSAGE_SIZE {
            log::warn!(
                "[server-host] Dropping oversized DC message: {} bytes (limit {})",
                data.len(), MAX_DC_MESSAGE_SIZE,
            );
            return;
        }
        if let Ok(remote_msg) = RemoteHost::decode_remote_input(data) {
            if let Some(proto::remote_message::Payload::ApiRequest(ref req)) = remote_msg.payload {
                if req.method == "open_editor" || req.method == "close_editor" {
                    let chunks = handle_editor_request(req, &broadcast_tx);
                    let dc_reply = dc_for_reply.clone();
                    tokio::spawn(async move {
                        for bytes in chunks {
                            if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                                log::warn!("[server-host] api editor chunk send failed: {e}");
                                break;
                            }
                        }
                    });
                    return;
                }
                if req.method == "git_ai_auto_commit_stream" {
                    let request_id = req.request_id.clone();
                    let params: serde_json::Value = if req.params_json.is_empty() {
                        serde_json::json!({})
                    } else {
                        serde_json::from_str(&req.params_json).unwrap_or(serde_json::json!({}))
                    };
                    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".").to_string();
                    let dc_reply = dc_for_reply.clone();
                    tokio::spawn(async move {
                        handle_streaming_auto_commit(request_id, path, dc_reply).await;
                    });
                    return;
                }
                let req = req.clone();
                let dc_reply = dc_for_reply.clone();
                let state_clone = state.clone();
                tokio::spawn(async move {
                    let chunks = tokio::task::spawn_blocking(move || handle_api_request(&req, &state_clone))
                        .await
                        .unwrap_or_else(|e| {
                            log::error!("[api] spawn_blocking failed: {e}");
                            api_error_response("", "Internal error")
                        });
                    for bytes in chunks {
                        if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                            log::warn!("[server-host] api chunk send failed: {e}");
                            break;
                        }
                    }
                });
                return;
            }
            // PtyHistoryRequest: always send current PTY size, send history on first request only.
            if let Some(proto::remote_message::Payload::PtyHistoryRequest(ref req)) = remote_msg.payload {
                let pty_id = req.pty_id.clone();
                // Mark as seen; fetch size + history under a single lock to avoid TOCTOU.
                let is_first = history_sent.lock().insert(pty_id.clone());
                let (pty_size, history) = state.lock().get_pty_size_and_history(&pty_id, is_first);
                if pty_size.is_none() && history.is_none() {
                    // Explicit "unknown pty" signal: PtyResized(0, 0). Mobile uses
                    // this to bail out of the spinner immediately instead of waiting
                    // for a per-call timeout.
                    let dc_reply = dc_for_reply.clone();
                    let pty_id_clone = pty_id.clone();
                    tokio::spawn(async move {
                        let unknown_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::PtyResized(
                                proto::PtyResized {
                                    pty_id: pty_id_clone,
                                    cols: 0,
                                    rows: 0,
                                },
                            )),
                        };
                        let bytes = unknown_msg.encode_to_vec();
                        if let Err(e) = dc_reply
                            .send(&bytes::Bytes::copy_from_slice(&bytes))
                            .await
                        {
                            log::warn!("[server-host] unknown pty signal send failed: {e}");
                        }
                    });
                    return;
                }
                let dc_reply = dc_for_reply.clone();
                let pty_id_clone = pty_id.clone();
                tokio::spawn(async move {
                    if let Some((rows, cols)) = pty_size {
                        let size_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::PtyResized(proto::PtyResized {
                                pty_id: pty_id_clone.clone(),
                                cols: cols as u32,
                                rows: rows as u32,
                            })),
                        };
                        let bytes = size_msg.encode_to_vec();
                        if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                            log::warn!("[server-host] pty size send failed: {e}");
                            return;
                        }
                    }
                    if let Some(data) = history {
                        if !data.is_empty() {
                            log::info!("[server-host] sending {} bytes history for pane {}", data.len(), pty_id_clone);
                            const CHUNK_SIZE: usize = 32 * 1024;
                            for chunk in data.chunks(CHUNK_SIZE) {
                                let history_msg = proto::RemoteMessage {
                                    payload: Some(proto::remote_message::Payload::TerminalOutput(
                                        proto::TerminalOutput { pty_id: pty_id_clone.clone(), data: chunk.to_vec() },
                                    )),
                                };
                                let bytes = history_msg.encode_to_vec();
                                if let Err(e) = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
                                    log::warn!("[server-host] history chunk send failed: {e}");
                                    break;
                                }
                            }
                        }
                    }
                });
                return;
            }
            let needs_reply = RemoteHost::is_request_response(&remote_msg);
            if let Some(ipc_msg) = RemoteHost::to_ipc_message(&remote_msg) {
                let response = {
                    let mut s = state.lock();
                    s.handle_message(ipc_msg)
                };
                if needs_reply {
                    if let ServerMessage::SessionList { sessions } = response {
                        let bytes = RemoteHost::encode_session_list(&sessions);
                        let dc_reply = dc_for_reply.clone();
                        tokio::spawn(async move {
                            let _ = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await;
                        });
                    }
                }
            }
        }
    });
}

/// Wait for SDP answer and ICE candidates until the data channel opens (pairing-based hosting).
/// Returns `true` if DC opened successfully, `false` if timed out or errored.
async fn wait_for_dc_open(
    webrtc: &mut WebRtcManager,
    signaling: &mut SignalingClient,
) -> bool {
    let mut signaling_ended = false;
    let sdp_start = Instant::now();
    loop {
        if let Some(dc) = webrtc.data_channel() {
            if dc.ready_state() == webrtc::data_channel::data_channel_state::RTCDataChannelState::Open {
                log::info!("[server-host] DC is open!");
                return true;
            }
        }
        if sdp_start.elapsed() > Duration::from_secs(15) {
            log::error!("[server-host] DC failed to open within 15s");
            return false;
        }
        if signaling_ended {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        tokio::select! {
            msg = signaling.recv() => {
                match msg {
                    Some(SignalingMessage::SdpAnswer { sdp, .. }) => {
                        if let Err(e) = webrtc.set_remote_answer(&sdp).await {
                            log::error!("[server-host] set_remote_answer failed: {e}");
                            return false;
                        }
                    }
                    Some(SignalingMessage::IceCandidate { candidate, .. }) => {
                        if let Err(e) = webrtc.add_ice_candidate(&candidate).await {
                            log::warn!("[server-host] add ICE failed: {e}");
                        }
                    }
                    Some(SignalingMessage::Error { message, .. }) => {
                        log::error!("[server-host] signaling error: {message}");
                        return false;
                    }
                    None => {
                        signaling_ended = true;
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }
}

/// Bridge loop result: tells the host_loop what action to take next.
enum BridgeAction {
    /// Shutdown requested — exit the host loop entirely.
    Shutdown,
    /// DC closed — continue to next iteration (accept new client).
    NextClient,
    /// New peer joined during bridge — continue with pending_peer flag.
    NewPeer,
    /// Broadcast channel closed — exit the host loop.
    BroadcastClosed,
}

/// Run the bridge loop: forward broadcast messages to data channels, handle heartbeat/shutdown/DC close.
async fn run_bridge_loop(
    broadcast_tx: &broadcast::Sender<ServerMessage>,
    data_channels: &[Arc<RTCDataChannel>],
    shutdown_rx: &mut oneshot::Receiver<()>,
    dc_closed_rx: &mut mpsc::Receiver<()>,
    signaling: &mut SignalingClient,
    webrtc: &mut WebRtcManager,
    shutting_down: &Arc<std::sync::atomic::AtomicBool>,
    state: Arc<Mutex<ServerState>>,
) -> BridgeAction {
    let mut bridge_rx = broadcast_tx.subscribe();
    let mut heartbeat_interval = tokio::time::interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
    let mut sig_alive = true;

    loop {
        tokio::select! {
            msg = bridge_rx.recv() => {
                match msg {
                    Ok(ServerMessage::PtyOutput { pane_id, data }) => {
                        log::debug!("[server-host] fwd {} bytes pty={}", data.len(), pane_id);
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::TerminalOutput(
                                proto::TerminalOutput { pty_id: pane_id, data },
                            )),
                        };
                        send_to_all(data_channels, &remote_msg.encode_to_vec()).await;
                    }
                    Ok(ServerMessage::PtyResized { pane_id: _, rows: _, cols: _ }) => {
                        // See comment in the broadcast_to_all_clients path above:
                        // live resize events are not forwarded to mobile clients.
                    }
                    Ok(ServerMessage::PtyExit { pane_id }) => {
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::PtyResized(
                                proto::PtyResized { pty_id: pane_id, cols: 0, rows: 0 },
                            )),
                        };
                        send_to_all(data_channels, &remote_msg.encode_to_vec()).await;
                    }
                    Ok(ServerMessage::SessionUpdated { session }) => {
                        let layout_json = serde_json::to_string(&session.root_pane).unwrap_or_default();
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::LayoutUpdate(
                                proto::LayoutUpdate {
                                    session_id: session.id,
                                    layout_json,
                                    pane_count: session.pane_count as u32,
                                },
                            )),
                        };
                        send_to_all(data_channels, &remote_msg.encode_to_vec()).await;
                    }
                    Ok(ServerMessage::SessionListChanged) => {
                        let sessions = state.lock().sessions.clone();
                        let payload = crate::remote::host::RemoteHost::encode_session_list(&sessions);
                        send_to_all(data_channels, &payload).await;
                    }
                    Ok(ServerMessage::RemoteStatusChanged { .. }) => {}
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("[server-host] bridge lagged, skipped {n} messages");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        log::error!("[server-host] broadcast closed");
                        return BridgeAction::BroadcastClosed;
                    }
                }
            }
            _ = heartbeat_interval.tick() => {
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let msg = proto::RemoteMessage {
                    payload: Some(proto::remote_message::Payload::Heartbeat(
                        proto::Heartbeat { timestamp },
                    )),
                };
                send_to_all(data_channels, &msg.encode_to_vec()).await;
            }
            _ = &mut *shutdown_rx => {
                log::info!("[server-host] shutdown signal");
                shutting_down.store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = webrtc.close().await;
                return BridgeAction::Shutdown;
            }
            _ = dc_closed_rx.recv() => {
                log::info!("[server-host] DC closed — cleaning up for next client");
                let _ = webrtc.close().await;
                return BridgeAction::NextClient;
            }
            msg = signaling.recv(), if sig_alive => {
                match msg {
                    Some(SignalingMessage::PeerJoined { peer_id }) => {
                        log::info!("[server-host] new peer during bridge: {peer_id}");
                        let _ = webrtc.close().await;
                        return BridgeAction::NewPeer;
                    }
                    None => {
                        sig_alive = false;
                    }
                    other => {
                        log::info!("[server-host] signaling msg during bridge: {other:?}");
                    }
                }
            }
        }
    }
}

/// Main hosting loop: signaling → WebRTC → DC → bridge, with reconnection support.
async fn hosting_loop(
    state: Arc<Mutex<ServerState>>,
    broadcast_tx: broadcast::Sender<ServerMessage>,
    signaling_url: String,
    code: String,
    shutdown_rx: oneshot::Receiver<()>,
) {
    let mut shutdown_rx = shutdown_rx;

    // 1. Connect to signaling server as host
    log::info!("[server-host] Connecting to signaling: {signaling_url}");
    let extra_params = build_sessions_param(&state);

    let mut signaling = match SignalingClient::connect(&signaling_url, "host", &code, &extra_params).await {
        Ok(s) => s,
        Err(e) => {
            log::error!("[server-host] Signaling connect failed: {e}");
            emit_status(&broadcast_tx, "failed", None, Some(format!("{e} (url: {signaling_url})")));
            return;
        }
    };

    // Wait for room_created
    match signaling.recv().await {
        Some(SignalingMessage::RoomCreated { room_id }) => {
            log::info!("[server-host] Room created: {room_id}");
        }
        Some(SignalingMessage::Error { code: err_code, message }) => {
            log::error!("[server-host] Room creation failed: {err_code}: {message}");
            emit_status(&broadcast_tx, "failed", None, Some(message));
            return;
        }
        other => {
            log::error!("[server-host] Unexpected signaling message: {other:?}");
            return;
        }
    }

    emit_status(&broadcast_tx, "waiting", Some(code.clone()), None);

    // Main hosting loop: accept clients repeatedly until shutdown
    let mut iteration = 0u32;
    let mut pending_peer = false;

    'host_loop: loop {
        iteration += 1;
        log::info!("[server-host] === iteration {iteration} — waiting for peer ===");

        // 2. Wait for peer_joined
        let peer_joined = if pending_peer {
            pending_peer = false;
            true
        } else {
            loop {
                tokio::select! {
                    msg = signaling.recv() => {
                        match msg {
                            Some(SignalingMessage::PeerJoined { peer_id }) => {
                                log::info!("[server-host] peer_joined: {peer_id}");
                                break true;
                            }
                            None => {
                                log::error!("[server-host] signaling closed");
                                break false;
                            }
                            other => {
                                log::info!("[server-host] skipping: {other:?}");
                            }
                        }
                    }
                    _ = &mut shutdown_rx => {
                        log::info!("[server-host] shutdown during wait-for-peer");
                        break false;
                    }
                }
            }
        };

        if !peer_joined {
            break 'host_loop;
        }

        // 3. Create WebRTC PeerConnection + offer
        log::info!("[server-host] creating WebRTC PeerConnection");
        let ice_servers = WebRtcManager::default_ice_servers();
        let mut webrtc = match WebRtcManager::new(ice_servers).await {
            Ok(w) => w,
            Err(e) => {
                log::error!("[server-host] WebRTC create failed: {e}");
                break 'host_loop;
            }
        };

        let (dc_closed_tx, mut dc_closed_rx) = mpsc::channel::<()>(1);
        let shutting_down = Arc::new(std::sync::atomic::AtomicBool::new(false));

        setup_pairing_connection_monitor(
            &mut webrtc, &broadcast_tx, &code,
            dc_closed_tx.clone(), &shutting_down, iteration,
        );
        drop(dc_closed_tx);

        // ICE candidate forwarding
        let signaling_ice_tx = {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let signaling_ref = signaling.clone_tx();
            tokio::spawn(async move {
                while let Some(candidate) = rx.recv().await {
                    let msg = SignalingMessage::IceCandidate { candidate, room_code: None };
                    if let Ok(json) = serde_json::to_string(&msg) {
                        let _ = signaling_ref.send(json);
                    }
                }
            });
            tx
        };
        webrtc.on_ice_candidate(move |candidate| {
            let _ = signaling_ice_tx.send(candidate);
        });

        // Create SDP offer
        let offer_sdp = match webrtc.create_offer().await {
            Ok(sdp) => sdp,
            Err(e) => {
                log::error!("[server-host] create offer failed: {e}");
                break 'host_loop;
            }
        };

        // 4. Register DC message handler
        if let Some(dc) = webrtc.data_channel() {
            register_pairing_dc_handler(&dc, state.clone(), broadcast_tx.clone());
        }

        // Send SDP offer
        let offer_msg = SignalingMessage::SdpOffer { sdp: offer_sdp };
        if let Err(e) = signaling.send(&offer_msg) {
            log::error!("[server-host] send offer failed: {e}");
            break 'host_loop;
        }

        // 5. Wait for SDP answer + ICE until DC opens
        if !wait_for_dc_open(&mut webrtc, &mut signaling).await {
            break 'host_loop;
        }

        // 6. Bridge loop: broadcast_rx → protobuf → DC
        let data_channels: Vec<Arc<RTCDataChannel>> = webrtc
            .data_channel()
            .into_iter()
            .collect();

        emit_status(&broadcast_tx, "connected", Some(code.clone()), None);
        log::info!("[server-host] === connected, running bridge with {} DC(s) ===", data_channels.len());

        match run_bridge_loop(
            &broadcast_tx, &data_channels,
            &mut shutdown_rx, &mut dc_closed_rx,
            &mut signaling, &mut webrtc, &shutting_down,
            state.clone(),
        ).await {
            BridgeAction::Shutdown | BridgeAction::BroadcastClosed => break 'host_loop,
            BridgeAction::NextClient => continue 'host_loop,
            BridgeAction::NewPeer => {
                pending_peer = true;
                continue 'host_loop;
            }
        }
    }

    // Cleanup
    signaling.close();
    emit_status(&broadcast_tx, "disconnected", None, None);
    log::info!("[server-host] Hosting task finished");
}

/// Send encoded protobuf bytes to all data channels.
async fn send_to_all(data_channels: &[Arc<RTCDataChannel>], bytes: &[u8]) {
    for dc in data_channels {
        if let Err(e) = dc.send(&bytes::Bytes::copy_from_slice(bytes)).await {
            log::warn!("[server-host] DC send failed (state={:?}): {e}", dc.ready_state());
        }
    }
}



// ── Host-side history cache ───────────────────────────────────
struct HistoryCache {
    entries: Vec<String>,
    fetched_at: Option<Instant>,
}

static HISTORY_CACHE: OnceLock<parking_lot::Mutex<HistoryCache>> = OnceLock::new();
const HISTORY_CACHE_TTL: Duration = Duration::from_secs(5);

fn get_history_cached(limit: usize) -> Vec<String> {
    let cache = HISTORY_CACHE.get_or_init(|| {
        parking_lot::Mutex::new(HistoryCache { entries: Vec::new(), fetched_at: None })
    });

    let mut guard = cache.lock();
    let expired = guard.fetched_at.map(|t| t.elapsed() >= HISTORY_CACHE_TTL).unwrap_or(true);

    if expired {
        guard.entries = read_merged_history(500);
        guard.fetched_at = Some(Instant::now());
    }

    guard.entries.iter().take(limit).cloned().collect()
}

/// Drop the in-memory history snapshot so the next `get_history` re-reads
/// the on-disk files. Called from mutating handlers (e.g. delete) so the
/// remote client doesn't see ghost entries during the cache TTL window.
fn invalidate_history_cache() {
    if let Some(cache) = HISTORY_CACHE.get() {
        let mut guard = cache.lock();
        guard.entries.clear();
        guard.fetched_at = None;
    }
}

/// Merge Racemo's own history (newest first) with native shell history, deduplicated.
fn read_merged_history(limit: usize) -> Vec<String> {
    use std::collections::HashSet;

    // (timestamp_secs, command) — 0 means unknown
    let mut all: Vec<(i64, String)> = Vec::new();

    // 1. Racemo's own history: {data_dir}/racemo/history.txt  format: "timestamp;command"
    if let Some(path) = dirs::data_dir().map(|d| d.join("racemo").join("history.txt")) {
        if let Ok(bytes) = std::fs::read(&path) {
            for line in String::from_utf8_lossy(&bytes).lines() {
                let line = line.trim();
                if let Some(semi) = line.find(';') {
                    let ts = line[..semi].parse::<i64>().unwrap_or(0);
                    let cmd = line[semi + 1..].trim().to_string();
                    if !cmd.is_empty() {
                        all.push((ts, cmd));
                    }
                }
            }
        }
    }

    // 2. Native shell history
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".to_string());
    let shell = std::env::var("SHELL").unwrap_or_default();
    let history_path = if shell.contains("zsh") {
        format!("{}/.zsh_history", home)
    } else if shell.contains("fish") {
        format!("{}/.local/share/fish/fish_history", home)
    } else {
        std::env::var("HISTFILE").unwrap_or_else(|_| format!("{}/.bash_history", home))
    };

    if let Ok(bytes) = std::fs::read(&history_path) {
        let content = String::from_utf8_lossy(&bytes).into_owned();
        for entry in parse_shell_history_with_ts(&content, &shell) {
            all.push(entry);
        }
    }

    // Sort newest-first, deduplicate
    all.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut seen = HashSet::new();
    all.into_iter()
        .filter_map(|(_, cmd)| if seen.insert(cmd.clone()) { Some(cmd) } else { None })
        .take(limit)
        .collect()
}

/// Parse shell history returning (timestamp, command) pairs.
fn parse_shell_history_with_ts(content: &str, shell: &str) -> Vec<(i64, String)> {
    let mut result = Vec::new();
    if shell.contains("fish") {
        for line in content.lines() {
            if let Some(cmd) = line.trim().strip_prefix("- cmd: ") {
                if !cmd.is_empty() {
                    result.push((0, cmd.trim().to_string()));
                }
            }
        }
    } else if shell.contains("zsh") {
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix(": ") {
                if let Some(semi) = rest.find(';') {
                    let ts = rest[..semi].split(':').next()
                        .and_then(|s| s.trim().parse::<i64>().ok())
                        .unwrap_or(0);
                    let cmd = rest[semi + 1..].trim().to_string();
                    if !cmd.is_empty() {
                        result.push((ts, cmd));
                    }
                }
            } else {
                let t = line.trim();
                if !t.is_empty() && !t.starts_with('#') {
                    result.push((0, t.to_string()));
                }
            }
        }
    } else {
        for line in content.lines() {
            let t = line.trim();
            if !(t.is_empty() || t.starts_with('#') && t[1..].parse::<u64>().is_ok()) {
                result.push((0, t.to_string()));
            }
        }
    }
    result
}

/// Validate a remote path.
/// On Unix: restricts to home directory. On Windows: allows any existing path
/// (users commonly work on non-system-drive paths like D:\work).
/// One commit plan parsed from an `auto-commit` AI response.
/// `files` empty => stage all (`git add -A`).
#[derive(Debug, PartialEq)]
struct CommitPlan {
    files: Vec<String>,
    msg: String,
}

/// Strip leading/trailing backticks, single, double quotes (one round each).
fn strip_outer_quotes(s: &str) -> String {
    let mut out = s.to_string();
    if let Some(stripped) = out.strip_prefix(['`', '"', '\'']) {
        out = stripped.to_string();
    }
    if let Some(stripped) = out.strip_suffix(['`', '"', '\'']) {
        out = stripped.to_string();
    }
    out.trim().to_string()
}

/// Parse `---COMMIT---` blocks (with FILES: + MSG:) out of an auto-commit
/// response. Falls back to a single conventional-commit-prefixed line if no
/// blocks are found.
fn parse_commit_plans(output: &str) -> Vec<CommitPlan> {
    let mut plans = Vec::new();
    for block in output.split("---COMMIT---") {
        if block.trim().is_empty() {
            continue;
        }
        let mut files = Vec::<String>::new();
        let mut msg = String::new();
        for line in block.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("FILES:") {
                files = rest
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            } else if let Some(rest) = trimmed.strip_prefix("MSG:") {
                msg = strip_outer_quotes(rest.trim());
            }
        }
        if !msg.is_empty() {
            plans.push(CommitPlan { files, msg });
        }
    }
    if plans.is_empty() {
        // Fallback: pick the first conventional-commit-prefixed line.
        const PREFIXES: &[&str] = &[
            "feat:", "fix:", "refactor:", "chore:", "docs:", "test:", "style:", "perf:",
            "feat(", "fix(", "refactor(", "chore(", "docs(", "test(", "style(", "perf(",
        ];
        for line in output.lines() {
            let cleaned = strip_outer_quotes(line.trim());
            let lower = cleaned.to_lowercase();
            if PREFIXES.iter().any(|p| lower.starts_with(p)) {
                plans.push(CommitPlan {
                    files: Vec::new(),
                    msg: cleaned,
                });
                break;
            }
        }
    }
    plans
}

/// Run a git subcommand, returning Err with stderr on non-zero exit.
fn run_git_in(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("git spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Strip markdown fences and trim. If the output contains a fenced block,
/// return the first block's content (skipping optional language tag on the
/// opening line). Otherwise return trimmed raw output. Caps at 8 KB.
fn extract_commit_message(raw: &str) -> String {
    const MAX: usize = 8 * 1024;
    let truncated = if raw.len() > MAX { &raw[..MAX] } else { raw };
    if let Some(start) = truncated.find("```") {
        let after_open = &truncated[start + 3..];
        if let Some(end_rel) = after_open.find("```") {
            let inner = &after_open[..end_rel];
            // Skip optional language tag on the first line of the fence.
            let inner = inner.split_once('\n').map(|(_, body)| body).unwrap_or(inner);
            return inner.trim().to_string();
        }
    }
    truncated.trim().to_string()
}

/// Canonical home directory across platforms. Used by both
/// `validate_remote_path` and the `write_file createParents` guard so they
/// can share the same prefix-allow rule.
fn home_canonical_path() -> Result<std::path::PathBuf, String> {
    let home_str = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let home = std::path::Path::new(&home_str);
    Ok(home
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(home)))
}

fn validate_remote_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    // 신규 파일/디렉토리 (write_file, git_worktree_add) 의 경우 path 자체뿐
    // 아니라 그 부모 체인 일부도 아직 존재하지 않을 수 있다. 가장 깊은
    // 존재하는 ancestor 까지 walk-up 한 뒤 canonicalize 하고, 나머지 segment
    // 를 다시 join 한다. ancestor 가 HOME 외부면 결과 경로도 자연스레 외부가
    // 되어 아래의 prefix 검증에 걸린다.
    let canonical = match p.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
            let mut cursor: &std::path::Path = p;
            let mut acc = loop {
                let parent = cursor.parent()
                    .ok_or_else(|| "Invalid path: no parent".to_string())?;
                let name = cursor.file_name()
                    .ok_or_else(|| "Invalid path: no file name".to_string())?;
                tail.push(name);
                if let Ok(c) = parent.canonicalize() {
                    break c;
                }
                cursor = parent;
            };
            for seg in tail.iter().rev() {
                acc.push(seg);
            }
            acc
        }
    };
    let home_canonical = home_canonical_path()?;
    if !canonical.starts_with(&home_canonical) {
        return Err("Access denied: path outside home directory".to_string());
    }
    Ok(canonical)
}

/// Handle "open_editor" / "close_editor" API requests: validate path, broadcast to host frontend.
fn handle_editor_request(
    req: &proto::ApiRequest,
    broadcast_tx: &broadcast::Sender<ServerMessage>,
) -> Vec<Vec<u8>> {
    let error = (|| -> Result<(), String> {
        let params: serde_json::Value = serde_json::from_str(&req.params_json)
            .map_err(|e| format!("Invalid params: {e}"))?;
        let path = params.get("path").and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'path' parameter".to_string())?;
        let validated = validate_remote_path(path)?;
        let path_str = validated.to_string_lossy().to_string();
        let msg = if req.method == "close_editor" {
            ServerMessage::RemoteEditorClose { path: path_str }
        } else {
            ServerMessage::RemoteEditorOpen { path: path_str }
        };
        let _ = broadcast_tx.send(msg);
        Ok(())
    })();

    let (result_json, err_str) = match error {
        Ok(()) => ("{}".to_string(), String::new()),
        Err(e) => {
            log::warn!("[api] {} rejected: {e}", req.method);
            (String::new(), e)
        }
    };

    encode_api_response(&req.request_id, &result_json, &err_str)
}

/// Allowed API methods that can be invoked via DataChannel.
/// Any method not in this list is rejected before dispatching.
const ALLOWED_API_METHODS: &[&str] = &[
    "home_dir", "list_dir", "list_directory_filtered",
    "git_info", "git_status", "git_action", "git_log", "git_diff",
    "git_show_commit_patch", "git_commit_summary", "git_commit_file_diff",
    "git_ai_suggest_commit_message", "git_ai_auto_commit",
    "git_worktree_list", "git_worktree_add", "git_worktree_remove",
    "git_worktree_prune", "git_worktree_lock", "git_worktree_unlock",
    "get_history", "delete_history_entry", "hook_log",
    "read_file", "write_file", "file_stat",
    "create_session", "close_session",
];

/// Allowed git sub-actions within the "git_action" method.
const ALLOWED_GIT_ACTIONS: &[&str] = &[
    "stage", "unstage", "stage_all", "unstage_all",
    "commit", "discard", "push", "gitignore",
];

/// Per-chunk payload size for chunked ApiResponses. 32 KB matches the
/// PTY-history chunking that already works reliably on every supported
/// client. Larger sizes (we tried 200 KB) appear to be silently dropped by
/// flutter_webrtc on Android — possibly an internal SCTP reassembly cap —
/// leaving the mobile dialog stuck on the indeterminate spinner because no
/// progress event ever fires.
const API_CHUNK_BYTES: usize = 32 * 1024;

/// Build chunked encoded ApiResponse messages.
///
/// Returns one or more encoded `RemoteMessage(ApiResponse)` byte vectors.
/// Single-message (legacy) is used for short result_json or any error;
/// large results are split into ~`API_CHUNK_BYTES` chunks at UTF-8 char
/// boundaries. The receiver concatenates `result_json` from `chunk_seq=0..N`
/// to recover the full JSON.
fn encode_api_response(request_id: &str, result_json: &str, error: &str) -> Vec<Vec<u8>> {
    // Errors and small results: single legacy message (chunk_total = 0).
    if !error.is_empty() || result_json.len() <= API_CHUNK_BYTES {
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::ApiResponse(
                proto::ApiResponse {
                    request_id: request_id.to_string(),
                    result_json: result_json.to_string(),
                    error: error.to_string(),
                    chunk_seq: 0,
                    chunk_total: 0,
                },
            )),
        };
        return vec![msg.encode_to_vec()];
    }

    // Large success: split at UTF-8 char boundaries so each chunk is a valid
    // proto3 string field (which requires valid UTF-8).
    let total_len = result_json.len();
    let mut boundaries = Vec::<usize>::new();
    let mut cursor = 0;
    while cursor < total_len {
        let mut end = (cursor + API_CHUNK_BYTES).min(total_len);
        while end < total_len && !result_json.is_char_boundary(end) {
            end -= 1;
        }
        boundaries.push(end);
        cursor = end;
    }
    let chunk_total = boundaries.len() as u32;
    log::info!(
        "[api] chunked response id={} bytes={} chunks={}",
        request_id, total_len, chunk_total
    );
    let mut out = Vec::with_capacity(boundaries.len());
    let mut start = 0;
    for (i, end) in boundaries.iter().enumerate() {
        let msg = proto::RemoteMessage {
            payload: Some(proto::remote_message::Payload::ApiResponse(
                proto::ApiResponse {
                    request_id: request_id.to_string(),
                    result_json: result_json[start..*end].to_string(),
                    error: String::new(),
                    chunk_seq: i as u32,
                    chunk_total,
                },
            )),
        };
        out.push(msg.encode_to_vec());
        start = *end;
    }
    out
}

/// Build an encoded ApiResponse error (used when handle_api_request itself is unreachable).
fn api_error_response(request_id: &str, error: &str) -> Vec<Vec<u8>> {
    encode_api_response(request_id, "", error)
}

/// Encode a single ApiStreamEvent for the given request.
fn encode_stream_event(request_id: &str, payload: &serde_json::Value) -> Vec<u8> {
    let msg = proto::RemoteMessage {
        payload: Some(proto::remote_message::Payload::ApiStreamEvent(
            proto::ApiStreamEvent {
                request_id: request_id.to_string(),
                payload_json: payload.to_string(),
            },
        )),
    };
    msg.encode_to_vec()
}

/// Send a stream event over the data channel (best-effort; logs on failure).
async fn send_stream_event(
    dc: &Arc<RTCDataChannel>,
    request_id: &str,
    payload: serde_json::Value,
) {
    let bytes = encode_stream_event(request_id, &payload);
    if let Err(e) = dc.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
        log::warn!("[stream] event send failed: {e}");
    }
}

/// Send the terminal ApiResponse for a streaming request and close the stream.
async fn send_stream_final(
    dc: &Arc<RTCDataChannel>,
    request_id: &str,
    result: Result<serde_json::Value, String>,
) {
    let chunks = match result {
        Ok(v) => encode_api_response(request_id, &v.to_string(), ""),
        Err(e) => encode_api_response(request_id, "", &e),
    };
    for bytes in chunks {
        if let Err(e) = dc.send(&bytes::Bytes::copy_from_slice(&bytes)).await {
            log::warn!("[stream] final send failed: {e}");
            break;
        }
    }
}

/// Streaming variant of `git_ai_auto_commit`. Mirrors the desktop
/// `useAiCommit.handleAutoCommit` flow: spawns `claude -p ...
/// --output-format stream-json` in a PTY, parses the JSONL events as they
/// arrive, pushes `tool_use` / `text` events to the client over the data
/// channel, then runs `git restore/add/commit` for each parsed plan and
/// pushes a `step` event per git command. Final `ApiResponse.result_json`
/// has the same shape as the non-streaming method:
///   { ok: true, cli: "claude", commits: [{ hash, msg, files }, ...] }
async fn handle_streaming_auto_commit(
    request_id: String,
    path: String,
    dc: Arc<RTCDataChannel>,
) {
    use std::io::{BufRead, BufReader};
    use std::thread;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    // 1) Validate repo path.
    let canonical_repo = match validate_remote_path(&path) {
        Ok(p) => p,
        Err(e) => {
            send_stream_final(&dc, &request_id, Err(e)).await;
            return;
        }
    };

    // 2) Load auto-commit prompt (mirror non-streaming handler).
    const DEFAULT_AUTO_COMMIT_PROMPT: &str = include_str!("../../prompts/auto-commit.md");
    let home = std::env::var("HOME").unwrap_or_default();
    let prompt_path = std::path::PathBuf::from(&home)
        .join(".racemo")
        .join("prompts")
        .join("auto-commit.md");
    let raw_prompt = std::fs::read_to_string(&prompt_path)
        .unwrap_or_else(|_| DEFAULT_AUTO_COMMIT_PROMPT.to_string());
    let prompt = raw_prompt.replace("{lang}", "");

    // 3) Streaming requires `claude` (other CLIs don't emit stream-json).
    let claude_ok = std::process::Command::new("claude")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !claude_ok {
        send_stream_final(
            &dc,
            &request_id,
            Err("claude CLI not found (streaming auto-commit requires claude)".to_string()),
        )
        .await;
        return;
    }

    // 4) Spawn `claude -p <prompt> --output-format stream-json --verbose` in a PTY
    //    so it flushes JSONL output immediately. PTY column wrapping is
    //    re-assembled with `json_is_complete`.
    let pty_system = native_pty_system();
    let size = PtySize { rows: 24, cols: 4096, pixel_width: 0, pixel_height: 0 };
    let pair = match pty_system.openpty(size) {
        Ok(p) => p,
        Err(e) => {
            send_stream_final(&dc, &request_id, Err(format!("openpty failed: {e}"))).await;
            return;
        }
    };

    let mut cmd = CommandBuilder::new("claude");
    cmd.arg("-p");
    cmd.arg(&prompt);
    cmd.arg("--output-format");
    cmd.arg("stream-json");
    cmd.arg("--verbose");
    cmd.env("NO_COLOR", "1");
    cmd.env("FORCE_COLOR", "0");
    cmd.env("TERM", "dumb");
    cmd.cwd(&canonical_repo);

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            send_stream_final(&dc, &request_id, Err(format!("spawn claude failed: {e}"))).await;
            return;
        }
    };

    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = child.kill();
            send_stream_final(&dc, &request_id, Err(format!("PTY reader failed: {e}"))).await;
            return;
        }
    };
    let master = pair.master;

    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (done_tx, mut done_rx) = tokio::sync::oneshot::channel::<()>();

    // Reader thread: re-assemble JSON lines split by PTY column wrapping.
    thread::spawn(move || {
        let mut partial = String::new();
        for raw in BufReader::new(reader).lines().map_while(Result::ok) {
            let line = crate::commands::util::strip_ansi(&raw);
            let assembled = if !partial.is_empty() {
                partial.push_str(&line);
                if crate::commands::util::json_is_complete(&partial) {
                    let complete = std::mem::take(&mut partial);
                    Some(complete)
                } else {
                    None
                }
            } else if line.trim_start().starts_with('{') {
                if crate::commands::util::json_is_complete(&line) {
                    Some(line)
                } else {
                    partial = line;
                    None
                }
            } else {
                let t = line.trim().to_string();
                if t.is_empty() { None } else { Some(t) }
            };

            if let Some(l) = assembled {
                let is_result = l.contains("\"type\":\"result\"");
                let _ = line_tx.send(l);
                if is_result { break; }
            }
        }
        if !partial.is_empty() { let _ = line_tx.send(partial); }
        let _ = done_tx.send(());
    });

    // Reap child + close master on a blocking task so the reader thread can
    // finish naturally when claude exits.
    tokio::task::spawn_blocking(move || {
        let _ = child.wait();
        drop(master);
    });

    // 5) Drain JSONL events; emit tool_use/text stream events. Capture the
    //    final `result.result` text for plan parsing.
    let mut final_text = String::new();
    let timeout = tokio::time::sleep(tokio::time::Duration::from_secs(180));
    tokio::pin!(timeout);
    let mut timed_out = false;

    loop {
        tokio::select! {
            biased;
            line = line_rx.recv() => {
                match line {
                    Some(raw) => {
                        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&raw) {
                            let typ = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            match typ {
                                "assistant" => {
                                    if let Some(content) = obj.pointer("/message/content").and_then(|v| v.as_array()) {
                                        for block in content {
                                            let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                            match btype {
                                                "text" => {
                                                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                                        if !t.trim().is_empty() {
                                                            send_stream_event(&dc, &request_id, serde_json::json!({
                                                                "kind": "text",
                                                                "text": t,
                                                            })).await;
                                                        }
                                                    }
                                                }
                                                "tool_use" => {
                                                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                    let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                                                    let summary = summarize_tool_input(&name, &input);
                                                    send_stream_event(&dc, &request_id, serde_json::json!({
                                                        "kind": "tool_use",
                                                        "name": name,
                                                        "summary": summary,
                                                    })).await;
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                }
                                "result" => {
                                    final_text = obj.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                }
                                _ => {}
                            }
                        }
                    }
                    None => break,
                }
            }
            _ = &mut done_rx => {
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                while let Ok(raw) = line_rx.try_recv() {
                    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if obj.get("type").and_then(|v| v.as_str()) == Some("result") {
                            final_text = obj.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        }
                    }
                }
                break;
            }
            _ = &mut timeout => {
                timed_out = true;
                break;
            }
        }
    }

    if timed_out {
        send_stream_final(&dc, &request_id, Err("claude timed out (180s)".to_string())).await;
        return;
    }

    if final_text.trim().is_empty() {
        send_stream_final(
            &dc,
            &request_id,
            Err("claude produced no result event".to_string()),
        )
        .await;
        return;
    }

    // 6) Parse commit plans and run git steps, emitting per-step events.
    let plans = parse_commit_plans(&final_text);
    if plans.is_empty() {
        send_stream_final(
            &dc,
            &request_id,
            Err("AI response did not contain any usable commit plan".to_string()),
        )
        .await;
        return;
    }

    let mut commits_made = Vec::<serde_json::Value>::new();
    for plan in &plans {
        // Reset index so each plan stages only its own files.
        run_git_in(&canonical_repo, &["restore", "--staged", "."]).ok();
        if plan.files.is_empty() {
            send_stream_event(&dc, &request_id, serde_json::json!({
                "kind": "step", "label": "git add -A", "ok": true,
            })).await;
            if let Err(e) = run_git_in(&canonical_repo, &["add", "-A"]) {
                send_stream_event(&dc, &request_id, serde_json::json!({
                    "kind": "step", "label": format!("git add -A: {e}"), "ok": false,
                })).await;
                send_stream_final(&dc, &request_id, Err(e)).await;
                return;
            }
        } else {
            for file in &plan.files {
                let label = format!("git add {file}");
                match run_git_in(&canonical_repo, &["add", file]) {
                    Ok(_) => {
                        send_stream_event(&dc, &request_id, serde_json::json!({
                            "kind": "step", "label": label, "ok": true,
                        })).await;
                    }
                    Err(e) => {
                        send_stream_event(&dc, &request_id, serde_json::json!({
                            "kind": "step", "label": format!("{label}: {e}"), "ok": false,
                        })).await;
                        send_stream_final(&dc, &request_id, Err(e)).await;
                        return;
                    }
                }
            }
        }
        let commit_label = {
            let preview: String = plan.msg.chars().take(60).collect();
            format!("git commit: {preview}")
        };
        match run_git_in(&canonical_repo, &["commit", "-m", &plan.msg]) {
            Ok(_) => {
                send_stream_event(&dc, &request_id, serde_json::json!({
                    "kind": "step", "label": commit_label, "ok": true,
                })).await;
            }
            Err(e) => {
                send_stream_event(&dc, &request_id, serde_json::json!({
                    "kind": "step", "label": format!("{commit_label}: {e}"), "ok": false,
                })).await;
                send_stream_final(&dc, &request_id, Err(e)).await;
                return;
            }
        }
        let hash = run_git_in(&canonical_repo, &["rev-parse", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        commits_made.push(serde_json::json!({
            "hash": hash,
            "msg": plan.msg,
            "files": plan.files,
        }));
    }

    send_stream_final(
        &dc,
        &request_id,
        Ok(serde_json::json!({
            "ok": true,
            "cli": "claude",
            "commits": commits_made,
        })),
    )
    .await;
}

/// Compress a tool-use input value into a single-line, human-readable summary
/// for the streaming UI. Mirrors desktop `onToolUse` formatting in
/// `useAiCommit.ts`.
fn summarize_tool_input(name: &str, input: &serde_json::Value) -> String {
    fn truncate(s: &str, max: usize) -> String {
        if s.chars().count() <= max {
            s.to_string()
        } else {
            let prefix: String = s.chars().take(max).collect();
            format!("{prefix}…")
        }
    }
    match name {
        "Bash" => input
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| truncate(s, 120))
            .unwrap_or_default(),
        "Read" | "Write" | "Edit" => input
            .get("file_path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default(),
        "Glob" => input
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(|s| format!("\"{s}\""))
            .unwrap_or_default(),
        "Grep" => input
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(|s| format!("\"{s}\""))
            .unwrap_or_default(),
        "Task" => input
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(|s| truncate(s, 60))
            .unwrap_or_default(),
        _ => input
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| truncate(s, 80))
            .unwrap_or_default(),
    }
}

fn handle_api_request(req: &proto::ApiRequest, state: &Arc<Mutex<ServerState>>) -> Vec<Vec<u8>> {
    let result: Result<serde_json::Value, String> = (|| {
        if !ALLOWED_API_METHODS.contains(&req.method.as_str()) {
            log::warn!("[api] Rejected unknown API method (len={})", req.method.len());
            return Err("Unknown API method".to_string());
        }

        let params: serde_json::Value = if req.params_json.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&req.params_json).map_err(|e| e.to_string())?
        };

        match req.method.as_str() {
            "home_dir" => {
                let home = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .unwrap_or_else(|_| "/".to_string());
                Ok(serde_json::json!({ "path": home }))
            }
            "list_dir" => {
                let path = params["path"].as_str().unwrap_or("/");
                let canonical = validate_remote_path(path)?;
                let mut entries: Vec<serde_json::Value> = std::fs::read_dir(&canonical)
                    .map_err(|e| e.to_string())?
                    .filter_map(|e| e.ok())
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        if name.starts_with('.') { return None; }
                        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                        let kind = if is_dir { "dir" } else { "file" };
                        // size: 파일만 반환. 디렉토리는 OS별로 의미가 다르고
                        // (du 와 stat 결과가 갈림) 모바일 UI 에 도움 안 됨 → null.
                        // metadata 실패 시도 null — 권한 부족 등으로 size 못 읽는
                        // 경우에도 entry 자체는 보여주는 게 자연스러움.
                        let size = if is_dir {
                            serde_json::Value::Null
                        } else {
                            e.metadata()
                                .ok()
                                .map(|m| serde_json::Value::from(m.len()))
                                .unwrap_or(serde_json::Value::Null)
                        };
                        Some(serde_json::json!({
                            "name": name,
                            "type": kind,
                            "size": size,
                        }))
                    })
                    .collect();
                entries.sort_by(|a, b| {
                    let a_dir = a["type"].as_str() == Some("dir");
                    let b_dir = b["type"].as_str() == Some("dir");
                    b_dir.cmp(&a_dir)
                        .then(a["name"].as_str().unwrap_or("").to_lowercase().cmp(
                            &b["name"].as_str().unwrap_or("").to_lowercase()
                        ))
                });
                Ok(serde_json::json!(entries))
            }
            "git_info" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let info = crate::git::get_repo_info(path)?;
                Ok(serde_json::to_value(info).map_err(|e| e.to_string())?)
            }
            "git_status" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let statuses = crate::git::get_file_statuses(path)?;
                Ok(serde_json::to_value(statuses).map_err(|e| e.to_string())?)
            }
            "git_action" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let action = params["action"].as_str().unwrap_or("");
                if !ALLOWED_GIT_ACTIONS.contains(&action) {
                    log::warn!("[api] Rejected unknown git action (len={})", action.len());
                    return Err("Unknown git action".to_string());
                }
                let file = params["filePath"].as_str().unwrap_or("");
                let message = params["message"].as_str().unwrap_or("");
                match action {
                    "stage" => crate::git::stage_file(path, file)?,
                    "unstage" => crate::git::unstage_file(path, file)?,
                    "stage_all" => crate::git::stage_all(path)?,
                    "unstage_all" => crate::git::unstage_all(path)?,
                    "commit" => crate::git::git_commit(path, message)?,
                    "discard" => crate::git::discard_file(path, file)?,
                    "push" => crate::git::git_push(path)?,
                    "gitignore" => crate::git::add_to_gitignore(path, file)?,
                    _ => return Err("Unknown git action".to_string()),
                }
                Ok(serde_json::json!({ "ok": true }))
            }
            "git_log" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let count = params["count"].as_u64().unwrap_or(50) as u32;
                let all = params["all"].as_bool().unwrap_or(false);
                let log = crate::git::get_commit_log(path, count, all)?;
                Ok(serde_json::to_value(log).map_err(|e| e.to_string())?)
            }
            "git_diff" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let file = params["filePath"].as_str().unwrap_or("");
                let staged = params["staged"].as_bool().unwrap_or(false);
                let context_lines = params["contextLines"].as_u64().map(|v| v as u32);
                let diff = crate::git::diff_file(path, file, staged, context_lines)?;
                Ok(serde_json::json!({ "diff": diff }))
            }
            "git_show_commit_patch" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let hash = params["hash"].as_str().ok_or("Missing hash")?;
                if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err("Invalid commit hash".to_string());
                }
                let mut patch = crate::git::show_commit_patch(path, hash)?;
                // WebRTC DataChannel 의 단일 메시지 한계 (대부분 64 KB) 직전에서
                // 자른다. 56 KB 마진 = protobuf framing + 다른 필드 overhead 고려.
                // 잘릴 때는 `diff --git` file 경계에 맞춰 자르므로 클라이언트의
                // per-file split 이 깨지지 않는다.
                const MAX_PATCH: usize = 56 * 1024;
                let total = patch.len();
                let truncated = total > MAX_PATCH;
                if truncated {
                    let mut cut = MAX_PATCH;
                    // 가까운 직전 file boundary 찾기
                    if let Some(pos) = patch[..cut].rfind("\ndiff --git ") {
                        cut = pos + 1; // 직전 \n 다음 = 새 file 헤더 시작
                    } else {
                        // boundary 못 찾으면 utf-8 safe 자르기
                        while cut > 0 && !patch.is_char_boundary(cut) {
                            cut -= 1;
                        }
                    }
                    patch.truncate(cut);
                    patch.push_str(&format!(
                        "\n--- (truncated: full patch {} bytes; {} bytes shown — view remaining files on desktop)\n",
                        total, cut
                    ));
                }
                Ok(serde_json::json!({
                    "patch": patch,
                    "truncated": truncated,
                    "totalBytes": total,
                }))
            }
            "git_commit_summary" => {
                let path = params["path"].as_str().unwrap_or(".");
                let canonical = validate_remote_path(path)?;
                let hash = params["hash"].as_str().ok_or("Missing hash")?;
                if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err("Invalid commit hash".to_string());
                }

                // 1) name-status: 각 파일의 status (M/A/D/R)
                let name_status = std::process::Command::new("git")
                    .arg("-C").arg(&canonical)
                    .arg("show").arg("--name-status").arg("--format=")
                    .arg(hash)
                    .output()
                    .map_err(|e| format!("git show --name-status: {e}"))?;
                if !name_status.status.success() {
                    return Err(format!(
                        "git show --name-status: {}",
                        String::from_utf8_lossy(&name_status.stderr)
                    ));
                }

                // 2) numstat: 각 파일의 +/- 라인 수
                let numstat = std::process::Command::new("git")
                    .arg("-C").arg(&canonical)
                    .arg("show").arg("--numstat").arg("--format=")
                    .arg(hash)
                    .output()
                    .map_err(|e| format!("git show --numstat: {e}"))?;
                if !numstat.status.success() {
                    return Err(format!(
                        "git show --numstat: {}",
                        String::from_utf8_lossy(&numstat.stderr)
                    ));
                }

                // path → (additions, deletions)
                let mut stats: std::collections::HashMap<String, (u32, u32)> =
                    std::collections::HashMap::new();
                for line in String::from_utf8_lossy(&numstat.stdout).lines() {
                    let line = line.trim();
                    if line.is_empty() { continue; }
                    let mut it = line.splitn(3, '\t');
                    let add = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                    let del = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                    let p = it.next().unwrap_or("").to_string();
                    if !p.is_empty() {
                        stats.insert(p, (add, del));
                    }
                }

                // 합치기: name-status 의 각 줄 → file entry
                let mut files = Vec::<serde_json::Value>::new();
                for line in String::from_utf8_lossy(&name_status.stdout).lines() {
                    let line = line.trim();
                    if line.is_empty() { continue; }
                    let mut it = line.splitn(3, '\t');
                    let status_raw = it.next().unwrap_or("");
                    let p1 = it.next().unwrap_or("");
                    let p2 = it.next();
                    // R / C 는 status 가 R100 / C90 등 score 포함. 첫 글자만 사용.
                    let status = status_raw.chars().next().unwrap_or('M').to_string();
                    let (path, old_path): (String, Option<String>) = match status.as_str() {
                        "R" | "C" => (p2.unwrap_or("").to_string(), Some(p1.to_string())),
                        _ => (p1.to_string(), None),
                    };
                    if path.is_empty() { continue; }
                    let (add, del) = stats.get(&path).copied().unwrap_or((0, 0));
                    files.push(serde_json::json!({
                        "path": path,
                        "oldPath": old_path,
                        "status": status,
                        "additions": add,
                        "deletions": del,
                    }));
                }

                Ok(serde_json::json!({ "files": files }))
            }
            "git_commit_file_diff" => {
                let path = params["path"].as_str().unwrap_or(".");
                let canonical = validate_remote_path(path)?;
                let hash = params["hash"].as_str().ok_or("Missing hash")?;
                if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err("Invalid commit hash".to_string());
                }
                let file = params["file"].as_str().ok_or("Missing file")?;
                if file.is_empty() || file.contains("..") {
                    return Err("Invalid file path".to_string());
                }

                let output = std::process::Command::new("git")
                    .arg("-C").arg(&canonical)
                    .arg("show")
                    .arg("--format=")
                    .arg(hash)
                    .arg("--")
                    .arg(file)
                    .output()
                    .map_err(|e| format!("git show: {e}"))?;
                if !output.status.success() {
                    return Err(format!(
                        "git show: {}",
                        String::from_utf8_lossy(&output.stderr)
                    ));
                }

                let mut diff = String::from_utf8_lossy(&output.stdout).to_string();
                // 파일 단위 컷오프 (개별 파일도 거대할 수 있음 — 56 KB 안전마진)
                const MAX_FILE_DIFF: usize = 56 * 1024;
                let total = diff.len();
                let truncated = total > MAX_FILE_DIFF;
                if truncated {
                    let mut cut = MAX_FILE_DIFF;
                    while cut > 0 && !diff.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    diff.truncate(cut);
                    diff.push_str(&format!(
                        "\n--- (truncated: full file diff {} bytes; {} bytes shown)\n",
                        total, cut
                    ));
                }
                Ok(serde_json::json!({
                    "diff": diff,
                    "truncated": truncated,
                    "totalBytes": total,
                }))
            }
            "close_session" => {
                let id = params["id"].as_str().ok_or("Missing id")?;
                let result = state.lock().handle_close_session(id.to_string());
                match result {
                    ServerMessage::SessionClosed { remaining } => Ok(serde_json::json!({
                        "id": id,
                        "remainingId": remaining.as_ref().map(|s| s.id.clone()),
                    })),
                    ServerMessage::Error { code, message } => {
                        Err(format!("{code:?}: {message}"))
                    }
                    _ => Err("Unexpected response from close_session".to_string()),
                }
            }
            "create_session" => {
                let name = params["name"].as_str().map(|s| s.to_string());
                let cwd = params["cwd"].as_str().map(|s| s.to_string());
                let shell = params["shell"].as_str().and_then(|s| match s {
                    "bash" => Some(crate::layout::ShellType::Bash),
                    "zsh" => Some(crate::layout::ShellType::Zsh),
                    "fish" => Some(crate::layout::ShellType::Fish),
                    "powershell" | "pwsh" => Some(crate::layout::ShellType::PowerShell),
                    "cmd" => Some(crate::layout::ShellType::Cmd),
                    "wsl" => Some(crate::layout::ShellType::Wsl),
                    _ => None,
                });
                let rows = params["rows"].as_u64().unwrap_or(24).clamp(1, 1000) as u16;
                let cols = params["cols"].as_u64().unwrap_or(80).clamp(1, 1000) as u16;

                let result = state.lock().handle_create_session(name, cwd, shell, rows, cols);
                match result {
                    ServerMessage::SessionCreated { session } => {
                        let layout = serde_json::to_string(&session.root_pane)
                            .unwrap_or_default();
                        Ok(serde_json::json!({
                            "id": session.id,
                            "name": session.name,
                            "paneCount": session.pane_count,
                            "paneIds": session.root_pane.pty_ids(),
                            "layoutJson": layout,
                        }))
                    }
                    ServerMessage::Error { code, message } => {
                        Err(format!("{code:?}: {message}"))
                    }
                    _ => Err("Unexpected response from create_session".to_string()),
                }
            }
            "git_ai_auto_commit" => {
                let path = params["path"].as_str().unwrap_or(".");
                let canonical_repo = validate_remote_path(path)?;

                // 1) prompt 로드: ~/.racemo/prompts/auto-commit.md → 없으면 default
                const DEFAULT_AUTO_COMMIT_PROMPT: &str =
                    include_str!("../../prompts/auto-commit.md");
                let home = std::env::var("HOME").unwrap_or_default();
                let prompt_path = std::path::PathBuf::from(&home)
                    .join(".racemo")
                    .join("prompts")
                    .join("auto-commit.md");
                let raw_prompt = std::fs::read_to_string(&prompt_path)
                    .unwrap_or_else(|_| DEFAULT_AUTO_COMMIT_PROMPT.to_string());
                let prompt = raw_prompt.replace("{lang}", "");

                // 2) AI CLI detect (claude → codex → gemini)
                let cli = ["claude", "codex", "gemini"]
                    .iter()
                    .find(|c| {
                        std::process::Command::new(c)
                            .arg("--version")
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status()
                            .is_ok_and(|s| s.success())
                    })
                    .copied()
                    .ok_or_else(|| {
                        "No AI CLI found (install one of: claude, codex, gemini)".to_string()
                    })?;

                // 3) AI invoke (-p headless mode, cwd=repo, timeout 120s)
                let mut child = std::process::Command::new(cli)
                    .arg("-p")
                    .arg(&prompt)
                    .current_dir(&canonical_repo)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("Failed to spawn {cli}: {e}"))?;

                // multi-plan 응답이 pipe buffer(macOS 16KB) 초과 시 deadlock 되지
                // 않도록 try_wait 루프 진입 전에 drain 스레드를 먼저 띄운다.
                let stdout_handle = child.stdout.take().map(|mut s| {
                    std::thread::spawn(move || {
                        use std::io::Read;
                        let mut buf = String::new();
                        s.read_to_string(&mut buf).ok();
                        buf
                    })
                });
                let stderr_handle = child.stderr.take().map(|mut s| {
                    std::thread::spawn(move || {
                        use std::io::Read;
                        let mut buf = String::new();
                        s.read_to_string(&mut buf).ok();
                        buf
                    })
                });

                let start = std::time::Instant::now();
                let timeout = std::time::Duration::from_secs(120);
                let status = loop {
                    match child.try_wait() {
                        Ok(Some(s)) => break s,
                        Ok(None) => {
                            if start.elapsed() >= timeout {
                                let _ = child.kill();
                                return Err(format!("{cli} timed out (120s)"));
                            }
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                        Err(e) => return Err(format!("wait failed: {e}")),
                    }
                };

                let stdout_text = stdout_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();
                let stderr_text = stderr_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();

                if !status.success() {
                    return Err(format!("{cli} failed: {stderr_text}"));
                }

                // 4) 응답 파싱
                let plans = parse_commit_plans(&stdout_text);
                if plans.is_empty() {
                    return Err(
                        "AI response did not contain any usable commit plan".to_string()
                    );
                }

                // 5) 각 plan 별 git restore --staged → add → commit 순차 실행
                let mut commits_made = Vec::<serde_json::Value>::new();
                for plan in &plans {
                    // Reset index so each plan stages only its own files.
                    run_git_in(&canonical_repo, &["restore", "--staged", "."]).ok();
                    if plan.files.is_empty() {
                        run_git_in(&canonical_repo, &["add", "-A"])?;
                    } else {
                        for file in &plan.files {
                            run_git_in(&canonical_repo, &["add", file])?;
                        }
                    }
                    run_git_in(&canonical_repo, &["commit", "-m", &plan.msg])?;
                    let hash = run_git_in(&canonical_repo, &["rev-parse", "HEAD"])
                        .ok()
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    commits_made.push(serde_json::json!({
                        "hash": hash,
                        "msg": plan.msg,
                        "files": plan.files,
                    }));
                }

                Ok(serde_json::json!({
                    "ok": true,
                    "cli": cli,
                    "commits": commits_made,
                }))
            }
            "git_ai_suggest_commit_message" => {
                let path = params["path"].as_str().unwrap_or(".");
                let canonical_repo = validate_remote_path(path)?;

                // 1) staged diff 가져오기
                let diff_output = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&canonical_repo)
                    .arg("diff")
                    .arg("--staged")
                    .arg("--no-color")
                    .output()
                    .map_err(|e| format!("git diff failed: {e}"))?;
                if !diff_output.status.success() {
                    return Err(format!(
                        "git diff: {}",
                        String::from_utf8_lossy(&diff_output.stderr)
                    ));
                }
                let diff = String::from_utf8_lossy(&diff_output.stdout).to_string();
                if diff.trim().is_empty() {
                    return Err("No staged changes".to_string());
                }

                // 2) AI CLI detect (claude → codex → gemini)
                let cli = ["claude", "codex", "gemini"]
                    .iter()
                    .find(|c| {
                        std::process::Command::new(c)
                            .arg("--version")
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status()
                            .is_ok_and(|s| s.success())
                    })
                    .copied()
                    .ok_or_else(|| {
                        "No AI CLI found (install one of: claude, codex, gemini)".to_string()
                    })?;

                // 3) prompt + invoke (-p headless mode)
                let prompt = "Write a Conventional Commits commit message for this staged diff. \
                    Output only the message body in plain text — no markdown fences, no preface, \
                    no quotes. Keep the subject line under 70 chars.";
                let full_input = format!("{prompt}\n\n--- DIFF ---\n{diff}\n");

                let mut child = std::process::Command::new(cli)
                    .arg("-p")
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("Failed to spawn {cli}: {e}"))?;

                // 4) stdout/stderr 동시 drain — child 가 pipe buffer(macOS 16KB) 초과
                //    출력 시 stdin write 와 wait 가 deadlock 되지 않도록 stdin 쓰기 전에
                //    drain 스레드를 먼저 띄운다.
                let stdout_handle = child.stdout.take().map(|mut s| {
                    std::thread::spawn(move || {
                        use std::io::Read;
                        let mut buf = String::new();
                        s.read_to_string(&mut buf).ok();
                        buf
                    })
                });
                let stderr_handle = child.stderr.take().map(|mut s| {
                    std::thread::spawn(move || {
                        use std::io::Read;
                        let mut buf = String::new();
                        s.read_to_string(&mut buf).ok();
                        buf
                    })
                });

                if let Some(mut stdin) = child.stdin.take() {
                    use std::io::Write;
                    stdin
                        .write_all(full_input.as_bytes())
                        .map_err(|e| format!("write stdin: {e}"))?;
                    // drop(stdin) → EOF 통지
                }

                // 5) 30s timeout
                let start = std::time::Instant::now();
                let timeout = std::time::Duration::from_secs(30);
                let status = loop {
                    match child.try_wait() {
                        Ok(Some(s)) => break s,
                        Ok(None) => {
                            if start.elapsed() >= timeout {
                                let _ = child.kill();
                                return Err(format!("{cli} timed out (30s)"));
                            }
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                        Err(e) => return Err(format!("wait failed: {e}")),
                    }
                };

                let stdout_text = stdout_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();
                let stderr_text = stderr_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();

                if !status.success() {
                    return Err(format!("{cli} failed: {stderr_text}"));
                }

                let cleaned = extract_commit_message(&stdout_text);
                Ok(serde_json::json!({ "message": cleaned, "cli": cli }))
            }
            "git_worktree_list" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let worktrees = crate::git::list_worktrees(path)?;
                Ok(serde_json::json!({
                    "worktrees": serde_json::to_value(worktrees)
                        .map_err(|e| e.to_string())?
                }))
            }
            "git_worktree_add" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let worktree_path = params["worktreePath"].as_str()
                    .ok_or("Missing worktreePath")?;
                // Worktree path is *new*; validate_remote_path walks up to
                // the deepest existing ancestor and re-checks the HOME prefix.
                let canonical_worktree = validate_remote_path(worktree_path)?;
                let branch = params["branch"].as_str().unwrap_or("");
                let new_branch = params["newBranch"].as_bool().unwrap_or(false);
                let target = params["target"].as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());

                // Reject ref-shaped strings that begin with `-` so they cannot
                // be interpreted as git options when add_worktree builds args.
                if branch.starts_with('-') {
                    return Err("Invalid branch name (starts with '-')".to_string());
                }
                if let Some(t) = &target {
                    if t.starts_with('-') {
                        return Err("Invalid target (starts with '-')".to_string());
                    }
                }
                if new_branch && branch.is_empty() {
                    return Err("Branch name required when creating a new branch".to_string());
                }
                if !new_branch && branch.is_empty() && target.is_none() {
                    return Err("Either branch or target is required".to_string());
                }

                // Create missing parent dirs so `git worktree add` does not
                // fail solely because the parent (e.g. "<repo>/.worktrees")
                // does not exist yet. Bounded to canonicalised path under HOME.
                if let Some(parent) = canonical_worktree.parent() {
                    if !parent.exists() {
                        std::fs::create_dir_all(parent)
                            .map_err(|e| format!("Failed to create parent: {e}"))?;
                    }
                }

                crate::git::add_worktree(path, worktree_path, branch, new_branch, target)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "git_worktree_remove" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let worktree_path = params["worktreePath"].as_str()
                    .ok_or("Missing worktreePath")?;
                validate_remote_path(worktree_path)?;
                let force = params["force"].as_bool().unwrap_or(false);
                crate::git::remove_worktree(path, worktree_path, force)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "git_worktree_prune" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                crate::git::prune_worktrees(path)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "git_worktree_lock" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let worktree_path = params["worktreePath"].as_str()
                    .ok_or("Missing worktreePath")?;
                validate_remote_path(worktree_path)?;
                let reason = params["reason"].as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                // Reject reason values that would be parsed as git options.
                if let Some(r) = &reason {
                    if r.starts_with('-') {
                        return Err("Invalid reason (starts with '-')".to_string());
                    }
                }
                crate::git::lock_worktree(path, worktree_path, reason)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "git_worktree_unlock" => {
                let path = params["path"].as_str().unwrap_or(".");
                validate_remote_path(path)?;
                let worktree_path = params["worktreePath"].as_str()
                    .ok_or("Missing worktreePath")?;
                validate_remote_path(worktree_path)?;
                crate::git::unlock_worktree(path, worktree_path)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "list_directory_filtered" => {
                let dir = params["dir"].as_str().unwrap_or(".");
                let partial = params["partial"].as_str().unwrap_or("");

                // Expand ~/
                let expanded = if let Some(rest) = dir.strip_prefix("~/") {
                    let home = std::env::var("HOME")
                        .or_else(|_| std::env::var("USERPROFILE"))
                        .unwrap_or_else(|_| "/".to_string());
                    format!("{}/{}", home, rest)
                } else if dir == "~" {
                    std::env::var("HOME")
                        .or_else(|_| std::env::var("USERPROFILE"))
                        .unwrap_or_else(|_| "/".to_string())
                } else {
                    dir.to_string()
                };

                let include_hidden = partial.starts_with('.');
                let lower_partial = partial.to_lowercase();

                let dir_path = validate_remote_path(&expanded)?;
                let mut entries: Vec<serde_json::Value> = std::fs::read_dir(&dir_path)
                    .map_err(|e| e.to_string())?
                    .filter_map(|e| e.ok())
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        if !lower_partial.is_empty() && !name.to_lowercase().starts_with(&lower_partial) {
                            return None;
                        }
                        if name.starts_with('.') && !include_hidden {
                            return None;
                        }
                        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                        let kind = if is_dir { "dir" } else { "file" };
                        Some(serde_json::json!({ "name": name, "type": kind }))
                    })
                    .collect();

                entries.sort_by(|a, b| {
                    let a_dir = a["type"].as_str() == Some("dir");
                    let b_dir = b["type"].as_str() == Some("dir");
                    b_dir.cmp(&a_dir)
                        .then(a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")))
                });
                let limited: Vec<_> = entries.into_iter().take(20).collect();
                Ok(serde_json::json!(limited))
            }
            "get_history" => {
                let limit = (params["limit"].as_u64().unwrap_or(500) as usize).min(500);
                let entries = get_history_cached(limit);
                Ok(serde_json::json!({ "entries": entries }))
            }
            "delete_history_entry" => {
                // Drop a single command from the Racemo + native shell history
                // files so the mobile sheet's swipe-to-delete sticks across
                // re-fetches. Cache invalidation is required — `get_history`
                // is served from a 5 s in-memory snapshot.
                let command = params["command"].as_str().ok_or("Missing command")?;
                crate::commands::history::delete_history_entry(command.to_string())?;
                invalidate_history_cache();
                Ok(serde_json::json!({}))
            }
            "hook_log" => {
                let max = params["max"].as_u64().unwrap_or(20) as usize;
                let nodes = crate::hooklog::read_hook_log_tree(max);
                Ok(serde_json::to_value(nodes).map_err(|e| e.to_string())?)
            }
            "read_file" => {
                let path = params["path"].as_str().ok_or("Missing path")?;
                // encoding=utf8 (default) returns the file as a UTF-8 string.
                // encoding=base64 reads raw bytes and returns base64-encoded
                // content — used by the mobile Explorer to preview images and
                // other non-utf8 files.
                let encoding = params["encoding"].as_str().unwrap_or("utf8");
                let canonical = validate_remote_path(path)?;
                const MAX_READ_SIZE: u64 = 10 * 1024 * 1024; // 10 MB per call
                // Optional range read: when both offset and length are present
                // the host streams the requested byte range, lifting the
                // whole-file size cap so the mobile Explorer can download
                // arbitrarily large files in 4 MB slices. Each individual call
                // is still capped at MAX_READ_SIZE to bound peer memory and
                // the encoded ApiResponse size.
                let offset = params.get("offset").and_then(|v| v.as_u64());
                let length = params.get("length").and_then(|v| v.as_u64());
                let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
                let bytes: Vec<u8> = match (offset, length) {
                    (Some(off), Some(len)) => {
                        if len > MAX_READ_SIZE {
                            return Err(format!(
                                "Range too large: {} bytes (max {} per call)",
                                len, MAX_READ_SIZE
                            ));
                        }
                        if off > meta.len() {
                            return Err(format!(
                                "Offset {} past EOF (file size {})",
                                off,
                                meta.len()
                            ));
                        }
                        // Ranged reads must use base64: a byte-range boundary
                        // can split a multi-byte UTF-8 codepoint, making the
                        // chunk undecodable on the receiving end.
                        if encoding == "utf8" {
                            return Err("Ranged read_file requires encoding=base64".to_string());
                        }
                        // remaining/len both ≤ MAX_READ_SIZE (10 MB), so the
                        // `as usize` cast is safe even on 32-bit hosts.
                        use std::io::{Read, Seek, SeekFrom};
                        let mut f = std::fs::File::open(&canonical).map_err(|e| e.to_string())?;
                        f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
                        let remaining = meta.len() - off;
                        let cap = remaining.min(len) as usize;
                        let mut buf = Vec::with_capacity(cap);
                        f.take(cap as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
                        buf
                    }
                    _ => {
                        if meta.len() > MAX_READ_SIZE {
                            return Err(format!(
                                "File too large: {} bytes (max {})",
                                meta.len(),
                                MAX_READ_SIZE
                            ));
                        }
                        std::fs::read(&canonical).map_err(|e| e.to_string())?
                    }
                };
                let content = match encoding {
                    "utf8" => String::from_utf8(bytes).map_err(|e| e.to_string())?,
                    "base64" => {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD.encode(bytes)
                    }
                    other => return Err(format!("Unsupported encoding: {other}")),
                };
                Ok(serde_json::json!({ "content": content, "encoding": encoding }))
            }
            "file_stat" => {
                // Lightweight metadata fetch so the mobile Explorer can plan a
                // chunked download (loop ranged read_file calls) without first
                // listing the parent directory. Mirrors what list_dir already
                // surfaces, but for a single path.
                let path = params["path"].as_str().ok_or("Missing path")?;
                let canonical = validate_remote_path(path)?;
                let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
                let modified_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Ok(serde_json::json!({
                    "size": meta.len(),
                    "isDir": meta.is_dir(),
                    "isFile": meta.is_file(),
                    "modifiedMs": modified_ms,
                }))
            }
            "write_file" => {
                let path = params["path"].as_str().ok_or("Missing path")?;
                let content = params["content"].as_str().ok_or("Missing content")?;
                let encoding = params["encoding"].as_str().unwrap_or("utf8");
                let create_parents = params["createParents"].as_bool().unwrap_or(false);
                // append=true: 기존 파일에 이어쓰기. 청크 업로드의 2번째 이후 청크에 사용.
                let append = params["append"].as_bool().unwrap_or(false);
                const MAX_WRITE_SIZE: usize = 10 * 1024 * 1024; // 10 MB
                if content.len() > MAX_WRITE_SIZE {
                    return Err(format!("Content too large: {} bytes (max {})", content.len(), MAX_WRITE_SIZE));
                }

                // createParents=true 일 때 부모 디렉토리 자동 생성. HOME 외부는 거부.
                if create_parents {
                    let p = std::path::Path::new(path);
                    if let Some(parent) = p.parent() {
                        if parent.canonicalize().is_err() {
                            // anchor: parent 사슬에서 실재하는 가장 가까운 디렉토리.
                            // 이걸 canonicalize 해 HOME 안에 있는지 검증한 뒤에만 mkdir.
                            let mut anchor: &std::path::Path = parent;
                            while !anchor.exists() {
                                match anchor.parent() {
                                    Some(p_parent) => anchor = p_parent,
                                    None => break,
                                }
                            }
                            let canon_anchor = anchor.canonicalize()
                                .map_err(|e| format!("Invalid parent: {e}"))?;
                            let home_canonical = home_canonical_path()?;
                            if !canon_anchor.starts_with(&home_canonical) {
                                return Err("Access denied: createParents outside home".to_string());
                            }
                            std::fs::create_dir_all(parent)
                                .map_err(|e| format!("mkdir failed: {e}"))?;
                            // mkdir 후 다시 canonicalize 해서 결과 위치도 HOME 안인지
                            // 재확인 (TOCTOU: mkdir 사이에 symlink swap 방어).
                            let canon_after = parent.canonicalize()
                                .map_err(|e| format!("Created parent re-canonicalize: {e}"))?;
                            if !canon_after.starts_with(&home_canonical) {
                                return Err(
                                    "Access denied: parent resolved outside home after mkdir".to_string()
                                );
                            }
                        }
                    }
                }

                let canonical = validate_remote_path(path)?;
                let bytes: Vec<u8> = match encoding {
                    "utf8" => content.as_bytes().to_vec(),
                    "base64" => {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD
                            .decode(content)
                            .map_err(|e| format!("Invalid base64: {e}"))?
                    }
                    other => return Err(format!("Unsupported encoding: {other}")),
                };
                if append {
                    use std::io::Write;
                    let mut f = std::fs::OpenOptions::new()
                        .append(true)
                        .open(&canonical)
                        .map_err(|e| format!("append open failed: {e}"))?;
                    f.write_all(&bytes).map_err(|e| format!("append write failed: {e}"))?;
                } else {
                    std::fs::write(&canonical, &bytes).map_err(|e| e.to_string())?;
                }
                crate::emit_global("remote-file-changed", serde_json::json!({ "path": canonical.to_string_lossy() }));
                Ok(serde_json::json!({ "ok": true }))
            }
            _ => Err("Unhandled API method".to_string()),
        }
    })();

    let (result_json, error) = match result {
        Ok(v) => (serde_json::to_string(&v).unwrap_or_default(), String::new()),
        Err(e) => {
            log::warn!("[api] {} failed: {e}", req.method);
            (String::new(), e)
        }
    };

    encode_api_response(&req.request_id, &result_json, &error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_limit_not_exceeded_below_max() {
        assert!(!client_limit_exceeded(0, 1));
        assert!(!client_limit_exceeded(0, 10));
        assert!(!client_limit_exceeded(9, 10));
    }

    #[test]
    fn test_client_limit_exceeded_at_max() {
        assert!(client_limit_exceeded(1, 1));
        assert!(client_limit_exceeded(10, 10));
    }

    // ── update_sessions push pipeline ────────────────────────────────

    use crate::layout::PaneNode;
    use crate::remote::signaling::OutCmd;
    use crate::session::Session;

    fn make_state_with_sessions(specs: &[(&str, &str, u32)]) -> Arc<Mutex<ServerState>> {
        let (tx, _rx) = broadcast::channel(16);
        let mut s = ServerState::new(tx);
        for (id, name, pane_count) in specs {
            s.sessions.push(Session {
                id: (*id).to_string(),
                name: (*name).to_string(),
                root_pane: PaneNode::Leaf {
                    id: format!("pane-{id}"),
                    pty_id: format!("pty-{id}"),
                    shell: None,
                    cwd: None,
                    last_command: None,
                },
                pane_count: *pane_count as usize,
                created_at: 0,
            });
        }
        Arc::new(Mutex::new(s))
    }

    fn make_test_signaling_sender() -> (SignalingSender, mpsc::UnboundedReceiver<OutCmd>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (SignalingSender { tx }, rx)
    }

    #[test]
    fn snapshot_summaries_reflects_state() {
        let state = make_state_with_sessions(&[
            ("a", "flutter", 1),
            ("b", "racemo_mobile", 2),
            ("c", "racemo", 3),
        ]);
        let summaries = snapshot_session_summaries(&state);
        assert_eq!(summaries.len(), 3);
        assert_eq!(summaries[0], SessionSummary { name: "flutter".into(), pane_count: 1 });
        assert_eq!(summaries[1], SessionSummary { name: "racemo_mobile".into(), pane_count: 2 });
        assert_eq!(summaries[2], SessionSummary { name: "racemo".into(), pane_count: 3 });
    }

    #[test]
    fn snapshot_summaries_clamps_zero_pane_count_to_one() {
        // pane_count is `usize` so it can't be negative, but a freshly-pushed
        // session in a degenerate state could be 0. Clamp to 1 so the wire
        // payload always reflects a sensible value (matches server semantics).
        let state = make_state_with_sessions(&[("a", "x", 0)]);
        let summaries = snapshot_session_summaries(&state);
        assert_eq!(summaries[0].pane_count, 1);
    }

    /// Pull a `Send` payload out of the receiver, panicking on anything else.
    fn expect_send_payload(rx: &mut mpsc::UnboundedReceiver<OutCmd>) -> String {
        let cmd = rx.try_recv().expect("expected one OutCmd");
        match cmd {
            OutCmd::Send(s) => s,
            OutCmd::Ping => panic!("expected Send, got Ping"),
            OutCmd::Close => panic!("expected Send, got Close"),
        }
    }

    #[test]
    fn push_update_sessions_emits_correct_wire_message() {
        let (sender, mut rx) = make_test_signaling_sender();
        let summaries = vec![
            SessionSummary { name: "alpha".into(), pane_count: 2 },
            SessionSummary { name: "beta".into(), pane_count: 5 },
        ];
        push_update_sessions(&sender, summaries);

        let payload = expect_send_payload(&mut rx);
        // Round-trip through the same SignalingMessage parser the server uses.
        let parsed: SignalingMessage = serde_json::from_str(&payload).unwrap();
        match parsed {
            SignalingMessage::UpdateSessions { sessions } => {
                assert_eq!(sessions.len(), 2);
                assert_eq!(sessions[0].name, "alpha");
                assert_eq!(sessions[0].pane_count, 2);
                assert_eq!(sessions[1].name, "beta");
                assert_eq!(sessions[1].pane_count, 5);
            }
            other => panic!("Expected UpdateSessions, got {other:?}"),
        }
        // Exactly one message — push_update_sessions is fire-and-forget.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn push_update_sessions_handles_empty_list() {
        let (sender, mut rx) = make_test_signaling_sender();
        push_update_sessions(&sender, vec![]);
        let payload = expect_send_payload(&mut rx);
        assert_eq!(payload, r#"{"type":"update_sessions","sessions":[]}"#);
    }

    // ── validate_remote_path: new-file support ───────────────────────────

    #[test]
    fn validate_remote_path_allows_new_file_in_existing_dir() {
        // 부모(HOME)는 존재하고 파일은 아직 없는 케이스 — write_file 의 정상 경로.
        let home = std::env::var("HOME").expect("HOME not set");
        let new_path = format!(
            "{home}/.racemo-test-new-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        // 파일 자체는 만들지 않는다 — validate 만 통과해야 함.
        let result = validate_remote_path(&new_path);
        assert!(
            result.is_ok(),
            "expected new-file path to validate, got: {:?}",
            result
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_remote_path_rejects_outside_home() {
        // /tmp 는 HOME 밖이어야 한다 (대부분의 unix 시스템).
        let result = validate_remote_path("/tmp/some-nonexistent-file");
        assert!(result.is_err(), "expected /tmp path to be rejected, got: {:?}", result);
    }

    // ── write_file base64 round-trip ─────────────────────────────────────

    #[test]
    fn base64_decode_round_trip_preserves_binary() {
        use base64::Engine;
        let raw: &[u8] = &[0x00, 0x01, 0x02, 0x7f, 0x80, 0xff, 0xfe];
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .expect("base64 decode");
        assert_eq!(decoded, raw);
    }

    // ── extract_commit_message ───────────────────────────────────────────

    #[test]
    fn extract_commit_message_strips_fences() {
        let raw = "Some preface\n```\nfeat(api): add foo\n\nLong body\n```\nafter";
        assert_eq!(extract_commit_message(raw), "feat(api): add foo\n\nLong body");
    }

    #[test]
    fn extract_commit_message_handles_lang_tag() {
        let raw = "```text\nfix: bar\n```";
        assert_eq!(extract_commit_message(raw), "fix: bar");
    }

    #[test]
    fn extract_commit_message_passthrough_without_fence() {
        let raw = "feat: just a line";
        assert_eq!(extract_commit_message(raw), "feat: just a line");
    }

    #[test]
    fn extract_commit_message_caps_at_8kb() {
        let raw = "x".repeat(9000);
        let result = extract_commit_message(&raw);
        assert!(result.len() <= 8 * 1024);
    }

    #[test]
    fn extract_commit_message_trims_whitespace() {
        let raw = "  \n\n  fix: trim me  \n  ";
        assert_eq!(extract_commit_message(raw), "fix: trim me");
    }

    // ── parse_commit_plans ──────────────────────────────────────────────

    #[test]
    fn parse_commit_plans_parses_blocks() {
        let raw = "---COMMIT---\nFILES: a.rs, b.rs\nMSG: feat(foo): add stuff\n---COMMIT---\nFILES: c.rs\nMSG: fix: bug\n";
        let plans = parse_commit_plans(raw);
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].files, vec!["a.rs".to_string(), "b.rs".to_string()]);
        assert_eq!(plans[0].msg, "feat(foo): add stuff");
        assert_eq!(plans[1].files, vec!["c.rs".to_string()]);
        assert_eq!(plans[1].msg, "fix: bug");
    }

    #[test]
    fn parse_commit_plans_strips_quotes_from_msg() {
        let raw = "---COMMIT---\nFILES: a.rs\nMSG: \"feat: quoted\"\n";
        let plans = parse_commit_plans(raw);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].msg, "feat: quoted");
    }

    #[test]
    fn parse_commit_plans_fallback_picks_prefixed_line() {
        let raw = "Some preface\nfeat(api): single line commit\nblah\n";
        let plans = parse_commit_plans(raw);
        assert_eq!(plans.len(), 1);
        assert!(plans[0].files.is_empty());
        assert_eq!(plans[0].msg, "feat(api): single line commit");
    }

    #[test]
    fn parse_commit_plans_returns_empty_when_no_match() {
        let raw = "no useful content here";
        assert!(parse_commit_plans(raw).is_empty());
    }

    // ── encode_api_response chunking ────────────────────────────────────

    fn decode_api_response(bytes: &[u8]) -> proto::ApiResponse {
        use prost::Message as _;
        let msg = proto::RemoteMessage::decode(bytes).expect("decode RemoteMessage");
        match msg.payload {
            Some(proto::remote_message::Payload::ApiResponse(r)) => r,
            _ => panic!("expected ApiResponse payload"),
        }
    }

    #[test]
    fn encode_api_response_small_payload_is_single_message() {
        let chunks = encode_api_response("req-1", "{\"ok\":true}", "");
        assert_eq!(chunks.len(), 1, "small payloads stay as one message");
        let r = decode_api_response(&chunks[0]);
        assert_eq!(r.request_id, "req-1");
        assert_eq!(r.result_json, "{\"ok\":true}");
        assert_eq!(r.error, "");
        assert_eq!(r.chunk_total, 0, "chunk_total=0 marks legacy single-msg");
        assert_eq!(r.chunk_seq, 0);
    }

    #[test]
    fn encode_api_response_error_never_chunks() {
        // Even with a "huge" error string we must keep error responses
        // single-message since the client short-circuits on error.
        let huge_err: String = "e".repeat(API_CHUNK_BYTES * 3);
        let chunks = encode_api_response("req-2", "", &huge_err);
        assert_eq!(chunks.len(), 1);
        let r = decode_api_response(&chunks[0]);
        assert_eq!(r.error, huge_err);
        assert_eq!(r.chunk_total, 0);
    }

    #[test]
    fn encode_api_response_large_payload_splits_and_reassembles() {
        // Build a payload safely above the chunk threshold.
        let payload: String = "a".repeat(API_CHUNK_BYTES * 2 + 1234);
        let chunks = encode_api_response("req-3", &payload, "");
        assert!(chunks.len() >= 3, "expected ≥3 chunks, got {}", chunks.len());

        // All chunks share the same request_id and chunk_total; chunk_seq
        // monotonically increases from 0.
        let mut reassembled = String::new();
        for (i, bytes) in chunks.iter().enumerate() {
            let r = decode_api_response(bytes);
            assert_eq!(r.request_id, "req-3");
            assert_eq!(r.chunk_total as usize, chunks.len());
            assert_eq!(r.chunk_seq as usize, i);
            assert!(r.error.is_empty());
            reassembled.push_str(&r.result_json);
        }
        assert_eq!(reassembled, payload, "reassembled payload matches input");
    }

    #[test]
    fn encode_api_response_chunks_at_char_boundary_for_multibyte() {
        // 한글 + emoji 가 chunk 경계에 걸려도 UTF-8 char boundary 를 침범하면
        // proto3 string 으로 인코딩이 깨지므로, 분할이 항상 char boundary 에서
        // 일어나야 한다. payload 길이를 chunk 임계치 근처로 맞춰 분할 발생.
        let unit = "한글🚀가나다";
        let payload = unit.repeat((API_CHUNK_BYTES / unit.len()) + 50);
        let chunks = encode_api_response("req-4", &payload, "");
        assert!(chunks.len() >= 2);
        let mut reassembled = String::new();
        for bytes in &chunks {
            let r = decode_api_response(bytes);
            // 각 chunk 도 valid UTF-8 string 임이 proto decode 에서 보장됨.
            reassembled.push_str(&r.result_json);
        }
        assert_eq!(reassembled, payload);
    }
}
