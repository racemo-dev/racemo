import { useEffect } from "react";
import { useSettingsDialogStore, type SettingsCategory } from "../../../stores/settingsDialogStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { isMac } from "../../../lib/osUtils";
import { X } from "@phosphor-icons/react";
import { useGitT } from "../../../lib/i18n/git";
import { BrowserHideGuard } from "../../Editor/BrowserViewer";

import { AppearanceSection } from "./AppearanceSection";
import { TerminalSection } from "./TerminalSection";
import { NotificationsSection, AutocompleteSection, PrivacySection } from "./PreferenceSections";
import { DebugSection, HelpSection, AccountSection } from "./DevSections";

/* ─── Window controls for standalone (no native titlebar) ─── */
function WindowControls({ onClose }: { onClose: () => void }) {
  const handleAction = (action: "minimize" | "maximize" | "close") => {
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      if (action === "minimize") win.minimize().catch(console.error);
      else if (action === "maximize") win.toggleMaximize().catch(console.error);
      else onClose();
    });
  };

  if (isMac()) return null;

  return (
    <div className="flex items-center h-full ml-auto" style={{ borderLeft: "1px solid var(--border-subtle)" }}>
      <button type="button" className="window-control" onClick={() => handleAction("minimize")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="currentColor" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <rect y="5" width="10" height="1" />
        </svg>
      </button>
      <button type="button" className="window-control" onClick={() => handleAction("maximize")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <rect x="1" y="1" width="8" height="8" />
        </svg>
      </button>
      <button type="button" className="window-control close" onClick={() => handleAction("close")} onMouseDown={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <line x1="1" y1="1" x2="9" y2="9" />
          <line x1="9" y1="1" x2="1" y2="9" />
        </svg>
      </button>
    </div>
  );
}

/* ─── Nav categories ─── */
interface NavItem {
  id: SettingsCategory;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "notifications", label: "Notifications" },
  { id: "autocomplete", label: "Autocomplete" },
  { id: "privacy", label: "Privacy" },
  ...(!import.meta.env.PROD ? [{ id: "debug" as const, label: "Debug" }] : []),
  { id: "help", label: "Help" },
];

const NAV_BOTTOM: NavItem[] = [
  { id: "account", label: "Account" },
];

/* ─── Nav button ─── */
function NavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left px-3 py-1.5 rounded cursor-pointer transition-colors"
      style={{
        fontSize: 'var(--fs-11)',
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        background: active ? "var(--bg-overlay)" : "transparent",
        borderLeft: active ? "2px solid var(--accent-blue)" : "2px solid transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)";
      }}
    >
      {item.label}
    </button>
  );
}

/* ═══════════════════════════════════════════════
   Main Dialog
   ═══════════════════════════════════════════════ */
export default function SettingsDialog({ standalone = false }: { standalone?: boolean }) {
  const { isOpen, activeCategory, close, setCategory } = useSettingsDialogStore();
  const t = useGitT();

  // Localized nav labels
  const navLabelMap: Record<string, string> = {
    appearance: t("settings.appearance"),
    terminal: t("settings.terminal"),
    notifications: t("settings.notifications"),
    autocomplete: t("settings.autocomplete"),
    privacy: t("settings.privacy"),
    debug: t("settings.debug"),
    help: t("settings.help"),
    account: t("settings.account"),
  };

  const handleClose = () => {
    if (standalone) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().close();
      });
    } else {
      close();
    }
  };

  useEffect(() => {
    if (!standalone && !isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); handleClose(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleClose is stable per render and reads latest closure
  }, [standalone, isOpen]);

  // 외부 설정창에서 패널 모드로 전환하면 이 창을 닫는다
  const editorModeForClose = useSettingsStore((s) => s.editorMode);
  useEffect(() => {
    if (standalone && editorModeForClose === "internal") {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().close();
      });
    }
  }, [standalone, editorModeForClose]);

  if (!standalone && !isOpen) return null;

  const categoryLabel = navLabelMap[activeCategory] ?? activeCategory;

  const content = (
    <div
      className="flex w-full h-full"
      style={{ background: "var(--bg-elevated)" }}
    >
      {/* Left nav */}
      <div
        className="flex flex-col shrink-0 py-3"
        style={{
          width: 160,
          background: "var(--bg-surface)",
          borderRight: "1px solid var(--border-default)",
        }}
      >
        {/* macOS traffic light spacing (standalone only) */}
        {standalone && isMac() && <div className="shrink-0" style={{ height: 28 }} />}
        <div className="flex-1 flex flex-col gap-0.5 px-2">
          {NAV_ITEMS.map((item) => (
            <NavButton key={item.id} item={{ ...item, label: navLabelMap[item.id] ?? item.label }} active={activeCategory === item.id} onClick={() => setCategory(item.id)} />
          ))}
        </div>
        <div className="flex flex-col gap-0.5 px-2 mt-auto pt-3" style={{ borderTop: "1px solid var(--border-subtle)" }}>
          {NAV_BOTTOM.map((item) => (
            <NavButton key={item.id} item={{ ...item, label: navLabelMap[item.id] ?? item.label }} active={activeCategory === item.id} onClick={() => setCategory(item.id)} />
          ))}
        </div>
      </div>

      {/* Right content */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <div
          className="flex items-center shrink-0 pl-5"
          style={{
            height: 'calc(36px * var(--ui-scale))',
            borderBottom: "1px solid var(--border-default)",
          }}
          data-tauri-drag-region
        >
          <span style={{ fontSize: 'var(--fs-12)', color: "var(--text-tertiary)" }}>
            {t("settings.title")} — {categoryLabel}
          </span>
          {standalone ? (
            <WindowControls onClose={handleClose} />
          ) : (
            <button
              onClick={handleClose}
              className="ml-auto cursor-pointer p-1 rounded transition-opacity opacity-40 hover:opacity-100"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={14} style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-8 py-5" style={{ maxWidth: 800 }}>
          {activeCategory === "appearance" && <AppearanceSection />}
          {activeCategory === "terminal" && <TerminalSection />}
          {activeCategory === "notifications" && <NotificationsSection />}
          {activeCategory === "autocomplete" && <AutocompleteSection />}
          {activeCategory === "privacy" && <PrivacySection />}
          {activeCategory === "debug" && !import.meta.env.PROD && <DebugSection />}
          {activeCategory === "help" && <HelpSection />}
          {activeCategory === "account" && <AccountSection />}
        </div>
        </div>
    </div>
  );

  // Standalone: fill the whole window, no overlay
  if (standalone) {
    return <><BrowserHideGuard /><div className="fixed inset-0">{content}</div></>;
  }

  // In-app: centered modal overlay with backdrop
  return (
    <>
    <BrowserHideGuard />
    <div
           className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="flex overflow-hidden"
        style={{
          width: 900,
          height: 680,
          borderRadius: 8,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          border: "1px solid var(--border-default)",
        }}
      >
        {content}
      </div>
    </div>
    </>
  );
}
