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
use crate::remote::signaling::{SignalingClient, SignalingMessage, SignalingSender};
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
        let pending_approval = self.pending_approval_tx.clone();
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
                let (appr_tx, appr_rx) = mpsc::channel::<(String, bool)>(4);
                *pending_approval.lock() = Some(appr_tx);

                let should_retry = account_hosting_loop(
                    state.clone(),
                    broadcast_tx.clone(),
                    signaling_url.clone(),
                    jwt.clone(),
                    device_name.clone(),
                    sd_rx,
                    appr_rx,
                    first_result_tx.take(),
                ).await;

                // If a new start_account_based() was called while we were in the loop,
                // exit without touching shared state (new task owns the channels now).
                if hosting_gen.load(Ordering::SeqCst) != gen { break; }

                *shared_shutdown.lock() = None;
                *pending_approval.lock() = None;

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
type ApprovalWaiters = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;
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
    let history_sent = Arc::new(Mutex::new(std::collections::HashSet::<String>::new()));
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
                    let bytes = handle_editor_request(req, &broadcast_tx);
                    let dc_reply = dc_for_reply.clone();
                    tokio::spawn(async move {
                        let _ = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await;
                    });
                    return;
                }
                let req = req.clone();
                let dc_reply = dc_for_reply.clone();
                tokio::spawn(async move {
                    let bytes = tokio::task::spawn_blocking(move || handle_api_request(&req))
                        .await
                        .unwrap_or_else(|e| {
                            log::error!("[api] spawn_blocking failed: {e}");
                            api_error_response("", "Internal error")
                        });
                    let _ = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await;
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
            if let Some(proto::remote_message::Payload::ResizeRequest(ref resize)) = remote_msg.payload {
                let pty_id = resize.pty_id.clone();
                let should_send = { !history_sent.lock().contains(&pty_id) };
                if should_send {
                    history_sent.lock().insert(pty_id.clone());
                    let history = {
                        let s = state.lock();
                        s.get_pty_history(&pty_id)
                    };
                    // PtyResized는 handle_message→resize_pty_remote의 broadcast로 전송됨.
                    // 여기서 호스트 사이즈를 별도 전송하면 비동기 레이스로 인해
                    // 원격 xterm이 호스트의 큰 사이즈로 잘못 설정될 수 있음.
                    if let Some(data) = history {
                        if !data.is_empty() {
                            log::info!("[server-host:acct] sending {} bytes history for pane {}", data.len(), pty_id);
                            const CHUNK_SIZE: usize = 32 * 1024;
                            let dc_reply = dc_for_reply.clone();
                            let pty_id_clone = pty_id.clone();
                            tokio::spawn(async move {
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
                            });
                        }
                    }
                }
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
    approval_waiters: ApprovalWaiters,
    state: Arc<Mutex<ServerState>>,
    broadcast_tx: broadcast::Sender<ServerMessage>,
    host_login: String,
    disconnect_tx: mpsc::Sender<String>,
) {
    // 1. Auto-approve (same user) or wait for user approval
    let approved = if !host_login.is_empty() && from_login == host_login {
        log::info!("[server-host:acct:{room_code}] Auto-approving same user: {from_login}");
        true
    } else {
        let _ = broadcast_tx.send(ServerMessage::AccountConnectionRequest {
            room_code: room_code.clone(),
            from_login: from_login.clone(),
            from_device: from_device.clone(),
        });
        log::info!("[server-host:acct:{room_code}] Waiting for user approval from {from_login}");

        let (approval_tx, approval_rx) = oneshot::channel::<bool>();
        { approval_waiters.lock().insert(room_code.clone(), approval_tx); }

        tokio::select! {
            result = approval_rx => result.unwrap_or(false),
            _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                log::warn!("[server-host:acct:{room_code}] Approval timeout");
                approval_waiters.lock().remove(&room_code);
                false
            }
        }
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
    mut approval_rx: mpsc::Receiver<(String, bool)>,
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
    let approval_waiters: ApprovalWaiters = Arc::new(Mutex::new(HashMap::new()));
    let pty_session_map: PtySessionMap = Arc::new(Mutex::new(HashMap::new()));
    rebuild_pty_session_map(&state, &pty_session_map);
    let (disconnect_tx, mut disconnect_rx) = mpsc::channel::<String>(16);
    let sig_tx = signaling.clone_tx();

    let mut bridge_rx = broadcast_tx.subscribe();
    let mut heartbeat_interval = tokio::time::interval(
        std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS),
    );

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
                            approval_waiters.clone(),
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

            decision = approval_rx.recv() => {
                if let Some((room_code, approved)) = decision {
                    let waiter = { approval_waiters.lock().remove(&room_code) };
                    if let Some(tx) = waiter {
                        let _ = tx.send(approved);
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
                    Ok(ServerMessage::PtyResized { pane_id, rows, cols }) => {
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::PtyResized(
                                proto::PtyResized { pty_id: pane_id, cols: cols as u32, rows: rows as u32 },
                            )),
                        };
                        broadcast_to_all_clients(&client_map, &remote_msg.encode_to_vec()).await;
                    }
                    Ok(ServerMessage::PtyExit { pane_id }) => {
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::Disconnect(
                                proto::Disconnect { reason: format!("PTY exited: {pane_id}") },
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
    let history_sent_code = Arc::new(parking_lot::Mutex::new(std::collections::HashSet::<String>::new()));
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
                    let bytes = handle_editor_request(req, &broadcast_tx);
                    let dc_reply = dc_for_reply.clone();
                    tokio::spawn(async move {
                        let _ = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await;
                    });
                    return;
                }
                let req = req.clone();
                let dc_reply = dc_for_reply.clone();
                tokio::spawn(async move {
                    let bytes = tokio::task::spawn_blocking(move || handle_api_request(&req))
                        .await
                        .unwrap_or_else(|e| {
                            log::error!("[api] spawn_blocking failed: {e}");
                            api_error_response("", "Internal error")
                        });
                    let _ = dc_reply.send(&bytes::Bytes::copy_from_slice(&bytes)).await;
                });
                return;
            }
            if let Some(proto::remote_message::Payload::ResizeRequest(ref resize)) = remote_msg.payload {
                let pty_id = resize.pty_id.clone();
                let should_send = { !history_sent_code.lock().contains(&pty_id) };
                if should_send {
                    history_sent_code.lock().insert(pty_id.clone());
                    let history = {
                        let s = state.lock();
                        s.get_pty_history(&pty_id)
                    };
                    // PtyResized는 handle_message→resize_pty_remote의 broadcast로 전송됨.
                    // 여기서 호스트 사이즈를 별도 전송하면 비동기 레이스로 인해
                    // 원격 xterm이 호스트의 큰 사이즈로 잘못 설정될 수 있음.
                    if let Some(data) = history {
                        if !data.is_empty() {
                            log::info!("[server-host] sending {} bytes history for pane {}", data.len(), pty_id);
                            const CHUNK_SIZE: usize = 32 * 1024;
                            let dc_reply = dc_for_reply.clone();
                            let pty_id_clone = pty_id.clone();
                            tokio::spawn(async move {
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
                            });
                        }
                    }
                }
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
                    Ok(ServerMessage::PtyResized { pane_id, rows, cols }) => {
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::PtyResized(
                                proto::PtyResized { pty_id: pane_id, cols: cols as u32, rows: rows as u32 },
                            )),
                        };
                        send_to_all(data_channels, &remote_msg.encode_to_vec()).await;
                    }
                    Ok(ServerMessage::PtyExit { pane_id }) => {
                        let remote_msg = proto::RemoteMessage {
                            payload: Some(proto::remote_message::Payload::Disconnect(
                                proto::Disconnect { reason: format!("PTY exited: {pane_id}") },
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
fn validate_remote_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    let canonical = p.canonicalize().map_err(|e| format!("Invalid path: {e}"))?;
    #[cfg(unix)]
    {
        let home = std::env::var("HOME")
            .map_err(|_| "Cannot determine home directory".to_string())?;
        let home_canonical = std::path::Path::new(&home)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(&home));
        if !canonical.starts_with(&home_canonical) {
            return Err("Access denied: path outside home directory".to_string());
        }
    }
    Ok(canonical)
}

/// Handle "open_editor" / "close_editor" API requests: validate path, broadcast to host frontend.
fn handle_editor_request(
    req: &proto::ApiRequest,
    broadcast_tx: &broadcast::Sender<ServerMessage>,
) -> Vec<u8> {
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

    let msg = proto::RemoteMessage {
        payload: Some(proto::remote_message::Payload::ApiResponse(
            proto::ApiResponse {
                request_id: req.request_id.clone(),
                result_json,
                error: err_str,
            },
        )),
    };
    msg.encode_to_vec()
}

/// Allowed API methods that can be invoked via DataChannel.
/// Any method not in this list is rejected before dispatching.
const ALLOWED_API_METHODS: &[&str] = &[
    "home_dir", "list_dir", "list_directory_filtered",
    "git_info", "git_status", "git_action", "git_log", "git_diff",
    "get_history", "hook_log", "read_file", "write_file",
];

/// Allowed git sub-actions within the "git_action" method.
const ALLOWED_GIT_ACTIONS: &[&str] = &[
    "stage", "unstage", "stage_all", "unstage_all",
    "commit", "discard", "push", "gitignore",
];

/// Handle an ApiRequest (Explorer/Git API tunneled over DataChannel).
/// Returns encoded protobuf bytes for the ApiResponse.
/// Build an encoded ApiResponse error (used when handle_api_request itself is unreachable).
fn api_error_response(request_id: &str, error: &str) -> Vec<u8> {
    let msg = proto::RemoteMessage {
        payload: Some(proto::remote_message::Payload::ApiResponse(
            proto::ApiResponse {
                request_id: request_id.to_string(),
                result_json: String::new(),
                error: error.to_string(),
            },
        )),
    };
    msg.encode_to_vec()
}

fn handle_api_request(req: &proto::ApiRequest) -> Vec<u8> {
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
                        Some(serde_json::json!({ "name": name, "type": kind }))
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
            "hook_log" => {
                let max = params["max"].as_u64().unwrap_or(20) as usize;
                let nodes = crate::hooklog::read_hook_log_tree(max);
                Ok(serde_json::to_value(nodes).map_err(|e| e.to_string())?)
            }
            "read_file" => {
                let path = params["path"].as_str().ok_or("Missing path")?;
                let canonical = validate_remote_path(path)?;
                const MAX_READ_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
                let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
                if meta.len() > MAX_READ_SIZE {
                    return Err(format!("File too large: {} bytes (max {})", meta.len(), MAX_READ_SIZE));
                }
                let content = std::fs::read_to_string(&canonical).map_err(|e| e.to_string())?;
                Ok(serde_json::json!({ "content": content }))
            }
            "write_file" => {
                let path = params["path"].as_str().ok_or("Missing path")?;
                let content = params["content"].as_str().ok_or("Missing content")?;
                const MAX_WRITE_SIZE: usize = 10 * 1024 * 1024; // 10 MB
                if content.len() > MAX_WRITE_SIZE {
                    return Err(format!("Content too large: {} bytes (max {})", content.len(), MAX_WRITE_SIZE));
                }
                let canonical = validate_remote_path(path)?;
                std::fs::write(&canonical, content).map_err(|e| e.to_string())?;
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

    let response = proto::RemoteMessage {
        payload: Some(proto::remote_message::Payload::ApiResponse(
            proto::ApiResponse {
                request_id: req.request_id.clone(),
                result_json,
                error,
            },
        )),
    };
    use prost::Message as _;
    response.encode_to_vec()
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

}
