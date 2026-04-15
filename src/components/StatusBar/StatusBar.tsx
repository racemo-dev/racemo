import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../stores/sessionStore";
import { useThemeStore, applyCssTheme } from "../../stores/themeStore";
import { useBroadcastStore } from "../../stores/broadcastStore";
import { usePrivacyStore } from "../../stores/privacyStore";

import { useSettingsStore } from "../../stores/settingsStore";
import { useGitStore } from "../../stores/gitStore";
import { useSidebarStore } from "../../stores/sidebarStore";
import { applyThemeToAll, applyFontSizeToAll } from "../../lib/terminalRegistry";
import { collectPtyIds, findPtyId } from "../../lib/paneTreeUtils";
import { getModLabel, isWindows, isMac } from "../../lib/osUtils";
import { useGitT } from "../../lib/i18n/git";
import { logger } from "../../lib/logger";

function PaletteIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))' }}>
      <circle cx="8" cy="8" r="6.5" />
      <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="11" cy="8.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="9.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function StatusBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const focusedPaneId = useSessionStore((s) => s.focusedPaneId);
  const paneShellTypes = useSessionStore((s) => s.paneShellTypes);
  const isIpcReady = useSessionStore((s) => s.isIpcReady);
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const themeName = useThemeStore((s) => s.themeName);
  const fontSize = useThemeStore((s) => s.fontSize);
  const nextTheme = useThemeStore((s) => s.nextTheme);
  const getTheme = useThemeStore((s) => s.getTheme);
  const resetFontSize = useThemeStore((s) => s.resetFontSize);

  const broadcastEnabled = useBroadcastStore((s) => s.enabled);
  const broadcastToggle = useBroadcastStore((s) => s.toggle);
  const broadcastSelectAll = useBroadcastStore((s) => s.selectAll);
  const broadcastClear = useBroadcastStore((s) => s.clearSelection);
  const broadcastSelectedCount = useBroadcastStore((s) => s.selectedPtyIds.length);

  const privacyEnabled = usePrivacyStore((s) => s.enabled);
  const privacyToggle = usePrivacyStore((s) => s.toggle);

  const repoInfo = useGitStore((s) => s.repoInfo);
  const togglePanel = useSidebarStore((s) => s.togglePanel);

  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const t = useGitT();

  // Get shell type for the focused pane
  const focusedPtyId = activeSession && focusedPaneId
    ? findPtyId(activeSession.rootPane, focusedPaneId)
    : null;
  const paneShell = focusedPtyId ? paneShellTypes[focusedPtyId] : null;
  const effectiveShell = paneShell ?? defaultShell;

  // Re-compute shell label based on focused pane's shell type
  const shellLabel = isWindows()
    ? (effectiveShell === "PowerShell" ? "pwsh" : effectiveShell === "Cmd" ? "cmd" : effectiveShell === "Wsl" ? "wsl" : "pwsh")
    : (isMac() ? "zsh" : "bash");

  const handleThemeToggle = () => {
    nextTheme();
    const theme = getTheme();
    applyCssTheme(theme);
    applyThemeToAll();
  };

  const handleFontSizeReset = () => {
    resetFontSize();
    applyFontSizeToAll();
  };

  return (
    <div
      className="flex items-center justify-between shrink-0 select-none px-3"
      style={{
        height: 'calc(26px * var(--ui-scale))',
        minHeight: 'calc(26px * var(--ui-scale))',
        maxHeight: 'calc(26px * var(--ui-scale))',
        background: "var(--bg-elevated)",
        borderTop: "1px solid var(--border-default)",
        fontSize: 'var(--fs-12)',
        overflow: "hidden",
        flexWrap: "nowrap",
        whiteSpace: "nowrap",
      }}
    >
      {/* Left */}
      <div className="flex items-center gap-3" style={{ overflow: "hidden", flexShrink: 1, minWidth: 0 }}>
        <span
          className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity"
          title={isIpcReady ? t("status.serverConnected") : t("status.serverDisconnected")}
          onClick={async (e) => {
            e.stopPropagation();
            // Try to reconnect regardless of current state if clicked (user requested)
            try {
              logger.debug("[racemo] Manual reconnection triggered from StatusBar");
              await invoke("reconnect_ipc");
            } catch (err) {
              logger.error("Manual reconnection failed:", err);
            }
          }}
        >
          <span
            className="inline-block rounded-full"
            style={{
              width: 'calc(6px * var(--ui-scale))',
              height: 'calc(6px * var(--ui-scale))',
              background: isIpcReady ? "var(--status-active, #4ade80)" : "var(--status-inactive, #ef4444)",
              boxShadow: isIpcReady ? "0 0 4px var(--status-active, #4ade80)" : "none",
            }}
          />
          <span style={{ color: isIpcReady ? "var(--text-secondary)" : "var(--status-inactive, #ef4444)" }}>
            {activeSession ? activeSession.name : t("status.noSession")}
          </span>
        </span>
        {activeSession && (
          <span style={{ color: "var(--text-muted)" }}>
            {t("status.panes")}: {activeSession.paneCount}
          </span>
        )}
        <span style={{ color: "var(--text-muted)" }}>
          {t("status.sessions")}: {sessions.length}
        </span>
        <span
          className="flex items-center gap-1 uppercase"
          style={{
            fontSize: 'var(--fs-11)',
            letterSpacing: "0.05em",
            color: "var(--text-tertiary)",
            background: "var(--bg-overlay)",
            padding: "0 4px",
            borderRadius: 3,
          }}
          title={t("status.shellTitle")}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
            <polyline points="4,4 8,8 4,12" />
            <line x1="10" y1="12" x2="14" y2="12" />
          </svg>
          {shellLabel}
        </span>

        {/* Git branch indicator */}
        {repoInfo && (
          <button
            onClick={() => togglePanel("git")}
            className="flex items-center gap-1 uppercase cursor-pointer transition-colors"
            style={{
              fontSize: 'var(--fs-11)',
              letterSpacing: "0.05em",
              color: "var(--text-tertiary)",
              background: "transparent",
              padding: "0 4px",
              borderRadius: 3,
              border: "none",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
            title={t("status.gitTitle")}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
              <circle cx="5" cy="4" r="2" />
              <circle cx="5" cy="12" r="2" />
              <circle cx="11" cy="8" r="2" />
              <line x1="5" y1="6" x2="5" y2="10" />
              <path d="M5 6c0 2 6 2 6 0" />
            </svg>
            <span style={{ textTransform: "none" }}>{repoInfo.branch}</span>
            {(repoInfo.ahead > 0 || repoInfo.behind > 0) && (
              <span style={{ fontSize: 'var(--fs-8)' }}>
                {repoInfo.ahead > 0 && `\u2191${repoInfo.ahead}`}
                {repoInfo.behind > 0 && `\u2193${repoInfo.behind}`}
              </span>
            )}
          </button>
        )}

        {/* Broadcast toggle */}
        <span className="flex items-center gap-1">
          <button
            onClick={() => {
              broadcastToggle();
              // Auto-select all panes when enabling
              if (!broadcastEnabled && activeSession) {
                const ptyIds = collectPtyIds(activeSession.rootPane);
                broadcastSelectAll(ptyIds);
              }
            }}
            className="flex items-center gap-1 uppercase cursor-pointer transition-colors"
            style={{
              fontSize: 'var(--fs-11)',
              letterSpacing: "0.05em",
              color: broadcastEnabled ? "var(--accent-cyan, #22d3ee)" : "var(--text-tertiary)",
              background: broadcastEnabled ? "color-mix(in srgb, var(--accent-cyan, #22d3ee) 10%, transparent)" : "transparent",
              padding: "0 4px",
              borderRadius: 3,
            }}
            onMouseEnter={(e) => {
              if (!broadcastEnabled) (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              if (!broadcastEnabled) (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)";
            }}
            title={`${t("status.broadcastTitle")} (${getModLabel()}+B)`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
              <circle cx="8" cy="8" r="2" />
              <path d="M4.5 4.5a5 5 0 0 1 7 0" />
              <path d="M11.5 11.5a5 5 0 0 1-7 0" />
              <path d="M2.5 2.5a8 8 0 0 1 11 0" />
              <path d="M13.5 13.5a8 8 0 0 1-11 0" />
            </svg>
            <span>{t("status.broadcast")}{broadcastEnabled ? ` (${broadcastSelectedCount})` : ""}</span>
          </button>
          {broadcastEnabled && (
            <button
              onClick={() => {
                if (activeSession) {
                  const allPtyIds = collectPtyIds(activeSession.rootPane);
                  if (broadcastSelectedCount === allPtyIds.length) {
                    broadcastClear();
                  } else {
                    broadcastSelectAll(allPtyIds);
                  }
                }
              }}
              className="uppercase cursor-pointer transition-colors"
              style={{
                fontSize: 'var(--fs-11)',
                color: "var(--accent-cyan, #22d3ee)",
                letterSpacing: "0.05em",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
              title={t("status.broadcastAll")}
            >
              All
            </button>
          )}
        </span>
      </div>

      {/* Right */}
      <div className="flex items-center gap-3" style={{ flexShrink: 0 }}>
        {/* Privacy/Masking toggle */}
        <button
          onClick={privacyToggle}
          className="flex items-center gap-1 uppercase cursor-pointer transition-colors"
          style={{
            fontSize: 'var(--fs-11)',
            letterSpacing: "0.05em",
            color: privacyEnabled ? "var(--accent-yellow)" : "var(--text-tertiary)",
            background: privacyEnabled ? "color-mix(in srgb, var(--accent-yellow) 10%, transparent)" : "transparent",
            padding: "0 4px",
            borderRadius: 3,
          }}
          onMouseEnter={(e) => {
            if (!privacyEnabled) (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            if (!privacyEnabled) (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)";
          }}
          title={`${t("status.maskTitle")} (${getModLabel()}+Shift+M)`}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
            {privacyEnabled ? (
              <>
                <rect x="3" y="7" width="10" height="7" rx="1.5" />
                <path d="M5 7V5a3 3 0 0 1 6 0v2" />
              </>
            ) : (
              <>
                <rect x="3" y="7" width="10" height="7" rx="1.5" />
                <path d="M5 7V5a3 3 0 0 1 6 0v2" />
                <line x1="2" y1="2" x2="14" y2="14" />
              </>
            )}
          </svg>
          <span>{t("status.mask")}{privacyEnabled ? " ON" : ""}</span>
        </button>

        <button
          onClick={handleFontSizeReset}
          className="flex items-center gap-1 uppercase cursor-pointer transition-colors"
          style={{ color: "var(--text-tertiary)", fontSize: 'var(--fs-11)', letterSpacing: "0.05em" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          title={t("status.fontTitle")}
        >
          <span>{fontSize}px</span>
        </button>
        <button
          onClick={handleThemeToggle}
          className="flex items-center gap-1 uppercase cursor-pointer transition-colors"
          style={{ color: "var(--text-tertiary)", fontSize: 'var(--fs-11)', letterSpacing: "0.05em" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          title={t("status.themeTitle")}
        >
          <PaletteIcon />
          <span>{themeName}</span>
        </button>
        <span
          style={{ color: "var(--text-tertiary)", letterSpacing: "0.05em" }}
          className="uppercase"
        >
          Racemo v{__APP_VERSION__}
        </span>
      </div>
    </div>
  );
}
