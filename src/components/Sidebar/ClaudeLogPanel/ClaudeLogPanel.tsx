import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiReadClaudeLogHistory, apiReadClaudeLogSession, isTauri } from "../../../lib/bridge";
import { useSessionStore } from "../../../stores/sessionStore";
import { collectPtyIds } from "../../../lib/paneTreeUtils";
import type { ClaudeHistoryEntry, ClaudeSessionMessage } from "../../../types/claudelog";
import {
  ArrowClockwise,
  Crosshair,
  List,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { useGitT } from "../../../lib/i18n/git";
import { ICON_STYLE } from "../logUtils";
import { logger } from "../../../lib/logger";
import { GroupRow } from "../LogShared";
import { buildProjectGroups } from "./helpers";
import { sessionCache } from "./types";
import type { ViewMode, TooltipState, FilterState } from "./types";
import SessionDetailPanel from "./SessionDetailPanel";
import HistoryRow from "./HistoryRow";
import { ClaudeApiUsagePanel } from "./UsageComponents";

export default function ClaudeLogPanel() {
  const t = useGitT();
  const [entries, setEntries] = useState<ClaudeHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [filter, setFilter] = useState<FilterState>(null);
  const [cwdFilter, setCwdFilter] = useState(true);

  const sessionCwdsKey = useSessionStore((s) => {
    if (!cwdFilter) return "";
    const session = s.sessions.find((ses) => ses.id === s.activeSessionId);
    if (!session) return "";
    return collectPtyIds(session.rootPane)
      .map((id) => s.paneCwds[id] ?? "")
      .filter(Boolean)
      .join("\0");
  });
  const panelRef = useRef<HTMLDivElement>(null);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [tooltipMessages, setTooltipMessages] = useState<ClaudeSessionMessage[]>([]);
  const [tooltipLoading, setTooltipLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiReadClaudeLogHistory(200);
      logger.debug("[ClaudeLogPanel] loaded", data.length, "entries");
      setEntries(data);
    } catch (e) {
      setEntries([]);
      setLoadError(String(e));
      logger.error("[ClaudeLogPanel] load error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Reload when window regains focus (handles case where history grows while app is in background)
  useEffect(() => {
    const onFocus = () => { loadHistory(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadHistory]);

  const filteredEntries = useMemo(() => {
    const sessionCwds = sessionCwdsKey ? sessionCwdsKey.split("\0") : [];
    let result = entries;
    if (cwdFilter && sessionCwds.length > 0) {
      const cwds = sessionCwds.map((c) => c.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
      result = result.filter((e) => {
        const proj = e.project.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        return cwds.some((cwd) => proj === cwd || cwd.startsWith(proj + "/") || proj.startsWith(cwd + "/"));
      });
    }
    if (!filter) return result;
    if (filter.type === "project") return result.filter((e) => e.project_label === filter.value);
    if (filter.type === "session") return result.filter((e) => e.session_id === filter.value);
    return result;
  }, [entries, filter, cwdFilter, sessionCwdsKey]);

  const projectGroups = useMemo(() => buildProjectGroups(filteredEntries), [filteredEntries]);
  const uniqueProjectCount = projectGroups.length;

  const toggleFilter = useCallback((type: "project" | "session", value: string) => {
    setFilter((prev) => (prev?.type === type && prev.value === value ? null : { type, value }));
  }, []);

  const handleRowClick = useCallback(async (entry: ClaudeHistoryEntry, rect: DOMRect) => {
    if (tooltip?.entry.session_id === entry.session_id) {
      setTooltip(null);
      setTooltipMessages([]);
      setTooltipLoading(false);
      return;
    }

    setTooltip({ entry, anchorRect: rect });

    const cached = sessionCache.get(entry.session_id);
    if (cached) {
      setTooltipMessages(cached);
      setTooltipLoading(false);
      return;
    }

    setTooltipMessages([]);
    setTooltipLoading(true);
    try {
      const msgs = await apiReadClaudeLogSession(entry.project, entry.session_id);
      sessionCache.set(entry.session_id, msgs);
      setTooltipMessages(msgs);
    } catch {
      setTooltipMessages([]);
    } finally {
      setTooltipLoading(false);
    }
  }, [tooltip]);

  const handleDetailClose = useCallback(() => {
    setTooltip(null);
    setTooltipMessages([]);
    setTooltipLoading(false);
  }, []);

  if (!isTauri()) {
    return <div className="sb-empty">{t("claudeLog.desktopOnly")}</div>;
  }

  return (
    <div ref={panelRef} className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="sb-section-header flex items-center px-2 py-1 select-none shrink-0" style={{ gap: 6 }}>
        <span>
          {viewMode === "flat"
            ? t("claudeLog.sessions").replace("{count}", String(filteredEntries.length)).replace("{s}", filteredEntries.length !== 1 ? "s" : "")
            : t("claudeLog.projects").replace("{count}", String(uniqueProjectCount)).replace("{s}", uniqueProjectCount !== 1 ? "s" : "")}
        </span>
        {filter && (
          <button
            onClick={() => setFilter(null)}
            className="flex items-center gap-1 cursor-pointer"
            style={{
              fontSize: "var(--fs-9)",
              color: "var(--accent-blue)",
              background: "hsla(210, 60%, 50%, 0.12)",
              border: "1px solid hsla(210, 60%, 50%, 0.25)",
              borderRadius: 3,
              padding: "0 5px",
              lineHeight: 1.4,
            }}
            title={t("claudeLog.clearFilter")}
          >
            <span>{filter.type === "project" ? filter.value : filter.value.slice(0, 8)}</span>
            <X size={9} weight="bold" />
          </button>
        )}
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
            {viewMode === "flat" ? (
              <TreeStructure size={14} style={ICON_STYLE(14)} />
            ) : (
              <List size={14} style={ICON_STYLE(14)} />
            )}
          </button>
          <button
            onClick={loadHistory}
            className="sb-icon cursor-pointer"
            style={{ lineHeight: 0 }}
            title={t("claudeLog.refresh")}
            disabled={loading}
          >
            <ArrowClockwise size={14} style={ICON_STYLE(14)} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="sb-empty">{t("claudeLog.loading")}</div>
        ) : loadError ? (
          <div className="sb-empty" style={{ color: "var(--accent-red)", fontSize: "var(--fs-10)", padding: "8px", wordBreak: "break-all" }}>
            {t("claudeLog.error")}{loadError}
          </div>
        ) : entries.length === 0 ? (
          <div className="sb-empty">{t("claudeLog.noLogs")}</div>
        ) : viewMode === "grouped" ? (
          projectGroups.map((group) => (
            <GroupRow
              key={group.project}
              label={group.label}
              count={group.entries.length}
              latestTimestamp={group.latestTimestamp}
              entries={group.entries}
              renderEntry={(entry) => (
                <HistoryRow
                  key={entry.session_id}
                  entry={entry}
                  onClick={handleRowClick}
                  onFilter={toggleFilter}
                  activeSessionId={tooltip?.entry.session_id ?? null}
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
              key={entry.session_id}
              entry={entry}
              onClick={handleRowClick}
              onFilter={toggleFilter}
              activeFilter={filter}
              activeSessionId={tooltip?.entry.session_id ?? null}
              t={t}
            />
          ))
        )}
      </div>

      <ClaudeApiUsagePanel />

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
