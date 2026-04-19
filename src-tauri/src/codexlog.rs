use serde::Serialize;
use std::path::{Path, PathBuf};

/// Entry from ~/.codex/history.jsonl
#[derive(Debug, Clone, Serialize)]
pub struct CodexHistoryEntry {
    pub session_id: String,
    pub display: String,
    /// Unix epoch in milliseconds
    pub timestamp: u64,
    pub cwd: String,
    pub cwd_label: String,
}

/// A unified message for display
#[derive(Debug, Clone, Serialize)]
pub struct CodexSessionMessage {
    pub role: String,
    pub content: String,
    pub tool_name: String,
    pub model: String,
    pub timestamp: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub reasoning_tokens: u64,
}

/// Session metadata from session_meta event
#[derive(Debug, Clone, Serialize)]
pub struct CodexSessionMeta {
    pub id: String,
    pub cwd: String,
    pub cli_version: String,
    pub model_provider: String,
    pub model: String,
    pub git_branch: String,
    pub git_commit: String,
}

fn codex_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".codex")
}

const MAX_FILE_BYTES: u64 = 512 * 1024;

fn read_tail(path: &Path, max_bytes: u64) -> Option<String> {
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

fn extract_cwd_label(cwd: &str) -> String {
    let normalized = cwd.replace('\\', "/");
    normalized
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Read ~/.codex/history.jsonl and return deduplicated entries (newest first).
pub fn read_codex_history(max: usize) -> Vec<CodexHistoryEntry> {
    let path = codex_dir().join("history.jsonl");
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

fn parse_history(text: &str, max: usize) -> Vec<CodexHistoryEntry> {
    use std::collections::HashMap;

    // Codex history.jsonl format: {"session_id":"...", "ts": epoch_secs, "text": "..."}
    // We group by session_id, keep the first text as display, and the latest ts as timestamp.
    struct SessionAcc {
        display: String,
        first_ts: u64,
        latest_ts: u64,
    }

    let mut by_session: HashMap<String, SessionAcc> = HashMap::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let session_id = val
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if session_id.is_empty() {
            continue;
        }

        let ts = val.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        let text_val = val
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        by_session
            .entry(session_id)
            .and_modify(|acc| {
                if ts > acc.latest_ts {
                    acc.latest_ts = ts;
                }
                if ts < acc.first_ts {
                    acc.first_ts = ts;
                    acc.display = text_val.clone();
                }
            })
            .or_insert(SessionAcc {
                display: text_val,
                first_ts: ts,
                latest_ts: ts,
            });
    }

    // Build session_id → rollout file path index once (instead of per-session)
    let rollout_index = build_rollout_index();

    let mut entries: Vec<CodexHistoryEntry> = by_session
        .into_iter()
        .map(|(session_id, acc)| {
            let cwd = rollout_index
                .get(&session_id)
                .map(|path| resolve_cwd_from_file(path))
                .unwrap_or_default();
            let cwd_label = extract_cwd_label(&cwd);
            CodexHistoryEntry {
                session_id,
                display: acc.display,
                timestamp: acc.latest_ts * 1000, // Convert to ms
                cwd,
                cwd_label,
            }
        })
        .collect();

    entries.sort_by_key(|e| std::cmp::Reverse(e.timestamp));
    entries.truncate(max);
    entries
}

/// Build a HashMap of session_id → rollout file path by walking sessions dir once.
fn build_rollout_index() -> std::collections::HashMap<String, PathBuf> {
    let mut index = std::collections::HashMap::new();
    let sessions_dir = codex_dir().join("sessions");
    if !sessions_dir.exists() {
        return index;
    }
    walk_sessions_dir(&sessions_dir, &mut index);
    index
}

fn walk_sessions_dir(sessions_dir: &Path, index: &mut std::collections::HashMap<String, PathBuf>) {
    let Ok(years) = std::fs::read_dir(sessions_dir) else { return };
    for year_entry in years.flatten() {
        if !year_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
        let Ok(months) = std::fs::read_dir(year_entry.path()) else { continue };
        for month_entry in months.flatten() {
            if !month_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let Ok(days) = std::fs::read_dir(month_entry.path()) else { continue };
            for day_entry in days.flatten() {
                if !day_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
                let Ok(files) = std::fs::read_dir(day_entry.path()) else { continue };
                for file_entry in files.flatten() {
                    let name = file_entry.file_name();
                    let name_str = name.to_string_lossy();
                    if !name_str.starts_with("rollout-") || !name_str.ends_with(".jsonl") { continue; }
                    // Extract session_id from filename: rollout-{datetime}-{session_id}.jsonl
                    // The session_id is the last UUID-shaped segment before .jsonl
                    if let Some(id) = extract_session_id_from_filename(&name_str) {
                        index.insert(id, file_entry.path());
                    }
                }
            }
        }
    }
}

/// Extract session_id (UUID) from rollout filename.
/// Format: `rollout-2026-03-26T21-41-45-019d2a2a-4216-75b2-af30-5127c45be3df.jsonl`
fn extract_session_id_from_filename(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".jsonl")?;
    // UUID v7 is 36 chars (8-4-4-4-12 with hyphens)
    if stem.len() < 37 { return None; }
    let candidate = &stem[stem.len() - 36..];
    // Basic UUID format check
    if candidate.len() == 36
        && candidate.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && candidate.chars().filter(|&c| c == '-').count() == 4
    {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// Resolve cwd from a rollout file by reading its session_meta event.
fn resolve_cwd_from_file(path: &Path) -> String {
    let Ok(file) = std::fs::File::open(path) else { return String::new() };
    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(file);
    for line in reader.lines().take(5) {
        let Ok(line) = line else { continue };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if val.get("type").and_then(|v| v.as_str()) == Some("session_meta") {
            if let Some(cwd) = val.get("payload").and_then(|p| p.get("cwd")).and_then(|v| v.as_str()) {
                return cwd.to_string();
            }
        }
    }
    String::new()
}

/// Find a single rollout file by session_id (used for session detail view).
fn find_rollout_file(sessions_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let index = {
        let mut idx = std::collections::HashMap::new();
        walk_sessions_dir(sessions_dir, &mut idx);
        idx
    };
    index.get(session_id).cloned()
}

/// Read a Codex session rollout JSONL and extract messages for display.
pub fn read_codex_session(session_id: &str) -> (Option<CodexSessionMeta>, Vec<CodexSessionMessage>) {
    let sessions_dir = codex_dir().join("sessions");
    let path = match find_rollout_file(&sessions_dir, session_id) {
        Some(p) => p,
        None => return (None, vec![]),
    };

    let text = if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_FILE_BYTES * 4 {
            read_tail(&path, MAX_FILE_BYTES * 4).unwrap_or_default()
        } else {
            std::fs::read_to_string(&path).unwrap_or_default()
        }
    } else {
        return (None, vec![]);
    };

    parse_session(&text)
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

fn parse_session(text: &str) -> (Option<CodexSessionMeta>, Vec<CodexSessionMessage>) {
    let mut meta: Option<CodexSessionMeta> = None;
    let mut messages: Vec<CodexSessionMessage> = Vec::new();
    let mut last_model = String::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let ts = val
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let top_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = match val.get("payload") {
            Some(p) => p,
            None => continue,
        };

        match top_type {
            "session_meta" => {
                let model_from_turn = String::new(); // will be filled from turn_context
                let git = payload.get("git");
                meta = Some(CodexSessionMeta {
                    id: payload
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    cwd: payload
                        .get("cwd")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    cli_version: payload
                        .get("cli_version")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    model_provider: payload
                        .get("model_provider")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    model: model_from_turn,
                    git_branch: git
                        .and_then(|g| g.get("branch"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    git_commit: git
                        .and_then(|g| g.get("commit_hash"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
            "turn_context" => {
                if let Some(m) = payload.get("model").and_then(|v| v.as_str()) {
                    last_model = m.to_string();
                    // Update meta model if available
                    if let Some(ref mut meta) = meta {
                        if meta.model.is_empty() {
                            meta.model = m.to_string();
                        }
                    }
                }
            }
            "event_msg" => {
                let event_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match event_type {
                    "user_message" => {
                        let msg = payload
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !msg.is_empty() {
                            messages.push(CodexSessionMessage {
                                role: "user".into(),
                                content: msg,
                                tool_name: String::new(),
                                model: String::new(),
                                timestamp: ts.clone(),
                                input_tokens: 0,
                                output_tokens: 0,
                                cached_input_tokens: 0,
                                reasoning_tokens: 0,
                            });
                        }
                    }
                    "agent_message" => {
                        let msg = payload
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !msg.is_empty() {
                            messages.push(CodexSessionMessage {
                                role: "assistant".into(),
                                content: msg,
                                tool_name: String::new(),
                                model: last_model.clone(),
                                timestamp: ts.clone(),
                                input_tokens: 0,
                                output_tokens: 0,
                                cached_input_tokens: 0,
                                reasoning_tokens: 0,
                            });
                        }
                    }
                    "agent_reasoning" => {
                        let text_val = payload
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !text_val.is_empty() {
                            messages.push(CodexSessionMessage {
                                role: "reasoning".into(),
                                content: text_val,
                                tool_name: String::new(),
                                model: last_model.clone(),
                                timestamp: ts.clone(),
                                input_tokens: 0,
                                output_tokens: 0,
                                cached_input_tokens: 0,
                                reasoning_tokens: 0,
                            });
                        }
                    }
                    "token_count" => {
                        // Attach token info to the last assistant message
                        if let Some(info) = payload.get("info") {
                            let usage = info.get("total_token_usage");
                            let input = usage
                                .and_then(|u| u.get("input_tokens"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let output = usage
                                .and_then(|u| u.get("output_tokens"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let cached = usage
                                .and_then(|u| u.get("cached_input_tokens"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let reasoning = usage
                                .and_then(|u| u.get("reasoning_output_tokens"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            // Update last assistant/reasoning message with token info
                            if let Some(last) = messages.iter_mut().rev().find(|m| {
                                m.role == "assistant" && m.input_tokens == 0
                            }) {
                                last.input_tokens = input;
                                last.output_tokens = output;
                                last.cached_input_tokens = cached;
                                last.reasoning_tokens = reasoning;
                            }
                        }
                    }
                    _ => {}
                }
            }
            "response_item" => {
                let item_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match item_type {
                    "function_call" => {
                        let name = payload
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let args_raw = payload
                            .get("arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        let detail = extract_tool_detail_codex(&name, args_raw);
                        messages.push(CodexSessionMessage {
                            role: "tool_call".into(),
                            content: detail,
                            tool_name: name,
                            model: String::new(),
                            timestamp: ts.clone(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cached_input_tokens: 0,
                            reasoning_tokens: 0,
                        });
                    }
                    "function_call_output" => {
                        let output = payload
                            .get("output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let call_id = payload
                            .get("call_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // Find matching tool_call to get the name
                        let tool_name = messages
                            .iter()
                            .rev()
                            .find(|m| m.role == "tool_call")
                            .map(|m| m.tool_name.clone())
                            .unwrap_or_else(|| call_id);
                        messages.push(CodexSessionMessage {
                            role: "tool_result".into(),
                            content: truncate_str(&output, 500),
                            tool_name,
                            model: String::new(),
                            timestamp: ts.clone(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cached_input_tokens: 0,
                            reasoning_tokens: 0,
                        });
                    }
                    "custom_tool_call" => {
                        let name = payload
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let input = payload
                            .get("input")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        messages.push(CodexSessionMessage {
                            role: "tool_call".into(),
                            content: truncate_str(input, 200),
                            tool_name: name,
                            model: String::new(),
                            timestamp: ts.clone(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cached_input_tokens: 0,
                            reasoning_tokens: 0,
                        });
                    }
                    "custom_tool_call_output" => {
                        let output = payload
                            .get("output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        messages.push(CodexSessionMessage {
                            role: "tool_result".into(),
                            content: truncate_str(output, 500),
                            tool_name: "custom_tool".into(),
                            model: String::new(),
                            timestamp: ts.clone(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cached_input_tokens: 0,
                            reasoning_tokens: 0,
                        });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    (meta, merge_consecutive_messages(messages))
}

fn extract_tool_detail_codex(name: &str, args_raw: &str) -> String {
    let Ok(args) = serde_json::from_str::<serde_json::Value>(args_raw) else {
        return truncate_str(args_raw, 120);
    };
    let s = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match name {
        "shell_command" => {
            let cmd = s("command");
            let workdir = s("workdir");
            if workdir.is_empty() {
                truncate_str(&cmd, 120)
            } else {
                truncate_str(&format!("[{}] {}", extract_cwd_label(&workdir), cmd), 140)
            }
        }
        "read_file" | "write_file" => s("path"),
        _ => truncate_str(args_raw, 120),
    }
}

/// Merge consecutive assistant messages (same as Claude log pattern).
fn merge_consecutive_messages(messages: Vec<CodexSessionMessage>) -> Vec<CodexSessionMessage> {
    let mut merged: Vec<CodexSessionMessage> = Vec::new();

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
            prev.input_tokens = prev.input_tokens.max(msg.input_tokens);
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
    fn extract_cwd_label_basic() {
        assert_eq!(extract_cwd_label(r"D:\work\racemo"), "racemo");
        assert_eq!(extract_cwd_label("/home/user/myproject"), "myproject");
        assert_eq!(extract_cwd_label(""), "");
    }

    #[test]
    fn parse_history_groups_by_session() {
        let text = r#"{"session_id":"s1","ts":1000,"text":"first msg"}
{"session_id":"s1","ts":1001,"text":"second msg"}
{"session_id":"s2","ts":1002,"text":"other session"}"#;

        let entries = parse_history(text, 100);
        assert_eq!(entries.len(), 2);
        // s2 is newer
        assert_eq!(entries[0].session_id, "s2");
        // s1 display should be first message
        assert_eq!(entries[1].session_id, "s1");
        assert_eq!(entries[1].display, "first msg");
        // timestamp in ms
        assert_eq!(entries[1].timestamp, 1001 * 1000);
    }

    #[test]
    fn parse_history_max_limit() {
        let text = r#"{"session_id":"s1","ts":3000,"text":"a"}
{"session_id":"s2","ts":2000,"text":"b"}
{"session_id":"s3","ts":1000,"text":"c"}"#;

        let entries = parse_history(text, 2);
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn parse_session_basic() {
        let text = r#"{"timestamp":"2026-03-26T12:58:37.137Z","type":"session_meta","payload":{"id":"s1","timestamp":"2026-03-26T12:58:44.461Z","cwd":"D:\\work\\racemo","originator":"codex_cli_rs","cli_version":"0.116.0","source":"cli","model_provider":"openai","base_instructions":"","git":{"commit_hash":"abc123","branch":"main","repository_url":"https://github.com/test/repo.git"}}}
{"timestamp":"2026-03-26T12:59:10.878Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"D:\\work\\racemo","model":"gpt-5.4"}}
{"timestamp":"2026-03-26T12:59:10.879Z","type":"event_msg","payload":{"type":"user_message","message":"hello"}}
{"timestamp":"2026-03-26T12:59:14.473Z","type":"event_msg","payload":{"type":"agent_message","message":"Hi there!","phase":"final_answer"}}"#;

        let (meta, messages) = parse_session(text);
        assert!(meta.is_some());
        let meta = meta.unwrap();
        assert_eq!(meta.id, "s1");
        assert_eq!(meta.cli_version, "0.116.0");
        assert_eq!(meta.git_branch, "main");
        assert_eq!(meta.model, "gpt-5.4");

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "Hi there!");
        assert_eq!(messages[1].model, "gpt-5.4");
    }

    #[test]
    fn parse_session_with_tool_calls() {
        let text = r#"{"timestamp":"T","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"ls\",\"workdir\":\"D:\\\\work\"}","call_id":"c1"}}
{"timestamp":"T","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"file1.txt\nfile2.txt"}}"#;

        let (_meta, messages) = parse_session(text);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "tool_call");
        assert_eq!(messages[0].tool_name, "shell_command");
        assert!(messages[0].content.contains("ls"));
        assert_eq!(messages[1].role, "tool_result");
    }

    #[test]
    fn extract_tool_detail_codex_shell() {
        let detail =
            extract_tool_detail_codex("shell_command", r#"{"command":"ls -la","workdir":"D:\\work\\proj"}"#);
        assert!(detail.contains("ls -la"));
        assert!(detail.contains("proj"));
    }

    #[test]
    fn merge_consecutive_assistant() {
        let text = r#"{"timestamp":"T","type":"event_msg","payload":{"type":"agent_message","message":"Part 1"}}
{"timestamp":"T","type":"event_msg","payload":{"type":"agent_message","message":"Part 2"}}"#;

        let (_meta, messages) = parse_session(text);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].content.contains("Part 1"));
        assert!(messages[0].content.contains("Part 2"));
    }

    #[test]
    fn extract_session_id_from_rollout_filename() {
        assert_eq!(
            extract_session_id_from_filename("rollout-2026-03-26T21-41-45-019d2a2a-4216-75b2-af30-5127c45be3df.jsonl"),
            Some("019d2a2a-4216-75b2-af30-5127c45be3df".to_string()),
        );
        assert_eq!(extract_session_id_from_filename("short.jsonl"), None);
        assert_eq!(extract_session_id_from_filename("rollout.txt"), None);
    }
}
