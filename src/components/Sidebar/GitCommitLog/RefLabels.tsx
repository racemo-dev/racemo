import { GitBranch, Tag } from "@phosphor-icons/react";

export function RefLabels({ refs }: { refs: string[] }) {
    if (refs.length === 0) return null;
    return (
        <div className="flex items-center gap-1 flex-shrink-0">
            {refs.map((ref) => {
                const isTag = ref.startsWith("tag: ");
                const label = ref.replace(/^tag: /, "").replace(/^HEAD -> /, "");
                const isHead = ref.startsWith("HEAD -> ") || ref === "HEAD";
                return (
                    <span
                        key={ref}
                        className="flex items-center gap-0.5 px-1 rounded"
                        style={{
                            fontSize: 'var(--fs-9)',
                            lineHeight: '14px',
                            background: isTag ? "color-mix(in srgb, var(--accent-yellow) 15%, transparent)" : isHead ? "color-mix(in srgb, var(--accent-blue) 20%, transparent)" : "color-mix(in srgb, var(--status-active) 15%, transparent)",
                            color: isTag ? "var(--accent-yellow)" : isHead ? "var(--accent-blue)" : "var(--status-active)",
                            border: `1px solid ${isTag ? "color-mix(in srgb, var(--accent-yellow) 30%, transparent)" : isHead ? "color-mix(in srgb, var(--accent-blue) 35%, transparent)" : "color-mix(in srgb, var(--status-active) 30%, transparent)"}`,
                            whiteSpace: "nowrap",
                        }}
                    >
                        {isTag ? (
                            <Tag size={9} weight="fill" />
                        ) : (
                            <GitBranch size={9} weight="bold" />
                        )}
                        {label}
                    </span>
                );
            })}
        </div>
    );
}
