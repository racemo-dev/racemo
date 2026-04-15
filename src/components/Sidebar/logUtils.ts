import type { TranslationKey } from "../../lib/i18n/git";

export function relativeTime(epochMs: number, t: (key: TranslationKey) => string): string {
  const diff = Date.now() - epochMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t("claudeLog.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("claudeLog.minutesAgo").replace("{count}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("claudeLog.hoursAgo").replace("{count}", String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return t("claudeLog.daysAgo").replace("{count}", String(days));
  return new Date(epochMs).toLocaleDateString();
}

export function truncateDisplay(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

export function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export const LABEL_HUES = [210, 160, 30, 280, 340, 120, 50, 190, 310, 80];

export function hashLabelHue(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = ((h << 5) - h + label.charCodeAt(i)) | 0;
  return LABEL_HUES[Math.abs(h) % LABEL_HUES.length];
}

export const ICON_STYLE = (size: number) => ({
  width: `calc(${size}px * var(--ui-scale))`,
  height: `calc(${size}px * var(--ui-scale))`,
  flexShrink: 0 as const,
});
