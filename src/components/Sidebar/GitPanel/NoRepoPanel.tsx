import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CaretRight,
  GitBranch,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useGitStore } from "../../../stores/gitStore";
import { useGitT } from "../../../lib/i18n/git";
import { logger } from "../../../lib/logger";
import { runGitStreaming, runGitSteps, runExecStreaming } from "../../../lib/gitStream";
import { useGitOutputStore } from "../../../stores/gitOutputStore";

export default function NoRepoPanel({ cwd }: { cwd: string | null }) {
  const t = useGitT();
  const [cloneUrl, setCloneUrl] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [repoName, setRepoName] = useState(() => cwd?.split("/").pop() || "");
  const [isPrivate, setIsPrivate] = useState(true);
  const [hostingCli, setHostingCli] = useState<string | null>(null);
  const [remoteRepos, setRemoteRepos] = useState<{ name: string; url: string; is_private: boolean }[]>([]);
  const [showRepoList, setShowRepoList] = useState(false);

  useEffect(() => {
    invoke<string | null>("git_detect_hosting_cli").then((cli) => {
      setHostingCli(cli);
      if (cli) {
        invoke<{ name: string; url: string; is_private: boolean }[]>("git_list_remote_repos", { limit: 30 })
          .then(setRemoteRepos)
          .catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const handleInit = async () => {
    if (!cwd) return;
    try {
      await invoke("git_init", { path: cwd });
      useGitStore.getState().refresh(cwd);
    } catch (e) {
      logger.error("git init failed:", e);
    }
  };

  const handleClone = async () => {
    const url = cloneUrl.trim();
    if (!url || !cwd) return;
    if (!/^[a-zA-Z0-9+._:/@-]+$/.test(url)) return;
    setCloneUrl("");
    setIsCloning(true);
    const ok = await runGitStreaming(
      [{ cwd, args: ["clone", url, "."], label: "git clone" }],
      "Git Clone",
    );
    if (ok) await useGitStore.getState().refresh(cwd);
    setIsCloning(false);
  };

  const handleCreateRepo = async () => {
    if (!cwd) return;
    const name = repoName.trim();
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) return;
    const vis = isPrivate ? "--private" : "--public";
    const store = useGitOutputStore.getState();
    store.open("Create Repository");
    await new Promise<void>((r) => setTimeout(r, 32));
    try {
      // 1. git init + add + commit
      const ok = await runGitSteps([
        { cwd, args: ["init"], label: "git init" },
        { cwd, args: ["add", "-A"], label: "git add" },
        { cwd, args: ["commit", "--allow-empty", "-m", "Initial commit"], label: "git commit" },
      ]);
      if (!ok) { store.setStatus("error"); return; }
      // 2. Create remote repo via gh/glab
      if (hostingCli === "glab") {
        await runExecStreaming("glab", ["repo", "create", name, vis], cwd);
        const ok2 = await runGitSteps([{ cwd, args: ["push", "-u", "origin", "main"], label: "git push" }]);
        store.setStatus(ok2 ? "success" : "error");
      } else {
        await runExecStreaming("gh", ["repo", "create", ...(name ? [name] : []), "--source=.", vis, "--push"], cwd);
        store.setStatus("success");
      }
      await useGitStore.getState().refresh(cwd);
    } catch (e) {
      store.addLine(String(e), true);
      store.setStatus("error");
    }
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--bg-overlay)",
    border: "1px solid var(--border-subtle)",
    borderRadius: 6,
    padding: "12px 12px",
    cursor: "pointer",
    transition: "border-color 150ms",
    textAlign: "left",
  };

  return (
    <div style={{ padding: "12px 8px" }}>
      <div className="flex flex-col gap-3">
        {/* Init */}
        <div style={{ ...cardStyle, cursor: "default" }}>
          <div className="flex items-center gap-1.5" style={{ marginBottom: 6 }}>
            <GitBranch size={14} weight="bold" style={{ color: "var(--accent-blue)", width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))" }} />
            <span style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)", fontWeight: 600 }}>
              {t("git.initRepo")}
            </span>
          </div>
          <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", lineHeight: 1.4, marginBottom: 10 }}>
            {t("git.initRepoDesc")}
          </div>
          <div>
            <button
              onClick={handleInit}
              className="w-full rounded px-2 py-1.5 cursor-pointer"
              style={{
                fontSize: "var(--fs-10)",
                background: "transparent",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-default)",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover, rgba(255,255,255,0.08))"; (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-blue)"; (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)"; (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
            >
              {t("git.initRepo")}
            </button>
          </div>
        </div>
        {/* Clone */}
        <div style={{ ...cardStyle, cursor: "default" }}>
          <div className="flex items-center gap-1.5" style={{ marginBottom: 6 }}>
            <ArrowDown size={14} weight="bold" style={{ color: "var(--accent-green)", width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))" }} />
            <span style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)", fontWeight: 600 }}>
              {t("git.clone")}
            </span>
          </div>
          <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", lineHeight: 1.4, marginBottom: 10 }}>
            {t("git.cloneDesc")}
          </div>
          <input
            type="text"
            placeholder={t("git.clonePlaceholder")}
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleClone(); }}
            className="w-full rounded px-2 py-1"
            style={{
              fontSize: "var(--fs-10)",
              background: "var(--bg-base)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              outline: "none",
              marginBottom: 6,
            }}
          />
          {remoteRepos.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div
                className="flex items-center gap-1 cursor-pointer"
                onClick={() => setShowRepoList((p) => !p)}
                style={{ fontSize: "var(--fs-10)", color: "var(--accent-green)" }}
              >
                <CaretRight
                  size={10}
                  weight="bold"
                  style={{
                    transform: showRepoList ? "rotate(90deg)" : "none",
                    transition: "transform 150ms",
                    width: "calc(10px * var(--ui-scale))",
                    height: "calc(10px * var(--ui-scale))",
                  }}
                />
                <span>{t("git.myRepos")} ({remoteRepos.length})</span>
              </div>
              {showRepoList && (
                <div
                  style={{
                    marginTop: 4,
                    maxHeight: 120,
                    overflowY: "auto",
                    borderRadius: 4,
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-base)",
                  }}
                >
                  {remoteRepos.map((repo) => (
                    <div
                      key={repo.url}
                      className="flex items-center justify-between px-2 py-1 cursor-pointer"
                      style={{ fontSize: "var(--fs-10)", color: "var(--text-secondary)" }}
                      onClick={() => { setCloneUrl(repo.url); setShowRepoList(false); }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {repo.name}
                      </span>
                      {repo.is_private && (
                        <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", flexShrink: 0, marginLeft: 4 }}>
                          private
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => { if (cloneUrl.trim() && !isCloning) handleClone(); }}
            className="w-full rounded px-2 py-1.5 cursor-pointer"
            style={{
              fontSize: "var(--fs-10)",
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
              opacity: cloneUrl.trim() && !isCloning ? 1 : 0.4,
            }}
            onMouseEnter={(e) => { if (cloneUrl.trim() && !isCloning) { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover, rgba(255,255,255,0.08))"; (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-green)"; (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; } }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)"; (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
          >
            {isCloning ? t("git.cloning") : t("git.clone")}
          </button>
        </div>
        {/* Create Remote Repo — only shown when gh/glab CLI is installed */}
        {hostingCli && (
        <div style={{ ...cardStyle, cursor: "default" }}>
          <div className="flex items-center gap-1.5" style={{ marginBottom: 6 }}>
            <ArrowUp size={14} weight="bold" style={{ color: "var(--accent-yellow)", width: "calc(14px * var(--ui-scale))", height: "calc(14px * var(--ui-scale))" }} />
            <span style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)", fontWeight: 600 }}>
              {hostingCli === "glab" ? t("git.createRepoGitlab") : t("git.createRepo")}
            </span>
          </div>
          <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", lineHeight: 1.4, marginBottom: 10 }}>
            {hostingCli === "glab" ? t("git.createRepoDescGitlab") : t("git.createRepoDesc")}
          </div>
          <div className="flex flex-col gap-1.5">
            <input
              type="text"
              placeholder={t("git.repoNamePlaceholder")}
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && repoName.trim()) handleCreateRepo(); }}
              className="w-full rounded px-2 py-1"
              style={{
                fontSize: "var(--fs-10)",
                background: "var(--bg-base)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
                outline: "none",
              }}
            />
            <div
              className="flex items-center gap-1 cursor-pointer"
              onClick={() => setIsPrivate((p) => !p)}
              style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", marginBottom: 6 }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  border: "1px solid var(--border-subtle)",
                  background: isPrivate ? "var(--accent-yellow)" : "transparent",
                }}
              />
              <span>{isPrivate ? "Private" : "Public"}</span>
            </div>
            <div>
              <button
                onClick={handleCreateRepo}
                disabled={!repoName.trim()}
                className="w-full rounded px-2 py-1.5 cursor-pointer"
                style={{
                  fontSize: "var(--fs-10)",
                  background: "transparent",
                  color: repoName.trim() ? "var(--text-secondary)" : "var(--text-muted)",
                  border: "1px solid var(--border-default)",
                }}
                onMouseEnter={(e) => { if (repoName.trim()) { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover, rgba(255,255,255,0.08))"; (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-yellow)"; (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; } }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)"; (e.currentTarget as HTMLElement).style.color = repoName.trim() ? "var(--text-secondary)" : "var(--text-muted)"; }}
              >
                {t("git.createRepo")}
              </button>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
