import { SignalingClient } from "./remoteSignaling";
import { WebRtcClient } from "./remoteWebrtc";
import {
  loadProto,
  decodeRemoteMessage,
  encodeTerminalInput,
  encodeResizeRequest,
  encodeSessionListRequest,
  encodeSessionSelectRequest,
  encodeConnectionRequest,
  encodeSplitPaneRequest,
  encodeResizePaneRequest,
  encodeClosePaneRequest,
} from "./remoteProtobuf";
import { emitRemote } from "./remoteEvents";
import { logger } from "./logger";

class BrowserRemoteClient {
  private signalingClient: SignalingClient | null = null;
  private webRtcClient: WebRtcClient | null = null;

  async connect(signalingUrl: string, pairingCode: string): Promise<void> {
    await loadProto();

    this.signalingClient = new SignalingClient();
    this.webRtcClient = new WebRtcClient();

    const sigClient = this.signalingClient;
    const rtcClient = this.webRtcClient;

    // ICE candidate from local → send to signaling server
    rtcClient.onIceCandidate((candidateJson) => {
      sigClient.send({ type: "ice_candidate", candidate: candidateJson });
    });

    // Data channel opened
    rtcClient.onDataChannelOpen(() => {
      logger.debug("[webrtc] Data channel open");
      emitRemote("remote-client-status", { status: "connected" });
      // Send connection request and ask for session list
      rtcClient.send(encodeConnectionRequest());
      rtcClient.send(encodeSessionListRequest());
    });

    // Data channel messages
    rtcClient.onDataChannelMessage((data) => {
      const decoded = decodeRemoteMessage(data);
      switch (decoded.type) {
        case "terminal_output":
          emitRemote("remote-pty-output", {
            pane_id: decoded.ptyId,
            data: Array.from(decoded.data),
          });
          break;
        case "session_list":
          emitRemote("remote-session-list", {
            sessions: decoded.sessions.map((s) => ({
              id: s.id,
              name: s.name,
              pane_count: s.paneCount,
              created_at: s.createdAt,
              pane_ids: s.paneIds,
              layout_json: s.layout ? JSON.stringify(s.layout) : "",
            })),
          });
          break;
        case "layout_update":
          emitRemote("remote-layout-update", {
            session_id: decoded.sessionId,
            layout_json: decoded.layoutJson,
            pane_count: decoded.paneCount,
          });
          break;
        case "pty_resized":
          emitRemote("remote-pty-resized", {
            pane_id: decoded.ptyId,
            cols: decoded.cols,
            rows: decoded.rows,
          });
          break;
        case "disconnect":
          this.disconnect();
          break;
        case "heartbeat":
          // silently ignore
          break;
        default:
          break;
      }
    });

    // Connection state changes
    rtcClient.onConnectionStateChange((state) => {
      if (state === "failed" || state === "disconnected" || state === "closed") {
        emitRemote("remote-client-status", { status: "disconnected" });
      }
    });

    // Handle signaling messages
    sigClient.onMessage(async (msg) => {
      if (msg.type === "sdp_offer") {
        const answerSdp = await rtcClient.handleOffer(msg.sdp);
        sigClient.send({ type: "sdp_answer", sdp: answerSdp });
      } else if (msg.type === "ice_candidate") {
        await rtcClient.addIceCandidate(msg.candidate);
      } else if (msg.type === "error") {
        logger.error("[signaling] Error:", msg.code, msg.message);
        emitRemote("remote-client-status", {
          status: "failed",
          error: `${msg.code}: ${msg.message}`,
        });
      } else if (msg.type === "room_expired") {
        emitRemote("remote-client-status", {
          status: "failed",
          error: "Pairing code expired",
        });
      }
    });

    sigClient.onClose(() => {
      logger.debug("[signaling] WebSocket closed");
    });

    // Connect to signaling server
    // Convert ws:// or http:// to ws://
    const wsUrl = signalingUrl.replace(/^http/, "ws").replace(/^https/, "wss");
    await sigClient.connect(wsUrl, pairingCode);
  }

  disconnect(): void {
    this.signalingClient?.close();
    this.webRtcClient?.close();
    this.signalingClient = null;
    this.webRtcClient = null;
    emitRemote("remote-client-status", { status: "disconnected" });
  }

  sendInput(paneId: string, data: Uint8Array): void {
    this.webRtcClient?.send(encodeTerminalInput(paneId, data));
  }

  sendResize(paneId: string, cols: number, rows: number): void {
    this.webRtcClient?.send(encodeResizeRequest(paneId, cols, rows));
  }

  requestSessionList(): void {
    this.webRtcClient?.send(encodeSessionListRequest());
  }

  selectSession(sessionId: string): void {
    this.webRtcClient?.send(encodeSessionSelectRequest(sessionId));
  }

  sendSplitPane(
    sessionId: string,
    paneId: string,
    direction: string,
    before: boolean
  ): void {
    this.webRtcClient?.send(
      encodeSplitPaneRequest(sessionId, paneId, direction, before)
    );
  }

  sendResizePane(sessionId: string, splitId: string, ratio: number): void {
    this.webRtcClient?.send(
      encodeResizePaneRequest(sessionId, splitId, ratio)
    );
  }

  sendClosePane(sessionId: string, paneId: string): void {
    this.webRtcClient?.send(encodeClosePaneRequest(sessionId, paneId));
  }
}

let _instance: BrowserRemoteClient | null = null;

export function getBrowserRemoteClient(): BrowserRemoteClient {
  if (!_instance) {
    _instance = new BrowserRemoteClient();
  }
  return _instance;
}
