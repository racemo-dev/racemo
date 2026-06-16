import { useEffect, useRef, useMemo } from "react";
import Fuse from "fuse.js";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import { getAllCommands } from "../../lib/commandRegistry";
import type { CommandItem } from "../../types/commandPalette";
import { BrowserHideGuard } from "../../components/Editor/BrowserViewer";

export default function CommandPalette() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.query);
  const selectedIndex = useCommandPaletteStore((s) => s.selectedIndex);
  const close = useCommandPaletteStore((s) => s.close);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const setSelectedIndex = useCommandPaletteStore((s) => s.setSelectedIndex);

  if (!isOpen) return null;

  return (
    <>
    <BrowserHideGuard />
    <div

      className="fixed inset-0 z-50 flex justify-center"
      style={{ paddingTop: "20vh", background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="flex flex-col rounded-lg shadow-2xl overflow-hidden"
        style={{
          width: 480,
          maxHeight: "50vh",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
        }}
      >
        <SearchMode
          query={query}
          selectedIndex={selectedIndex}
          setQuery={setQuery}
          setSelectedIndex={setSelectedIndex}
          close={close}
        />
      </div>
    </div>
    </>
  );
}

function SearchMode({
  query,
  selectedIndex,
  setQuery,
  setSelectedIndex,
  close,
}: {
  query: string;
  selectedIndex: number;
  setQuery: (q: string) => void;
  setSelectedIndex: (i: number) => void;
  close: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(() => getAllCommands(), []);
  const fuse = useMemo(
    () =>
      new Fuse(commands, {
        keys: ["label", "keywords"],
        threshold: 0.4,
        includeScore: true,
      }),
    [commands],
  );

  const results: CommandItem[] = useMemo(() => {
    if (!query.trim()) return commands.slice(0, 20);
    return fuse.search(query).slice(0, 20).map((r) => r.item);
  }, [query, fuse, commands]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(Math.min(selectedIndex + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(Math.max(selectedIndex - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = results[selectedIndex];
      if (item) item.action();
      return;
    }
  };

  return (
    <>
      <div className="flex items-center px-3 gap-2" style={{ borderBottom: "1px solid var(--border-default)" }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="6.5" cy="6.5" r="5" />
          <line x1="10" y1="10" x2="14" y2="14" />
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search commands..."
          className="flex-1 bg-transparent outline-none py-2.5"
          style={{ fontSize: 'var(--fs-13)', color: "var(--text-primary)", caretColor: "var(--text-primary)" }}
        />
      </div>

      <div ref={listRef} className="overflow-y-auto flex-1" style={{ maxHeight: "calc(50vh - 80px)" }}>
        {results.length === 0 && (
          <div className="px-3 py-4 text-center" style={{ fontSize: 'var(--fs-12)', color: "var(--text-muted)" }}>
            No commands found
          </div>
        )}
        {results.map((item, idx) => (
          <CommandRow
            key={item.id}
            item={item}
            isSelected={idx === selectedIndex}
            onClick={() => item.action()}
            onMouseEnter={() => setSelectedIndex(idx)}
          />
        ))}
      </div>

      <div
        className="flex items-center justify-end px-3 py-1.5"
        style={{ borderTop: "1px solid var(--border-default)", fontSize: 'var(--fs-10)', color: "var(--text-muted)" }}
      >
        <span>Esc to close</span>
      </div>
    </>
  );
}

function CommandRow({
  item,
  isSelected,
  onClick,
  onMouseEnter,
}: {
  item: CommandItem;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <button
      className="w-full flex items-center justify-between px-3 py-1.5 text-left"
      style={{
        fontSize: 'var(--fs-12)',
        color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
        background: isSelected ? "var(--bg-overlay)" : "transparent",
      }}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <span className="truncate">{item.label}</span>
      {item.shortcut && (
        <span className="shrink-0 ml-2" style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)" }}>
          {item.shortcut}
        </span>
      )}
    </button>
  );
}
