import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useWorktreeStore } from "../../../stores/worktreeStore";
import { useDialogStore } from "../../../stores/dialogStore";
import { parseGitHubUrl } from "./constants";
import { logger } from "../../../lib/logger";
import type { GitCommitDetail } from "../../../types/git";

interface UseCommitActionsParams {
    cwd: string;
    loadCommitLog: (cwd: string) => void;
    onOpenChanges?: (hash: string) => void;
    onOpenDiff?: (diff: string) => void;
    closeMenu: () => void;
    setInputPrompt: (prompt: { type: "branch" | "tag"; hash: string } | null) => void;
    setCompareSource: (hash: string | null) => void;
}

export function useCommitActions({
    cwd,
    loadCommitLog,
    onOpenChanges,
    onOpenDiff,
    closeMenu,
    setInputPrompt,
    setCompareSource,
}: UseCommitActionsParams) {
    const handleOpenChanges = useCallback(
        (hash: string) => {
            closeMenu();
            onOpenChanges?.(hash);
        },
        [closeMenu, onOpenChanges],
    );

    const handleOpenOnGitHub = useCallback(
        async (hash: string) => {
            closeMenu();
            try {
                const url = await invoke<string>("git_get_remote_url", { path: cwd });
                const ghUrl = parseGitHubUrl(url.trim());
                if (ghUrl) {
                    invoke("open_in_default_app", { path: `${ghUrl}/commit/${hash}` }).catch(logger.error);
                }
            } catch (e) {
                logger.error("Failed to get remote URL:", e);
            }
        },
        [closeMenu, cwd],
    );

    const handleNewWorktree = useCallback(
        (hash: string) => {
            closeMenu();
            useWorktreeStore.getState().openAddModal(cwd, hash);
        },
        [closeMenu, cwd],
    );

    const handleCheckout = useCallback(
        (hash: string, detached: boolean) => {
            closeMenu();
            const label = detached ? "Detached checkout" : "Checkout";
            useDialogStore.getState().show({
                title: label,
                message: `${label} to commit ${hash}?`,
                type: "warning",
                confirmLabel: label,
                cancelLabel: "Cancel",
                onConfirm: () => {
                    invoke("git_checkout_commit", { path: cwd, hash, detached })
                        .then(() => loadCommitLog(cwd))
                        .catch((e) =>
                            useDialogStore.getState().show({ title: "Error", message: String(e), type: "error" }),
                        );
                },
            });
        },
        [closeMenu, cwd, loadCommitLog],
    );

    const handleCreateBranch = useCallback(
        (hash: string) => {
            closeMenu();
            setInputPrompt({ type: "branch", hash });
        },
        [closeMenu, setInputPrompt],
    );

    const handleCreateTag = useCallback(
        (hash: string) => {
            closeMenu();
            setInputPrompt({ type: "tag", hash });
        },
        [closeMenu, setInputPrompt],
    );

    const handleCherryPick = useCallback(
        (hash: string) => {
            closeMenu();
            useDialogStore.getState().show({
                title: "Cherry Pick",
                message: `Cherry-pick commit ${hash}?`,
                type: "warning",
                confirmLabel: "Cherry Pick",
                cancelLabel: "Cancel",
                onConfirm: () => {
                    invoke("git_cherry_pick", { path: cwd, hash })
                        .then(() => loadCommitLog(cwd))
                        .catch((e) =>
                            useDialogStore.getState().show({ title: "Error", message: String(e), type: "error" }),
                        );
                },
            });
        },
        [closeMenu, cwd, loadCommitLog],
    );

    const handleRevert = useCallback(
        (hash: string) => {
            closeMenu();
            useDialogStore.getState().show({
                title: "Revert Commit",
                message: `Revert commit ${hash}? This will create a new commit that undoes the changes.`,
                type: "warning",
                confirmLabel: "Revert",
                cancelLabel: "Cancel",
                onConfirm: () => {
                    invoke("git_revert_commit", { path: cwd, hash })
                        .then(() => loadCommitLog(cwd))
                        .catch((e) =>
                            useDialogStore.getState().show({ title: "Error", message: String(e), type: "error" }),
                        );
                },
            });
        },
        [closeMenu, cwd, loadCommitLog],
    );

    const handleCompareWithRemote = useCallback(
        async (hash: string) => {
            closeMenu();
            try {
                const diff = await invoke<string>("git_diff_commits", {
                    path: cwd,
                    hash1: "origin/HEAD",
                    hash2: hash,
                });
                onOpenDiff?.(diff);
            } catch (e) {
                useDialogStore.getState().show({ title: "Error", message: String(e), type: "error" });
            }
        },
        [closeMenu, cwd, onOpenDiff],
    );

    const handleCompareWithMergeBase = useCallback(
        async (hash: string) => {
            closeMenu();
            try {
                const base = await invoke<string>("git_merge_base", { path: cwd, hash1: "HEAD", hash2: hash });
                const diff = await invoke<string>("git_diff_commits", {
                    path: cwd,
                    hash1: base.trim(),
                    hash2: hash,
                });
                onOpenDiff?.(diff);
            } catch (e) {
                useDialogStore.getState().show({ title: "Error", message: String(e), type: "error" });
            }
        },
        [closeMenu, cwd, onOpenDiff],
    );

    const handleCompareWith = useCallback(
        (hash: string) => {
            closeMenu();
            setCompareSource(hash);
        },
        [closeMenu, setCompareSource],
    );

    const handleCopyCommitId = useCallback(
        async (hash: string) => {
            closeMenu();
            try {
                const detail = await invoke<GitCommitDetail>("git_commit_detail", { path: cwd, hash });
                await writeText(detail.fullHash);
            } catch (e) {
                logger.error("Failed to copy commit ID:", e);
            }
        },
        [closeMenu, cwd],
    );

    const handleCopyMessage = useCallback(
        async (message: string) => {
            closeMenu();
            await writeText(message).catch(logger.error);
        },
        [closeMenu],
    );

    const handleCopyPatch = useCallback(
        async (hash: string) => {
            closeMenu();
            try {
                const patch = await invoke<string>("git_show_commit_patch", { path: cwd, hash });
                await writeText(patch);
            } catch (e) {
                logger.error("Failed to copy patch:", e);
            }
        },
        [closeMenu, cwd],
    );

    return {
        handleOpenChanges,
        handleOpenOnGitHub,
        handleNewWorktree,
        handleCheckout,
        handleCreateBranch,
        handleCreateTag,
        handleCherryPick,
        handleRevert,
        handleCompareWithRemote,
        handleCompareWithMergeBase,
        handleCompareWith,
        handleCopyCommitId,
        handleCopyMessage,
        handleCopyPatch,
    };
}
