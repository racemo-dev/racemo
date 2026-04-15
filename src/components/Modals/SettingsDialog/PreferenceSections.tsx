import { useState } from "react";
import { useSettingsStore } from "../../../stores/settingsStore";
import { usePrivacyStore } from "../../../stores/privacyStore";
import { useAutocompleteStore } from "../../../stores/autocompleteStore";
import { invalidatePatternCache } from "../../../lib/secretDetector";
import { useGitT } from "../../../lib/i18n/git";
import { sectionTitleStyle, inputStyle, cardStyle, SettingRow } from "./shared";

/* ═══════════════════════════════════════════════
   Section: Notifications
   ═══════════════════════════════════════════════ */
export function NotificationsSection() {
  const t = useGitT();
  const notificationEnabled = useSettingsStore((s) => s.notificationEnabled);
  const notificationThreshold = useSettingsStore((s) => s.notificationThreshold);
  const soundEnabled = useSettingsStore((s) => s.soundEnabled);
  const setNotificationEnabled = useSettingsStore((s) => s.setNotificationEnabled);
  const setNotificationThreshold = useSettingsStore((s) => s.setNotificationThreshold);
  const setSoundEnabled = useSettingsStore((s) => s.setSoundEnabled);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div style={sectionTitleStyle}>{t("settings.general")}</div>
        <div className="flex flex-col gap-2">
          <SettingRow title={t("settings.notifyEnabled")} desc={t("settings.notifyEnabledDesc")}>
            <input type="checkbox" checked={notificationEnabled} onChange={(e) => setNotificationEnabled(e.target.checked)} />
          </SettingRow>
          {notificationEnabled && (
            <SettingRow title={t("settings.notifyThreshold")} desc={`${notificationThreshold}s`}>
              <input type="range" min={5} max={300} step={5} value={notificationThreshold} onChange={(e) => setNotificationThreshold(Number(e.target.value))} style={{ width: 140 }} />
            </SettingRow>
          )}
          <SettingRow title={t("settings.soundEnabled")} desc={t("settings.soundEnabledDesc")}>
            <input type="checkbox" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)} />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   Section: Autocomplete
   ═══════════════════════════════════════════════ */
export function AutocompleteSection() {
  const t = useGitT();
  const enabled = useAutocompleteStore((s) => s.enabled);
  const setEnabled = useAutocompleteStore((s) => s.setEnabled);
  const historyCount = useSettingsStore((s) => s.historyCompletionCount);
  const setHistoryCount = useSettingsStore((s) => s.setHistoryCompletionCount);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div style={sectionTitleStyle}>{t("settings.general")}</div>
        <div className="flex flex-col gap-2">
          <SettingRow title={t("auto.smartAutocomplete")} desc={t("auto.smartAutocompleteDesc")}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </SettingRow>
          {enabled && (
            <SettingRow title={t("auto.historySuggestions")} desc={`${historyCount}${t("auto.historySuggestionsDesc")}`}>
              <input type="range" min={1} max={20} value={historyCount} onChange={(e) => setHistoryCount(Number(e.target.value))} style={{ width: 140 }} />
            </SettingRow>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   Section: Privacy
   ═══════════════════════════════════════════════ */
export function PrivacySection() {
  const t = useGitT();
  const enabled = usePrivacyStore((s) => s.enabled);
  const customPatterns = usePrivacyStore((s) => s.customPatterns);
  const setEnabled = usePrivacyStore((s) => s.setEnabled);
  const addPattern = usePrivacyStore((s) => s.addPattern);
  const removePattern = usePrivacyStore((s) => s.removePattern);
  const [newPattern, setNewPattern] = useState("");

  const handleAdd = () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    try { new RegExp(trimmed); } catch { return; }
    addPattern(trimmed);
    invalidatePatternCache();
    setNewPattern("");
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div style={sectionTitleStyle}>{t("privacy.secretMasking")}</div>
        <div className="flex flex-col gap-2">
          <SettingRow title={t("privacy.enableMasking")} desc={t("privacy.enableMaskingDesc")}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </SettingRow>
        </div>
      </div>

      <div>
        <div style={sectionTitleStyle}>{t("privacy.customPatterns")}</div>
        <div style={cardStyle}>
          {customPatterns.length > 0 && (
            <div className="flex flex-col gap-1 mb-3">
              {customPatterns.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-2 py-1 rounded"
                  style={{ fontSize: 'var(--fs-10)', fontFamily: "monospace", color: "var(--text-secondary)", background: "var(--bg-overlay)" }}
                >
                  <span className="truncate flex-1">{p}</span>
                  <button
                    onClick={() => { removePattern(i); invalidatePatternCache(); }}
                    className="shrink-0 ml-2 cursor-pointer"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent-red)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1">
            <input
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              placeholder={t("privacy.addPattern")}
              className="flex-1 bg-transparent outline-none px-2 py-1 rounded"
              style={{ ...inputStyle, fontSize: 'var(--fs-10)', fontFamily: "monospace", caretColor: "var(--text-primary)" }}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
            />
            <button onClick={handleAdd} className="px-2 py-1 rounded text-xs cursor-pointer" style={{ color: "var(--text-secondary)", background: "var(--bg-overlay)" }}>+</button>
          </div>
        </div>
      </div>
    </div>
  );
}
