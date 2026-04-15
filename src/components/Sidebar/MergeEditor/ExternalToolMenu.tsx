import { useEffect, useRef } from "react";
import { GitMerge, Warning } from "@phosphor-icons/react";
import { useGitT } from "../../../lib/i18n/git";

export function ExternalToolMenu({
  onMergetool,
  onVscode,
  mergetoolName,
  onClose,
}: {
  onMergetool: () => void;
  onVscode: () => void;
  mergetoolName: string;
  onClose: () => void;
}) {
  const t = useGitT();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    // Delay to avoid immediate close from the click that opened the menu
    const timer = setTimeout(() => window.addEventListener("click", handleClick), 0);
    return () => { clearTimeout(timer); window.removeEventListener("click", handleClick); };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="absolute z-[9999] py-1 rounded shadow-lg"
      style={{
        top: "100%",
        right: 0,
        marginTop: 2,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        minWidth: 200,
        fontSize: "var(--fs-11)",
      }}
    >
      {/* git mergetool */}
      {mergetoolName ? (
        <button
          className="w-full text-left px-3 py-1 flex items-center gap-2 hover:bg-[var(--bg-overlay)] transition-colors cursor-pointer"
          style={{ color: "var(--text-primary)", background: "none", border: "none", fontSize: "var(--fs-11)" }}
          onClick={() => { onMergetool(); onClose(); }}
        >
          <GitMerge size={14} weight="bold" style={{ color: "var(--accent-purple)", flexShrink: 0 }} />
          <span className="flex flex-col">
            <span>{t("merge.openMergetool")}</span>
            <span style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)" }}>{mergetoolName}</span>
          </span>
        </button>
      ) : (
        <div
          className="px-3 py-1 flex items-center gap-2"
          style={{ color: "var(--text-muted)", fontSize: "var(--fs-11)" }}
        >
          <Warning size={14} weight="bold" style={{ color: "var(--accent-yellow)", flexShrink: 0 }} />
          <span className="flex flex-col">
            <span>{t("merge.noMergetool")}</span>
            <span style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{t("merge.noMergetoolTip")}</span>
          </span>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--border-subtle)", margin: "2px 0" }} />

      {/* VS Code */}
      <button
        className="w-full text-left px-3 py-1 flex items-center gap-2 hover:bg-[var(--bg-overlay)] transition-colors cursor-pointer"
        style={{ color: "var(--text-primary)", background: "none", border: "none", fontSize: "var(--fs-11)" }}
        onClick={() => { onVscode(); onClose(); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path d="M17.5 0L9.5 8.5L4.5 4.5L0 6.5V17.5L4.5 19.5L9.5 15.5L17.5 24L24 21V3L17.5 0Z" fill="var(--accent-blue)"/>
        </svg>
        <span>{t("merge.openVscode")}</span>
      </button>
    </div>
  );
}
