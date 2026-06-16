import { useToastStore } from "../../stores/toastStore";

const COLORS = {
  info: { bg: "rgba(38, 50, 64, 0.95)", border: "#3b82f6", fg: "#e7eef9" },
  success: { bg: "rgba(28, 52, 38, 0.95)", border: "#22c55e", fg: "#e6f6ec" },
  error: { bg: "rgba(58, 30, 30, 0.95)", border: "#ef4444", fg: "#fde2e2" },
};

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => {
        const c = COLORS[t.type];
        return (
          <div
            key={t.id}
            role="status"
            onClick={() => dismiss(t.id)}
            style={{
              pointerEvents: "auto",
              cursor: "pointer",
              background: c.bg,
              color: c.fg,
              borderLeft: `3px solid ${c.border}`,
              padding: "8px 12px",
              borderRadius: 4,
              fontSize: 13,
              lineHeight: 1.4,
              maxWidth: 360,
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
            }}
          >
            {t.message}
          </div>
        );
      })}
    </div>
  );
}
