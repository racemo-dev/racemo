use serde::Serialize;

/// Entry from ~/.claude/history.jsonl
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeHistoryEntry {
    pub display: String,
    pub timestamp: u64,
    pub project: String,
    pub session_id: String,
    pub project_label: String,
}

/// A single tool use with its name and a human-readable detail string
#[derive(Debug, Clone, Serialize)]
pub struct ToolUseDetail {
    pub name: String,
    pub detail: String,
}

/// A single user/assistant message from a session JSONL file
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSessionMessage {
    pub role: String,
    pub content: String,
    pub tool_uses: Vec<ToolUseDetail>,
    pub model: String,
    pub timestamp: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Encode a project path to Claude Code's directory name format.
/// e.g. `D:\work\racemo` → `D--work-racemo`
pub fn encode_project_path(project: &str) -> String {
    let normalized = project.replace('\\', "/");
    let without_trailing = normalized.trim_end_matches('/');
    let mut result = String::new();
    for ch in without_trailing.chars() {
        match ch {
            ':' | '/' | '_' => result.push('-'),
            _ => result.push(ch),
        }
    }
    result
}

fn claude_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".claude")
}

const MAX_FILE_BYTES: u64 = 512 * 1024;

fn read_tail(path: &std::path::Path, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let start = file_len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    if start > 0 {
        if let Some(pos) = buf.find('\n') {
            return Some(buf[pos + 1..].to_string());
        }
        return None;
    }
    Some(buf)
}

/// Read Claude Code history.jsonl, deduplicate by session_id (keep latest),
/// return sorted by timestamp descending (newest first).
pub fn read_claude_history(max: usize) -> Vec<ClaudeHistoryEntry> {
    let path = claude_dir().join("history.jsonl");
    let text = if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_FILE_BYTES {
            read_tail(&path, MAX_FILE_BYTES).unwrap_or_default()
        } else {
            std::fs::read_to_string(&path).unwrap_or_default()
        }
    } else {
        return vec![];
    };

    parse_history(&text, max)
}

fn parse_history(text: &str, max: usize) -> Vec<ClaudeHistoryEntry> {
    use std::collections::HashMap;

    let mut by_session: HashMap<String, ClaudeHistoryEntry> = HashMap::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let display = val
            .get("display")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let timestamp = val
            .get("timestamp")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let project = val
            .get("project")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let session_id = val
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if session_id.is_empty() {
            continue;
        }

        let project_label = extract_project_label(&project);

        let entry = ClaudeHistoryEntry {
            display,
            timestamp,
            project,
            session_id: session_id.clone(),
            project_label,
        };

        // Keep the latest entry per session
        by_session
            .entry(session_id)
            .and_modify(|existing| {
                if timestamp > existing.timestamp {
                    *existing = entry.clone();
                }
            })
            .or_insert(entry);
    }

    let mut entries: Vec<ClaudeHistoryEntry> = by_session.into_values().collect();
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    entries.truncate(max);
    entries
}

fn extract_project_label(project: &str) -> String {
    let normalized = project.replace('\\', "/");
    normalized
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Read a Claude Code session JSONL file and extract user/assistant messages.
pub fn read_claude_session(project: &str, session_id: &str) -> Vec<ClaudeSessionMessage> {
    let encoded = encode_project_path(project);
    let dir = claude_dir().join("projects").join(&encoded);
    let file_path = dir.join(format!("{session_id}.jsonl"));

    // Try case-insensitive match if exact path doesn't exist
    let file_path = if file_path.exists() {
        file_path
    } else {
        match find_project_dir_case_insensitive(&encoded) {
            Some(p) => p.join(format!("{session_id}.jsonl")),
            None => return vec![],
        }
    };

    if !file_path.exists() {
        return vec![];
    }

    let text = if let Ok(meta) = std::fs::metadata(&file_path) {
        if meta.len() > MAX_FILE_BYTES * 4 {
            // For very large sessions, read only the last 2MB
            read_tail(&file_path, MAX_FILE_BYTES * 4).unwrap_or_default()
        } else {
            std::fs::read_to_string(&file_path).unwrap_or_default()
        }
    } else {
        return vec![];
    };

    parse_session(&text)
}

/// Case-insensitive directory lookup under ~/.claude/projects/
fn find_project_dir_case_insensitive(encoded: &str) -> Option<std::path::PathBuf> {
    let projects_dir = claude_dir().join("projects");
    let entries = std::fs::read_dir(&projects_dir).ok()?;
    let lower = encoded.to_lowercase();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().to_lowercase() == lower {
            return Some(entry.path());
        }
    }
    None
}

fn truncate_str(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let collected: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() { format!("{}…", collected) } else { collected }
}

fn extract_tool_detail(name: &str, input: Option<&serde_json::Value>) -> String {
    let Some(input) = input else { return String::new() };
    let s = |key: &str| input.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "Read" | "Write" => s("file_path"),
        "Edit" | "MultiEdit" => s("file_path"),
        "Bash" => truncate_str(&s("command"), 120),
        "Grep" => {
            let pattern = s("pattern");
            let path = s("path");
            if path.is_empty() { pattern } else { format!("{} in {}", pattern, path) }
        }
        "Glob" => s("pattern"),
        "WebFetch" => s("url"),
        "WebSearch" | "ToolSearch" => s("query"),
        "Agent" => truncate_str(&s("prompt"), 100),
        "AskUserQuestion" => {
            let q = s("question");
            if !q.is_empty() { truncate_str(&q, 120) } else { truncate_str(&s("questions"), 120) }
        }
        "TaskCreate" => truncate_str(&s("task"), 120),
        "TaskUpdate" | "TaskGet" => {
            let id = s("id");
            let status = s("status");
            if !status.is_empty() { format!("{} → {}", id, status) } else { id }
        }
        "LSP" => s("file_path"),
        "NotebookEdit" => s("notebook_path"),
        // No meaningful detail for these
        "EnterPlanMode" | "ExitPlanMode" | "EnterWorktree" | "ExitWorktree" => String::new(),
        // Fallback: serialize input JSON for unknown tools
        _ => {
            let raw = serde_json::to_string(input).unwrap_or_default();
            if raw == "{}" || raw == "null" || raw.is_empty() {
                String::new()
            } else {
                truncate_str(&raw, 120)
            }
        }
    }
}

fn parse_session(text: &str) -> Vec<ClaudeSessionMessage> {
    let mut messages = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if msg_type != "user" && msg_type != "assistant" {
            continue;
        }

        // Skip API error messages
        if val.get("isApiErrorMessage").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }

        let message = match val.get("message") {
            Some(m) => m,
            None => continue,
        };

        let role = message
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or(msg_type)
            .to_string();

        let timestamp = val
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let content_arr = message.get("content");

        // Extract text content and tool use details
        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_uses: Vec<ToolUseDetail> = Vec::new();

        if let Some(content) = content_arr {
            if let Some(arr) = content.as_array() {
                for item in arr {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match item_type {
                        "text" => {
                            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                                let trimmed = t.trim();
                                if !trimmed.is_empty() && !trimmed.starts_with("<system-reminder>")
                                {
                                    text_parts.push(trimmed.to_string());
                                }
                            }
                        }
                        "tool_use" => {
                            if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                                let detail = extract_tool_detail(name, item.get("input"));
                                tool_uses.push(ToolUseDetail { name: name.to_string(), detail });
                            }
                        }
                        _ => {}
                    }
                }
            } else if let Some(s) = content.as_str() {
                // User messages may have content as a plain string
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    text_parts.push(trimmed.to_string());
                }
            }
        }

        let content_text = text_parts.join("\n\n");

        // Skip empty messages
        if content_text.is_empty() && tool_uses.is_empty() {
            continue;
        }

        let model = message
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let usage = message.get("usage");
        let input_tokens = usage
            .and_then(|u| u.get("input_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output_tokens = usage
            .and_then(|u| u.get("output_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        messages.push(ClaudeSessionMessage {
            role,
            content: content_text,
            tool_uses,
            model,
            timestamp,
            input_tokens,
            output_tokens,
        });
    }

    merge_consecutive_assistant(messages)
}

/// Merge consecutive assistant messages into one, accumulating tool_uses and tokens.
fn merge_consecutive_assistant(messages: Vec<ClaudeSessionMessage>) -> Vec<ClaudeSessionMessage> {
    let mut merged: Vec<ClaudeSessionMessage> = Vec::new();

    for msg in messages {
        let should_merge = msg.role == "assistant"
            && merged.last().is_some_and(|prev: &ClaudeSessionMessage| {
                prev.role == "assistant"
            });

        if should_merge {
            let Some(prev) = merged.last_mut() else { continue };
            prev.tool_uses.extend(msg.tool_uses);
            prev.input_tokens += msg.input_tokens;
            prev.output_tokens += msg.output_tokens;
            if !msg.content.is_empty() {
                if prev.content.is_empty() {
                    prev.content = msg.content;
                } else {
                    prev.content.push_str("\n\n");
                    prev.content.push_str(&msg.content);
                }
            }
            // Keep the latest model if present
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
    fn encode_project_path_windows() {
        assert_eq!(
            encode_project_path(r"D:\work\racemo"),
            "D--work-racemo"
        );
    }

    #[test]
    fn encode_project_path_unix() {
        assert_eq!(
            encode_project_path("/home/user/project"),
            "-home-user-project"
        );
    }

    #[test]
    fn encode_project_path_trailing_slash() {
        assert_eq!(
            encode_project_path(r"D:\work\racemo\"),
            "D--work-racemo"
        );
    }

    #[test]
    fn encode_project_path_underscore() {
        // Claude Code converts underscores to hyphens in directory names
        assert_eq!(
            encode_project_path(r"D:\workspace\ev_snow"),
            "D--workspace-ev-snow"
        );
    }

    #[test]
    fn extract_project_label_basic() {
        assert_eq!(extract_project_label(r"D:\work\racemo"), "racemo");
        assert_eq!(extract_project_label("/home/user/myproject"), "myproject");
        assert_eq!(extract_project_label(""), "");
    }

    #[test]
    fn parse_history_dedup_by_session() {
        let text = r#"{"display":"first","timestamp":1000,"project":"D:\\work\\proj","sessionId":"sess-1"}
{"display":"second","timestamp":2000,"project":"D:\\work\\proj","sessionId":"sess-1"}
{"display":"other","timestamp":1500,"project":"D:\\work\\proj2","sessionId":"sess-2"}"#;

        let entries = parse_history(text, 100);
        assert_eq!(entries.len(), 2);
        // Newest first
        assert_eq!(entries[0].session_id, "sess-1");
        assert_eq!(entries[0].display, "second");
        assert_eq!(entries[0].timestamp, 2000);
        assert_eq!(entries[1].session_id, "sess-2");
    }

    #[test]
    fn parse_history_max_limit() {
        let text = r#"{"display":"a","timestamp":3000,"project":"p","sessionId":"s1"}
{"display":"b","timestamp":2000,"project":"p","sessionId":"s2"}
{"display":"c","timestamp":1000,"project":"p","sessionId":"s3"}"#;

        let entries = parse_history(text, 2);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].session_id, "s1");
        assert_eq!(entries[1].session_id, "s2");
    }

    #[test]
    fn parse_history_skips_empty_session_id() {
        let text = r#"{"display":"no session","timestamp":1000,"project":"p","sessionId":""}
{"display":"valid","timestamp":2000,"project":"p","sessionId":"s1"}"#;

        let entries = parse_history(text, 100);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id, "s1");
    }

    #[test]
    fn parse_session_user_and_assistant() {
        let text = r#"{"type":"user","timestamp":"2026-02-22T10:00:00Z","message":{"role":"user","content":"fix the bug"}}
{"type":"assistant","timestamp":"2026-02-22T10:00:05Z","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"I'll fix that bug."}],"usage":{"input_tokens":100,"output_tokens":50}}}"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 2);

        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "fix the bug");

        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "I'll fix that bug.");
        assert_eq!(messages[1].model, "claude-opus-4-6");
        assert_eq!(messages[1].input_tokens, 100);
        assert_eq!(messages[1].output_tokens, 50);
    }

    #[test]
    fn parse_session_with_tool_uses() {
        let text = r#"{"type":"assistant","timestamp":"2026-02-22T10:00:05Z","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"Let me read the file."},{"type":"tool_use","name":"Read","id":"t1","input":{"file_path":"src/main.rs"}},{"type":"tool_use","name":"Edit","id":"t2","input":{}}],"usage":{"input_tokens":200,"output_tokens":100}}}"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 1);
        let names: Vec<&str> = messages[0].tool_uses.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["Read", "Edit"]);
        assert_eq!(messages[0].tool_uses[0].detail, "src/main.rs");
        assert_eq!(messages[0].content, "Let me read the file.");
    }

    #[test]
    fn parse_session_skips_api_errors() {
        let text = r#"{"type":"assistant","isApiErrorMessage":true,"timestamp":"T","message":{"role":"assistant","content":[{"type":"text","text":"API Error"}],"usage":{"input_tokens":0,"output_tokens":0}}}
{"type":"user","timestamp":"T","message":{"role":"user","content":"hello"}}"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
    }

    #[test]
    fn parse_session_skips_non_message_types() {
        let text = r#"{"type":"file-history-snapshot","messageId":"abc"}
{"type":"progress","data":{}}
{"type":"user","timestamp":"T","message":{"role":"user","content":"hello"}}"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn parse_session_filters_system_reminders() {
        let text = r#"{"type":"assistant","timestamp":"T","message":{"role":"assistant","model":"claude","content":[{"type":"text","text":"<system-reminder>ignore this</system-reminder>"},{"type":"text","text":"Real content here"}],"usage":{"input_tokens":10,"output_tokens":5}}}"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Real content here");
    }

    #[test]
    fn parse_session_skips_empty_content() {
        let text = r#"{"type":"assistant","timestamp":"T","message":{"role":"assistant","model":"claude","content":[{"type":"text","text":"   "}],"usage":{"input_tokens":0,"output_tokens":0}}}"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 0);
    }

    #[test]
    fn merge_consecutive_assistant_messages() {
        let text = r#"{"type":"user","timestamp":"T","message":{"role":"user","content":"hello"}}
{"type":"assistant","timestamp":"T","message":{"role":"assistant","model":"claude","content":[{"type":"text","text":"Let me check."},{"type":"tool_use","name":"Read","id":"t1","input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}}
{"type":"assistant","timestamp":"T","message":{"role":"assistant","model":"claude","content":[{"type":"tool_use","name":"Read","id":"t2","input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}}
{"type":"assistant","timestamp":"T","message":{"role":"assistant","model":"claude","content":[{"type":"tool_use","name":"Edit","id":"t3","input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}}
{"type":"assistant","timestamp":"T","message":{"role":"assistant","model":"claude","content":[{"type":"text","text":"Done!"}],"usage":{"input_tokens":10,"output_tokens":20}}}"#;

        let messages = parse_session(text);
        // user + 1 merged assistant
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        let names: Vec<&str> = messages[1].tool_uses.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["Read", "Read", "Edit"]);
        assert_eq!(messages[1].content, "Let me check.\n\nDone!");
        assert_eq!(messages[1].input_tokens, 40);
        assert_eq!(messages[1].output_tokens, 35);
    }

    #[test]
    fn merge_does_not_merge_across_user() {
        let text = r#"{"type":"assistant","timestamp":"T","message":{"role":"assistant","model":"claude","content":[{"type":"tool_use","name":"Read","id":"t1","input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}}
{"type":"user","timestamp":"T","message":{"role":"user","content":"ok"}}
{"type":"assistant","timestamp":"T","message":{"role":"assistant","model":"claude","content":[{"type":"tool_use","name":"Edit","id":"t2","input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}}"#;

        let messages = parse_session(text);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].tool_uses[0].name, "Read");
        assert_eq!(messages[2].tool_uses[0].name, "Edit");
    }
}
