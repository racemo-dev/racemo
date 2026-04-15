import { useEffect, useMemo, useState } from "react";
import { useThemeStore, applyCssTheme } from "../../../stores/themeStore";
import { useSettingsStore, FONT_FAMILIES, LANGUAGES, type Language } from "../../../stores/settingsStore";
import { applyThemeToAll, applyFontSizeToAll, applySettingsToAll } from "../../../lib/terminalRegistry";
import { applyThemeToAllRemote, applyFontSizeToAllRemote, applySettingsToAllRemote } from "../../../lib/remoteTerminalRegistry";
import { useGitT } from "../../../lib/i18n/git";
import { sectionTitleStyle, inputStyle, cardStyle, SettingRow, isFontAvailable } from "./shared";

export function AppearanceSection() {
  const t = useGitT();
  const themeName = useThemeStore((s) => s.themeName);
  const setTheme = useThemeStore((s) => s.setTheme);
  const getTheme = useThemeStore((s) => s.getTheme);
  const getThemes = useThemeStore((s) => s.getThemes);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);

  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const themes = getThemes();

  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => { document.fonts.ready.then(() => setFontsReady(true)); }, []);
  const availableFonts = useMemo(() => {
    if (!fontsReady) return FONT_FAMILIES;
    return FONT_FAMILIES.filter((f) => isFontAvailable(f.value));
  }, [fontsReady]);

  const handleThemeChange = (name: string) => {
    setTheme(name);
    const theme = getTheme();
    applyCssTheme(theme);
    applyThemeToAll();
    applyThemeToAllRemote();
  };

  const handleFontFamilyChange = (family: string) => {
    setFontFamily(family);
    applySettingsToAll({ fontFamily: family });
    applySettingsToAllRemote({ fontFamily: family });
  };

  const handleFontSizeChange = (size: number) => {
    setFontSize(size);
    applyFontSizeToAll();
    applyFontSizeToAllRemote();
  };


  return (
    <div className="flex flex-col gap-5">
      {/* Theme */}
      <div>
        <div style={sectionTitleStyle}>{t("settings.theme")}</div>
        <div style={cardStyle}>
          <div className="grid grid-cols-3 gap-1.5">
            {themes.map((th) => (
              <button
                key={th.name}
                onClick={() => handleThemeChange(th.name)}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded text-left transition-colors cursor-pointer"
                style={{
                  background: th.name === themeName ? "var(--bg-overlay)" : "transparent",
                  color: th.name === themeName ? "var(--text-primary)" : "var(--text-secondary)",
                  border: th.name === themeName ? "1px solid var(--border-default)" : "1px solid transparent",
                }}
                onMouseEnter={(e) => {
                  if (th.name !== themeName) (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)";
                }}
                onMouseLeave={(e) => {
                  if (th.name !== themeName) (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <span
                  className="inline-block rounded-full shrink-0"
                  style={{ width: 10, height: 10, background: th.terminal.background, border: "1px solid var(--border-default)" }}
                />
                <span style={{ fontSize: 'var(--fs-11)' }}>{th.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Language */}
      <div>
        <div style={sectionTitleStyle}>{t("settings.language")}</div>
        <div className="flex flex-col gap-2">
          <SettingRow title={t("settings.language")} desc={t("settings.languageDesc")}>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              className="rounded px-2 py-1 outline-none"
              style={{ ...inputStyle, minWidth: 160 }}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </SettingRow>
        </div>
      </div>

      {/* Font */}
      <div>
        <div style={sectionTitleStyle}>{t("settings.font")}</div>
        <div className="flex flex-col gap-2">
          <SettingRow title={t("settings.fontFamily")} desc={t("settings.fontFamilyDesc")}>
            <select
              value={fontFamily}
              onChange={(e) => handleFontFamilyChange(e.target.value)}
              className="rounded px-2 py-1 outline-none"
              style={{ ...inputStyle, minWidth: 180 }}
            >
              {availableFonts.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("settings.fontSize")} desc={`${fontSize}px`}>
            <input
              type="range"
              min={8}
              max={28}
              value={fontSize}
              onChange={(e) => handleFontSizeChange(Number(e.target.value))}
              style={{ width: 140 }}
            />
          </SettingRow>
        </div>
      </div>

    </div>
  );
}
