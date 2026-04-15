import type { LayoutOption } from "./types";

export const LAYOUT_ICONS: Record<LayoutOption, React.ReactNode> = {
  "1": (
    <svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="22" height="16" rx="1" />
    </svg>
  ),
  "2h": (
    <svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="10" height="16" rx="1" />
      <rect x="13" y="1" width="10" height="16" rx="1" />
    </svg>
  ),
  "2v": (
    <svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="22" height="7" rx="1" />
      <rect x="1" y="10" width="22" height="7" rx="1" />
    </svg>
  ),
  "3": (
    <svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="10" height="16" rx="1" />
      <rect x="13" y="1" width="10" height="7" rx="1" />
      <rect x="13" y="10" width="10" height="7" rx="1" />
    </svg>
  ),
  "4": (
    <svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="10" height="7" rx="1" />
      <rect x="13" y="1" width="10" height="7" rx="1" />
      <rect x="1" y="10" width="10" height="7" rx="1" />
      <rect x="13" y="10" width="10" height="7" rx="1" />
    </svg>
  ),
};
