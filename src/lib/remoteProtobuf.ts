import protobuf from "protobufjs";
import { logger } from "./logger";

let RemoteMessage: protobuf.Type;
let loaded = false;

/** Load the proto definition (once). */
export async function loadProto(): Promise<void> {
  if (loaded) return;
  const root = await protobuf.load("/remote.proto");
  RemoteMessage = root.lookupType("racemo.remote.RemoteMessage");
  loaded = true;
}

/** Encode a TerminalInput message. */
export function encodeTerminalInput(
  ptyId: string,
  data: Uint8Array
): Uint8Array {
  const msg = RemoteMessage.create({
    terminalInput: { ptyId, data },
  });
  return RemoteMessage.encode(msg).finish();
}

/** Encode a ResizeRequest message. */
export function encodeResizeRequest(
  ptyId: string,
  cols: number,
  rows: number
): Uint8Array {
  const msg = RemoteMessage.create({
    resizeRequest: { ptyId, cols, rows },
  });
  return RemoteMessage.encode(msg).finish();
}

/** Encode a SessionListRequest message. */
export function encodeSessionListRequest(): Uint8Array {
  const msg = RemoteMessage.create({
    sessionListRequest: {},
  });
  return RemoteMessage.encode(msg).finish();
}

/** Encode a SessionSelectRequest message. */
export function encodeSessionSelectRequest(sessionId: string): Uint8Array {
  const msg = RemoteMessage.create({
    sessionSelect: { sessionId },
  });
  return RemoteMessage.encode(msg).finish();
}

/** Encode a ConnectionRequest message. */
export function encodeConnectionRequest(): Uint8Array {
  const clientId = crypto.randomUUID();
  const msg = RemoteMessage.create({
    connectionRequest: { clientName: "browser", clientId },
  });
  return RemoteMessage.encode(msg).finish();
}

/** Encode a SplitPaneRequest message. */
export function encodeSplitPaneRequest(
  sessionId: string,
  paneId: string,
  direction: string,
  before: boolean
): Uint8Array {
  const msg = RemoteMessage.create({
    splitPaneRequest: { sessionId, paneId, direction, before },
  });
  return RemoteMessage.encode(msg).finish();
}

/** Encode a ResizePaneRequest message (split ratio adjustment). */
export function encodeResizePaneRequest(
  sessionId: string,
  splitId: string,
  ratio: number
): Uint8Array {
  const msg = RemoteMessage.create({
    resizePaneRequest: { sessionId, splitId, ratio },
  });
  return RemoteMessage.encode(msg).finish();
}

/** Encode a ClosePaneRequest message. */
export function encodeClosePaneRequest(
  sessionId: string,
  paneId: string
): Uint8Array {
  const msg = RemoteMessage.create({
    closePaneRequest: { sessionId, paneId },
  });
  return RemoteMessage.encode(msg).finish();
}

export interface PaneLeaf {
  type: "leaf";
  id: string;
  ptyId: string;
}

export interface PaneSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface SessionInfo {
  id: string;
  name: string;
  paneCount: number;
  createdAt: number;
  paneIds: string[];
  layout: PaneNode | null;
}

type Long = { toNumber(): number };

export type DecodedMessage =
  | { type: "terminal_output"; ptyId: string; data: Uint8Array }
  | { type: "session_list"; sessions: SessionInfo[] }
  | { type: "heartbeat"; timestamp: number }
  | { type: "disconnect"; reason: string }
  | { type: "layout_update"; sessionId: string; layoutJson: string; paneCount: number }
  | { type: "split_pane_request"; sessionId: string; paneId: string; direction: string; before: boolean }
  | { type: "close_pane_request"; sessionId: string; paneId: string }
  | { type: "connection_response"; approved: boolean; hostName: string; error: string }
  | { type: "pty_resized"; ptyId: string; cols: number; rows: number }
  | { type: "unknown" };

/** Decode a RemoteMessage from binary. */
export function decodeRemoteMessage(data: ArrayBuffer): DecodedMessage {
  const bytes = new Uint8Array(data);
  const msg = RemoteMessage.decode(bytes) as protobuf.Message & {
    terminalOutput?: { ptyId: string; data: Uint8Array };
    sessionListResponse?: {
      sessions: Array<{
        id: string;
        name: string;
        paneCount: number;
        createdAt: number | Long;
        paneIds: string[];
        layoutJson: string;
      }>;
    };
    heartbeat?: { timestamp: number | Long };
    disconnect?: { reason: string };
    layoutUpdate?: { sessionId: string; layoutJson: string; paneCount: number };
    splitPaneRequest?: { sessionId: string; paneId: string; direction: string; before: boolean };
    closePaneRequest?: { sessionId: string; paneId: string };
    connectionResponse?: { approved: boolean; hostName: string; error: string };
    ptyResized?: { ptyId: string; cols: number; rows: number };
  };

  if (msg.terminalOutput) {
    return {
      type: "terminal_output",
      ptyId: msg.terminalOutput.ptyId,
      data:
        msg.terminalOutput.data instanceof Uint8Array
          ? msg.terminalOutput.data
          : new Uint8Array(msg.terminalOutput.data),
    };
  }
  if (msg.sessionListResponse) {
    return {
      type: "session_list",
      sessions: (msg.sessionListResponse.sessions ?? []).map((s: {
        id: string;
        name: string;
        paneCount: number;
        createdAt: number | Long;
        paneIds: string[];
        layoutJson: string;
      }) => {
        let layout: PaneNode | null = null;
        if (s.layoutJson) {
          try { layout = JSON.parse(s.layoutJson); } catch (e) { logger.warn("[remoteProtobuf:parseLayout] failed:", e); }
        }
        return {
          id: s.id,
          name: s.name,
          paneCount: s.paneCount,
          createdAt: typeof s.createdAt === "number" ? s.createdAt : s.createdAt.toNumber(),
          paneIds: s.paneIds ?? [],
          layout,
        };
      }),
    };
  }
  if (msg.heartbeat) {
    const ts = msg.heartbeat.timestamp;
    return {
      type: "heartbeat",
      timestamp: typeof ts === "number" ? ts : ts.toNumber(),
    };
  }
  if (msg.disconnect) {
    return { type: "disconnect", reason: msg.disconnect.reason };
  }
  if (msg.layoutUpdate) {
    return {
      type: "layout_update",
      sessionId: msg.layoutUpdate.sessionId,
      layoutJson: msg.layoutUpdate.layoutJson,
      paneCount: msg.layoutUpdate.paneCount,
    };
  }
  if (msg.splitPaneRequest) {
    return {
      type: "split_pane_request",
      sessionId: msg.splitPaneRequest.sessionId,
      paneId: msg.splitPaneRequest.paneId,
      direction: msg.splitPaneRequest.direction,
      before: msg.splitPaneRequest.before,
    };
  }
  if (msg.closePaneRequest) {
    return {
      type: "close_pane_request",
      sessionId: msg.closePaneRequest.sessionId,
      paneId: msg.closePaneRequest.paneId,
    };
  }
  if (msg.ptyResized) {
    return {
      type: "pty_resized",
      ptyId: msg.ptyResized.ptyId,
      cols: msg.ptyResized.cols,
      rows: msg.ptyResized.rows,
    };
  }
  if (msg.connectionResponse) {
    return {
      type: "connection_response",
      approved: msg.connectionResponse.approved,
      hostName: msg.connectionResponse.hostName,
      error: msg.connectionResponse.error,
    };
  }
  return { type: "unknown" };
}
