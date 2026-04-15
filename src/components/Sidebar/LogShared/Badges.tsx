/* eslint-disable react-refresh/only-export-components -- exports both badge components and helper functions */
/**
 * Badge components for AI log panels.
 */
import { hashLabelHue } from "../logUtils";

/* ─── Badge components ─── */

export function ProjectLabel({ label }: { label: string }) {
  const hue = hashLabelHue(label);
  return (
    <span
      style={{
        fontSize: "var(--fs-9)",
        color: `hsl(${hue}, 60%, 72%)`,
        background: `hsla(${hue}, 50%, 40%, 0.15)`,
        borderRadius: 3,
        padding: "0 4px",
        border: `1px solid hsla(${hue}, 50%, 50%, 0.25)`,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

export function IdBadge({ id, maxLen = 8 }: { id: string; maxLen?: number }) {
  const short = id.length > maxLen ? id.slice(0, maxLen) : id;
  return (
    <span
      title={id}
      style={{
        fontSize: "var(--fs-9)",
        color: "var(--text-muted)",
        background: "var(--bg-subtle)",
        borderRadius: 3,
        padding: "0 4px",
        border: "1px solid var(--border-default)",
        flexShrink: 0,
        whiteSpace: "nowrap",
        fontFamily: "var(--font-mono, monospace)",
        letterSpacing: "0.02em",
      }}
    >
      {short}
    </span>
  );
}

/* ─── Tool badge ─── */

const BORDER_CYAN   = "color-mix(in srgb, var(--accent-cyan) 30%, transparent)";
const BORDER_YELLOW = "color-mix(in srgb, var(--accent-yellow) 30%, transparent)";
const BORDER_RED    = "color-mix(in srgb, var(--accent-red) 30%, transparent)";
const BORDER_PURPLE = "color-mix(in srgb, var(--accent-purple) 30%, transparent)";
const BORDER_BLUE   = "color-mix(in srgb, var(--accent-blue) 30%, transparent)";

const SHARED_TOOL_COLORS: Record<string, { color: string; border: string }> = {
  // Claude tools
  Read:        { color: "var(--accent-cyan)",   border: BORDER_CYAN },
  Grep:        { color: "var(--accent-cyan)",   border: BORDER_CYAN },
  Glob:        { color: "var(--accent-cyan)",   border: BORDER_CYAN },
  Write:       { color: "var(--accent-yellow)", border: BORDER_YELLOW },
  Edit:        { color: "var(--accent-yellow)", border: BORDER_YELLOW },
  Bash:        { color: "var(--accent-red)",    border: BORDER_RED },
  Agent:       { color: "var(--accent-purple)", border: BORDER_PURPLE },
  WebFetch:    { color: "var(--accent-blue)",   border: BORDER_BLUE },
  WebSearch:   { color: "var(--accent-blue)",   border: BORDER_BLUE },
  // Codex tools
  shell_command: { color: "var(--accent-red)",    border: BORDER_RED },
  apply_patch:   { color: "var(--accent-yellow)", border: BORDER_YELLOW },
  read_file:     { color: "var(--accent-cyan)",   border: BORDER_CYAN },
  ReadFile:      { color: "var(--accent-cyan)",   border: BORDER_CYAN },
  write_file:    { color: "var(--accent-yellow)", border: BORDER_YELLOW },
  WriteFile:     { color: "var(--accent-yellow)", border: BORDER_YELLOW },
  custom_tool:   { color: "var(--accent-purple)", border: BORDER_PURPLE },
  // Gemini tools
  ShellTool:    { color: "var(--accent-red)",    border: BORDER_RED },
  shell:        { color: "var(--accent-red)",    border: BORDER_RED },
  replace:      { color: "var(--accent-yellow)", border: BORDER_YELLOW },
  Replace:      { color: "var(--accent-yellow)", border: BORDER_YELLOW },
  GoogleSearch: { color: "var(--accent-purple)", border: BORDER_PURPLE },
  // OpenCode tools
  bash:           { color: "var(--accent-red)",    border: BORDER_RED },
  edit:           { color: "var(--accent-yellow)", border: BORDER_YELLOW },
  search_files:   { color: "var(--accent-cyan)",   border: BORDER_CYAN },
  list_directory: { color: "var(--accent-cyan)",   border: BORDER_CYAN },
};

export function getToolColor(name: string): { color: string; border: string } {
  return SHARED_TOOL_COLORS[name] ?? { color: "var(--text-secondary)", border: "var(--border-subtle)" };
}

export function ToolBadge({ name }: { name: string }) {
  const { color, border } = getToolColor(name);
  return (
    <span
      style={{
        fontSize: "var(--fs-9)",
        color,
        background: "var(--bg-elevated)",
        borderRadius: 3,
        padding: "1px 4px",
        border: `1px solid ${border}`,
        whiteSpace: "nowrap",
      }}
    >
      {name}
    </span>
  );
}
