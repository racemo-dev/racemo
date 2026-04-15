/* eslint-disable react-refresh/only-export-components -- helpers file mixes components and utilities */
import {
  CaretRight,
  User,
  ChatText,
  Terminal,
  Code,
  Robot,
  Bell,
  SignOut,
  Play,
  MagnifyingGlass,
  PencilSimple,
  FileText,
} from "@phosphor-icons/react";
import type { HookTreeNode } from "../../../types/hooklog";

/* ─── Chevron ─── */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <CaretRight
      size={14}
      weight="bold"
      style={{
        width: "calc(14px * var(--ui-scale))",
        height: "calc(14px * var(--ui-scale))",
        transition: "transform 120ms ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        flexShrink: 0,
        color: "var(--text-muted)",
      }}
    />
  );
}

/* ─── Node icon (size 14 for tree, 16 for popup) ─── */
export function nodeIcon(node: HookTreeNode, size = 14) {
  const s = {
    width: `calc(${size}px * var(--ui-scale))`,
    height: `calc(${size}px * var(--ui-scale))`,
    flexShrink: 0 as const,
  };
  const { node_type: type_, label } = node;

  if (type_ === "session") return <User size={size} style={s} color="var(--accent-blue)" />;
  if (type_ === "prompt") return <ChatText size={size} style={s} color="var(--accent-purple)" />;
  if (type_ === "subagent") return <Robot size={size} style={s} color="var(--accent-cyan)" />;

  if (type_ === "tool") {
    if (label.startsWith("Bash")) return <Terminal size={size} style={s} color="var(--status-active)" />;
    if (label.startsWith("Read")) return <FileText size={size} style={s} color="var(--accent-blue)" />;
    if (label.startsWith("Edit") || label.startsWith("Write")) return <PencilSimple size={size} style={s} color="var(--accent-yellow)" />;
    if (label.startsWith("Grep") || label.startsWith("Glob")) return <MagnifyingGlass size={size} style={s} color="var(--accent-cyan)" />;
    if (label.startsWith("Task")) return <Robot size={size} style={s} color="var(--accent-cyan)" />;
    return <Code size={size} style={s} color="var(--text-muted)" />;
  }

  if (label === "SessionEnd" || label === "SubagentStop") return <SignOut size={size} style={s} color="var(--text-muted)" />;
  if (label === "SessionStart") return <Play size={size} style={s} color="var(--status-active)" />;
  return <Bell size={size} style={s} color="var(--text-muted)" />;
}

/* ─── Model badge ─── */
function modelColor(model: string): string {
  switch (model) {
    case "claude": return "var(--accent-purple)";
    case "gemini": return "var(--accent-blue)";
    case "codex": return "var(--status-active)";
    default: return "var(--text-muted)";
  }
}

export function ModelBadge({ model }: { model: string }) {
  if (!model) return null;
  return (
    <span style={{
      fontSize: "var(--fs-10)",
      color: "var(--bg-base)",
      background: modelColor(model),
      borderRadius: 3,
      padding: "1px 5px",
      fontWeight: 600,
      textTransform: "capitalize",
      flexShrink: 0,
    }}>
      {model}
    </span>
  );
}

/* ─── Status helpers ─── */
export function statusColor(status: string): string | undefined {
  if (status === "success") return "var(--status-active)";
  if (status === "failure") return "var(--accent-red)";
  return undefined;
}

export function statusBadge(status: string) {
  if (status === "success")
    return (
      <span style={{ fontSize: "var(--fs-10)", color: "var(--bg-base)", background: "var(--status-active)", borderRadius: 3, padding: "1px 5px", fontWeight: 600 }}>
        OK
      </span>
    );
  if (status === "failure")
    return (
      <span style={{ fontSize: "var(--fs-10)", color: "var(--bg-base)", background: "var(--accent-red)", borderRadius: 3, padding: "1px 5px", fontWeight: 600 }}>
        ERR
      </span>
    );
  return null;
}

export function statusDot(status: string) {
  const bg = status === "success" ? "var(--status-active)" : status === "failure" ? "var(--accent-red)" : null;
  if (!bg) return null;
  return <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: bg, flexShrink: 0, marginLeft: 4 }} />;
}

/* ─── Summary field & Code block ─── */
export function CodeBlock({ content }: { content: string }) {
  return (
    <pre style={{
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      color: "var(--text-secondary)",
      fontFamily: "var(--font-mono, monospace)",
      fontSize: "var(--fs-10)",
      margin: 0,
      padding: "8px 10px",
      background: "var(--bg-elevated)",
      borderRadius: 6,
      border: "1px solid var(--border-subtle)",
      lineHeight: 1.5,
      maxHeight: 280,
      overflow: "auto",
    }}>
      {content}
    </pre>
  );
}

export function SummaryField({ label, value, mono }: { label: string; value: unknown; mono?: boolean }) {
  const displayLabel = label.replace(/_/g, " ");
  const strVal = typeof value === "string" ? value : JSON.stringify(value);
  const isMultiline = typeof strVal === "string" && (strVal.length > 80 || strVal.includes("\n"));

  return (
    <div>
      <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2, fontWeight: 600 }}>
        {displayLabel}
      </div>
      {isMultiline ? (
        <CodeBlock content={strVal} />
      ) : (
        <div style={{
          color: "var(--text-secondary)",
          fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
          fontSize: "var(--fs-11)",
          wordBreak: "break-all",
        }}>
          {strVal}
        </div>
      )}
    </div>
  );
}

/* ─── Hover timer constants ─── */
export const HOVER_SHOW_DELAY = 300;
export const HOVER_HIDE_DELAY = 500;

/* ─── Tooltip state type ─── */
export interface TooltipState { node: HookTreeNode; anchorRect: DOMRect }
