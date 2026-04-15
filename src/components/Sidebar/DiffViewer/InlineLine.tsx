import type { DiffLine } from "./types";
import { BG, FG, LINE_H, NUM_W } from "./constants";

export function InlineLine({ line }: { line: DiffLine }) {
  return (
    <div
      className="flex"
      style={{
        background: BG[line.type],
        minHeight: LINE_H,
        height: LINE_H,
        whiteSpace: "pre",
        minWidth: "100%",
        width: "fit-content",
      }}
    >
      {/* Old line number */}
      <span
        style={{
          width: NUM_W,
          minWidth: NUM_W,
          textAlign: "right",
          paddingRight: 4,
          color: "var(--text-muted)",
          opacity: 0.4,
          fontSize: 'var(--fs-12)',
          lineHeight: `${LINE_H}px`,
        }}
      >
        {line.oldNum ?? ""}
      </span>
      {/* New line number */}
      <span
        style={{
          width: NUM_W,
          minWidth: NUM_W,
          textAlign: "right",
          paddingRight: 6,
          color: "var(--text-muted)",
          opacity: 0.4,
          userSelect: "none",
          fontSize: 'var(--fs-12)',
          lineHeight: `${LINE_H}px`,
          borderRight: "1px solid var(--border-subtle)",
        }}
      >
        {line.newNum ?? ""}
      </span>
      {/* +/- indicator */}
      <span
        style={{
          width: 16,
          minWidth: 16,
          textAlign: "center",
          color: line.type === "remove" ? "var(--accent-red)" : line.type === "add" ? "var(--status-active)" : "transparent",
          fontWeight: 700,
          userSelect: "none",
          lineHeight: `${LINE_H}px`,
          fontSize: 'var(--fs-14)',
        }}
      >
        {line.type === "remove" ? "\u2212" : line.type === "add" ? "+" : " "}
      </span>
      {/* Content */}
      <span
        style={{
          color: FG[line.type],
          paddingRight: 12,
          lineHeight: `${LINE_H}px`,
        }}
      >
        {line.content}
      </span>
    </div>
  );
}
