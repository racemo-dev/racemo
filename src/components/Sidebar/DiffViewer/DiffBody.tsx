import React from "react";
import type { TranslationKey } from "../../../lib/i18n/git";
import type { DiffLine, RenderItem } from "./types";
import { lineHCss, NUM_W } from "./constants";
import { InlineLine } from "./InlineLine";
import { ChangeMarker } from "./ChangeMarker";

interface DiffBodyProps {
  items: RenderItem[];
  syntheticDiscardedIndices: Set<number>;
  collapsedHunks: Set<number>;
  onDiscardHunk: (hunkIndex: number) => void;
  onConfirmHunk: (hunkIndex: number) => void;
  onExpandHunk: (hunkIndex: number) => void;
  onUndoDiscard: (syntheticIdx: number) => void;
  t: (key: TranslationKey) => string;
}

export function DiffBody({
  items,
  syntheticDiscardedIndices,
  collapsedHunks,
  onDiscardHunk,
  onConfirmHunk,
  onExpandHunk,
  onUndoDiscard,
  t,
}: DiffBodyProps) {
  const nodes: React.ReactNode[] = [];
  let currentHunkIdx = -1;
  let isCollapsed = false;
  let isDiscarded = false;
  const shownBtn = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "changeMarker") {
      currentHunkIdx = item.structHunk.hunkIndex;
      isDiscarded = syntheticDiscardedIndices.has(currentHunkIdx);
      isCollapsed = isDiscarded || collapsedHunks.has(currentHunkIdx);
      const idx = currentHunkIdx; // snapshot for closure
      nodes.push(
        <ChangeMarker
          key={`m-${i}`}
          onDiscard={idx >= 0 && !isDiscarded ? () => onDiscardHunk(idx) : undefined}
          onConfirm={idx >= 0 && !isDiscarded ? () => onConfirmHunk(idx) : undefined}
          confirmed={isCollapsed}
          discardLabel={t("diff.discard")}
          discardTitle={t("diff.discardTitle")}
          confirmLabel={t("diff.confirm")}
          confirmTitle={t("diff.confirmTitle")}
        />
      );
    } else if (!isCollapsed) {
      nodes.push(<InlineLine key={i} line={item.line} />);
    } else if (item.line.type === "remove") {
      // collapsed/discarded: remove lines hidden
    } else if (item.line.type === "add") {
      // collapsed/discarded: add lines shown with button
      const isFirst = !shownBtn.has(currentHunkIdx);
      if (isFirst) shownBtn.add(currentHunkIdx);
      const hunkIdxForBtn = currentHunkIdx;
      const hunkDiscarded = isDiscarded;
      nodes.push(
        <CollapsedAddLine
          key={i}
          line={item.line}
          isFirst={isFirst}
          hunkDiscarded={hunkDiscarded}
          hunkIdxForBtn={hunkIdxForBtn}
          onUndoDiscard={onUndoDiscard}
          onExpandHunk={onExpandHunk}
          t={t}
        />
      );
    } else {
      // collapsed/discarded: context lines shown as-is
      nodes.push(<InlineLine key={i} line={item.line} />);
    }
  }

  return <>{nodes}</>;
}

// ── Collapsed add-line sub-component ──

function CollapsedAddLine({
  line,
  isFirst,
  hunkDiscarded,
  hunkIdxForBtn,
  onUndoDiscard,
  onExpandHunk,
  t,
}: {
  line: DiffLine;
  isFirst: boolean;
  hunkDiscarded: boolean;
  hunkIdxForBtn: number;
  onUndoDiscard: (idx: number) => void;
  onExpandHunk: (idx: number) => void;
  t: (key: TranslationKey) => string;
}) {
  return (
    <div
      className="group flex relative"
      style={{
        background: hunkDiscarded ? "color-mix(in srgb, var(--accent-yellow) 8%, transparent)" : "color-mix(in srgb, var(--status-active) 8%, transparent)",
        minHeight: lineHCss,
        height: lineHCss,
        whiteSpace: "pre",
        minWidth: "100%",
        width: "fit-content",
        borderLeft: `2px solid ${hunkDiscarded ? "color-mix(in srgb, var(--accent-yellow) 35%, transparent)" : "color-mix(in srgb, var(--status-active) 35%, transparent)"}`,
      }}
    >
      <span style={{ width: NUM_W, minWidth: NUM_W, textAlign: "right", paddingRight: 4, color: "var(--text-muted)", opacity: 0.3, fontSize: 'var(--fs-12)', lineHeight: lineHCss }}>
        {line.oldNum ?? ""}
      </span>
      <span style={{ width: NUM_W, minWidth: NUM_W, textAlign: "right", paddingRight: 6, color: "var(--text-muted)", opacity: 0.3, userSelect: "none", fontSize: 'var(--fs-12)', lineHeight: lineHCss, borderRight: "1px solid var(--border-subtle)" }}>
        {line.newNum ?? ""}
      </span>
      <span style={{ width: 16, minWidth: 16, textAlign: "center", color: hunkDiscarded ? "var(--text-muted)" : "var(--status-active)", fontWeight: 700, userSelect: "none", lineHeight: lineHCss, fontSize: 'var(--fs-14)', textDecoration: hunkDiscarded ? "line-through" : undefined }}>
        {hunkDiscarded ? "\u2212" : "+"}
      </span>
      <span style={{ color: hunkDiscarded ? "var(--text-muted)" : "var(--status-active)", paddingRight: 12, lineHeight: lineHCss, textDecoration: hunkDiscarded ? "line-through" : undefined, opacity: hunkDiscarded ? 0.5 : 1 }}>
        {line.content}
      </span>
      {isFirst && (
        <span
          className="absolute right-2 top-0 flex items-center"
          style={{ height: lineHCss }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (hunkDiscarded) onUndoDiscard(hunkIdxForBtn);
              else onExpandHunk(hunkIdxForBtn);
            }}
            style={{ fontSize: 'var(--fs-11)', color: hunkDiscarded ? "var(--accent-blue)" : "var(--accent-yellow)", background: "transparent", border: "none", cursor: "pointer", lineHeight: "normal", padding: "1px 5px", borderRadius: 3 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = hunkDiscarded ? "color-mix(in srgb, var(--accent-blue) 10%, transparent)" : "color-mix(in srgb, var(--accent-yellow) 10%, transparent)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            title={hunkDiscarded ? t("diff.undoDiscardTitle") : t("diff.undoConfirmTitle")}
          >
            {hunkDiscarded ? t("diff.undoDiscard") : t("diff.undoConfirm")}
          </button>
        </span>
      )}
    </div>
  );
}
