use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AiSource {
    Claude,
    Codex,
    Gemini,
    OpenCode,
}

/// Unified history list entry across all AI log sources.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiHistoryEntry {
    pub display: String,
    pub timestamp: u64,
    pub session_id: String,
    pub project_label: String,
    pub source: AiSource,
}

/// Unified session message across all AI log sources.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionMessage {
    pub role: String,
    pub content: String,
    /// Comma-separated tool names (empty string if none).
    pub tool_name: String,
    pub model: String,
    pub timestamp: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub source: AiSource,
}

// ── Claude ───────────────────────────────────────────────────────────────────

impl From<crate::claudelog::ClaudeHistoryEntry> for AiHistoryEntry {
    fn from(e: crate::claudelog::ClaudeHistoryEntry) -> Self {
        AiHistoryEntry {
            display: e.display,
            timestamp: e.timestamp,
            session_id: e.session_id,
            project_label: e.project_label,
            source: AiSource::Claude,
        }
    }
}

impl From<crate::claudelog::ClaudeSessionMessage> for AiSessionMessage {
    fn from(e: crate::claudelog::ClaudeSessionMessage) -> Self {
        let tool_name = e
            .tool_uses
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        AiSessionMessage {
            role: e.role,
            content: e.content,
            tool_name,
            model: e.model,
            timestamp: e.timestamp,
            input_tokens: e.input_tokens,
            output_tokens: e.output_tokens,
            source: AiSource::Claude,
        }
    }
}

// ── Codex ────────────────────────────────────────────────────────────────────

impl From<crate::codexlog::CodexHistoryEntry> for AiHistoryEntry {
    fn from(e: crate::codexlog::CodexHistoryEntry) -> Self {
        AiHistoryEntry {
            display: e.display,
            timestamp: e.timestamp,
            session_id: e.session_id,
            project_label: e.cwd_label,
            source: AiSource::Codex,
        }
    }
}

impl From<crate::codexlog::CodexSessionMessage> for AiSessionMessage {
    fn from(e: crate::codexlog::CodexSessionMessage) -> Self {
        AiSessionMessage {
            role: e.role,
            content: e.content,
            tool_name: e.tool_name,
            model: e.model,
            timestamp: e.timestamp,
            input_tokens: e.input_tokens,
            output_tokens: e.output_tokens,
            source: AiSource::Codex,
        }
    }
}

// ── Gemini ───────────────────────────────────────────────────────────────────

impl From<crate::geminilog::GeminiHistoryEntry> for AiHistoryEntry {
    fn from(e: crate::geminilog::GeminiHistoryEntry) -> Self {
        AiHistoryEntry {
            display: e.display,
            timestamp: e.timestamp,
            session_id: e.tag,
            project_label: e.project_label,
            source: AiSource::Gemini,
        }
    }
}

impl From<crate::geminilog::GeminiSessionMessage> for AiSessionMessage {
    fn from(e: crate::geminilog::GeminiSessionMessage) -> Self {
        AiSessionMessage {
            role: e.role,
            content: e.content,
            tool_name: e.tool_name,
            model: e.model,
            timestamp: e.timestamp,
            input_tokens: e.input_tokens,
            output_tokens: e.output_tokens,
            source: AiSource::Gemini,
        }
    }
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

impl From<crate::opencodelog::OpenCodeHistoryEntry> for AiHistoryEntry {
    fn from(e: crate::opencodelog::OpenCodeHistoryEntry) -> Self {
        AiHistoryEntry {
            display: e.display,
            timestamp: e.timestamp,
            session_id: e.session_id,
            project_label: e.project_label,
            source: AiSource::OpenCode,
        }
    }
}

impl From<crate::opencodelog::OpenCodeSessionMessage> for AiSessionMessage {
    fn from(e: crate::opencodelog::OpenCodeSessionMessage) -> Self {
        AiSessionMessage {
            role: e.role,
            content: e.content,
            tool_name: e.tool_name,
            model: e.model,
            timestamp: e.timestamp,
            input_tokens: e.input_tokens,
            output_tokens: e.output_tokens,
            source: AiSource::OpenCode,
        }
    }
}
