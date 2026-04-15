import { logger } from "./logger";

export type SignalingMessage =
  | { type: "room_created"; room_id: string }
  | { type: "peer_joined"; peer_id: string }
  | { type: "sdp_offer"; sdp: string }
  | { type: "sdp_answer"; sdp: string }
  | { type: "ice_candidate"; candidate: string }
  | { type: "error"; code: string; message: string }
  | { type: "room_expired" };

export class SignalingClient {
  private ws: WebSocket | null = null;
  private messageHandler: ((msg: SignalingMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  /** Connect to signaling server as client role. */
  connect(url: string, pairingCode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${url}/ws?role=client&code=${pairingCode}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => resolve();

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as SignalingMessage;
          this.messageHandler?.(msg);
        } catch {
          logger.warn("[signaling] Failed to parse message:", event.data);
        }
      };

      this.ws.onerror = () => {
        reject(new Error("WebSocket connection failed"));
      };

      this.ws.onclose = () => {
        this.closeHandler?.();
      };
    });
  }

  /** Send a signaling message (JSON). */
  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Register message handler. */
  onMessage(handler: (msg: SignalingMessage) => void): void {
    this.messageHandler = handler;
  }

  /** Register close handler. */
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
