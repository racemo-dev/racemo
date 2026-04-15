export interface OpenCodeHistoryEntry {
  session_id: string;
  display: string;
  timestamp: number;
  directory: string;
  project_label: string;
}

export interface OpenCodeSessionMessage {
  role: string;
  content: string;
  tool_name: string;
  model: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
}
