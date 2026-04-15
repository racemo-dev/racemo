/** Tauri event payload for streaming command output (exec_streaming / run_ai_streaming). */
export interface StreamLineEvent {
  line: string;
  is_err: boolean;
}
