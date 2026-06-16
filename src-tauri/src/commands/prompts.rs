//! Tauri commands for the Prompts feature mobile-sync pipe.
//!
//! Frontend Zustand `promptStore` is the source of truth. On every change the
//! frontend invokes `update_remote_prompts` (debounced) which:
//!   1. Stores the latest snapshot in `PromptsState`
//!   2. Emits a Tauri event `remote-prompts-changed`
//!
//! The presence WS loop listens for that event and forwards the snapshot to
//! the signaling server as an `update_prompts` message. This decoupling means
//! prompts work even when no presence WS is connected — the snapshot is just
//! held in memory until presence comes online (next push will pick it up).

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, State};

use crate::remote::prompts_state::PromptsState;
use crate::remote::signaling::PromptDto;

/// Replace the cached prompts snapshot and signal the presence loop to push.
#[tauri::command]
pub async fn update_remote_prompts(
    app: AppHandle,
    state: State<'_, PromptsState>,
    prompts: Vec<PromptDto>,
) -> Result<(), String> {
    {
        let mut guard = state.latest.lock().await;
        *guard = prompts;
    }
    // Mark hydrated AFTER the snapshot is in place — presence loop reads in the
    // opposite order (hydrated check, then snapshot lock), and Acquire/Release
    // ordering ensures it observes the new snapshot once hydrated is true.
    state.hydrated.store(true, Ordering::Release);
    // Best-effort emit — presence loop coalesces dirty signals so missed
    // emits during a transient listener gap are recovered on the next change.
    let _ = app.emit("remote-prompts-changed", ());
    Ok(())
}
