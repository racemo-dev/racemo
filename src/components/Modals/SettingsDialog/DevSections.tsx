import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useLoggingStore } from "../../../stores/loggingStore";
import { useAuthStore } from "../../../stores/authStore";
import { useRemoteStore } from "../../../stores/remoteStore";
import { getModLabel, isWindows, safeOpenUrl } from "../../../lib/osUtils";
import { useGitT } from "../../../lib/i18n/git";
import { sectionTitleStyle, cardStyle, SettingRow } from "./shared";

/* ═══════════════════════════════════════════════
   Section: Debug (dev only)
   ═══════════════════════════════════════════════ */
export function DebugSection() {
  const t = useGitT();
  const enabled = useLoggingStore((s) => s.enabled);
  const logPath = useLoggingStore((s) => s.logPath);
  const setEnabled = useLoggingStore((s) => s.setEnabled);
  const imeInterceptEnabled = useSettingsStore((s) => s.imeInterceptEnabled);
  const setImeInterceptEnabled = useSettingsStore((s) => s.setImeInterceptEnabled);
  const blockHangulKey = useSettingsStore((s) => s.blockHangulKey);
  const setBlockHangulKey = useSettingsStore((s) => s.setBlockHangulKey);

  const handleToggle = (checked: boolean) => { setEnabled(checked); };

  const handleTestLog = () => {
    const testMessage = `[TEST] ${new Date().toISOString()} - Logging test\n`;
    invoke("append_shell_log", { data: testMessage })
      .then(() => alert(`Test successful!\nLog file: ${logPath}`))
      .catch((err) => alert(`Test failed: ${err}`));
  };

  const handleClearLog = () => {
    invoke("clear_shell_log").catch(console.error);
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div style={sectionTitleStyle}>{t("debug.shellLogging")}</div>
        <div className="flex flex-col gap-2">
          <SettingRow title={t("debug.logOutput")} desc={t("debug.logOutputDesc")}>
            <input type="checkbox" checked={enabled} onChange={(e) => handleToggle(e.target.checked)} />
          </SettingRow>
          {enabled && logPath && (
            <div style={cardStyle}>
              <div style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", fontWeight: 500, marginBottom: 6 }}>{t("debug.logFile")}</div>
              <div className="px-2 py-1 rounded mb-3" style={{ fontSize: 'var(--fs-10)', fontFamily: "monospace", color: "var(--text-secondary)", background: "var(--bg-overlay)", wordBreak: "break-all" }}>
                {logPath}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleTestLog}
                  className="px-3 py-1 rounded text-xs cursor-pointer transition-colors"
                  style={{ color: "var(--text-secondary)", background: "var(--bg-overlay)", border: "1px solid var(--border-default)" }}
                >
                  {t("debug.testLogging")}
                </button>
                <button
                  onClick={handleClearLog}
                  className="px-3 py-1 rounded text-xs cursor-pointer transition-colors"
                  style={{ color: "var(--text-secondary)", background: "var(--bg-overlay)", border: "1px solid var(--border-default)" }}
                >
                  {t("debug.clearLog")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* IME */}
      {isWindows() && (
        <div>
          <div style={sectionTitleStyle}>{t("settings.ime")}</div>
          <SettingRow title={t("settings.imeIntercept")} desc={t("settings.imeInterceptDesc")}>
            <input type="checkbox" checked={imeInterceptEnabled} onChange={(e) => setImeInterceptEnabled(e.target.checked)} />
          </SettingRow>
          <SettingRow title={t("settings.blockHangul")} desc={t("settings.blockHangulDesc")}>
            <input
              type="checkbox"
              checked={blockHangulKey}
              onChange={(e) => {
                const enabled = e.target.checked;
                setBlockHangulKey(enabled);
                invoke("set_block_hangul_key", { enabled }).catch(console.error);
              }}
            />
          </SettingRow>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   Section: Help
   ═══════════════════════════════════════════════ */
export function HelpSection() {
  const t = useGitT();
  const mod = getModLabel();
  return (
    <div className="flex flex-col gap-5">
      {/* Shortcuts */}
      <div>
        <div style={sectionTitleStyle}>{t("help.shortcuts")}</div>
        <div
          className="rounded"
          style={{
            fontSize: 'var(--fs-11)',
            color: "var(--text-tertiary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            overflow: "hidden",
          }}
        >
          {[
            [`${mod}+T`, t("help.newTab")],
            [`${mod}+Q`, t("help.closeTab")],
            [`Alt+1~9`, t("help.switchTab")],
            [`${mod}+Shift+\u2190/\u2192`, t("help.moveTab")],
            [`${mod}+F`, t("help.search")],
            [`${mod}+K`, t("help.commandPalette")],
            [`${mod}+R`, t("help.historySearch")],
            [`${mod}+B`, t("help.broadcast")],
            [`${mod}+Shift+M`, t("help.secretMasking")],
            [`${mod}+=`, t("help.zoomIn")],
            [`${mod}+-`, t("help.zoomOut")],
            [`${mod}+0`, t("help.resetZoom")],
            [`${mod}+?`, t("help.help")],
          ].map(([key, desc], i) => (
            <div
              key={key}
              className="flex items-center justify-between px-3 py-1.5"
              style={{
                borderBottom: i < 13 ? "1px solid var(--border-subtle)" : "none",
                background: i % 2 === 0 ? "transparent" : "var(--bg-overlay)",
              }}
            >
              <code style={{ color: "var(--text-secondary)", fontFamily: "monospace", fontSize: 'var(--fs-10)' }}>{key}</code>
              <span style={{ textAlign: "right" }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Features */}
      <div>
        <div style={sectionTitleStyle}>{t("help.features")}</div>
        <div className="flex flex-col gap-3" style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {[
            [t("help.broadcastTitle"), t("help.broadcastDesc").replace("{mod}", mod)],
            [t("help.paletteTitle"), t("help.paletteDesc").replace("{mod}", mod)],
            [t("help.autocompleteTitle"), t("help.autocompleteDesc")],
            [t("help.maskingTitle"), t("help.maskingDesc").replace("{mod}", mod)],
            [t("help.historyTitle"), t("help.historyDesc").replace("{mod}", mod)],
          ].map(([title, desc]) => (
            <div key={title}>
              <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{title}</span>
              <p style={{ color: "var(--text-tertiary)", fontSize: 'var(--fs-10)', margin: "2px 0 0" }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* About */}
      <div>
        <div style={sectionTitleStyle}>{t("help.about")}</div>
        <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-tertiary)", lineHeight: 1.6 }}>
          <div>Racemo v{__APP_VERSION__}</div>
          <div>{t("help.aboutDesc")}</div>
          <div style={{ marginTop: 4, color: "var(--text-muted)" }}>Built with Tauri v2 + React + xterm.js</div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   Section: Account
   ═══════════════════════════════════════════════ */
export function AccountSection() {
  const t = useGitT();
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const startLogin = useAuthStore((s) => s.startLogin);
  const logout = useAuthStore((s) => s.logout);
  const deviceFlow = useAuthStore((s) => s.deviceFlow);
  const cancelLogin = useAuthStore((s) => s.cancelLogin);
  const shareAliveEnabled = useSettingsStore((s) => s.shareAliveEnabled);
  const setShareAliveEnabled = useSettingsStore((s) => s.setShareAliveEnabled);
  const startAccountHosting = useRemoteStore((s) => s.startAccountHosting);
  const stopHosting = useRemoteStore((s) => s.stopHosting);

  const handleShareAliveToggle = (checked: boolean) => {
    setShareAliveEnabled(checked);
    if (checked) startAccountHosting(); else stopHosting();
  };

  const handleOpenBrowser = () => {
    if (deviceFlow.verificationUri) {
      safeOpenUrl(deviceFlow.verificationUri);
    }
  };

  const handleCopyCode = () => {
    if (deviceFlow.userCode) writeText(deviceFlow.userCode).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div style={sectionTitleStyle}>GitHub Account</div>

        {isLoading && (
          <div style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)" }}>Checking login status...</div>
        )}

        {!isLoading && !isAuthenticated && !deviceFlow.userCode && (
          <button
            onClick={startLogin}
            className="px-4 py-1.5 rounded cursor-pointer"
            style={{ fontSize: 'var(--fs-11)', background: "var(--bg-overlay)", color: "var(--text-primary)", border: "1px solid var(--border-default)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-blue)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)"; }}
          >
            Sign in with GitHub
          </button>
        )}

        {!isLoading && deviceFlow.userCode && (
          <div className="flex flex-col gap-2 p-3 rounded" style={{ background: "var(--bg-overlay)", border: "1px solid var(--border-default)", maxWidth: 320 }}>
            <div style={{ fontSize: 'var(--fs-10)', color: "var(--text-secondary)" }}>Enter this code on GitHub:</div>
            <div className="flex items-center gap-1">
              <span className="flex-1 px-2 py-1 rounded text-center font-mono" style={{ fontSize: 'var(--fs-13)', fontWeight: 600, background: "var(--bg-base)", color: "var(--text-primary)", border: "1px solid var(--border-default)", letterSpacing: "0.1em" }}>
                {deviceFlow.userCode}
              </span>
              <button onClick={handleCopyCode} title="Copy code" className="px-2 py-1 rounded cursor-pointer" style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", border: "1px solid var(--border-default)" }}>Copy</button>
            </div>
            <div className="flex gap-1">
              <button onClick={handleOpenBrowser} className="flex-1 px-2 py-1 rounded text-center cursor-pointer" style={{ fontSize: 'var(--fs-10)', color: "var(--text-primary)", background: "var(--bg-base)", border: "1px solid var(--border-default)" }}>Open Browser</button>
              <button onClick={cancelLogin} className="px-2 py-1 rounded cursor-pointer" style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", border: "1px solid var(--border-default)" }}>Cancel</button>
            </div>
            {deviceFlow.isPolling && <div style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)" }}>Waiting for code entry...</div>}
          </div>
        )}

        {!isLoading && isAuthenticated && user && (
          <div className="flex flex-col gap-3 p-3 rounded" style={{ background: "var(--bg-overlay)", border: "1px solid var(--border-default)", maxWidth: 320 }}>
            <div className="flex items-center gap-2">
              {user.avatar_url && (
                <img src={user.avatar_url} alt={user.login} className="rounded-full shrink-0" style={{ width: 28, height: 28, border: "1px solid var(--border-default)" }} />
              )}
              <div className="flex flex-col min-w-0">
                <span className="truncate" style={{ fontSize: 'var(--fs-11)', color: "var(--text-primary)", fontWeight: 500 }}>{user.name ?? user.login}</span>
                <span style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)" }}>@{user.login}</span>
              </div>
              <span
                className="ml-auto shrink-0 px-1.5 py-0.5 rounded"
                style={{
                  fontSize: 'var(--fs-9)', fontWeight: 600, letterSpacing: "0.04em",
                  background: user.plan === "pro" ? "color-mix(in srgb, var(--accent-blue) 15%, transparent)" : "var(--bg-base)",
                  color: user.plan === "pro" ? "var(--accent-blue)" : "var(--text-muted)",
                  border: "1px solid", borderColor: user.plan === "pro" ? "var(--accent-blue)" : "var(--border-default)",
                  textTransform: "uppercase",
                }}
              >
                {user.plan === "pro" ? "Pro" : "Starter"}
              </span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)" }}>
              <input type="checkbox" checked={shareAliveEnabled} onChange={(e) => handleShareAliveToggle(e.target.checked)} />
              {t("settings.autoShare")}
            </label>
            <button
              onClick={logout}
              className="w-full px-2 py-1 rounded text-center cursor-pointer"
              style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent-red)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-red)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)"; }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
