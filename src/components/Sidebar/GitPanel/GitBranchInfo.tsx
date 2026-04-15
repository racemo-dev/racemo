import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  GitBranch,
  GitCommit,
  Link,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useGitStore } from "../../../stores/gitStore";
import { useGitT } from "../../../lib/i18n/git";
import { runGitStreaming } from "../../../lib/gitStream";
import { IconButton } from "./shared";

export default function GitBranchInfo({ cwd, onOpenHistory }: { cwd: string; onOpenHistory: () => void }) {
  const repoInfo = useGitStore((s) => s.repoInfo);
  const refresh = useGitStore((s) => s.refresh);
  const isLoading = useGitStore((s) => s.isLoading);
  const t = useGitT();
  const [hasRemote, setHasRemote] = useState(true);
  const [showRemoteInput, setShowRemoteInput] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");

  useEffect(() => {
    if (!cwd || !repoInfo) return;
    invoke<string>("git_get_remote_url", { path: cwd })
      .then(() => setHasRemote(true))
      .catch(() => setHasRemote(false));
  }, [cwd, repoInfo]);

  const handleAddRemote = async () => {
    const url = remoteUrl.trim();
    if (!url || !cwd) return;
    if (!/^[a-zA-Z0-9+._:/@-]+$/.test(url)) return;
    setRemoteUrl("");
    setShowRemoteInput(false);
    const ok = await runGitStreaming(
      [
        { cwd, args: ["remote", "add", "origin", url], label: "git remote add" },
        { cwd, args: ["push", "-u", "origin", "HEAD"], label: "git push" },
      ],
      "Add Remote & Push",
    );
    if (ok) await refresh(cwd);
  };

  if (!repoInfo) return null;

  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      <div className="flex items-center gap-1.5 px-2 py-1" style={{ fontSize: 'var(--fs-11)' }}>
        <GitBranch size={14} weight="bold" className="sb-muted" style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))', flexShrink: 0 }} />
        <span className="sb-label truncate">
          {repoInfo.branch}
        </span>
        {(repoInfo.ahead > 0 || repoInfo.behind > 0) && (
          <span className="sb-muted" style={{ fontSize: 'var(--fs-10)' }}>
            {repoInfo.ahead > 0 && `\u2191${repoInfo.ahead}`}
            {repoInfo.behind > 0 && `\u2193${repoInfo.behind}`}
          </span>
        )}
        <span className="flex items-center ml-auto" style={{ flexShrink: 0, gap: 4 }}>
          {!hasRemote && (
            <IconButton onClick={() => setShowRemoteInput((p) => !p)} title={t("git.addRemote")}>
              <Link
                size={13}
                style={{ width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))', color: showRemoteInput ? "var(--text-primary)" : undefined }}
              />
            </IconButton>
          )}
          <IconButton onClick={onOpenHistory} title={t("git.commitLog")}>
            <GitCommit
              size={13}
              style={{ width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))' }}
            />
          </IconButton>
          <IconButton onClick={() => refresh(cwd)} title={t("git.refresh")}>
            <ArrowClockwise
              size={13}
              style={isLoading ? { width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))', animation: "spin 1s linear infinite" } : { width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))' }}
            />
          </IconButton>
        </span>
      </div>
      {showRemoteInput && (
        <div className="px-2 pb-1.5">
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="https://github.com/user/repo.git"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddRemote(); if (e.key === "Escape") setShowRemoteInput(false); }}
              className="flex-1 min-w-0 rounded px-1.5 py-0.5"
              style={{
                fontSize: "var(--fs-10)",
                background: "var(--bg-base)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
                outline: "none",
              }}
              autoFocus
            />
            <button
              onClick={handleAddRemote}
              className="rounded px-1.5 py-0.5 cursor-pointer shrink-0"
              style={{
                fontSize: "var(--fs-10)",
                background: "transparent",
                color: remoteUrl.trim() ? "var(--text-secondary)" : "var(--text-muted)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              {t("git.connect")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
