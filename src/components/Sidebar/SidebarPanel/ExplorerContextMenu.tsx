import type { ContextMenuState } from "./types";
import { useGitT } from "../../../lib/i18n/git";

interface ExplorerContextMenuProps {
  ctxMenu: ContextMenuState;
  handleOpenInPanel: () => void;
  handleOpenInWindow: () => void;
  handleOpenInDefaultApp: () => void;
  handleOpenInTerminal: () => void;
  handlePastePathToTerminal: () => void;
  handleRevealInFinder: () => void;
  handleCopyPath: () => void;
  handleNewFile: () => void;
  handleNewFolder: () => void;
  handleRename: () => void;
  handleTrash: () => void;
}

export function ExplorerContextMenu({
  ctxMenu,
  handleOpenInPanel,
  handleOpenInWindow,
  handleOpenInDefaultApp,
  handleOpenInTerminal,
  handlePastePathToTerminal,
  handleRevealInFinder,
  handleCopyPath,
  handleNewFile,
  handleNewFolder,
  handleRename,
  handleTrash,
}: ExplorerContextMenuProps) {
  const t = useGitT();

  return (
    <div
      ref={(el) => {
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.bottom > window.innerHeight) {
            el.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
          }
          if (rect.right > window.innerWidth) {
            el.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
          }
        }
      }}
      className="fixed z-[9999] py-1 rounded shadow-lg flex flex-col"
      style={{
        left: ctxMenu.x,
        top: ctxMenu.y,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        minWidth: 240,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* File-only items */}
      {!ctxMenu.isDir && (
        <>
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={handleOpenInPanel}
          >
            {t("explorer.openInPanel")}
          </button>
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={handleOpenInWindow}
          >
            <span>{t("explorer.openInWindow")}</span><span className="sb-ctx-shortcut">Ctrl+Click</span>
          </button>
          <button
            className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
            onClick={handleOpenInDefaultApp}
          >
            {t("explorer.openWithDefaultApp")}
          </button>
        </>
      )}
      {/* Directory-only items */}
      {ctxMenu.isDir && (
        <button
          className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
          onClick={handleOpenInTerminal}
        >
          {t("explorer.openInTerminal")}
        </button>
      )}
      {/* Common items */}
      <button
        className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
        onClick={handlePastePathToTerminal}
      >
        {t("explorer.pastePathToTerminal")}
      </button>
      <div className="my-1" style={{ borderTop: "1px solid var(--border-default)" }} />
      <button
        className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
        onClick={handleRevealInFinder}
      >
        {t("explorer.revealInFileManager")}
      </button>
      <div className="my-1" style={{ borderTop: "1px solid var(--border-default)" }} />
      <button
        className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
        onClick={handleCopyPath}
      >
        {t("explorer.copyPath")}
      </button>
      <div className="my-1" style={{ borderTop: "1px solid var(--border-default)" }} />
      <button
        className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
        onClick={handleNewFile}
      >
        {t("explorer.newFile")}
      </button>
      <button
        className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
        onClick={handleNewFolder}
      >
        {t("explorer.newFolder")}
      </button>
      <button
        className="sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors"
        onClick={handleRename}
      >
        {t("explorer.rename")}
      </button>
      <div className="my-1" style={{ borderTop: "1px solid var(--border-default)" }} />
      <button
        className="w-full text-left hover:bg-[var(--bg-overlay)] transition-colors"
        style={{ fontSize: 'var(--fs-12)', color: "var(--accent-red)", padding: "3px 12px" }}
        onClick={handleTrash}
      >
        {t("explorer.moveToTrash")}
      </button>
    </div>
  );
}
