export const SHELL_LABELS: Record<string, string> = {
  PowerShell: "PowerShell",
  Cmd: "CMD",
  Wsl: "WSL",
  Zsh: "Zsh",
  Bash: "Bash",
  Fish: "Fish",
};

export interface RemoteTerminalPaneProps {
  paneId: string;
  remotePaneId: string;
  shell?: string;
}
