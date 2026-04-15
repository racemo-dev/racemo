import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";

export interface SearchBarHandle {
  focus: () => void;
}

interface SearchBarProps {
  /** Position style override. Default: full-width bar below header */
  position?: "bar" | "float-right";
  /** Top offset (for bar mode) */
  top?: string;
  onSearch: (query: string) => void;
  onNext: (query: string) => void;
  onPrev: (query: string) => void;
  onClose: () => void;
}

const SearchBar = forwardRef<SearchBarHandle, SearchBarProps>(function SearchBar({ position = "bar", top, onSearch, onNext, onPrev, onClose }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => { inputRef.current?.focus(); inputRef.current?.select(); },
  }));
  const [query, setQuery] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const handleChange = useCallback((val: string) => {
    setQuery(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearch(val), 150);
  }, [onSearch]);

  const handleClose = () => {
    onSearch("");
    setQuery("");
    onClose();
  };

  const posStyle: React.CSSProperties = position === "float-right"
    ? { position: "absolute", right: 8, top: top ?? "0", borderRadius: "0 0 6px 6px", border: "1px solid var(--border-default)", borderTop: "none" }
    : { position: "absolute", left: 0, right: 0, top: top ?? "calc(24px * var(--ui-scale))", borderBottom: "1px solid var(--border-default)" };

  return (
    <div
      className="flex items-center gap-1 px-2 z-20"
      style={{
        height: 'calc(28px * var(--ui-scale))',
        background: "var(--bg-elevated)",
        ...posStyle,
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            if (query) {
              if (e.shiftKey) onPrev(query);
              else onNext(query);
            }
          }
          if (e.key === "Escape") {
            e.preventDefault();
            handleClose();
          }
        }}
        placeholder="Search..."
        className="flex-1 bg-transparent outline-none"
        style={{
          fontSize: 'var(--fs-11)',
          color: "var(--text-primary)",
          caretColor: "var(--text-primary)",
          minWidth: 0,
        }}
      />
      {/* Previous */}
      <NavButton direction="up" title="Previous (Shift+Enter)" onClick={() => { if (query) onPrev(query); }} />
      {/* Next */}
      <NavButton direction="down" title="Next (Enter)" onClick={() => { if (query) onNext(query); }} />
      {/* Close */}
      <button
        onClick={handleClose}
        className="p-0.5 rounded transition-colors"
        style={{ color: "var(--text-muted)", cursor: "pointer" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent-red)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        title="Close (Escape)"
      >
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ width: 'calc(10px * var(--ui-scale))', height: 'calc(10px * var(--ui-scale))' }}>
          <line x1="2" y1="2" x2="8" y2="8" />
          <line x1="8" y1="2" x2="2" y2="8" />
        </svg>
      </button>
    </div>
  );
});

export default SearchBar;

function NavButton({ direction, title, onClick }: { direction: "up" | "down"; title: string; onClick: () => void }) {
  const points = direction === "up" ? "3,7 6,4 9,7" : "3,5 6,8 9,5";
  return (
    <button
      onClick={onClick}
      className="p-0.5 rounded transition-colors"
      style={{ color: "var(--text-muted)", cursor: "pointer" }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      title={title}
    >
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 'calc(12px * var(--ui-scale))', height: 'calc(12px * var(--ui-scale))' }}>
        <polyline points={points} />
      </svg>
    </button>
  );
}
