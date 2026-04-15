import { useEffect, useRef, useMemo } from "react";
import Fuse from "fuse.js";
import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore } from "../../stores/historyStore";
import { useSessionStore } from "../../stores/sessionStore";
import { findPtyId } from "../../lib/paneTreeUtils";
import type { HistoryEntry } from "../../types/history";
import { BrowserHideGuard } from "../Editor/BrowserViewer";

function relativeTime(ts?: number): string {
  if (!ts) return "";
  const now = Date.now();
  const diff = now - (ts > 1e12 ? ts : ts * 1000); // handle both ms and seconds
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function writeToActivePty(text: string, execute: boolean) {
  const { sessions, activeSessionId, focusedPaneId } = useSessionStore.getState();
  const session = sessions.find((s) => s.id === activeSessionId);
  if (!session || !focusedPaneId) return;
  const ptyId = findPtyId(session.rootPane, focusedPaneId);
  if (!ptyId) return;
  const encoder = new TextEncoder();
  const payload = execute ? text + "\r" : text;
  invoke("write_to_pty", { paneId: ptyId, data: Array.from(encoder.encode(payload)) }).catch(
    console.error,
  );
}

// Star icon SVG component
function StarIcon({ filled, size = 12 }: { filled: boolean; size?: number }) {
  // Muted gold color for favorites
  const starColor = "var(--accent-yellow)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? starColor : "none"}
      stroke={filled ? starColor : "var(--text-muted)"}
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <path d="M8 1.5l1.85 4.1 4.45.55-3.3 3.05.9 4.3L8 11.25l-3.9 2.25.9-4.3-3.3-3.05 4.45-.55L8 1.5z" />
    </svg>
  );
}

export default function HistorySearch() {
  const isOpen = useHistoryStore((s) => s.isOpen);
  const entries = useHistoryStore((s) => s.entries);
  const query = useHistoryStore((s) => s.query);
  const selectedIndex = useHistoryStore((s) => s.selectedIndex);
  const historyPath = useHistoryStore((s) => s.historyPath);
  const showFavoritesOnly = useHistoryStore((s) => s.showFavoritesOnly);
  const close = useHistoryStore((s) => s.close);
  const setQuery = useHistoryStore((s) => s.setQuery);
  const setSelectedIndex = useHistoryStore((s) => s.setSelectedIndex);
  const deleteEntry = useHistoryStore((s) => s.deleteEntry);
  const clearAll = useHistoryStore((s) => s.clearAll);
  const toggleFavorite = useHistoryStore((s) => s.toggleFavorite);
  const toggleShowFavoritesOnly = useHistoryStore((s) => s.toggleShowFavoritesOnly);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Sort by timestamp (newest first) and deduplicate by command
  const sortedAndDeduped = useMemo(() => {
    // Filter by favorites if enabled
    const filtered = showFavoritesOnly
      ? entries.filter((e) => e.favorite)
      : entries;
    // Sort: favorites first, then by timestamp descending
    const sorted = [...filtered].sort((a, b) => {
      // Favorites always first
      if (a.favorite && !b.favorite) return -1;
      if (!a.favorite && b.favorite) return 1;
      // Then by timestamp
      const tsA = a.timestamp ?? 0;
      const tsB = b.timestamp ?? 0;
      return tsB - tsA;
    });
    // Deduplicate: keep first occurrence (newest) of each command
    const seen = new Set<string>();
    return sorted.filter((entry) => {
      if (seen.has(entry.command)) return false;
      seen.add(entry.command);
      return true;
    });
  }, [entries, showFavoritesOnly]);

  const fuse = useMemo(
    () => new Fuse(sortedAndDeduped, { keys: ["command"], threshold: 0.3, includeScore: true }),
    [sortedAndDeduped],
  );

  const results: HistoryEntry[] = useMemo(() => {
    if (!query.trim()) return sortedAndDeduped.slice(0, 50);
    return fuse.search(query).slice(0, 50).map((r) => r.item);
  }, [query, fuse, sortedAndDeduped]);

  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      inputRef.current?.focus();
      // Set cursor to first non-favorite (most recent command)
      const firstNonFavoriteIndex = results.findIndex((e) => !e.favorite);
      if (firstNonFavoriteIndex > 0) {
        setSelectedIndex(firstNonFavoriteIndex);
      }
    }
    prevOpenRef.current = isOpen;
  }, [isOpen, results, setSelectedIndex]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isOpen) return null;

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
      if (item) {
        writeToActivePty(item.command, true);
        close();
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const item = results[selectedIndex];
      if (item) {
        writeToActivePty(item.command, false);
        close();
      }
      return;
    }
  };

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
        {/* Header with file path */}
        {historyPath && (
          <div
            className="px-3 py-1.5 truncate"
            style={{
              fontSize: 'var(--fs-10)',
              color: "var(--text-muted)",
              borderBottom: "1px solid var(--border-default)",
              background: "var(--bg-subtle)",
            }}
            title={historyPath}
          >
            {historyPath}
          </div>
        )}

        {/* Search input */}
        <div
          className="flex items-center px-3 gap-2"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="6.5" cy="6.5" r="5" />
            <line x1="10" y1="10" x2="14" y2="14" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search history..."
            className="flex-1 bg-transparent outline-none py-2.5"
            style={{
              fontSize: 'var(--fs-13)',
              color: "var(--text-primary)",
              caretColor: "var(--text-primary)",
            }}
          />
          {/* Favorites filter toggle */}
          <button
            onClick={toggleShowFavoritesOnly}
            title={showFavoritesOnly ? "Show all" : "Show favorites only"}
            style={{
              padding: "4px",
              borderRadius: 4,
              background: showFavoritesOnly ? "var(--bg-overlay)" : "transparent",
            }}
          >
            <StarIcon filled={showFavoritesOnly} size={14} />
          </button>
        </div>

        {/* Result list */}
        <div
          ref={listRef}
          className="overflow-y-auto flex-1"
          style={{ maxHeight: "calc(50vh - 80px)" }}
        >
          {results.map((entry, i) => (
            <div
              key={`${entry.command}-${i}`}
              className="w-full flex items-center px-3 py-1.5 group"
              style={{
                fontSize: 'var(--fs-12)',
                fontFamily: "monospace",
                color: i === selectedIndex ? "var(--text-primary)" : "var(--text-secondary)",
                background: i === selectedIndex ? "var(--bg-overlay)" : "transparent",
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              {/* Favorite toggle */}
              <button
                className="shrink-0 mr-2"
                style={{ color: "var(--text-muted)", padding: "2px" }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(entry.command);
                }}
                title={entry.favorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon filled={!!entry.favorite} />
              </button>
              <button
                className="flex-1 text-left truncate"
                onClick={() => {
                  writeToActivePty(entry.command, true);
                  close();
                }}
              >
                {entry.command}
              </button>
              {entry.timestamp && (
                <span
                  className="shrink-0 ml-2"
                  style={{ fontSize: 'var(--fs-10)', color: "var(--text-muted)", fontFamily: "inherit" }}
                >
                  {relativeTime(entry.timestamp)}
                </span>
              )}
              <button
                className="shrink-0 ml-2 rounded transition-colors"
                style={{ color: "var(--text-muted)", padding: "2px 4px" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent-red)"; e.currentTarget.style.background = "color-mix(in srgb, var(--accent-red) 10%, transparent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteEntry(entry.command);
                }}
                title="Delete this entry"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </div>
          ))}
          {results.length === 0 && (
            <div
              className="px-3 py-4 text-center"
              style={{ fontSize: 'var(--fs-12)', color: "var(--text-muted)" }}
            >
              {showFavoritesOnly ? "No favorites yet" : "No history found"}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-3 py-1.5"
          style={{
            borderTop: "1px solid var(--border-default)",
            fontSize: 'var(--fs-10)',
            color: "var(--text-muted)",
          }}
        >
          <span>Enter: execute &middot; Tab: insert &middot; Esc: close</span>
          <button
            className="hover:text-red-400 transition-colors"
            style={{ color: "var(--text-muted)" }}
            onClick={() => {
              if (window.confirm("Clear all history?")) {
                clearAll();
              }
            }}
          >
            Clear All
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
