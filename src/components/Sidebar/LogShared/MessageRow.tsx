/* eslint-disable react-refresh/only-export-components -- exports both row components and helpers */
/**
 * Message row components for AI log panels.
 */
import { useState } from "react";
import {
  CaretDown,
  Robot,
  Terminal,
  User,
  Wrench,
} from "@phosphor-icons/react";
import { ICON_STYLE } from "../logUtils";

/* ─── Message row base (shared role config rendering) ─── */

export interface RoleConfig {
  icon: React.ReactNode;
  color: string;
  label: string;
  bg?: string;
  borderColor?: string;
}

export const BASE_ROLE_CONFIGS: Record<string, RoleConfig> = {
  user: {
    icon: <User size={11} style={ICON_STYLE(11)} color="var(--accent-blue)" />,
    color: "var(--accent-blue)",
    label: "USER",
    bg: "hsla(210, 60%, 50%, 0.08)",
    borderColor: "var(--accent-blue)",
  },
  assistant: {
    icon: <Robot size={11} style={ICON_STYLE(11)} color="var(--accent-green, #5daa68)" />,
    color: "var(--accent-green, #5daa68)",
    label: "ASSISTANT",
    borderColor: "transparent",
  },
  tool_call: {
    icon: <Wrench size={11} style={ICON_STYLE(11)} color="var(--accent-yellow)" />,
    color: "var(--accent-yellow)",
    label: "TOOL",
    bg: "hsla(45, 80%, 50%, 0.06)",
    borderColor: "var(--accent-yellow)",
  },
  tool_result: {
    icon: <Terminal size={11} style={ICON_STYLE(11)} color="var(--accent-cyan)" />,
    color: "var(--accent-cyan)",
    label: "RESULT",
    bg: "hsla(180, 60%, 40%, 0.06)",
    borderColor: "var(--accent-cyan)",
  },
};

export function MessageRowShell({
  role,
  extraRoles,
  isCollapsible,
  headerExtra,
  children,
}: {
  role: string;
  extraRoles?: Record<string, RoleConfig>;
  isCollapsible?: boolean;
  headerExtra?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const allRoles = extraRoles ? { ...BASE_ROLE_CONFIGS, ...extraRoles } : BASE_ROLE_CONFIGS;
  const config = allRoles[role] ?? BASE_ROLE_CONFIGS.assistant;
  const collapsible = isCollapsible ?? false;
  const showContent = !collapsible || expanded;

  return (
    <div style={{
      padding: "5px 10px",
      borderBottom: "1px solid var(--border-subtle)",
      background: config.bg,
      borderLeft: `2px solid ${config.borderColor ?? "transparent"}`,
    }}>
      <div
        className="flex items-center gap-1"
        style={{ marginBottom: 2, cursor: collapsible ? "pointer" : undefined }}
        onClick={collapsible ? () => setExpanded((p) => !p) : undefined}
      >
        {config.icon}
        <span
          style={{
            fontSize: "var(--fs-9)",
            fontWeight: 600,
            color: config.color,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {config.label}
        </span>
        {headerExtra}
        {collapsible && (
          <CaretDown
            size={9}
            weight="bold"
            style={{
              marginLeft: "auto",
              color: "var(--text-muted)",
              transition: "transform 150ms ease",
              transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            }}
          />
        )}
      </div>
      {showContent && children}
    </div>
  );
}
