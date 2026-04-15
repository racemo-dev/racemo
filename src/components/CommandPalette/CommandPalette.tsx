import { useEffect, useRef, useMemo, useState } from "react";
import Fuse from "fuse.js";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import { useSnippetStore } from "../../stores/snippetStore";
import {
  getAllCommands,
  substituteVariables,
  writeCommandToPty,
} from "../../lib/commandRegistry";
import type { CommandItem } from "../../types/commandPalette";
import { BrowserHideGuard } from "../../components/Editor/BrowserViewer";

export default function CommandPalette() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const mode = useCommandPaletteStore((s) => s.mode);
  const query = useCommandPaletteStore((s) => s.query);
  const selectedIndex = useCommandPaletteStore((s) => s.selectedIndex);
  const close = useCommandPaletteStore((s) => s.close);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const setSelectedIndex = useCommandPaletteStore((s) => s.setSelectedIndex);
  const pendingVariables = useCommandPaletteStore((s) => s.pendingVariables);
  const pendingCommand = useCommandPaletteStore((s) => s.pendingCommand);
  const startEditSnippet = useCommandPaletteStore((s) => s.startEditSnippet);

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
        {mode === "search" && (
          <SearchMode
            query={query}
            selectedIndex={selectedIndex}
            setQuery={setQuery}
            setSelectedIndex={setSelectedIndex}
            close={close}
            startEditSnippet={startEditSnippet}
          />
        )}
        {mode === "snippet-edit" && <SnippetEditMode />}
        {mode === "variable-prompt" && (
          <VariablePromptMode
            command={pendingCommand}
            variables={pendingVariables}
            close={close}
          />
        )}
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
  startEditSnippet,
}: {
  query: string;
  selectedIndex: number;
  setQuery: (q: string) => void;
  setSelectedIndex: (i: number) => void;
  close: () => void;
  startEditSnippet: (id: string | null) => void;
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

  // Scroll selected item into view
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

  // Group by category for display
  const snippetItems = results.filter((r) => r.category === "snippet");
  const internalItems = results.filter((r) => r.category === "internal");

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
        {snippetItems.length > 0 && (
          <>
            <div className="px-3 py-1 uppercase" style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)", letterSpacing: "0.08em" }}>
              Snippets
            </div>
            {snippetItems.map((item) => {
              const globalIndex = results.indexOf(item);
              return (
                <CommandRow
                  key={item.id}
                  item={item}
                  isSelected={globalIndex === selectedIndex}
                  onClick={() => item.action()}
                  onMouseEnter={() => setSelectedIndex(globalIndex)}
                />
              );
            })}
          </>
        )}
        {internalItems.length > 0 && (
          <>
            <div className="px-3 py-1 uppercase" style={{ fontSize: 'var(--fs-9)', color: "var(--text-muted)", letterSpacing: "0.08em" }}>
              Commands
            </div>
            {internalItems.map((item) => {
              const globalIndex = results.indexOf(item);
              return (
                <CommandRow
                  key={item.id}
                  item={item}
                  isSelected={globalIndex === selectedIndex}
                  onClick={() => item.action()}
                  onMouseEnter={() => setSelectedIndex(globalIndex)}
                />
              );
            })}
          </>
        )}
        {results.length === 0 && (
          <div className="px-3 py-4 text-center" style={{ fontSize: 'var(--fs-12)', color: "var(--text-muted)" }}>
            No commands found
          </div>
        )}
      </div>

      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ borderTop: "1px solid var(--border-default)", fontSize: 'var(--fs-10)', color: "var(--text-muted)" }}
      >
        <button
          className="cursor-pointer transition-colors"
          style={{ color: "var(--text-tertiary)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          onClick={() => startEditSnippet(null)}
        >
          + New Snippet
        </button>
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

function SnippetEditMode() {
  const setMode = useCommandPaletteStore((s) => s.setMode);
  const editingId = useCommandPaletteStore((s) => s.editingSnippetId);
  const addSnippet = useSnippetStore((s) => s.addSnippet);
  const updateSnippet = useSnippetStore((s) => s.updateSnippet);
  const snippets = useSnippetStore((s) => s.snippets);

  const existing = editingId ? snippets.find((s) => s.id === editingId) : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [command, setCommand] = useState(existing?.command ?? "");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSave = () => {
    if (!name.trim() || !command.trim()) return;
    if (existing) {
      updateSnippet(existing.id, { name: name.trim(), command: command.trim() });
    } else {
      addSnippet(name.trim(), command.trim());
    }
    setMode("search");
  };

  return (
    <div className="p-3 flex flex-col gap-2">
      <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)", fontWeight: 500 }}>
        {existing ? "Edit Snippet" : "New Snippet"}
      </div>
      <input
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Snippet name"
        className="bg-transparent outline-none px-2 py-1.5 rounded"
        style={{
          fontSize: 'var(--fs-12)',
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          caretColor: "var(--text-primary)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setMode("search");
          if (e.key === "Enter") handleSave();
        }}
      />
      <textarea
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="Command (use {{variable}} for prompts)"
        className="bg-transparent outline-none px-2 py-1.5 rounded resize-none"
        rows={3}
        style={{
          fontSize: 'var(--fs-12)',
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          fontFamily: "monospace",
          caretColor: "var(--text-primary)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setMode("search");
          if (e.key === "Enter" && e.metaKey) handleSave();
        }}
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          className="px-3 py-1 rounded text-xs cursor-pointer"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => setMode("search")}
        >
          Cancel
        </button>
        <button
          className="px-3 py-1 rounded text-xs cursor-pointer"
          style={{ color: "var(--text-primary)", background: "var(--bg-overlay)" }}
          onClick={handleSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function VariablePromptMode({
  command,
  variables,
  close,
}: {
  command: string;
  variables: { name: string; value: string }[];
  close: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(variables.map((v) => [v.name, v.value])),
  );
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const handleRun = () => {
    const substituted = substituteVariables(command, values);
    writeCommandToPty(substituted);
  };

  return (
    <div className="p-3 flex flex-col gap-2">
      <div style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)", fontWeight: 500 }}>
        Fill variables
      </div>
      <div
        className="px-2 py-1 rounded"
        style={{ fontSize: 'var(--fs-11)', fontFamily: "monospace", color: "var(--text-muted)", background: "var(--bg-overlay)" }}
      >
        {command}
      </div>
      {variables.map((v, i) => (
        <div key={v.name} className="flex items-center gap-2">
          <span style={{ fontSize: 'var(--fs-11)', color: "var(--text-secondary)", minWidth: 80 }}>
            {`{{${v.name}}}`}
          </span>
          <input
            ref={i === 0 ? firstRef : undefined}
            value={values[v.name] ?? ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
            className="flex-1 bg-transparent outline-none px-2 py-1 rounded"
            style={{
              fontSize: 'var(--fs-12)',
              color: "var(--text-primary)",
              border: "1px solid var(--border-default)",
              caretColor: "var(--text-primary)",
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "Enter") handleRun();
            }}
          />
        </div>
      ))}
      <div className="flex items-center gap-2 justify-end">
        <button
          className="px-3 py-1 rounded text-xs cursor-pointer"
          style={{ color: "var(--text-secondary)" }}
          onClick={close}
        >
          Cancel
        </button>
        <button
          className="px-3 py-1 rounded text-xs cursor-pointer"
          style={{ color: "var(--text-primary)", background: "var(--bg-overlay)" }}
          onClick={handleRun}
        >
          Run
        </button>
      </div>
    </div>
  );
}
