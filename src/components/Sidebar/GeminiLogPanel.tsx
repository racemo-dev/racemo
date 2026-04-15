import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiReadGeminiLogHistory, apiReadGeminiLogSession, isTauri } from "../../lib/bridge";
import { useSessionStore } from "../../stores/sessionStore";
import { findPtyId } from "../../lib/paneTreeUtils";
import type { GeminiHistoryEntry, GeminiSessionMessage } from "../../types/geminilog";
import {
  ArrowClockwise,
  Crosshair,
  List,
  TreeStructure,
} from "@phosphor-icons/react";
import { useGitT, type TranslationKey } from "../../lib/i18n/git";
import { relativeTime, truncateDisplay, formatTokens } from "./logUtils";
import { GeminiIcon } from "./AiLogPanel/ProviderIcons";
import {
  ProjectLabel,
  IdBadge,
  ToolBadge,
  MarkdownContent,
  LogMdStyles,
  DetailPanelShell,
  DetailPanelHeader,
  MessageListBody,
  MessageRowShell,
  GroupRow,
  HistoryRowShell,
  TokenSummaryFooter,
  INITIAL_MESSAGE_COUNT,
} from "./LogShared";

/* ─── Usage summary ─── */
function UsageSummary({ messages }: { messages: GeminiSessionMessage[] }) {
  const totalInput = messages.reduce((s, m) => s + m.input_tokens, 0);
  const totalOutput = messages.reduce((s, m) => s + m.output_tokens, 0);
  const msgCount = messages.filter((m) => m.role === "user" || m.role === "assistant").length;
  return <TokenSummaryFooter totalInput={totalInput} totalOutput={totalOutput} msgCount={msgCount} />;
}

/* ─── Session Detail Panel ─── */
function SessionDetailPanel({
  entry,
  messages,
  loading,
  anchorRect,
  panelRight,
  onClose,
  ownerRef,
  t,
}: {
  entry: GeminiHistoryEntry;
  messages: GeminiSessionMessage[];
  loading: boolean;
  anchorRect: DOMRect;
  panelRight: number;
  onClose: () => void;
  ownerRef: React.RefObject<HTMLDivElement | null>;
  t: (key: TranslationKey) => string;
}) {
  const [showCount, setShowCount] = useState(INITIAL_MESSAGE_COUNT);

  return (
    <DetailPanelShell anchorRect={anchorRect} panelRight={panelRight} onClose={onClose} ownerRef={ownerRef}>
      <DetailPanelHeader title={entry.display} onClose={onClose} closeLabel={t("geminiLog.close")}>
        <IdBadge id={entry.tag} maxLen={16} />
        <ProjectLabel label={entry.project_label} />
        <span className="sb-muted" style={{ fontSize: "var(--fs-9)", flexShrink: 0 }}>
          {relativeTime(entry.timestamp, t)}
        </span>
      </DetailPanelHeader>

      <LogMdStyles prefix="gemini-log-md" />

      <MessageListBody
        messages={messages}
        loading={loading}
        showCount={showCount}
        onShowMore={() => setShowCount((c) => c + INITIAL_MESSAGE_COUNT)}
        loadingText={t("geminiLog.loading")}
        emptyText={t("geminiLog.noMessages")}
        showMoreText={t("geminiLog.showMore").replace("{count}", String(messages.length - showCount))}
        renderMessage={(msg, idx) => <MessageRow key={idx} message={msg} />}
      />

      {!loading && messages.length > 0 && <UsageSummary messages={messages} />}
    </DetailPanelShell>
  );
}

/* ─── Message Row ─── */
function MessageRow({ message }: { message: GeminiSessionMessage }) {
  const isToolResult = message.role === "tool_result";
  const contentPreview = isToolResult && message.content.length > 80
    ? message.content.slice(0, 80) + "..."
    : null;

  return (
    <MessageRowShell
      role={message.role}
      isCollapsible={isToolResult}
      headerExtra={
        <>
          {message.tool_name && <ToolBadge name={message.tool_name} />}
          {message.role === "assistant" && message.input_tokens > 0 && (
            <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", whiteSpace: "nowrap", display: "flex", gap: 4, alignItems: "center" }}>
              <span>{formatTokens(message.input_tokens)}in</span>
              <span>{formatTokens(message.output_tokens)}out</span>
            </span>
          )}
        </>
      }
    >
      {message.content && (
        <div
          style={{
            fontSize: "var(--fs-12)",
            color: "var(--text-secondary)",
            lineHeight: 1.4,
            wordBreak: "break-word",
            fontFamily: isToolResult ? "var(--font-mono, monospace)" : undefined,
            whiteSpace: isToolResult ? "pre-wrap" : undefined,
          }}
        >
          {isToolResult ? (
            <span>{message.content}</span>
          ) : (
            <MarkdownContent content={message.content} className="gemini-log-md" />
          )}
        </div>
      )}
      {contentPreview && (
        <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", fontStyle: "italic" }}>
          {contentPreview}
        </div>
      )}
    </MessageRowShell>
  );
}

/* ─── Project Group (grouped view) ─── */
interface ProjectGroup {
  projectHash: string;
  label: string;
  entries: GeminiHistoryEntry[];
  latestTimestamp: number;
}

function buildProjectGroups(entries: GeminiHistoryEntry[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const entry of entries) {
    const key = entry.project_hash;
    const existing = map.get(key);
    if (existing) {
      existing.entries.push(entry);
      if (entry.timestamp > existing.latestTimestamp) {
        existing.latestTimestamp = entry.timestamp;
      }
    } else {
      map.set(key, {
        projectHash: key,
        label: entry.project_label || key,
        entries: [entry],
        latestTimestamp: entry.timestamp,
      });
    }
  }
  const groups = Array.from(map.values());
  groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  return groups;
}

type ViewMode = "flat" | "grouped";

/* ─── Tooltip state ─── */
interface TooltipState {
  entry: GeminiHistoryEntry;
  anchorRect: DOMRect;
}

/* ─── Session message cache ─── */
const sessionCache = new Map<string, GeminiSessionMessage[]>();

/* ─── Main Panel ─── */
export default function GeminiLogPanel() {
  const t = useGitT();
  const [entries, setEntries] = useState<GeminiHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [cwdFilter, setCwdFilter] = useState(true);

  const focusedCwd = useSessionStore((s) => {
    if (!cwdFilter) return "";
    const session = s.sessions.find((ses) => ses.id === s.activeSessionId);
    if (!session || !s.focusedPaneId) return "";
    const ptyId = findPtyId(session.rootPane, s.focusedPaneId);
    return ptyId ? s.paneCwds[ptyId] ?? "" : "";
  });
  const panelRef = useRef<HTMLDivElement>(null);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [tooltipMessages, setTooltipMessages] = useState<GeminiSessionMessage[]>([]);
  const [tooltipLoading, setTooltipLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiReadGeminiLogHistory(200);
      setEntries(data);
    } catch (e) {
      setEntries([]);
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const filteredEntries = useMemo(() => {
    if (!cwdFilter || !focusedCwd) return entries;
    const cwdBasename = focusedCwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()?.toLowerCase() ?? "";
    if (!cwdBasename) return entries;
    return entries.filter((e) => {
      const label = e.project_label.toLowerCase();
      return label === cwdBasename || cwdBasename.startsWith(label) || label.startsWith(cwdBasename);
    });
  }, [entries, cwdFilter, focusedCwd]);

  const projectGroups = useMemo(() => buildProjectGroups(filteredEntries), [filteredEntries]);
  const uniqueProjectCount = projectGroups.length;

  const cacheKey = useCallback((entry: GeminiHistoryEntry) => `${entry.project_hash}/${entry.tag}`, []);

  const handleRowClick = useCallback(async (entry: GeminiHistoryEntry, rect: DOMRect) => {
    const key = `${entry.project_hash}/${entry.tag}`;
    if (tooltip && cacheKey(tooltip.entry) === key) {
      setTooltip(null);
      setTooltipMessages([]);
      setTooltipLoading(false);
      return;
    }

    setTooltip({ entry, anchorRect: rect });

    const cached = sessionCache.get(key);
    if (cached) {
      setTooltipMessages(cached);
      setTooltipLoading(false);
      return;
    }

    setTooltipMessages([]);
    setTooltipLoading(true);
    try {
      const msgs = await apiReadGeminiLogSession(entry.project_hash, entry.tag);
      sessionCache.set(key, msgs);
      if (sessionCache.size > 32) {
        const first = sessionCache.keys().next().value;
        if (first) sessionCache.delete(first);
      }
      setTooltipMessages(msgs);
    } catch {
      setTooltipMessages([]);
    } finally {
      setTooltipLoading(false);
    }
  }, [tooltip, cacheKey]);

  const handleDetailClose = useCallback(() => {
    setTooltip(null);
    setTooltipMessages([]);
    setTooltipLoading(false);
  }, []);

  if (!isTauri()) {
    return <div className="sb-empty">{t("geminiLog.desktopOnly")}</div>;
  }

  return (
    <div ref={panelRef} className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="sb-section-header flex items-center px-2 py-1 select-none shrink-0" style={{ gap: 6 }}>
        <span>
          {viewMode === "flat"
            ? t("geminiLog.sessions").replace("{count}", String(filteredEntries.length)).replace("{s}", filteredEntries.length !== 1 ? "s" : "")
            : t("geminiLog.projects").replace("{count}", String(uniqueProjectCount)).replace("{s}", uniqueProjectCount !== 1 ? "s" : "")}
        </span>
        <div className="ml-auto flex items-center" style={{ gap: 6 }}>
          <button
            onClick={() => setCwdFilter((v) => !v)}
            className="cursor-pointer"
            style={{ color: cwdFilter ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = cwdFilter ? "var(--accent-blue)" : "var(--text-muted)"; }}
            title={cwdFilter ? t("geminiLog.clearCwdFilter") : t("geminiLog.filterByCwd")}
          >
            <Crosshair size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))", flexShrink: 0 }} />
          </button>
          <button
            onClick={() => setViewMode((m) => (m === "flat" ? "grouped" : "flat"))}
            className="cursor-pointer"
            style={{ color: viewMode === "grouped" ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = viewMode === "grouped" ? "var(--accent-blue)" : "var(--text-muted)"; }}
            title={viewMode === "flat" ? t("geminiLog.groupByProject") : t("geminiLog.flatList")}
          >
            {viewMode === "flat" ? (
              <TreeStructure size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))", flexShrink: 0 }} />
            ) : (
              <List size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))", flexShrink: 0 }} />
            )}
          </button>
          <button
            onClick={loadHistory}
            className="sb-icon cursor-pointer"
            style={{ lineHeight: 0 }}
            title={t("geminiLog.refresh")}
            disabled={loading}
          >
            <ArrowClockwise size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))", flexShrink: 0 }} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="sb-empty">{t("geminiLog.loading")}</div>
        ) : loadError ? (
          <div className="sb-empty" style={{ color: "var(--accent-red)", fontSize: "var(--fs-10)", padding: "8px", wordBreak: "break-all" }}>
            {t("geminiLog.error")}{loadError}
          </div>
        ) : entries.length === 0 ? (
          <div className="sb-empty">{t("geminiLog.noLogs")}</div>
        ) : viewMode === "grouped" ? (
          projectGroups.map((group) => (
            <GroupRow
              key={group.projectHash}
              label={group.label}
              count={group.entries.length}
              latestTimestamp={group.latestTimestamp}
              entries={group.entries}
              renderEntry={(entry) => (
                <HistoryRow
                  key={`${entry.project_hash}/${entry.tag}`}
                  entry={entry}
                  onClick={handleRowClick}
                  activeKey={tooltip ? `${tooltip.entry.project_hash}/${tooltip.entry.tag}` : null}
                  indent
                  t={t}
                />
              )}
              t={t}
            />
          ))
        ) : (
          filteredEntries.map((entry) => (
            <HistoryRow
              key={`${entry.project_hash}/${entry.tag}`}
              entry={entry}
              onClick={handleRowClick}
              activeKey={tooltip ? `${tooltip.entry.project_hash}/${tooltip.entry.tag}` : null}
              t={t}
            />
          ))
        )}
      </div>

      {/* Session Detail Panel */}
      {tooltip && (
        <SessionDetailPanel
          entry={tooltip.entry}
          messages={tooltipMessages}
          loading={tooltipLoading}
          anchorRect={tooltip.anchorRect}
          panelRight={panelRef.current?.getBoundingClientRect().right ?? 0}
          onClose={handleDetailClose}
          ownerRef={panelRef}
          t={t}
        />
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  onClick,
  activeKey,
  indent,
  t,
}: {
  entry: GeminiHistoryEntry;
  onClick: (entry: GeminiHistoryEntry, rect: DOMRect) => void;
  activeKey: string | null;
  indent?: boolean;
  t: (key: TranslationKey) => string;
}) {
  const key = `${entry.project_hash}/${entry.tag}`;
  const isActive = activeKey === key;
  return (
    <HistoryRowShell isActive={isActive} indent={indent} icon={<GeminiIcon />} onClick={(rect) => onClick(entry, rect)}>
      <div className="truncate" style={{ lineHeight: 1.3 }}>
        {truncateDisplay(entry.display, 60)}
      </div>
      <div
        className="flex items-center gap-1"
        style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", marginTop: 1 }}
      >
        <span>{relativeTime(entry.timestamp, t)}</span>
        <span style={{ marginLeft: "auto" }}>
          <IdBadge id={entry.tag} maxLen={16} />
        </span>
        <ProjectLabel label={entry.project_label} />
      </div>
    </HistoryRowShell>
  );
}
