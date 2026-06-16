import { AiCommitPanel } from "./AiCommitPanel";

/**
 * AI 자동 커밋 — 인라인(사이드바 GitPanel 안) shell.
 * GitPanel 전체 영역을 덮어 다른 항목(변경/워크트리)을 가린다.
 */
export function AiCommitInline() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--bg-surface)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 5,
      }}
    >
      <AiCommitPanel variant="inline" />
    </div>
  );
}
