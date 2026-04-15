import { useEffect, useRef, useState, useCallback } from "react";
import { useAutocompleteStore } from "../../stores/autocompleteStore";

const KIND_ICONS: Record<string, string> = {
  subcommand: "\u25b6",  // ▶
  option: "\u2212",      // −
  file: "\ud83d\udcc4",  // 📄
  directory: "\ud83d\udcc1", // 📁
  history: "\u231a",     // ⌚
  command: ">",
  argument: "\u2026",    // …
  envvar: "$",
};

const KIND_COLORS: Record<string, string> = {
  subcommand: "var(--accent-blue, #60a5fa)",
  option: "var(--accent-purple, #a78bfa)",
  file: "var(--text-secondary)",
  directory: "var(--accent-yellow, #facc15)",
  history: "var(--text-muted)",
  command: "var(--accent-green, #4ade80)",
  argument: "var(--text-secondary)",
  envvar: "var(--accent-cyan, #22d3ee)",
};

const MAX_POPUP_HEIGHT = 200;

export default function AutocompletePopup({ ptyId }: { ptyId: string }) {
  const isOpen = useAutocompleteStore((s) => s.isOpen);
  const activePtyId = useAutocompleteStore((s) => s.activePtyId);
  const items = useAutocompleteStore((s) => s.items);
  const selectedIndex = useAutocompleteStore((s) => s.selectedIndex);
  const cursorPixelX = useAutocompleteStore((s) => s.cursorPixelX);
  const cursorPixelY = useAutocompleteStore((s) => s.cursorPixelY);
  const lineHeight = useAutocompleteStore((s) => s.lineHeight);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [flipUp, setFlipUp] = useState(false);
  const [adjustedX, setAdjustedX] = useState(0);
  const [maxWidth, setMaxWidth] = useState(720);

  const measurePosition = useCallback(() => {
    if (!containerRef.current) return;
    const popupHeight = containerRef.current.offsetHeight || MAX_POPUP_HEIGHT;
    const popupWidth = containerRef.current.offsetWidth || 200;

    // Flip up if popup would overflow below the viewport
    setFlipUp(cursorPixelY + popupHeight > window.innerHeight - 8);

    // Clamp X so popup doesn't overflow right edge of viewport
    const vw = window.innerWidth;
    const maxX = Math.max(0, vw - popupWidth - 8);
    setAdjustedX(Math.min(cursorPixelX, maxX));
    setMaxWidth(Math.min(vw - 32, 720));
  }, [cursorPixelX, cursorPixelY]);

  useEffect(() => {
    if (isOpen) {
      // Measure after render so offsetHeight is available
      requestAnimationFrame(measurePosition);
    }
  }, [isOpen, items, cursorPixelX, cursorPixelY, measurePosition]);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("resize", measurePosition);
    return () => window.removeEventListener("resize", measurePosition);
  }, [isOpen, measurePosition]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isOpen || items.length === 0 || activePtyId !== ptyId) return null;

  const x = adjustedX > 0 ? adjustedX : cursorPixelX;

  // Normal: popup top at cursorPixelY (just below cursor line)
  // Flip-up: popup bottom at cursorPixelY - lineHeight (just above cursor line)
  const positionStyle: React.CSSProperties = flipUp
    ? { left: x, top: "auto", bottom: window.innerHeight - (cursorPixelY - lineHeight) }
    : { left: x, top: cursorPixelY };

  return (
    <div
      ref={containerRef}
      className="fixed z-[9999]"
      style={{
        ...positionStyle,
        minWidth: 200,
        maxWidth,
        maxHeight: MAX_POPUP_HEIGHT,
        width: "max-content",
      }}
    >
      <div
        ref={listRef}
        className="rounded shadow-lg overflow-y-auto"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          maxHeight: MAX_POPUP_HEIGHT,
        }}
      >
        {items.map((item, i) => {
          const isSelected = i === selectedIndex;
          return (
            <div
              key={`${item.label}-${i}`}
              className="flex items-center gap-2 px-2 py-1 cursor-pointer"
              style={{
                fontSize: 'var(--fs-11)',
                background: isSelected ? "var(--bg-overlay)" : "transparent",
                color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
              }}
              onMouseEnter={() => useAutocompleteStore.getState().setSelectedIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const detail = { insertText: item.insertText, kind: item.kind, ptyId: useAutocompleteStore.getState().activePtyId };
                window.dispatchEvent(new CustomEvent("racemo-autocomplete-accept", { detail }));
              }}
            >
              <span
                className="shrink-0"
                style={{
                  width: 16,
                  textAlign: "center",
                  fontSize: 'var(--fs-10)',
                  color: item.favorite ? "var(--accent-yellow, #facc15)" : KIND_COLORS[item.kind] || "var(--text-muted)",
                }}
              >
                {item.favorite ? "★" : KIND_ICONS[item.kind] || "?"}
              </span>
              <span
                className="flex-1"
                style={{ fontFamily: "monospace", fontSize: 'var(--fs-11)', whiteSpace: "nowrap" }}
              >
                {item.label}
              </span>
              {item.description && (
                <span
                  className="shrink-0 truncate"
                  style={{
                    maxWidth: 140,
                    fontSize: 'var(--fs-9)',
                    color: "var(--text-muted)",
                  }}
                >
                  {item.description}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
