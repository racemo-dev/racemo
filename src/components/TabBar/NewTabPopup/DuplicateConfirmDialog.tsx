import { useGitT } from "../../../lib/i18n/git";

interface DuplicateConfirmDialogProps {
  popupRef: React.RefObject<HTMLDivElement | null>;
  baseName: string;
  uniqueName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function DuplicateConfirmDialog({
  popupRef,
  baseName,
  uniqueName,
  onCancel,
  onConfirm,
}: DuplicateConfirmDialogProps) {
  const t = useGitT();

  return (
    <div
      ref={popupRef}
      className="fixed rounded-lg shadow-xl"
      style={{
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 9999,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        width: 340,
        padding: 16,
      }}
    >
      <div
        className="mb-4 uppercase"
        style={{ fontSize: 'var(--fs-10)', letterSpacing: "0.1em", color: "var(--text-secondary)" }}
      >
        Duplicate Tab Name
      </div>
      <p style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", marginBottom: 12 }}>
        {t("tab.duplicateExists").replace("{name}", baseName)}
      </p>
      <p style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)", marginBottom: 16 }}>
        {t("tab.duplicateConfirm").replace("{name}", uniqueName)}
      </p>
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 py-2 rounded transition-colors"
          style={{
            fontSize: 'var(--fs-10)',
            background: "transparent",
            border: "1px solid var(--border-default)",
            color: "var(--text-secondary)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)";
            (e.currentTarget as HTMLElement).style.borderColor = "var(--text-muted)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
            (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)";
          }}
        >
          {t("tab.cancel")}
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 py-2 rounded transition-colors"
          style={{
            fontSize: 'var(--fs-10)',
            background: "transparent",
            border: "1px solid var(--border-default)",
            color: "var(--text-secondary)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)";
            (e.currentTarget as HTMLElement).style.borderColor = "var(--text-muted)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
            (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)";
          }}
        >
          {t("tab.create")}
        </button>
      </div>
    </div>
  );
}
