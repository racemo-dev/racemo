import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  CheckCircle,
  X,
  XCircle,
  SpinnerGap,
  Robot,
  Eye,
  EyeSlash,
  ArrowSquareOut,
  ArrowSquareIn,
} from "@phosphor-icons/react";
import { useGitOutputStore } from "../../../stores/gitOutputStore";
import { useGitT } from "../../../lib/i18n/git";
import { CommitSummaryView } from "./CommitSummaryView";
import { AI_COMMIT_STYLES } from "./constants";

export interface AiCommitPanelProps {
  /** floating 일 때 헤더에 드래그 핸들을 연결한다 */
  variant: "inline" | "floating";
  /** floating 일 때 헤더 드래그 시작 */
  onHeaderMouseDown?: (e: React.MouseEvent) => void;
  /** floating 드래그 중인지 — 커서 표시용 */
  isDragging?: boolean;
}

/**
 * AI 자동 커밋 패널 콘텐츠. 위치(인라인/플로팅) 무관하게 같은 UI를 그린다.
 * 위치/드래그/리사이즈는 외부 shell이 담당한다.
 */
export function AiCommitPanel({ variant, onHeaderMouseDown, isDragging }: AiCommitPanelProps) {
  const t = useGitT();
  const title = useGitOutputStore((s) => s.title);
  const status = useGitOutputStore((s) => s.status);
  const toolEntries = useGitOutputStore((s) => s.toolEntries);
  const suggestions = useGitOutputStore((s) => s.suggestions);
  const changedFiles = useGitOutputStore((s) => s.changedFiles);
  const lines = useGitOutputStore((s) => s.lines);
  const prompt = useGitOutputStore((s) => s.prompt);
  const close = useGitOutputStore((s) => s.close);
  const kill = useGitOutputStore((s) => s.kill);
  const setStatus = useGitOutputStore((s) => s.setStatus);
  const setAiCommitLocation = useGitOutputStore((s) => s.setAiCommitLocation);

  const isThinking = useGitOutputStore((s) => s.isThinking);
  const isDone = status === "success" || status === "error" || status === "cancelled";
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [toolEntries, suggestions, changedFiles, lines]);

  const handleClose = () => {
    if (!isDone) { kill(); setStatus("cancelled"); }
    close();
  };

  const toggleLocation = () => {
    setAiCommitLocation(variant === "inline" ? "floating" : "inline");
  };

  const errorLines = lines.filter(l => l.isErr);
  const isFloating = variant === "floating";

  return (
    <>
      {/* Header (drag handle when floating) */}
      <div
        onMouseDown={isFloating ? onHeaderMouseDown : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: isFloating ? "14px 20px" : "8px 12px",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
          cursor: isFloating ? (isDragging ? "grabbing" : "move") : "default",
          userSelect: isFloating ? "none" : "auto",
          background: isFloating ? undefined : "var(--bg-surface)",
        }}
      >
        <Robot size={isFloating ? 18 : 14} weight="duotone" style={{ color: "var(--accent-cyan)", flexShrink: 0 }} />
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: isFloating ? 14 : 11,
          fontWeight: 700,
          color: "var(--text-primary)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{title}</span>
        {status === "running" && (
          <SpinnerGap size={isFloating ? 15 : 12} weight="bold" style={{ color: "var(--accent-cyan)", animation: "spin 1s linear infinite", flexShrink: 0 }} />
        )}
        {status === "success" && (
          <CheckCircle size={isFloating ? 15 : 12} weight="fill" style={{ color: "var(--accent-green)", flexShrink: 0 }} />
        )}
        {(status === "error" || status === "cancelled") && (
          <XCircle size={isFloating ? 15 : 12} weight="fill" style={{ color: status === "cancelled" ? "var(--text-tertiary)" : "var(--accent-red)", flexShrink: 0 }} />
        )}
        {prompt && (
          <button
            onClick={() => setShowPrompt((v) => !v)}
            title={showPrompt ? t("gitOutput.hidePrompt") : t("gitOutput.showPrompt")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: showPrompt ? "var(--accent-cyan)" : "var(--text-tertiary)", display: "flex", alignItems: "center", borderRadius: 4, flexShrink: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent-cyan)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = showPrompt ? "var(--accent-cyan)" : "var(--text-tertiary)"; }}
          >
            {showPrompt ? <EyeSlash size={isFloating ? 14 : 12} /> : <Eye size={isFloating ? 14 : 12} />}
          </button>
        )}
        <button
          onClick={toggleLocation}
          title={isFloating ? t("gitOutput.dockToSide") : t("gitOutput.detach")}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "var(--text-tertiary)", display: "flex", alignItems: "center", borderRadius: 4, flexShrink: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
        >
          {isFloating
            ? <ArrowSquareIn size={isFloating ? 14 : 12} />
            : <ArrowSquareOut size={isFloating ? 14 : 12} />}
        </button>
        <button
          onClick={handleClose}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "var(--text-tertiary)", display: "flex", alignItems: "center", borderRadius: 4, flexShrink: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
        >
          <X size={isFloating ? 15 : 12} />
        </button>
      </div>

      {/* Prompt viewer */}
      {showPrompt && prompt && (
        <div style={{
          borderBottom: "1px solid var(--border-default)",
          background: "var(--bg-base)",
          maxHeight: isFloating ? 220 : 140,
          overflowY: "auto",
          flexShrink: 0,
        }}>
          <div style={{ padding: "6px 18px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--accent-cyan)", textTransform: "uppercase" }}>Prompt</span>
            <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{prompt.length.toLocaleString()} chars</span>
          </div>
          <pre style={{
            margin: 0, padding: "0 18px 12px",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 11, lineHeight: 1.7,
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>{prompt}</pre>
        </div>
      )}

      {/* Single output box */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          background: "var(--bg-base)",
          fontFamily: "var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace)",
          fontSize: isFloating ? 12 : 11,
          lineHeight: isFloating ? 1.8 : 1.6,
          padding: isFloating ? "16px 18px" : "8px 12px",
        }}
      >
        {/* Empty state */}
        {toolEntries.length === 0 && lines.length === 0 && status === "running" && (
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 12px" }}>
              <SpinnerGap size={12} weight="bold" style={{ color: "var(--accent-cyan)", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
              <span style={{ color: "var(--accent-cyan)", fontSize: 11, fontWeight: 500 }}>{t("gitOutput.ready")}</span>
              <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
                {[0, 1, 2].map((i) => (
                  <span key={i} style={{
                    width: 3, height: 3, borderRadius: "50%",
                    background: "var(--accent-cyan)",
                    display: "inline-block",
                    animation: `thinking-dot 1.2s ease-in-out ${i * 0.18}s infinite`,
                  }} />
                ))}
              </span>
            </div>
          </div>
        )}

        {/* Tool entries (auto-commit) */}
        {toolEntries.map((te, i) => (
          <div key={`t${i}`} style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>
            <span style={{ color: "var(--accent-cyan)", fontWeight: 700, userSelect: "none" }}>$ </span>
            {te.cmd}
          </div>
        ))}

        {/* Streamed lines (review / generate) */}
        {lines.map((l, i) => (
          <div
            key={`l${i}`}
            className="ai-output-line"
            style={{ color: l.isErr ? "var(--accent-red)" : "var(--text-secondary)", wordBreak: "break-word" }}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parseInline(l.line) as string) }}
          />
        ))}

        {/* Running indicator */}
        {status === "running" && (toolEntries.length > 0 || lines.length > 0) && (
          isThinking ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 10, padding: "5px 12px" }}>
              <SpinnerGap size={12} weight="bold" style={{ color: "var(--accent-cyan)", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
              <span style={{ color: "var(--accent-cyan)", fontSize: 11, fontWeight: 500 }}>{t("gitOutput.analyzing")}</span>
              <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
                {[0, 1, 2].map((i) => (
                  <span key={i} style={{
                    width: 3, height: 3, borderRadius: "50%",
                    background: "var(--accent-cyan)",
                    display: "inline-block",
                    animation: `thinking-dot 1.2s ease-in-out ${i * 0.18}s infinite`,
                  }} />
                ))}
              </span>
            </div>
          ) : (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, color: "var(--text-muted)", fontSize: 11 }}>
              <span style={{ color: "var(--accent-cyan)", animation: "blink 1s step-end infinite" }}>&#9612;</span>
              <span>{t("gitOutput.generating")}</span>
            </div>
          )
        )}

        {/* Error lines -- only show lines NOT already rendered above */}
        {status === "error" && errorLines.length > 0 && lines.length === 0 && (
          <>
            <div style={{ height: 8 }} />
            {errorLines.map((l, i) => (
              <div key={i} style={{ color: "var(--accent-red)" }}>{l.line}</div>
            ))}
          </>
        )}

        {/* Formatted summary on completion */}
        {status === "success" && (
          <>
            <div style={{ height: 16, borderTop: "1px solid var(--border-subtle)", margin: "16px 0 0" }} />
            <CommitSummaryView lines={lines} suggestions={suggestions} changedFiles={changedFiles} />
          </>
        )}
      </div>

      {/* Footer */}
      {isDone && (
        <div style={{
          padding: isFloating ? "10px 20px" : "6px 12px",
          borderTop: "1px solid var(--border-default)",
          display: "flex", justifyContent: "flex-end",
          flexShrink: 0,
        }}>
          <button
            onClick={close}
            style={{
              padding: isFloating ? "5px 16px" : "3px 10px",
              fontSize: isFloating ? 12 : 10,
              borderRadius: 6,
              border: "1px solid var(--border-default)", background: "transparent",
              color: "var(--text-tertiary)", cursor: "pointer",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          >
            {t("gitOutput.close")}
          </button>
        </div>
      )}

      <style>{AI_COMMIT_STYLES}</style>
    </>
  );
}
