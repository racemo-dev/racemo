//! Presence WS — 데스크탑이 로그인 + 앱 실행 상태이기만 하면 항상 켜져 있는
//! 가벼운 watcher 채널. 시그널링 서버에 `role=presence` 로 등록되어 모바일에
//! "켜져 있는 데스크탑" 으로 노출된다. 공유는 하지 않음.
//!
//! 책임:
//! - JWT 기반 인증 후 시그널링 서버에 등록
//! - 30초 주기 ping 으로 dead connection 조기 검출
//! - 서버가 보내는 `{"type":"start_share"}` 푸시 수신 → IPC 로 host loop 트리거
//! - 연결 끊김 시 지수 backoff (5s → 30s → 60s cap) 로 재연결
//!
//! 비책임:
//! - 공유 자체 (그건 server_host::account_hosting_loop 가 담당)
//! - JWT 갱신 (`auth::get_valid_access_token` 가 호출 시점마다 처리)

use std::sync::Arc;
use std::time::Duration;
use std::path::PathBuf;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::{Mutex as TokioMutex, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use tauri::Emitter;

use crate::commands::IpcState;
use crate::ipc::protocol::{ClientMessage, ServerMessage};
use crate::remote::prompts_state::PromptsState;

/// presence loop 의 외부 컨트롤 핸들. drop 되거나 `stop()` 호출 시 loop 가 종료된다.
pub struct PresenceHandle {
    shutdown_tx: Option<oneshot::Sender<()>>,
    join: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl PresenceHandle {
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

impl Drop for PresenceHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            join.abort();
        }
    }
}

/// Tauri 앱이 관리하는 presence 상태. `setup` 시 None 으로 등록되고, 로그인 직후
/// `start()` 가 채워 넣는다. 로그아웃 / 종료 시 `stop()` 으로 비운다.
pub type PresenceState = Arc<TokioMutex<Option<PresenceHandle>>>;

/// presence loop 를 시작한다. 이미 실행 중이면 기존 loop 를 stop 하고 새로 시작.
/// JWT 만료 시 자동 갱신은 loop 내부에서 reconnect 사이클마다 처리.
pub async fn start(app: &AppHandle, presence_state: PresenceState) {
    // 이미 실행 중이면 정리
    {
        let mut guard = presence_state.lock().await;
        if let Some(h) = guard.take() {
            log::info!("[presence] replacing existing handle");
            drop(guard);
            h.stop().await;
        }
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let app_clone = app.clone();
    let join = tauri::async_runtime::spawn(async move {
        run_loop(app_clone, shutdown_rx).await;
    });

    *presence_state.lock().await = Some(PresenceHandle {
        shutdown_tx: Some(shutdown_tx),
        join: Some(join),
    });
}

/// presence loop 종료. 토큰 폐기 / 로그아웃 / 앱 종료 시 호출.
pub async fn stop(presence_state: &PresenceState) {
    let handle = {
        let mut guard = presence_state.lock().await;
        guard.take()
    };
    if let Some(h) = handle {
        h.stop().await;
    }
}

/// 본 loop. 외부에서 shutdown 시그널이 오거나 fatal error 발생 시까지 reconnect.
async fn run_loop(app: AppHandle, mut shutdown_rx: oneshot::Receiver<()>) {
    let mut backoff = Duration::from_secs(5);
    const MAX_BACKOFF: Duration = Duration::from_secs(60);

    loop {
        // shutdown 우선 검사 — connect 시도 전 매번 확인.
        if matches!(shutdown_rx.try_recv(), Ok(_) | Err(oneshot::error::TryRecvError::Closed)) {
            log::info!("[presence] shutdown received, exiting loop");
            return;
        }

        let result = single_session(&app, &mut shutdown_rx).await;
        match result {
            SessionOutcome::Shutdown => return,
            SessionOutcome::AuthFailed => {
                log::warn!(
                    "[presence] auth failed — JWT may be invalid; will retry after {}s",
                    backoff.as_secs()
                );
            }
            SessionOutcome::Disconnected => {
                log::info!(
                    "[presence] disconnected; reconnecting in {}s",
                    backoff.as_secs()
                );
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = &mut shutdown_rx => {
                log::info!("[presence] shutdown received during backoff");
                return;
            }
        }

        // exponential backoff with cap.
        backoff = std::cmp::min(backoff.saturating_mul(2), MAX_BACKOFF);
    }
}

enum SessionOutcome {
    Shutdown,
    AuthFailed,
    Disconnected,
}

/// 한 번의 WS 세션. 연결 → 인증 → message loop → 종료.
async fn single_session(
    app: &AppHandle,
    shutdown_rx: &mut oneshot::Receiver<()>,
) -> SessionOutcome {
    // 1) JWT 확보 (만료됐으면 refresh)
    let jwt = match crate::auth::get_valid_access_token(app).await {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[presence] no valid access token: {e}");
            return SessionOutcome::AuthFailed;
        }
    };

    let device_name = crate::auth::get_device_name();
    let os = std::env::consts::OS.to_string();
    let device_id = get_or_create_persistent_device_id(app);

    // 2) URL 구성. role=presence 로 시그널링 서버 분기.
    let encoded_name = percent_encode(&device_name);
    let url = format!(
        "{}/ws?role=presence&device_name={}&os={}&device_id={}",
        super::DEFAULT_SIGNALING_URL,
        encoded_name,
        os,
        device_id,
    );

    // 3) WS 연결
    let mut request = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            log::error!("[presence] build request failed: {e}");
            return SessionOutcome::Disconnected;
        }
    };
    request.headers_mut().insert(
        "Origin",
        "tauri://localhost".parse().expect("static origin"),
    );

    let connect_result = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await;

    let ws_stream = match connect_result {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(e)) => {
            log::warn!("[presence] connect failed: {e}");
            return SessionOutcome::Disconnected;
        }
        Err(_) => {
            log::warn!("[presence] connect timed out (10s)");
            return SessionOutcome::Disconnected;
        }
    };

    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // 4) auth 메시지 전송
    let auth_msg = serde_json::json!({"type": "auth", "token": jwt});
    if let Err(e) = ws_tx.send(Message::Text(auth_msg.to_string())).await {
        log::warn!("[presence] send auth failed: {e}");
        return SessionOutcome::Disconnected;
    }

    log::info!("[presence] connected as device='{}', awaiting registration", device_name);

    // 5) 세션 변경 알림 채널: ipc client 가 "session-list-changed" Tauri 이벤트를
    // 발행하면 이 채널을 통해 WS 루프가 깨어나 update_sessions 를 서버로 전송.
    let (session_dirty_tx, mut session_dirty_rx) = mpsc::channel::<()>(4);
    let tx_clone = session_dirty_tx.clone();
    let listener_id = app.listen("session-list-changed", move |_| {
        let _ = tx_clone.try_send(());
    });

    // 5b) 프롬프트 변경 알림 채널: 프론트엔드가 update_remote_prompts 호출 시
    // "remote-prompts-changed" 이벤트를 발행 → loop 가 깨어나 update_prompts 를 서버로 전송.
    // 초기 push 는 handle_text 가 `presence_registered` 수신 시 동일 이벤트를
    // 재방출해서 트리거 — auth 가 거절된 WS 위에 빈 스냅샷을 흘려보내는 것을 방지.
    let (prompts_dirty_tx, mut prompts_dirty_rx) = mpsc::channel::<()>(4);
    let prompts_listener_id = app.listen("remote-prompts-changed", move |_| {
        let _ = prompts_dirty_tx.try_send(());
    });

    // 5c) 명령 완료 푸시 채널: notify 모듈이 임계값 통과 + 채널=Mobile/Both 일 때
    // "remote-task-complete" 이벤트를 발행. 각 이벤트가 고유한 elapsed_ms/exit_code 를
    // 갖기 때문에 dirty-flag 가 아닌 payload 큐로 처리한다 (coalesce 금지).
    let (task_complete_tx, mut task_complete_rx) = mpsc::channel::<String>(16);
    let task_complete_listener_id = app.listen("remote-task-complete", move |event| {
        let _ = task_complete_tx.try_send(event.payload().to_string());
    });

    // 6) 메시지 루프 + ping
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ping_interval.tick().await; // skip first immediate tick

    let outcome = loop {
        tokio::select! {
            biased;
            _ = &mut *shutdown_rx => {
                let _ = ws_tx.send(Message::Close(None)).await;
                break SessionOutcome::Shutdown;
            }
            _ = ping_interval.tick() => {
                if ws_tx.send(Message::Ping(vec![])).await.is_err() {
                    log::warn!("[presence] ping failed — connection dead");
                    break SessionOutcome::Disconnected;
                }
            }
            _ = session_dirty_rx.recv() => {
                // 연속 변경 신호를 coalesce — 최신 스냅샷 한 번만 전송.
                while session_dirty_rx.try_recv().is_ok() {}
                if let Some(sessions_json) = fetch_session_summaries(app).await {
                    log::info!("[presence] pushing update_sessions (count={})", sessions_json.len());
                    let payload = serde_json::json!({
                        "type": "update_sessions",
                        "sessions": sessions_json,
                    });
                    if ws_tx.send(Message::Text(payload.to_string())).await.is_err() {
                        log::warn!("[presence] update_sessions send failed");
                        break SessionOutcome::Disconnected;
                    }
                }
            }
            _ = prompts_dirty_rx.recv() => {
                // 연속 변경 신호 coalesce — 최신 스냅샷 한 번만 전송.
                while prompts_dirty_rx.try_recv().is_ok() {}
                // hydrated=false 인 경우 frontend 가 아직 첫 push 를 못 한 상태 —
                // 빈 배열을 broadcast 하면 모바일 캐시가 wipe 된다. skip.
                let Some(prompts) = fetch_prompts_snapshot(app).await else {
                    log::debug!("[presence] update_prompts skipped: PromptsState not yet hydrated");
                    continue;
                };
                log::info!("[presence] pushing update_prompts (count={})", prompts.len());
                let payload = serde_json::json!({
                    "type": "update_prompts",
                    "prompts": prompts,
                });
                if ws_tx.send(Message::Text(payload.to_string())).await.is_err() {
                    log::warn!("[presence] update_prompts send failed");
                    break SessionOutcome::Disconnected;
                }
            }
            Some(payload_json) = task_complete_rx.recv() => {
                // notify 모듈이 이미 알림 채널을 결정해서 보낸 payload — 그대로 forward.
                // 서버가 동일 user 의 다른 device(s)의 presence_tx 로 fan-out.
                let parsed: serde_json::Value = match serde_json::from_str(&payload_json) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("[presence] task_complete payload parse failed: {e}");
                        continue;
                    }
                };
                let mut payload = serde_json::json!({ "type": "task_complete" });
                if let Some(obj) = payload.as_object_mut() {
                    if let Some(elapsed) = parsed.get("elapsed_ms") {
                        obj.insert("elapsed_ms".into(), elapsed.clone());
                    }
                    if let Some(exit) = parsed.get("exit_code") {
                        obj.insert("exit_code".into(), exit.clone());
                    }
                }
                log::info!("[presence] pushing task_complete");
                if ws_tx.send(Message::Text(payload.to_string())).await.is_err() {
                    log::warn!("[presence] task_complete send failed");
                    break SessionOutcome::Disconnected;
                }
            }
            msg = ws_rx.next() => {
                let Some(msg) = msg else {
                    log::info!("[presence] stream ended");
                    break SessionOutcome::Disconnected;
                };
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Err(outcome) = handle_text(app, &text).await {
                            break outcome;
                        }
                    }
                    Ok(Message::Ping(p)) => {
                        let _ = ws_tx.send(Message::Pong(p)).await;
                    }
                    Ok(Message::Close(_)) => {
                        log::info!("[presence] server closed connection");
                        break SessionOutcome::Disconnected;
                    }
                    Ok(_) => {} // pong / binary — ignore
                    Err(e) => {
                        log::warn!("[presence] read error: {e}");
                        break SessionOutcome::Disconnected;
                    }
                }
            }
        }
    };

    app.unlisten(listener_id);
    app.unlisten(prompts_listener_id);
    app.unlisten(task_complete_listener_id);
    outcome
}

/// 현재 PromptsState 에 저장된 최신 스냅샷을 wire 형식으로 반환.
/// frontend 가 아직 첫 push 를 못 한 상태면 None — 호출자는 broadcast 를 skip.
async fn fetch_prompts_snapshot(app: &AppHandle) -> Option<Vec<serde_json::Value>> {
    use std::sync::atomic::Ordering;
    let state = app.state::<PromptsState>();
    if !state.hydrated.load(Ordering::Acquire) {
        return None;
    }
    let guard = state.latest.lock().await;
    Some(
        guard
            .iter()
            .map(|p| serde_json::to_value(p).unwrap_or(serde_json::Value::Null))
            .collect(),
    )
}

/// 현재 세션 목록을 IPC 서버에서 읽어 `update_sessions` 페이로드용 JSON 배열로 반환.
async fn fetch_session_summaries(app: &AppHandle) -> Option<Vec<serde_json::Value>> {
    let ipc_state = app.state::<IpcState>();
    let mut guard = ipc_state.lock().await;
    let client = guard.as_mut()?;
    match client.request(ClientMessage::ListSessions).await {
        Ok(ServerMessage::SessionList { sessions }) => Some(
            sessions
                .iter()
                .map(|s| serde_json::json!({ "name": s.name, "pane_count": s.pane_count }))
                .collect(),
        ),
        Ok(_) => {
            log::warn!("[presence] fetch_session_summaries: unexpected IPC response");
            None
        }
        Err(e) => {
            log::warn!("[presence] fetch_session_summaries: IPC error: {e}");
            None
        }
    }
}

/// 서버에서 받은 텍스트 메시지 처리. fatal 한 경우 SessionOutcome 반환.
async fn handle_text(app: &AppHandle, text: &str) -> Result<(), SessionOutcome> {
    let json: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            log::debug!("[presence] non-JSON text dropped: {e}");
            return Ok(());
        }
    };
    let ty = json.get("type").and_then(|t| t.as_str());

    match ty {
        Some("presence_registered") => {
            let id = json.get("device_id").and_then(|d| d.as_str()).unwrap_or("?");
            log::info!("[presence] registered device_id={id}");
            // Auth 확정 직후 캐시된 prompts 스냅샷을 한 번 push.
            // 재접속 케이스에서 모바일이 stale snapshot 을 보지 않도록 보장.
            if let Err(e) = app.emit("remote-prompts-changed", ()) {
                log::warn!("[presence] failed to trigger initial prompts push: {e}");
            }
            Ok(())
        }
        Some("error") => {
            let code = json.get("code").and_then(|c| c.as_str()).unwrap_or("");
            let msg = json.get("message").and_then(|m| m.as_str()).unwrap_or("");
            // 인증 실패는 backoff 후에도 같은 토큰으로 다시 거절될 가능성이 큼.
            // get_valid_access_token 이 refresh 시도 후 새 토큰을 발급하므로 disconnect 만 반환.
            log::warn!("[presence] server error: code={code} msg={msg}");
            Err(SessionOutcome::Disconnected)
        }
        Some("start_share") => {
            let req_id = json
                .get("request_id")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            log::info!("[presence] received start_share (req={req_id})");
            // IPC 호출은 시간이 걸릴 수 있으므로 별도 태스크로 발사. presence loop 는
            // 계속 다른 메시지를 수신해야 한다.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                trigger_remote_share(app, req_id).await;
            });
            Ok(())
        }
        Some("stop_share") => {
            let req_id = json
                .get("request_id")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            log::info!("[presence] received stop_share (req={req_id})");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                trigger_remote_stop(app, req_id).await;
            });
            Ok(())
        }
        Some("prompt_mutate") => {
            // 모바일이 보낸 mutation. payload 그대로 프론트엔드에 forward.
            // 서버가 이미 device_id 를 strip 했으므로 op + 관련 필드만 남는다.
            log::info!("[presence] received prompt_mutate: {json}");
            if let Err(e) = app.emit("remote-prompt-mutate", json.clone()) {
                log::warn!("[presence] failed to emit remote-prompt-mutate: {e}");
            }
            Ok(())
        }
        Some("prompt_request") => {
            // 모바일이 BacklogScreen 진입 시 fresh snapshot 을 요구. 서버는 캐시하지 않으므로
            // 데스크탑이 응답 책임. 프론트엔드에 신호만 보내면 usePromptSync 가 현재
            // store snapshot 을 update_remote_prompts 로 push → presence loop → 서버 broadcast.
            log::info!("[presence] received prompt_request");
            if let Err(e) = app.emit("remote-prompt-request", ()) {
                log::warn!("[presence] failed to emit remote-prompt-request: {e}");
            }
            Ok(())
        }
        Some(other) => {
            log::debug!("[presence] unknown message type: {other}");
            Ok(())
        }
        None => Ok(()),
    }
}

/// 모바일이 요청한 원격 공유 시작 — IPC 로 daemon 의 host loop 를 띄운다.
/// 결과는 device_registry 의 device_list_changed broadcast 로 모바일에 전파됨.
async fn trigger_remote_share(app: AppHandle, req_id: String) {
    // 데몬이 아직 안 떠 있을 수 있으므로 짧게 retry.
    let ipc_state = app.state::<IpcState>();
    let jwt = match crate::auth::get_valid_access_token(&app).await {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[presence] start_share aborted (req={req_id}): jwt error: {e}");
            return;
        }
    };
    let device_name = crate::auth::get_device_name();

    for attempt in 1..=10u32 {
        let attempt_result = {
            let mut guard = ipc_state.lock().await;
            if guard.as_ref().is_some_and(|c| c.is_connected()) {
                let client = guard.as_mut().unwrap();
                Some(
                    client
                        .request(ClientMessage::StartAccountHosting {
                            jwt: jwt.clone(),
                            device_name: device_name.clone(),
                        })
                        .await,
                )
            } else {
                None
            }
        };

        match attempt_result {
            Some(Ok(_)) => {
                log::info!("[presence] start_share succeeded (req={req_id})");
                return;
            }
            Some(Err(e)) => {
                log::warn!(
                    "[presence] start_share IPC failed (req={req_id}, attempt={attempt}): {e}"
                );
                return;
            }
            None => {
                log::debug!(
                    "[presence] start_share waiting for IPC (req={req_id}, attempt={attempt})"
                );
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }

    log::warn!(
        "[presence] start_share gave up — daemon never became ready (req={req_id})"
    );
}

/// 모바일이 요청한 원격 공유 종료 — IPC 로 daemon 의 host loop 를 중지한다.
/// device 가 sharing 중이라면 daemon 은 이미 떠 있으므로 retry 없이 한 번만 시도.
/// 결과는 host WS close → device_registry.detach_host 의 device_list_changed
/// broadcast 로 모바일에 전파됨.
async fn trigger_remote_stop(app: AppHandle, req_id: String) {
    let ipc_state = app.state::<IpcState>();
    let mut guard = ipc_state.lock().await;
    let Some(client) = guard.as_mut().filter(|c| c.is_connected()) else {
        log::warn!("[presence] stop_share aborted (req={req_id}): IPC not connected");
        return;
    };
    match client.request(ClientMessage::StopHosting).await {
        Ok(_) => {
            log::info!("[presence] stop_share succeeded (req={req_id})");
        }
        Err(e) => {
            log::warn!("[presence] stop_share IPC failed (req={req_id}): {e}");
        }
    }
}

/// `tokio_tungstenite` 의 connect 는 raw URL 을 받는데, device_name 에 공백이나
/// 재시작해도 동일한 device_id 를 유지하도록 앱 데이터 디렉터리에 UUID 를 영속 저장.
/// 파일이 없으면 새 UUID 를 생성해서 저장한다.
fn get_or_create_persistent_device_id(app: &AppHandle) -> String {
    let path: Option<PathBuf> = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("device_id.txt"));

    if let Some(ref p) = path {
        if let Ok(id) = std::fs::read_to_string(p) {
            let id = id.trim().to_string();
            if !id.is_empty() {
                return id;
            }
        }
    }

    let new_id = format!("dev_{}", uuid::Uuid::new_v4());
    if let Some(ref p) = path {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, &new_id);
    }
    log::info!("[presence] generated new persistent device_id={new_id}");
    new_id
}

/// non-ASCII 가 들어가면 query string 으로 그대로 못 넣는다. RFC 3986 기준으로
/// percent-encode (alnum + - _ . ~ 만 통과).
fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                String::from(b as char)
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_passes_through_safe_chars() {
        assert_eq!(percent_encode("Macbook-Pro_15.local"), "Macbook-Pro_15.local");
    }

    #[test]
    fn percent_encode_escapes_space() {
        assert_eq!(percent_encode("My Mac"), "My%20Mac");
    }

    #[test]
    fn percent_encode_escapes_non_ascii() {
        // 한글 (UTF-8 3바이트) — 각 바이트가 %xx 로.
        assert_eq!(percent_encode("맥"), "%EB%A7%A5");
    }
}
