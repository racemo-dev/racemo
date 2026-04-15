import { useState } from "react";
import type { ClaudeHistoryEntry, ClaudeSessionMessage } from "../../../types/claudelog";
import type { TranslationKey } from "../../../lib/i18n/git";
import { relativeTime } from "../logUtils";
import {
  ProjectLabel,
  IdBadge,
  LogMdStyles,
  DetailPanelShell,
  DetailPanelHeader,
  MessageListBody,
  INITIAL_MESSAGE_COUNT,
} from "../LogShared";
import MessageRow from "./MessageRow";
import { UsageSummary } from "./UsageComponents";

export default function SessionDetailPanel({
  entry,
  messages,
  loading,
  anchorRect,
  panelRight,
  onClose,
  ownerRef,
  t,
}: {
  entry: ClaudeHistoryEntry;
  messages: ClaudeSessionMessage[];
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
      <DetailPanelHeader title={entry.display} onClose={onClose} closeLabel={t("claudeLog.close")}>
        <IdBadge id={entry.session_id} />
        {entry.project_label && <ProjectLabel label={entry.project_label} />}
        <span className="sb-muted" style={{ fontSize: "var(--fs-9)", flexShrink: 0 }}>
          {relativeTime(entry.timestamp, t)}
        </span>
      </DetailPanelHeader>

      <LogMdStyles prefix="claude-log-md" />

      <MessageListBody
        messages={messages}
        loading={loading}
        showCount={showCount}
        onShowMore={() => setShowCount((c) => c + INITIAL_MESSAGE_COUNT)}
        loadingText={t("claudeLog.loading")}
        emptyText={t("claudeLog.noMessages")}
        showMoreText={t("claudeLog.showMore").replace("{count}", String(messages.length - showCount))}
        renderMessage={(msg, idx) => <MessageRow key={idx} message={msg} />}
      />

      {!loading && messages.length > 0 && <UsageSummary messages={messages} />}
    </DetailPanelShell>
  );
}
