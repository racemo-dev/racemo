import { useEffect, useState } from "react";
import { ArrowClockwise, Trash, CheckCircle, XCircle, CaretRight } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import type { GitCommandLogEntry } from "../../types/git";
import { useGitT } from "../../lib/i18n/git";

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function LogEntry({ entry }: { entry: GitCommandLogEntry }) {
  const t = useGitT();
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{ borderBottom: "1px solid var(--border-subtle)" }}
    >
      <div
        className="flex items-center gap-1 py-1 px-2 cursor-pointer select-none"
        style={{ fontSize: 'var(--fs-11)', userSelect: "none" }}
        onClick={() => setExpanded((p) => !p)}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        <CaretRight
          size={10}
          weight="bold"
          style={{
            width: 'calc(10px * var(--ui-scale))',
            height: 'calc(10px * var(--ui-scale))',
            transition: "transform 120ms ease",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            flexShrink: 0,
            color: "var(--text-muted)",
          }}
        />
        {entry.success ? (
          <CheckCircle size={12} weight="fill" style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))', flexShrink: 0, color: "var(--status-active)" }} />
        ) : (
          <XCircle size={12} weight="fill" style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))', flexShrink: 0, color: "var(--accent-red)" }} />
        )}
        <span
          className="truncate"
          style={{
            color: "var(--text-secondary)",
            fontFamily: "monospace",
            fontSize: 'var(--fs-10)',
          }}
        >
          {entry.command}
        </span>
        <span
          className="ml-auto shrink-0"
          style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)" }}
        >
          {entry.durationMs}ms
        </span>
      </div>
      {expanded && (
        <div
          className="px-3 py-1.5"
          style={{
            background: "var(--bg-elevated, var(--bg-surface))",
          }}
        >
          <div className="flex items-center gap-2 mb-1" style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)" }}>
            <span>{formatTime(entry.timestamp)}</span>
            <span
              style={{
                color: entry.success ? "var(--status-active)" : "var(--accent-red)",
                fontWeight: 600,
              }}
            >
              {entry.success ? t("gitLog.ok") : t("gitLog.fail")}
            </span>
          </div>
          {entry.output && (
            <pre
              style={{
                fontSize: 'var(--fs-10)',
                fontFamily: "monospace",
                color: entry.success ? "var(--text-secondary)" : "var(--accent-red)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 200,
                overflowY: "auto",
                margin: 0,
                lineHeight: 1.4,
              }}
            >
              {entry.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function GitLogPanel() {
  const t = useGitT();
  const [logs, setLogs] = useState<GitCommandLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = async () => {
    setIsLoading(true);
    try {
      const result = await invoke<GitCommandLogEntry[]>("git_command_log");
      setLogs(result);
    } catch {
      setLogs([]);
    } finally {
      setIsLoading(false);
    }
  };

  const clear = async () => {
    await invoke("git_clear_command_log");
    setLogs([]);
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  const reversed = [...logs].reverse();

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center gap-1 px-2 py-1 shrink-0"
        style={{ fontSize: 'var(--fs-11)', borderBottom: "1px solid var(--border-subtle)" }}
      >
        <span style={{ color: "var(--text-muted)", fontSize: 'var(--fs-10)' }}>
          {logs.length} {t("gitLog.command")}{logs.length !== 1 ? "s" : ""}
        </span>
        <span className="flex items-center gap-1 ml-auto">
          <button
            onClick={clear}
            className="cursor-pointer"
            style={{ color: "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--accent-red)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
            }}
            title={t("gitLog.clearLog")}
          >
            <Trash size={13} style={{ width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))' }} />
          </button>
          <button
            onClick={refresh}
            className="cursor-pointer"
            style={{ color: "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
            }}
            title={t("git.refresh")}
          >
            <ArrowClockwise
              size={13}
              style={isLoading ? { width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))', animation: "spin 1s linear infinite" } : { width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))' }}
            />
          </button>
        </span>
      </div>

      {/* Log entries (newest first) */}
      <div className="flex-1 overflow-y-auto">
        {reversed.length === 0 && (
          <div className="px-3 py-2" style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)" }}>
            {t("gitLog.noCommands")}
          </div>
        )}
        {reversed.map((entry, i) => (
          <LogEntry key={`${entry.timestamp}-${i}`} entry={entry} />
        ))}
      </div>
    </div>
  );
}
