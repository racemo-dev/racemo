import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiReadCodexLogHistory, apiReadCodexLogSession, isTauri } from "../../../lib/bridge";
import { useSessionStore } from "../../../stores/sessionStore";
import { findPtyId } from "../../../lib/paneTreeUtils";
import type { CodexSessionMessage, CodexSessionMeta } from "../../../types/codexlog";
import {
  ArrowClockwise,
  Crosshair,
  List,
  TreeStructure,
} from "@phosphor-icons/react";
import { useGitT } from "../../../lib/i18n/git";
import { GroupRow } from "../LogShared";
import { buildProjectGroups } from "./helpers";
import { sessionCache } from "./types";
import type { TooltipState, ViewMode } from "./types";
import { HistoryRow, SessionDetailPanel } from "./SubComponents";

export default function CodexLogPanel() {
  const t = useGitT();
  const [entries, setEntries] = useState<import("../../../types/codexlog").CodexHistoryEntry[]>([]);
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
  const [tooltipMeta, setTooltipMeta] = useState<CodexSessionMeta | null>(null);
  const [tooltipMessages, setTooltipMessages] = useState<CodexSessionMessage[]>([]);
  const [tooltipLoading, setTooltipLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiReadCodexLogHistory(200);
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
    const cwd = focusedCwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return entries.filter((e) => {
      const ecwd = e.cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      return ecwd === cwd || cwd.startsWith(ecwd + "/") || ecwd.startsWith(cwd + "/");
    });
  }, [entries, cwdFilter, focusedCwd]);

  const projectGroups = useMemo(() => buildProjectGroups(filteredEntries), [filteredEntries]);
  const uniqueProjectCount = projectGroups.length;

  const handleRowClick = useCallback(async (entry: import("../../../types/codexlog").CodexHistoryEntry, rect: DOMRect) => {
    if (tooltip?.entry.session_id === entry.session_id) {
      setTooltip(null);
      setTooltipMessages([]);
      setTooltipMeta(null);
      setTooltipLoading(false);
      return;
    }

    setTooltip({ entry, anchorRect: rect });

    const cached = sessionCache.get(entry.session_id);
    if (cached) {
      setTooltipMeta(cached.meta);
      setTooltipMessages(cached.messages);
      setTooltipLoading(false);
      return;
    }

    setTooltipMessages([]);
    setTooltipMeta(null);
    setTooltipLoading(true);
    try {
      const [meta, msgs] = await apiReadCodexLogSession(entry.session_id);
      sessionCache.set(entry.session_id, { meta, messages: msgs });
      setTooltipMeta(meta);
      setTooltipMessages(msgs);
    } catch {
      setTooltipMessages([]);
      setTooltipMeta(null);
    } finally {
      setTooltipLoading(false);
    }
  }, [tooltip]);

  const handleDetailClose = useCallback(() => {
    setTooltip(null);
    setTooltipMessages([]);
    setTooltipMeta(null);
    setTooltipLoading(false);
  }, []);

  if (!isTauri()) {
    return <div className="sb-empty">{t("codexLog.desktopOnly")}</div>;
  }

  return (
    <div ref={panelRef} className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="sb-section-header flex items-center px-2 py-1 select-none shrink-0" style={{ gap: 6 }}>
        <span>
          {viewMode === "flat"
            ? t("codexLog.sessions").replace("{count}", String(filteredEntries.length)).replace("{s}", filteredEntries.length !== 1 ? "s" : "")
            : t("codexLog.projects").replace("{count}", String(uniqueProjectCount)).replace("{s}", uniqueProjectCount !== 1 ? "s" : "")}
        </span>
        <div className="ml-auto flex items-center" style={{ gap: 6 }}>
          <button
            onClick={() => setCwdFilter((v) => !v)}
            className="cursor-pointer"
            style={{ color: cwdFilter ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = cwdFilter ? "var(--accent-blue)" : "var(--text-muted)"; }}
            title={cwdFilter ? t("codexLog.clearCwdFilter") : t("codexLog.filterByCwd")}
          >
            <Crosshair size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))", flexShrink: 0 }} />
          </button>
          <button
            onClick={() => setViewMode((m) => (m === "flat" ? "grouped" : "flat"))}
            className="cursor-pointer"
            style={{ color: viewMode === "grouped" ? "var(--accent-blue)" : "var(--text-muted)", lineHeight: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = viewMode === "grouped" ? "var(--accent-blue)" : "var(--text-muted)"; }}
            title={viewMode === "flat" ? t("codexLog.groupByProject") : t("codexLog.flatList")}
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
            title={t("codexLog.refresh")}
            disabled={loading}
          >
            <ArrowClockwise size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))", flexShrink: 0 }} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="sb-empty">{t("codexLog.loading")}</div>
        ) : loadError ? (
          <div className="sb-empty" style={{ color: "var(--accent-red)", fontSize: "var(--fs-10)", padding: "8px", wordBreak: "break-all" }}>
            {t("codexLog.error")}{loadError}
          </div>
        ) : entries.length === 0 ? (
          <div className="sb-empty">{t("codexLog.noLogs")}</div>
        ) : viewMode === "grouped" ? (
          projectGroups.map((group) => (
            <GroupRow
              key={group.cwd}
              label={group.label}
              count={group.entries.length}
              latestTimestamp={group.latestTimestamp}
              entries={group.entries}
              renderEntry={(entry) => (
                <HistoryRow
                  key={entry.session_id}
                  entry={entry}
                  onClick={handleRowClick}
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
              activeSessionId={tooltip?.entry.session_id ?? null}
              t={t}
            />
          ))
        )}
      </div>

      {/* Session Detail Panel */}
      {tooltip && (
        <SessionDetailPanel
          entry={tooltip.entry}
          meta={tooltipMeta}
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
