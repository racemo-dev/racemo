import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { useGitStore } from "../../stores/gitStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { GitCommit, X } from "@phosphor-icons/react";
import GitCommitLog from "../Sidebar/GitCommitLog";
import { useGitT } from "../../lib/i18n/git";
import { BrowserHideGuard } from "../Editor/BrowserViewer";
import { firstLeafId } from "../../lib/paneTreeUtils";
import { getDefaultTerminalSize } from "../../lib/terminalUtils";
import { logger } from "../../lib/logger";
import type { Session } from "../../types/session";

export default function AddWorktreeModal() {
    const t = useGitT();
    const isOpen = useWorktreeStore((s) => s.isAddModalOpen);
    const cwd = useWorktreeStore((s) => s.modalCwd);
    const modalTarget = useWorktreeStore((s) => s.modalTarget);
    const close = useWorktreeStore((s) => s.closeAddModal);
    const add = useWorktreeStore((s) => s.add);

    const [suffix, setSuffix] = useState("");
    const [target, setTarget] = useState("");
    const [newBranch, setNewBranch] = useState(true);
    const [error, setError] = useState("");
    const [isAdding, setIsAdding] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    // 동기 재진입 가드 — state 업데이트 지연 사이 더블 트리거 차단
    const isAddingRef = useRef(false);

    const commitLog = useGitStore((s) => s.commitLog);
    const hasAutoSelected = useRef(false);

    // Reset state when opened
    useEffect(() => {
        if (isOpen) {
            setSuffix("");
            setTarget(modalTarget ?? "");
            setNewBranch(true);
            setError("");
            setIsAdding(false);
            isAddingRef.current = false;
            hasAutoSelected.current = !!modalTarget;
            inputRef.current?.focus();
        }
    }, [isOpen, modalTarget]);

    // Auto-select first commit (HEAD) when log loads (only if no modalTarget)
    useEffect(() => {
        if (isOpen && !hasAutoSelected.current && commitLog.length > 0) {
            setTarget(commitLog[0].hash);
            hasAutoSelected.current = true;
        }
    }, [isOpen, commitLog]);

    // Close on ESC
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") close();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, close]);

    if (!isOpen || !cwd) return null;

    // Full-screen loading overlay when creating worktree
    if (isAdding) {
        return (
            <>
            <BrowserHideGuard />
            <div

                className="fixed inset-0 z-50 flex items-center justify-center"
                style={{ background: "rgba(0,0,0,0.6)" }}
            >
                <div className="flex flex-col items-center gap-4">
                    <div
                        className="w-12 h-12 border-[3px] border-t-blue-500 border-r-blue-500/30 border-b-transparent border-l-transparent rounded-full"
                        style={{ animation: "spin 1s linear infinite" }}
                    />
                    <span style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: "var(--text-primary)" }}>
                        {t("addWt.creating")}
                    </span>
                </div>
            </div>
            </>
        );
    }

    const repoName = cwd.split(/[\\/]/).pop() || "project";
    const branchName = suffix ? `${repoName}-${suffix}` : "";
    const worktreePath = branchName ? `${cwd}/../${branchName}` : "";

    const handleAdd = async () => {
        if (!suffix.trim() || isAddingRef.current) return;
        isAddingRef.current = true;
        setIsAdding(true);
        setError("");
        try {
            await add(cwd, worktreePath, branchName, newBranch, target.trim() || undefined);
            // 생성 성공 → 해당 워크트리에 대한 탭(세션)을 자동으로 열어 활성화
            try {
                const { sessions, setActiveSession, setFocusedPane, addSession } = useSessionStore.getState();
                const dirName = worktreePath.split(/[\\/]/).pop() ?? worktreePath;
                const existingSession = sessions.find((s) => s.name === dirName);
                if (existingSession) {
                    setActiveSession(existingSession.id);
                    setFocusedPane(firstLeafId(existingSession.rootPane));
                } else {
                    const shell = useSettingsStore.getState().defaultShell;
                    const { rows, cols } = getDefaultTerminalSize();
                    const session = await invoke<Session>("create_session", {
                        name: dirName,
                        workingDir: worktreePath,
                        shell,
                        rows,
                        cols,
                    });
                    addSession(session);
                    setFocusedPane(firstLeafId(session.rootPane));
                }
            } catch (e) {
                // 탭 생성 실패는 치명적이지 않음 — 워크트리 자체는 이미 만들어졌으니 로그만 남기고 진행
                logger.error("Failed to open session for new worktree:", e);
            }
            close();
        } catch (e) {
            // 재시도 없이 즉시 실패 처리: 모달은 유지하고 인라인 에러로 알림
            const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
            setError(msg);
        } finally {
            isAddingRef.current = false;
            setIsAdding(false);
        }
    };

    return (
        <>
        <BrowserHideGuard />
        <div

            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={(e) => {
                if (e.target === e.currentTarget) close();
            }}
        >
            <div
                className="flex flex-col rounded-lg shadow-2xl overflow-hidden"
                style={{
                    width: 800,
                    height: 600,
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                }}
            >
                {/* Header */}
                <div
                    className="flex items-center justify-between px-4 py-3 shrink-0"
                    style={{ borderBottom: "1px solid var(--border-default)" }}
                >
                    <div className="flex items-center gap-2">
                        <GitCommit size={18} style={{ color: "var(--text-muted)" }} />
                        <span style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: "var(--text-primary)" }}>
                            {t("addWt.title")}
                        </span>
                    </div>
                    <button
                        onClick={close}
                        className="cursor-pointer transition-colors"
                        style={{ color: "var(--text-muted)" }}
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 flex min-h-0">
                    {/* Left: Commit Graph */}
                    <div
                        className="flex-1 border-r border-r-[var(--border-default)] overflow-y-auto"
                        style={{ background: "var(--bg-subtle)" }}
                    >
                        <div className="p-3">
                            <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                {t("addWt.selectSource")}
                            </div>
                            <GitCommitLog
                                cwd={cwd}
                                onSelect={(hash) => setTarget(hash)}
                                selectedHash={target}
                            />
                        </div>
                    </div>

                    {/* Right: Form */}
                    <div className="w-[300px] flex flex-col p-4 gap-4 shrink-0 overflow-y-auto">

                        {/* Name Input */}
                        <div className="flex flex-col gap-1.5">
                            <label style={{ fontSize: 'var(--fs-12)', fontWeight: 500, color: "var(--text-secondary)" }}>
                                {t("addWt.nameSuffix")}
                            </label>
                            <div
                                className="flex items-center rounded overflow-hidden"
                                style={{
                                    background: "var(--bg-overlay)",
                                    border: "1px solid var(--border-default)",
                                }}
                            >
                                <span
                                    className="px-2 py-1.5 shrink-0"
                                    style={{
                                        fontSize: 'var(--fs-12)',
                                        color: "var(--text-muted)",
                                        background: "var(--bg-subtle)",
                                        borderRight: "1px solid var(--border-default)",
                                    }}
                                >
                                    {repoName}-
                                </span>
                                <input
                                    ref={inputRef}
                                    type="text"
                                    placeholder={t("addWt.namePlaceholder")}
                                    value={suffix}
                                    onChange={(e) => setSuffix(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleAdd();
                                    }}
                                    className="flex-1 px-2 py-1.5 outline-none"
                                    style={{
                                        fontSize: 'var(--fs-12)',
                                        background: "transparent",
                                        color: "var(--text-primary)",
                                    }}
                                />
                            </div>
                            {branchName && (
                                <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)" }}>
                                    {t("addWt.branch")}<span style={{ fontFamily: "monospace" }}>{branchName}</span>
                                </div>
                            )}
                        </div>

                        {/* Source Input */}
                        <div className="flex flex-col gap-1.5">
                            <label style={{ fontSize: 'var(--fs-12)', fontWeight: 500, color: "var(--text-secondary)" }}>
                                {t("addWt.source")}
                            </label>
                            <input
                                type="text"
                                placeholder={t("addWt.sourcePlaceholder")}
                                value={target}
                                onChange={(e) => setTarget(e.target.value)}
                                className="w-full px-2 py-1.5 rounded outline-none"
                                style={{
                                    fontSize: 'var(--fs-12)',
                                    fontFamily: "monospace",
                                    background: "var(--bg-overlay)",
                                    color: "var(--text-primary)",
                                    border: "1px solid var(--border-default)",
                                }}
                            />
                            <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)" }}>
                                {t("addWt.sourceHelp")}
                            </div>
                        </div>

                        {/* Options */}
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={newBranch}
                                onChange={(e) => setNewBranch(e.target.checked)}
                                style={{ accentColor: "var(--accent-blue)" }}
                            />
                            <span style={{ fontSize: 'var(--fs-12)', color: "var(--text-secondary)" }}>{t("addWt.newBranch")}</span>
                        </label>

                        {/* Error */}
                        {error && (
                            <div
                                className="p-2 rounded"
                                style={{ background: "color-mix(in srgb, var(--accent-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--accent-red) 20%, transparent)" }}
                            >
                                <div style={{ fontSize: 'var(--fs-11)', color: "var(--accent-red)" }}>{error}</div>
                            </div>
                        )}

                        <div className="flex-1" />

                        {/* Actions */}
                        <div className="flex gap-2 pt-4" style={{ borderTop: "1px solid var(--border-default)" }}>
                            <button
                                onClick={close}
                                className="flex-1 py-1.5 rounded transition-colors"
                                style={{
                                    fontSize: 'var(--fs-12)',
                                    color: "var(--text-secondary)",
                                    background: "transparent",
                                    border: "1px solid var(--border-default)",
                                }}
                            >
                                {t("addWt.cancel")}
                            </button>
                            <button
                                onClick={handleAdd}
                                disabled={!suffix.trim() || isAdding}
                                className="flex-1 py-1.5 rounded transition-colors"
                                style={{
                                    fontSize: 'var(--fs-12)',
                                    fontWeight: 600,
                                    color: suffix.trim() ? "white" : "var(--text-secondary)",
                                    background: suffix.trim() ? "var(--accent-blue)" : "transparent",
                                    border: `1px solid ${suffix.trim() ? "var(--accent-blue)" : "var(--border-default)"}`,
                                    opacity: suffix.trim() ? 1 : 0.6,
                                    cursor: suffix.trim() ? "pointer" : "not-allowed",
                                }}
                            >
                                {isAdding ? t("addWt.creatingBtn") : t("addWt.create")}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        </>
    );
}
