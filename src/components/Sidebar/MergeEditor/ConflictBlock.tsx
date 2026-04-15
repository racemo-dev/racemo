import {
  ArrowDown,
  ArrowUp,
  ArrowsInSimple,
  Check,
} from "@phosphor-icons/react";
import type { FileBlock } from "../../../lib/conflictParser";
import { useGitT } from "../../../lib/i18n/git";
import { CURRENT_BG, CURRENT_BORDER, INCOMING_BG, INCOMING_BORDER, ICON_S } from "./constants";

export function ConflictBlock({
  block,
  onAcceptCurrent,
  onAcceptIncoming,
  onAcceptBoth,
}: {
  block: Extract<FileBlock, { kind: "conflict" }>;
  onAcceptCurrent: () => void;
  onAcceptIncoming: () => void;
  onAcceptBoth: () => void;
}) {
  const t = useGitT();
  return (
    <div style={{ margin: "2px 0", borderRadius: 4, overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
      {/* Button bar */}
      <div
        className="flex items-center gap-1 px-2"
        style={{
          height: "calc(24px * var(--ui-scale))",
          background: "var(--bg-overlay)",
          fontSize: "var(--fs-10)",
          userSelect: "none",
        }}
      >
        <button onClick={onAcceptCurrent} className="cursor-pointer flex items-center gap-0.5" style={{ color: "var(--status-active)", background: "none", border: "none", fontWeight: 600, fontSize: "var(--fs-10)" }}>
          <Check size={11} weight="bold" style={ICON_S} />
          {t("merge.acceptCurrent")}
        </button>
        <span style={{ color: "var(--border-subtle)" }}>|</span>
        <button onClick={onAcceptIncoming} className="cursor-pointer flex items-center gap-0.5" style={{ color: "var(--accent-blue)", background: "none", border: "none", fontWeight: 600, fontSize: "var(--fs-10)" }}>
          <Check size={11} weight="bold" style={ICON_S} />
          {t("merge.acceptIncoming")}
        </button>
        <span style={{ color: "var(--border-subtle)" }}>|</span>
        <button onClick={onAcceptBoth} className="cursor-pointer flex items-center gap-0.5" style={{ color: "var(--text-muted)", background: "none", border: "none", fontWeight: 600, fontSize: "var(--fs-10)" }}>
          <ArrowsInSimple size={11} weight="bold" style={ICON_S} />
          {t("merge.acceptBoth")}
        </button>
      </div>

      {/* Current (ours) */}
      <div style={{ background: CURRENT_BG, borderLeft: `3px solid ${CURRENT_BORDER}`, padding: "2px 8px" }}>
        <div className="flex items-center gap-1" style={{ fontSize: "var(--fs-10)", color: "var(--status-active)", opacity: 0.7, userSelect: "none", marginBottom: 1 }}>
          <ArrowUp size={10} weight="bold" style={{ width: "calc(10px * var(--ui-scale))", height: "calc(10px * var(--ui-scale))" }} />
          Current {block.current.label && `(${block.current.label})`}
        </div>
        <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "var(--fs-12)", color: "var(--text-primary)", lineHeight: "20px" }}>
          {block.current.lines.map((l, i) => (
            <div key={i}>{l || "\u00A0"}</div>
          ))}
        </div>
      </div>

      {/* Incoming (theirs) */}
      <div style={{ background: INCOMING_BG, borderLeft: `3px solid ${INCOMING_BORDER}`, padding: "2px 8px" }}>
        <div className="flex items-center gap-1" style={{ fontSize: "var(--fs-10)", color: "var(--accent-blue)", opacity: 0.7, userSelect: "none", marginBottom: 1 }}>
          <ArrowDown size={10} weight="bold" style={{ width: "calc(10px * var(--ui-scale))", height: "calc(10px * var(--ui-scale))" }} />
          Incoming {block.incoming.label && `(${block.incoming.label})`}
        </div>
        <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "var(--fs-12)", color: "var(--text-primary)", lineHeight: "20px" }}>
          {block.incoming.lines.map((l, i) => (
            <div key={i}>{l || "\u00A0"}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
