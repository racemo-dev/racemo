import { useState } from "react";
import {
  ArrowUp,
  ArrowDown,
  Sparkle,
  Lightning,
  X,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useGitStore } from "../../../stores/gitStore";
import { useGitT } from "../../../lib/i18n/git";
import { loadPromptAndBuildCommand } from "../../../lib/prompts";
import { runGitStreaming } from "../../../lib/gitStream";
import { useGitOutputStore } from "../../../stores/gitOutputStore";
import { safeOpenUrl } from "../../../lib/osUtils";
import { PushTooltip } from "./shared";
import { useAiCommit } from "./useAiCommit";
import type { GitStatusEntry } from "../../../types/git";

interface CommitFormProps {
  cwd: string;
  staged: GitStatusEntry[];
  allChanges: GitStatusEntry[];
  hasChanges: boolean;
  ahead: number;
  behind: number;
  unpushedCommits: string[];
  commitMsg: string;
  setCommitMsg: (msg: string) => void;
  onCommitSuccess: () => void;
}

export default function CommitForm({
  cwd,
  staged,
  allChanges,
  hasChanges,
  ahead,
  behind,
  unpushedCommits,
  commitMsg,
  setCommitMsg,
  onCommitSuccess,
}: CommitFormProps) {
  const t = useGitT();
  const repoInfo = useGitStore((s) => s.repoInfo);
  const { push, pull, setPullConflict } = useGitStore.getState();

  const [commitError, setCommitError] = useState("");
  const [isPushing, setIsPushing] = useState(false);
  const [pushTooltip, setPushTooltip] = useState<{ x: number; y: number } | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [pullError, setPullError] = useState("");

  const [showPrForm, setShowPrForm] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("main");
  const [isCreatingPr, setIsCreatingPr] = useState(false);
  const [prResult, setPrResult] = useState<string | null>(null);
  const [prError, setPrError] = useState("");
  const [isGeneratingPr, setIsGeneratingPr] = useState(false);

  const { isGenerating, generateCommitMsg, handleAutoCommit } = useAiCommit({
    cwd,
    hasChanges,
    setCommitMsg,
  });

  const canCommit = hasChanges && commitMsg.trim().length > 0;

  const handlePull = async () => {
    setIsPulling(true);
    setPullError("");
    try {
      await pull(cwd);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("would be overwritten")) {
        const files = msg
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("error") && !l.startsWith("Please") && !l.startsWith("Aborting") && !l.startsWith("Updating"));
        if (files.length > 0) {
          setPullConflict(cwd, files);
        } else {
          setPullError(msg);
        }
      } else {
        setPullError(msg);
      }
    } finally {
      setIsPulling(false);
    }
  };

  const handlePush = async () => {
    setIsPushing(true);
    try {
      await push(cwd);
      const branch = repoInfo?.branch ?? "";
      if (branch && branch !== "main" && branch !== "master") {
        try {
          const existingPr = await invoke<string | null>("git_pr_status", { path: cwd });
          if (existingPr) {
            setPrResult(existingPr);
          } else {
            const base = await invoke<string>("git_default_branch", { path: cwd });
            setPrBase(base);
            setShowPrForm(true);
          }
        } catch { /* gh CLI 없을 수 있음, 무시 */ }
      }
    } catch (e) {
      const msg = String(e);
      const isAuthError = msg.includes("Authentication failed") || msg.includes("Invalid username or token") || msg.includes("Password authentication is not supported") || msg.includes("terminal prompts disabled") || msg.includes("could not read Username");
      const { useDialogStore } = await import("../../../stores/dialogStore");
      useDialogStore.getState().show({
        title: isAuthError ? t("git.authErrorTitle") : t("git.pushFailed"),
        message: isAuthError ? t("git.authError") : msg,
        type: "error",
        confirmLabel: t("git.confirm"),
      });
    } finally {
      setIsPushing(false);
    }
  };

  const handleCreatePr = async () => {
    if (!prTitle.trim() || isCreatingPr) return;
    setIsCreatingPr(true);
    setPrError("");
    try {
      const url = await invoke<string>("git_create_pr", {
        path: cwd,
        title: prTitle.trim(),
        body: prBody.trim(),
        base: prBase,
      });
      setPrResult(url);
      setShowPrForm(false);
      setPrTitle("");
      setPrBody("");
    } catch (e) {
      setPrError(String(e));
    } finally {
      setIsCreatingPr(false);
    }
  };

  const handleGeneratePrContent = async () => {
    if (isGeneratingPr) return;
    setIsGeneratingPr(true);
    try {
      const { command, args } = await loadPromptAndBuildCommand("pr", {
        branch: repoInfo?.branch,
        base: prBase,
      });
      const output = await invoke<string>("run_ai_command", { command, args, cwd });
      if (output?.trim()) {
        const titleMatch = output.match(/TITLE:\s*(.+)/i);
        const bodyMatch = output.match(/BODY:\s*([\s\S]+)/i);
        if (titleMatch) setPrTitle(titleMatch[1].trim());
        if (bodyMatch) setPrBody(bodyMatch[1].trim());
      }
    } catch (e) {
      setPrError(String(e));
    } finally {
      setIsGeneratingPr(false);
    }
  };

  const handleCommit = async () => {
    if (!canCommit) return;
    setCommitError("");

    const msg = commitMsg.trim();
    const steps = [];

    if (staged.length === 0) {
      steps.push({ cwd, args: ["add", "-A"], label: "stage all" });
    }
    steps.push({ cwd, args: ["commit", "-m", msg], label: "commit" });

    const ok = await runGitStreaming(steps, `${t("git.commitLabel")}: ${msg.slice(0, 50)}`, () => {
      useGitStore.getState().refresh(cwd);
    });

    if (ok) {
      setCommitMsg("");
      invoke("save_discard_cache", { path: cwd, data: "{}" }).catch(() => {});
      onCommitSuccess();
    } else {
      const lines = useGitOutputStore.getState().lines;
      const isIdentError = lines.some((l) =>
        l.line.includes("empty ident") || l.line.includes("Please tell me who you are")
      );
      if (isIdentError) setCommitError(t("git.identError"));
    }
  };

  return (
    <div className="px-2 pt-1 pb-1">
      <div className="flex items-center gap-1">
        <input
          type="text"
          placeholder={t("git.commitMsg")}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCommit) handleCommit();
          }}
          className="flex-1 min-w-0 px-1.5 py-1 rounded"
          style={{
            fontSize: 'var(--fs-11)',
            background: "var(--bg-overlay)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-subtle)",
            outline: "none",
          }}
        />
        <div className="flex items-center shrink-0">
          <button
            onClick={handleAutoCommit}
            disabled={!hasChanges}
            className="shrink-0 flex items-center justify-center rounded"
            style={{
              width: 22,
              height: 22,
              background: "transparent",
              border: "none",
              color: hasChanges ? "var(--text-muted)" : "var(--text-disabled, var(--text-tertiary))",
              transition: "all 150ms",
              cursor: hasChanges ? "pointer" : "not-allowed",
              opacity: hasChanges ? 1 : 0.35,
            }}
            onMouseEnter={(e) => { if (hasChanges) (e.currentTarget as HTMLElement).style.color = "var(--accent-green)"; }}
            onMouseLeave={(e) => { if (hasChanges) (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
            title={t("git.autoCommit")}
          >
            <Lightning
              size={13}
              weight="bold"
              style={{ width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))' }}
            />
          </button>
          <button
            onClick={generateCommitMsg}
            disabled={!hasChanges || isGenerating}
            className="shrink-0 flex items-center justify-center rounded"
            style={{
              width: 22,
              height: 22,
              background: "transparent",
              border: "none",
              color: isGenerating ? "var(--accent-yellow)" : "var(--text-muted)",
              opacity: !hasChanges ? 0.3 : 1,
              transition: "all 150ms",
              cursor: isGenerating ? "wait" : hasChanges ? "pointer" : "default",
            }}
            onMouseEnter={(e) => {
              if (hasChanges && !isGenerating) (e.currentTarget as HTMLElement).style.color = "var(--accent-yellow)";
            }}
            onMouseLeave={(e) => {
              if (!isGenerating) (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
            }}
            title={isGenerating ? t("git.generating") : t("git.generateCommitMsg")}
          >
            <Sparkle
              size={13}
              weight={isGenerating ? "fill" : "bold"}
              className={isGenerating ? "animate-spin" : ""}
              style={{ width: 'calc(13px * var(--ui-scale))', height: 'calc(13px * var(--ui-scale))' }}
            />
          </button>
        </div>
      </div>
      <button
        onClick={handleCommit}
        disabled={!canCommit}
        className="w-full mt-1 py-0.5 rounded cursor-pointer transition-colors"
        style={{
          fontSize: 'var(--fs-10)',
          fontWeight: 600,
          letterSpacing: "0.03em",
          color: canCommit ? "var(--accent-blue)" : "var(--text-muted)",
          background: "transparent",
          border: canCommit ? "1px solid var(--accent-blue)" : "1px solid var(--border-subtle)",
          opacity: canCommit ? 1 : 0.5,
        }}
      >
        Commit{staged.length > 0 ? ` (${staged.length} staged)` : hasChanges ? ` (${allChanges.length} files)` : ""}
      </button>
      {commitError && (
        <div style={{ fontSize: 'var(--fs-10)', color: "var(--accent-red)", marginTop: 2 }}>
          {commitError}
        </div>
      )}
      {ahead > 0 && (
        <div className="mt-1">
          <button
            onClick={handlePush}
            disabled={isPushing}
            onMouseEnter={(e) => unpushedCommits.length > 0 && setPushTooltip({ x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => pushTooltip && setPushTooltip({ x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setPushTooltip(null)}
            className="w-full py-0.5 cursor-pointer transition-colors flex items-center justify-center gap-1"
            style={{
              fontSize: 'var(--fs-10)',
              fontWeight: 600,
              letterSpacing: "0.03em",
              color: "var(--text-secondary)",
              background: "transparent",
              border: "1px solid var(--border-default)",
              opacity: isPushing ? 0.6 : 1,
            }}
          >
            <ArrowUp size={11} weight="bold" style={{ width: 'calc(11px * var(--ui-scale))', height: 'calc(11px * var(--ui-scale))' }} />
            {isPushing ? t("git.pushing") : `${t("git.push")} (${ahead})`}
          </button>
          {pushTooltip && unpushedCommits.length > 0 && (
            <PushTooltip x={pushTooltip.x} y={pushTooltip.y} commits={unpushedCommits} />
          )}
        </div>
      )}
      {behind > 0 && (
        <button
          onClick={handlePull}
          disabled={isPulling}
          className="w-full mt-1 py-0.5 rounded cursor-pointer transition-colors flex items-center justify-center gap-1"
          style={{
            fontSize: 'var(--fs-10)',
            fontWeight: 600,
            letterSpacing: "0.03em",
            color: "var(--text-secondary)",
            background: "transparent",
            border: "1px solid var(--border-default)",
            opacity: isPulling ? 0.6 : 1,
          }}
        >
          <ArrowDown size={11} weight="bold" style={{ width: 'calc(11px * var(--ui-scale))', height: 'calc(11px * var(--ui-scale))' }} />
          {isPulling ? t("git.pulling") : `${t("git.pull")} (${behind})`}
        </button>
      )}
      {pullError && (
        <div style={{ fontSize: 'var(--fs-10)', color: "var(--accent-red)", marginTop: 2 }}>
          {pullError}
        </div>
      )}

      {/* PR created result */}
      {prResult && (
        <div
          className="mt-1 flex items-center gap-1 rounded px-2 py-1"
          style={{
            fontSize: 'var(--fs-10)',
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <span style={{ color: "var(--status-active)" }}>{t("git.prCreated")}</span>
          <button
            onClick={() => { if (prResult) safeOpenUrl(prResult); }}
            className="cursor-pointer"
            style={{ color: "var(--accent-blue)", fontSize: 'var(--fs-10)', textDecoration: "underline" }}
          >
            {t("git.viewPr")}
          </button>
          <button
            onClick={() => setPrResult(null)}
            className="ml-auto cursor-pointer"
            style={{ color: "var(--text-muted)", lineHeight: 0 }}
          >
            <X size={10} style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }} />
          </button>
        </div>
      )}

      {/* PR creation form */}
      {showPrForm && (
        <div
          className="mt-1 rounded overflow-hidden"
          style={{
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-surface)",
          }}
        >
          <div
            className="flex items-center justify-between px-2 py-1"
            style={{
              fontSize: 'var(--fs-10)',
              color: "var(--text-muted)",
              borderBottom: "1px solid var(--border-subtle)",
              background: "var(--bg-overlay)",
            }}
          >
            <span>{t("git.createPr")}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleGeneratePrContent}
                disabled={isGeneratingPr}
                className="cursor-pointer"
                style={{ color: isGeneratingPr ? "var(--accent-yellow)" : "var(--text-muted)", fontSize: 'var(--fs-10)' }}
                onMouseEnter={(e) => { if (!isGeneratingPr) (e.currentTarget as HTMLElement).style.color = "var(--accent-yellow)"; }}
                onMouseLeave={(e) => { if (!isGeneratingPr) (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
                title={t("git.generatePr")}
              >
                <Sparkle size={11} weight={isGeneratingPr ? "fill" : "bold"} className={isGeneratingPr ? "animate-spin" : ""} style={{ width: 'calc(11px * var(--ui-scale))', height: 'calc(11px * var(--ui-scale))' }} />
              </button>
              <button
                onClick={() => setShowPrForm(false)}
                className="cursor-pointer"
                style={{ color: "var(--text-muted)", lineHeight: 0 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
              >
                <X size={10} style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }} />
              </button>
            </div>
          </div>
          <div className="px-2 py-1.5 flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)", width: 30, flexShrink: 0 }}>{t("git.prBase")}</span>
              <input
                type="text"
                value={prBase}
                onChange={(e) => setPrBase(e.target.value)}
                className="flex-1 px-1.5 py-0.5 rounded outline-none"
                style={{ fontSize: 'var(--fs-10)', background: "var(--bg-overlay)", color: "var(--text-primary)", border: "1px solid var(--border-subtle)" }}
              />
            </div>
            <input
              type="text"
              placeholder={t("git.prTitle")}
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && prTitle.trim()) handleCreatePr(); }}
              className="w-full px-1.5 py-0.5 rounded outline-none"
              style={{ fontSize: 'var(--fs-10)', background: "var(--bg-overlay)", color: "var(--text-primary)", border: "1px solid var(--border-subtle)" }}
            />
            <textarea
              placeholder={t("git.prBody")}
              value={prBody}
              onChange={(e) => setPrBody(e.target.value)}
              rows={4}
              className="w-full px-1.5 py-0.5 rounded outline-none resize-none"
              style={{ fontSize: 'var(--fs-10)', background: "var(--bg-overlay)", color: "var(--text-primary)", border: "1px solid var(--border-subtle)", lineHeight: 1.5 }}
            />
            <button
              onClick={handleCreatePr}
              disabled={!prTitle.trim() || isCreatingPr}
              className="w-full py-0.5 rounded cursor-pointer transition-colors"
              style={{
                fontSize: 'var(--fs-10)',
                fontWeight: 600,
                color: prTitle.trim() ? "var(--accent-blue)" : "var(--text-muted)",
                background: "transparent",
                border: prTitle.trim() ? "1px solid var(--accent-blue)" : "1px solid var(--border-subtle)",
                opacity: isCreatingPr ? 0.6 : 1,
              }}
            >
              {isCreatingPr ? t("git.creatingPr") : t("git.createPr")}
            </button>
            {prError && (
              <div style={{ fontSize: 'var(--fs-10)', color: "var(--accent-red)" }}>{prError}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
