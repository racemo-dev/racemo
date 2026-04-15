import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, AI_TEMPLATES } from "../../../stores/settingsStore";
import { applySettingsToAll } from "../../../lib/terminalRegistry";
import { applySettingsToAllRemote } from "../../../lib/remoteTerminalRegistry";
import { isWindows } from "../../../lib/osUtils";
import { useGitT } from "../../../lib/i18n/git";
import { logger } from "../../../lib/logger";
import type { ShellType } from "../../../types/session";
import { sectionTitleStyle, inputStyle, descStyle, cardStyle, SettingRow } from "./shared";

export function TerminalSection() {
  const t = useGitT();
  const aiTemplate = useSettingsStore((s) => s.aiTemplate);
  const setAiTemplate = useSettingsStore((s) => s.setAiTemplate);
  const scrollback = useSettingsStore((s) => s.scrollback);
  const setScrollback = useSettingsStore((s) => s.setScrollback);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const setDefaultShell = useSettingsStore((s) => s.setDefaultShell);
  const editorMode = useSettingsStore((s) => s.editorMode);
  const setEditorMode = useSettingsStore((s) => s.setEditorMode);
  const diffMode = useSettingsStore((s) => s.diffMode);
  const setDiffMode = useSettingsStore((s) => s.setDiffMode);
  const singleClickOpen = useSettingsStore((s) => s.singleClickOpen);
  const setSingleClickOpen = useSettingsStore((s) => s.setSingleClickOpen);

  const handleScrollbackChange = (lines: number) => {
    setScrollback(lines);
    applySettingsToAll({ scrollback: lines });
    applySettingsToAllRemote({ scrollback: lines });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* General */}
      <div>
        <div style={sectionTitleStyle}>{t("settings.general")}</div>
        <div className="flex flex-col gap-2">
          <SettingRow title={t("settings.diffMode")} desc={t("settings.diffModeDesc")}>
            <select
              value={diffMode}
              onChange={(e) => setDiffMode(e.target.value as "panel" | "window")}
              className="rounded px-2 py-1 outline-none"
              style={{ ...inputStyle, minWidth: 120 }}
            >
              <option value="panel">{t("settings.diffPanel")}</option>
              <option value="window">{t("settings.diffWindow")}</option>
            </select>
          </SettingRow>
          <SettingRow title={t("settings.editorMode")} desc={t("settings.editorModeDesc")}>
            <select
              value={editorMode}
              onChange={(e) => setEditorMode(e.target.value as "external" | "internal")}
              className="rounded px-2 py-1 outline-none"
              style={{ ...inputStyle, minWidth: 120 }}
            >
              <option value="external">{t("settings.editorExternal")}</option>
              <option value="internal">{t("settings.editorInternal")}</option>
            </select>
          </SettingRow>
          {isWindows() && (
            <SettingRow title={t("settings.defaultShell")} desc={t("settings.defaultShellDesc")}>
              <select
                value={defaultShell}
                onChange={(e) => setDefaultShell(e.target.value as ShellType)}
                className="rounded px-2 py-1 outline-none"
                style={{ ...inputStyle, minWidth: 160 }}
              >
                <option value="PowerShell">PowerShell</option>
                <option value="Cmd">CMD</option>
                <option value="Wsl">WSL (Linux)</option>
              </select>
            </SettingRow>
          )}
          <SettingRow title={t("settings.scrollback")} desc={t("settings.scrollbackDesc")}>
            <input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={scrollback}
              onChange={(e) => handleScrollbackChange(Number(e.target.value))}
              className="rounded px-2 py-1 outline-none"
              style={{ ...inputStyle, width: 100, textAlign: "right" }}
            />
          </SettingRow>
          <SettingRow title={t("settings.singleClick")} desc={t("settings.singleClickDesc")}>
            <input type="checkbox" checked={singleClickOpen} onChange={(e) => setSingleClickOpen(e.target.checked)} />
          </SettingRow>
        </div>
      </div>

      {/* AI */}
      <div>
        <div style={sectionTitleStyle}>{t("settings.aiTemplate")}</div>
        <div style={cardStyle}>
          <div style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", fontWeight: 500, marginBottom: 6 }}>{t("settings.aiTemplate")}</div>
          <select
            value={aiTemplate}
            onChange={(e) => setAiTemplate(e.target.value)}
            className="w-full rounded px-2 py-1 outline-none"
            style={{ ...inputStyle, fontFamily: "monospace" }}
          >
            {AI_TEMPLATES.map((tpl) => (
              <option key={tpl.value} value={tpl.value}>{tpl.label} — {tpl.value}</option>
            ))}
          </select>
          <div style={{ ...descStyle, marginTop: 8 }}>
            Requires an AI CLI tool installed in your PATH.
          </div>
          <button
            onClick={async () => {
              try {
                const dir = await invoke<string>("get_prompts_dir");
                await invoke("open_in_default_app", { path: dir });
              } catch (e) {
                logger.error("Failed to open prompts dir:", e);
              }
            }}
            className="w-full rounded px-2 py-1.5 mt-2"
            style={{
              fontSize: 'var(--fs-12)',
              background: "var(--bg-overlay)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-subtle)",
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-overlay)"; }}
          >
            {t("settings.editPrompts")}
            <span style={{ ...descStyle, display: "block", marginTop: 2 }}>
              ~/.racemo/prompts/ (review, commit, pr, auto-commit)
            </span>
          </button>
        </div>
      </div>

    </div>
  );
}
