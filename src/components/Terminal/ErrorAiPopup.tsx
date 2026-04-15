import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useSettingsStore } from "../../stores/settingsStore";
import { buildAiCommand } from "../../lib/prompts";
import { useAiHistoryStore } from "../../stores/aiHistoryStore";
import type { StreamLineEvent } from "../../types/streaming";
import type { CommandError } from "../../stores/commandErrorStore";

interface ErrorAiPopupProps {
  ptyId: string;
  error: CommandError;
  cwd: string;
  onClose: () => void;
}

const _seqRef = { current: 0 };
function makeChannelId() {
  return `err-ai-${++_seqRef.current}-${Date.now()}`;
}

export default function ErrorAiPopup({ ptyId: _ptyId, error, cwd, onClose }: ErrorAiPopupProps) {
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const hasFetched = useRef(false);
  const unlistenRef = useRef<(() => void) | null>(null);
  const channelIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  // Cleanup on unmount: cancel streaming process + unlisten event
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
      if (channelIdRef.current) {
        invoke("kill_streaming", { channelId: channelIdRef.current }).catch(() => {});
        channelIdRef.current = null;
      }
    };
  }, []);

  const fetchAiHelp = useCallback(async () => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    setStreaming(true);
    setAiError(null);

    const { language } = useSettingsStore.getState();

    const langPrompts: Record<string, string> = {
      en: "Respond in English.",
      ko: "반드시 한국어로 응답하세요.",
      ja: "必ず日本語で応答してください。",
      zh: "请用中文回答。",
    };

    const outputSection = error.terminalOutput
      ? `\nTerminal output:\n\`\`\`\n${error.terminalOutput.slice(-2000)}\n\`\`\``
      : "";

    const prompt = `The following command failed with exit code ${error.exitCode}: \`${error.command}\`
${outputSection}

Analyze the error and suggest a fix. Be concise (max 5 lines).
${langPrompts[language] || langPrompts.en}

IMPORTANT: Output ONLY the analysis and fix. No preamble.`;

    const { command: aiCmd, args: aiArgs } = buildAiCommand(prompt);
    const isClaude = aiCmd === "claude";

    const channelId = makeChannelId();
    channelIdRef.current = channelId;

    const historyId = useAiHistoryStore.getState().add({
      type: "error-explain",
      status: "running",
      command: aiCmd,
      summary: error.command.slice(0, 80),
      output: "",
    });

    try {
      if (!isClaude) {
        // non-claude: run_ai_streaming (표준 프로세스, no PTY)
        const aiEventName = `ai-out-${channelId}`;
        const unlisten = await listen<StreamLineEvent>(aiEventName, (event) => {
          if (!mountedRef.current) return;
          const raw = event.payload.line;
          if (!raw.trim() || event.payload.is_err) return;
          setResult((prev) => prev + (prev ? "\n" : "") + raw);
        });
        unlistenRef.current = unlisten;

        await invoke<string>("run_ai_streaming", {
          command: aiCmd,
          args: aiArgs,
          cwd: cwd || null,
          channelId,
        });
      } else {
        // claude: exec_streaming (PTY + stream-json)
        const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
        const eventName = `exec-out-${channelId}`;
        const unlisten = await listen<StreamLineEvent>(eventName, (event) => {
          if (!mountedRef.current) return;
          const raw = event.payload.line;
          if (!raw.trim() || event.payload.is_err) return;

          try {
            const obj = JSON.parse(raw);
            if (obj.type === "assistant") {
              for (const block of (obj.message?.content ?? [])) {
                if (block.type === "text" && block.text) {
                  setResult((prev) => prev + block.text);
                }
              }
            }
          } catch {
            // non-JSON line — ignore
          }
        });
        unlistenRef.current = unlisten;

        await invoke<void>("exec_streaming", {
          program: aiCmd,
          args,
          cwd: cwd || null,
          channelId,
        });
      }
      useAiHistoryStore.getState().update(historyId, { status: "success" });
    } catch (e) {
      if (mountedRef.current) setAiError(String(e));
      useAiHistoryStore.getState().update(historyId, { status: "error", output: String(e), prompt });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      channelIdRef.current = null;
      if (mountedRef.current) setStreaming(false);
    }
  }, [error, cwd]);

  useEffect(() => {
    fetchAiHelp();
  }, [fetchAiHelp]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const safeHtml = result
    ? DOMPurify.sanitize(marked.parse(result, { async: false }))
    : "";

  return (
    <div
      ref={popupRef}
      className="absolute z-40 rounded shadow-lg"
      style={{
        top: 8,
        left: 8,
        right: 8,
        maxHeight: "60%",
        overflow: "auto",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        padding: "8px 12px",
        fontSize: "var(--fs-12)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span style={{ color: "var(--accent-red)", fontWeight: 600 }}>
            Exit {error.exitCode}
          </span>
          <code
            style={{
              color: "var(--text-secondary)",
              background: "var(--bg-overlay)",
              padding: "1px 6px",
              borderRadius: 3,
              fontSize: "var(--fs-11)",
            }}
          >
            {error.command}
          </code>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded transition-colors"
          style={{ color: "var(--text-muted)", background: "transparent", border: "none", cursor: "pointer" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent-red)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
        >
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ width: 10, height: 10 }}>
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      </div>

      {/* Content */}
      {streaming && !result && (
        <div className="flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
          <span className="inline-block animate-spin" style={{ width: 12, height: 12, border: "2px solid var(--border-default)", borderTop: "2px solid var(--accent-yellow)", borderRadius: "50%" }} />
          <span>Asking AI...</span>
        </div>
      )}
      {aiError && (
        <div style={{ color: "var(--accent-red)", whiteSpace: "pre-wrap" }}>
          {aiError}
        </div>
      )}
      {result && (
        <div
          className="ai-markdown"
          style={{ color: "var(--text-primary)", lineHeight: 1.6, fontSize: "var(--fs-11)" }}
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
      )}
      {streaming && result && (
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: "0.8em",
            background: "var(--accent-yellow)",
            marginLeft: 2,
            verticalAlign: "text-bottom",
            animation: "blink 1s step-end infinite",
          }}
        />
      )}
    </div>
  );
}
