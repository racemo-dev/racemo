import type { CommitSuggestion, GitOutputLine } from "../../../stores/gitOutputStore";
import { useGitT } from "../../../lib/i18n/git";
import { TYPE_COLORS } from "./constants";

function TypeBadge({ type }: { type: string }) {
  const base = type.replace(/\(.*\)/, "").trim();
  const colors = TYPE_COLORS[base] ?? { bg: "color-mix(in srgb, var(--text-muted) 12%, transparent)", text: "var(--text-muted)" };
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 7px", borderRadius: 4,
      background: colors.bg, color: colors.text,
      fontSize: 10, fontWeight: 700, whiteSpace: "nowrap", letterSpacing: "0.03em",
    }}>
      {type}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
      color: "var(--text-tertiary)", textTransform: "uppercase",
      marginBottom: 8, paddingBottom: 4,
      borderBottom: "1px solid var(--border-subtle)",
    }}>
      {children}
    </div>
  );
}

export function CommitSummaryView({ suggestions, changedFiles }: {
  lines: GitOutputLine[];
  suggestions: CommitSuggestion[];
  changedFiles: string[];
}) {
  const t = useGitT();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, lineHeight: 1.6 }}>

      {/* Commit messages */}
      {suggestions.length > 0 && (
        <section>
          <SectionTitle>{t("gitOutput.commitMessages")}</SectionTitle>
          <div style={{
            background: "var(--bg-overlay)",
            borderRadius: 6, padding: "10px 14px",
            display: "flex", flexDirection: "column", gap: 5,
          }}>
            {suggestions.map((s, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                {s.type && <TypeBadge type={s.type} />}
                <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>{s.message}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Changed files */}
      {changedFiles.length > 0 && (
        <section>
          <SectionTitle>{t("gitOutput.changedFiles")} ({changedFiles.length})</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {changedFiles.map((f, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "3px 8px", borderRadius: 4,
              }}>
                <span style={{ color: "var(--text-tertiary)", fontSize: 10, flexShrink: 0 }}>&#9656;</span>
                <code style={{ color: "var(--accent-yellow)", fontSize: 11 }}>{f}</code>
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}
