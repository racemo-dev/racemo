import { useEffect, useState } from "react";
import { isTauri } from "../../../lib/bridge";
import { useGitT } from "../../../lib/i18n/git";
import { AI_PROVIDERS } from "./types";
import { AllLogPanel } from "./AllLogPanel";
import { TabButton } from "./TabButton";

/* ─── Main Component ─── */

export default function AiLogPanel() {
  const t = useGitT();
  const [availableIds, setAvailableIds] = useState<Set<string>>(
    () => new Set(AI_PROVIDERS.filter((p) => !p.checkExists).map((p) => p.id)),
  );
  const [activeTab, setActiveTab] = useState<string>("all");

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const check = async () => {
      const ids = new Set<string>();
      for (const p of AI_PROVIDERS) {
        if (!p.checkExists) { ids.add(p.id); } else {
          try { if (await p.checkExists()) ids.add(p.id); } catch { /* skip */ }
        }
      }
      if (!cancelled) setAvailableIds(ids);
    };
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, []);

  useEffect(() => {
    if (activeTab !== "all" && !availableIds.has(activeTab)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fallback when active tab disappears from available list
      setActiveTab("all");
    }
  }, [availableIds, activeTab]);

  const visibleProviders = AI_PROVIDERS.filter((p) => availableIds.has(p.id));

  if (!isTauri()) {
    return <div className="sb-empty">{t("claudeLog.desktopOnly")}</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar: All on left, provider icons on right */}
      <div
        className="flex items-center shrink-0 select-none"
        style={{ borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-surface)", padding: "3px 6px", gap: 2 }}
      >
        <TabButton isActive={activeTab === "all"} onClick={() => setActiveTab("all")} title="All">
          <span style={{ fontSize: "var(--fs-9)", fontWeight: 600 }}>All</span>
        </TabButton>
        <div style={{ flex: 1 }} />
        {visibleProviders.map((p) => (
          <TabButton key={p.id} isActive={p.id === activeTab} onClick={() => setActiveTab(p.id)} title={p.label}>
            {p.icon}
          </TabButton>
        ))}
      </div>

      {/* All panel */}
      <div className="flex-1 min-h-0" style={{ display: activeTab === "all" ? undefined : "none" }}>
        <AllLogPanel availableIds={availableIds} />
      </div>

      {/* Individual provider panels */}
      {visibleProviders.map((p) => (
        <div key={p.id} className="flex-1 min-h-0" style={{ display: p.id === activeTab ? undefined : "none" }}>
          <p.panel />
        </div>
      ))}
    </div>
  );
}
