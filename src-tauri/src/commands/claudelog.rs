use crate::claudelog::{ClaudeHistoryEntry, ClaudeSessionMessage};

#[tauri::command]
pub fn read_claude_log_history(max: Option<usize>) -> Result<Vec<ClaudeHistoryEntry>, String> {
    Ok(crate::claudelog::read_claude_history(max.unwrap_or(100)))
}

#[tauri::command]
pub fn read_claude_log_session(
    project: String,
    session_id: String,
) -> Result<Vec<ClaudeSessionMessage>, String> {
    Ok(crate::claudelog::read_claude_session(&project, &session_id))
}
