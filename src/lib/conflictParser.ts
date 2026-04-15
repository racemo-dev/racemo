export type FileBlock =
  | { kind: "text"; lines: string[] }
  | {
      kind: "conflict";
      id: number;
      current: { label: string; lines: string[] };
      incoming: { label: string; lines: string[] };
    };

/**
 * Parse a file with conflict markers into blocks.
 * Handles <<<<<<< / ======= / >>>>>>> markers.
 */
export function parseConflicts(content: string): FileBlock[] {
  const rawLines = content.split("\n");
  const blocks: FileBlock[] = [];
  let textBuf: string[] = [];
  let conflictId = 0;

  let inConflict = false;
  let inCurrent = false;
  let currentLabel = "";
  let currentLines: string[] = [];
  let incomingLines: string[] = [];

  const flushText = () => {
    if (textBuf.length > 0) {
      blocks.push({ kind: "text", lines: textBuf });
      textBuf = [];
    }
  };

  for (const line of rawLines) {
    if (!inConflict && line.startsWith("<<<<<<<")) {
      flushText();
      inConflict = true;
      inCurrent = true;
      currentLabel = line.slice(7).trim();
      currentLines = [];
      incomingLines = [];
    } else if (inConflict && inCurrent && line.startsWith("=======")) {
      inCurrent = false;
    } else if (inConflict && !inCurrent && line.startsWith(">>>>>>>")) {
      const incomingLabel = line.slice(7).trim();
      blocks.push({
        kind: "conflict",
        id: conflictId++,
        current: { label: currentLabel, lines: currentLines },
        incoming: { label: incomingLabel, lines: incomingLines },
      });
      inConflict = false;
    } else if (inConflict) {
      if (inCurrent) {
        currentLines.push(line);
      } else {
        incomingLines.push(line);
      }
    } else {
      textBuf.push(line);
    }
  }

  // Flush remaining text (or malformed conflict markers treated as text)
  if (inConflict) {
    // Malformed — dump everything as text
    textBuf.push(`<<<<<<< ${currentLabel}`);
    textBuf.push(...currentLines);
    textBuf.push("=======");
    textBuf.push(...incomingLines);
  }
  flushText();

  return blocks;
}

/** Count the number of conflict blocks. */
export function countConflicts(blocks: FileBlock[]): number {
  return blocks.filter((b) => b.kind === "conflict").length;
}

/** Reconstruct file content from resolved blocks. */
export function reconstructFile(blocks: FileBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      lines.push(...block.lines);
    } else {
      // Should only have text blocks after full resolution
      lines.push(...block.current.lines);
    }
  }
  return lines.join("\n");
}
