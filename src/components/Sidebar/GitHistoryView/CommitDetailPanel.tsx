import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitBranch, Tag, CaretDown } from "@phosphor-icons/react";
import type { GitCommitDetail } from "../../../types/git";
import { useGitStore } from "../../../stores/gitStore";

const FILE_STATUS_STYLE: Record<string, { label: string; color: string }> = {
    M: { label: "Modified", color: "var(--accent-yellow)" },
    A: { label: "Added", color: "var(--status-active)" },
    D: { label: "Deleted", color: "var(--accent-red)" },
    R: { label: "Renamed", color: "var(--accent-blue)" },
};

/** Simple file tree from flat file list. */
function FileTreeView({ files }: { files: { path: string; status: string }[] }) {
    // Build tree structure
    type TreeNode = { name: string; status?: string; children: Map<string, TreeNode> };
    const root: TreeNode = { name: "", children: new Map() };

    for (const f of files) {
        const parts = f.path.split("/");
        let node = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!node.children.has(part)) {
                node.children.set(part, { name: part, children: new Map() });
            }
            node = node.children.get(part)!;
            if (i === parts.length - 1) {
                node.status = f.status;
            }
        }
    }

    const renderNode = (node: TreeNode, depth: number): React.ReactNode[] => {
        const entries = Array.from(node.children.entries()).sort(([, a], [, b]) => {
            const aDir = a.children.size > 0;
            const bDir = b.children.size > 0;
            if (aDir !== bDir) return aDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        return entries.map(([key, child]) => {
            const isDir = child.children.size > 0 && !child.status;
            const st = child.status ? (FILE_STATUS_STYLE[child.status] ?? { label: child.status, color: "var(--text-muted)" }) : null;
            return (
                <div key={key}>
                    <div
                        className="flex items-center gap-1 py-0.5 rounded hover:bg-[var(--bg-overlay)]"
                        style={{
                            paddingLeft: depth * 14 + 4,
                            fontSize: "var(--fs-11)",
                            color: isDir ? "var(--text-secondary)" : "var(--text-muted)",
                        }}
                    >
                        {isDir && <CaretDown size={9} />}
                        {st && (
                            <span
                                style={{
                                    width: 14,
                                    height: 14,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    borderRadius: 2,
                                    fontSize: "var(--fs-8)",
                                    fontWeight: 700,
                                    color: "var(--bg-base)",
                                    background: st.color,
                                    flexShrink: 0,
                                }}
                            >
                                {child.status}
                            </span>
                        )}
                        <span className="truncate">{child.name}</span>
                    </div>
                    {isDir && renderNode(child, depth + 1)}
                </div>
            );
        });
    };

    if (files.length === 0) {
        return <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-11)" }}>No file changes</div>;
    }

    return <div>{renderNode(root, 0)}</div>;
}

export default function CommitDetailPanel({ cwd, hash }: { cwd: string; hash: string | null }) {
    const [detail, setDetail] = useState<GitCommitDetail | null>(null);
    const [tab, setTab] = useState<"commit" | "changes" | "files">("commit");
    const commitLog = useGitStore((s) => s.commitLog);

    useEffect(() => {
        if (!hash) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- clear detail when hash unset
            setDetail(null);
            return;
        }
        invoke<GitCommitDetail>("git_commit_detail", { path: cwd, hash })
            .then(setDetail)
            .catch(() => setDetail(null));
    }, [cwd, hash]);

    // Find refs for the selected commit
    const commitEntry = commitLog.find((c) => c.hash === hash);
    const refs = commitEntry?.refs ?? [];

    if (!hash) {
        return (
            <div
                className="flex items-center justify-center"
                style={{ height: "100%", color: "var(--text-muted)", fontSize: "var(--fs-11)" }}
            >
                Select a commit to view details
            </div>
        );
    }

    if (!detail) {
        return (
            <div
                className="flex items-center justify-center"
                style={{ height: "100%", color: "var(--text-muted)", fontSize: "var(--fs-11)" }}
            >
                Loading...
            </div>
        );
    }

    const tabStyle = (active: boolean): React.CSSProperties => ({
        fontSize: "var(--fs-11)",
        padding: "4px 12px",
        cursor: "pointer",
        color: active ? "var(--text-primary)" : "var(--text-muted)",
        borderBottom: active ? "2px solid var(--accent-blue)" : "2px solid transparent",
        background: "transparent",
        userSelect: "none",
    });

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* Tabs */}
            <div
                className="flex shrink-0"
                style={{ borderBottom: "1px solid var(--border-subtle)" }}
            >
                <button style={tabStyle(tab === "commit")} onClick={() => setTab("commit")}>
                    Commit
                </button>
                <button style={tabStyle(tab === "changes")} onClick={() => setTab("changes")}>
                    Changes
                </button>
                <button style={tabStyle(tab === "files")} onClick={() => setTab("files")}>
                    File Tree
                </button>
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 12px" }}>
                {tab === "commit" && (
                    <div className="flex flex-col gap-2" style={{ fontSize: "var(--fs-11)" }}>
                        {/* Author */}
                        <div className="flex flex-col gap-0.5">
                            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-9)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                                Author
                            </div>
                            <div>
                                <span style={{ color: "var(--text-primary)" }}>{detail.author}</span>
                                <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>&lt;{detail.email}&gt;</span>
                            </div>
                            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-10)" }}>
                                {detail.date}
                            </div>
                        </div>

                        {/* Refs */}
                        {refs.length > 0 && (
                            <div className="flex flex-col gap-0.5">
                                <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-9)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                                    Refs
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {refs.map((ref) => {
                                        const isTag = ref.startsWith("tag: ");
                                        const label = ref.replace(/^tag: /, "").replace(/^HEAD -> /, "");
                                        return (
                                            <span
                                                key={ref}
                                                className="flex items-center gap-0.5 px-1.5 rounded"
                                                style={{
                                                    fontSize: "var(--fs-9)",
                                                    lineHeight: "16px",
                                                    background: isTag ? "color-mix(in srgb, var(--accent-yellow) 15%, transparent)" : "color-mix(in srgb, var(--accent-blue) 20%, transparent)",
                                                    color: isTag ? "var(--accent-yellow)" : "var(--accent-blue)",
                                                    border: `1px solid ${isTag ? "color-mix(in srgb, var(--accent-yellow) 30%, transparent)" : "color-mix(in srgb, var(--accent-blue) 35%, transparent)"}`,
                                                }}
                                            >
                                                {isTag ? <Tag size={9} weight="fill" /> : <GitBranch size={9} weight="bold" />}
                                                {label}
                                            </span>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* SHA */}
                        <div className="flex flex-col gap-0.5">
                            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-9)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                                SHA
                            </div>
                            <div style={{ fontFamily: "monospace", color: "var(--accent-yellow)", fontSize: "var(--fs-10)" }}>
                                {detail.fullHash}
                            </div>
                        </div>

                        {/* Parents */}
                        {commitEntry && commitEntry.parents.length > 0 && (
                            <div className="flex flex-col gap-0.5">
                                <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-9)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                                    Parents
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {commitEntry.parents.map((p) => (
                                        <span
                                            key={p}
                                            style={{
                                                fontFamily: "monospace",
                                                fontSize: "var(--fs-10)",
                                                color: "var(--accent-blue)",
                                            }}
                                        >
                                            {p}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Message */}
                        <div
                            style={{
                                marginTop: 4,
                                padding: "8px 0",
                                borderTop: "1px solid var(--border-subtle)",
                                color: "var(--text-primary)",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                lineHeight: 1.5,
                            }}
                        >
                            {detail.message}
                        </div>
                    </div>
                )}

                {tab === "changes" && (
                    <div className="flex flex-col gap-0.5">
                        {detail.files.length === 0 && (
                            <div style={{ color: "var(--text-muted)" }}>No file changes</div>
                        )}
                        {detail.files.map((f) => {
                            const st = FILE_STATUS_STYLE[f.status] ?? { label: f.status, color: "var(--text-muted)" };
                            return (
                                <div
                                    key={f.path}
                                    className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-[var(--bg-overlay)]"
                                    style={{ fontSize: "var(--fs-11)" }}
                                >
                                    <span
                                        style={{
                                            width: 18,
                                            height: 18,
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            borderRadius: 3,
                                            fontSize: "var(--fs-9)",
                                            fontWeight: 700,
                                            color: "var(--bg-base)",
                                            background: st.color,
                                            flexShrink: 0,
                                        }}
                                    >
                                        {f.status}
                                    </span>
                                    <span style={{ color: "var(--text-secondary)" }} className="truncate">
                                        {f.path}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}

                {tab === "files" && (
                    <FileTreeView files={detail.files} />
                )}
            </div>
        </div>
    );
}
