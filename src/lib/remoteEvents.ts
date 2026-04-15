import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./bridge";

export async function listenRemote(
  name: string,
  handler: (payload: unknown) => void
): Promise<() => void> {
  if (isTauri()) {
    return listen(name, (e) => handler(e.payload));
  }
  const h = (e: Event) => handler((e as CustomEvent).detail);
  window.addEventListener(name, h as EventListener);
  return () => window.removeEventListener(name, h as EventListener);
}

export function emitRemote(name: string, payload: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail: payload }));
}
