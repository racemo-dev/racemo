import { useCallback, useEffect, useState } from "react";
import { Trash, EyeSlash, GitPullRequest, GitMerge, GitFork, X, ArrowsClockwise } from "@phosphor-icons/react";
import { useGitStore } from "../../stores/gitStore";
import { useGitT } from "../../lib/i18n/git";
import { BrowserHideGuard } from "../Editor/BrowserViewer";
import { logger } from "../../lib/logger";

export default function PullConflictDialog() {
  const t = useGitT();
  const files = useGitStore((s) => s.pullConflictFiles);
  const cwd = useGitStore((s) => s.pullConflictCwd);
  const clearPullConflict = useGitStore((s) => s.clearPullConflict);
  const discardFile = useGitStore((s) => s.discardFile);
  const addToGitignore = useGitStore((s) => s.addToGitignore);
  const stashPull = useGitStore((s) => s.stashPull);
  const stashRebasePull = useGitStore((s) => s.stashRebasePull);

  const [processing, setProcessing] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const isOpen = files.length > 0 && cwd !== null;

  const close = useCallback(() => {
    clearPullConflict();
    setResolved(new Set());
    setProcessing(null);
  }, [clearPullConflict]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, close]);

  if (!isOpen || !cwd) return null;

  const resolveFile = (file: string) => {
    setResolved((prev) => {
      const next = new Set(prev).add(file);
      // All files resolved → auto pull & close
      if (files.every((f) => next.has(f))) {
        setTimeout(() => handleAction("retry"), 0);
      }
      return next;
    });
  };

  const handleDiscard = async (file: string) => {
    try {
      await discardFile(cwd, file);
      resolveFile(file);
    } catch (e) {
      logger.error("[PullConflict] discard failed:", e);
    }
  };

  const handleIgnore = async (file: string) => {
    try {
      await addToGitignore(cwd, file);
      resolveFile(file);
    } catch (e) {
      logger.error("[PullConflict] gitignore failed:", e);
    }
  };

  const handleAction = async (action: "merge" | "rebase" | "retry") => {
    setProcessing(action);
    try {
      if (action === "merge") {
        await stashPull(cwd);
      } else if (action === "rebase") {
        await stashRebasePull(cwd);
      } else {
        await useGitStore.getState().pull(cwd);
      }
      close();
    } catch (e) {
      logger.error(`[PullConflict] ${action} failed:`, e);
    } finally {
      setProcessing(null);
    }
  };

  const allResolved = files.every((f) => resolved.has(f));
  const isProcessing = processing !== null;

  return (
    <>
    <BrowserHideGuard />
    <div

      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className="w-full max-w-md rounded-[12px] overflow-hidden"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <div className="flex items-center gap-2.5">
            <GitPullRequest size={18} weight="bold" style={{ color: "var(--accent-orange)" }} />
            <h3 style={{ color: "var(--text-primary)", fontSize: "14px", fontWeight: 600 }}>
              {t("pullConflict.title")}
            </h3>
          </div>
          <button
            onClick={close}
            className="p-1 rounded-md opacity-40 hover:opacity-100 transition-opacity"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Description */}
        <div className="px-5 pt-3 pb-2">
          <p style={{ color: "var(--text-secondary)", fontSize: "12px", lineHeight: 1.5, whiteSpace: "pre-line" }}>
            {t("pullConflict.desc")}
          </p>
        </div>

        {/* File List */}
        <div
          className="mx-5 mb-3 rounded-lg overflow-hidden"
          style={{ border: "1px solid var(--border-default)", maxHeight: "200px", overflowY: "auto" }}
        >
          {files.map((file, i) => {
            const isResolved = resolved.has(file);
            const fileName = file.split("/").pop() ?? file;
            const dirPath = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
            return (
              <div
                key={file}
                className="flex items-center gap-2 px-3 py-2"
                style={{
                  borderTop: i > 0 ? "1px solid var(--border-subtle)" : undefined,
                  opacity: isResolved ? 0.4 : 1,
                  background: isResolved ? "var(--bg-surface)" : "transparent",
                }}
              >
                <div className="flex-1 min-w-0">
                  <span
                    className="block truncate"
                    style={{ color: "var(--text-primary)", fontSize: "12px" }}
                    title={file}
                  >
                    {fileName}
                  </span>
                  {dirPath && (
                    <span
                      className="block truncate"
                      style={{ color: "var(--text-muted)", fontSize: "10px" }}
                    >
                      {dirPath}
                    </span>
                  )}
                </div>
                {!isResolved && (
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => handleDiscard(file)}
                      className="p-1.5 rounded-md transition-colors"
                      style={{ color: "var(--text-muted)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--accent-red)";
                        e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--accent-red) 10%, transparent)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-muted)";
                        e.currentTarget.style.backgroundColor = "transparent";
                      }}
                      title={t("pullConflict.discard")}
                    >
                      <Trash size={14} weight="bold" />
                    </button>
                    <button
                      onClick={() => handleIgnore(file)}
                      className="p-1.5 rounded-md transition-colors"
                      style={{ color: "var(--text-muted)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--accent-yellow)";
                        e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--accent-yellow) 10%, transparent)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-muted)";
                        e.currentTarget.style.backgroundColor = "transparent";
                      }}
                      title={t("pullConflict.ignore")}
                    >
                      <EyeSlash size={14} weight="bold" />
                    </button>
                  </div>
                )}
                {isResolved && (
                  <span style={{ color: "var(--status-active)", fontSize: "11px" }}>{t("pullConflict.resolved")}</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Strategy buttons */}
        {!allResolved && (
          <div className="mx-5 mb-3 flex flex-col gap-2">
            <button
              onClick={() => handleAction("merge")}
              disabled={isProcessing}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors"
              style={{
                border: "1px solid var(--border-default)",
                opacity: isProcessing && processing !== "merge" ? 0.4 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent-blue)"; e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--accent-blue) 5%, transparent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; e.currentTarget.style.backgroundColor = "transparent"; }}
              title={t("pullConflict.stashMerge.tip")}
            >
              <GitMerge size={16} weight="bold" style={{ color: "var(--accent-blue)", flexShrink: 0 }} />
              <span style={{ color: "var(--text-primary)", fontSize: "12px", fontWeight: 600 }}>
                {t("pullConflict.stashMerge")}
              </span>
              {processing === "merge" && <ArrowsClockwise size={12} className="animate-spin" style={{ color: "var(--accent-blue)", marginLeft: "auto" }} />}
            </button>

            <button
              onClick={() => handleAction("rebase")}
              disabled={isProcessing}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors"
              style={{
                border: "1px solid var(--border-default)",
                opacity: isProcessing && processing !== "rebase" ? 0.4 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent-cyan)"; e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--accent-cyan) 5%, transparent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; e.currentTarget.style.backgroundColor = "transparent"; }}
              title={t("pullConflict.stashRebase.tip")}
            >
              <GitFork size={16} weight="bold" style={{ color: "var(--accent-cyan)", flexShrink: 0 }} />
              <span style={{ color: "var(--text-primary)", fontSize: "12px", fontWeight: 600 }}>
                {t("pullConflict.stashRebase")}
              </span>
              {processing === "rebase" && <ArrowsClockwise size={12} className="animate-spin" style={{ color: "var(--accent-cyan)", marginLeft: "auto" }} />}
            </button>
          </div>
        )}

        {/* Retry Pull */}
        {allResolved && (
          <div className="mx-5 mb-3">
            <button
              onClick={() => handleAction("retry")}
              disabled={isProcessing}
              className="w-full flex items-center justify-center gap-2 p-2.5 rounded-lg transition-colors"
              style={{
                border: "1px solid var(--status-active)",
                color: "var(--status-active)",
                opacity: isProcessing ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--status-active) 10%, transparent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              {processing === "retry" && <ArrowsClockwise size={12} className="animate-spin" />}
              <span style={{ fontSize: "12px", fontWeight: 600 }}>{t("pullConflict.retry")}</span>
            </button>
          </div>
        )}

        {/* Footer */}
        <div
          className="px-5 py-3 flex justify-end"
          style={{ borderTop: "1px solid var(--border-default)" }}
        >
          <button
            onClick={close}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--bg-overlay)";
              e.currentTarget.style.borderColor = "var(--border-strong)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.borderColor = "var(--border-default)";
            }}
          >
            {t("pullConflict.cancel")}
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
