import { useState, useEffect } from "react";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { X, ArrowClockwise, Check, Scissors, ArrowCounterClockwise, ArrowSquareIn } from "@phosphor-icons/react";
import GitCommitLog from "../Sidebar/GitCommitLog";
import { useGitT, type TranslationKey } from "../../lib/i18n/git";
import { runGitStreaming } from "../../lib/gitStream";
import { BrowserHideGuard } from "../Editor/BrowserViewer";

type ResetMode = "soft" | "mixed" | "hard";

const resetLabelKeys: Record<ResetMode, TranslationKey> = {
    soft: "wtAction.resetSoft",
    mixed: "wtAction.resetMixed",
    hard: "wtAction.resetHard",
};
const resetDescKeys: Record<ResetMode, TranslationKey> = {
    soft: "wtAction.resetSoftDesc",
    mixed: "wtAction.resetMixedDesc",
    hard: "wtAction.resetHardDesc",
};

export default function WorktreeActionModal() {
    const t = useGitT();
    const { actionModal, closeActionModal } = useWorktreeStore();
    const { isOpen, mode, worktree, cwd } = actionModal;

    const [target, setTarget] = useState("main");
    const [useRebase, setUseRebase] = useState(true);
    const [useSquash, setUseSquash] = useState(false);
    const [resetMode, setResetMode] = useState<ResetMode>("mixed");
    const [selectedCommits, setSelectedCommits] = useState<string[]>([]);
    const [error, setError] = useState("");
    const [isProcessing, setIsProcessing] = useState(false);
    const [confirmHard, setConfirmHard] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setTarget("main");
            setUseRebase(true);
            setUseSquash(false);
            setResetMode("mixed");
            setSelectedCommits([]);
            setError("");
            setConfirmHard(false);
        }
    }, [isOpen]);

    if (!isOpen || !worktree || !cwd) return null;

    const handleAction = async () => {
        if (mode === "reset" && resetMode === "hard" && !confirmHard) {
            setConfirmHard(true);
            return;
        }
        setIsProcessing(true);
        setError("");
        closeActionModal();

        const onSuccess = () => {
            if (cwd) {
                useWorktreeStore.getState().refresh(cwd);
            }
        };

        try {
            if (mode === "sync") {
                if (useRebase) {
                    await runGitStreaming(
                        [
                            { cwd, args: ["fetch", "origin"], label: "fetch" },
                            { cwd: worktree.path, args: ["rebase", "--autostash", target], label: "rebase" },
                        ],
                        cfg.title,
                        onSuccess
                    );
                } else {
                    await runGitStreaming(
                        [
                            { cwd, args: ["fetch", "origin"], label: "fetch" },
                            { cwd: worktree.path, args: ["stash", "push", "--include-untracked", "-m", "racemo-autostash"] },
                            { cwd: worktree.path, args: ["merge", target], label: "merge" },
                            { cwd: worktree.path, args: ["stash", "pop"] },
                        ],
                        cfg.title,
                        onSuccess
                    );
                }
            } else if (mode === "apply") {
                const branch = worktree.branch ?? "";
                const mergeArgs = useSquash
                    ? ["merge", "--squash", branch]
                    : ["merge", branch];
                // 원본 리포가 이미 target 브랜치면 checkout 불필요 (워크트리 존재 시 checkout 실패 방지)
                const steps: { cwd: string; args: string[]; label?: string }[] = [];
                const { invoke } = await import("@tauri-apps/api/core");
                const info = await invoke<{ branch: string }>("git_repo_info", { path: cwd }).catch(() => ({ branch: "" }));
                if (info.branch !== target) {
                    steps.push({ cwd, args: ["checkout", target], label: "checkout" });
                }
                steps.push({ cwd, args: mergeArgs, label: "merge" });
                await runGitStreaming(steps, cfg.title, onSuccess);
            } else if (mode === "pull") {
                await runGitStreaming(
                    [{ cwd: worktree.path, args: ["pull"], label: "pull" }],
                    cfg.title,
                    onSuccess
                );
            } else if (mode === "cherrypick") {
                await runGitStreaming(
                    selectedCommits.map((hash) => ({
                        cwd: worktree.path,
                        args: ["cherry-pick", "--allow-empty", hash],
                        label: `cherry-pick ${hash.slice(0, 8)}`,
                    })),
                    cfg.title,
                    onSuccess
                );
            } else if (mode === "reset") {
                const flag = resetMode === "soft" ? "--soft" : resetMode === "hard" ? "--hard" : "--mixed";
                await runGitStreaming(
                    [{ cwd: worktree.path, args: ["reset", flag, target], label: "reset" }],
                    cfg.title,
                    onSuccess
                );
            }
        } catch (e) {
            setError(String(e));
            setIsProcessing(false);
            setConfirmHard(false);
        }
    };

    const handleCommitSelect = (hash: string) => {
        if (mode === "cherrypick") {
            setSelectedCommits((prev) =>
                prev.includes(hash) ? prev.filter((h) => h !== hash) : [...prev, hash]
            );
        } else {
            setTarget(hash);
        }
    };

    const modalConfig: Record<string, { title: string; icon: React.ReactNode; actionLabel: string }> = {
        sync:       { title: t("wtAction.syncFromBase"),   icon: <ArrowClockwise size={18} />,       actionLabel: t("wtAction.update") },
        apply:      { title: t("wtAction.applyToBranch"),  icon: <ArrowSquareIn size={18} />,         actionLabel: t("wtAction.apply") },
        pull:       { title: t("wtAction.pullFromRemote"),  icon: <ArrowClockwise size={18} />,       actionLabel: t("git.pull") },
        cherrypick: { title: t("wtAction.cherryPick"),      icon: <Scissors size={18} />,              actionLabel: t("wtAction.pick") },
        reset:      { title: t("wtAction.reset"),           icon: <ArrowCounterClockwise size={18} />, actionLabel: t("wtAction.doReset") },
    };

    const cfg = modalConfig[mode ?? "sync"];

    const isActionEnabled = (() => {
        if (isProcessing) return false;
        if (mode === "cherrypick") return selectedCommits.length > 0;
        return target.trim().length > 0;
    })();

    const leftPanelLabel = (() => {
        if (mode === "sync")       return t("wtAction.syncSource");
        if (mode === "pull")       return t("wtAction.remoteTarget");
        if (mode === "apply")      return t("wtAction.applyTarget");
        if (mode === "cherrypick") return t("wtAction.cherryPickSource");
        if (mode === "reset")      return t("wtAction.resetTarget");
        return "";
    })();

    return (
        <>
        <BrowserHideGuard />
        <div

            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={(e) => { if (e.target === e.currentTarget) closeActionModal(); }}
        >
            <div
                className="flex flex-col rounded-lg shadow-2xl overflow-hidden"
                style={{
                    width: 800,
                    height: 520,
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
                        <span style={{ color: "var(--text-muted)" }}>{cfg.icon}</span>
                        <span style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: "var(--text-primary)" }}>
                            {cfg.title}
                        </span>
                    </div>
                    <button onClick={closeActionModal} className="cursor-pointer" style={{ color: "var(--text-muted)" }}>
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 flex min-h-0">
                    {/* Left: Commit log */}
                    <div
                        className="flex-1 border-r border-r-[var(--border-default)] overflow-y-auto"
                        style={{ background: "var(--bg-subtle)" }}
                    >
                        <div className="p-3">
                            <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                {leftPanelLabel}
                            </div>
                            {mode === "cherrypick" && selectedCommits.length > 0 && (
                                <div className="flex items-center gap-1.5 mb-2 px-1 py-1 rounded" style={{ background: "var(--bg-overlay)", fontSize: 'var(--fs-10)', color: "var(--accent-blue)" }}>
                                    <Check size={12} weight="bold" />
                                    <span>{t("wt.selectedCount").replace("{n}", String(selectedCommits.length))}</span>
                                </div>
                            )}
                            <GitCommitLog
                                cwd={cwd}
                                onSelect={handleCommitSelect}
                                selectedHash={mode === "cherrypick" ? selectedCommits[selectedCommits.length - 1] ?? "" : target}
                                multiSelected={mode === "cherrypick" ? selectedCommits : undefined}
                            />
                        </div>
                    </div>

                    {/* Right: Options */}
                    <div className="w-[280px] flex flex-col p-4 gap-3 shrink-0 overflow-y-auto">

                        {/* sync: branch/commit input + rebase/merge */}
                        {(mode === "sync" || mode === "pull") && (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <label style={{ fontSize: 'var(--fs-12)', fontWeight: 500, color: "var(--text-secondary)" }}>
                                        {mode === "pull" ? t("wtAction.remoteBranch") : t("wtAction.baseBranch")}
                                    </label>
                                    <input
                                        type="text"
                                        value={target}
                                        onChange={(e) => setTarget(e.target.value)}
                                        className="w-full px-2 py-1.5 rounded outline-none"
                                        style={{ fontSize: 'var(--fs-12)', fontFamily: "monospace", background: "var(--bg-overlay)", color: "var(--text-primary)", border: "1px solid var(--border-default)" }}
                                    />
                                </div>
                                {mode === "sync" && (
                                    <div className="flex flex-col gap-2">
                                        {/* Rebase */}
                                        <label className="flex items-start gap-2 cursor-pointer select-none p-2 rounded" style={{ background: useRebase ? "var(--bg-overlay)" : "transparent", border: `1px solid ${useRebase ? "var(--accent-blue)" : "var(--border-subtle)"}`, transition: "all 150ms" }} onClick={() => setUseRebase(true)}>
                                            <input type="radio" checked={useRebase} onChange={() => setUseRebase(true)} style={{ accentColor: "var(--accent-blue)", marginTop: 2, flexShrink: 0 }} />
                                            <div>
                                                <div style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", fontWeight: 600 }}>{t("wtAction.rebase")}</div>
                                                <div style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>{t("wtAction.rebaseDesc")}</div>
                                            </div>
                                        </label>
                                        {/* Merge */}
                                        <label className="flex items-start gap-2 cursor-pointer select-none p-2 rounded" style={{ background: !useRebase ? "var(--bg-overlay)" : "transparent", border: `1px solid ${!useRebase ? "var(--accent-blue)" : "var(--border-subtle)"}`, transition: "all 150ms" }} onClick={() => setUseRebase(false)}>
                                            <input type="radio" checked={!useRebase} onChange={() => setUseRebase(false)} style={{ accentColor: "var(--accent-blue)", marginTop: 2, flexShrink: 0 }} />
                                            <div>
                                                <div style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", fontWeight: 600 }}>{t("wtAction.merge")}</div>
                                                <div style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>{t("wtAction.mergeDesc")}</div>
                                            </div>
                                        </label>
                                    </div>
                                )}
                            </>
                        )}

                        {/* apply: target branch + merge / squash merge */}
                        {mode === "apply" && (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <label style={{ fontSize: 'var(--fs-12)', fontWeight: 500, color: "var(--text-secondary)" }}>{t("wtAction.targetBranch")}</label>
                                    <input
                                        type="text"
                                        value={target}
                                        onChange={(e) => setTarget(e.target.value)}
                                        className="w-full px-2 py-1.5 rounded outline-none"
                                        style={{ fontSize: 'var(--fs-12)', fontFamily: "monospace", background: "var(--bg-overlay)", color: "var(--text-primary)", border: "1px solid var(--border-default)" }}
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    {/* Merge */}
                                    <label className="flex items-start gap-2 cursor-pointer select-none p-2 rounded" style={{ background: !useSquash ? "var(--bg-overlay)" : "transparent", border: `1px solid ${!useSquash ? "var(--accent-blue)" : "var(--border-subtle)"}`, transition: "all 150ms" }} onClick={() => setUseSquash(false)}>
                                        <input type="radio" checked={!useSquash} onChange={() => setUseSquash(false)} style={{ accentColor: "var(--accent-blue)", marginTop: 2, flexShrink: 0 }} />
                                        <div>
                                            <div style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", fontWeight: 600 }}>{t("wtAction.merge")}</div>
                                            <div style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>{t("wtAction.mergeDesc")}</div>
                                        </div>
                                    </label>
                                    {/* Squash Merge */}
                                    <label className="flex items-start gap-2 cursor-pointer select-none p-2 rounded" style={{ background: useSquash ? "var(--bg-overlay)" : "transparent", border: `1px solid ${useSquash ? "var(--accent-blue)" : "var(--border-subtle)"}`, transition: "all 150ms" }} onClick={() => setUseSquash(true)}>
                                        <input type="radio" checked={useSquash} onChange={() => setUseSquash(true)} style={{ accentColor: "var(--accent-blue)", marginTop: 2, flexShrink: 0 }} />
                                        <div>
                                            <div style={{ fontSize: 'var(--fs-12)', color: "var(--text-primary)", fontWeight: 600 }}>{t("wtAction.squash")}</div>
                                            <div style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>{t("wtAction.squashDesc")}</div>
                                        </div>
                                    </label>
                                </div>
                            </>
                        )}

                        {/* cherry-pick: info */}
                        {mode === "cherrypick" && (
                            <div className="flex flex-col gap-2">
                                <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)", lineHeight: 1.5 }}>{t("wtAction.cherryPickDesc")}</div>
                                {selectedCommits.length > 0 && (
                                    <div className="flex flex-col gap-1">
                                        <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)", fontWeight: 600 }}>{t("wt.selectedCommits").replace("{n}", String(selectedCommits.length))}</div>
                                        <div className="flex flex-col gap-0.5" style={{ maxHeight: 140, overflowY: "auto" }}>
                                            {selectedCommits.map((h) => (
                                                <div key={h} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded" style={{ background: "var(--bg-overlay)", fontSize: 'var(--fs-10)', fontFamily: "monospace", color: "var(--accent-blue)" }}>
                                                    <span>{h.slice(0, 8)}</span>
                                                    <button onClick={() => setSelectedCommits((p) => p.filter((c) => c !== h))} style={{ marginLeft: "auto", color: "var(--text-muted)" }}>
                                                        <X size={10} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* reset: mode selection */}
                        {mode === "reset" && (
                            <div className="flex flex-col gap-2">
                                <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-muted)", lineHeight: 1.5 }}>{t("wtAction.resetDesc")}</div>
                                <div style={{ fontSize: 'var(--fs-12)', fontWeight: 500, color: "var(--text-secondary)" }}>{t("wtAction.resetMode")}</div>
                                {(["soft", "mixed", "hard"] as ResetMode[]).map((m) => {
                                    const label = t(resetLabelKeys[m]);
                                    const desc = t(resetDescKeys[m]);
                                    const isHard = m === "hard";
                                    return (
                                        <label key={m} className="flex items-start gap-2 cursor-pointer select-none p-2 rounded" style={{ background: resetMode === m ? "var(--bg-overlay)" : "transparent", border: `1px solid ${resetMode === m ? (isHard ? "var(--accent-red)" : "var(--accent-blue)") : "var(--border-subtle)"}`, transition: "all 150ms" }} onClick={() => { setResetMode(m); setConfirmHard(false); }}>
                                            <input type="radio" checked={resetMode === m} onChange={() => setResetMode(m)} style={{ accentColor: isHard ? "var(--accent-red)" : "var(--accent-blue)", marginTop: 2, flexShrink: 0 }} />
                                            <div>
                                                <div style={{ fontSize: 'var(--fs-12)', color: isHard ? "var(--accent-red)" : "var(--text-primary)", fontWeight: 600 }}>{label}</div>
                                                <div style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
                                            </div>
                                        </label>
                                    );
                                })}
                            </div>
                        )}

                        {/* Hard reset confirm warning */}
                        {confirmHard && (
                            <div className="p-2 rounded" style={{ background: "color-mix(in srgb, var(--accent-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--accent-red) 30%, transparent)", fontSize: 'var(--fs-11)', color: "var(--accent-red)", lineHeight: 1.4 }}>
                                {t("wtAction.confirmHardReset")}
                            </div>
                        )}

                        {/* Error */}
                        {error && (
                            <div className="p-2 rounded" style={{ background: "color-mix(in srgb, var(--accent-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--accent-red) 20%, transparent)", fontSize: 'var(--fs-11)', color: "var(--accent-red)" }}>
                                {error}
                            </div>
                        )}

                        <div className="flex-1" />

                        {/* Footer buttons */}
                        <div className="flex gap-2 pt-3" style={{ borderTop: "1px solid var(--border-default)" }}>
                            <button
                                onClick={closeActionModal}
                                className="flex-1 py-1.5 rounded"
                                style={{ fontSize: 'var(--fs-12)', color: "var(--text-secondary)", background: "transparent", border: "1px solid var(--border-default)" }}
                            >
                                {t("wtAction.cancel")}
                            </button>
                            <button
                                onClick={handleAction}
                                disabled={!isActionEnabled}
                                className="flex-1 py-1.5 rounded"
                                style={{
                                    fontSize: 'var(--fs-12)',
                                    fontWeight: 600,
                                    color: isActionEnabled ? (confirmHard ? "var(--accent-red)" : "var(--accent-blue)") : "var(--text-muted)",
                                    background: "transparent",
                                    border: `1px solid ${isActionEnabled ? (confirmHard ? "var(--accent-red)" : "var(--accent-blue)") : "var(--border-default)"}`,
                                    opacity: isActionEnabled ? 1 : 0.4,
                                    cursor: isActionEnabled ? "pointer" : "not-allowed",
                                    transition: "all 150ms",
                                }}
                            >
                                {isProcessing ? t("wtAction.processing") : (confirmHard ? "⚠ " + cfg.actionLabel : cfg.actionLabel)}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        </>
    );
}
