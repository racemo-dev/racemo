use std::sync::Arc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice::network_type::NetworkType;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// WebRTC connection manager wrapping webrtc-rs.
pub struct WebRtcManager {
    peer_connection: Arc<RTCPeerConnection>,
    data_channel: Option<Arc<RTCDataChannel>>,
}

impl WebRtcManager {
    /// Create a new PeerConnection with ICE servers.
    pub async fn new(ice_servers: Vec<RTCIceServer>) -> Result<Self, String> {
        let config = RTCConfiguration {
            ice_servers,
            ..Default::default()
        };

        let mut m = MediaEngine::default();
        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut m)
            .map_err(|e| e.to_string())?;

        // Restrict ICE gathering to IPv4 UDP. Background: on macOS with many
        // link-local IPv6 addresses (fe80::), webrtc-rs fails to bind them and
        // then resolves STUN hosts as IPv6-only, yielding zero srflx candidates
        // and a permanent `Checking` state. Forcing Udp4 side-steps that path.
        //
        // Also disable mDNS ICE candidates. When one Tauri process hosts AND
        // connects at the same time (self-connect loopback for debugging), both
        // WebRtcManager instances try to bind 0.0.0.0:5353 for mDNS, one fails,
        // and ICE ends up with zero candidate pairs. Disabling mDNS removes that
        // port conflict and also prevents leaking a random <uuid>.local hostname.
        let mut setting_engine = SettingEngine::default();
        setting_engine.set_network_types(vec![NetworkType::Udp4]);
        setting_engine.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);

        let api = APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .with_setting_engine(setting_engine)
            .build();

        let pc = api
            .new_peer_connection(config)
            .await
            .map_err(|e| e.to_string())?;

        Ok(Self {
            peer_connection: Arc::new(pc),
            data_channel: None,
        })
    }

    /// Default ICE servers (Google STUN + optional TURN).
    pub fn default_ice_servers() -> Vec<RTCIceServer> {
        let mut servers = vec![RTCIceServer {
            urls: vec![
                "stun:stun.l.google.com:19302".to_string(),
                "stun:stun1.l.google.com:19302".to_string(),
            ],
            ..Default::default()
        }];

        // Add TURN server if configured via environment variables.
        if let Ok(turn_url) = std::env::var("RACEMO_TURN_URL") {
            let username = std::env::var("RACEMO_TURN_USER").unwrap_or_default();
            let credential = std::env::var("RACEMO_TURN_PASS").unwrap_or_default();
            servers.push(RTCIceServer {
                urls: vec![turn_url],
                username,
                credential,
                ..Default::default()
            });
        }

        servers
    }

    /// Register connection state change callback.
    pub fn on_connection_state_change<F>(&self, callback: F)
    where
        F: Fn(webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState)
            + Send
            + Sync
            + 'static,
    {
        self.peer_connection
            .on_peer_connection_state_change(Box::new(move |state| {
                callback(state);
                Box::pin(async {})
            }));
    }

    /// Host: create Data Channel + SDP offer.
    pub async fn create_offer(&mut self) -> Result<String, String> {
        let dc = self
            .peer_connection
            .create_data_channel("terminal", None)
            .await
            .map_err(|e| e.to_string())?;
        self.data_channel = Some(dc);

        let offer = self
            .peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_local_description(offer.clone())
            .await
            .map_err(|e| e.to_string())?;

        Ok(offer.sdp)
    }

    /// Client: receive SDP offer, create answer.
    pub async fn create_answer(&mut self, offer_sdp: &str) -> Result<String, String> {
        let offer = RTCSessionDescription::offer(offer_sdp.to_string())
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_remote_description(offer)
            .await
            .map_err(|e| e.to_string())?;

        let answer = self
            .peer_connection
            .create_answer(None)
            .await
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_local_description(answer.clone())
            .await
            .map_err(|e| e.to_string())?;

        Ok(answer.sdp)
    }

    /// Set remote SDP answer (host side).
    pub async fn set_remote_answer(&self, answer_sdp: &str) -> Result<(), String> {
        let answer = RTCSessionDescription::answer(answer_sdp.to_string())
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())
    }

    /// Add an ICE candidate (trickle ICE).
    ///
    /// Both incoming and outgoing candidates are accepted as-is. Racemo's
    /// account-based connections are between devices of the same GitHub
    /// user, so there is no third-party privacy concern that would justify
    /// filtering private / loopback / mDNS candidates, and filtering them
    /// would break same-machine and same-LAN self-connects.
    pub async fn add_ice_candidate(&self, candidate_json: &str) -> Result<(), String> {
        let candidate: RTCIceCandidateInit =
            serde_json::from_str(candidate_json).map_err(|e| e.to_string())?;
        self.peer_connection
            .add_ice_candidate(candidate)
            .await
            .map_err(|e| e.to_string())
    }

    /// Register ICE candidate gathering callback.
    ///
    /// All candidate types (host / srflx / prflx / relay, IPv4 only per the
    /// SettingEngine configuration above) are forwarded to the callback
    /// without filtering — see `add_ice_candidate` for the rationale.
    pub fn on_ice_candidate<F>(&self, callback: F)
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        self.peer_connection
            .on_ice_candidate(Box::new(move |candidate| {
                // Historically this path filtered out loopback / private / mDNS
                // candidates to avoid leaking local network topology. Racemo's
                // account-based connections, however, are always between
                // devices belonging to the same GitHub user, so there is no
                // third-party privacy concern — and filtering breaks
                // same-machine and same-LAN self-connects by yielding zero
                // candidate pairs. Keep all candidates.
                if let Some(c) = candidate {
                    if let Ok(json_val) = c.to_json() {
                        if let Ok(json_str) = serde_json::to_string(&json_val) {
                            log::debug!(
                                "[webrtc] emitting ICE candidate: {}",
                                json_val.candidate
                            );
                            callback(json_str);
                        }
                    }
                }
                Box::pin(async {})
            }));
    }

    /// Register handler for incoming Data Channel (client side).
    pub fn on_data_channel<F>(&self, callback: F)
    where
        F: Fn(Arc<RTCDataChannel>) + Send + Sync + 'static,
    {
        self.peer_connection
            .on_data_channel(Box::new(move |dc| {
                callback(dc);
                Box::pin(async {})
            }));
    }

    /// Register handler for messages on the data channel.
    pub fn on_data_channel_message<F>(dc: &Arc<RTCDataChannel>, callback: F)
    where
        F: Fn(DataChannelMessage) + Send + Sync + 'static,
    {
        dc.on_message(Box::new(move |msg| {
            callback(msg);
            Box::pin(async {})
        }));
    }

    /// Send bytes on the data channel.
    pub async fn send(&self, data: &[u8]) -> Result<(), String> {
        if let Some(ref dc) = self.data_channel {
            dc.send(&bytes::Bytes::copy_from_slice(data))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Get a reference to the data channel.
    pub fn data_channel(&self) -> Option<Arc<RTCDataChannel>> {
        self.data_channel.clone()
    }

    /// Get a cloneable handle to the peer connection (for external close).
    pub fn peer_connection_handle(&self) -> Arc<RTCPeerConnection> {
        self.peer_connection.clone()
    }

    /// Close the peer connection.
    pub async fn close(&self) -> Result<(), String> {
        self.peer_connection
            .close()
            .await
            .map_err(|e| e.to_string())
    }

    /// Set the data channel (used by client side when receiving DC from host).
    pub fn set_data_channel(&mut self, dc: Arc<RTCDataChannel>) {
        self.data_channel = Some(dc);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    /// Loopback test: two local PeerConnections exchange SDP/ICE and send data over DC.
    #[tokio::test]
    async fn test_dc_loopback() {
        let ice_servers = WebRtcManager::default_ice_servers();

        // Create host and client PeerConnections
        let mut host = WebRtcManager::new(ice_servers.clone()).await.unwrap();
        let mut client = WebRtcManager::new(ice_servers).await.unwrap();

        // Collect ICE candidates
        let host_candidates: Arc<tokio::sync::Mutex<Vec<String>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let client_candidates: Arc<tokio::sync::Mutex<Vec<String>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));

        let hc = host_candidates.clone();
        host.on_ice_candidate(move |c| {
            let hc = hc.clone();
            tokio::spawn(async move { hc.lock().await.push(c); });
        });

        let cc = client_candidates.clone();
        client.on_ice_candidate(move |c| {
            let cc = cc.clone();
            tokio::spawn(async move { cc.lock().await.push(c); });
        });

        // Client: listen for incoming DC
        let received = Arc::new(AtomicBool::new(false));
        let received_clone = received.clone();
        let notify = Arc::new(Notify::new());
        let notify_clone = notify.clone();

        client.on_data_channel(move |dc| {
            let r = received_clone.clone();
            let n = notify_clone.clone();
            dc.on_message(Box::new(move |msg| {
                if msg.data.as_ref() == b"hello from host" {
                    r.store(true, Ordering::SeqCst);
                    n.notify_one();
                }
                Box::pin(async {})
            }));
        });

        // Host creates offer, client creates answer
        let offer_sdp = host.create_offer().await.unwrap();
        let answer_sdp = client.create_answer(&offer_sdp).await.unwrap();
        host.set_remote_answer(&answer_sdp).await.unwrap();

        // Wait for ICE gathering
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Exchange ICE candidates
        for c in host_candidates.lock().await.iter() {
            client.add_ice_candidate(c).await.ok();
        }
        for c in client_candidates.lock().await.iter() {
            host.add_ice_candidate(c).await.ok();
        }

        // Wait for DC to open, then send
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        host.send(b"hello from host").await.unwrap();

        // Wait for message receipt (max 5 seconds)
        tokio::select! {
            _ = notify.notified() => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {},
        }

        assert!(received.load(Ordering::SeqCst), "Client should have received the message");

        host.close().await.ok();
        client.close().await.ok();
    }
}
