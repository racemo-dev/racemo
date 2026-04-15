import type { DiffLine, StructureHunk } from "./types";

// ── Parsing ──────────────────────────────────────────────────

/** Parse unified diff into inline lines (old/new line numbers + type). */
export function parseUnifiedLines(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNum = parseInt(m[1], 10);
        newNum = parseInt(m[2], 10);
      }
    } else if (
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      // skip headers
    } else if (line.startsWith("-")) {
      lines.push({ oldNum, newNum: null, content: line.slice(1), type: "remove" });
      oldNum++;
    } else if (line.startsWith("+")) {
      lines.push({ oldNum: null, newNum, content: line.slice(1), type: "add" });
      newNum++;
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      if (oldNum > 0 || newNum > 0) {
        lines.push({ oldNum, newNum, content, type: "context" });
        oldNum++;
        newNum++;
      }
    }
  }
  return lines;
}

/** Parse the default-context diff to extract hunk line ranges. */
export function parseStructureHunks(raw: string): StructureHunk[] {
  const hunks: StructureHunk[] = [];
  let idx = -1;
  let oldLine = 0;
  let newLine = 0;
  let oldStart = 0;
  let newStart = 0;

  function pushCurrent() {
    if (idx >= 0) {
      hunks.push({ hunkIndex: idx, oldStart, oldEnd: oldLine, newStart, newEnd: newLine });
    }
  }

  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      pushCurrent();
      idx++;
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        oldStart = parseInt(m[1], 10);
        oldLine = oldStart;
        newStart = parseInt(m[3], 10);
        newLine = newStart;
      }
    } else if (line.startsWith("-")) {
      oldLine++;
    } else if (line.startsWith("+")) {
      newLine++;
    } else if (!line.startsWith("diff ") && !line.startsWith("index ") && !line.startsWith("---") && !line.startsWith("+++")) {
      oldLine++;
      newLine++;
    }
  }
  pushCurrent();
  return hunks;
}

/** Find which structure hunk a given line belongs to. */
export function findStructHunk(
  structHunks: StructureHunk[],
  oldLineNum: number | null,
  newLineNum: number | null,
): StructureHunk | null {
  if (oldLineNum != null) {
    for (const h of structHunks) {
      if (oldLineNum >= h.oldStart && oldLineNum < h.oldEnd) return h;
    }
  }
  if (newLineNum != null) {
    for (const h of structHunks) {
      if (newLineNum >= h.newStart && newLineNum < h.newEnd) return h;
    }
  }
  return null;
}
