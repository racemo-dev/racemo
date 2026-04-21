import type { DiffLine } from "./types";
import { BG, FG, lineHCss, NUM_W } from "./constants";

export function InlineLine({ line }: { line: DiffLine }) {
  return (
    <div
      className="flex"
      style={{
        background: BG[line.type],
        minHeight: lineHCss,
        height: lineHCss,
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
          lineHeight: lineHCss,
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
          lineHeight: lineHCss,
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
          lineHeight: lineHCss,
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
          lineHeight: lineHCss,
        }}
      >
        {line.content}
      </span>
    </div>
  );
}
