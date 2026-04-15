/* ─── Tab Button ─── */

export function TabButton({ isActive, onClick, title, children }: { isActive: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center cursor-pointer"
      style={{
        width: 24, height: 24, padding: 0,
        color: isActive ? "var(--text-secondary)" : "var(--text-muted)",
        background: isActive ? "var(--bg-overlay)" : "transparent",
        border: "none", borderRadius: 4,
        transition: "color 120ms, background 120ms",
      }}
      onMouseEnter={(e) => { if (!isActive) { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)"; } }}
      onMouseLeave={(e) => { if (!isActive) { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; (e.currentTarget as HTMLElement).style.background = "transparent"; } }}
      title={title}
    >
      {children}
    </button>
  );
}
