export interface ClaudeHistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  session_id: string;
  project_label: string;
}

export interface ToolUseDetail {
  name: string;
  detail: string;
}

export interface ClaudeSessionMessage {
  role: string;
  content: string;
  tool_uses: ToolUseDetail[];
  model: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
}
