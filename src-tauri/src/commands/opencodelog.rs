use crate::opencodelog::{OpenCodeHistoryEntry, OpenCodeSessionMessage};

#[tauri::command]
pub fn check_opencode_dir_exists() -> bool {
    crate::opencodelog::check_opencode_dir()
}

/// Validate session_id: alphanumeric + hyphen/underscore only, reasonable length
fn is_valid_session_id(s: &str) -> bool {
    let len = s.len();
    (1..=256).contains(&len)
        && !s.contains("..")
        && !s.contains('/')
        && !s.contains('\\')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub fn read_opencode_log_history(max: Option<usize>) -> Result<Vec<OpenCodeHistoryEntry>, String> {
    Ok(crate::opencodelog::read_opencode_history(max.unwrap_or(100).min(1000)))
}

#[tauri::command]
pub fn read_opencode_log_session(
    session_id: String,
) -> Result<Vec<OpenCodeSessionMessage>, String> {
    if !is_valid_session_id(&session_id) {
        return Err("Invalid session ID format".to_string());
    }
    Ok(crate::opencodelog::read_opencode_session(&session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_session_ids() {
        assert!(is_valid_session_id("01JQ3K"));
        assert!(is_valid_session_id("session-001"));
        assert!(is_valid_session_id("abc_123"));
    }

    #[test]
    fn invalid_session_ids() {
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("../../etc/passwd"));
        assert!(!is_valid_session_id("a/b"));
        assert!(!is_valid_session_id("a\\b"));
    }
}
