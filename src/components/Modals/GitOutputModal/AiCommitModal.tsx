import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { CheckCircle, X, XCircle, SpinnerGap, Robot, Eye, EyeSlash } from "@phosphor-icons/react";
import { useGitOutputStore } from "../../../stores/gitOutputStore";
import { useGitT } from "../../../lib/i18n/git";
import { ResizeHandles } from "./ResizeHandles";
import { CommitSummaryView } from "./CommitSummaryView";
import { AI_COMMIT_STYLES } from "./constants";
import type { ModalSizeProps } from "./types";

export function AiCommitModal({ size, setSize, onResizeMouseDown, justResized }: ModalSizeProps) {
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

  const isThinking = useGitOutputStore((s) => s.isThinking);
  const isDone = status === "success" || status === "error" || status === "cancelled";
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  void setSize;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [toolEntries, suggestions, changedFiles, lines]);

  const handleClose = () => {
    if (!isDone) { kill(); setStatus("cancelled"); }
    close();
  };

  const errorLines = lines.filter(l => l.isErr);

  return (
    <div

      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
      }}
      onClick={(e) => {
        if (isDone && !justResized.current && e.target === e.currentTarget) close();
      }}
    >
      <div
        style={{
          width: size.width, height: size.height,
          maxWidth: "95vw", maxHeight: "95vh",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          borderRadius: 12,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.7)",
          position: "relative",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 20px",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}>
          <Robot size={18} weight="duotone" style={{ color: "var(--accent-cyan)" }} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>{title}</span>
          {status === "running" && (
            <SpinnerGap size={15} weight="bold" style={{ color: "var(--accent-cyan)", animation: "spin 1s linear infinite" }} />
          )}
          {status === "success" && (
            <CheckCircle size={15} weight="fill" style={{ color: "var(--accent-green)" }} />
          )}
          {(status === "error" || status === "cancelled") && (
            <XCircle size={15} weight="fill" style={{ color: status === "cancelled" ? "var(--text-tertiary)" : "var(--accent-red)" }} />
          )}
          {prompt && (
            <button
              onClick={() => setShowPrompt((v) => !v)}
              title={showPrompt ? t("gitOutput.hidePrompt") : t("gitOutput.showPrompt")}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: showPrompt ? "var(--accent-cyan)" : "var(--text-tertiary)", display: "flex", alignItems: "center", borderRadius: 4 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent-cyan)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = showPrompt ? "var(--accent-cyan)" : "var(--text-tertiary)"; }}
            >
              {showPrompt ? <EyeSlash size={14} /> : <Eye size={14} />}
            </button>
          )}
          <button
            onClick={handleClose}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "var(--text-tertiary)", display: "flex", alignItems: "center", borderRadius: 4 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Prompt viewer */}
        {showPrompt && prompt && (
          <div style={{
            borderBottom: "1px solid var(--border-default)",
            background: "var(--bg-base)",
            maxHeight: 220,
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
            overflowY: "auto",
            background: "var(--bg-base)",
            fontFamily: "var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace)",
            fontSize: 12,
            lineHeight: 1.8,
            padding: "16px 18px",
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
          {toolEntries.map((t, i) => (
            <div key={`t${i}`} style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>
              <span style={{ color: "var(--accent-cyan)", fontWeight: 700, userSelect: "none" }}>$ </span>
              {t.cmd}
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
            padding: "10px 20px",
            borderTop: "1px solid var(--border-default)",
            display: "flex", justifyContent: "flex-end",
            flexShrink: 0,
          }}>
            <button
              onClick={close}
              style={{
                padding: "5px 16px", fontSize: 12, borderRadius: 6,
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

        <ResizeHandles onResizeMouseDown={onResizeMouseDown} />

        <style>{AI_COMMIT_STYLES}</style>
      </div>
    </div>
  );
}
