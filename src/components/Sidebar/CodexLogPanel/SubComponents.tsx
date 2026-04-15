import { useState } from "react";
import { Brain } from "@phosphor-icons/react";
import type { CodexHistoryEntry, CodexSessionMessage, CodexSessionMeta } from "../../../types/codexlog";
import type { TranslationKey } from "../../../lib/i18n/git";
import { formatTokens, ICON_STYLE } from "../logUtils";
import { relativeTime, truncateDisplay } from "../logUtils";
import { CodexIcon } from "../AiLogPanel/ProviderIcons";
import {
  ProjectLabel,
  IdBadge,
  ToolBadge,
  MarkdownContent,
  LogMdStyles,
  DetailPanelShell,
  DetailPanelHeader,
  MessageListBody,
  MessageRowShell,
  HistoryRowShell,
  UsageBar,
  INITIAL_MESSAGE_COUNT,
  type RoleConfig,
} from "../LogShared";
import { getModelColor } from "./helpers";

/* ─── Extra role config for Codex ─── */
const CODEX_EXTRA_ROLES: Record<string, RoleConfig> = {
  reasoning: {
    icon: <Brain size={11} style={ICON_STYLE(11)} color="var(--accent-purple)" />,
    color: "var(--accent-purple)",
    label: "REASONING",
    bg: "hsla(280, 50%, 50%, 0.06)",
    borderColor: "var(--accent-purple)",
  },
};

/* ─── ModelBadge ─── */
export function ModelBadge({ model }: { model: string }) {
  if (!model) return null;
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
      {model}
    </span>
  );
}

/* ─── TokenInfo ─── */
export function TokenInfo({ input, output, cached, reasoning }: { input: number; output: number; cached: number; reasoning: number }) {
  if (input === 0 && output === 0) return null;
  return (
    <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", whiteSpace: "nowrap", display: "flex", gap: 4, alignItems: "center" }}>
      <span>{formatTokens(input)}in</span>
      {cached > 0 && <span style={{ color: "var(--accent-cyan)" }}>({formatTokens(cached)} cached)</span>}
      <span>{formatTokens(output)}out</span>
      {reasoning > 0 && <span style={{ color: "var(--accent-purple)" }}>({formatTokens(reasoning)} reasoning)</span>}
    </span>
  );
}

/* ─── UsageSummary ─── */
export function UsageSummary({ messages, meta }: { messages: CodexSessionMessage[]; meta: CodexSessionMeta | null }) {
  const lastToken = [...messages].reverse().find((m) => m.input_tokens > 0);
  const totalInput  = lastToken?.input_tokens ?? 0;
  const totalOutput = messages.reduce((s, m) => s + m.output_tokens, 0);
  const ctxWindow = 258400;
  const ctxPct = totalInput > 0 ? Math.round((totalInput / ctxWindow) * 100) : 0;
  const ctxBarColor = ctxPct >= 80 ? "var(--accent-red, #d4625e)"
    : ctxPct >= 50 ? "var(--accent-yellow, #c49a3a)"
    : "var(--accent-green, #5daa68)";
  const msgCount = messages.filter((m) => m.role === "user" || m.role === "assistant").length;

  return (
    <div className="shrink-0" style={{ borderTop: "1px solid var(--border-subtle)", padding: "6px 10px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
      {meta && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "var(--fs-9)", color: "var(--text-muted)" }}>
          <ModelBadge model={meta.model} />
          <span>{meta.cli_version}</span>
          {meta.git_branch && <span style={{ color: "var(--accent-cyan)" }}>{meta.git_branch}</span>}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)" }}>Context window</span>
        <span style={{ fontSize: "var(--fs-9)", fontWeight: 600, color: ctxBarColor }}>{ctxPct}% used</span>
      </div>
      <UsageBar pct={ctxPct} color={ctxBarColor} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", opacity: 0.7 }}>
          {formatTokens(totalInput)} / {formatTokens(ctxWindow)} tokens
        </span>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
          <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", display: "flex", gap: 3, alignItems: "center" }}>
            <span style={{ color: "var(--accent-blue)" }}>↑</span>{formatTokens(totalInput)}
          </span>
          <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", display: "flex", gap: 3, alignItems: "center" }}>
            <span style={{ color: "var(--accent-purple)" }}>↓</span>{formatTokens(totalOutput)}
          </span>
          <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)" }}>
            {msgCount} msg{msgCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── MessageRow ─── */
export function MessageRow({ message }: { message: CodexSessionMessage }) {
  const isToolResult = message.role === "tool_result";
  const isReasoning = message.role === "reasoning";
  const isCollapsible = isToolResult || isReasoning;
  const contentPreview = isCollapsible && message.content.length > 80
    ? message.content.slice(0, 80) + "..."
    : null;

  return (
    <MessageRowShell
      role={message.role}
      extraRoles={CODEX_EXTRA_ROLES}
      isCollapsible={isCollapsible}
      headerExtra={
        <>
          {message.tool_name && <ToolBadge name={message.tool_name} />}
          {message.role === "assistant" && message.model && <ModelBadge model={message.model} />}
          {message.role === "assistant" && (
            <TokenInfo
              input={message.input_tokens}
              output={message.output_tokens}
              cached={message.cached_input_tokens}
              reasoning={message.reasoning_tokens}
            />
          )}
        </>
      }
    >
      {message.content && (
        <div
          style={{
            fontSize: "var(--fs-12)",
            color: "var(--text-secondary)",
            lineHeight: 1.4,
            wordBreak: "break-word",
            fontFamily: isToolResult ? "var(--font-mono, monospace)" : undefined,
            whiteSpace: isToolResult ? "pre-wrap" : undefined,
          }}
        >
          {isToolResult ? (
            <span>{message.content}</span>
          ) : (
            <MarkdownContent content={message.content} className="codex-log-md" />
          )}
        </div>
      )}
      {contentPreview && (
        <div style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", fontStyle: "italic" }}>
          {contentPreview}
        </div>
      )}
    </MessageRowShell>
  );
}

/* ─── SessionDetailPanel ─── */
export function SessionDetailPanel({
  entry,
  meta,
  messages,
  loading,
  anchorRect,
  panelRight,
  onClose,
  ownerRef,
  t,
}: {
  entry: CodexHistoryEntry;
  meta: CodexSessionMeta | null;
  messages: CodexSessionMessage[];
  loading: boolean;
  anchorRect: DOMRect;
  panelRight: number;
  onClose: () => void;
  ownerRef: React.RefObject<HTMLDivElement | null>;
  t: (key: TranslationKey) => string;
}) {
  const [showCount, setShowCount] = useState(INITIAL_MESSAGE_COUNT);

  return (
    <DetailPanelShell anchorRect={anchorRect} panelRight={panelRight} onClose={onClose} ownerRef={ownerRef}>
      <DetailPanelHeader title={entry.display} onClose={onClose} closeLabel={t("codexLog.close")}>
        <IdBadge id={entry.session_id} />
        {entry.cwd_label && <ProjectLabel label={entry.cwd_label} />}
        <span className="sb-muted" style={{ fontSize: "var(--fs-9)", flexShrink: 0 }}>
          {relativeTime(entry.timestamp, t)}
        </span>
      </DetailPanelHeader>

      <LogMdStyles prefix="codex-log-md" />

      <MessageListBody
        messages={messages}
        loading={loading}
        showCount={showCount}
        onShowMore={() => setShowCount((c) => c + INITIAL_MESSAGE_COUNT)}
        loadingText={t("codexLog.loading")}
        emptyText={t("codexLog.noMessages")}
        showMoreText={t("codexLog.showMore").replace("{count}", String(messages.length - showCount))}
        renderMessage={(msg, idx) => <MessageRow key={idx} message={msg} />}
      />

      {!loading && messages.length > 0 && <UsageSummary messages={messages} meta={meta} />}
    </DetailPanelShell>
  );
}

/* ─── HistoryRow ─── */
export function HistoryRow({
  entry,
  onClick,
  activeSessionId,
  indent,
  t,
}: {
  entry: CodexHistoryEntry;
  onClick: (entry: CodexHistoryEntry, rect: DOMRect) => void;
  activeSessionId: string | null;
  indent?: boolean;
  t: (key: TranslationKey) => string;
}) {
  const isActive = activeSessionId === entry.session_id;
  return (
    <HistoryRowShell isActive={isActive} indent={indent} icon={<CodexIcon />} onClick={(rect) => onClick(entry, rect)}>
      <div className="truncate" style={{ lineHeight: 1.3 }}>
        {truncateDisplay(entry.display, 60)}
      </div>
      <div
        className="flex items-center gap-1"
        style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", marginTop: 1 }}
      >
        <span>{relativeTime(entry.timestamp, t)}</span>
        <span style={{ marginLeft: "auto" }}>
          <IdBadge id={entry.session_id} />
        </span>
        {entry.cwd_label && <ProjectLabel label={entry.cwd_label} />}
      </div>
    </HistoryRowShell>
  );
}
