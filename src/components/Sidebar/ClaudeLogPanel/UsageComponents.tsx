import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeSessionMessage } from "../../../types/claudelog";
import { formatTokens } from "../logUtils";
import { UsageBar } from "../LogShared";
import { formatResetTime } from "./helpers";
import { CONTEXT_WINDOW, USAGE_POLL_INTERVAL } from "./types";
import type { ClaudeUsagePeriod, ClaudeUsageResult } from "./types";

export function UsageRow({ label, period, color }: { label: string; period: ClaudeUsagePeriod; color: string }) {
  const pct = Math.round(period.utilization);
  const barColor = pct >= 80 ? "var(--accent-red, #d4625e)"
    : pct >= 50 ? "var(--accent-yellow, #c49a3a)"
    : color;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "var(--fs-9)", color: "var(--text-secondary)" }}>{label}</span>
        <span style={{ fontSize: "var(--fs-9)", fontWeight: 600, color: barColor }}>{pct}% used</span>
      </div>
      <UsageBar pct={pct} color={barColor} />
      <span style={{ fontSize: "var(--fs-9)", color: "var(--text-secondary)", opacity: 0.7 }}>
        Resets {formatResetTime(period.resets_at)}
      </span>
    </div>
  );
}

export function UsageSummary({ messages }: { messages: ClaudeSessionMessage[] }) {
  const totalInput  = messages.reduce((s, m) => s + (m.input_tokens  ?? 0), 0);
  const totalOutput = messages.reduce((s, m) => s + (m.output_tokens ?? 0), 0);
  const lastInputTokens = [...messages].reverse().find((m) => m.input_tokens > 0)?.input_tokens ?? 0;
  const ctxPct = Math.round((lastInputTokens / CONTEXT_WINDOW) * 100);
  const msgCount = messages.length;
  const ctxBarColor = ctxPct >= 80 ? "var(--accent-red, #d4625e)"
    : ctxPct >= 50 ? "var(--accent-yellow, #c49a3a)"
    : "var(--accent-blue)";

  return (
    <div className="shrink-0" style={{ borderTop: "1px solid var(--border-subtle)", padding: "6px 10px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)" }}>Context window</span>
        <span style={{ fontSize: "var(--fs-9)", fontWeight: 600, color: ctxBarColor }}>{ctxPct}% used</span>
      </div>
      <UsageBar pct={ctxPct} color={ctxBarColor} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: "var(--fs-9)", color: "var(--text-muted)", opacity: 0.7 }}>
          {formatTokens(lastInputTokens)} / {formatTokens(CONTEXT_WINDOW)} tokens
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

export function ClaudeApiUsagePanel() {
  const [usage, setUsage] = useState<ClaudeUsageResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const fetch = () => {
      invoke<ClaudeUsageResult>("get_claude_usage")
        .then(setUsage)
        .catch(() => setFailed(true));
    };
    fetch();
    const id = setInterval(fetch, USAGE_POLL_INTERVAL);
    return () => clearInterval(id);
  }, []);

  if (failed) return <div style={{ padding: "6px 10px", fontSize: "var(--fs-9)", color: "var(--text-muted)" }}>Usage data unavailable</div>;
  if (!usage) return null;

  return (
    <div className="shrink-0" style={{ borderTop: "1px solid var(--border-subtle)", padding: "6px 10px 8px", display: "flex", flexDirection: "column", gap: 5 }}>
      {usage.five_hour && (
        <UsageRow label="Current session" period={usage.five_hour} color="var(--accent-cyan)" />
      )}
      {usage.seven_day && (
        <UsageRow label="Current week (all models)" period={usage.seven_day} color="var(--accent-blue)" />
      )}
      {usage.seven_day_sonnet && (
        <UsageRow label="Current week (Sonnet only)" period={usage.seven_day_sonnet} color="var(--accent-purple)" />
      )}
    </div>
  );
}
