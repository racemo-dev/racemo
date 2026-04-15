export interface CodexHistoryEntry {
  session_id: string;
  display: string;
  timestamp: number;
  cwd: string;
  cwd_label: string;
}

export interface CodexSessionMessage {
  role: string;
  content: string;
  tool_name: string;
  model: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
}

export interface CodexSessionMeta {
  id: string;
  cwd: string;
  cli_version: string;
  model_provider: string;
  model: string;
  git_branch: string;
  git_commit: string;
}
