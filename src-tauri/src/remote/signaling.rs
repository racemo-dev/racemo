use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// User info from a connection request (sent by the signaling server).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionRequestUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Compact session summary pushed to the signaling server so it can keep
/// the device's session list fresh between WS reconnects (mobile reads it via
/// `GET /auth/me/devices`). Mirrors the JSON shape of the registration-time
/// `&sessions=...` query param so the server can store both via the same code path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub name: String,
    pub pane_count: u32,
}

/// Single prompt entry — wire format for desktop ↔ mobile sync.
/// `status` is "pending" | "done"; `completed_at` is None for pending.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptDto {
    pub id: String,
    pub text: String,
    pub status: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
}

/// Signaling protocol messages (JSON over WebSocket).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalingMessage {
    // Host → Server
    CreateRoom { pairing_code: String },
    SdpAnswer { sdp: String, #[serde(default)] room_code: Option<String> },
    ApproveConnection { approved: bool },
    /// Push host's current session list. Server replaces its cached snapshot
    /// (full truth, not delta). Fire-and-forget — no response. Old signaling
    /// servers ignore unknown types, so this is forward-compatible.
    UpdateSessions { sessions: Vec<SessionSummary> },
    /// Push host's current prompts list. Server replaces its cached snapshot
    /// and broadcasts to paired mobile clients as a `peer_message` envelope
    /// with `kind: "prompts_updated"`. Mirrors UpdateSessions semantics.
    UpdatePrompts { prompts: Vec<PromptDto> },

    // Client → Server
    JoinRoom { pairing_code: String },
    SdpOffer { sdp: String },

    // Both → Server
    IceCandidate { candidate: String, #[serde(default)] room_code: Option<String> },

    // Server → Both
    PeerJoined { peer_id: String },
    RoomCreated { room_id: String },
    Error { code: String, message: String },
    RoomExpired,

    // Account-based: Server → Host
    // max_clients: 서버가 계정 플랜을 검증해 내려주는 동시 연결 상한.
    //   - 클라이언트는 이 값을 신뢰해야 하며, 자기 JWT의 plan 필드를 직접 해석하지 않음.
    //   - 서버가 값을 안 주면 None — 가장 보수적인 기본값(1)으로 fallback.
    DeviceRegistered {
        device_id: String,
        device_name: String,
        #[serde(default)]
        max_clients: Option<usize>,
    },
    ConnectionRequest {
        room_code: String,
        #[serde(default)]
        from_user: Option<ConnectionRequestUser>,
        #[serde(default)]
        from_device: Option<String>,
    },

    // Account-based: Server → Client
    ConnectingToDevice { device_id: String, room_code: String },

    // Account-based: Host → Client (via relay)
    ConnectionResponse { approved: bool, #[serde(default)] room_code: Option<String> },

    // Account-based: Server → Host (client WS closed)
    ClientDisconnected { room_code: String },

    /// 일반 peer-to-peer 이벤트 envelope. payload 는 wire 위에서는
    /// 임의 JSON 으로 전달되며, 서버는 forward 만 한다 (해석 X).
    /// 첫 사용처: 서버가 호스트 WS close 감지 시 모바일에 합성 발송 →
    /// `payload.kind == "peer_offline"` 으로 모바일이 즉시 reconnecting
    /// 상태 전환. host → mobile 방향은 graceful shutdown 통보용
    /// (`payload.kind == "host_shutting_down"`) 등으로 사용 가능.
    PeerMessage { payload: serde_json::Value },
}

/// Internal command for the outgoing WS task.
pub enum OutCmd {
    Send(String),
    /// WS-level Ping frame — used to detect dead TCP connections after sleep.
    Ping,
    Close,
}

/// Signaling client connecting to the signaling server via WebSocket.
pub struct SignalingClient {
    tx: mpsc::UnboundedSender<OutCmd>,
    rx: mpsc::UnboundedReceiver<SignalingMessage>,
    /// Abort handles for background I/O tasks — aborted on Drop to prevent zombie tasks.
    task_handles: Vec<tokio::task::AbortHandle>,
}

impl Drop for SignalingClient {
    fn drop(&mut self) {
        for handle in &self.task_handles {
            handle.abort();
        }
    }
}

/// HTTP 403 응답에서 body 텍스트를 추출합니다.
/// tungstenite 에러 메시지에서 "HTTP error: 403 Forbidden" 이후의 body를 추출합니다.
fn extract_http_body(err_msg: &str) -> Option<String> {
    // tokio-tungstenite formats: "HTTP error: 403 Forbidden\n<body>"
    // or "HTTP status code 403"
    // Body is after the status line
    if let Some(pos) = err_msg.find("403") {
        let after_403 = &err_msg[pos..];
        // Find the body part (after first newline)
        if let Some(nl) = after_403.find('\n') {
            let body = after_403[nl..].trim();
            if !body.is_empty() {
                return Some(body.to_string());
            }
        }
    }
    None
}

impl SignalingClient {
    /// Connect to the signaling server using a pairing code.
    pub async fn connect(url: &str, role: &str, code: &str, extra_params: &str) -> Result<Self, String> {
        Self::connect_with_param(url, role, "code", code, extra_params).await
    }

    /// Connect to the signaling server using a JWT token (account-based mode).
    /// The token is sent as the first WebSocket message instead of a query parameter,
    /// preventing it from appearing in server access logs.
    pub async fn connect_with_token(url: &str, role: &str, token: &str, extra_params: &str) -> Result<Self, String> {
        let full_url = format!("{url}/ws?role={role}{extra_params}");
        let client = Self::connect_raw(&full_url).await?;
        // Send JWT as first message
        let auth_msg = serde_json::json!({"type": "auth", "token": token});
        client.tx.send(OutCmd::Send(auth_msg.to_string()))
            .map_err(|e| format!("Failed to send auth message: {e}"))?;
        Ok(client)
    }

    async fn connect_with_param(url: &str, role: &str, key: &str, val: &str, extra: &str) -> Result<Self, String> {
        let full_url = format!("{url}/ws?role={role}&{key}={val}{extra}");
        Self::connect_raw(&full_url).await
    }

    async fn connect_raw(full_url: &str) -> Result<Self, String> {
        // Build request with Origin header for server-side origin validation
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = full_url.into_client_request()
            .map_err(|e| format!("Failed to build WS request: {e}"))?;
        request.headers_mut().insert("Origin", "tauri://localhost".parse().unwrap());

        let (ws_stream, _) = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio_tungstenite::connect_async(request)
        ).await
            .map_err(|_| "Signaling server connection timed out (3s)".to_string())?
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("403") {
                    if let Some(body) = extract_http_body(&msg) {
                        body
                    } else {
                        "서버 접근이 거부되었습니다 (403 Forbidden)".to_string()
                    }
                } else {
                    format!("WebSocket connect failed: {e}")
                }
            })?;

        let (mut ws_sink, mut ws_stream_rx) = ws_stream.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<OutCmd>();
        let (in_tx, in_rx) = mpsc::unbounded_channel::<SignalingMessage>();

        // oneshot: outgoing task signals incoming task to stop on write failure.
        let (abort_tx, abort_rx) = tokio::sync::oneshot::channel::<()>();

        // Outgoing: channel → WebSocket
        let out_handle = tokio::spawn(async move {
            let mut abort_tx = Some(abort_tx);
            while let Some(cmd) = out_rx.recv().await {
                let write_result = match cmd {
                    OutCmd::Send(msg) => ws_sink.send(Message::Text(msg)).await,
                    OutCmd::Ping => ws_sink.send(Message::Ping(vec![])).await,
                    OutCmd::Close => {
                        let _ = ws_sink.send(Message::Close(None)).await;
                        break;
                    }
                };
                if write_result.is_err() {
                    // Signal incoming task to abort — dead TCP connection detected.
                    if let Some(tx) = abort_tx.take() {
                        let _ = tx.send(());
                    }
                    break;
                }
            }
        });

        // Incoming: WebSocket → channel
        let in_handle = tokio::spawn(async move {
            let mut abort_rx = abort_rx;
            loop {
                tokio::select! {
                    msg = ws_stream_rx.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(parsed) = serde_json::from_str::<SignalingMessage>(&text) {
                                    if in_tx.send(parsed).is_err() {
                                        break;
                                    }
                                }
                            }
                            None | Some(Err(_)) => break,
                            _ => {} // Ping/Pong/Binary frames — ignored
                        }
                    }
                    // Outgoing task signaled failure OR was dropped (graceful close).
                    _ = &mut abort_rx => break,
                }
            }
            // in_tx dropped here → signaling.recv() returns None in the main loop.
        });

        Ok(Self {
            tx: out_tx,
            rx: in_rx,
            task_handles: vec![out_handle.abort_handle(), in_handle.abort_handle()],
        })
    }

    /// Clone the outgoing sender (for ICE candidate forwarding from another task).
    pub fn clone_tx(&self) -> SignalingSender {
        SignalingSender { tx: self.tx.clone() }
    }

    /// Get the raw outgoing channel sender (for storing a close handle).
    pub fn raw_tx(&self) -> mpsc::UnboundedSender<OutCmd> {
        self.tx.clone()
    }

    /// Send a signaling message.
    pub fn send(&self, msg: &SignalingMessage) -> Result<(), String> {
        let json = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        self.tx.send(OutCmd::Send(json)).map_err(|e| e.to_string())
    }

    /// Receive the next signaling message.
    pub async fn recv(&mut self) -> Option<SignalingMessage> {
        self.rx.recv().await
    }

    /// Send a WS-level Ping to detect dead TCP connections.
    /// Returns Err if the outgoing task has already exited (connection dead).
    pub fn ping(&self) -> Result<(), String> {
        self.tx.send(OutCmd::Ping).map_err(|e| e.to_string())
    }

    /// Close the WebSocket connection gracefully.
    pub fn close(&self) {
        let _ = self.tx.send(OutCmd::Close);
    }
}

/// A cloneable sender handle for forwarding messages (e.g. ICE candidates).
#[derive(Clone)]
pub struct SignalingSender {
    pub(crate) tx: mpsc::UnboundedSender<OutCmd>,
}

impl SignalingSender {
    pub fn send(&self, json: String) -> Result<(), String> {
        self.tx.send(OutCmd::Send(json)).map_err(|e| e.to_string())
    }

    /// Send a WS-level Ping to detect dead TCP connections.
    pub fn ping(&self) -> Result<(), String> {
        self.tx.send(OutCmd::Ping).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sdp_offer_with_extra_room_code_field() {
        // Host sends SdpOffer with room_code (for signaling server routing).
        // Client must parse it even though SdpOffer doesn't have a room_code field.
        let json = r#"{"type":"sdp_offer","sdp":"v=0\r\n...","room_code":"acct_123"}"#;
        let msg: SignalingMessage = serde_json::from_str(json).expect("SdpOffer with extra field should parse");
        match msg {
            SignalingMessage::SdpOffer { sdp } => assert!(sdp.contains("v=0")),
            other => panic!("Expected SdpOffer, got: {other:?}"),
        }
    }

    #[test]
    fn test_sdp_answer_with_room_code() {
        // Enriched SdpAnswer from signaling server (room_code injected).
        let json = r#"{"type":"sdp_answer","sdp":"v=0\r\n...","room_code":"acct_456"}"#;
        let msg: SignalingMessage = serde_json::from_str(json).expect("SdpAnswer with room_code should parse");
        match msg {
            SignalingMessage::SdpAnswer { sdp, room_code } => {
                assert!(sdp.contains("v=0"));
                assert_eq!(room_code, Some("acct_456".to_string()));
            }
            other => panic!("Expected SdpAnswer, got: {other:?}"),
        }
    }

    #[test]
    fn test_ice_candidate_with_room_code() {
        let json = r#"{"type":"ice_candidate","candidate":"{\"candidate\":\"...\"}","room_code":"acct_789"}"#;
        let msg: SignalingMessage = serde_json::from_str(json).expect("IceCandidate with room_code should parse");
        match msg {
            SignalingMessage::IceCandidate { candidate, room_code } => {
                assert!(candidate.contains("candidate"));
                assert_eq!(room_code, Some("acct_789".to_string()));
            }
            other => panic!("Expected IceCandidate, got: {other:?}"),
        }
    }

    #[test]
    fn test_sdp_answer_without_room_code() {
        // Original format without room_code should still parse (backwards compat).
        let json = r#"{"type":"sdp_answer","sdp":"v=0\r\n..."}"#;
        let msg: SignalingMessage = serde_json::from_str(json).expect("SdpAnswer without room_code should parse");
        match msg {
            SignalingMessage::SdpAnswer { room_code, .. } => assert_eq!(room_code, None),
            other => panic!("Expected SdpAnswer, got: {other:?}"),
        }
    }

    #[test]
    fn test_connection_response_parses() {
        let json = r#"{"type":"connection_response","approved":true,"room_code":"acct_123"}"#;
        let msg: SignalingMessage = serde_json::from_str(json).expect("should parse");
        match msg {
            SignalingMessage::ConnectionResponse { approved, room_code } => {
                assert!(approved);
                assert_eq!(room_code, Some("acct_123".to_string()));
            }
            other => panic!("Expected ConnectionResponse, got: {other:?}"),
        }
    }

    #[test]
    fn test_connection_response_rejected() {
        let json = r#"{"type":"connection_response","approved":false,"room_code":"acct_456"}"#;
        let msg: SignalingMessage = serde_json::from_str(json).expect("should parse");
        match msg {
            SignalingMessage::ConnectionResponse { approved, .. } => assert!(!approved),
            other => panic!("Expected ConnectionResponse, got: {other:?}"),
        }
    }

    #[test]
    fn test_update_sessions_serializes_with_snake_case_type() {
        let msg = SignalingMessage::UpdateSessions {
            sessions: vec![
                SessionSummary { name: "flutter".into(), pane_count: 1 },
                SessionSummary { name: "racemo".into(), pane_count: 3 },
            ],
        };
        let json = serde_json::to_string(&msg).unwrap();
        // Wire format must match the spec agreed with racemo-signal.
        assert!(json.contains(r#""type":"update_sessions""#), "got: {json}");
        assert!(json.contains(r#""name":"flutter""#));
        assert!(json.contains(r#""pane_count":1"#));
        assert!(json.contains(r#""pane_count":3"#));
    }

    #[test]
    fn test_update_sessions_round_trip() {
        let original = SignalingMessage::UpdateSessions {
            sessions: vec![SessionSummary { name: "a".into(), pane_count: 2 }],
        };
        let json = serde_json::to_string(&original).unwrap();
        let parsed: SignalingMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            SignalingMessage::UpdateSessions { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].name, "a");
                assert_eq!(sessions[0].pane_count, 2);
            }
            other => panic!("Expected UpdateSessions, got: {other:?}"),
        }
    }

    #[test]
    fn test_update_sessions_empty_list() {
        // Closing the last session must produce a valid empty-list payload.
        let msg = SignalingMessage::UpdateSessions { sessions: vec![] };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"type":"update_sessions","sessions":[]}"#);
    }

    #[test]
    fn test_update_prompts_round_trip() {
        let original = SignalingMessage::UpdatePrompts {
            prompts: vec![
                PromptDto {
                    id: "p1".into(),
                    text: "deploy staging".into(),
                    status: "pending".into(),
                    created_at: 1700000000,
                    completed_at: None,
                },
                PromptDto {
                    id: "p2".into(),
                    text: "rotate keys".into(),
                    status: "done".into(),
                    created_at: 1699000000,
                    completed_at: Some(1699500000),
                },
            ],
        };
        let json = serde_json::to_string(&original).unwrap();
        assert!(json.contains(r#""type":"update_prompts""#), "got: {json}");
        let parsed: SignalingMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            SignalingMessage::UpdatePrompts { prompts } => {
                assert_eq!(prompts.len(), 2);
                assert_eq!(prompts[0].id, "p1");
                assert_eq!(prompts[0].status, "pending");
                assert_eq!(prompts[0].completed_at, None);
                assert_eq!(prompts[1].completed_at, Some(1699500000));
            }
            other => panic!("Expected UpdatePrompts, got: {other:?}"),
        }
    }

    #[test]
    fn test_update_prompts_empty_list() {
        let msg = SignalingMessage::UpdatePrompts { prompts: vec![] };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"type":"update_prompts","prompts":[]}"#);
    }

    #[test]
    fn test_prompt_dto_omits_completed_at_when_none() {
        let dto = PromptDto {
            id: "x".into(),
            text: "y".into(),
            status: "pending".into(),
            created_at: 1,
            completed_at: None,
        };
        let json = serde_json::to_string(&dto).unwrap();
        assert!(!json.contains("completed_at"), "got: {json}");
    }
}
