import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePromptStore } from "../stores/promptStore";
import type { Prompt } from "../types/prompts";
import { logger } from "../lib/logger";

const DEBOUNCE_MS = 100;

interface PromptDtoWire {
  id: string;
  text: string;
  status: "pending" | "done";
  created_at: number;
  completed_at?: number;
}

function toWire(p: Prompt): PromptDtoWire {
  const out: PromptDtoWire = {
    id: p.id,
    text: p.text,
    status: p.status === "done" ? "done" : "pending",
    created_at: p.createdAt,
  };
  if (p.completedAt !== undefined) out.completed_at = p.completedAt;
  return out;
}

function fromWire(w: PromptDtoWire): Prompt {
  const p: Prompt = {
    id: w.id,
    text: w.text,
    status: w.status,
    createdAt: w.created_at,
  };
  if (w.completed_at !== undefined) p.completedAt = w.completed_at;
  return p;
}

interface MutatePayload {
  op: "add" | "update" | "remove" | "toggle";
  prompt?: PromptDtoWire;
  prompt_id?: string;
  text?: string;
}

/**
 * Apply a server-pushed mutation (originating from a paired mobile client).
 * The store change triggered here flows through the normal subscribe path and
 * results in `update_remote_prompts` being invoked, which pushes the resulting
 * snapshot to the signaling server. The server forwards the snapshot to all
 * paired mobile clients (including the originating mobile, idempotently). No
 * loop occurs because the server never echoes pushes back to the desktop.
 */
function applyMutation(payload: MutatePayload): void {
  const store = usePromptStore.getState();
  switch (payload.op) {
    case "add": {
      if (!payload.prompt?.id || !payload.prompt.text) return;
      // Preserve mobile-supplied id so the optimistic mobile row reconciles
      // when the server broadcasts the resulting `prompts_updated` snapshot.
      const incoming = fromWire(payload.prompt);
      usePromptStore.setState((s) => ({
        prompts: [incoming, ...s.prompts.filter((p) => p.id !== incoming.id)],
      }));
      return;
    }
    case "update": {
      if (!payload.prompt_id || payload.text === undefined) return;
      store.updatePrompt(payload.prompt_id, payload.text);
      return;
    }
    case "remove": {
      if (!payload.prompt_id) return;
      store.removePrompt(payload.prompt_id);
      return;
    }
    case "toggle": {
      if (!payload.prompt_id) return;
      store.toggleDone(payload.prompt_id);
      return;
    }
  }
}

/**
 * Wires the local promptStore to the desktop backend's mobile-sync pipe.
 *
 * Outbound: subscribes to store changes, debounces, and forwards the latest
 * snapshot to `update_remote_prompts` (which then pushes via presence WS).
 *
 * Inbound:
 *   - `remote-prompt-mutate` — mobile-originated CRUD ops applied to the store.
 *   - `remote-prompt-request` — mobile BacklogScreen entry; we re-push the
 *     current snapshot so the signaling server broadcasts it back to the
 *     requesting mobile. The server does NOT cache prompts (desktop's
 *     localStorage is the single source of truth).
 */
export function usePromptSync(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const push = (prompts: Prompt[]) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (cancelled) return;
        const wire = prompts.map(toWire);
        invoke("update_remote_prompts", { prompts: wire }).catch(logger.error);
      }, DEBOUNCE_MS);
    };

    const pushImmediate = (prompts: Prompt[]) => {
      if (timer) clearTimeout(timer);
      const wire = prompts.map(toWire);
      invoke("update_remote_prompts", { prompts: wire }).catch(logger.error);
    };

    const unsubStore = usePromptStore.subscribe((state, prev) => {
      if (state.prompts === prev.prompts) return;
      push(state.prompts);
    });

    let unlistenMutate: (() => void) | undefined;
    listen<MutatePayload>("remote-prompt-mutate", (event) => {
      if (cancelled) return;
      logger.info("[usePromptSync] remote-prompt-mutate received", event.payload);
      try {
        applyMutation(event.payload);
        logger.info("[usePromptSync] mutation applied", event.payload.op);
      } catch (e) {
        logger.error("[usePromptSync] mutation failed", e);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenMutate = fn;
      })
      .catch(logger.error);

    // Respond once hydration is known to be complete. If a prompt_request
    // arrives during the boot window before localStorage has been replayed
    // into the store, getState() returns the initial empty array and we'd
    // broadcast that empty snapshot to mobile — wiping the visible list.
    const respondWithCurrentSnapshot = () => {
      pushImmediate(usePromptStore.getState().prompts);
    };
    const respondWhenHydrated = () => {
      // `persist` typing on zustand v4: hasHydrated / onFinishHydration are
      // optional helpers exposed on the store. Defensive guards keep this
      // working even on older zustand minor versions.
      const persistApi = (usePromptStore as unknown as {
        persist?: {
          hasHydrated?: () => boolean;
          onFinishHydration?: (cb: () => void) => () => void;
        };
      }).persist;
      if (!persistApi || persistApi.hasHydrated?.() !== false) {
        respondWithCurrentSnapshot();
        return;
      }
      logger.info("[usePromptSync] prompt_request deferred until hydration");
      const unsub = persistApi.onFinishHydration?.(() => {
        if (cancelled) return;
        logger.info("[usePromptSync] hydration complete → pushing snapshot");
        respondWithCurrentSnapshot();
        unsub?.();
      });
    };

    let unlistenRequest: (() => void) | undefined;
    listen("remote-prompt-request", () => {
      if (cancelled) return;
      logger.info("[usePromptSync] remote-prompt-request received");
      respondWhenHydrated();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenRequest = fn;
      })
      .catch(logger.error);

    return () => {
      cancelled = true;
      unsubStore();
      unlistenMutate?.();
      unlistenRequest?.();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
