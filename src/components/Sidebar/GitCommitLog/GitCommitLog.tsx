import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useGitStore } from "../../../stores/gitStore";
import { useWorktreeStore } from "../../../stores/worktreeStore";
import { useDialogStore } from "../../../stores/dialogStore";
import { FolderOpen } from "@phosphor-icons/react";
import type { GitCommitEntry } from "../../../types/git";
import { computeGraphRows, getMaxLanes } from "../../../lib/gitGraph";
import type { GraphRow } from "../../../lib/gitGraph";

import { LANE_WIDTH, ROW_HEIGHT, GRAPH_PADDING } from "./constants";
import { GraphCell } from "./GraphCell";
import { CommitTooltip } from "./CommitTooltip";
import { RefLabels } from "./RefLabels";
import { CommitContextMenu } from "./CommitContextMenu";
import { useCommitActions } from "./useCommitActions";

export default function GitCommitLog({
    cwd,
    onSelect,
    selectedHash,
    multiSelected,
    onOpenChanges,
    onOpenDiff,
}: {
    cwd: string;
    onSelect?: (hash: string) => void;
    selectedHash?: string;
    multiSelected?: string[];
    onOpenChanges?: (hash: string) => void;
    onOpenDiff?: (diff: string) => void;
}) {
    const commitLog = useGitStore((s) => s.commitLog);
    const loadCommitLog = useGitStore((s) => s.loadCommitLog);
    const worktrees = useWorktreeStore((s) => s.worktrees);
    const [loaded, setLoaded] = useState(false);
    const [hoveredHash, setHoveredHash] = useState<string | null>(null);
    const [hoveredMousePos, setHoveredMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const hoveredRef = useRef<HTMLDivElement | null>(null);
    const hoverMousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commit: GitCommitEntry } | null>(null);
    const [inputPrompt, setInputPrompt] = useState<{ type: "branch" | "tag"; hash: string } | null>(null);
    const [inputValue, setInputValue] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const [compareSource, setCompareSource] = useState<string | null>(null);

    const HOVER_HIDE_DELAY = 500;

    // ── Compute graph rows ──
    const graphRows = useMemo(() => computeGraphRows(commitLog), [commitLog]);
    const maxLanes = useMemo(() => getMaxLanes(graphRows), [graphRows]);
    const graphWidth = GRAPH_PADDING * 2 + Math.max(maxLanes, 1) * LANE_WIDTH;

    const worktreeMap = useMemo(() => {
        const map: Record<string, typeof worktrees> = {};
        for (const wt of worktrees) {
            if (!wt.head) continue;
            const shortHash = wt.head.substring(0, 7);
            if (!map[shortHash]) map[shortHash] = [];
            map[shortHash].push(wt);
        }
        return map;
    }, [worktrees]);

    useEffect(() => {
        if (cwd && !loaded) {
            loadCommitLog(cwd);
            // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load flag
            setLoaded(true);
        }
    }, [cwd, loaded, loadCommitLog]);

    useEffect(() => {
        if (!contextMenu) return;
        const handleClick = () => setContextMenu(null);
        window.addEventListener("click", handleClick);
        window.addEventListener("contextmenu", handleClick, { capture: true });
        return () => {
            window.removeEventListener("click", handleClick);
            window.removeEventListener("contextmenu", handleClick, { capture: true });
        };
    }, [contextMenu]);

    useEffect(() => {
        if (inputPrompt) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- reset input when new prompt arrives
            setInputValue("");
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [inputPrompt]);

    const closeMenu = useCallback(() => setContextMenu(null), []);

    const actions = useCommitActions({
        cwd,
        loadCommitLog,
        onOpenChanges,
        onOpenDiff,
        closeMenu,
        setInputPrompt,
        setCompareSource,
    });

    const handleMouseEnter = (hash: string, el: HTMLDivElement, isSelected: boolean, e: React.MouseEvent) => {
        if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
        if (!isSelected) el.style.background = "var(--bg-overlay)";
        hoverMousePos.current = { x: e.clientX, y: e.clientY };
        if (hoveredHash === hash) return;

        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
            hoveredRef.current = el;
            setHoveredMousePos({ ...hoverMousePos.current });
            setHoveredHash(hash);
            hoverTimerRef.current = null;
        }, 400);
    };

    const handleMouseLeave = (el: HTMLDivElement, isSelected: boolean) => {
        if (!isSelected) el.style.background = "transparent";
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }

        hideTimerRef.current = setTimeout(() => {
            setHoveredHash(null);
            hideTimerRef.current = null;
        }, HOVER_HIDE_DELAY);
    };

    const handleTooltipMouseEnter = () => {
        if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
    };

    const handleTooltipMouseLeave = () => {
        hideTimerRef.current = setTimeout(() => {
            setHoveredHash(null);
            hideTimerRef.current = null;
        }, HOVER_HIDE_DELAY);
    };

    const handleContextMenu = (e: React.MouseEvent, commit: GitCommitEntry) => {
        e.preventDefault();
        e.stopPropagation();
        setHoveredHash(null);
        setContextMenu({ x: e.clientX, y: e.clientY, commit });
    };

    const handleInputSubmit = async () => {
        if (!inputPrompt || !inputValue.trim()) return;
        const name = inputValue.trim();
        try {
            if (inputPrompt.type === "branch") {
                await invoke("git_create_branch", { path: cwd, name, startPoint: inputPrompt.hash });
            } else {
                await invoke("git_create_tag", { path: cwd, name, hash: inputPrompt.hash });
            }
            loadCommitLog(cwd);
        } catch (e) {
            useDialogStore.getState().show({ title: "Error", message: String(e), type: "error" });
        }
        setInputPrompt(null);
    };

    const handleRowClick = (c: GitCommitEntry) => {
        if (compareSource) {
            invoke<string>("git_diff_commits", { path: cwd, hash1: compareSource, hash2: c.hash })
                .then((diff) => onOpenDiff?.(diff))
                .catch((e) => useDialogStore.getState().show({ title: "Error", message: String(e), type: "error" }));
            setCompareSource(null);
            return;
        }
        onSelect?.(c.hash);
    };

    return (
        <div>
            {/* Compare mode banner */}
            {compareSource && (
                <div
                    className="flex items-center justify-between px-3 py-1.5"
                    style={{ background: "var(--accent-blue)", color: "var(--bg-base)", fontSize: 'var(--fs-11)' }}
                >
                    <span>Select a commit to compare with {compareSource}</span>
                    <button
                        className="px-2 py-0.5 rounded"
                        style={{ background: "color-mix(in srgb, var(--text-primary) 20%, transparent)", fontSize: 'var(--fs-10)' }}
                        onClick={() => setCompareSource(null)}
                    >
                        Cancel
                    </button>
                </div>
            )}

            {/* Input prompt for branch/tag creation */}
            {inputPrompt && (
                <div
                    className="flex items-center gap-2 px-3 py-1.5"
                    style={{ background: "var(--bg-overlay)", borderBottom: "1px solid var(--border-default)" }}
                >
                    <span style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {inputPrompt.type === "branch" ? "Branch name:" : "Tag name:"}
                    </span>
                    <input
                        ref={inputRef}
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") handleInputSubmit();
                            if (e.key === "Escape") setInputPrompt(null);
                        }}
                        className="flex-1 px-1.5 py-0.5 rounded outline-none"
                        style={{
                            fontSize: 'var(--fs-11)',
                            background: "var(--bg-surface)",
                            color: "var(--text-primary)",
                            border: "1px solid var(--border-default)",
                        }}
                    />
                    <button
                        className="px-2 py-0.5 rounded"
                        style={{ fontSize: 'var(--fs-10)', background: "var(--accent-blue)", color: "var(--bg-base)" }}
                        onClick={handleInputSubmit}
                    >
                        OK
                    </button>
                    <button
                        className="px-2 py-0.5 rounded"
                        style={{ fontSize: 'var(--fs-10)', background: "var(--bg-subtle)", color: "var(--text-muted)" }}
                        onClick={() => setInputPrompt(null)}
                    >
                        Cancel
                    </button>
                </div>
            )}

            {commitLog.length === 0 && (
                <div className="px-3 py-1" style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)" }}>
                    No commits
                </div>
            )}
            {commitLog.map((c, i) => {
                const isHead = i === 0;
                const isLast = i === commitLog.length - 1;
                const isSelected = cwd === c.hash || selectedHash === c.hash || (multiSelected ? multiSelected.includes(c.hash) : false);
                const matchingWorktrees = worktreeMap[c.hash] ?? [];
                const graphRow: GraphRow | undefined = graphRows[i];

                return (
                    <div
                        key={c.hash}
                        className={`flex items-center gap-0 ${onSelect || compareSource ? "cursor-pointer" : "cursor-default"}`}
                        style={{
                            fontSize: 'var(--fs-11)',
                            paddingRight: 6,
                            height: ROW_HEIGHT,
                            background: isSelected ? "var(--bg-overlay)" : "transparent",
                            transition: "background-color 0.1s",
                            outline: compareSource ? "1px dashed var(--accent-blue)" : "none",
                            outlineOffset: -1,
                        }}
                        onMouseEnter={(e) => handleMouseEnter(c.hash, e.currentTarget as HTMLDivElement, isSelected, e)}
                        onMouseLeave={(e) => handleMouseLeave(e.currentTarget as HTMLDivElement, isSelected)}
                        onClick={() => handleRowClick(c)}
                        onContextMenu={(e) => handleContextMenu(e, c)}
                    >
                        {/* Graph SVG */}
                        {graphRow && (
                            <GraphCell
                                row={graphRow}
                                isFirst={isHead}
                                isLast={isLast}
                                isHead={isHead}
                                isSelected={isSelected}
                                graphWidth={graphWidth}
                            />
                        )}

                        {/* Content */}
                        <div className="flex-1 min-w-0 flex items-center gap-1.5" style={{ height: ROW_HEIGHT }}>
                            {/* Ref labels (branches, tags) */}
                            <RefLabels refs={c.refs} />

                            <span className="truncate" style={{ color: "var(--text-secondary)" }}>
                                {c.message}
                            </span>

                            {/* Worktree labels */}
                            {matchingWorktrees.length > 0 && (
                                <div className="flex flex-wrap gap-1 flex-shrink-0">
                                    {matchingWorktrees.map(wt => (
                                        <div
                                            key={wt.path}
                                            className="flex items-center gap-0.5 px-1.5 rounded"
                                            style={{
                                                fontSize: 'var(--fs-9)',
                                                background: "var(--bg-subtle)",
                                                border: "1px solid var(--border-subtle)",
                                                color: "var(--accent-yellow)",
                                                height: 16,
                                                whiteSpace: "nowrap"
                                            }}
                                            title={wt.path}
                                        >
                                            <FolderOpen size={10} weight="fill" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }} />
                                            <span>{wt.path.split(/[\\/]/).pop()}</span>
                                            {wt.branch && (
                                                <span style={{ color: "var(--text-muted)", marginLeft: 2 }}>
                                                    ({wt.branch})
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                                <span style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)" }}>
                                    {c.relativeTime}
                                </span>
                                <span style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)", fontFamily: "monospace" }}>
                                    {c.hash}
                                </span>
                            </div>
                        </div>
                    </div>
                );
            })}
            {hoveredHash && (
                <CommitTooltip
                    cwd={cwd}
                    hash={hoveredHash}
                    anchorRef={hoveredRef}
                    mousePos={hoveredMousePos}
                    onMouseEnter={handleTooltipMouseEnter}
                    onMouseLeave={handleTooltipMouseLeave}
                />
            )}

            {/* ── Context Menu ── */}
            {contextMenu && (
                <CommitContextMenu
                    contextMenu={contextMenu}
                    onOpenChanges={onOpenChanges}
                    actions={actions}
                />
            )}
        </div>
    );
}
