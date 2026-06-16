//! Common abstractions shared by all AI log parsers (Claude, Codex, Gemini, OpenCode).
//!
//! - `shared`: utility functions (e.g. `truncate_str`) used by every parser
//! - `types`: unified `AiHistoryEntry` / `AiSessionMessage` types with `From` impls,
//!   intended for a future unified `list_ai_history` Tauri command

pub mod shared;
pub mod types;

pub use types::{AiHistoryEntry, AiSessionMessage, AiSource};
