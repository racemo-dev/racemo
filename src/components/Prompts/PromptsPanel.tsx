import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Copy, Clipboard, Play, Check, X, ArrowUUpLeft, DotsThreeVertical, FolderSimple } from "@phosphor-icons/react";
import { usePromptStore } from "../../stores/promptStore";
import {
  copyPromptToClipboard,
  pastePromptToActivePty,
  runPromptInActivePty,
} from "../../lib/promptActions";
import type { Prompt, PromptStatus } from "../../types/prompts";

type Filter = "pending" | "testing" | "done" | "all";

const ICON_SIZE = 13;
const iconStyle = {
  width: "calc(13px * var(--ui-scale))",
  height: "calc(13px * var(--ui-scale))",
  flexShrink: 0,
} as const;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketFor(completedAt: number, now: number): "today" | "week" | "older" {
  const today = startOfDay(now);
  if (completedAt >= today) return "today";
  const weekAgo = today - 6 * 24 * 60 * 60 * 1000;
  if (completedAt >= weekAgo) return "week";
  return "older";
}

export default function PromptsPanel() {
  const prompts = usePromptStore((s) => s.prompts);
  const addPrompt = usePromptStore((s) => s.addPrompt);
  const removePrompt = usePromptStore((s) => s.removePrompt);
  const setStatus = usePromptStore((s) => s.setStatus);

  const [draft, setDraft] = useState("");
  const [draftFolder, setDraftFolder] = useState("");
  const [filter, setFilter] = useState<Filter>("pending");
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const handleAdd = () => {
    const text = draft.trim();
    if (!text) return;
    addPrompt(text, draftFolder.trim() || undefined);
    setDraft("");
    setDraftFolder("");
    inputRef.current?.focus();
  };

  const filtered = useMemo(() => {
    let result = prompts;
    if (filter === "pending") result = result.filter((p) => p.status === "pending");
    else if (filter === "testing") result = result.filter((p) => p.status === "testing");
    else if (filter === "done") result = result.filter((p) => p.status === "done");
    if (folderFilter) result = result.filter((p) => p.folder === folderFilter);
    return result;
  }, [prompts, filter, folderFilter]);

  const { pending, testing, doneToday, doneWeek, doneOlder } = useMemo(() => {
    const pending: Prompt[] = [];
    const testing: Prompt[] = [];
    const doneToday: Prompt[] = [];
    const doneWeek: Prompt[] = [];
    const doneOlder: Prompt[] = [];
    for (const p of filtered) {
      if (p.status === "pending") {
        pending.push(p);
      } else if (p.status === "testing") {
        testing.push(p);
      } else {
        const b = bucketFor(p.completedAt ?? p.createdAt, now);
        if (b === "today") doneToday.push(p);
        else if (b === "week") doneWeek.push(p);
        else doneOlder.push(p);
      }
    }
    doneToday.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    doneWeek.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    doneOlder.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return { pending, testing, doneToday, doneWeek, doneOlder };
  }, [filtered, now]);

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--bg-surface)" }}>
      {/* Filter tabs */}
      <div
        className="flex items-center shrink-0 px-2 gap-1"
        style={{
          height: "calc(28px * var(--ui-scale))",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        {(["pending", "testing", "done", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="px-2 py-0.5 rounded cursor-pointer capitalize"
            style={{
              fontSize: "var(--fs-11)",
              color: filter === f ? "var(--text-primary)" : "var(--text-muted)",
              background: filter === f ? "var(--bg-overlay)" : "transparent",
            }}
          >
            {f}
          </button>
        ))}
        {folderFilter && (
          <button
            onClick={() => setFolderFilter(null)}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded cursor-pointer"
            title="Clear folder filter"
            style={{
              fontSize: "var(--fs-10)",
              color: "var(--accent-blue)",
              background: "color-mix(in srgb, var(--accent-blue) 15%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent-blue) 30%, transparent)",
            }}
          >
            <FolderSimple size={10} style={{ flexShrink: 0 }} />
            <span>{folderFilter}</span>
            <X size={9} style={{ flexShrink: 0 }} />
          </button>
        )}
        <span
          className="ml-auto"
          style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)" }}
        >
          {filtered.length}
        </span>
      </div>

      {/* Input */}
      <div
        className="shrink-0 p-2"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="Add a prompt… (Enter to add, Shift+Enter for newline)"
          rows={2}
          className="w-full bg-transparent outline-none px-2 py-1.5 rounded resize-none"
          style={{
            fontSize: "var(--fs-12)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            fontFamily: "inherit",
            caretColor: "var(--text-primary)",
          }}
        />
        <div
          className="flex items-center gap-1 mt-1 px-1 rounded"
          style={{ border: "1px solid transparent" }}
          onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)"; }}
          onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "transparent"; }}
        >
          <FolderSimple
            size={11}
            style={{ flexShrink: 0, color: draftFolder ? "var(--accent-blue)" : "var(--text-muted)" }}
          />
          <input
            value={draftFolder}
            onChange={(e) => setDraftFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); inputRef.current?.focus(); }
              if (e.key === "Escape") { e.preventDefault(); setDraftFolder(""); }
            }}
            placeholder="folder tag (optional)"
            className="flex-1 bg-transparent outline-none"
            style={{
              fontSize: "var(--fs-11)",
              color: draftFolder ? "var(--text-primary)" : "var(--text-muted)",
              fontFamily: "inherit",
            }}
          />
          {draftFolder && (
            <button
              onClick={() => setDraftFolder("")}
              style={{ color: "var(--text-muted)", lineHeight: 0, flexShrink: 0 }}
            >
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 && (
          <div
            className="px-3 py-6 text-center"
            style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }}
          >
            No prompts
          </div>
        )}

        {pending.length > 0 && (
          <Section
            label={filter === "all" ? "Pending" : null}
            items={pending}
            onRemove={removePrompt}
            onSetStatus={setStatus}
            onFolderClick={setFolderFilter}
          />
        )}
        {testing.length > 0 && (
          <Section
            label={filter === "all" || filter === "pending" ? "Testing" : null}
            items={testing}
            onRemove={removePrompt}
            onSetStatus={setStatus}
            onFolderClick={setFolderFilter}
          />
        )}
        {doneToday.length > 0 && (
          <Section
            label="Today"
            items={doneToday}
            onRemove={removePrompt}
            onSetStatus={setStatus}
            onFolderClick={setFolderFilter}
          />
        )}
        {doneWeek.length > 0 && (
          <Section
            label="This week"
            items={doneWeek}
            onRemove={removePrompt}
            onSetStatus={setStatus}
            onFolderClick={setFolderFilter}
          />
        )}
        {doneOlder.length > 0 && (
          <Section
            label="Older"
            items={doneOlder}
            onRemove={removePrompt}
            onSetStatus={setStatus}
            onFolderClick={setFolderFilter}
          />
        )}
      </div>
    </div>
  );
}

function Section({
  label,
  items,
  onRemove,
  onSetStatus,
  onFolderClick,
}: {
  label: string | null;
  items: Prompt[];
  onRemove: (id: string) => void;
  onSetStatus: (id: string, status: PromptStatus) => void;
  onFolderClick: (folder: string) => void;
}) {
  return (
    <div>
      {label && (
        <div
          className="px-3 py-1 uppercase select-none"
          style={{
            fontSize: "var(--fs-9)",
            color: "var(--text-muted)",
            letterSpacing: "0.08em",
          }}
        >
          {label}
        </div>
      )}
      {items.map((p) => (
        <PromptRow key={p.id} prompt={p} onRemove={onRemove} onSetStatus={onSetStatus} onFolderClick={onFolderClick} />
      ))}
    </div>
  );
}

function PromptRow({
  prompt,
  onRemove,
  onSetStatus,
  onFolderClick,
}: {
  prompt: Prompt;
  onRemove: (id: string) => void;
  onSetStatus: (id: string, status: PromptStatus) => void;
  onFolderClick: (folder: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { status } = prompt;
  const isDone = status === "done";
  const isTesting = status === "testing";
  const showActions = hovered || menuOpen;

  const checkboxBorderColor = isDone
    ? "var(--accent-blue)"
    : isTesting
      ? "var(--accent-amber, #f59e0b)"
      : "var(--border-default)";
  const checkboxBg = isDone ? "var(--accent-blue)" : "transparent";

  function advanceStatus() {
    if (status === "pending") onSetStatus(prompt.id, "testing");
    else if (status === "testing") onSetStatus(prompt.id, "done");
    else onSetStatus(prompt.id, "testing");
  }

  return (
    <div
      className="group flex items-start gap-2 px-2 py-1.5"
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        background: showActions ? "var(--bg-overlay)" : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={advanceStatus}
        className="cursor-pointer mt-0.5"
        title={
          isDone ? "Revert to testing" : isTesting ? "Mark done" : "Mark as testing"
        }
        style={{
          width: "calc(14px * var(--ui-scale))",
          height: "calc(14px * var(--ui-scale))",
          borderRadius: 3,
          border: `1px solid ${checkboxBorderColor}`,
          background: checkboxBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {isDone && (
          <Check
            size={10}
            weight="bold"
            style={{
              width: "calc(10px * var(--ui-scale))",
              height: "calc(10px * var(--ui-scale))",
              color: "var(--bg-surface)",
            }}
          />
        )}
        {isTesting && (
          <div
            style={{
              width: "calc(5px * var(--ui-scale))",
              height: "calc(5px * var(--ui-scale))",
              borderRadius: "50%",
              background: "var(--accent-amber, #f59e0b)",
            }}
          />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div
          className="whitespace-pre-wrap break-words"
          style={{
            fontSize: "var(--fs-12)",
            color: isDone ? "var(--text-muted)" : "var(--text-primary)",
            textDecoration: isDone ? "line-through" : "none",
            lineHeight: 1.4,
          }}
        >
          {prompt.text}
        </div>
        {prompt.folder && (
          <button
            onClick={() => onFolderClick(prompt.folder!)}
            className="flex items-center gap-0.5 mt-0.5 rounded cursor-pointer"
            title={`Filter by folder: ${prompt.folder}`}
            style={{
              fontSize: "var(--fs-10)",
              color: "var(--accent-blue)",
              background: "color-mix(in srgb, var(--accent-blue) 12%, transparent)",
              padding: "0 5px 1px",
            }}
          >
            <FolderSimple size={9} style={{ flexShrink: 0 }} />
            <span>{prompt.folder}</span>
          </button>
        )}
      </div>
      <div
        className="shrink-0"
        style={{ opacity: showActions ? 1 : 0, transition: "opacity 0.1s" }}
      >
        <ActionsMenu
          onOpenChange={setMenuOpen}
          items={[
            {
              icon: <Copy size={ICON_SIZE} style={iconStyle} />,
              label: "Copy to clipboard",
              onClick: () => copyPromptToClipboard(prompt.text),
            },
            {
              icon: <Clipboard size={ICON_SIZE} style={iconStyle} />,
              label: "Paste to terminal",
              onClick: () => pastePromptToActivePty(prompt.text),
            },
            {
              icon: <Play size={ICON_SIZE} style={iconStyle} />,
              label: "Run in terminal",
              onClick: () => {
                const ok = runPromptInActivePty(prompt.text);
                if (ok && status === "pending") onSetStatus(prompt.id, "testing");
              },
            },
            ...(status !== "pending"
              ? [
                  {
                    icon: <ArrowUUpLeft size={ICON_SIZE} style={iconStyle} />,
                    label: "Restore",
                    onClick: () =>
                      onSetStatus(prompt.id, status === "done" ? "testing" : "pending"),
                  },
                ]
              : []),
            {
              icon: <X size={ICON_SIZE} style={iconStyle} />,
              label: "Delete",
              onClick: () => onRemove(prompt.id),
              danger: true,
            },
          ]}
        />
      </div>
    </div>
  );
}

type ActionItem = {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
};

function ActionsMenu({
  items,
  onOpenChange,
}: {
  items: ActionItem[];
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const setOpen = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      setOpenState((prev) => {
        const next = typeof v === "function" ? v(prev) : v;
        onOpenChange?.(next);
        return next;
      });
    },
    [onOpenChange],
  );

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuW = 180;
    const left = Math.max(8, rect.right - menuW);
    const top = rect.bottom + 4;
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current?.contains(target) ||
        btnRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="More actions"
        className="cursor-pointer p-1 rounded"
        style={{
          color: open ? "var(--text-primary)" : "var(--text-muted)",
          lineHeight: 0,
          background: open ? "var(--bg-overlay)" : "transparent",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          if (!open) {
            (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
          }
        }}
      >
        <DotsThreeVertical size={ICON_SIZE} style={iconStyle} weight="bold" />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 py-1 rounded shadow-lg"
          style={{
            top: pos.top,
            left: pos.left,
            width: 180,
            background: "var(--bg-elevated, var(--bg-surface))",
            border: "1px solid var(--border-default)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 cursor-pointer text-left"
              style={{
                fontSize: "var(--fs-12)",
                color: item.danger ? "var(--accent-red, #e5484d)" : "var(--text-primary)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              <span
                style={{
                  color: item.danger ? "var(--accent-red, #e5484d)" : "var(--text-muted)",
                  lineHeight: 0,
                }}
              >
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
