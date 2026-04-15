import { useRestoreStore } from "../../stores/restoreStore";
import { useGitT } from "../../lib/i18n/git";
import { BrowserHideGuard } from "../Editor/BrowserViewer";

export default function RestoreCommandDialog() {
  const t = useGitT();
  const { items, isOpen, toggle, execute, dismiss } = useRestoreStore();

  if (!isOpen || items.length === 0) return null;

  const checkedCount = items.filter((i) => i.checked).length;

  return (
    <>
    <BrowserHideGuard />
    <div

      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
    >
      <div
        className="rounded-lg flex flex-col"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          width: 420,
          maxWidth: "90vw",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header */}
        <div
          className="px-4 py-3"
          style={{
            borderBottom: "1px solid var(--border-subtle)",
            fontSize: "var(--fs-13)",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {t("restore.title")}
        </div>

        {/* Body */}
        <div className="px-4 py-3 flex flex-col gap-2">
          <p style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", marginBottom: 4 }}>
            {t("restore.desc")}
          </p>
          {items.map((item) => (
            <label
              key={item.ptyId}
              className="flex items-center gap-3 px-3 py-2 rounded cursor-pointer"
              style={{
                background: item.checked ? "color-mix(in srgb, var(--accent-cyan) 8%, transparent)" : "var(--bg-overlay)",
                border: `1px solid ${item.checked ? "color-mix(in srgb, var(--accent-cyan) 30%, transparent)" : "var(--border-subtle)"}`,
                transition: "all 0.1s",
              }}
            >
              <input
                type="checkbox"
                checked={item.checked}
                onChange={() => toggle(item.ptyId)}
                style={{ accentColor: "var(--accent-cyan)", width: 14, height: 14, cursor: "pointer" }}
              />
              <span
                className="truncate flex-1"
                style={{ fontFamily: "monospace", fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}
              >
                {item.command}
              </span>
            </label>
          ))}
        </div>

        {/* Footer */}
        <div
          className="px-4 py-3 flex items-center justify-end gap-2"
          style={{ borderTop: "1px solid var(--border-subtle)" }}
        >
          <button
            onClick={dismiss}
            className="px-3 py-1.5 rounded"
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-muted)",
              fontSize: "var(--fs-12)",
              cursor: "pointer",
            }}
          >
            {t("restore.cancel")}
          </button>
          <button
            onClick={execute}
            disabled={checkedCount === 0}
            className="px-3 py-1.5 rounded"
            style={{
              background: checkedCount === 0 ? "var(--bg-overlay)" : "var(--accent-cyan)",
              border: "none",
              color: checkedCount === 0 ? "var(--text-muted)" : "var(--bg-base)",
              fontSize: "var(--fs-12)",
              fontWeight: 600,
              cursor: checkedCount === 0 ? "not-allowed" : "pointer",
            }}
          >
            {t("restore.run")} {checkedCount > 0 ? `(${checkedCount})` : ""}
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
