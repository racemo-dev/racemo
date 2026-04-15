import { useSidebarStore, type SidebarPanel } from "../../stores/sidebarStore";
import { useGitStore } from "../../stores/gitStore";
import { useAuthStore } from "../../stores/authStore";
import { useGitT } from "../../lib/i18n/git";
import { openSettingsWindow } from "../../lib/settingsWindow";
import { getModLabel } from "../../lib/osUtils";
import UserMenu from "../Auth/UserMenu";
import LoginButton from "../Auth/LoginButton";

import {
  Files,
  MagnifyingGlass,
  GitBranch,
  Gear,
  Robot,
  Tray,
} from "@phosphor-icons/react";

interface IconDef {
  id: SidebarPanel | "settings-window";
  title: string;
  shortcut?: string;
  icon: React.ReactNode;
}

function buildIcons(mod: string): { top: IconDef[]; bottom: IconDef[] } {
  return {
    top: [
      {
        id: "explorer",
        title: "Explorer",
        shortcut: `${mod}+Shift+E`,
        icon: <Files size={22} weight="regular" style={{ width: 'calc(22px * var(--ui-scale))', height: 'calc(22px * var(--ui-scale))' }} />,
      },
      {
        id: "search",
        title: "Search",
        shortcut: `${mod}+Shift+F`,
        icon: <MagnifyingGlass size={22} weight="regular" style={{ width: 'calc(22px * var(--ui-scale))', height: 'calc(22px * var(--ui-scale))' }} />,
      },
      {
        id: "git",
        title: "Source Control",
        shortcut: `${mod}+Shift+G`,
        icon: <GitBranch size={22} weight="regular" style={{ width: 'calc(22px * var(--ui-scale))', height: 'calc(22px * var(--ui-scale))' }} />,
      },
      {
        id: "aihistory",
        title: "AI History",
        shortcut: `${mod}+Shift+H`,
        icon: <Tray size={22} weight="regular" style={{ width: 'calc(22px * var(--ui-scale))', height: 'calc(22px * var(--ui-scale))' }} />,
      },
      {
        id: "ailog",
        title: "AI Logs",
        shortcut: `${mod}+Shift+L`,
        icon: <Robot size={22} weight="regular" style={{ width: 'calc(22px * var(--ui-scale))', height: 'calc(22px * var(--ui-scale))' }} />,
      },
    ],
    bottom: [
      {
        id: "settings-window",
        title: "Settings",
        shortcut: `${mod}+,`,
        icon: <Gear size={22} weight="regular" style={{ width: 'calc(22px * var(--ui-scale))', height: 'calc(22px * var(--ui-scale))' }} />,
      },
    ],
  };
}


export default function IconStrip() {
  const activePanel = useSidebarStore((s) => s.activePanel);
  const togglePanel = useSidebarStore((s) => s.togglePanel);
  const fileStatuses = useGitStore((s) => s.fileStatuses);
  const { user, isAuthenticated } = useAuthStore();
  const t = useGitT();
  // 런타임에 플랫폼 감지 — 모듈 평가 시점 의존성 제거 (테스트/jsdom 호환)
  const { top: topIcons, bottom: bottomIcons } = buildIcons(getModLabel());
  const titleMap: Record<string, string> = {
    explorer: t("sidebar.explorer"),
    git: t("sidebar.gitControl"),
    aihistory: t("aiHistory.title"),
    ailog: t("sidebar.aiLog"),
    docs: t("sidebar.docs"),
  };

  const gitChangeCount = fileStatuses
    ? fileStatuses.staged.length + fileStatuses.unstaged.length + fileStatuses.untracked.length
    : 0;

  const handleIconClick = (icon: IconDef) => {
    if (icon.id === "settings-window") {
      openSettingsWindow("appearance");
    } else {
      togglePanel(icon.id as SidebarPanel);
    }
  };

  const renderIcon = (icon: IconDef) => {
    const isActive = icon.id === "settings-window" ? false : activePanel === icon.id;
    const badge = icon.id === "git" && gitChangeCount > 0 ? gitChangeCount : 0;
    return (
      <button
        key={icon.id}
        onClick={() => handleIconClick(icon)}
        className="relative flex items-center justify-center rounded transition-colors cursor-pointer"
        style={{
          width: 'calc(28px * var(--ui-scale))',
          height: 'calc(28px * var(--ui-scale))',
          color: isActive ? "var(--text-secondary)" : "var(--text-muted)",
          background: "transparent",
        }}
        onMouseEnter={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
        }}
        onMouseLeave={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
        }}
        title={`${titleMap[icon.id] ?? icon.title}${icon.shortcut ? ` (${icon.shortcut})` : ""}`}
      >
        {isActive && (
          <span
            className="absolute pointer-events-none"
            style={{
              left: 'calc(-5px * var(--ui-scale))',
              top: '10%',
              bottom: '10%',
              width: 'calc(2px * var(--ui-scale))',
              borderRadius: 1,
              background: "var(--text-secondary)",
            }}
          />
        )}
        <div style={{ pointerEvents: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {icon.icon}
        </div>
        {badge > 0 && (
          <span
            className="absolute rounded-full pointer-events-none"
            style={{
              bottom: 'calc(1px * var(--ui-scale))',
              right: 'calc(1px * var(--ui-scale))',
              width: 'calc(6px * var(--ui-scale))',
              height: 'calc(6px * var(--ui-scale))',
              background: "var(--accent-blue)",
            }}
          />
        )}
      </button>
    );
  };


  return (
    <div
      className="flex flex-col items-center shrink-0 no-drag h-full"
      style={{
        width: 'calc(38px * var(--ui-scale))',
        background: "var(--bg-overlay)",
        overflow: "visible",
      }}
    >
      <div className="flex-1 w-full flex flex-col items-center py-2 overflow-y-auto hide-scrollbar" style={{ gap: 4 }}>
        {topIcons.map(renderIcon)}
      </div>
      <div className="mt-auto w-full flex flex-col items-center py-2 shrink-0 overflow-visible" style={{ gap: 4 }}>
        {bottomIcons.map(renderIcon)}

        {/* Auth: Login button or User avatar */}
        {isAuthenticated && user ? <UserMenu /> : <LoginButton />}
      </div>
    </div>
  );
}
