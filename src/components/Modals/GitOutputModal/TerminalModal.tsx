import { useEffect } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { CheckCircle, X, XCircle, SpinnerGap, StopCircle } from "@phosphor-icons/react";
import { useGitOutputStore } from "../../../stores/gitOutputStore";
import { useGitT } from "../../../lib/i18n/git";
import { ResizeHandles } from "./ResizeHandles";
import { TERMINAL_STYLES } from "./constants";
import type { TerminalModalProps } from "./types";

export function TerminalModal({ size, setSize, onResizeMouseDown, scrollRef, justResized }: TerminalModalProps) {
  const t = useGitT();
  const title = useGitOutputStore((s) => s.title);
  const lines = useGitOutputStore((s) => s.lines);
  const status = useGitOutputStore((s) => s.status);
  const close = useGitOutputStore((s) => s.close);
  const kill = useGitOutputStore((s) => s.kill);
  const setStatus = useGitOutputStore((s) => s.setStatus);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, scrollRef]);

  const isDone = status === "success" || status === "error" || status === "cancelled";
  const headerH = 41;
  const footerH = isDone ? 45 : 0;
  const outputH = size.height - headerH - footerH;

  void setSize;

  return (
    <div

      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
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
          borderRadius: 10,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
          position: "relative",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            {title}
          </div>
          {status === "running" && (
            <>
              <SpinnerGap size={16} weight="bold" style={{ color: "var(--text-tertiary)", animation: "spin 1s linear infinite" }} />
              <button
                onClick={() => { kill(); setStatus("cancelled"); }}
                title={t("gitOutput.abort")}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--accent-red)", display: "flex", alignItems: "center" }}
              >
                <StopCircle size={16} weight="fill" />
              </button>
            </>
          )}
          {status === "success" && (
            <CheckCircle size={16} weight="fill" style={{ color: "var(--accent-green)" }} />
          )}
          {(status === "error" || status === "cancelled") && (
            <XCircle size={16} weight="fill" style={{ color: status === "cancelled" ? "var(--text-tertiary)" : "var(--accent-red)" }} />
          )}
          {isDone && (
            <button
              onClick={close}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--text-tertiary)", display: "flex", alignItems: "center" }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Terminal output */}
        <div
          ref={scrollRef}
          style={{
            background: "var(--bg-surface)",
            padding: "12px 14px",
            height: outputH,
            overflowY: "auto",
            fontFamily: "monospace",
            fontSize: 12,
            lineHeight: 1.6,
            flex: 1,
          }}
        >
          {lines.length === 0 && status === "running" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "36px 0" }}>
              <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 22 }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} style={{
                    width: 3, borderRadius: 3,
                    background: "var(--accent-blue)",
                    animation: `wave-bar 1.1s ease-in-out ${i * 0.13}s infinite`,
                  }} />
                ))}
              </div>
              <span style={{ color: "var(--text-muted)", fontSize: 11, letterSpacing: "0.04em" }}>{t("gitOutput.running")}</span>
            </div>
          )}
          {lines.map((l, i) => (
            <div
              key={i}
              className="git-output-line"
              style={{ color: l.isErr ? "var(--accent-red)" : "var(--text-primary)", wordBreak: "break-word" }}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parseInline(l.line) as string) }}
            />
          ))}
          {status === "error" && (
            <div style={{ color: "var(--accent-red)", marginTop: 8 }}>{t("gitOutput.error")}</div>
          )}
          {status === "cancelled" && (
            <div style={{ color: "var(--text-secondary)", marginTop: 8 }}>{t("gitOutput.aborted")}</div>
          )}
        </div>

        {/* Footer */}
        {isDone && (
          <div style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--border-subtle)",
            display: "flex", justifyContent: "flex-end",
            flexShrink: 0,
          }}>
            <button
              onClick={close}
              style={{
                padding: "5px 16px", fontSize: 12, borderRadius: 6,
                border: "1px solid var(--border-subtle)", background: "transparent",
                color: "var(--text-secondary)", cursor: "pointer",
              }}
            >
              {t("gitOutput.close")}
            </button>
          </div>
        )}

        <ResizeHandles onResizeMouseDown={onResizeMouseDown} />

        {/* SE corner grip indicator */}
        <div style={{
          position: "absolute", right: 3, bottom: 3,
          width: 10, height: 10, pointerEvents: "none",
          backgroundImage: "radial-gradient(circle, #555 1px, transparent 1px)",
          backgroundSize: "3px 3px",
          opacity: 0.5,
        }} />
      </div>

      <style>{TERMINAL_STYLES}</style>
    </div>
  );
}
