use tauri::{State, Emitter};
use crate::ipc::protocol::{ClientMessage, ServerMessage};
use crate::remote::RemoteState;
use super::{ipc, IpcState};

#[derive(serde::Serialize)]
pub struct RemoteHostInfo {
    pub pairing_code: String,
    pub status: String,
}

/// Start remote hosting via server-side WebRTC (IPC proxy).
#[tauri::command]
pub async fn start_remote_hosting(
    ipc_state: State<'_, IpcState>,
    remote_state: State<'_, RemoteState>,
) -> Result<RemoteHostInfo, String> {
    log::info!("[remote] start_remote_hosting requested");

    let client = ipc(&ipc_state).await?;
    let msg = client.request(ClientMessage::StartHosting).await?;
    match msg {
        ServerMessage::HostingStarted { pairing_code } => {
            let mut state = remote_state.lock().await;
            state.pairing_code = Some(pairing_code.clone());
            state.host_status = crate::remote::RemoteConnectionState::WaitingApproval;
            Ok(RemoteHostInfo {
                pairing_code,
                status: "waiting".to_string(),
            })
        }
        ServerMessage::Error { message, .. } => {
            log::error!("[remote] start_remote_hosting failed: {message}");
            Err(message)
        }
        _ => {
            log::error!("[remote] start_remote_hosting: unexpected response");
            Err("Unexpected response".to_string())
        }
    }
}

/// Stop remote hosting via server (IPC proxy).
#[tauri::command]
pub async fn stop_remote_hosting(
    ipc_state: State<'_, IpcState>,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    log::info!("[remote] stop_remote_hosting requested");
    let client = ipc(&ipc_state).await?;
    let msg = client.request(ClientMessage::StopHosting).await?;
    match msg {
        ServerMessage::HostingStopped => {
            log::info!("[remote] stop_remote_hosting: success");
            let mut state = remote_state.lock().await;
            state.host_status = crate::remote::RemoteConnectionState::Disconnected;
            state.pairing_code = None;
            Ok(())
        }
        ServerMessage::Error { message, .. } => {
            log::error!("[remote] stop_remote_hosting failed: {message}");
            Err(message)
        }
        _ => {
            log::info!("[remote] stop_remote_hosting: success (non-standard msg)");
            Ok(())
        }
    }
}

/// Connect to a remote host as a client (pairing mode).
/// NOTE: Pairing mode still uses single-connection semantics (disconnects existing pairing connections).
#[tauri::command]
pub async fn connect_to_remote_host(
    app_handle: tauri::AppHandle,
    pairing_code: String,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    use crate::remote::signaling::{SignalingClient, SignalingMessage};
    use crate::remote::webrtc_conn::WebRtcManager;
    use crate::remote::client::RemoteClient;

    // For pairing mode, use "__pairing__" as the virtual device_id
    let device_id = "__pairing__".to_string();
    let gen = {
        let mut state = remote_state.lock().await;
        cleanup_device_connection(&mut state, &device_id);
        state.next_gen += 1;
        state.next_gen
    };

    let remote_state_inner = remote_state.inner().clone();
    let device_id_spawn = device_id.clone();

    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let signaling_url = crate::remote::DEFAULT_SIGNALING_URL;

        // 1+2. Connect to signaling server AND create WebRTC PeerConnection in parallel
        log::info!("[remote-client] Connecting to signaling server: {signaling_url}");
        let ice_servers = WebRtcManager::default_ice_servers();
        let (signaling_result, webrtc_result) = tokio::join!(
            SignalingClient::connect(signaling_url, "client", &pairing_code, ""),
            WebRtcManager::new(ice_servers)
        );

        let mut signaling = match signaling_result {
            Ok(s) => s,
            Err(e) => {
                let err_msg = e.to_string();
                log::error!("Failed to connect to signaling server: {err_msg}");
                let _ = app_handle.emit("remote-client-status", serde_json::json!({
                    "status": "failed", "error": err_msg, "gen": gen, "device_id": device_id_spawn
                }));
                return;
            }
        };
        log::info!("[remote-client] Signaling connected, checking WebRTC...");

        let mut webrtc = match webrtc_result {
            Ok(w) => w,
            Err(e) => {
                log::error!("Failed to create WebRTC: {e}");
                let _ = app_handle.emit("remote-client-status", serde_json::json!({
                    "status": "failed", "error": e, "gen": gen, "device_id": device_id_spawn
                }));
                return;
            }
        };

        let _ = app_handle.emit("remote-client-progress", serde_json::json!({
            "step": "signaling", "label": "Connecting to relay", "elapsed_ms": started.elapsed().as_millis() as u64,
            "device_id": device_id_spawn
        }));

        // Monitor connection state
        setup_client_connection_monitor(
            &mut webrtc, remote_state_inner.clone(), app_handle.clone(), gen, "pairing", device_id_spawn.clone(),
        );

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

        // Set up DC receive handler for incoming data channel from host
        let (mut remote_client, output_rx) = RemoteClient::new();
        spawn_output_forwarder(
            app_handle.clone(), output_rx, gen, device_id_spawn.clone(),
            remote_state_inner.clone(),
        );

        // Listen for incoming data channel from host
        {
            let dc_notify = std::sync::Arc::new(tokio::sync::Notify::new());
            let dc_notify_clone = dc_notify.clone();
            let dc_holder: std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<webrtc::data_channel::RTCDataChannel>>>> =
                std::sync::Arc::new(tokio::sync::Mutex::new(None));
            let dc_holder_clone = dc_holder.clone();

            webrtc.on_data_channel(move |dc| {
                log::info!("[remote-client] on_data_channel fired, label: {}", dc.label());
                let holder = dc_holder_clone.clone();
                let notify = dc_notify_clone.clone();
                tokio::spawn(async move {
                    *holder.lock().await = Some(dc);
                    notify.notify_one();
                });
            });

            // 3. Process signaling messages (SDP offer + ICE) concurrently with DC readiness
            let dc_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                tokio::select! {
                    msg = signaling.recv() => {
                        match msg {
                            Some(SignalingMessage::SdpOffer { sdp }) => {
                                match webrtc.create_answer(&sdp).await {
                                    Ok(answer_sdp) => {
                                        let answer_msg = SignalingMessage::SdpAnswer { sdp: answer_sdp, room_code: None };
                                        if let Err(e) = signaling.send(&answer_msg) {
                                            log::error!("Failed to send answer: {e}");
                                            return;
                                        }
                                        let _ = app_handle.emit("remote-client-progress", serde_json::json!({
                                            "step": "negotiating", "label": "Peer connection",
                                            "elapsed_ms": started.elapsed().as_millis() as u64,
                                            "device_id": device_id_spawn
                                        }));
                                    }
                                    Err(e) => {
                                        log::error!("Failed to create answer: {e}");
                                        return;
                                    }
                                }
                            }
                            Some(SignalingMessage::IceCandidate { candidate, .. }) => {
                                if let Err(e) = webrtc.add_ice_candidate(&candidate).await {
                                    log::warn!("Failed to add ICE candidate: {e}");
                                }
                            }
                            Some(SignalingMessage::ConnectionResponse { approved: false, .. }) => {
                                let message = "Host rejected the connection".to_string();
                                log::warn!("[CLIENT:pairing] Connection rejected by host");
                                let _ = app_handle.emit("remote-client-status", serde_json::json!({
                                    "status": "failed", "error": message, "gen": gen, "device_id": device_id_spawn
                                }));
                                return;
                            }
                            Some(SignalingMessage::ConnectionResponse { .. }) => {}
                            Some(SignalingMessage::Error { message, .. }) => {
                                log::error!("Signaling error: {message}");
                                let _ = app_handle.emit("remote-client-status", serde_json::json!({
                                    "status": "failed", "error": message, "gen": gen, "device_id": device_id_spawn
                                }));
                                return;
                            }
                            None => {
                                log::info!("[remote-client] Signaling closed");
                                break;
                            }
                            _ => {}
                        }
                    }
                    _ = dc_notify.notified() => {
                        log::info!("[remote-client] DC notify received");
                        if let Some(dc) = dc_holder.lock().await.take() {
                            remote_client.set_data_channel(dc);
                            log::info!("[remote-client] Data channel established via notify");
                            break;
                        }
                    }
                    _ = tokio::time::sleep_until(dc_deadline) => {
                        log::error!("[remote-client] Timeout waiting for data channel (15s)");
                        let _ = app_handle.emit("remote-client-status", serde_json::json!({
                            "status": "failed", "error": "Timeout waiting for data channel",
                            "gen": gen, "device_id": device_id_spawn
                        }));
                        return;
                    }
                }

                // Also check DC holder after each signaling message
                if let Some(dc) = dc_holder.lock().await.take() {
                    remote_client.set_data_channel(dc);
                    log::info!("[remote-client] Data channel established after signaling msg");
                    break;
                }
            }
        }

        // Wait for DC to be open before sending session list request
        if remote_client.wait_dc_open(std::time::Duration::from_secs(5)).await {
            log::info!("[remote-client] DC is open, sending session list request");
        } else {
            log::warn!("[remote-client] DC did not open within 5s, sending anyway");
        }

        let _ = app_handle.emit("remote-client-progress", serde_json::json!({
            "step": "channel", "label": "Secure channel",
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "device_id": device_id_spawn
        }));

        if let Err(e) = remote_client.request_session_list().await {
            log::warn!("[remote-client] Failed to request session list: {e}");
        }

        // Finalize: store client in shared state
        finalize_client_connection(
            remote_client, webrtc, signaling,
            remote_state_inner, &app_handle, started, gen, "pairing",
            device_id_spawn,
        ).await;
    });

    Ok(())
}

/// Disconnect from a specific remote device (client mode).
/// If device_id is empty, disconnects ALL client connections.
#[tauri::command]
pub async fn disconnect_remote(
    app_handle: tauri::AppHandle,
    device_id: Option<String>,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    let mut state = remote_state.lock().await;

    let device_ids: Vec<String> = match &device_id {
        Some(id) if !id.is_empty() => vec![id.clone()],
        _ => state.clients.keys().cloned().collect(),
    };

    for did in &device_ids {
        log::info!("[CLIENT:disconnect] Disconnecting device: {did}");
        if let Some(slot) = state.clients.remove(did) {
            state.unregister_device(did);
            // Send close signals
            if let Some(stx) = slot.signaling_close_tx {
                let _ = stx.send(crate::remote::signaling::OutCmd::Close);
            }
            if let Some(tx) = slot.close_tx {
                let _ = tx.send(());
            }
            // Wait for teardown (don't hold lock — use spawn)
            if let Some(drx) = slot.close_done_rx {
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), drx).await;
                });
            }
        }
    }

    drop(state);

    for did in &device_ids {
        let _ = app_handle.emit("remote-client-status", serde_json::json!({
            "status": "disconnected", "device_id": did
        }));
    }

    Ok(())
}

/// Approve or reject a remote client connection (host mode).
#[tauri::command]
pub async fn approve_remote_client(
    app_handle: tauri::AppHandle,
    client_id: String,
    approved: bool,
    _remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    log::info!(
        "Remote client {} {}",
        client_id,
        if approved { "approved" } else { "rejected" }
    );

    if !approved {
        let _ = app_handle.emit("remote-client-rejected", serde_json::json!({
            "client_id": client_id
        }));
    }

    Ok(())
}

/// Get current remote hosting status from server (IPC proxy).
#[tauri::command]
pub async fn get_remote_status(
    ipc_state: State<'_, IpcState>,
) -> Result<serde_json::Value, String> {
    let client = ipc(&ipc_state).await?;
    let msg = client.request(ClientMessage::GetHostingStatus).await?;
    match msg {
        ServerMessage::HostingStatus { status, pairing_code } => {
            Ok(serde_json::json!({
                "status": status,
                "pairing_code": pairing_code,
            }))
        }
        ServerMessage::Error { message, .. } => Err(message),
        _ => Err("Unexpected response".to_string()),
    }
}

/// Write input to a remote host's PTY via WebRTC Data Channel (client mode).
/// Routes to the correct device connection via pane_id lookup.
#[tauri::command]
pub async fn write_to_remote_pty(
    pane_id: String,
    data: Vec<u8>,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    let state = remote_state.lock().await;
    let client = state
        .client_for_pane(&pane_id)
        .ok_or("Not connected to remote host for this pane")?;
    client.send_input(&pane_id, &data).await
}

/// Send resize request to a remote host's PTY via WebRTC Data Channel (client mode).
#[tauri::command]
pub async fn resize_remote_pty(
    pane_id: String,
    rows: u32,
    cols: u32,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    let state = remote_state.lock().await;
    let client = state
        .client_for_pane(&pane_id)
        .ok_or("Not connected to remote host for this pane")?;
    client.send_resize(&pane_id, rows, cols).await
}


/// Send resize pane (split ratio) request to a remote host via WebRTC Data Channel (client mode).
#[tauri::command]
pub async fn resize_remote_pane(
    session_id: String,
    split_id: String,
    ratio: f64,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    let state = remote_state.lock().await;
    let client = state
        .client_for_session(&session_id)
        .ok_or("Not connected to remote host for this session")?;
    client.send_resize_pane(&session_id, &split_id, ratio).await
}

/// Send split pane request to a remote host via WebRTC Data Channel (client mode).
#[tauri::command]
pub async fn split_remote_pane(
    session_id: String,
    pane_id: String,
    direction: String,
    before: bool,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    let state = remote_state.lock().await;
    let client = state
        .client_for_session(&session_id)
        .ok_or("Not connected to remote host for this session")?;
    client.send_split_pane(&session_id, &pane_id, &direction, before).await
}

/// Send close pane request to a remote host via WebRTC Data Channel (client mode).
#[tauri::command]
pub async fn close_remote_pane(
    session_id: String,
    pane_id: String,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    let state = remote_state.lock().await;
    let client = state
        .client_for_session(&session_id)
        .ok_or("Not connected to remote host for this session")?;
    client.send_close_pane(&session_id, &pane_id).await
}

/// Request the host to send the session list again (client mode).
/// If device_id is provided, requests from that specific device.
/// Otherwise requests from all connected devices.
#[tauri::command]
pub async fn request_remote_session_list(
    device_id: Option<String>,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    let state = remote_state.lock().await;
    match device_id {
        Some(did) => {
            let slot = state.clients.get(&did).ok_or("Not connected to this device")?;
            slot.client.request_session_list().await
        }
        None => {
            // Request from all connected devices
            for slot in state.clients.values() {
                let _ = slot.client.request_session_list().await;
            }
            Ok(())
        }
    }
}

/// Send an API request to the remote host (Explorer/Git/autocomplete).
/// Routes via device_id if provided, otherwise tries pane/session lookup.
#[tauri::command]
pub async fn remote_api_call(
    method: String,
    params_json: String,
    device_id: Option<String>,
    remote_state: State<'_, RemoteState>,
) -> Result<String, String> {
    let state = remote_state.lock().await;
    let client = if let Some(did) = &device_id {
        state.clients.get(did).map(|s| &s.client)
    } else {
        // Fallback: use first connected client (backward compat)
        state.clients.values().next().map(|s| &s.client)
    };
    let client = client.ok_or("Not connected to remote host")?;
    client.send_api_request(&method, &params_json).await
}

/// Approve or reject an incoming account-based connection request (host mode).
#[tauri::command]
pub async fn approve_account_connection(
    room_code: String,
    approved: bool,
    ipc_state: State<'_, IpcState>,
) -> Result<(), String> {
    let client = ipc(&ipc_state).await?;
    let msg = client
        .request(ClientMessage::ApproveAccountConnection { room_code, approved })
        .await?;
    match msg {
        ServerMessage::Ok => Ok(()),
        ServerMessage::Error { message, .. } => Err(message),
        _ => Ok(()),
    }
}

/// Start account-based hosting via IPC proxy to daemon.
#[tauri::command]
pub async fn start_account_hosting(
    app_handle: tauri::AppHandle,
    ipc_state: State<'_, IpcState>,
) -> Result<(), String> {
    let jwt = crate::auth::get_valid_access_token(&app_handle).await?;
    let device_name = crate::auth::get_device_name();

    log::info!("[remote] start_account_hosting requested");
    let client = ipc(&ipc_state).await?;
    let msg = client
        .request(ClientMessage::StartAccountHosting {
            jwt,
            device_name,
        })
        .await?;

    match msg {
        ServerMessage::Ok => {
            log::info!("[remote] start_account_hosting: success");
            Ok(())
        }
        ServerMessage::Error { message, .. } => {
            log::error!("[remote] start_account_hosting failed: {message}");
            Err(message)
        }
        _ => {
            log::error!("[remote] start_account_hosting: unexpected response");
            Err("Unexpected response".to_string())
        }
    }
}

/// Set up WebRTC connection state monitoring for client-mode connections.
fn setup_client_connection_monitor(
    webrtc: &mut crate::remote::webrtc_conn::WebRtcManager,
    remote_state_inner: std::sync::Arc<tokio::sync::Mutex<crate::remote::RemoteHostingState>>,
    app_handle: tauri::AppHandle,
    gen: u64,
    log_prefix: &'static str,
    device_id: String,
) {
    let rs = remote_state_inner;
    let ah = app_handle;
    let did = device_id;
    webrtc.on_connection_state_change(move |state| {
        use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
        log::info!("[CLIENT:conn-state:{log_prefix}] WebRTC state changed -> {state:?} (gen={gen}, device={did})");
        match state {
            RTCPeerConnectionState::Connected => {
                let rs = rs.clone();
                let ah = ah.clone();
                let did = did.clone();
                tokio::spawn(async move {
                    let s = rs.lock().await;
                    if !s.clients.get(&did).is_some_and(|slot| slot.gen == gen) { return; }
                    let _ = ah.emit("remote-client-status", serde_json::json!({
                        "status": "connected", "gen": gen, "device_id": did
                    }));
                });
            }
            RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed => {
                let rs = rs.clone();
                let ah = ah.clone();
                let did = did.clone();
                tokio::spawn(async move {
                    let s = rs.lock().await;
                    if !s.clients.get(&did).is_some_and(|slot| slot.gen == gen) {
                        log::info!("[CLIENT:conn-state:{log_prefix}] ignoring stale WebRTC {state:?} (gen {gen})");
                        return;
                    }
                    log::warn!("[CLIENT:conn-state:{log_prefix}] WebRTC {state:?} — connection lost (device={did})");
                    let _ = ah.emit("remote-client-status", serde_json::json!({
                        "status": "failed", "error": "Connection lost", "gen": gen, "device_id": did
                    }));
                });
            }
            _ => {}
        }
    });
}

/// Spawn the output forwarding task that emits remote events to the Tauri app.
/// Includes device_id in all events and updates pane/session mappings in state.
fn spawn_output_forwarder(
    app_handle: tauri::AppHandle,
    mut output_rx: tokio::sync::mpsc::UnboundedReceiver<crate::remote::client::RemoteOutput>,
    gen: u64,
    device_id: String,
    remote_state: std::sync::Arc<tokio::sync::Mutex<crate::remote::RemoteHostingState>>,
) {
    tokio::spawn(async move {
        while let Some(output) = output_rx.recv().await {
            match output {
                crate::remote::client::RemoteOutput::TerminalOutput { pty_id, data } => {
                    let _ = app_handle.emit("remote-pty-output", serde_json::json!({
                        "pane_id": pty_id, "data": data, "device_id": device_id,
                    }));
                }
                crate::remote::client::RemoteOutput::SessionList { sessions } => {
                    // Update pane/session → device mappings
                    {
                        let mut state = remote_state.lock().await;
                        state.register_device_sessions(&device_id, &sessions);
                    }
                    let _ = app_handle.emit("remote-session-list", serde_json::json!({
                        "sessions": sessions, "device_id": device_id,
                    }));
                    for session in &sessions {
                        for pane_id in &session.pane_ids {
                            let _ = app_handle.emit("remote-pty-output", serde_json::json!({
                                "pane_id": pane_id, "data": [], "device_id": device_id,
                            }));
                        }
                    }
                }
                crate::remote::client::RemoteOutput::Heartbeat { .. } => {}
                crate::remote::client::RemoteOutput::LayoutUpdate { session_id, layout_json, pane_count } => {
                    // Parse pane_ids from layout and register them
                    if let Ok(layout) = serde_json::from_str::<serde_json::Value>(&layout_json) {
                        let pane_ids = extract_pane_ids_from_layout(&layout);
                        if !pane_ids.is_empty() {
                            let mut state = remote_state.lock().await;
                            state.session_to_device.insert(session_id.clone(), device_id.clone());
                            state.register_layout_panes(&device_id, &pane_ids);
                        }
                    }
                    let _ = app_handle.emit("remote-layout-update", serde_json::json!({
                        "session_id": session_id, "layout_json": layout_json,
                        "pane_count": pane_count, "device_id": device_id,
                    }));
                }
                crate::remote::client::RemoteOutput::PtyResized { pty_id, rows, cols } => {
                    let _ = app_handle.emit("remote-pty-resized", serde_json::json!({
                        "pane_id": pty_id, "rows": rows, "cols": cols,
                    }));
                }
                crate::remote::client::RemoteOutput::Disconnected { reason } => {
                    let _ = app_handle.emit("remote-client-status", serde_json::json!({
                        "status": "failed", "error": reason, "gen": gen, "device_id": device_id,
                    }));
                }
            }
        }
    });
}

/// Extract pane/pty IDs from a layout JSON tree.
fn extract_pane_ids_from_layout(layout: &serde_json::Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(pty_id) = layout.get("ptyId").and_then(|v| v.as_str()) {
        ids.push(pty_id.to_string());
    }
    if let Some(children) = layout.get("children").and_then(|v| v.as_array()) {
        for child in children {
            ids.extend(extract_pane_ids_from_layout(child));
        }
    }
    // Also check "first" and "second" for split layouts
    if let Some(first) = layout.get("first") {
        ids.extend(extract_pane_ids_from_layout(first));
    }
    if let Some(second) = layout.get("second") {
        ids.extend(extract_pane_ids_from_layout(second));
    }
    ids
}

/// Emit a client failure status.
async fn emit_client_failure(
    app_handle: &tauri::AppHandle,
    gen: u64,
    device_id: &str,
    message: String,
) {
    let _ = app_handle.emit("remote-client-status", serde_json::json!({
        "status": "failed", "error": message, "gen": gen, "device_id": device_id
    }));
}

/// Clean up a specific device connection from the state (without sending close signals).
fn cleanup_device_connection(
    state: &mut crate::remote::RemoteHostingState,
    device_id: &str,
) {
    if let Some(slot) = state.clients.remove(device_id) {
        state.unregister_device(device_id);
        if let Some(stx) = slot.signaling_close_tx {
            let _ = stx.send(crate::remote::signaling::OutCmd::Close);
        }
        if let Some(tx) = slot.close_tx {
            let _ = tx.send(());
        }
    }
}

/// Wait for DC open + SDP/ICE negotiation loop for account-based client connection.
/// Returns `true` if the data channel was established, `false` on failure/timeout.
#[allow(clippy::too_many_arguments)]
async fn negotiate_account_dc(
    signaling: &mut crate::remote::signaling::SignalingClient,
    webrtc: &mut crate::remote::webrtc_conn::WebRtcManager,
    remote_client: &mut crate::remote::client::RemoteClient,
    app_handle: &tauri::AppHandle,
    started: std::time::Instant,
    gen: u64,
    log_prefix: &str,
    device_id: &str,
) -> bool {
    use crate::remote::signaling::SignalingMessage;

    let dc_notify = std::sync::Arc::new(tokio::sync::Notify::new());
    let dc_notify_clone = dc_notify.clone();
    let dc_holder: std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<webrtc::data_channel::RTCDataChannel>>>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(None));
    let dc_holder_clone = dc_holder.clone();

    webrtc.on_data_channel(move |dc| {
        let holder = dc_holder_clone.clone();
        let notify = dc_notify_clone.clone();
        tokio::spawn(async move {
            *holder.lock().await = Some(dc);
            notify.notify_one();
        });
    });

    let dc_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        tokio::select! {
            msg = signaling.recv() => {
                match msg {
                    Some(SignalingMessage::SdpOffer { sdp }) => {
                        match webrtc.create_answer(&sdp).await {
                            Ok(answer_sdp) => {
                                let answer_msg = SignalingMessage::SdpAnswer { sdp: answer_sdp, room_code: None };
                                if let Err(e) = signaling.send(&answer_msg) {
                                    log::error!("[{log_prefix}] Failed to send answer: {e}");
                                    return false;
                                }
                                let _ = app_handle.emit("remote-client-progress", serde_json::json!({
                                    "step": "negotiating", "label": "Peer connection",
                                    "elapsed_ms": started.elapsed().as_millis() as u64,
                                    "device_id": device_id,
                                }));
                            }
                            Err(e) => {
                                log::error!("[{log_prefix}] Failed to create answer: {e}");
                                return false;
                            }
                        }
                    }
                    Some(SignalingMessage::IceCandidate { candidate, .. }) => {
                        if let Err(e) = webrtc.add_ice_candidate(&candidate).await {
                            log::warn!("[{log_prefix}] Failed to add ICE: {e}");
                        }
                    }
                    Some(SignalingMessage::ConnectionResponse { approved: false, .. }) => {
                        let message = "Host rejected the connection (client limit reached)".to_string();
                        log::warn!("[CLIENT:{log_prefix}] Connection rejected by host: {message}");
                        let _ = app_handle.emit("remote-client-status", serde_json::json!({
                            "status": "failed", "error": message, "gen": gen, "device_id": device_id
                        }));
                        return false;
                    }
                    Some(SignalingMessage::ConnectionResponse { .. }) => {}
                    Some(SignalingMessage::Error { message, .. }) => {
                        let _ = app_handle.emit("remote-client-status", serde_json::json!({
                            "status": "failed", "error": message, "gen": gen, "device_id": device_id
                        }));
                        return false;
                    }
                    None => {
                        log::info!("[{log_prefix}] Signaling closed");
                        break;
                    }
                    _ => {}
                }
            }
            _ = dc_notify.notified() => {
                if let Some(dc) = dc_holder.lock().await.take() {
                    remote_client.set_data_channel(dc);
                    log::info!("[{log_prefix}] Data channel established");
                    return true;
                }
            }
            _ = tokio::time::sleep_until(dc_deadline) => {
                log::error!("[{log_prefix}] Timeout waiting for data channel");
                let _ = app_handle.emit("remote-client-status", serde_json::json!({
                    "status": "failed", "error": "Timeout waiting for data channel",
                    "gen": gen, "device_id": device_id
                }));
                return false;
            }
        }

        if let Some(dc) = dc_holder.lock().await.take() {
            remote_client.set_data_channel(dc);
            log::info!("[{log_prefix}] Data channel established after msg");
            return true;
        }
    }
    false
}

/// Finalize the client connection: store in clients map, wait for close signal, teardown.
#[allow(clippy::too_many_arguments)]
async fn finalize_client_connection(
    remote_client: crate::remote::client::RemoteClient,
    webrtc: crate::remote::webrtc_conn::WebRtcManager,
    signaling: crate::remote::signaling::SignalingClient,
    remote_state_inner: std::sync::Arc<tokio::sync::Mutex<crate::remote::RemoteHostingState>>,
    app_handle: &tauri::AppHandle,
    started: std::time::Instant,
    gen: u64,
    log_prefix: &str,
    device_id: String,
) {
    let _ = app_handle.emit("remote-client-progress", serde_json::json!({
        "step": "channel", "label": "Secure channel",
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "device_id": device_id,
    }));

    let pc_handle = webrtc.peer_connection_handle();
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let signaling_tx = signaling.raw_tx();

    {
        let mut s = remote_state_inner.lock().await;
        // Check if this device's slot still expects this gen
        if s.clients.get(&device_id).is_some_and(|slot| slot.gen != gen) {
            log::info!("[CLIENT:{log_prefix}] ignoring stale connection complete (gen {gen})");
            return;
        }
        let slot = crate::remote::ClientSlot {
            client: remote_client,
            close_tx: Some(close_tx),
            signaling_close_tx: Some(signaling_tx),
            close_done_rx: Some(done_rx),
            gen,
        };
        s.clients.insert(device_id.clone(), slot);
    }
    log::info!("[CLIENT:{log_prefix}] Connected successfully (gen={gen}, device={device_id})");
    let _ = app_handle.emit("remote-client-status", serde_json::json!({
        "status": "connected", "gen": gen, "device_id": device_id
    }));

    let _ = close_rx.await;
    drop(signaling);
    log::info!("[CLIENT:close:{log_prefix}] Close signal received, closing PeerConnection (device={device_id})");
    if let Err(e) = pc_handle.close().await {
        log::error!("[CLIENT:close:{log_prefix}] PeerConnection close failed: {e}");
    } else {
        log::info!("[CLIENT:close:{log_prefix}] PeerConnection closed successfully");
    }
    let _ = done_tx.send(());
}

/// Connect to a specific device (account-based) via real WebRTC (client mode).
/// Does NOT disconnect existing connections — supports multi-connection.
#[tauri::command]
pub async fn connect_to_device_account(
    app_handle: tauri::AppHandle,
    device_id: String,
    remote_state: State<'_, RemoteState>,
) -> Result<(), String> {
    use crate::remote::signaling::{SignalingClient, SignalingMessage};
    use crate::remote::webrtc_conn::WebRtcManager;
    use crate::remote::client::RemoteClient;

    let jwt = crate::auth::get_valid_access_token(&app_handle).await?;

    let gen = {
        let mut state = remote_state.lock().await;
        // Only clean up the SAME device if reconnecting
        cleanup_device_connection(&mut state, &device_id);
        state.next_gen += 1;
        state.next_gen
    };

    let remote_state_inner = remote_state.inner().clone();
    let extra_params = format!("&target_device={device_id}");
    let device_id_spawn = device_id.clone();

    // Emit connecting status
    let _ = app_handle.emit("remote-client-status", serde_json::json!({
        "status": "connecting", "device_id": device_id, "gen": gen
    }));

    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let signaling_url = crate::remote::DEFAULT_SIGNALING_URL;

        // 1. Connect to signaling server
        log::info!("[remote-client-acct] Connecting to signaling: {signaling_url} (device={device_id_spawn})");
        let mut signaling = match SignalingClient::connect_with_token(
            signaling_url, "client", &jwt, &extra_params,
        ).await {
            Ok(s) => s,
            Err(e) => {
                let err_msg = e.to_string();
                log::error!("[remote-client-acct] Connect failed: {err_msg}");
                emit_client_failure(&app_handle, gen, &device_id_spawn, err_msg).await;
                return;
            }
        };

        let _ = app_handle.emit("remote-client-progress", serde_json::json!({
            "step": "signaling", "label": "Connecting to relay",
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "device_id": device_id_spawn,
        }));

        // 2. Wait for ConnectingToDevice AND create WebRTC PeerConnection in parallel
        let ice_servers = WebRtcManager::default_ice_servers();
        let (connecting_result, webrtc_result) = tokio::join!(
            async {
                tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    async {
                        loop {
                            match signaling.recv().await {
                                Some(SignalingMessage::ConnectingToDevice { .. }) => {
                                    log::info!("[remote-client-acct] Received ConnectingToDevice");
                                    return Ok::<(), String>(());
                                }
                                Some(SignalingMessage::Error { message, .. }) => {
                                    return Err(message);
                                }
                                None => {
                                    return Err("Signaling closed before device routing".to_string());
                                }
                                _ => {}
                            }
                        }
                    }
                ).await
            },
            WebRtcManager::new(ice_servers)
        );

        match connecting_result {
            Ok(Ok(())) => {
                let _ = app_handle.emit("remote-client-progress", serde_json::json!({
                    "step": "routing", "label": "Routing to device",
                    "elapsed_ms": started.elapsed().as_millis() as u64,
                    "device_id": device_id_spawn,
                }));
            }
            Ok(Err(message)) => {
                emit_client_failure(&app_handle, gen, &device_id_spawn, message).await;
                return;
            }
            Err(_) => {
                emit_client_failure(&app_handle, gen, &device_id_spawn,
                    "Timeout waiting for device routing (10s)".to_string()).await;
                return;
            }
        }

        let mut webrtc = match webrtc_result {
            Ok(w) => w,
            Err(e) => {
                log::error!("[remote-client-acct] Failed to create WebRTC: {e}");
                emit_client_failure(&app_handle, gen, &device_id_spawn, e).await;
                return;
            }
        };

        // 3. Monitor connection state
        setup_client_connection_monitor(
            &mut webrtc, remote_state_inner.clone(), app_handle.clone(), gen, "acct",
            device_id_spawn.clone(),
        );

        // 4. ICE candidate forwarding
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

        // 5. Set up DC receive handler
        let (mut remote_client, output_rx) = RemoteClient::new();
        spawn_output_forwarder(
            app_handle.clone(), output_rx, gen, device_id_spawn.clone(),
            remote_state_inner.clone(),
        );

        // 6. Negotiate DC (SDP/ICE + wait for data channel)
        if !negotiate_account_dc(
            &mut signaling, &mut webrtc, &mut remote_client,
            &app_handle, started, gen, "remote-client-acct",
            &device_id_spawn,
        ).await {
            return;
        }

        // 7. Wait for DC open
        if remote_client.wait_dc_open(std::time::Duration::from_secs(5)).await {
            log::info!("[remote-client-acct] DC is open (device={device_id_spawn})");
        } else {
            log::warn!("[remote-client-acct] DC did not open within 5s, sending anyway");
        }

        if let Err(e) = remote_client.request_session_list().await {
            log::warn!("[remote-client-acct] Failed to request session list: {e}");
        }

        // 8. Finalize connection
        finalize_client_connection(
            remote_client, webrtc, signaling,
            remote_state_inner, &app_handle, started, gen, "acct",
            device_id_spawn,
        ).await;
    });

    Ok(())
}

