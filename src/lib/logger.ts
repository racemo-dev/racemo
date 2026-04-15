import { invoke } from "@tauri-apps/api/core";

const isDev = import.meta.env.DEV;

// Inlined to avoid circular imports (bridge.ts → webrtcClient.ts → logger.ts).
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function stringify(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

// Fire-and-forget bridge to the Rust logger so frontend logs end up in the
// same Racemo.log file as backend logs. Two safeguards prevent a failing
// invoke from feeding back into the logger:
//
// 1. A reentrancy flag skips forwarding while we are already forwarding a
//    previous message — a promise rejection that lands in console.error will
//    therefore never trigger another invoke from within this module.
// 2. Both sync throws and async promise rejections are swallowed.
let forwarding = false;
function forward(level: "debug" | "info" | "warn" | "error", args: unknown[]) {
  if (!inTauri() || forwarding) return;
  forwarding = true;
  try {
    const p = invoke("fe_log", { level, msg: stringify(args) });
    // Swallow async rejections (e.g. command not yet registered at boot).
    if (p && typeof (p as Promise<unknown>).catch === "function") {
      (p as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Swallow sync throws.
  } finally {
    forwarding = false;
  }
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (isDev) console.debug("[debug]", ...args);
    forward("debug", args);
  },
  info: (...args: unknown[]) => {
    if (isDev) console.info("[info]", ...args);
    forward("info", args);
  },
  warn: (...args: unknown[]) => {
    console.warn("[warn]", ...args);
    forward("warn", args);
  },
  error: (...args: unknown[]) => {
    console.error("[error]", ...args);
    forward("error", args);
  },
};
