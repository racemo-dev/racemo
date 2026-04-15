import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useGitOutputStore } from "../stores/gitOutputStore";
import { getGitT } from "./i18n/git";
import { buildAiCommand } from "./prompts";
import { getAiErrorGuide } from "./aiErrorGuide";
import { useSettingsStore } from "../stores/settingsStore";
import type { StreamLineEvent } from "../types/streaming";

export class DisplayedError extends Error {
  readonly _displayed = true;
}

let _channelSeq = 0;

function makeChannelId() {
  return `ch${++_channelSeq}-${Date.now()}`;
}

/** Run a single git command, streaming each line to the provided callback. */
async function runOne(
  cwd: string,
  args: string[],
  addLine: (line: string, isErr: boolean) => void
): Promise<boolean> {
  const channelId = makeChannelId();
  const eventName = `git-out-${channelId}`;
  let unlisten: UnlistenFn | null = null;

  useGitOutputStore.getState().setChannelId(channelId);
  try {
    unlisten = await listen<StreamLineEvent>(eventName, (event) => {
      addLine(event.payload.line, event.payload.is_err);
    });

    return await invoke<boolean>("git_exec_streaming", {
      cwd,
      args,
      channelId,
    });
  } finally {
    unlisten?.();
    useGitOutputStore.getState().setChannelId(null);
  }
}

/**
 * Run an AI CLI command (e.g. claude --print "...") with streaming output
 * into the already-open GitOutputModal. Returns the full stdout.
 */
export async function runAiStreaming(
  command: string,
  args: string[],
  cwd: string | undefined,
  _headerLine?: string,
): Promise<string> {
  const { addLine } = useGitOutputStore.getState();
  const channelId = makeChannelId();
  const eventName = `ai-out-${channelId}`;
  let unlisten: UnlistenFn | null = null;

  addLine(`\n$ ${command} ${args.filter((a) => a.length < 60).join(" ")}`, false);

  useGitOutputStore.getState().setChannelId(channelId);
  try {
    unlisten = await listen<StreamLineEvent>(eventName, (event) => {
      addLine(event.payload.line, event.payload.is_err);
    });

    return await invoke<string>("run_ai_streaming", {
      command,
      args,
      cwd: cwd ?? null,
      channelId,
    });
  } finally {
    unlisten?.();
    useGitOutputStore.getState().setChannelId(null);
  }
}

/**
 * Run any shell command with streaming output into the already-open GitOutputModal.
 */
export async function runExecStreaming(
  program: string,
  args: string[],
  cwd: string | undefined,
): Promise<void> {
  const { addLine } = useGitOutputStore.getState();
  const channelId = makeChannelId();
  const eventName = `exec-out-${channelId}`;
  let unlisten: UnlistenFn | null = null;

  addLine(`\n$ ${program} ${args.join(" ")}`, false);

  useGitOutputStore.getState().setChannelId(channelId);
  try {
    unlisten = await listen<StreamLineEvent>(eventName, (event) => {
      addLine(event.payload.line, event.payload.is_err);
    });

    await invoke<void>("exec_streaming", {
      program,
      args,
      cwd: cwd ?? null,
      channelId,
    });
  } finally {
    unlisten?.();
    useGitOutputStore.getState().setChannelId(null);
  }
}

/**
 * Run `claude -p "<prompt>" --output-format stream-json --verbose`
 * and stream parsed output into the already-open GitOutputModal.
 * Returns the final result text.
 */
export async function runClaudeStreaming(
  prompt: string,
  cwd: string | undefined,
  suppressText?: boolean,
  suppressResult?: boolean,
  onToolUse?: (name: string, input: Record<string, unknown>) => void,
): Promise<string> {
  const { addLine, setIsThinking } = useGitOutputStore.getState();
  const channelId = makeChannelId();
  const eventName = `exec-out-${channelId}`;
  let unlisten: UnlistenFn | null = null;
  let resultText = "";

  const { command: aiCmd, args: aiArgs } = buildAiCommand(prompt);
  const isClaude = aiCmd === "claude";

  // claude: stream-json (PTY 필요)
  // 그 외: 템플릿 args 그대로 (표준 프로세스 — PTY 사용 시 interactive 모드로 빠짐)
  const args = isClaude
    ? ["-p", prompt, "--output-format", "stream-json", "--verbose"]
    : aiArgs;

  addLine(`\n$ ${aiCmd} ${args.filter((a) => a.length < 60).join(" ")}`, false);
  useGitOutputStore.getState().setChannelId(channelId);

  // non-claude: run_ai_streaming (표준 프로세스, no PTY)
  // PTY를 사용하면 gemini/codex가 터미널 감지 후 interactive 모드로 전환되어 hang
  if (!isClaude) {
    let stderrBuf = "";
    try {
      const aiEventName = `ai-out-${channelId}`;
      unlisten = await listen<StreamLineEvent>(aiEventName, (event) => {
        const raw = event.payload.line;
        if (!raw.trim()) return;
        if (event.payload.is_err) { stderrBuf += (stderrBuf ? "\n" : "") + raw; return; }
        if (!suppressText) addLine(raw, false);
        resultText += (resultText ? "\n" : "") + raw;
      });

      const stdout = await invoke<string>("run_ai_streaming", {
        command: aiCmd,
        args,
        cwd: cwd ?? null,
        channelId,
      });
      if (stdout) resultText = stdout;
      useGitOutputStore.getState().setStatus("success");
    } catch (e) {
      const errorText = stderrBuf || String(e);
      const lang = useSettingsStore.getState().language;
      const guide = getAiErrorGuide(errorText, aiCmd, lang);
      addLine(guide ? `💡 ${guide}` : String(e), guide ? false : true);
      useGitOutputStore.getState().setStatus("error");
      throw new DisplayedError(String(e));
    } finally {
      unlisten?.();
      useGitOutputStore.getState().setChannelId(null);
    }
    return resultText;
  }

  // claude: exec_streaming (PTY + stream-json JSONL 파싱)
  let claudeStderrBuf = "";
  try {
    unlisten = await listen<StreamLineEvent>(eventName, (event) => {
      const raw = event.payload.line;
      if (!raw.trim()) return;

      // stderr는 그대로 표시
      if (event.payload.is_err) {
        claudeStderrBuf += (claudeStderrBuf ? "\n" : "") + raw;
        addLine(raw, true);
        return;
      }

      // claude: JSONL 파싱
      try {
        const obj = JSON.parse(raw);
        const type = obj.type as string;
        const subtype = obj.subtype as string | undefined;

        // 노이즈 이벤트 무시
        if (type === "system" && (subtype === "hook_started" || subtype === "hook_response")) return;
        if (type === "user") return;

        if (type === "system" && subtype === "init") {
          // suppress init line
        } else if (type === "assistant") {
          const content = obj.message?.content ?? [];
          for (const block of content) {
            if (block.type === "thinking") {
              if (!onToolUse) {
                setIsThinking(true);
              }
            } else if (block.type === "text" && block.text) {
              setIsThinking(false);
              if (!suppressText) {
                for (const ln of (block.text as string).split("\n")) {
                  addLine(ln, false);
                }
              }
            } else if (block.type === "tool_use") {
              if (onToolUse) {
                onToolUse(block.name as string, (block.input ?? {}) as Record<string, unknown>);
              } else {
                const inputStr = JSON.stringify(block.input ?? {});
                const summary = inputStr.length > 80 ? inputStr.slice(0, 77) + "..." : inputStr;
                addLine(`\`${block.name}\`: ${summary}`, false);
              }
              setIsThinking(true);
            }
          }
        } else if (type === "tool" || type === "tool_result") {
          const content = obj.content ?? obj.output ?? "";
          const len = typeof content === "string" ? content.length : JSON.stringify(content).length;
          addLine(`  └─ ${len} chars`, false);
          setIsThinking(true);
        } else if (type === "result") {
          setIsThinking(false);
          resultText = obj.result ?? "";
          if (!suppressResult) {
            const ms = obj.duration_ms ?? 0;
            addLine(getGitT("gitStream.done").replace("{s}", (ms / 1000).toFixed(1)), false);
          }
          useGitOutputStore.getState().setStatus("success");
        }
        // rate_limit_event 등 나머지 무시
      } catch {
        // JSON 파싱 실패: JSON처럼 생긴 라인은 무시 (깨진 JSON 덤프 방지)
        if (!raw.trim().startsWith('{')) {
          addLine(raw, false);
        }
      }
    });

    await invoke<void>("exec_streaming", {
      program: aiCmd,
      args,
      cwd: cwd ?? null,
      channelId,
    });
  } catch (e) {
    const errorText = claudeStderrBuf || String(e);
    const lang = useSettingsStore.getState().language;
    const guide = getAiErrorGuide(errorText, aiCmd, lang);
    addLine(guide ? `💡 ${guide}` : String(e), guide ? false : true);
    useGitOutputStore.getState().setStatus("error");
    throw new DisplayedError(String(e));
  } finally {
    unlisten?.();
    useGitOutputStore.getState().setChannelId(null);
  }

  return resultText;
}

export interface GitStep {
  cwd: string;
  args: string[];
  /** Label shown as a header line in the output (optional) */
  label?: string;
}

/**
 * Run git steps inside an already-open GitOutputModal.
 * Does NOT open or close the modal — caller is responsible.
 * Returns true if all steps succeed.
 */
export async function runGitSteps(steps: GitStep[]): Promise<boolean> {
  const { addLine } = useGitOutputStore.getState();

  for (const step of steps) {
    const ok = await runOne(step.cwd, step.args, addLine);
    if (!ok) return false;
  }
  return true;
}

/**
 * Open GitOutputModal, run a sequence of git commands with streaming output.
 * Stops on first failure.
 */
export async function runGitStreaming(
  steps: GitStep[],
  title: string,
  onSuccess?: () => void
): Promise<boolean> {
  const store = useGitOutputStore.getState();
  store.open(title, onSuccess);

  // React 렌더 사이클에 양보 — 팝업이 화면에 먼저 뜨고 나서 명령 실행
  await new Promise<void>((r) => setTimeout(r, 32));

  try {
    const ok = await runGitSteps(steps);
    store.setStatus(ok ? "success" : "error");
    return ok;
  } catch (e) {
    store.addLine(String(e), true);
    store.setStatus("error");
    return false;
  }
}
