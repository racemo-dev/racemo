import { useState } from "react";
import { useAiHistoryStore, type AiHistoryEntry, type AiTaskType } from "../../stores/aiHistoryStore";
import { useGitT, type TranslationKey } from "../../lib/i18n/git";
import {
  Trash,
  CaretDown,
  CaretRight,
  CheckCircle,
  XCircle,
  CircleNotch,
} from "@phosphor-icons/react";

const ICON_STYLE = (size: number) => ({
  width: `calc(${size}px * var(--ui-scale))`,
  height: `calc(${size}px * var(--ui-scale))`,
  flexShrink: 0 as const,
});

const TYPE_LABELS: Record<AiTaskType, TranslationKey> = {
  "commit": "aiHistory.commit",
  "auto-commit": "aiHistory.autoCommit",
  "review": "aiHistory.review",
  "error-explain": "aiHistory.errorExplain",
};

function relativeTime(epochMs: number, t: (key: TranslationKey) => string): string {
  const diff = Date.now() - epochMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t("aiHistory.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("aiHistory.minutesAgo").replace("{count}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("aiHistory.hoursAgo").replace("{count}", String(hours));
  const days = Math.floor(hours / 24);
  return t("aiHistory.daysAgo").replace("{count}", String(days));
}

function StatusIcon({ status }: { status: AiHistoryEntry["status"] }) {
  if (status === "running") return <CircleNotch size={14} weight="bold" style={{ ...ICON_STYLE(14), color: "var(--accent-blue)", animation: "spin 1s linear infinite" }} />;
  if (status === "success") return <CheckCircle size={14} weight="fill" style={{ ...ICON_STYLE(14), color: "var(--accent-green)" }} />;
  return <XCircle size={14} weight="fill" style={{ ...ICON_STYLE(14), color: "var(--accent-red)" }} />;
}

function PromptViewer({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  const t = useGitT();
  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1"
        style={{
          fontSize: "var(--fs-9)",
          color: "var(--accent-cyan)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {open ? <CaretDown size={10} style={ICON_STYLE(10)} /> : <CaretRight size={10} style={ICON_STYLE(10)} />}
        {t("aiHistory.prompt")}
      </button>
      {open && (
        <pre
          style={{
            margin: "4px 0 0",
            fontSize: "var(--fs-9)",
            lineHeight: 1.6,
            color: "var(--text-muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 300,
            overflowY: "auto",
            background: "var(--bg-primary)",
            borderRadius: 4,
            padding: "4px 6px",
          }}
        >
          {prompt}
        </pre>
      )}
    </div>
  );
}

function EntryItem({ entry }: { entry: AiHistoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  const t = useGitT();
  const remove = useAiHistoryStore((s) => s.remove);

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      <div
        className="flex items-center gap-1 px-2 py-1.5 cursor-pointer"
        style={{ fontSize: "var(--fs-11)" }}
        onClick={() => setExpanded((v) => !v)}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        {expanded
          ? <CaretDown size={12} style={ICON_STYLE(12)} />
          : <CaretRight size={12} style={ICON_STYLE(12)} />}
        <StatusIcon status={entry.status} />
        <span className="flex-1 truncate" style={{ color: "var(--text-primary)" }}>
          {t(TYPE_LABELS[entry.type])}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-9)", whiteSpace: "nowrap" }}>
          {relativeTime(entry.timestamp, t)}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); remove(entry.id); }}
          className="flex items-center justify-center"
          style={{ color: "var(--text-muted)", background: "transparent", border: "none", cursor: "pointer", padding: 2 }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent-red)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <Trash size={12} style={ICON_STYLE(12)} />
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-2" style={{ fontSize: "var(--fs-10)" }}>
          {entry.summary && (
            <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>
              {entry.summary}
            </div>
          )}
          <div
            className="font-mono"
            style={{
              color: "var(--text-muted)",
              fontSize: "var(--fs-9)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 200,
              overflowY: "auto",
              background: "var(--bg-primary)",
              borderRadius: 4,
              padding: "4px 6px",
            }}
          >
            <span style={{ color: "var(--text-muted)", opacity: 0.7 }}>$ {entry.command}</span>
            {entry.output && (
              <>
                {"\n"}
                <span style={{ color: entry.status === "error" ? "var(--accent-red)" : "var(--text-secondary)" }}>
                  {entry.output}
                </span>
              </>
            )}
          </div>
          {entry.status === "error" && entry.prompt && (
            <PromptViewer prompt={entry.prompt} />
          )}
        </div>
      )}
    </div>
  );
}

export default function AiHistoryPanel() {
  const entries = useAiHistoryStore((s) => s.entries);
  const clear = useAiHistoryStore((s) => s.clear);
  const t = useGitT();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center px-2 py-1 shrink-0"
        style={{ borderBottom: "1px solid var(--border-default)" }}
      >
        <span
          className="flex-1 uppercase"
          style={{ fontSize: "var(--fs-10)", letterSpacing: "0.05em", color: "var(--text-secondary)" }}
        >
          {t("aiHistory.title")}
        </span>
        {entries.length > 0 && (
          <button
            onClick={clear}
            className="flex items-center gap-1 cursor-pointer"
            style={{
              fontSize: "var(--fs-9)",
              color: "var(--text-muted)",
              background: "transparent",
              border: "none",
              padding: "2px 4px",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <Trash size={12} style={ICON_STYLE(12)} />
            {t("aiHistory.clear")}
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--text-muted)", fontSize: "var(--fs-11)" }}
          >
            {t("aiHistory.empty")}
          </div>
        ) : (
          entries.map((entry) => <EntryItem key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  );
}
