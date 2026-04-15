use crate::codexlog::{CodexHistoryEntry, CodexSessionMessage, CodexSessionMeta};

#[tauri::command]
pub fn check_codex_dir_exists() -> bool {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".codex").is_dir()
}

/// Validate session_id is a UUID-like string (hex + hyphens only, 8-64 chars)
fn is_valid_session_id(id: &str) -> bool {
    let len = id.len();
    (8..=64).contains(&len) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[tauri::command]
pub fn read_codex_log_history(max: Option<usize>) -> Result<Vec<CodexHistoryEntry>, String> {
    Ok(crate::codexlog::read_codex_history(max.unwrap_or(100)))
}

#[tauri::command]
pub fn read_codex_log_session(
    session_id: String,
) -> Result<(Option<CodexSessionMeta>, Vec<CodexSessionMessage>), String> {
    if !is_valid_session_id(&session_id) {
        return Err("Invalid session ID format".to_string());
    }
    Ok(crate::codexlog::read_codex_session(&session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_session_ids() {
        assert!(is_valid_session_id("019d2a2a-4216-75b2-af30-5127c45be3df"));
        assert!(is_valid_session_id("abcdef01"));
    }

    #[test]
    fn invalid_session_ids() {
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("short"));
        assert!(!is_valid_session_id("../../../etc/passwd"));
        assert!(!is_valid_session_id("abc\x00def01234"));
        assert!(!is_valid_session_id("01234567/89abcdef"));
    }
}
