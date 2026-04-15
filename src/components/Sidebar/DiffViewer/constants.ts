import type { DiffLine } from "./types";

// ── Constants ────────────────────────────────────────────────

export const LINE_H = 20;
export const MARKER_H = 24;
export const NUM_W = 40;
export const SCROLLBAR_W = 14;
export const MARKER_TRACK_W = 6;

export const BG: Record<DiffLine["type"], string> = {
  remove: "color-mix(in srgb, var(--accent-red) 13%, transparent)",
  add: "color-mix(in srgb, var(--status-active) 13%, transparent)",
  context: "transparent",
};

export const FG: Record<DiffLine["type"], string> = {
  remove: "var(--accent-red)",
  add: "var(--status-active)",
  context: "var(--text-secondary)",
};
