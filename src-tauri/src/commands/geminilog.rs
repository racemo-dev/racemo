use crate::geminilog::{GeminiHistoryEntry, GeminiSessionMessage};

#[tauri::command]
pub fn check_gemini_dir_exists() -> bool {
    crate::geminilog::check_gemini_dir()
}

/// Validate project_hash: alphanumeric + hyphen only, reasonable length
fn is_valid_hash(s: &str) -> bool {
    let len = s.len();
    (1..=128).contains(&len) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Validate tag: no path traversal, alphanumeric + hyphen/underscore/dot
fn is_valid_tag(s: &str) -> bool {
    let len = s.len();
    (1..=256).contains(&len)
        && !s.contains("..")
        && !s.contains('/')
        && !s.contains('\\')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

#[tauri::command]
pub fn read_gemini_log_history(max: Option<usize>) -> Result<Vec<GeminiHistoryEntry>, String> {
    Ok(crate::geminilog::read_gemini_history(max.unwrap_or(100)))
}

#[tauri::command]
pub fn read_gemini_log_session(
    project_hash: String,
    tag: String,
) -> Result<Vec<GeminiSessionMessage>, String> {
    if !is_valid_hash(&project_hash) {
        return Err("Invalid project hash format".to_string());
    }
    if !is_valid_tag(&tag) {
        return Err("Invalid tag format".to_string());
    }
    Ok(crate::geminilog::read_gemini_session(&project_hash, &tag))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_hashes() {
        assert!(is_valid_hash("abc123"));
        assert!(is_valid_hash("a1b2c3d4e5f6"));
        assert!(is_valid_hash("project-hash_123"));
    }

    #[test]
    fn invalid_hashes() {
        assert!(!is_valid_hash(""));
        assert!(!is_valid_hash("../etc"));
        assert!(!is_valid_hash("a/b"));
        assert!(!is_valid_hash("a\\b"));
    }

    #[test]
    fn valid_tags() {
        assert!(is_valid_tag("before-refactor"));
        assert!(is_valid_tag("session_001"));
        assert!(is_valid_tag("my.tag"));
    }

    #[test]
    fn invalid_tags() {
        assert!(!is_valid_tag(""));
        assert!(!is_valid_tag("../../etc/passwd"));
        assert!(!is_valid_tag("a/b"));
        assert!(!is_valid_tag("a\\b"));
    }
}
