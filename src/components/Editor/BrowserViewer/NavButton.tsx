function NavButton({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      className="flex items-center justify-center shrink-0 rounded cursor-pointer"
      style={{ width: "calc(22px * var(--ui-scale))", height: "calc(22px * var(--ui-scale))", color: disabled ? "var(--text-disabled)" : "var(--text-muted)", background: "transparent", border: "none", opacity: disabled ? 0.4 : 1 }}
      title={title}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = "var(--text-primary)"; }}
      onMouseLeave={(e) => { if (!disabled) e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      {children}
    </button>
  );
}

export default NavButton;
