import { useState, useRef, useCallback } from "react";
import { X } from "@phosphor-icons/react";
import GitCommitLog from "../GitCommitLog";
import RefsTree from "./RefsTree";
import CommitDetailPanel from "./CommitDetailPanel";
import HorizontalDivider from "./HorizontalDivider";

export default function GitHistoryView({
    cwd,
    onClose,
}: {
    cwd: string;
    onClose: () => void;
}) {
    const [selectedHash, setSelectedHash] = useState<string | null>(null);
    const [detailHeight, setDetailHeight] = useState(220);
    const containerRef = useRef<HTMLDivElement>(null);

    const handleDrag = useCallback((deltaY: number) => {
        setDetailHeight((h) => Math.max(80, Math.min(500, h - deltaY)));
    }, []);

    return (
        <div
            onClick={onClose}
            style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                zIndex: 999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
            }}
        >
            <div
                ref={containerRef}
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: "85vw",
                    maxWidth: 1100,
                    height: "80vh",
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 8,
                    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                }}
            >
                {/* Title bar */}
                <div
                    className="flex items-center shrink-0 px-3"
                    style={{
                        height: "calc(30px * var(--ui-scale))",
                        fontSize: "var(--fs-11)",
                        letterSpacing: "0.08em",
                        color: "var(--text-tertiary)",
                        borderBottom: "1px solid var(--border-subtle)",
                        userSelect: "none",
                    }}
                >
                    <span>Git History</span>
                    <button
                        onClick={onClose}
                        className="sb-icon ml-auto cursor-pointer"
                        style={{ lineHeight: 0 }}
                    >
                        <X size={14} style={{ width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))" }} />
                    </button>
                </div>

                {/* Main body: left refs + right (graph + detail) */}
                <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                    {/* Left: Refs tree */}
                    <RefsTree cwd={cwd} />

                    {/* Right: graph (top) + detail (bottom) */}
                    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                        {/* Commit graph */}
                        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                            <GitCommitLog
                                cwd={cwd}
                                onSelect={setSelectedHash}
                                selectedHash={selectedHash ?? undefined}
                            />
                        </div>

                        {/* Resizable divider */}
                        <HorizontalDivider onDrag={handleDrag} />

                        {/* Commit detail */}
                        <div
                            style={{
                                height: detailHeight,
                                minHeight: 80,
                                flexShrink: 0,
                                borderTop: "1px solid var(--border-subtle)",
                                overflow: "hidden",
                            }}
                        >
                            <CommitDetailPanel cwd={cwd} hash={selectedHash} />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
