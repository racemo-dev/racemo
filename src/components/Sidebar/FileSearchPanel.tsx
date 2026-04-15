import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useFileSearchStore, type FileMatch, type ContentGroup } from "../../stores/fileSearchStore";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useSessionStore } from "../../stores/sessionStore";
import { findPtyId } from "../../lib/paneTreeUtils";
import { openEditorPanel } from "../../lib/editorWindow";

export default function FileSearchPanel() {
  const query = useFileSearchStore((s) => s.query);
  const caseSensitive = useFileSearchStore((s) => s.caseSensitive);
  const selectedIndex = useFileSearchStore((s) => s.selectedIndex);
  const cwd = useFileSearchStore((s) => s.cwd);
  const searchRoot = useFileSearchStore((s) => s.searchRoot);
  const scanDir = useFileSearchStore((s) => s.scanDir);
  const fileResults = useFileSearchStore((s) => s.fileResults);
  const contentGroups = useFileSearchStore((s) => s.contentGroups);
  const contentFlat = useFileSearchStore((s) => s.contentFlat);
  const isSearchingFiles = useFileSearchStore((s) => s.isSearchingFiles);
  const isSearchingContent = useFileSearchStore((s) => s.isSearchingContent);
  const setQuery = useFileSearchStore((s) => s.setQuery);
  const setCaseSensitive = useFileSearchStore((s) => s.setCaseSensitive);
  const setSelectedIndex = useFileSearchStore((s) => s.setSelectedIndex);
  const setSearchRoot = useFileSearchStore((s) => s.setSearchRoot);
  const initCwd = useFileSearchStore((s) => s.initCwd);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  // Sync cwd from active session
  useEffect(() => {
    const sync = () => {
      const st = useSessionStore.getState();
      const session = st.sessions.find((s) => s.id === st.activeSessionId);
      if (!session || !st.focusedPaneId) return;
      const ptyId = findPtyId(session.rootPane, st.focusedPaneId);
      const cwd = ptyId ? (st.paneCwds[ptyId] ?? "") : "";
      if (cwd) initCwd(cwd);
    };
    sync();
    const unsub = useSessionStore.subscribe(sync);
    return () => unsub();
  }, [initCwd]);

  // Focus input whenever this panel becomes active
  const activePanel = useSidebarStore((s) => s.activePanel);
  useEffect(() => {
    if (activePanel !== "search") return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [activePanel]);

  useEffect(() => {
    const handler = () => inputRef.current?.focus();
    window.addEventListener("search-panel-focus", handler);
    return () => window.removeEventListener("search-panel-focus", handler);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // flat nav: files first, then content
  const totalItems = fileResults.length + contentFlat.length;

  const openResult = useCallback((index: number) => {
    if (index < fileResults.length) {
      openEditorPanel(fileResults[index].path);
    } else {
      const ci = index - fileResults.length;
      if (contentFlat[ci]) openEditorPanel(contentFlat[ci].path);
    }
  }, [fileResults, contentFlat]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex(Math.min(selectedIndex + 1, totalItems - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex(Math.max(selectedIndex - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        openResult(selectedIndex);
        break;
    }
  }, [selectedIndex, totalItems, setSelectedIndex, openResult]);

  // Folder selector
  const toRelative = useCallback((abs: string) => {
    if (abs === cwd) return "";
    const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
    return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
  }, [cwd]);

  const [folderDraft, setFolderDraft] = useState(() => toRelative(searchRoot));
  useEffect(() => { setFolderDraft(toRelative(searchRoot)); }, [searchRoot, toRelative]);

  const commitFolder = useCallback((draft: string) => {
    const rel = draft.trim();
    const abs = rel === ""
      ? cwd
      : (rel.startsWith("/") || /^[A-Za-z]:/.test(rel) ? rel : `${cwd}/${rel}`);
    setSearchRoot(abs);
  }, [cwd, setSearchRoot]);

  const pickFolder = useCallback(async () => {
    const selected = await openDialog({ directory: true, defaultPath: searchRoot, title: "Select search folder" });
    if (selected) {
      setSearchRoot(selected as string);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [searchRoot, setSearchRoot]);

  const isSearching = isSearchingFiles || isSearchingContent;
  const hasAny = fileResults.length > 0 || contentFlat.length > 0;
  const showEmpty = query.trim() && !isSearching && !hasAny;

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div
        className="flex items-center gap-2 px-2 shrink-0"
        style={{ borderBottom: "1px solid var(--border-default)", height: "calc(32px * var(--ui-scale))" }}
      >
        {isSearching ? (
          <span className="shrink-0" style={{
            width: 13, height: 13, borderRadius: "50%",
            border: "2px solid var(--border-default)",
            borderTopColor: "var(--accent-blue)",
            animation: "spin 0.6s linear infinite",
            display: "inline-block",
          }} />
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"
            stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
            <circle cx="6.5" cy="6.5" r="5" />
            <line x1="10" y1="10" x2="14" y2="14" />
          </svg>
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search files and contents..."
          className="flex-1 bg-transparent outline-none"
          style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)", caretColor: "var(--text-primary)" }}
        />
        <button
          type="button"
          onClick={() => setCaseSensitive(!caseSensitive)}
          title="Case sensitive"
          className="shrink-0 flex items-center justify-center rounded"
          style={{
            width: 22, height: 20, fontSize: "var(--fs-10)", fontWeight: 700,
            border: "1px solid",
            borderColor: caseSensitive ? "var(--accent-blue)" : "var(--border-default)",
            color: caseSensitive ? "var(--accent-blue)" : "var(--text-muted)",
            background: caseSensitive ? "color-mix(in srgb, var(--accent-blue) 15%, transparent)" : "transparent",
            cursor: "pointer",
          }}
        >
          Aa
        </button>
      </div>

      {/* Folder selector */}
      <div
        className="flex items-center gap-1.5 px-2 shrink-0"
        style={{ borderBottom: "1px solid var(--border-default)", height: "calc(26px * var(--ui-scale))" }}
      >
        <button
          type="button"
          onClick={pickFolder}
          title="Browse folder"
          className="shrink-0 flex items-center"
          style={{ background: "transparent", cursor: "pointer", padding: "0 2px" }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4h5l2 2h7v8H1z" />
          </svg>
        </button>
        <input
          value={folderDraft}
          onChange={(e) => setFolderDraft(e.target.value)}
          onBlur={(e) => commitFolder(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitFolder(folderDraft); inputRef.current?.focus(); }
            if (e.key === "Escape") { e.preventDefault(); setFolderDraft(toRelative(searchRoot)); inputRef.current?.focus(); }
          }}
          placeholder={cwd}
          title={searchRoot}
          className="flex-1 min-w-0 bg-transparent outline-none"
          style={{ fontSize: "var(--fs-11)", color: "var(--text-secondary)", caretColor: "var(--text-primary)" }}
        />
        {searchRoot !== cwd && (
          <button
            type="button"
            onClick={() => { setSearchRoot(cwd); setTimeout(() => inputRef.current?.focus(), 0); }}
            title="Reset to root"
            style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", background: "transparent", cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
          >
            ×
          </button>
        )}
      </div>

      {/* Results */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {!query.trim() && (
          <div className="flex items-center justify-center py-8"
            style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>
            Type to search
          </div>
        )}
        {showEmpty && (
          <div className="flex items-center justify-center py-8"
            style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}>
            No results found
          </div>
        )}

        {/* Files section */}
        {query.trim() && (fileResults.length > 0 || isSearchingFiles) && (
          <>
            <SectionHeader
              label="Files"
              count={fileResults.length}
              isSearching={isSearchingFiles}
            />
            <FileResultList
              results={fileResults}
              selectedIndex={selectedIndex}
              fileOffset={0}
              query={query}
              itemRefs={itemRefs}
              onSelect={(i) => { setSelectedIndex(i); openResult(i); }}
              onHover={setSelectedIndex}
            />
          </>
        )}

        {/* Content section */}
        {query.trim() && (contentFlat.length > 0 || isSearchingContent) && (
          <>
            <SectionHeader
              label="Content"
              count={contentFlat.length}
              isSearching={isSearchingContent}
            />
            <ContentResultList
              groups={contentGroups}
              selectedIndex={selectedIndex}
              contentOffset={fileResults.length}
              query={query}
              caseSensitive={caseSensitive}
              itemRefs={itemRefs}
              onSelect={(i) => { setSelectedIndex(i); openResult(i); }}
              onHover={setSelectedIndex}
            />
          </>
        )}
      </div>

      {/* Scan progress */}
      {(isSearching && scanDir) && (
        <div
          className="shrink-0 px-2 py-1 truncate"
          style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", borderTop: "1px solid var(--border-subtle)" }}
          title={scanDir}
        >
          {scanDir}
        </div>
      )}
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ label, count, isSearching }: { label: string; count: number; isSearching: boolean }) {
  return (
    <div
      className="flex items-center gap-2 px-3 sticky top-0"
      style={{
        height: "calc(24px * var(--ui-scale))",
        background: "var(--bg-overlay)",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: "var(--fs-11)",
        color: "var(--text-tertiary)",
        letterSpacing: "0.06em",
        userSelect: "none",
      }}
    >
      <span style={{ fontWeight: 600 }}>{label.toUpperCase()}</span>
      {count > 0 && <span style={{ color: "var(--text-muted)" }}>{count}</span>}
      {isSearching && (
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          border: "1.5px solid var(--border-default)",
          borderTopColor: "var(--accent-blue)",
          animation: "spin 0.6s linear infinite",
          display: "inline-block",
          marginLeft: 2,
        }} />
      )}
    </div>
  );
}

// ── File results ──────────────────────────────────────────────────────────────

function FileResultList({
  results, selectedIndex, fileOffset, query, itemRefs, onSelect, onHover,
}: {
  results: FileMatch[];
  selectedIndex: number;
  fileOffset: number;
  query: string;
  itemRefs: React.MutableRefObject<(HTMLElement | null)[]>;
  onSelect: (i: number) => void;
  onHover: (i: number) => void;
}) {
  return (
    <>
      {results.map((item, i) => {
        const flatIdx = fileOffset + i;
        const isSelected = flatIdx === selectedIndex;
        const dirPart = item.relative.includes("/")
          ? item.relative.slice(0, item.relative.lastIndexOf("/"))
          : "";
        return (
          <div
            key={item.path}
            ref={(el) => { itemRefs.current[flatIdx] = el; }}
            onClick={() => onSelect(flatIdx)}
            onMouseEnter={() => onHover(flatIdx)}
            className="flex items-center gap-2 px-3 cursor-pointer"
            style={{
              height: "calc(28px * var(--ui-scale))",
              background: isSelected ? "var(--bg-overlay)" : "transparent",
              borderLeft: isSelected ? "2px solid var(--accent-blue)" : "2px solid transparent",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke={isSelected ? "var(--accent-blue)" : "var(--text-muted)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className="shrink-0">
              <path d="M4 2h6l4 4v8H4V2z" /><path d="M10 2v4h4" />
            </svg>
            <span className="flex-1 min-w-0 flex items-baseline gap-2">
              <HighlightText
                text={item.name}
                query={query}
                style={{ fontSize: "var(--fs-12)", color: isSelected ? "var(--text-primary)" : "var(--text-secondary)", fontWeight: 500, flexShrink: 0 }}
              />
              {dirPart && (
                <span className="truncate" style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)" }}>
                  {dirPart}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}

// ── Content results ───────────────────────────────────────────────────────────

function ContentResultList({
  groups, selectedIndex, contentOffset, query, caseSensitive, itemRefs, onSelect, onHover,
}: {
  groups: ContentGroup[];
  selectedIndex: number;
  contentOffset: number;
  query: string;
  caseSensitive: boolean;
  itemRefs: React.MutableRefObject<(HTMLElement | null)[]>;
  onSelect: (flatIdx: number) => void;
  onHover: (flatIdx: number) => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.path}>
          <div
            className="flex items-center gap-2 px-3 sticky top-6"
            style={{
              height: "calc(22px * var(--ui-scale))",
              background: "var(--bg-elevated)",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
              stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M4 2h6l4 4v8H4V2z" /><path d="M10 2v4h4" />
            </svg>
            <span style={{ fontSize: "var(--fs-11)", color: "var(--text-primary)", fontWeight: 500 }}>{group.name}</span>
            <span className="truncate" style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)" }}>
              {group.relative.includes("/") ? group.relative.slice(0, group.relative.lastIndexOf("/")) : ""}
            </span>
            <span className="ml-auto shrink-0" style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)" }}>
              {group.matches.length}
            </span>
          </div>
          {group.matches.map((m) => {
            const flatIdx = contentOffset + m.flatIndex;
            const isSelected = flatIdx === selectedIndex;
            return (
              <div
                key={`${group.path}:${m.lineNumber}`}
                ref={(el) => { itemRefs.current[flatIdx] = el; }}
                onClick={() => onSelect(flatIdx)}
                onMouseEnter={() => onHover(flatIdx)}
                className="flex items-start gap-2 px-3 py-0.5 cursor-pointer"
                style={{
                  background: isSelected ? "var(--bg-overlay)" : "transparent",
                  borderLeft: isSelected ? "2px solid var(--accent-blue)" : "2px solid transparent",
                }}
              >
                <span className="shrink-0 text-right select-none"
                  style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", minWidth: 28, lineHeight: "calc(18px * var(--ui-scale))" }}>
                  {m.lineNumber}
                </span>
                <HighlightText
                  text={m.lineText}
                  query={query}
                  caseSensitive={caseSensitive}
                  style={{
                    fontSize: "var(--fs-11)", color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                    fontFamily: "monospace", lineHeight: "calc(18px * var(--ui-scale))",
                    whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
                  }}
                />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ── Highlight ─────────────────────────────────────────────────────────────────

function HighlightText({ text, query, caseSensitive = false, style }: {
  text: string; query: string; caseSensitive?: boolean; style?: React.CSSProperties;
}) {
  const parts = useMemo(() => {
    if (!query) return [{ text, match: false }];
    const flags = caseSensitive ? "g" : "gi";
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, flags);
    const result: { text: string; match: boolean }[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) result.push({ text: text.slice(last, m.index), match: false });
      result.push({ text: m[0], match: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) result.push({ text: text.slice(last), match: false });
    return result;
  }, [text, query, caseSensitive]);

  return (
    <span style={style}>
      {parts.map((p, i) =>
        p.match
          ? <mark key={i} style={{ background: "color-mix(in srgb, var(--accent-yellow) 40%, transparent)", color: "inherit", borderRadius: 2 }}>{p.text}</mark>
          : <span key={i}>{p.text}</span>
      )}
    </span>
  );
}
