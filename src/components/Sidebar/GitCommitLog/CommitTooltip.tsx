import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitCommitDetail } from "../../../types/git";
import { FILE_STATUS_STYLE } from "./constants";

/** Rich tooltip popover for a commit. */
export function CommitTooltip({
    cwd,
    hash,
    anchorRef,
    mousePos,
    onMouseEnter,
    onMouseLeave,
}: {
    cwd: string;
    hash: string;
    anchorRef: React.RefObject<HTMLDivElement | null>;
    mousePos: { x: number; y: number };
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}) {
    const [detail, setDetail] = useState<GitCommitDetail | null>(null);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        invoke<GitCommitDetail>("git_commit_detail", { path: cwd, hash })
            .then(setDetail)
            .catch(() => { });
    }, [cwd, hash]);

    useEffect(() => {
        if (!detail || !tooltipRef.current) return;
        const el = tooltipRef.current;
        const tooltipWidth = el.offsetWidth;
        const tooltipHeight = el.offsetHeight;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const margin = 8;
        const offset = 12;
        let left = mousePos.x + offset;
        let top = mousePos.y + offset;
        if (left + tooltipWidth + margin > viewportWidth) {
            left = mousePos.x - tooltipWidth - offset;
        }
        if (top + tooltipHeight + margin > viewportHeight) {
            top = mousePos.y - tooltipHeight - offset;
        }
        left = Math.max(margin, left);
        top = Math.max(margin, top);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- position must be measured after DOM mount
        setPos({ top, left });
    }, [detail, mousePos, anchorRef]);

    if (!detail) return null;

    return (
        <div
            ref={tooltipRef}
            className="fixed z-[1002] rounded shadow-lg"
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            style={{
                top: pos ? pos.top : mousePos.y + 12,
                left: pos ? pos.left : mousePos.x + 12,
                maxWidth: 380,
                overflowY: "auto",
                background: "var(--bg-elevated, var(--bg-surface))",
                border: "1px solid var(--border-subtle)",
                padding: 10,
                fontSize: 'var(--fs-11)',
                pointerEvents: "auto",
            }}
        >
            <div style={{ color: "var(--text-primary)", marginBottom: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {detail.message}
            </div>
            <div className="flex flex-col gap-0.5" style={{ marginBottom: 8, color: "var(--text-muted)", fontSize: 'var(--fs-10)' }}>
                <div>
                    <span style={{ color: "var(--accent-blue)" }}>{detail.author}</span>
                    <span style={{ marginLeft: 4 }}>&lt;{detail.email}&gt;</span>
                </div>
                <div>
                    <span style={{ fontFamily: "monospace", color: "var(--accent-yellow)" }}>{detail.fullHash}</span>
                </div>
                <div>{detail.date}</div>
            </div>
            {detail.files.length > 0 && (
                <div>
                    <div style={{ color: "var(--text-secondary)", marginBottom: 3, fontSize: 'var(--fs-10)' }}>
                        Changed Files ({detail.files.length})
                    </div>
                    <div className="flex flex-col gap-px" style={{ maxHeight: 160, overflowY: "auto" }}>
                        {detail.files.map((f) => {
                            const st = FILE_STATUS_STYLE[f.status] ?? { label: f.status, color: "var(--text-muted)" };
                            return (
                                <div key={f.path} className="flex items-center gap-1.5" style={{ fontSize: 'var(--fs-10)' }}>
                                    <span style={{ color: st.color, width: 10, textAlign: "center", flexShrink: 0 }}>
                                        {f.status}
                                    </span>
                                    <span className="truncate" style={{ color: "var(--text-secondary)" }}>
                                        {f.path}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
