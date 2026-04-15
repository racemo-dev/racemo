/* eslint-disable react-refresh/only-export-components -- exports both component and helper utility */
import type { GitFileStatus } from "../../types/git";

const STATUS_CONFIG: Record<GitFileStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "var(--accent-yellow)" },
  added: { label: "A", color: "var(--status-active)" },
  deleted: { label: "D", color: "var(--accent-red)" },
  renamed: { label: "R", color: "var(--accent-blue)" },
  untracked: { label: "U", color: "var(--text-muted)" },
  conflicted: { label: "!", color: "var(--status-error, var(--accent-red))" },
  discarded: { label: "↩", color: "var(--accent-yellow)" },
};

export default function GitStatusIcon({ status }: { status: GitFileStatus | undefined }) {
  if (!status) return null;
  const cfg = STATUS_CONFIG[status];
  if (!cfg) return null;

  return (
    <span
      style={{
        fontSize: 'var(--fs-9)',
        fontWeight: 600,
        color: cfg.color,
        lineHeight: 1,
        flexShrink: 0,
        marginLeft: "auto",
        paddingRight: 6,
      }}
      title={status}
    >
      {cfg.label}
    </span>
  );
}

/** Get text color for a file/folder based on git status. */
export function getStatusColor(status: GitFileStatus | undefined): string | undefined {
  if (!status) return undefined;
  return STATUS_CONFIG[status]?.color;
}
