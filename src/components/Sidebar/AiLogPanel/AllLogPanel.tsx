import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiReadClaudeLogHistory,
  apiReadCodexLogHistory,
  apiReadGeminiLogHistory,
  apiReadOpenCodeLogHistory,
} from "../../../lib/bridge";
import { useSessionStore } from "../../../stores/sessionStore";
import { collectPtyIds, collectLeafCwds } from "../../../lib/paneTreeUtils";
import { useGitT, type TranslationKey } from "../../../lib/i18n/git";
import { ArrowClockwise, Crosshair, List, TreeStructure } from "@phosphor-icons/react";
import { relativeTime, truncateDisplay, formatTokens, ICON_STYLE } from "../logUtils";
import {
  ToolBadge,
  MarkdownContent,
  LogMdStyles,
  DetailPanelShell,
  DetailPanelHeader,
  MessageListBody,
  MessageRowShell,
  GroupRow,
  HistoryRowShell,
  INITIAL_MESSAGE_COUNT,
} from "../LogShared";
import type { UnifiedEntry, UnifiedMessage } from "./types";
import { PROVIDER_ICON_MAP, buildSessionLoader, sessionCache } from "./types";

/* ─── All Panel ─── */

export function AllLogPanel({ availableIds }: { availableIds: Set<string> }) {
  const t = useGitT();
  const [entries, setEntries] = useState<UnifiedEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [cwdFilter, setCwdFilter] = useState(true);
  const [viewMode, setViewMode] = useState<"flat" | "grouped">("flat");
  const panelRef = useRef<HTMLDivElement>(null);

  const sessionCwdsKey = useSessionStore((s) => {
    if (!cwdFilter) return "";
    const session = s.sessions.find((ses) => ses.id === s.activeSessionId);
    if (!session) return "";
    const leafCwds = collectLeafCwds(session.rootPane);
    return collectPtyIds(session.rootPane)
      .map((id) => s.paneCwds[id] || leafCwds.find((l) => l.ptyId === id)?.cwd || "")
      .filter(Boolean)
      .join("\0");
  });

  const [tooltip, setTooltip] = useState<{ entry: UnifiedEntry; anchorRect: DOMRect } | null>(null);
  const [tooltipMessages, setTooltipMessages] = useState<UnifiedMessage[]>([]);
  const [tooltipLoading, setTooltipLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const fetches: Promise<UnifiedEntry[]>[] = [];
      if (availableIds.has("claude")) {
        fetches.push(apiReadClaudeLogHistory(100).then((data) => data.map((e) => ({ providerId: "claude", display: e.display, timestamp: e.timestamp, sessionKey: `claude|${e.project}|${e.session_id}`, cwd: e.project }))));
      }
      if (availableIds.has("codex")) {
        fetches.push(apiReadCodexLogHistory(100).then((data) => data.map((e) => ({ providerId: "codex", display: e.display, timestamp: e.timestamp, sessionKey: `codex|${e.session_id}`, cwd: e.cwd }))));
      }
      if (availableIds.has("gemini")) {
        fetches.push(apiReadGeminiLogHistory(100).then((data) => data.map((e) => ({ providerId: "gemini", display: e.display, timestamp: e.timestamp, sessionKey: `gemini|${e.project_hash}|${e.tag}`, cwd: "", geminiHash: e.project_hash }))));
      }
      if (availableIds.has("opencode")) {
        fetches.push(apiReadOpenCodeLogHistory(100).then((data) => data.map((e) => ({ providerId: "opencode", display: e.display, timestamp: e.timestamp, sessionKey: `opencode|${e.session_id}`, cwd: e.directory }))));
      }
      const settled = await Promise.allSettled(fetches);
      const results = settled.flatMap((r) => r.status === "fulfilled" ? r.value : []);
      results.sort((a, b) => b.timestamp - a.timestamp);
      setEntries(results);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [availableIds]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const loadSession = useMemo(() => buildSessionLoader(), []);

  const handleRowClick = useCallback(async (entry: UnifiedEntry, rect: DOMRect) => {
    if (tooltip?.entry.sessionKey === entry.sessionKey) {
      setTooltip(null); setTooltipMessages([]); setTooltipLoading(false);
      return;
    }
    setTooltip({ entry, anchorRect: rect });
    const cached = sessionCache.get(entry.sessionKey);
    if (cached) { setTooltipMessages(cached); setTooltipLoading(false); return; }
    setTooltipMessages([]); setTooltipLoading(true);
    try {
      const msgs = await loadSession(entry.sessionKey);
      sessionCache.set(entry.sessionKey, msgs);
      if (sessionCache.size > 32) { const first = sessionCache.keys().next().value; if (first) sessionCache.delete(first); }
      setTooltipMessages(msgs);
    } catch { setTooltipMessages([]); }
    finally { setTooltipLoading(false); }
  }, [tooltip, loadSession]);

  const handleDetailClose = useCallback(() => { setTooltip(null); setTooltipMessages([]); setTooltipLoading(false); }, []);

  const filteredEntries = useMemo(() => {
    const sessionCwds = sessionCwdsKey ? sessionCwdsKey.split("\0") : [];
    let result = entries;
    if (cwdFilter && sessionCwds.length > 0) {
      // Full paths (lowercased, normalized) for Claude/Codex/OpenCode
      const cwds = sessionCwds.map((c) => c.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
      // Last folder names for Gemini (which only stores folder name or hash, not full path)
      const folderNames = new Set(cwds.map((c) => c.split("/").pop() ?? "").filter(Boolean));
      result = result.filter((e) => {
        // Gemini: only has folder name or hash — match against last path component
        if (e.geminiHash) return folderNames.has(e.geminiHash.toLowerCase());
        // Claude/Codex/OpenCode: full path — exact match only
        if (!e.cwd) return false;
        const ecwd = e.cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        return cwds.some((cwd) => ecwd === cwd);
      });
    }
    return result;
  }, [entries, cwdFilter, sessionCwdsKey]);

  const cwdGroups = useMemo(() => {
    const map = new Map<string, UnifiedEntry[]>();
    for (const e of filteredEntries) {
      const key = e.cwd || "unknown";
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(e);
    }
    return Array.from(map.entries())
      .map(([cwd, entries]) => {
        const parts = cwd.replace(/\\/g, "/").split("/");
        const label = parts[parts.length - 1] || cwd;
        return { cwd, label, entries };
      })
      .sort((a, b) => b.entries[0].timestamp - a.entries[0].timestamp);
  }, [filteredEntries]);

  return (
    <div ref={panelRef} className="flex flex-col h-full">
      <div className="sb-section-header flex items-center px-2 py-1 select-none shrink-0" style={{ gap: 6 }}>
        <span>
          {viewMode === "flat"
            ? t("claudeLog.sessions").replace("{count}", String(filteredEntries.length)).replace("{s}", filteredEntries.length !== 1 ? "s" : "")
            : t("claudeLog.projects").replace("{count}", String(cwdGroups.length)).replace("{s}", cwdGroups.length !== 1 ? "s" : "")}
        </span>
        <div className="ml-auto flex items-center" style={{ gap: 6 }}>
          <button
            onClick={() => setCwdFilter((v) => !v)}
            className="cursor-pointer"
            style={{ color: cwdFilter ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = cwdFilter ? "var(--accent-blue)" : "var(--text-muted)"; }}
            title={cwdFilter ? t("claudeLog.clearFolderFilter") : t("claudeLog.filterByFolder")}
          >
            <Crosshair size={14} style={ICON_STYLE(14)} />
          </button>
          <button
            onClick={() => setViewMode((m) => (m === "flat" ? "grouped" : "flat"))}
            className="cursor-pointer"
            style={{ color: viewMode === "grouped" ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = viewMode === "grouped" ? "var(--accent-blue)" : "var(--text-muted)"; }}
            title={viewMode === "flat" ? t("claudeLog.groupByProject") : t("claudeLog.flatList")}
          >
            {viewMode === "flat" ? <TreeStructure size={14} style={ICON_STYLE(14)} /> : <List size={14} style={ICON_STYLE(14)} />}
          </button>
          <button onClick={loadAll} className="sb-icon cursor-pointer" style={{ lineHeight: 0 }} title={t("claudeLog.refresh")} disabled={loading}>
            <ArrowClockwise size={14} style={ICON_STYLE(14)} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="sb-empty">{t("claudeLog.loading")}</div>
        ) : filteredEntries.length === 0 ? (
          <div className="sb-empty">{t("claudeLog.noLogs")}</div>
        ) : viewMode === "grouped" ? (
          cwdGroups.map((group) => (
            <CwdGroup key={group.cwd} group={group} onClick={handleRowClick} activeKey={tooltip?.entry.sessionKey ?? null} t={t} />
          ))
        ) : (
          filteredEntries.map((entry) => (
            <UnifiedHistoryRow
              key={entry.sessionKey}
              entry={entry}
              onClick={handleRowClick}
              activeKey={tooltip?.entry.sessionKey ?? null}
              t={t}
            />
          ))
        )}
      </div>
      {tooltip && (
        <UnifiedDetailPanel
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

/* ─── Unified History Row ─── */

function UnifiedHistoryRow({ entry, onClick, activeKey, t, indent }: {
  entry: UnifiedEntry;
  onClick: (entry: UnifiedEntry, rect: DOMRect) => void;
  activeKey: string | null;
  t: (key: TranslationKey) => string;
  indent?: boolean;
}) {
  const isActive = activeKey === entry.sessionKey;
  return (
    <HistoryRowShell isActive={isActive} indent={indent} icon={PROVIDER_ICON_MAP[entry.providerId]} onClick={(rect) => onClick(entry, rect)}>
      <div className="truncate" style={{ lineHeight: 1.3 }}>{truncateDisplay(entry.display, 60)}</div>
      <div className="flex items-center gap-1" style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", marginTop: 1 }}>
        <span>{relativeTime(entry.timestamp, t)}</span>
      </div>
    </HistoryRowShell>
  );
}

/* ─── Provider Group (grouped view) ─── */

function CwdGroup({ group, onClick, activeKey, t }: {
  group: { cwd: string; label: string; entries: UnifiedEntry[] };
  onClick: (entry: UnifiedEntry, rect: DOMRect) => void;
  activeKey: string | null;
  t: (key: TranslationKey) => string;
}) {
  const latestTimestamp = group.entries[0]?.timestamp ?? 0;
  return (
    <GroupRow
      label={group.label}
      count={group.entries.length}
      latestTimestamp={latestTimestamp}
      entries={group.entries}
      renderEntry={(entry) => (
        <UnifiedHistoryRow key={entry.sessionKey} entry={entry} onClick={onClick} activeKey={activeKey} t={t} indent />
      )}
      t={t}
    />
  );
}

/* ─── Unified Detail Panel ─── */

function UnifiedDetailPanel({ entry, messages, loading, anchorRect, panelRight, onClose, ownerRef, t }: {
  entry: UnifiedEntry;
  messages: UnifiedMessage[];
  loading: boolean;
  anchorRect: DOMRect;
  panelRight: number;
  onClose: () => void;
  ownerRef: React.RefObject<HTMLDivElement | null>;
  t: (key: TranslationKey) => string;
}) {
  const [showCount, setShowCount] = useState(INITIAL_MESSAGE_COUNT);
  const totalInput = messages.reduce((s, m) => s + m.input_tokens, 0);
  const totalOutput = messages.reduce((s, m) => s + m.output_tokens, 0);

  return (
    <DetailPanelShell anchorRect={anchorRect} panelRight={panelRight} onClose={onClose} ownerRef={ownerRef}>
      <DetailPanelHeader title={entry.display} onClose={onClose} closeLabel={t("claudeLog.close")}>
        <span style={{ color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
          {PROVIDER_ICON_MAP[entry.providerId]}
        </span>
        <span className="sb-muted" style={{ fontSize: "var(--fs-9)", flexShrink: 0 }}>
          {relativeTime(entry.timestamp, t)}
        </span>
      </DetailPanelHeader>

      <LogMdStyles prefix="all-log-md" />

      <MessageListBody
        messages={messages}
        loading={loading}
        showCount={showCount}
        onShowMore={() => setShowCount((c) => c + INITIAL_MESSAGE_COUNT)}
        loadingText={t("claudeLog.loading")}
        emptyText={t("claudeLog.noMessages")}
        showMoreText={t("claudeLog.showMore").replace("{count}", String(messages.length - showCount))}
        renderMessage={(msg, idx) => <UnifiedMessageRow key={idx} message={msg} />}
      />

      {!loading && messages.length > 0 && (totalInput > 0 || totalOutput > 0) && (
        <div className="shrink-0" style={{ borderTop: "1px solid var(--border-subtle)", padding: "6px 10px", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", display: "flex", gap: 3, alignItems: "center" }}>
            <span style={{ color: "var(--accent-blue)" }}>↑</span>{formatTokens(totalInput)}
          </span>
          <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", display: "flex", gap: 3, alignItems: "center" }}>
            <span style={{ color: "var(--accent-purple)" }}>↓</span>{formatTokens(totalOutput)}
          </span>
        </div>
      )}
    </DetailPanelShell>
  );
}

/* ─── Unified Message Row ─── */

function UnifiedMessageRow({ message }: { message: UnifiedMessage }) {
  const isToolResult = message.role === "tool_result";

  return (
    <MessageRowShell
      role={message.role}
      isCollapsible={isToolResult}
      headerExtra={message.tool_name ? <ToolBadge name={message.tool_name} /> : undefined}
    >
      {message.content && (
        <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: 1.4, wordBreak: "break-word", fontFamily: isToolResult ? "var(--font-mono, monospace)" : undefined, whiteSpace: isToolResult ? "pre-wrap" : undefined }}>
          {isToolResult ? <span>{message.content}</span> : (
            <MarkdownContent content={message.content} className="all-log-md" />
          )}
        </div>
      )}
    </MessageRowShell>
  );
}
