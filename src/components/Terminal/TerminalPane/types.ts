export const SHELL_LABELS: Record<string, string> = {
  PowerShell: "PowerShell",
  Cmd: "CMD",
  Wsl: "WSL",
  Zsh: "Zsh",
  Bash: "Bash",
  Fish: "Fish",
};

export interface PtyExitPayload {
  pane_id: string;
}

export interface TerminalPaneProps {
  paneId: string;
  ptyId: string;
  initialCwd?: string;
  lastCommand?: string;
}
