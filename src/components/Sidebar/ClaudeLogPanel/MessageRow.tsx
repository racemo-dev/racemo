import { useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { ClaudeSessionMessage } from "../../../types/claudelog";
import { useGitT } from "../../../lib/i18n/git";
import { formatTokens, ICON_STYLE } from "../logUtils";
import {
  CaretDown,
  Robot,
  User,
} from "@phosphor-icons/react";
import { ToolBadge, getToolColor } from "../LogShared";
import { getModelColor } from "./helpers";

function ModelBadge({ model }: { model: string }) {
  if (!model || model === "<synthetic>") return null;
  const short = model.replace("claude-", "").replace("anthropic.", "");
  const { bg, fg } = getModelColor(model);
  return (
    <span
      style={{
        fontSize: "var(--fs-9)",
        color: fg,
        background: bg,
        borderRadius: 3,
        padding: "1px 4px",
        fontWeight: 600,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {short}
    </span>
  );
}

function TokenInfo({ input, output }: { input: number; output: number }) {
  if (input === 0 && output === 0) return null;
  return (
    <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
      {formatTokens(input)}in / {formatTokens(output)}out
    </span>
  );
}

export default function MessageRow({ message }: { message: ClaudeSessionMessage }) {
  const t = useGitT();
  const isUser = message.role === "user";
  const [toolsOpen, setToolsOpen] = useState(false);

  const toolUses = message.tool_uses.map((tu) =>
    typeof tu === "string" ? { name: tu as string, detail: "" } : tu
  );
  const hasToolDetail = toolUses.length > 0;

  const preprocess = (text: string) =>
    text
      .replace(/^[─━═-]{4,}\s*$/gm, "\n---\n")
      .replace(/^\s*📊[^\n]*\n/gm, (m) => `**${m.trim()}**\n`);

  return (
    <div style={{
      padding: "5px 10px",
      borderBottom: "1px solid var(--border-subtle)",
      background: isUser ? "hsla(210, 60%, 50%, 0.08)" : undefined,
      borderLeft: isUser ? "2px solid var(--accent-blue)" : "2px solid transparent",
    }}>
      <div className="flex items-center gap-1" style={{ marginBottom: 2 }}>
        {isUser ? (
          <User size={11} style={ICON_STYLE(11)} color="var(--accent-blue)" />
        ) : (
          <Robot size={11} style={ICON_STYLE(11)} color="var(--accent-purple)" />
        )}
        <span
          style={{
            fontSize: "var(--fs-9)",
            fontWeight: 600,
            color: isUser ? "var(--accent-blue)" : "var(--accent-purple)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {message.role}
        </span>
        {!isUser && <ModelBadge model={message.model} />}
        {!isUser && <TokenInfo input={message.input_tokens} output={message.output_tokens} />}
      </div>

      {message.content && (
        <div
          style={{
            fontSize: "var(--fs-12)",
            color: "var(--text-secondary)",
            lineHeight: 1.4,
            wordBreak: "break-word",
          }}
        >
          <span
            dangerouslySetInnerHTML={{
              __html: (() => {
                try {
                  const html = marked.parse(preprocess(message.content), { async: false }) as string;
                  return DOMPurify.sanitize(html);
                } catch { return DOMPurify.sanitize(message.content); }
              })(),
            }}
            style={{ display: "block" }}
            className="claude-log-md"
          />
        </div>
      )}

      {toolUses.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div className="flex flex-wrap gap-1" style={{ alignItems: "center" }}>
            {toolUses.map((tool, i) => (
              <ToolBadge key={i} name={tool.name} />
            ))}
            {hasToolDetail && (
              <button
                onClick={() => setToolsOpen((p) => !p)}
                title={toolsOpen ? t("claudeLog.collapse") : t("claudeLog.expand")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 16,
                  height: 16,
                  background: toolsOpen ? "var(--bg-overlay)" : "transparent",
                  border: `1px solid ${toolsOpen ? "var(--border-default)" : "transparent"}`,
                  borderRadius: 3,
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                  transition: "background 120ms, border-color 120ms",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)"; }}
                onMouseLeave={(e) => { if (!toolsOpen) { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = "transparent"; } }}
              >
                <CaretDown
                  size={9}
                  weight="bold"
                  style={{
                    color: toolsOpen ? "var(--accent-cyan)" : "var(--text-muted)",
                    transition: "transform 150ms ease, color 120ms",
                    transform: toolsOpen ? "rotate(0deg)" : "rotate(-90deg)",
                  }}
                />
              </button>
            )}
          </div>
          {toolsOpen && (
            <div
              style={{
                marginTop: 3,
                background: "var(--bg-subtle)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              {toolUses.map((tool, i) => {
                const { color, border } = getToolColor(tool.name);
                const detail = tool.detail ?? "";
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 6,
                      padding: "3px 7px",
                      borderBottom: i < toolUses.length - 1
                        ? "1px solid var(--border-subtle)"
                        : "none",
                      alignItems: "baseline",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "var(--fs-9)",
                        color,
                        border: `1px solid ${border}`,
                        borderRadius: 3,
                        padding: "0 3px",
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tool.name}
                    </span>
                    {detail ? (
                      <span
                        style={{
                          fontSize: "var(--fs-9)",
                          color: "var(--text-secondary)",
                          fontFamily: "var(--font-mono, monospace)",
                          wordBreak: "break-all",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {detail}
                      </span>
                    ) : (
                      <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", fontStyle: "italic" }}>—</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
