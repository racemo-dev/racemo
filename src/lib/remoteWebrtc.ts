const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

export class WebRtcClient {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private dcOpenHandler: ((dc: RTCDataChannel) => void) | null = null;
  private dcMessageHandler: ((data: ArrayBuffer) => void) | null = null;
  private iceCandidateHandler: ((candidateJson: string) => void) | null = null;
  private stateChangeHandler:
    | ((state: RTCPeerConnectionState) => void)
    | null = null;
  private pendingCandidates: string[] = [];

  constructor(iceServers?: RTCIceServer[]) {
    this.pc = new RTCPeerConnection({
      iceServers: iceServers ?? DEFAULT_ICE_SERVERS,
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        const json = JSON.stringify(event.candidate.toJSON());
        this.iceCandidateHandler?.(json);
      }
    };

    this.pc.ondatachannel = (event) => {
      this.dc = event.channel;
      this.dc.binaryType = "arraybuffer";

      this.dc.onopen = () => {
        this.dcOpenHandler?.(this.dc!);
      };

      this.dc.onmessage = (msgEvent) => {
        if (msgEvent.data instanceof ArrayBuffer) {
          this.dcMessageHandler?.(msgEvent.data);
        }
      };
    };

    this.pc.onconnectionstatechange = () => {
      this.stateChangeHandler?.(this.pc.connectionState);
    };
  }

  /** Handle incoming SDP offer from host, return SDP answer. */
  async handleOffer(offerSdp: string): Promise<string> {
    await this.pc.setRemoteDescription({
      type: "offer",
      sdp: offerSdp,
    });
    // Apply any ICE candidates that arrived before setRemoteDescription
    for (const c of this.pendingCandidates) {
      const candidate = JSON.parse(c) as RTCIceCandidateInit;
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingCandidates = [];

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer.sdp!;
  }

  /** Add ICE candidate (buffers if remote description not yet set). */
  async addIceCandidate(candidateJson: string): Promise<void> {
    if (!this.pc.remoteDescription) {
      this.pendingCandidates.push(candidateJson);
      return;
    }
    const candidate = JSON.parse(candidateJson) as RTCIceCandidateInit;
    await this.pc.addIceCandidate(candidate);
  }

  /** Register ICE candidate callback. */
  onIceCandidate(handler: (candidateJson: string) => void): void {
    this.iceCandidateHandler = handler;
  }

  /** Register data channel open callback. */
  onDataChannelOpen(handler: (dc: RTCDataChannel) => void): void {
    this.dcOpenHandler = handler;
  }

  /** Register data channel message callback. */
  onDataChannelMessage(handler: (data: ArrayBuffer) => void): void {
    this.dcMessageHandler = handler;
  }

  /** Register connection state change callback. */
  onConnectionStateChange(
    handler: (state: RTCPeerConnectionState) => void
  ): void {
    this.stateChangeHandler = handler;
  }

  /** Send binary data on the data channel. */
  send(data: Uint8Array): void {
    if (this.dc?.readyState === "open") {
      const buf = new ArrayBuffer(data.byteLength);
      new Uint8Array(buf).set(data);
      this.dc.send(buf);
    }
  }

  /** Close the connection. */
  close(): void {
    this.dc?.close();
    this.pc.close();
    this.dc = null;
  }
}
