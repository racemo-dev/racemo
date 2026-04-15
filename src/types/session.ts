export type PaneNode = LeafPane | SplitPane;

export interface LeafPane {
  type: "leaf";
  id: string;
  ptyId: string;
  cwd?: string;
  shell?: ShellType;
  lastCommand?: string;
}

export interface SplitPane {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export interface Session {
  id: string;
  name: string;
  rootPane: PaneNode;
  createdAt: number;
  paneCount: number;
  isRemote?: boolean;
  /** Host OS for remote sessions: "macos" | "linux" | "windows". */
  remoteOs?: string;
}

/** Shell type for terminal selection */
export type ShellType = "PowerShell" | "Cmd" | "Wsl" | "Zsh" | "Bash" | "Fish";
