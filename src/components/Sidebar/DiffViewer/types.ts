// ── Types ────────────────────────────────────────────────────

export interface DiffLine {
  oldNum: number | null;
  newNum: number | null;
  content: string;
  type: "context" | "add" | "remove";
}

/** Hunk range from the default (3-line context) diff — used for discard. */
export interface StructureHunk {
  hunkIndex: number;
  oldStart: number;
  oldEnd: number; // exclusive
  newStart: number;
  newEnd: number; // exclusive
}

export type RenderItem =
  | { kind: "line"; line: DiffLine }
  | { kind: "changeMarker"; structHunk: StructureHunk };
