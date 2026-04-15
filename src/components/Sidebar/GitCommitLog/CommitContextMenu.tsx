import type { GitCommitEntry } from "../../../types/git";
import { menuBtnClass, menuSep } from "./constants";

interface CommitContextMenuProps {
    contextMenu: { x: number; y: number; commit: GitCommitEntry };
    onOpenChanges?: (hash: string) => void;
    actions: {
        handleOpenChanges: (hash: string) => void;
        handleOpenOnGitHub: (hash: string) => void;
        handleNewWorktree: (hash: string) => void;
        handleCheckout: (hash: string, detached: boolean) => void;
        handleCreateBranch: (hash: string) => void;
        handleCreateTag: (hash: string) => void;
        handleCherryPick: (hash: string) => void;
        handleRevert: (hash: string) => void;
        handleCompareWithRemote: (hash: string) => void;
        handleCompareWithMergeBase: (hash: string) => void;
        handleCompareWith: (hash: string) => void;
        handleCopyCommitId: (hash: string) => void;
        handleCopyMessage: (message: string) => void;
        handleCopyPatch: (hash: string) => void;
    };
}

export function CommitContextMenu({ contextMenu, onOpenChanges, actions }: CommitContextMenuProps) {
    const { commit } = contextMenu;

    return (
        <div
            className="fixed z-[9999] py-1 rounded shadow-lg flex flex-col"
            style={{
                left: contextMenu.x,
                top: contextMenu.y,
                minWidth: 240,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
            }}
        >
            {onOpenChanges && (
                <button className={menuBtnClass} onClick={() => actions.handleOpenChanges(commit.hash)}>
                    Open Changes
                </button>
            )}
            <button className={menuBtnClass} onClick={() => actions.handleOpenOnGitHub(commit.hash)}>
                Open on GitHub
            </button>

            {menuSep}

            <button className={menuBtnClass} onClick={() => actions.handleNewWorktree(commit.hash)}>
                Create Worktree Here...
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleCheckout(commit.hash, false)}>
                Checkout Here
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleCheckout(commit.hash, true)}>
                Checkout (Detached)
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleCreateBranch(commit.hash)}>
                Create Branch...
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleCreateTag(commit.hash)}>
                Create Tag...
            </button>

            {menuSep}

            <button className={menuBtnClass} onClick={() => actions.handleCherryPick(commit.hash)}>
                Cherry Pick
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleRevert(commit.hash)}>
                Revert Commit
            </button>

            {menuSep}

            <button className={menuBtnClass} onClick={() => actions.handleCompareWithRemote(commit.hash)}>
                Compare with Remote
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleCompareWithMergeBase(commit.hash)}>
                Compare with Merge Base
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleCompareWith(commit.hash)}>
                Compare with...
            </button>

            {menuSep}

            <button className={menuBtnClass} onClick={() => actions.handleCopyCommitId(commit.hash)}>
                Copy Commit ID
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleCopyMessage(commit.message)}>
                Copy Commit Message
            </button>
            <button className={menuBtnClass} onClick={() => actions.handleCopyPatch(commit.hash)}>
                Copy Patch
            </button>
        </div>
    );
}
