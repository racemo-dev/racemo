import { useState } from "react";
import { useGitStore } from "../../../stores/gitStore";
import { useGitT } from "../../../lib/i18n/git";
import { loadPrompt, buildAiCommand } from "../../../lib/prompts";
import { runClaudeStreaming, DisplayedError } from "../../../lib/gitStream";
import { useAiHistoryStore, type AiTaskType } from "../../../stores/aiHistoryStore";

interface UseAiCommitOptions {
  cwd: string;
  hasChanges: boolean;
  setCommitMsg: (msg: string) => void;
}

export function useAiCommit({ cwd, hasChanges, setCommitMsg }: UseAiCommitOptions) {
  const t = useGitT();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAutoCommitting, setIsAutoCommitting] = useState(false);

  const addAiHistory = (type: AiTaskType, status: "running" | "success" | "error", summary: string, output: string) => {
    const { command: cmd } = buildAiCommand("");
    return useAiHistoryStore.getState().add({ type, status, command: cmd, summary, output });
  };

  const generateCommitMsg = async () => {
    if (!hasChanges) return;
    setIsGenerating(true);

    const { useGitOutputStore: gitOutputStore } = await import("../../../stores/gitOutputStore");
    const store = gitOutputStore.getState();
    store.open(t("git.generateCommitMsg"), () => setIsGenerating(false), "ai-commit");
    await new Promise<void>((r) => setTimeout(r, 32));

    const historyId = addAiHistory("commit", "running", t("git.generateCommitMsg"), "");

    let prompt: string | undefined;
    try {
      prompt = await loadPrompt("commit") ?? undefined;
      if (!prompt) throw new Error("No commit prompt available");
      store.setPrompt(prompt);
      const output = await runClaudeStreaming(prompt, cwd);

      if (output && output.trim()) {
        const lines = output.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        const clean = (s: string) => s.replace(/^[`"']+|[`"']+$/g, "");
        const prefixes = ["feat:", "fix:", "refactor:", "chore:", "docs:", "test:", "style:", "perf:", "feat(", "fix(", "refactor(", "chore(", "docs(", "test(", "style(", "perf("];
        const commitLine = lines.find((l) => prefixes.some((p) => clean(l).toLowerCase().startsWith(p)));

        if (commitLine) {
          setCommitMsg(clean(commitLine));
          store.setStatus("success");
          useAiHistoryStore.getState().update(historyId, { status: "success", summary: clean(commitLine), output: output.slice(0, 500) });
        } else {
          const firstLine = lines[0]?.substring(0, 80) || "";
          store.setStatus("error");
          useAiHistoryStore.getState().update(historyId, { status: "error", summary: t("git.invalidResponse"), output: firstLine, prompt });
        }
      } else {
        store.setStatus("error");
        useAiHistoryStore.getState().update(historyId, { status: "error", summary: t("git.aiEmpty"), prompt });
      }
    } catch (e: unknown) {
      if (!(e instanceof DisplayedError)) store.addLine(String(e), true);
      store.setStatus("error");
      useAiHistoryStore.getState().update(historyId, { status: "error", output: String(e), prompt });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAutoCommit = async () => {
    if (!hasChanges || isAutoCommitting || isGenerating) return;
    setIsAutoCommitting(true);

    const { useGitOutputStore: gitOutputStore } = await import("../../../stores/gitOutputStore");
    const { runClaudeStreaming: runClaude, runGitSteps: runSteps } = await import("../../../lib/gitStream");
    const outputStore = gitOutputStore.getState();

    outputStore.open(t("git.autoCommit"), () => { setIsAutoCommitting(false); useGitStore.getState().refresh(cwd); }, "ai-commit");
    await new Promise<void>((r) => setTimeout(r, 32));

    const historyId = addAiHistory("auto-commit", "running", t("git.autoCommit"), "");

    let prompt: string | undefined;
    try {
      prompt = await loadPrompt("auto-commit") ?? undefined;
      if (!prompt) throw new Error("No auto-commit prompt available");
      outputStore.setPrompt(prompt);

      const onToolUse = (name: string, input: Record<string, unknown>) => {
        let cmd = name;
        if (name === "Bash" && typeof input.command === "string") {
          cmd = String(input.command).slice(0, 120);
        } else if ((name === "Read" || name === "Write" || name === "Edit") && typeof input.file_path === "string") {
          cmd = `${name.toLowerCase()} ${String(input.file_path)}`;
        } else if (name === "Glob" && typeof input.pattern === "string") {
          cmd = `glob "${String(input.pattern)}"`;
        } else if (name === "Grep" && typeof input.pattern === "string") {
          cmd = `grep "${String(input.pattern)}"`;
        } else if (name === "Task" && typeof input.prompt === "string") {
          cmd = `task: ${String(input.prompt).slice(0, 60)}`;
        } else if (typeof input.description === "string") {
          cmd = `${name}: ${String(input.description).slice(0, 80)}`;
        }
        outputStore.addToolEntry({ name, cmd });
      };

      let output: string;
      try {
        output = await runClaude(prompt, cwd, true, true, onToolUse);
      } catch (e: unknown) {
        if (!(e instanceof DisplayedError)) outputStore.addLine(String(e), true);
        outputStore.setStatus("error");
        useAiHistoryStore.getState().update(historyId, { status: "error", output: String(e), prompt });
        return;
      }

      if (!output?.trim()) {
        outputStore.addLine(t("git.aiNoResponse"), true);
        outputStore.setStatus("error");
        useAiHistoryStore.getState().update(historyId, { status: "error", summary: t("git.aiEmpty"), prompt });
        return;
      }

      // Parse response
      outputStore.setStatus("running");
      const clean = (s: string) => s.replace(/^[`"']+|[`"']+$/g, "").trim();
      const blocks = output.split(/---COMMIT---/).filter((b) => b.trim());
      const commitPlan: { files: string[]; msg: string }[] = [];

      for (const block of blocks) {
        const filesMatch = block.match(/FILES:\s*(.+)/i);
        const msgMatch = block.match(/MSG:\s*(.+)/i);
        if (filesMatch && msgMatch) {
          const files = filesMatch[1].split(",").map((f) => f.trim()).filter(Boolean);
          const msg = clean(msgMatch[1]);
          if (files.length > 0 && msg) commitPlan.push({ files, msg });
        }
      }

      if (commitPlan.length === 0) {
        const lines = output.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        const prefixes = ["feat:", "fix:", "refactor:", "chore:", "docs:", "test:", "style:", "perf:", "feat(", "fix(", "refactor(", "chore(", "docs(", "test(", "style(", "perf("];
        const commitLine = lines.find((l) => prefixes.some((p) => clean(l).toLowerCase().startsWith(p)));
        if (commitLine) {
          commitPlan.push({ files: [], msg: clean(commitLine) });
        } else {
          const firstLine = lines[0]?.substring(0, 80) || "";
          outputStore.addLine(`${t("git.parseFailed")}: "${firstLine}"`, true);
          outputStore.setStatus("error");
          useAiHistoryStore.getState().update(historyId, { status: "error", summary: t("git.invalidResponse"), output: firstLine, prompt });
          return;
        }
      }

      outputStore.setSuggestions(
        commitPlan.map((p) => {
          const colonIdx = p.msg.indexOf(":");
          return {
            type: colonIdx !== -1 ? p.msg.slice(0, colonIdx) : "",
            message: colonIdx !== -1 ? p.msg.slice(colonIdx + 1).trim() : p.msg,
          };
        })
      );
      const allFiles = [...new Set(commitPlan.flatMap((p) => p.files))];
      if (allFiles.length > 0) outputStore.setChangedFiles(allFiles);

      // Execute git commits
      const steps: import("../../../lib/gitStream").GitStep[] = [];

      for (const plan of commitPlan) {
        if (plan.files.length > 0) {
          steps.push({ cwd, args: ["restore", "--staged", "."] });
          for (const file of plan.files) {
            steps.push({ cwd, args: ["add", file] });
          }
        } else {
          steps.push({ cwd, args: ["add", "-A"], label: "stage all" });
        }
        steps.push({ cwd, args: ["commit", "-m", plan.msg], label: `commit: ${plan.msg.slice(0, 40)}` });
      }

      const ok = await runSteps(steps);
      if (ok) {
        setCommitMsg("");
      }
      outputStore.setStatus(ok ? "success" : "error");
      const msgs = commitPlan.map((p) => p.msg).join("; ");
      useAiHistoryStore.getState().update(historyId, { status: ok ? "success" : "error", summary: msgs.slice(0, 200), output: msgs });
    } catch (e: unknown) {
      if (!(e instanceof DisplayedError)) outputStore.addLine(String(e), true);
      outputStore.setStatus("error");
      useAiHistoryStore.getState().update(historyId, { status: "error", output: String(e), prompt });
    } finally {
      setIsAutoCommitting(false);
    }
  };

  return {
    isGenerating,
    isAutoCommitting,
    generateCommitMsg,
    handleAutoCommit,
  };
}
