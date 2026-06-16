//! Latest prompts snapshot pushed from the frontend. The presence WS loop
//! reads this on the "remote-prompts-changed" Tauri event and forwards it to
//! the signaling server as an `update_prompts` message.
//!
//! Source of truth lives in the frontend's Zustand `promptStore` (localStorage
//! persisted). This state is purely a hand-off buffer for the WS push pipe —
//! we never modify it from inside Rust except by overwriting on push.
//!
//! `hydrated` distinguishes "user has no prompts" (legitimate empty Vec) from
//! "frontend has not yet pushed its first snapshot" (cold-boot before
//! `usePromptSync` mounts and invokes `update_remote_prompts`). The presence
//! loop must not broadcast `update_prompts: []` in the latter case — that
//! would wipe paired mobile clients' caches with a stale empty.

use std::sync::atomic::AtomicBool;
use tokio::sync::Mutex;

use crate::remote::signaling::PromptDto;

/// Tauri-managed state holding the latest prompts snapshot from the frontend.
#[derive(Default)]
pub struct PromptsState {
    pub latest: Mutex<Vec<PromptDto>>,
    /// Set to true on the first `update_remote_prompts` call after process
    /// start. Stays true for the lifetime of the process.
    pub hydrated: AtomicBool,
}

impl PromptsState {
    pub fn new() -> Self {
        Self::default()
    }
}
