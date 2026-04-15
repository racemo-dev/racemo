export interface GeminiHistoryEntry {
  tag: string;
  display: string;
  timestamp: number;
  project_hash: string;
  project_label: string;
}

export interface GeminiSessionMessage {
  role: string;
  content: string;
  tool_name: string;
  model: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
}
