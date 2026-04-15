use serde::{Deserialize, Serialize};

/// Raw JSON line from session JSONL files
#[derive(Debug, Deserialize)]
struct RawHookEvent {
    ts: Option<String>,
    event: Option<String>,
    #[allow(dead_code)]
    model: Option<String>,
    #[allow(dead_code)]
    project: Option<String>,
    #[allow(dead_code)]
    session_id: Option<String>,
    tool_name: Option<String>,
    tool_use_id: Option<String>,
    tool_input: Option<serde_json::Value>,
    tool_response: Option<serde_json::Value>,
    prompt: Option<String>,
    error: Option<String>,
    #[serde(flatten)]
    _extra: serde_json::Map<String, serde_json::Value>,
}

/// Tree node sent to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct HookTreeNode {
    pub id: String,
    pub node_type: String, // "session" | "prompt" | "tool" | "subagent" | "event"
    pub label: String,
    pub timestamp: String,
    pub status: String, // "success" | "failure" | "info"
    pub detail: String, // JSON string with summarized data
    pub raw: String,    // JSON string with raw tool_input/tool_response (truncated)
    pub model: String,  // "claude" | "gemini" | "codex" | ...
    pub children: Vec<HookTreeNode>,
}

const MAX_FILE_BYTES: u64 = 256 * 1024; // 256 KB per session file

fn sessions_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".racemo-knowledge").join("sessions")
}

fn archive_dir() -> std::path::PathBuf {
    sessions_dir().join("archive")
}

/// Parsed session file info
struct SessionFile {
    model: String,
    session_id: String,
    path: std::path::PathBuf,
    mtime: std::time::SystemTime,
}

const ARCHIVE_DAYS: u64 = 30;

/// Move session files older than ARCHIVE_DAYS to sessions/archive/
fn auto_archive_old_sessions() {
    let dir = sessions_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(ARCHIVE_DAYS * 24 * 60 * 60);
    let mut archive_created = false;

    for entry in entries.flatten() {
        let path = entry.path();
        // Only move .jsonl files (skip dirs and index.jsonl)
        if path.is_dir() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if path.file_stem().and_then(|s| s.to_str()) == Some("index") {
            continue;
        }
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if mtime < cutoff {
            if !archive_created {
                let _ = std::fs::create_dir_all(archive_dir());
                archive_created = true;
            }
            let dest = archive_dir().join(path.file_name().unwrap_or_default());
            let _ = std::fs::rename(&path, &dest);
        }
    }
}

pub fn read_hook_log_tree(max_sessions: usize) -> Vec<HookTreeNode> {
    // Auto-archive old sessions before reading
    auto_archive_old_sessions();

    let dir = sessions_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    // Collect and parse session files (skip index.jsonl)
    let mut session_files: Vec<SessionFile> = entries
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                return None;
            }
            // Skip the index file
            if path.file_stem().and_then(|s| s.to_str()) == Some("index") {
                return None;
            }
            let stem = path.file_stem()?.to_str()?;
            let (model, session_id) = parse_filename(stem)?;
            let mtime = entry.metadata().ok()?.modified().ok()?;
            Some(SessionFile {
                model,
                session_id,
                path,
                mtime,
            })
        })
        .collect();

    // Sort by mtime ascending (oldest first), take last max_sessions
    session_files.sort_by_key(|f| f.mtime);
    if session_files.len() > max_sessions {
        let skip = session_files.len() - max_sessions;
        session_files = session_files.into_iter().skip(skip).collect();
    }

    session_files
        .iter()
        .filter_map(|sf| {
            let meta = std::fs::metadata(&sf.path).ok()?;
            if meta.len() > MAX_FILE_BYTES {
                // Read only last MAX_FILE_BYTES
                let buf = read_tail(&sf.path, MAX_FILE_BYTES)?;
                let events = parse_events(&buf);
                Some(build_session_node(&sf.session_id, &sf.model, &events))
            } else {
                let buf = std::fs::read_to_string(&sf.path).ok()?;
                let events = parse_events(&buf);
                Some(build_session_node(&sf.session_id, &sf.model, &events))
            }
        })
        .collect()
}

/// Parse filename pattern: YYYY-MM-DD_model_session_id
/// Returns (model, session_id). The date prefix is optional for backward compat.
fn parse_filename(stem: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = stem.splitn(3, '_').collect();
    match parts.len() {
        // New format: "2026-02-22_claude_84ba0c70-1250-4f3d"
        3 => {
            let date = parts[0];
            let model = parts[1];
            let session_id = parts[2];
            // Validate date-like prefix (YYYY-MM-DD = 10 chars)
            if date.len() == 10 && !model.is_empty() && !session_id.is_empty() {
                Some((model.to_string(), session_id.to_string()))
            } else {
                None
            }
        }
        // Legacy format: "claude_84ba0c70-1250-4f3d"
        2 => {
            let model = parts[0];
            let session_id = parts[1];
            if !model.is_empty() && !session_id.is_empty() {
                Some((model.to_string(), session_id.to_string()))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn read_tail(path: &std::path::Path, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let start = file_len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    // Skip first partial line if we started mid-file
    if start > 0 {
        if let Some(pos) = buf.find('\n') {
            return Some(buf[pos + 1..].to_string());
        }
        return None;
    }
    Some(buf)
}

fn parse_events(text: &str) -> Vec<RawHookEvent> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn build_session_node(session_id: &str, model: &str, events: &[RawHookEvent]) -> HookTreeNode {
    let first_ts = events
        .first()
        .and_then(|e| e.ts.clone())
        .unwrap_or_default();
    let short_ts = first_ts.get(11..16).unwrap_or(&first_ts);
    let short_id = if session_id.len() > 8 {
        &session_id[..8]
    } else {
        session_id
    };

    let model_label = capitalize(model);

    let mut children: Vec<HookTreeNode> = Vec::new();
    let mut current_prompt_idx: Option<usize> = None;
    let mut subagent_stack: Vec<usize> = Vec::new();
    let mut counter: usize = 0;

    for ev in events {
        counter += 1;
        let event_name = ev.event.as_deref().unwrap_or("Unknown");
        let ts = ev.ts.as_deref().unwrap_or("");

        match event_name {
            "SessionStart" => {
                children.push(HookTreeNode {
                    id: format!("{session_id}-{counter}"),
                    node_type: "event".into(),
                    label: "SessionStart".into(),
                    timestamp: ts.into(),
                    status: "info".into(),
                    detail: String::new(),
                    raw: String::new(),
                    model: String::new(),
                    children: vec![],
                });
            }
            "SessionEnd" | "Stop" => {
                if event_name == "Stop" && current_prompt_idx.is_some() {
                    let node = HookTreeNode {
                        id: format!("{session_id}-{counter}"),
                        node_type: "event".into(),
                        label: "Stop".into(),
                        timestamp: ts.into(),
                        status: "info".into(),
                        detail: String::new(),
                        raw: String::new(),
                        model: String::new(),
                        children: vec![],
                    };
                    push_to_active_parent(
                        &mut children,
                        current_prompt_idx,
                        &subagent_stack,
                        node,
                    );
                }
                if event_name == "SessionEnd" {
                    current_prompt_idx = None;
                    subagent_stack.clear();
                    children.push(HookTreeNode {
                        id: format!("{session_id}-{counter}"),
                        node_type: "event".into(),
                        label: "SessionEnd".into(),
                        timestamp: ts.into(),
                        status: "info".into(),
                        detail: String::new(),
                        raw: String::new(),
                        model: String::new(),
                        children: vec![],
                    });
                }
            }
            "UserPromptSubmit" => {
                subagent_stack.clear();
                let prompt_text = ev.prompt.as_deref().unwrap_or("");
                let short_prompt = truncate(prompt_text, 40);
                children.push(HookTreeNode {
                    id: format!("{session_id}-{counter}"),
                    node_type: "prompt".into(),
                    label: short_prompt,
                    timestamp: ts.into(),
                    status: "info".into(),
                    detail: prompt_text.to_string(),
                    raw: String::new(),
                    model: String::new(),
                    children: vec![],
                });
                current_prompt_idx = Some(children.len() - 1);
            }
            "PreToolUse" => {
                let tool = ev.tool_name.as_deref().unwrap_or("Tool");
                let input_summary = summarize_tool_input(tool, &ev.tool_input);
                let detail = build_tool_detail(tool, &ev.tool_input, &None, &None);
                let raw = build_raw_json(&ev.tool_input, &None);
                let node = HookTreeNode {
                    id: ev
                        .tool_use_id
                        .clone()
                        .unwrap_or_else(|| format!("{session_id}-{counter}")),
                    node_type: if tool == "Task" {
                        "subagent".into()
                    } else {
                        "tool".into()
                    },
                    label: format!("{tool}  {input_summary}"),
                    timestamp: ts.into(),
                    status: "info".into(),
                    detail,
                    raw,
                    model: String::new(),
                    children: vec![],
                };
                push_to_active_parent(
                    &mut children,
                    current_prompt_idx,
                    &subagent_stack,
                    node,
                );
            }
            "PostToolUse" | "PostToolUseFailure" => {
                let tool_use_id = ev.tool_use_id.as_deref().unwrap_or("");
                let status = if event_name == "PostToolUseFailure" {
                    "failure".to_string()
                } else {
                    tool_status(&ev.tool_response)
                };
                let tool = ev.tool_name.as_deref().unwrap_or("Tool");
                let detail =
                    build_tool_detail(tool, &ev.tool_input, &ev.tool_response, &ev.error);
                let raw = build_raw_json(&ev.tool_input, &ev.tool_response);
                if !tool_use_id.is_empty() {
                    update_node_on_post(&mut children, tool_use_id, &status, &detail, &raw);
                }
            }
            "SubagentStart" => {
                let parent = navigate_to_parent(
                    &mut children,
                    current_prompt_idx,
                    &subagent_stack,
                );
                let idx = parent.len().saturating_sub(1);
                subagent_stack.push(idx);
            }
            "SubagentStop" => {
                if let Some(idx) = subagent_stack.pop() {
                    let parent = navigate_to_parent(
                        &mut children,
                        current_prompt_idx,
                        &subagent_stack,
                    );
                    if let Some(node) = parent.get_mut(idx) {
                        node.children.push(HookTreeNode {
                            id: format!("{session_id}-{counter}"),
                            node_type: "event".into(),
                            label: "SubagentStop".into(),
                            timestamp: ts.into(),
                            status: "info".into(),
                            detail: String::new(),
                            raw: String::new(),
                            model: String::new(),
                            children: vec![],
                        });
                    }
                }
            }
            _ => {
                let node = HookTreeNode {
                    id: format!("{session_id}-{counter}"),
                    node_type: "event".into(),
                    label: event_name.into(),
                    timestamp: ts.into(),
                    status: "info".into(),
                    detail: String::new(),
                    raw: String::new(),
                    model: String::new(),
                    children: vec![],
                };
                if current_prompt_idx.is_some() {
                    push_to_active_parent(
                        &mut children,
                        current_prompt_idx,
                        &subagent_stack,
                        node,
                    );
                } else {
                    children.push(node);
                }
            }
        }
    }

    HookTreeNode {
        id: session_id.into(),
        node_type: "session".into(),
        label: format!("[{model_label}] Session {short_id} ({short_ts})"),
        timestamp: first_ts,
        status: "info".into(),
        detail: session_id.into(),
        raw: String::new(),
        model: model.to_string(),
        children,
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().to_string() + c.as_str(),
    }
}

fn push_to_active_parent(
    children: &mut Vec<HookTreeNode>,
    prompt_idx: Option<usize>,
    subagent_stack: &[usize],
    node: HookTreeNode,
) {
    let target = navigate_to_parent(children, prompt_idx, subagent_stack);
    target.push(node);
}

fn navigate_to_parent<'a>(
    children: &'a mut Vec<HookTreeNode>,
    prompt_idx: Option<usize>,
    subagent_stack: &[usize],
) -> &'a mut Vec<HookTreeNode> {
    let mut path: Vec<usize> = Vec::new();
    if let Some(pidx) = prompt_idx {
        if pidx < children.len() {
            path.push(pidx);
            for &sidx in subagent_stack {
                path.push(sidx);
            }
        }
    }

    if path.is_empty() {
        return children;
    }

    let mut current = children;
    for &idx in &path {
        if idx >= current.len() {
            return current;
        }
        current = &mut current[idx].children;
    }
    current
}

/// Update status, merge detail, and merge raw for a matched tool_use_id node.
fn update_node_on_post(
    nodes: &mut [HookTreeNode],
    tool_use_id: &str,
    status: &str,
    post_detail: &str,
    post_raw: &str,
) {
    for node in nodes.iter_mut() {
        if node.id == tool_use_id {
            node.status = status.into();
            node.detail = merge_detail_json(&node.detail, post_detail);
            node.raw = merge_detail_json(&node.raw, post_raw);
            return;
        }
        update_node_on_post(&mut node.children, tool_use_id, status, post_detail, post_raw);
    }
}

/// Merge two JSON object strings, with `b` fields added to `a`.
fn merge_detail_json(a: &str, b: &str) -> String {
    let mut base: serde_json::Map<String, serde_json::Value> = if a.is_empty() {
        serde_json::Map::new()
    } else {
        serde_json::from_str(a).unwrap_or_default()
    };
    if let Ok(extra) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(b) {
        for (k, v) in extra {
            // Don't overwrite "tool" key from pre (already set)
            if k == "tool" && base.contains_key("tool") {
                continue;
            }
            base.insert(k, v);
        }
    }
    serde_json::to_string(&serde_json::Value::Object(base)).unwrap_or_default()
}

/// Build a JSON detail string for a tool node.
fn build_tool_detail(
    tool: &str,
    input: &Option<serde_json::Value>,
    response: &Option<serde_json::Value>,
    error: &Option<String>,
) -> String {
    let mut map = serde_json::Map::new();
    map.insert("tool".into(), serde_json::Value::String(tool.into()));

    if let Some(inp) = input {
        // For tool_input, include relevant fields depending on tool type.
        match tool {
            "Bash" => {
                if let Some(cmd) = inp.get("command").and_then(|v| v.as_str()) {
                    map.insert("command".into(), serde_json::Value::String(cmd.into()));
                }
            }
            "Read" | "Write" | "Edit" => {
                if let Some(fp) = inp.get("file_path").and_then(|v| v.as_str()) {
                    map.insert("file_path".into(), serde_json::Value::String(fp.into()));
                }
                if let Some(old) = inp.get("old_string").and_then(|v| v.as_str()) {
                    map.insert(
                        "old_string".into(),
                        serde_json::Value::String(truncate(old, 200)),
                    );
                }
                if let Some(new) = inp.get("new_string").and_then(|v| v.as_str()) {
                    map.insert(
                        "new_string".into(),
                        serde_json::Value::String(truncate(new, 200)),
                    );
                }
            }
            "Grep" => {
                if let Some(pat) = inp.get("pattern").and_then(|v| v.as_str()) {
                    map.insert("pattern".into(), serde_json::Value::String(pat.into()));
                }
                if let Some(p) = inp.get("path").and_then(|v| v.as_str()) {
                    map.insert("path".into(), serde_json::Value::String(p.into()));
                }
            }
            "Glob" => {
                if let Some(pat) = inp.get("pattern").and_then(|v| v.as_str()) {
                    map.insert("pattern".into(), serde_json::Value::String(pat.into()));
                }
            }
            "Task" => {
                if let Some(desc) = inp.get("description").and_then(|v| v.as_str()) {
                    map.insert("description".into(), serde_json::Value::String(desc.into()));
                }
                if let Some(st) = inp.get("subagent_type").and_then(|v| v.as_str()) {
                    map.insert(
                        "subagent_type".into(),
                        serde_json::Value::String(st.into()),
                    );
                }
                if let Some(prompt) = inp.get("prompt").and_then(|v| v.as_str()) {
                    map.insert(
                        "prompt".into(),
                        serde_json::Value::String(truncate(prompt, 500)),
                    );
                }
            }
            _ => {
                // Fallback: include raw input (truncated).
                let raw = serde_json::to_string(inp).unwrap_or_default();
                map.insert(
                    "input".into(),
                    serde_json::Value::String(truncate(&raw, 300)),
                );
            }
        }
    }

    if let Some(resp) = response {
        // For response, extract key fields.
        if let Some(code) = resp.get("exit_code").and_then(|v| v.as_i64()) {
            map.insert("exit_code".into(), serde_json::Value::Number(code.into()));
        }
        if let Some(stdout) = resp.get("stdout").and_then(|v| v.as_str()) {
            map.insert(
                "stdout".into(),
                serde_json::Value::String(truncate(stdout, 500)),
            );
        }
        if let Some(stderr) = resp.get("stderr").and_then(|v| v.as_str()) {
            map.insert(
                "stderr".into(),
                serde_json::Value::String(truncate(stderr, 300)),
            );
        }
    }

    if let Some(err) = error {
        map.insert("error".into(), serde_json::Value::String(err.clone()));
    }

    serde_json::to_string(&serde_json::Value::Object(map)).unwrap_or_default()
}

/// Build a JSON string with raw tool_input and tool_response (values truncated).
fn build_raw_json(
    input: &Option<serde_json::Value>,
    response: &Option<serde_json::Value>,
) -> String {
    let mut map = serde_json::Map::new();
    if let Some(inp) = input {
        let s = serde_json::to_string_pretty(inp).unwrap_or_default();
        map.insert(
            "tool_input".into(),
            serde_json::Value::String(truncate(&s, 2000)),
        );
    }
    if let Some(resp) = response {
        let s = serde_json::to_string_pretty(resp).unwrap_or_default();
        map.insert(
            "tool_response".into(),
            serde_json::Value::String(truncate(&s, 2000)),
        );
    }
    if map.is_empty() {
        return String::new();
    }
    serde_json::to_string(&serde_json::Value::Object(map)).unwrap_or_default()
}

fn summarize_tool_input(tool: &str, input: &Option<serde_json::Value>) -> String {
    let Some(val) = input else {
        return String::new();
    };
    match tool {
        "Bash" => val
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| truncate(s, 60))
            .unwrap_or_default(),
        "Read" | "Write" | "Edit" => val
            .get("file_path")
            .and_then(|v| v.as_str())
            .map(short_path)
            .unwrap_or_default(),
        "Grep" => val
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(|s| format!("\"{s}\""))
            .unwrap_or_default(),
        "Glob" => val
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default(),
        "Task" => val
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| truncate(s, 50))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Find a char-safe boundary at or before `max`.
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &s[..end])
}

fn short_path(s: &str) -> String {
    let p = std::path::Path::new(s);
    p.file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| s.to_string())
}

fn tool_status(response: &Option<serde_json::Value>) -> String {
    let Some(val) = response else {
        return "info".into();
    };
    if let Some(code) = val.get("exit_code").and_then(|v| v.as_i64()) {
        return if code == 0 {
            "success".into()
        } else {
            "failure".into()
        };
    }
    if val.get("error").is_some() {
        return "failure".into();
    }
    "success".into()
}

pub fn clear_hook_log() -> Result<(), String> {
    let dir = sessions_dir();
    if !dir.exists() {
        return Ok(());
    }
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_events(lines: &[&str]) -> Vec<RawHookEvent> {
        lines
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn parse_empty_returns_empty() {
        let events: Vec<RawHookEvent> = vec![];
        let node = build_session_node("test", "claude", &events);
        assert_eq!(node.node_type, "session");
        assert!(node.children.is_empty());
    }

    #[test]
    fn parse_single_session() {
        let lines = vec![
            r#"{"ts":"2026-02-22T14:47:00Z","event":"SessionStart","session_id":"abc-123","model":"claude","project":"test"}"#,
            r#"{"ts":"2026-02-22T14:47:05Z","event":"UserPromptSubmit","session_id":"abc-123","model":"claude","prompt":"fix bug"}"#,
            r#"{"ts":"2026-02-22T14:47:10Z","event":"PreToolUse","session_id":"abc-123","model":"claude","tool_name":"Read","tool_use_id":"t1","tool_input":{"file_path":"src/main.rs"}}"#,
            r#"{"ts":"2026-02-22T14:47:11Z","event":"PostToolUse","session_id":"abc-123","model":"claude","tool_name":"Read","tool_use_id":"t1","tool_response":{}}"#,
            r#"{"ts":"2026-02-22T14:47:30Z","event":"SessionEnd","session_id":"abc-123","model":"claude"}"#,
        ];
        let events = make_events(&lines);
        let session = build_session_node("abc-123", "claude", &events);
        assert_eq!(session.node_type, "session");
        assert_eq!(session.model, "claude");
        assert!(session.label.contains("[Claude]"));
        assert_eq!(session.children.len(), 3);
        assert_eq!(session.children[0].label, "SessionStart");
        assert_eq!(session.children[1].node_type, "prompt");
        assert_eq!(session.children[1].label, "fix bug");
        assert_eq!(session.children[1].children.len(), 1);
        assert_eq!(session.children[1].children[0].node_type, "tool");
        assert_eq!(session.children[1].children[0].status, "success");
        let detail: serde_json::Value =
            serde_json::from_str(&session.children[1].children[0].detail).unwrap();
        assert_eq!(detail["file_path"], "src/main.rs");
        assert_eq!(session.children[2].label, "SessionEnd");
    }

    #[test]
    fn tool_pairing_failure() {
        let lines = vec![
            r#"{"ts":"2026-02-22T14:47:10Z","event":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_use_id":"t2","tool_input":{"command":"cargo test"}}"#,
            r#"{"ts":"2026-02-22T14:47:11Z","event":"PostToolUse","session_id":"s1","tool_name":"Bash","tool_use_id":"t2","tool_response":{"exit_code":1}}"#,
        ];
        let events = make_events(&lines);
        let session = build_session_node("s1", "claude", &events);
        let tool = &session.children[0];
        assert_eq!(tool.status, "failure");
        let detail: serde_json::Value = serde_json::from_str(&tool.detail).unwrap();
        assert_eq!(detail["command"], "cargo test");
        assert_eq!(detail["exit_code"], 1);
    }

    #[test]
    fn post_tool_use_failure_event() {
        let lines = vec![
            r#"{"ts":"T","event":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_use_id":"t3","tool_input":{"command":"npx playwright test"}}"#,
            r#"{"ts":"T","event":"PostToolUseFailure","session_id":"s1","tool_name":"Bash","tool_use_id":"t3","tool_input":{"command":"npx playwright test"},"error":"timeout"}"#,
        ];
        let events = make_events(&lines);
        let session = build_session_node("s1", "claude", &events);
        let tool = &session.children[0];
        assert_eq!(tool.status, "failure");
        let detail: serde_json::Value = serde_json::from_str(&tool.detail).unwrap();
        assert_eq!(detail["error"], "timeout");
    }

    #[test]
    fn truncate_multibyte_safe() {
        let korean = "세션하위프롬프트그아래";
        let result = truncate(korean, 5);
        assert!(result.ends_with("..."));
        let _ = result.len();
        assert_eq!(truncate("hello world", 5), "hello...");
        assert_eq!(truncate("hi", 5), "hi");
    }

    #[test]
    fn subagent_nesting() {
        let lines = vec![
            r#"{"ts":"T","event":"UserPromptSubmit","session_id":"s1","prompt":"test"}"#,
            r#"{"ts":"T","event":"PreToolUse","session_id":"s1","tool_name":"Task","tool_use_id":"sub1","tool_input":{"description":"Explore"}}"#,
            r#"{"ts":"T","event":"SubagentStart","session_id":"s1"}"#,
            r#"{"ts":"T","event":"PreToolUse","session_id":"s1","tool_name":"Grep","tool_use_id":"g1","tool_input":{"pattern":"foo"}}"#,
            r#"{"ts":"T","event":"PostToolUse","session_id":"s1","tool_name":"Grep","tool_use_id":"g1","tool_response":{}}"#,
            r#"{"ts":"T","event":"SubagentStop","session_id":"s1"}"#,
            r#"{"ts":"T","event":"PostToolUse","session_id":"s1","tool_name":"Task","tool_use_id":"sub1","tool_response":{}}"#,
        ];
        let events = make_events(&lines);
        let session = build_session_node("s1", "claude", &events);
        let prompt = &session.children[0];
        assert_eq!(prompt.node_type, "prompt");
        let task_node = &prompt.children[0];
        assert_eq!(task_node.node_type, "subagent");
        assert_eq!(task_node.status, "success");
        assert_eq!(task_node.children.len(), 2);
        assert_eq!(task_node.children[0].node_type, "tool");
        assert_eq!(task_node.children[1].label, "SubagentStop");
    }

    #[test]
    fn model_label_in_session() {
        let events: Vec<RawHookEvent> = vec![];
        let node = build_session_node("abc-12345678", "gemini", &events);
        assert_eq!(node.model, "gemini");
        assert!(node.label.contains("[Gemini]"));
    }

    #[test]
    fn parse_filename_new_format() {
        let (model, sid) = parse_filename("2026-02-22_claude_84ba0c70-1250-4f3d").unwrap();
        assert_eq!(model, "claude");
        assert_eq!(sid, "84ba0c70-1250-4f3d");
    }

    #[test]
    fn parse_filename_legacy_format() {
        let (model, sid) = parse_filename("claude_84ba0c70-1250-4f3d").unwrap();
        assert_eq!(model, "claude");
        assert_eq!(sid, "84ba0c70-1250-4f3d");
    }

    #[test]
    fn parse_filename_invalid() {
        assert!(parse_filename("nounderscorefile").is_none());
        assert!(parse_filename("_nosid").is_none());
        assert!(parse_filename("nomodel_").is_none());
    }

    #[test]
    fn dir_scan_with_tempdir() {
        let tmp = std::env::temp_dir().join("racemo_hooklog_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Write two session files (new YYYY-MM-DD format)
        let f1 = tmp.join("2026-02-22_claude_sess-001.jsonl");
        let f2 = tmp.join("2026-02-22_gemini_sess-002.jsonl");
        std::fs::write(
            &f1,
            r#"{"ts":"2026-02-22T10:00:00Z","event":"SessionStart","session_id":"sess-001","model":"claude"}"#.to_string() + "\n",
        ).unwrap();
        std::fs::write(
            &f2,
            r#"{"ts":"2026-02-22T11:00:00Z","event":"SessionStart","session_id":"sess-002","model":"gemini"}"#.to_string() + "\n",
        ).unwrap();

        // Read and verify
        let entries: Vec<_> = std::fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|entry| {
                let path = entry.path();
                let stem = path.file_stem()?.to_str()?;
                let (model, session_id) = parse_filename(stem)?;
                let buf = std::fs::read_to_string(&path).ok()?;
                let events = parse_events(&buf);
                Some(build_session_node(&session_id, &model, &events))
            })
            .collect();

        assert_eq!(entries.len(), 2);
        let models: Vec<&str> = entries.iter().map(|n| n.model.as_str()).collect();
        assert!(models.contains(&"claude"));
        assert!(models.contains(&"gemini"));

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn auto_archive_moves_old_files() {
        let tmp = std::env::temp_dir().join("racemo_archive_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let archive = tmp.join("archive");

        // Create a "recent" file
        let recent = tmp.join("2026-02-22_claude_recent.jsonl");
        std::fs::write(&recent, r#"{"ts":"T","event":"SessionStart"}"#).unwrap();

        // Create an "old" file and set mtime to 31 days ago
        let old = tmp.join("2026-01-01_claude_old.jsonl");
        std::fs::write(&old, r#"{"ts":"T","event":"SessionStart"}"#).unwrap();

        // Set old file mtime to 31 days ago using filetime
        let old_time = std::time::SystemTime::now()
            - std::time::Duration::from_secs(31 * 24 * 60 * 60);
        // Use a helper to set mtime (open + set_modified doesn't exist in std)
        // Instead, we directly test the archive logic inline
        let cutoff = std::time::SystemTime::now()
            - std::time::Duration::from_secs(ARCHIVE_DAYS * 24 * 60 * 60);

        // Simulate: manually set mtime by writing old modification time
        // Since we can't easily set mtime in pure std, we test the logic directly
        {
            let f = std::fs::OpenOptions::new()
                .write(true)
                .open(&old)
                .unwrap();
            f.set_modified(old_time).unwrap();
        }

        // Run archive logic inline (same as auto_archive_old_sessions but on tmp dir)
        let entries = std::fs::read_dir(&tmp).unwrap();
        let mut archive_created = false;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = entry.metadata().unwrap().modified().unwrap();
            if mtime < cutoff {
                if !archive_created {
                    std::fs::create_dir_all(&archive).unwrap();
                    archive_created = true;
                }
                let dest = archive.join(path.file_name().unwrap());
                std::fs::rename(&path, &dest).unwrap();
            }
        }

        // Verify: recent file stays, old file moved to archive
        assert!(recent.exists(), "recent file should still be in sessions/");
        assert!(!old.exists(), "old file should have been moved");
        assert!(
            archive.join("2026-01-01_claude_old.jsonl").exists(),
            "old file should be in archive/"
        );

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
