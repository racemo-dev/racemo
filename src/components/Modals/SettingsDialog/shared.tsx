/* eslint-disable react-refresh/only-export-components -- shared file mixes components, styles, and helpers */
import React from "react";

/* ─── Shared styles ─── */
export const sectionTitleStyle: React.CSSProperties = {
  fontSize: 'var(--fs-10)',
  letterSpacing: "0.06em",
  color: "var(--text-tertiary)",
  marginBottom: 10,
  textTransform: "uppercase",
};

export const inputStyle: React.CSSProperties = {
  fontSize: 'var(--fs-11)',
  background: "var(--bg-overlay)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
};

export const descStyle: React.CSSProperties = {
  fontSize: 'var(--fs-10)',
  color: "var(--text-tertiary)",
  marginTop: 4,
  lineHeight: 1.4,
};

export const cardStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
  padding: "14px 18px",
};

/* ─── Setting row: title+desc left, control right ─── */
export function SettingRow({ title, desc, children }: { title: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div style={cardStyle} className="flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", fontWeight: 500 }}>{title}</div>
        {desc && <div style={{ ...descStyle, marginTop: 6 }}>{desc}</div>}
      </div>
      {children && <div className="shrink-0 flex items-center">{children}</div>}
    </div>
  );
}

/* ─── Font check ─── */
export function isFontAvailable(fontFamily: string): boolean {
  const match = fontFamily.match(/^'([^']+)'/);
  const primaryFont = match ? match[1] : fontFamily.split(",")[0].trim().replace(/'/g, "");
  if (primaryFont === "monospace") return true;
  try { return document.fonts.check(`12px "${primaryFont}"`); } catch { return true; }
}
