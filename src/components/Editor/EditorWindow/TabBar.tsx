import { useEffect, useCallback, useRef, useState, forwardRef } from "react";
import { useEditorStore, type EditorTab } from "../../../stores/editorStore";
import { isMac } from "../../../lib/osUtils";
import { ArrowLeft, ArrowRight, ArrowSquareIn } from "@phosphor-icons/react";
import { useGitT } from "../../../lib/i18n/git";
import { WindowControls } from "./WindowControls";

/* ─── Context menu item ─── */
function CtxItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="w-full text-left hover:bg-[var(--bg-overlay)] transition-colors"
      style={{ fontSize: "var(--fs-12)", color: danger ? "var(--accent-red)" : "var(--text-primary)", padding: "3px 12px" }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ─── Disambiguation: show parent folder when two tabs share a name ─── */
function getDisplayNames(tabs: EditorTab[]): string[] {
  return tabs.map((tab, i) => {
    const hasDup = tabs.some((t, j) => j !== i && t.name === tab.name);
    if (!hasDup) return tab.name;
    const parts = tab.path.replace(/\\/g, "/").split("/");
    return parts.length >= 2 ? `${tab.name} (${parts[parts.length - 2]})` : tab.name;
  });
}

/* ─── Tab ─── */
const Tab = forwardRef<HTMLDivElement, {
  tab: EditorTab;
  displayName: string;
  isActive: boolean;
  isDragOver: boolean;
  onClick: () => void;
  onMiddleDown: () => void;
  onClose: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}>(function Tab({
  tab, displayName, isActive, isDragOver,
  onClick, onMiddleDown, onClose, onContextMenu,
  onDragStart, onDragOver, onDrop, onDragEnd,
}, ref) {
  return (
    <div
      ref={ref}
      draggable
      onClick={onClick}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.button === 1) { e.preventDefault(); onMiddleDown(); }
      }}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className="group flex items-center gap-1.5 px-3 h-full cursor-pointer shrink-0 select-none"
      style={{
        fontSize: "var(--fs-11)",
        color: isActive ? "var(--text-primary)" : "var(--text-tertiary)",
        background: isActive ? "var(--bg-base)" : "transparent",
        borderRight: "1px solid var(--border-subtle)",
        borderTop: "2px solid transparent",
        borderLeft: isDragOver ? "2px solid var(--accent-blue)" : undefined,
        boxSizing: "border-box",
      }}
    >
      {tab.isDirty && (
        <span className="inline-block rounded-full shrink-0" style={{ width: 6, height: 6, background: "var(--accent-blue)" }} />
      )}
      <span className="truncate max-w-[140px]">{displayName}</span>
      <button
        onClick={onClose}
        className="titlebar-btn p-1 cursor-pointer transition-opacity"
        style={{ opacity: isActive ? 0.6 : 0 }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = isActive ? "0.6" : "0")}
      >
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          style={{ width: 'calc(8px * var(--ui-scale))', height: 'calc(8px * var(--ui-scale))' }}>
          <line x1="2" y1="2" x2="8" y2="8" />
          <line x1="8" y1="2" x2="2" y2="8" />
        </svg>
      </button>
    </div>
  );
});

/* ─── Tab bar ─── */
export function TabBar() {
  const t = useGitT();
  const tabs = useEditorStore((s) => s.tabs);
  const activeIndex = useEditorStore((s) => s.activeIndex);
  const setActiveIndex = useEditorStore((s) => s.setActiveIndex);
  const closeTab = useEditorStore((s) => s.closeTab);
  const closeOthers = useEditorStore((s) => s.closeOthers);
  const closeToRight = useEditorStore((s) => s.closeToRight);
  const closeAll = useEditorStore((s) => s.closeAll);
  const moveTab = useEditorStore((s) => s.moveTab);
  const reloadTabByPath = useEditorStore((s) => s.reloadTabByPath);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [dragSrc, setDragSrc] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  /* Arrow visibility */
  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 0);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateArrows();
    el.addEventListener("scroll", updateArrows);
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", updateArrows); ro.disconnect(); };
  }, [updateArrows]);

  useEffect(() => { updateArrows(); }, [tabs, updateArrows]);

  /* Scroll active tab into view */
  useEffect(() => {
    const el = scrollRef.current;
    const tab = tabRefs.current[activeIndex];
    if (!el || !tab) return;
    const tabLeft = tab.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;
    if (tabLeft < el.scrollLeft) el.scrollLeft = tabLeft;
    else if (tabRight > el.scrollLeft + el.clientWidth) el.scrollLeft = tabRight - el.clientWidth;
  }, [activeIndex]);

  /* Mouse-wheel scroll (non-passive) */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      updateArrows();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [updateArrows]);

  /* Ctrl+W close active tab */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "w" && tabs.length > 0) {
        e.preventDefault();
        closeTab(activeIndex);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIndex, closeTab, tabs.length]);

  /* Close context menu on pointerdown outside */
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: PointerEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
  }, [ctxMenu]);

  const scroll = (dir: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === "left" ? -120 : 120, behavior: "smooth" });
  };

  const handleWinClose = () => {
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
  };

  const displayNames = getDisplayNames(tabs);

  const navBtn = (disabled: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    width: "calc(22px * var(--ui-scale))", height: "100%", flexShrink: 0,
    color: disabled ? "var(--text-disabled, var(--border-default))" : "var(--text-muted)",
    cursor: disabled ? "default" : "pointer",
    transition: "color 0.15s",
    opacity: disabled ? 0.35 : 1,
  });

  return (
    <div
      className="flex items-center shrink-0"
      style={{ height: "calc(32px * var(--ui-scale))", background: "var(--bg-overlay)" }}
      data-tauri-drag-region
    >
      {isMac() && <div className="shrink-0" style={{ width: 74 }} />}

      <div ref={scrollRef} className="flex items-center h-full min-w-0 overflow-hidden" style={{ flex: "1 1 0" }}>
        {tabs.map((tab, i) => (
          <Tab
            key={tab.path}
            ref={(el) => { tabRefs.current[i] = el; }}
            tab={tab}
            displayName={displayNames[i]}
            isActive={i === activeIndex}
            isDragOver={dragOver === i}
            onClick={() => { setActiveIndex(i); reloadTabByPath(tabs[i].path); }}
            onMiddleDown={() => closeTab(i)}
            onClose={(e) => { e.stopPropagation(); closeTab(i); }}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, index: i }); }}
            onDragStart={() => setDragSrc(i)}
            onDragOver={(e) => { e.preventDefault(); if (dragSrc !== i) setDragOver(i); }}
            onDrop={() => { if (dragSrc !== null && dragSrc !== i) moveTab(dragSrc, i); setDragSrc(null); setDragOver(null); }}
            onDragEnd={() => { setDragSrc(null); setDragOver(null); }}
          />
        ))}
      </div>

      <button type="button" className={canLeft ? "nav-arrow" : ""} style={navBtn(!canLeft)}
        onClick={() => canLeft && scroll("left")} onMouseDown={(e) => e.stopPropagation()}
      >
        <ArrowLeft style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
      </button>
      <button type="button" className={canRight ? "nav-arrow" : ""} style={navBtn(!canRight)}
        onClick={() => canRight && scroll("right")} onMouseDown={(e) => e.stopPropagation()}
      >
        <ArrowRight style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
      </button>

      <div className="flex-1 h-full" data-tauri-drag-region />

      {/* 패널로 이동 */}
      {tabs[activeIndex] && (
        <button
          type="button"
          title="Embed to panel"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            const active = tabs[activeIndex];
            if (!active) return;
            import("@tauri-apps/api/event").then(({ emit }) => {
              emit("editor:embed-to-panel", { path: active.path });
            });
            closeTab(activeIndex);
          }}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "calc(28px * var(--ui-scale))", height: "100%", flexShrink: 0,
            color: "var(--text-muted)",
            cursor: "pointer",
            transition: "color 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <ArrowSquareIn style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
        </button>
      )}

      <WindowControls onClose={handleWinClose} />

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="fixed z-[9999] py-1 rounded shadow-lg flex flex-col"
          style={{ left: ctxMenu.x, top: ctxMenu.y, background: "var(--bg-elevated)", border: "1px solid var(--border-default)", minWidth: 180 }}
        >
          <CtxItem onClick={() => { closeTab(ctxMenu.index); setCtxMenu(null); }}>{t("editor.closeTab")}</CtxItem>
          <CtxItem onClick={() => { closeOthers(ctxMenu.index); setCtxMenu(null); }}>{t("editor.closeOthers")}</CtxItem>
          {ctxMenu.index < tabs.length - 1 && (
            <CtxItem onClick={() => { closeToRight(ctxMenu.index); setCtxMenu(null); }}>{t("editor.closeRight")}</CtxItem>
          )}
          <div style={{ borderTop: "1px solid var(--border-subtle)", margin: "2px 0" }} />
          <CtxItem danger onClick={() => { closeAll(); setCtxMenu(null); }}>{t("editor.closeAll")}</CtxItem>
        </div>
      )}
    </div>
  );
}
