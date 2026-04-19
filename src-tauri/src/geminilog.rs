use serde::Serialize;
use std::path::{Path, PathBuf};

/// Entry representing a saved Gemini CLI chat session
#[derive(Debug, Clone, Serialize)]
pub struct GeminiHistoryEntry {
    /// Chat tag (filename without .json)
    pub tag: String,
    /// First user message or tag as display text
    pub display: String,
    /// File modification time as Unix epoch ms
    pub timestamp: u64,
    /// Project hash directory name
    pub project_hash: String,
    /// Short label derived from project hash
    pub project_label: String,
}

/// A single message from a Gemini chat session
#[derive(Debug, Clone, Serialize)]
pub struct GeminiSessionMessage {
    pub role: String,
    pub content: String,
    pub tool_name: String,
    pub model: String,
    pub timestamp: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

fn gemini_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".gemini")
}

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Check if ~/.gemini directory exists
pub fn check_gemini_dir() -> bool {
    gemini_dir().join("tmp").is_dir()
}

/// Scan all project hash dirs under ~/.gemini/tmp/ for saved chat sessions.
/// Returns entries sorted by timestamp descending (newest first).
pub fn read_gemini_history(max: usize) -> Vec<GeminiHistoryEntry> {
    let tmp_dir = gemini_dir().join("tmp");
    if !tmp_dir.is_dir() {
        return vec![];
    }

    let mut entries = Vec::new();

    let Ok(projects) = std::fs::read_dir(&tmp_dir) else {
        return vec![];
    };

    for project_entry in projects.flatten() {
        if !project_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let project_hash = project_entry.file_name().to_string_lossy().to_string();
        let chats_dir = project_entry.path().join("chats");
        if !chats_dir.is_dir() {
            continue;
        }

        let Ok(chat_files) = std::fs::read_dir(&chats_dir) else {
            continue;
        };

        for file_entry in chat_files.flatten() {
            let name = file_entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") {
                continue;
            }
            let tag = name_str.trim_end_matches(".json").to_string();

            // Use file modification time as timestamp
            let timestamp = file_entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            // Try to extract first user message as display text
            let display = extract_first_user_message(&file_entry.path())
                .unwrap_or_else(|| tag.clone());

            let project_label = if project_hash.len() > 8 {
                project_hash[..8].to_string()
            } else {
                project_hash.clone()
            };

            entries.push(GeminiHistoryEntry {
                tag: tag.clone(),
                display,
                timestamp,
                project_hash: project_hash.clone(),
                project_label,
            });
        }
    }

    entries.sort_by_key(|e| std::cmp::Reverse(e.timestamp));
    entries.truncate(max);
    entries
}

/// Extract text from Gemini content field which can be a string or array of {text: "..."}.
fn extract_content_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.trim().to_string();
    }
    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for part in arr {
            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                let trimmed = t.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
        return parts.join("\n\n");
    }
    String::new()
}

/// Extract first user message text from a chat JSON file for display.
/// Gemini CLI format: { "messages": [ { "type": "user", "content": "..." | [{"text":"..."}] } ] }
fn extract_first_user_message(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&text).ok()?;

    // Top-level object with "messages" array
    let messages = val.get("messages").and_then(|v| v.as_array())?;

    for item in messages {
        let msg_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if msg_type == "user" {
            if let Some(content) = item.get("content") {
                let text = extract_content_text(content);
                if !text.is_empty() {
                    return Some(truncate_str(&text, 120));
                }
            }
        }
    }
    None
}

fn truncate_str(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let collected: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}…", collected)
    } else {
        collected
    }
}

/// Read a Gemini CLI chat session JSON file and extract messages.
pub fn read_gemini_session(
    project_hash: &str,
    tag: &str,
) -> Vec<GeminiSessionMessage> {
    let chats_dir = gemini_dir().join("tmp").join(project_hash).join("chats");
    let file_path = chats_dir.join(format!("{tag}.json"));

    if !file_path.exists() {
        return vec![];
    }

    let text = if let Ok(meta) = std::fs::metadata(&file_path) {
        if meta.len() > MAX_FILE_BYTES {
            log::warn!(
                "Gemini session file too large ({} bytes), truncating to {}: {}",
                meta.len(),
                MAX_FILE_BYTES,
                file_path.display()
            );
            let mut file = match std::fs::File::open(&file_path) {
                Ok(f) => f,
                Err(_) => return vec![],
            };
            let mut buf = vec![0u8; MAX_FILE_BYTES as usize];
            use std::io::Read;
            let n = file.read(&mut buf).unwrap_or(0);
            String::from_utf8_lossy(&buf[..n]).to_string()
        } else {
            std::fs::read_to_string(&file_path).unwrap_or_default()
        }
    } else {
        return vec![];
    };

    parse_session(&text)
}

/// Parse Gemini CLI session JSON.
/// Format: { "sessionId": "...", "messages": [ { "type": "user"|"gemini", "content": ..., ... } ] }
fn parse_session(text: &str) -> Vec<GeminiSessionMessage> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return vec![];
    };

    let messages_arr = if let Some(arr) = val.get("messages").and_then(|v| v.as_array()) {
        arr.clone()
    } else if let Some(arr) = val.as_array() {
        // Fallback: support raw array format
        arr.clone()
    } else {
        return vec![];
    };

    let mut messages = Vec::new();

    for item in &messages_arr {
        // Gemini CLI uses "type" field: "user" | "gemini"
        let msg_type = item
            .get("type")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("role").and_then(|v| v.as_str()))
            .unwrap_or("");

        if msg_type.is_empty() {
            continue;
        }

        let normalized_role = match msg_type {
            "gemini" | "model" | "assistant" => "assistant",
            "user" => "user",
            _ => continue,
        };

        let timestamp = item
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let model = item
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Extract tokens from "tokens" object
        let tokens = item.get("tokens");
        let input_tokens = tokens
            .and_then(|t| t.get("input"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output_tokens = tokens
            .and_then(|t| t.get("output"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        // Extract content text
        let content_text = item
            .get("content")
            .map(extract_content_text)
            .unwrap_or_default();

        // Extract tool calls from "toolCalls" array
        if let Some(tool_calls) = item.get("toolCalls").and_then(|v| v.as_array()) {
            for tc in tool_calls {
                let name = tc
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let args = tc.get("args");
                let detail = extract_tool_detail_gemini(&name, args);

                messages.push(GeminiSessionMessage {
                    role: "tool_call".to_string(),
                    content: detail.clone(),
                    tool_name: name.clone(),
                    model: String::new(),
                    timestamp: timestamp.clone(),
                    input_tokens: 0,
                    output_tokens: 0,
                });

                // Extract inline tool result from toolCall.result
                if let Some(results) = tc.get("result").and_then(|v| v.as_array()) {
                    for result in results {
                        if let Some(fr) = result.get("functionResponse") {
                            let resp = fr.get("response");
                            let output = resp
                                .and_then(|r| r.get("output"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let result_text = if output.is_empty() {
                                serde_json::to_string(
                                    resp.unwrap_or(&serde_json::Value::Null),
                                )
                                .unwrap_or_default()
                            } else {
                                output.to_string()
                            };
                            messages.push(GeminiSessionMessage {
                                role: "tool_result".to_string(),
                                content: truncate_str(&result_text, 500),
                                tool_name: name.clone(),
                                model: String::new(),
                                timestamp: timestamp.clone(),
                                input_tokens: 0,
                                output_tokens: 0,
                            });
                        }
                    }
                }
            }
        }

        // Emit text content message
        if !content_text.is_empty() {
            messages.push(GeminiSessionMessage {
                role: normalized_role.to_string(),
                content: content_text,
                tool_name: String::new(),
                model,
                timestamp,
                input_tokens,
                output_tokens,
            });
        }
    }

    merge_consecutive_assistant(messages)
}

fn extract_tool_detail_gemini(name: &str, args: Option<&serde_json::Value>) -> String {
    let Some(args) = args else {
        return String::new();
    };
    let s = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match name {
        "read_file" | "write_file" | "ReadFile" | "WriteFile" => s("file_path").or_else(|| s("path")),
        "replace" | "Replace" => s("file_path").or_else(|| s("path")),
        "ShellTool" | "shell" | "run_shell_command" => truncate_str(&s("command"), 120),
        "GoogleSearch" | "google_search" => s("query"),
        _ => {
            let raw = serde_json::to_string(args).unwrap_or_default();
            if raw == "{}" || raw == "null" || raw.is_empty() {
                String::new()
            } else {
                truncate_str(&raw, 120)
            }
        }
    }
}

/// Helper: return self if not empty, otherwise the other
trait OrElse {
    fn or_else(self, f: impl FnOnce() -> String) -> String;
}
impl OrElse for String {
    fn or_else(self, f: impl FnOnce() -> String) -> String {
        if self.is_empty() { f() } else { self }
    }
}

/// Merge consecutive assistant messages into one.
fn merge_consecutive_assistant(
    messages: Vec<GeminiSessionMessage>,
) -> Vec<GeminiSessionMessage> {
    let mut merged: Vec<GeminiSessionMessage> = Vec::new();

    for msg in messages {
        let should_merge = msg.role == "assistant"
            && merged
                .last()
                .is_some_and(|prev| prev.role == "assistant");

        if should_merge {
            let Some(prev) = merged.last_mut() else { continue };
            if !msg.content.is_empty() {
                if prev.content.is_empty() {
                    prev.content = msg.content;
                } else {
                    prev.content.push_str("\n\n");
                    prev.content.push_str(&msg.content);
                }
            }
            prev.input_tokens += msg.input_tokens;
            prev.output_tokens += msg.output_tokens;
            if !msg.model.is_empty() {
                prev.model = msg.model;
            }
        } else {
            merged.push(msg);
        }
    }

    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_str_short() {
        assert_eq!(truncate_str("hello", 10), "hello");
    }

    #[test]
    fn truncate_str_long() {
        let result = truncate_str("hello world", 5);
        assert_eq!(result, "hello…");
    }

    #[test]
    fn parse_session_gemini_format() {
        let text = r#"{
            "sessionId": "abc",
            "projectHash": "hash123",
            "messages": [
                {"type": "user", "timestamp": "2026-04-01T00:00:00Z", "content": "fix the bug"},
                {"type": "gemini", "timestamp": "2026-04-01T00:00:05Z", "content": "I'll fix that bug.", "model": "gemini-3-flash", "tokens": {"input": 100, "output": 50}}
            ]
        }"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "fix the bug");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "I'll fix that bug.");
        assert_eq!(messages[1].model, "gemini-3-flash");
        assert_eq!(messages[1].input_tokens, 100);
        assert_eq!(messages[1].output_tokens, 50);
    }

    #[test]
    fn parse_session_array_content() {
        let text = r#"{
            "messages": [
                {"type": "user", "content": [{"text": "hello world"}]},
                {"type": "gemini", "content": "response here", "model": "gemini-3-flash"}
            ]
        }"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "hello world");
        assert_eq!(messages[1].content, "response here");
    }

    #[test]
    fn parse_session_with_tool_calls() {
        let text = r#"{
            "messages": [
                {
                    "type": "gemini",
                    "content": "Let me read the file.",
                    "toolCalls": [
                        {
                            "name": "read_file",
                            "args": {"file_path": "src/main.rs"},
                            "result": [
                                {"functionResponse": {"name": "read_file", "response": {"output": "fn main() {}"}}}
                            ]
                        }
                    ],
                    "model": "gemini-3-flash"
                }
            ]
        }"#;

        let messages = parse_session(text);
        assert!(messages.iter().any(|m| m.role == "tool_call" && m.tool_name == "read_file"));
        assert!(messages.iter().any(|m| m.role == "tool_result" && m.content.contains("fn main")));
        assert!(messages.iter().any(|m| m.role == "assistant" && m.content.contains("Let me read")));
    }

    #[test]
    fn parse_session_empty_content() {
        let text = r#"{
            "messages": [
                {"type": "user", "content": [{"text": "   "}]},
                {"type": "gemini", "content": "hello"}
            ]
        }"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "assistant");
    }

    #[test]
    fn merge_consecutive_assistant_messages() {
        let text = r#"{
            "messages": [
                {"type": "user", "content": "hi"},
                {"type": "gemini", "content": "Part 1"},
                {"type": "gemini", "content": "Part 2"}
            ]
        }"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        assert!(messages[1].content.contains("Part 1"));
        assert!(messages[1].content.contains("Part 2"));
    }

    #[test]
    fn extract_tool_detail_read_file() {
        let args: serde_json::Value =
            serde_json::from_str(r#"{"file_path": "src/main.rs"}"#).unwrap();
        let detail = extract_tool_detail_gemini("read_file", Some(&args));
        assert_eq!(detail, "src/main.rs");
    }

    #[test]
    fn extract_tool_detail_shell() {
        let args: serde_json::Value =
            serde_json::from_str(r#"{"command": "ls -la"}"#).unwrap();
        let detail = extract_tool_detail_gemini("ShellTool", Some(&args));
        assert_eq!(detail, "ls -la");
    }

    #[test]
    fn extract_content_text_string() {
        let val = serde_json::json!("hello");
        assert_eq!(extract_content_text(&val), "hello");
    }

    #[test]
    fn extract_content_text_array() {
        let val = serde_json::json!([{"text": "hello"}, {"text": "world"}]);
        assert_eq!(extract_content_text(&val), "hello\n\nworld");
    }

    #[test]
    fn extract_content_text_empty() {
        let val = serde_json::json!(null);
        assert_eq!(extract_content_text(&val), "");
    }

    #[test]
    fn parse_session_with_tokens_and_model() {
        let text = r#"{
            "messages": [
                {
                    "type": "gemini",
                    "content": "Hello!",
                    "model": "gemini-3-flash-preview",
                    "tokens": {"input": 500, "output": 100, "cached": 0, "thoughts": 50, "tool": 0, "total": 650}
                }
            ]
        }"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].model, "gemini-3-flash-preview");
        assert_eq!(messages[0].input_tokens, 500);
        assert_eq!(messages[0].output_tokens, 100);
    }
}
