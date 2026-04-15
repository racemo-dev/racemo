export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

export type InlineInputMode = "new-file" | "new-dir" | "rename";

export interface InlineInputState {
  mode: InlineInputMode;
  parentPath: string;
  originalName?: string; // rename only
}

export interface DirTreeProps {
  entry: DirEntry;
  parentPath: string;
  depth: number;
  repoRoot: string | null;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  inlineInput: InlineInputState | null;
  inlineValue: string;
  inlineRef: React.RefObject<HTMLInputElement | null>;
  setInlineValue: (v: string) => void;
  commitInlineInput: () => void;
  cancelInlineInput: () => void;
  openDirs: Set<string>;
  onToggleDir: (path: string) => void;
  focusedPath: string;
  onFocus: (path: string) => void;
  childrenMap: Map<string, DirEntry[]>;
  docsFilter?: boolean;
  docsDirCache?: Map<string, boolean>;
  onCheckDirDocs?: (paths: string[]) => void;
}

export interface DocTreeNode {
  name: string;
  fullPath: string;
  children: DocTreeNode[];
  isDir: boolean;
}
