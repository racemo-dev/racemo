export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "discarded";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
  staged: boolean;
}

export interface GitRepoInfo {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  isDetached: boolean;
}

export interface GitFileStatuses {
  repoRoot: string;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
}

export interface GitCommitEntry {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
  relativeTime: string;
  parents: string[];
  refs: string[];
}

export interface GitCommitFile {
  path: string;
  status: string; // "M", "A", "D", "R"
}

export interface GitCommitDetail {
  hash: string;
  fullHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
  files: GitCommitFile[];
}

export interface GitRefList {
  localBranches: string[];
  remoteBranches: string[];
  tags: string[];
  stashes: string[];
  currentBranch: string;
}

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch: string;
  isBare: boolean;
  isMain: boolean;
  isLocked: boolean;
  isDirty: boolean;
}

export interface GitCommandLogEntry {
  timestamp: number;
  command: string;
  success: boolean;
  output: string;
  durationMs: number;
}
