/* eslint-disable react-refresh/only-export-components -- exports both icon components and helpers */
import { isMac, isWindows } from "../../lib/osUtils";
import type { ShellType } from "../../types/session";
import applePng from "../../assets/apple.png";
import windowsPng from "../../assets/windows.png";
import linuxPng from "../../assets/linux.png";

export const iconSize = { width: 'calc(16px * var(--ui-scale))', height: 'calc(16px * var(--ui-scale))' };

function MaskIcon({ src, style }: { src: string; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        ...iconSize,
        display: "inline-block",
        backgroundColor: "currentColor",
        WebkitMaskImage: `url(${src})`,
        WebkitMaskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskImage: `url(${src})`,
        maskSize: "contain",
        maskRepeat: "no-repeat",
        maskPosition: "center",
        ...style,
      }}
    />
  );
}

/** Apple logo */
export function AppleIcon() {
  return <MaskIcon src={applePng} style={{ paddingBottom: '1px' }} />;
}

/** Windows logo */
export function WindowsIcon() {
  return <MaskIcon src={windowsPng} />;
}

/** Linux Tux penguin */
export function LinuxIcon() {
  return <MaskIcon src={linuxPng} />;
}

/** Share icon */
export function ShareIcon({ isActive, isConnecting }: { isActive: boolean; isConnecting: boolean }) {
  const color = isActive ? "var(--status-active)" : "var(--accent-purple)";
  const animation = isConnecting ? "pulse 1.5s ease-in-out infinite" : (isActive ? "float 3s ease-in-out infinite" : "none");

  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      stroke={color}
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        width: 'calc(12px * var(--ui-scale))',
        height: 'calc(12px * var(--ui-scale))',
        animation: animation,
        borderRadius: "2px",
        transition: "stroke 0.3s ease",
        overflow: 'visible'
      }}
    >
      <g style={{
        animation: isActive && !isConnecting ? 'rotate-slow 8s linear infinite' : 'none',
        transformOrigin: '5px 5px'
      }}>
        <circle cx="5" cy="5" r="1.2" fill={isActive ? color : "none"} stroke="none" />
        <circle cx="5" cy="1.5" r="0.8" />
        <circle cx="8.5" cy="7.5" r="0.8" />
        <circle cx="1.5" cy="7.5" r="0.8" />
        <line x1="5" y1="2.3" x2="5" y2="4" />
        <line x1="7.7" y1="7" x2="5.8" y2="5.7" />
        <line x1="2.3" y1="7" x2="4.2" y2="5.7" />
      </g>
    </svg>
  );
}

/** Connect icon — clean chain-link (two interlocked link rings) */
export function ConnectIcon({ isActive, isConnecting }: { isActive: boolean; isConnecting: boolean }) {
  const color = isActive ? "var(--status-active)" : "var(--accent-blue)";
  const animation = isConnecting ? "pulse 1.5s ease-in-out infinite" : "none";

  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke={color}
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        width: 'calc(12px * var(--ui-scale))',
        height: 'calc(12px * var(--ui-scale))',
        animation,
        transition: "stroke 0.3s ease",
      }}
    >
      {/* Left link ring */}
      <path d="M5.4 3.6 L4 2.2 a2 2 0 1 0 -2.8 2.8 L2.6 6.4" />
      {/* Right link ring */}
      <path d="M6.6 8.4 L8 9.8 a2 2 0 1 0 2.8 -2.8 L9.4 5.6" />
      {/* Connecting bar between the two rings */}
      <line x1="4.6" y1="7.4" x2="7.4" y2="4.6" />
    </svg>
  );
}

/** Small globe badge overlay for remote sessions */
function RemoteBadge() {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      style={{
        position: "absolute",
        bottom: "-2px",
        right: "-3px",
        width: "calc(8px * var(--ui-scale))",
        height: "calc(8px * var(--ui-scale))",
        filter: "drop-shadow(0 0 1px var(--bg-base))",
      }}
    >
      <circle cx="5" cy="5" r="4.5" fill="var(--bg-base)" />
      <circle cx="5" cy="5" r="3.5" stroke="var(--status-active)" strokeWidth="0.9" fill="var(--status-active)" fillOpacity="0.15" />
      <ellipse cx="5" cy="5" rx="1.5" ry="3.5" stroke="var(--status-active)" strokeWidth="0.6" />
      <line x1="1.5" y1="5" x2="8.5" y2="5" stroke="var(--status-active)" strokeWidth="0.5" />
    </svg>
  );
}

function getOSIcon(shell?: ShellType, isRemote?: boolean, remoteOs?: string) {
  if (isRemote) {
    // Prefer the host OS string reported by the remote peer when available.
    // Empty / "unknown" means a pre-0.0.4 host that did not report the field,
    // so fall through to the shell-based heuristic.
    const os = remoteOs && remoteOs !== "unknown" ? remoteOs : "";
    if (os === "macos") return <AppleIcon />;
    if (os === "windows") return <WindowsIcon />;
    if (os === "linux") return <LinuxIcon />;
    // Shell-based fallback for pre-0.0.4 hosts.
    if (shell === "PowerShell" || shell === "Cmd") return <WindowsIcon />;
    return <LinuxIcon />;
  }

  if (isMac()) return <AppleIcon />;
  if (isWindows()) return <WindowsIcon />;
  return <LinuxIcon />;
}

export function ShellIcon({ shell, isRemote, remoteOs }: { shell?: ShellType; isRemote?: boolean; remoteOs?: string }) {
  const icon = getOSIcon(shell, isRemote, remoteOs);

  if (!isRemote) return icon;

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}>
      {icon}
      <RemoteBadge />
    </span>
  );
}
