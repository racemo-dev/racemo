use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;

/// Entry representing a saved OpenCode session
#[derive(Debug, Clone, Serialize)]
pub struct OpenCodeHistoryEntry {
    /// Session ID
    pub session_id: String,
    /// Session title or first user message as display text
    pub display: String,
    /// Session update time as Unix epoch ms
    pub timestamp: u64,
    /// Working directory path
    pub directory: String,
    /// Short label derived from directory basename
    pub project_label: String,
}

/// A single message from an OpenCode session
#[derive(Debug, Clone, Serialize)]
pub struct OpenCodeSessionMessage {
    pub role: String,
    pub content: String,
    pub tool_name: String,
    pub model: String,
    pub timestamp: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

fn opencode_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("OPENCODE_DATA_DIR") {
        return PathBuf::from(custom);
    }
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".local").join("share").join("opencode")
}

fn db_path() -> PathBuf {
    opencode_data_dir().join("opencode.db")
}

/// Check if OpenCode DB exists
pub fn check_opencode_dir() -> bool {
    db_path().exists()
}

fn open_db() -> Option<Connection> {
    let path = db_path();
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()
}

/// Read session list from OpenCode SQLite DB.
/// Returns entries sorted by time_updated descending (newest first).
pub fn read_opencode_history(max: usize) -> Vec<OpenCodeHistoryEntry> {
    let Some(conn) = open_db() else {
        return vec![];
    };

    let mut stmt = match conn.prepare(
        "SELECT id, title, directory, time_updated \
         FROM session \
         ORDER BY time_updated DESC \
         LIMIT ?1",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let rows = stmt
        .query_map([max as i64], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let directory: String = row.get(2)?;
            let time_updated: i64 = row.get(3)?;
            Ok((id, title, directory, time_updated))
        })
        .ok();

    let Some(rows) = rows else {
        return vec![];
    };

    let mut entries = Vec::new();
    for row in rows.flatten() {
        let (id, title, directory, time_updated) = row;
        let display = if title.is_empty() {
            id.clone()
        } else {
            truncate_str(&title, 120)
        };
        let timestamp = time_updated.max(0) as u64;
        let project_label = directory
            .replace('\\', "/")
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&directory)
            .to_string();

        entries.push(OpenCodeHistoryEntry {
            session_id: id,
            display,
            timestamp,
            directory: directory.clone(),
            project_label,
        });
    }

    entries
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

/// Read messages + parts for a given session from the SQLite DB.
pub fn read_opencode_session(session_id: &str) -> Vec<OpenCodeSessionMessage> {
    let Some(conn) = open_db() else {
        return vec![];
    };

    // Query messages ordered by creation time
    let mut msg_stmt = match conn.prepare(
        "SELECT m.id, m.data \
         FROM message m \
         WHERE m.session_id = ?1 \
         ORDER BY m.time_created ASC",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    // Query parts for a specific message ordered by creation time
    let mut part_stmt = match conn.prepare(
        "SELECT data \
         FROM part \
         WHERE message_id = ?1 \
         ORDER BY time_created ASC",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let msg_rows = match msg_stmt.query_map([session_id], |row| {
        let id: String = row.get(0)?;
        let data: String = row.get(1)?;
        Ok((id, data))
    }) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let mut messages = Vec::new();

    for msg_row in msg_rows.flatten() {
        let (msg_id, msg_data_str) = msg_row;

        let Ok(msg_data) = serde_json::from_str::<serde_json::Value>(&msg_data_str) else {
            continue;
        };

        let role = msg_data
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if role.is_empty() {
            continue;
        }

        let model_id = msg_data
            .get("modelID")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Gather parts for this message
        let part_rows = part_stmt
            .query_map([&msg_id], |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .ok();

        let Some(part_rows) = part_rows else {
            continue;
        };

        for part_data_str in part_rows.flatten() {
            let Ok(part) = serde_json::from_str::<serde_json::Value>(&part_data_str) else {
                continue;
            };

            let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match part_type {
                "text" => {
                    let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if !text.is_empty() {
                        let ts = extract_timestamp(&part);
                        messages.push(OpenCodeSessionMessage {
                            role: role.clone(),
                            content: text.to_string(),
                            tool_name: String::new(),
                            model: model_id.clone(),
                            timestamp: ts,
                            input_tokens: 0,
                            output_tokens: 0,
                        });
                    }
                }
                "tool" => {
                    let tool_name = part
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let state = part.get("state");
                    let status = state
                        .and_then(|s| s.get("status"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let input = state.and_then(|s| s.get("input"));
                    let detail = extract_tool_detail(&tool_name, input);
                    let ts = extract_timestamp(&part);

                    // tool_call
                    messages.push(OpenCodeSessionMessage {
                        role: "tool_call".to_string(),
                        content: detail,
                        tool_name: tool_name.clone(),
                        model: String::new(),
                        timestamp: ts.clone(),
                        input_tokens: 0,
                        output_tokens: 0,
                    });

                    // tool_result (if completed)
                    if status == "completed" {
                        let output = state
                            .and_then(|s| s.get("output"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !output.is_empty() {
                            messages.push(OpenCodeSessionMessage {
                                role: "tool_result".to_string(),
                                content: truncate_str(output, 500),
                                tool_name,
                                model: String::new(),
                                timestamp: ts,
                                input_tokens: 0,
                                output_tokens: 0,
                            });
                        }
                    }
                }
                "step-finish" => {
                    // Extract token usage from step-finish parts
                    if let Some(tokens) = part.get("tokens") {
                        let input_tokens = tokens
                            .get("input")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let output_tokens = tokens
                            .get("output")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let cache_read = tokens
                            .get("cache")
                            .and_then(|c| c.get("read"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);

                        // Attach tokens to the last assistant message
                        if let Some(last) = messages.iter_mut().rev().find(|m| m.role == "assistant") {
                            last.input_tokens += input_tokens + cache_read;
                            last.output_tokens += output_tokens;
                        }
                    }
                }
                // Skip reasoning, step-start, etc.
                _ => {}
            }
        }
    }

    merge_consecutive_assistant(messages)
}

fn extract_timestamp(part: &serde_json::Value) -> String {
    part.get("time")
        .and_then(|t| t.get("start").or_else(|| t.get("end")))
        .and_then(|v| v.as_i64())
        .map(|ms| ms.to_string())
        .unwrap_or_default()
}

fn extract_tool_detail(name: &str, input: Option<&serde_json::Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    let s = |key: &str| {
        input
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match name {
        "read" | "read_file" | "write" | "write_file" => {
            let path = s("filePath");
            if path.is_empty() { s("file_path") } else { path }
        }
        "edit" => {
            let path = s("filePath");
            if path.is_empty() { s("file_path") } else { path }
        }
        "bash" | "shell" => truncate_str(&s("command"), 120),
        "glob" | "grep" | "list_directory" | "search_files" => s("path"),
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

/// Merge consecutive assistant messages into one.
fn merge_consecutive_assistant(
    messages: Vec<OpenCodeSessionMessage>,
) -> Vec<OpenCodeSessionMessage> {
    let mut merged: Vec<OpenCodeSessionMessage> = Vec::new();

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
    fn extract_tool_detail_read() {
        let args: serde_json::Value =
            serde_json::from_str(r#"{"filePath": "/src/main.rs"}"#).unwrap();
        let detail = extract_tool_detail("read", Some(&args));
        assert_eq!(detail, "/src/main.rs");
    }

    #[test]
    fn extract_tool_detail_bash() {
        let args: serde_json::Value =
            serde_json::from_str(r#"{"command": "ls -la"}"#).unwrap();
        let detail = extract_tool_detail("bash", Some(&args));
        assert_eq!(detail, "ls -la");
    }

    #[test]
    fn extract_tool_detail_none() {
        assert_eq!(extract_tool_detail("read", None), "");
    }

    #[test]
    fn merge_consecutive_assistant_messages() {
        let msgs = vec![
            OpenCodeSessionMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
                tool_name: String::new(),
                model: String::new(),
                timestamp: String::new(),
                input_tokens: 0,
                output_tokens: 0,
            },
            OpenCodeSessionMessage {
                role: "assistant".to_string(),
                content: "Part 1".to_string(),
                tool_name: String::new(),
                model: String::new(),
                timestamp: String::new(),
                input_tokens: 100,
                output_tokens: 50,
            },
            OpenCodeSessionMessage {
                role: "assistant".to_string(),
                content: "Part 2".to_string(),
                tool_name: String::new(),
                model: "model-x".to_string(),
                timestamp: String::new(),
                input_tokens: 200,
                output_tokens: 100,
            },
        ];

        let merged = merge_consecutive_assistant(msgs);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].role, "user");
        assert_eq!(merged[1].role, "assistant");
        assert!(merged[1].content.contains("Part 1"));
        assert!(merged[1].content.contains("Part 2"));
        assert_eq!(merged[1].input_tokens, 300);
        assert_eq!(merged[1].output_tokens, 150);
        assert_eq!(merged[1].model, "model-x");
    }

}
