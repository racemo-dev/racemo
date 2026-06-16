import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getTerminal } from "../../../lib/terminalRegistry";
import { isTauri } from "../../../lib/bridge";
import { logger } from "../../../lib/logger";
import { INPUT_BAR_DATA_ATTR } from "../../../lib/platform/ime/base";
import { isImagePath } from "./useTerminalEvents";

interface TerminalInputBarProps {
  ptyId: string;
  onClose: () => void;
  pendingImages?: string[];
  onPendingImagesConsumed?: () => void;
}

const encoder = new TextEncoder();
const MAX_HISTORY = 100;

// Per-ptyId history store — persists across open/close toggles within a session.
// Scoped to module to survive TerminalInputBar unmounts without leaking across
// session restarts.
const historyStore = new Map<string, string[]>();
function getHistory(ptyId: string): string[] {
  let h = historyStore.get(ptyId);
  if (!h) {
    h = [];
    historyStore.set(ptyId, h);
  }
  return h;
}

// Per-ptyId draft store — preserves unsent text across Esc-close / reopen cycles.
const draftStore = new Map<string, string>();

// Strip control characters except newline/tab
function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

interface ImageAttachment {
  id: string;
  path: string;
  url: string;
  compressing: boolean;
  originalBytes?: number;
  compressedBytes?: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

const THUMB = 28;

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : normalized;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const ext = s.includes(".") ? "." + s.split(".").pop() : "";
  const stem = s.slice(0, s.length - ext.length);
  return stem.slice(0, max - ext.length - 1) + "…" + ext;
}

function AttachmentThumb({ att, onRemove }: { att: ImageAttachment; onRemove: () => void }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const [imgError, setImgError] = useState(false);

  const reduction = att.originalBytes && att.compressedBytes
    ? Math.round((1 - att.compressedBytes / att.originalBytes) * 100)
    : null;
  const sizeLabel = att.compressing
    ? "압축 중…"
    : att.originalBytes && att.compressedBytes
      ? `${formatBytes(att.originalBytes)} → ${formatBytes(att.compressedBytes)}`
      : att.originalBytes
        ? formatBytes(att.originalBytes)
        : null;

  const handleMouseEnter = () => {
    if (!wrapperRef.current) return;
    const r = wrapperRef.current.getBoundingClientRect();
    setTooltip({ x: r.left + r.width / 2, y: r.top });
  };

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", flexShrink: 0 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setTooltip(null)}
    >
      {/* Tooltip — fixed to escape overflow, shows full path + reduction */}
      {tooltip && (
        <div style={{
          position: "fixed",
          left: tooltip.x,
          top: tooltip.y - 8,
          transform: "translate(-50%, -100%)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 6,
          padding: "5px 10px",
          whiteSpace: "pre",
          zIndex: 9999,
          fontSize: 10,
          color: "var(--text-primary)",
          lineHeight: 1.7,
          pointerEvents: "none",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          maxWidth: 420,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          <div style={{ color: "var(--text-muted)", wordBreak: "break-all", whiteSpace: "normal" }}>{att.path}</div>
          {sizeLabel && (
            <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>{sizeLabel}</div>
          )}
          {reduction !== null && (
            <div style={{ color: "#4ade80", fontWeight: 600 }}>↓ {reduction}% 절감</div>
          )}
        </div>
      )}

      {/* Chip: thumbnail + info + actions */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: "3px 4px 3px 4px",
        maxWidth: 220,
      }}>
        {/* Thumbnail */}
        <div style={{
          position: "relative",
          width: THUMB,
          height: THUMB,
          borderRadius: 4,
          overflow: "hidden",
          flexShrink: 0,
          background: "var(--bg-elevated)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
          {imgError ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16, color: "var(--text-muted)" }}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          ) : (
            <img
              src={att.url}
              alt=""
              draggable={false}
              onError={() => setImgError(true)}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          )}
          {att.compressing && (
            <div style={{
              position: "absolute", inset: 0,
              background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{
                width: 12, height: 12, borderRadius: "50%",
                border: "2px solid rgba(255,255,255,0.3)",
                borderTopColor: "#fff",
                animation: "spin 0.7s linear infinite",
              }} />
            </div>
          )}
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <div style={{
            fontSize: 10,
            color: "var(--text-primary)",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {truncate(basename(att.path), 18)}
          </div>
          <div style={{
            fontSize: 9,
            color: reduction !== null ? "#4ade80" : "var(--text-muted)",
            fontFamily: "monospace",
            whiteSpace: "nowrap",
          }}>
            {sizeLabel ?? dirname(att.path).split("/").pop() ?? ""}
            {reduction !== null && ` ↓${reduction}%`}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
          {/* Open folder button */}
          <button
            onClick={() => invoke("reveal_in_file_manager", { path: att.path }).catch(() => {})}
            style={{
              width: 16,
              height: 16,
              borderRadius: 3,
              border: "none",
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: 10,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              opacity: 0.7,
              transition: "opacity 0.12s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
            title={`폴더에서 열기\n${att.path}`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ width: 11, height: 11 }}>
              <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2H13A1.5 1.5 0 0114.5 6.5v6A1.5 1.5 0 0113 14H3.5A1.5 1.5 0 012 12.5V4.5z" />
            </svg>
          </button>
          {/* Remove button */}
          <button
            onClick={onRemove}
            style={{
              width: 16,
              height: 16,
              borderRadius: 3,
              border: "none",
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: 12,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              padding: 0,
              opacity: 0.7,
              transition: "opacity 0.12s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
            title="첨부 제거"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}



export default function TerminalInputBar({ ptyId, onClose, pendingImages, onPendingImagesConsumed }: TerminalInputBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(() => draftStore.get(ptyId) ?? "");
  const [attachments, setAttachments] = useState<ImageAttachment[]>(() =>
    (pendingImages ?? []).map((p) => ({ id: crypto.randomUUID(), path: p, url: convertFileSrc(p), compressing: true }))
  );
  const historyRef = useRef<string[]>(getHistory(ptyId));
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");
  // Track which pendingImages batch was last consumed to avoid duplicate attachments
  // when the parent re-renders with the same reference before onPendingImagesConsumed fires.
  const consumedPendingRef = useRef(pendingImages);

  useEffect(() => {
    historyRef.current = getHistory(ptyId);
    historyIndexRef.current = -1;
    draftRef.current = "";
    const entry = getTerminal(ptyId);
    if (entry) entry.terminal.blur();
    textareaRef.current?.focus();
    // Notify parent that initial pendingImages were consumed
    if (consumedPendingRef.current && consumedPendingRef.current.length > 0) {
      onPendingImagesConsumed?.();
    }
    // Compress initial pendingImages so thumbnails use data URLs (no asset protocol needed)
    setAttachments((prev) => {
      const compressing = prev.filter((a) => a.compressing);
      for (const att of compressing) {
        invoke<{ path: string; original_bytes: number; compressed_bytes: number; data_url: string }>(
          "compress_image_for_ai",
          { path: att.path }
        )
          .then((result) => {
            setAttachments((p) =>
              p.map((a) =>
                a.id === att.id
                  ? { ...a, path: result.path, url: result.data_url, compressing: false, originalBytes: result.original_bytes, compressedBytes: result.compressed_bytes }
                  : a
              )
            );
          })
          .catch(() => {
            setAttachments((p) =>
              p.map((a) => (a.id === att.id ? { ...a, compressing: false } : a))
            );
          });
      }
      return prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Handle pendingImages changes while the bar is already open (drop outside the bar)
  if (pendingImages !== consumedPendingRef.current && pendingImages && pendingImages.length > 0) {
    consumedPendingRef.current = pendingImages;
    setAttachments((prev) => [
      ...prev,
      ...pendingImages.map((p) => ({ id: crypto.randomUUID(), path: p, url: convertFileSrc(p), compressing: false })),
    ]);
    onPendingImagesConsumed?.();
  }

  // Drag-and-drop: insert file paths into textarea (same quoting as terminal)
  // Uses drop position to decide: if dropped on this bar → insert into textarea,
  // otherwise let the terminal's handler deal with it.
  const [isDragOver, setIsDragOver] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const hitTest = (pos: { x: number; y: number }) => {
      const el = containerRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      // Tauri may report logical (CSS) or physical pixels depending on platform/version.
      // Only divide by DPR when pos clearly exceeds the CSS viewport — using the dual
      // (raw OR scaled) check would false-positive on multi-pane layouts because the
      // scaled X always lands in [0, half-window-width], silently claiming top-left's bar.
      const scale = window.devicePixelRatio || 1;
      const isPhysical = pos.x > window.innerWidth || pos.y > window.innerHeight;
      const lx = isPhysical ? pos.x / scale : pos.x;
      const ly = isPhysical ? pos.y / scale : pos.y;
      return lx >= r.left && lx < r.right && ly >= r.top && ly < r.bottom;
    };
    // Race guard for async unlisten — see useTerminalEvents.useDragDrop for
    // the same pattern. Prevents stale listener fires from doubling drops
    // during HMR or strict-mode double-mount.
    let active = true;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (!active) return;
      const payload = event.payload;
      if (payload.type === "enter") {
        setIsDragOver(true);
      } else if (payload.type === "over") {
        setIsDragOver(hitTest(payload.position));
      } else if (payload.type === "leave") {
        setIsDragOver(false);
      } else if (payload.type === "drop") {
        const onBar = hitTest(payload.position);
        setIsDragOver(false);
        if (!onBar) return;
        const paths = payload.paths;
        if (!paths || paths.length === 0) return;
        const images: string[] = [];
        const others: string[] = [];
        for (const p of paths) {
          if (isImagePath(p)) images.push(p);
          else others.push(p);
        }
        if (images.length > 0) {
          const newAtts = images.map((p) => ({
            id: crypto.randomUUID(),
            path: p,
            url: convertFileSrc(p),
            compressing: true,
          }));
          setAttachments((prev) => [...prev, ...newAtts]);
          for (const att of newAtts) {
            invoke<{ path: string; original_bytes: number; compressed_bytes: number; data_url: string }>(
              "compress_image_for_ai",
              { path: att.path }
            )
              .then((result) => {
                setAttachments((prev) =>
                  prev.map((a) =>
                    a.id === att.id
                      ? { ...a, path: result.path, url: result.data_url, compressing: false, originalBytes: result.original_bytes, compressedBytes: result.compressed_bytes }
                      : a
                  )
                );
              })
              .catch(() => {
                setAttachments((prev) =>
                  prev.map((a) => (a.id === att.id ? { ...a, compressing: false } : a))
                );
              });
          }
        }
        if (others.length > 0) {
          const quoted = others.map((p: string) =>
            p.includes(" ") ? `'${p}'` : p
          );
          const text = quoted.join(" ");
          setValue((prev) => {
            const el = textareaRef.current;
            if (!el) return prev + text;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const next = prev.slice(0, start) + text + prev.slice(end);
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = start + text.length;
            });
            return next;
          });
        }
      }
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, []);

  const send = useCallback(async (overrideValue?: string) => {
    const parts: string[] = [];
    const trimmed = (overrideValue ?? value).trimEnd();
    if (trimmed) parts.push(trimmed);
    for (const att of attachments) {
      parts.push(att.path.includes(" ") ? `'${att.path}'` : att.path);
    }
    if (parts.length === 0) {
      invoke("write_to_pty", { paneId: ptyId, data: Array.from(encoder.encode("\r")) }).catch(logger.error);
      return;
    }
    const text = parts.join(" ");

    // Why bracketed paste: Claude Code TUI only converts an image path to an
    // `[Image #N]` placeholder when the path arrives inside a bracketed paste —
    // typed-character input is treated literally. Sending raw `text path\r\r`
    // therefore leaves the path as plain text and the two CRs just add newlines
    // in Claude Code's multiline input, leaving the user stuck mid-edit.
    //
    // When attachments are present we also have to split the writes: Claude
    // Code's paste handler processes the path → placeholder conversion
    // asynchronously, and a CR that arrives in the same byte stream gets
    // swallowed before the input parser sees it. Pause briefly after the
    // paste end marker, then deliver two separate CRs (commit placeholder,
    // then submit) so each is treated as an independent Enter event. Without
    // attachments a single trailing CR is enough.
    const term = getTerminal(ptyId)?.terminal;
    const bracketedPaste = term?.modes.bracketedPasteMode ?? false;
    const hasAttachments = attachments.length > 0;

    // Update history/draft state immediately so the UI feels responsive while
    // the async writes drain.
    const history = historyRef.current;
    if (history[0] !== text) {
      history.unshift(text);
      if (history.length > MAX_HISTORY) history.pop();
    }
    historyIndexRef.current = -1;
    draftRef.current = "";
    draftStore.delete(ptyId);
    setValue("");
    setAttachments([]);

    const write = (s: string) =>
      invoke("write_to_pty", { paneId: ptyId, data: Array.from(encoder.encode(s)) });
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    try {
      if (bracketedPaste) {
        await write(`\x1b[200~${text}\x1b[201~`);
        if (hasAttachments) {
          // Claude Code processes the image-path conversion asynchronously
          // (reads/inspects the file). 150ms covers cold-cache reads on slow
          // disks; below ~80ms the first CR gets eaten by the in-flight paste.
          // Then two CRs: the first commits the [Image #N] placeholder when
          // Claude Code requires confirmation, the second submits. If Claude
          // Code already submitted on the first CR, the second lands on an
          // empty prompt and is a no-op.
          await sleep(150);
          await write("\r");
          await sleep(50);
          await write("\r");
        } else {
          await write("\r");
        }
      } else {
        const ending = hasAttachments ? "\r\r" : "\r";
        await write(text + ending);
      }
    } catch (e) {
      logger.error(e);
    }
  }, [value, ptyId, attachments]);

  // Double-Enter to send: track last Enter timestamp
  const lastEnterRef = useRef(0);
  const DOUBLE_ENTER_MS = 300;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "a") {
        e.preventDefault();
        const el = textareaRef.current;
        if (el) el.setSelectionRange(0, el.value.length);
        return;
      }

      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        send();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 입력이 비어 있고 첨부도 없으면 첫 Enter에 바로 \r 전송 (사용성 확보).
        if (!textareaRef.current?.value && attachments.length === 0) {
          e.preventDefault();
          e.stopPropagation();
          invoke("write_to_pty", { paneId: ptyId, data: Array.from(encoder.encode("\r")) }).catch(logger.error);
          lastEnterRef.current = 0;
          return;
        }
        const now = Date.now();
        if (now - lastEnterRef.current < DOUBLE_ENTER_MS) {
          e.preventDefault();
          const cleaned = (textareaRef.current?.value ?? "").replace(/\n+$/, "");
          if (cleaned || attachments.length > 0) {
            send(cleaned);
          } else {
            invoke("write_to_pty", { paneId: ptyId, data: Array.from(encoder.encode("\r")) }).catch(logger.error);
            setValue("");
          }
          lastEnterRef.current = 0;
          return;
        }
        lastEnterRef.current = now;
        // Prevent native Enter from propagating to PTY handlers; insert newline manually.
        e.preventDefault();
        e.stopPropagation();
        const el = textareaRef.current;
        // When the textarea is empty OR attachments are present, skip the \n insertion —
        // avoids a state update (and the resulting re-render + closure swap) between
        // the two Enter presses. The second Enter fires with the same handler and
        // correctly triggers send. With attachments the user is in "send mode", so
        // mid-message newlines are not useful and the re-render race is avoided.
        if (!el?.value || attachments.length > 0) return;
        if (el) {
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          const next = value.slice(0, start) + "\n" + value.slice(end);
          setValue(next);
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.selectionStart = start + 1;
              textareaRef.current.selectionEnd = start + 1;
            }
          });
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        getTerminal(ptyId)?.terminal.focus();
        return;
      }

      const history = historyRef.current;
      if (e.key === "ArrowUp" && !e.shiftKey) {
        const el = textareaRef.current;
        if (el) {
          const beforeCursor = el.value.slice(0, el.selectionStart);
          if (beforeCursor.includes("\n")) return;
        }
        if (historyIndexRef.current < history.length - 1) {
          e.preventDefault();
          if (historyIndexRef.current === -1) draftRef.current = value;
          historyIndexRef.current++;
          setValue(history[historyIndexRef.current]);
        }
        return;
      }

      if (e.key === "ArrowDown" && !e.shiftKey) {
        const el = textareaRef.current;
        if (el) {
          const afterCursor = el.value.slice(el.selectionEnd);
          if (afterCursor.includes("\n")) return;
        }
        if (historyIndexRef.current >= 0) {
          e.preventDefault();
          historyIndexRef.current--;
          setValue(historyIndexRef.current === -1 ? draftRef.current : history[historyIndexRef.current]);
        }
        return;
      }

      if (historyIndexRef.current >= 0 && e.key !== "ArrowUp" && e.key !== "ArrowDown") {
        historyIndexRef.current = -1;
      }
    },
    [send, onClose, ptyId, value, attachments],
  );

  const hasContent = true;

  useEffect(() => {
    if (value) draftStore.set(ptyId, value);
    else draftStore.delete(ptyId);
  }, [value, ptyId]);

  const MAX_CONTENT_HEIGHT = 300;

  const syncHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_CONTENT_HEIGHT) + "px";
  }, []);

  useEffect(() => { syncHeight(); }, [value, syncHeight]);

  return (
    <div
      ref={containerRef}
      data-input-bar-container=""
      className="shrink-0"
      style={{
        background: "var(--bg-elevated)",
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onFocus={() => { getTerminal(ptyId)?.terminal.blur(); }}
    >
      {/* Top action bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "2px 12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <button
          onClick={() => {
            const data = Array.from(encoder.encode("/clear\r"));
            invoke("write_to_pty", { paneId: ptyId, data }).catch(logger.error);
          }}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "var(--fs-9)",
            fontFamily: "monospace",
            padding: "1px 6px",
            borderRadius: 4,
            opacity: 0.55,
            transition: "opacity 0.15s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.55"; }}
          title="Clear terminal"
        >
          /clear
        </button>
        <button
          onClick={() => {
            const history = historyRef.current;
            if (history.length === 0) return;
            const last = history[0];
            if (historyIndexRef.current === -1) draftRef.current = value;
            historyIndexRef.current = 0;
            setValue(last);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (!el) return;
              el.focus();
              const end = el.value.length;
              el.selectionStart = end;
              el.selectionEnd = end;
            });
          }}
          disabled={historyRef.current.length === 0}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: historyRef.current.length === 0 ? "default" : "pointer",
            fontSize: "var(--fs-9)",
            fontFamily: "monospace",
            padding: "1px 6px",
            borderRadius: 4,
            opacity: historyRef.current.length === 0 ? 0.25 : 0.55,
            transition: "opacity 0.15s",
          }}
          onMouseEnter={(e) => {
            if (historyRef.current.length === 0) return;
            (e.currentTarget as HTMLElement).style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            if (historyRef.current.length === 0) return;
            (e.currentTarget as HTMLElement).style.opacity = "0.55";
          }}
          title={
            historyRef.current.length === 0
              ? "마지막 프롬프트 없음"
              : `마지막 프롬프트 불러오기 (↑와 동일)\n${historyRef.current[0].length > 200 ? historyRef.current[0].slice(0, 200) + "…" : historyRef.current[0]}`
          }
        >
          ↑ 마지막
        </button>
        </div>
        <button
          onClick={() => { onClose(); getTerminal(ptyId)?.terminal.focus(); }}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: "0 2px",
            borderRadius: 4,
            opacity: 0.55,
            transition: "opacity 0.15s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.55"; }}
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      {/* Image attachments — outside the height-controlled box so text area isn't squeezed */}
      {attachments.length > 0 && (
        <div style={{ display: "flex", gap: 5, padding: "0 8px 4px", flexWrap: "wrap" }}>
          {attachments.map((att) => (
            <AttachmentThumb
              key={att.id}
              att={att}
              onRemove={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
            />
          ))}
        </div>
      )}

      {/* Input field with rounded border */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          background: "var(--bg-base)",
          border: isDragOver ? "1px dashed var(--accent-cyan, #22d3ee)" : "1px solid var(--border-subtle)",
          borderRadius: 8,
          padding: "6px 6px 6px 12px",
          margin: "0 8px 2px",
          transition: "border-color 0.15s",
        }}
        onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)"; }}
        onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-subtle)"; }}
      >
        {/* Input row */}
        <div style={{ display: "flex", gap: 6, flex: 1, alignItems: "flex-end" }}>
        <textarea
          ref={textareaRef}
          {...{ [INPUT_BAR_DATA_ATTR]: "" }}
          value={value}
          onChange={(e) => setValue(sanitize(e.target.value))}
          onKeyDown={handleKeyDown}
          aria-label="Terminal input bar"
          placeholder="Up/Down history | Enter×2 or Shift+Enter to send | Esc close"
          spellCheck={false}
          autoComplete="off"
          rows={1}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text-primary)",
            fontSize: "var(--fs-12)",
            fontFamily: "system-ui, sans-serif",
            padding: 0,
            resize: "none",
            lineHeight: 1.5,
            overflowY: "hidden",
            display: "block",
          }}
        />

        {/* Send button */}
        <button
          type="button"
          onMouseDown={(e) => {
            // Prevent the textarea from losing focus before onClick fires —
            // some IME/focus stacks swallow the click if focus moves first.
            e.preventDefault();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            send();
          }}
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            border: "none",
            background: hasContent ? "var(--accent-cyan, #22d3ee)" : "transparent",
            color: hasContent ? "var(--bg-base)" : "var(--text-muted)",
            cursor: hasContent ? "pointer" : "default",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            alignSelf: "flex-end",
            transition: "background 0.15s, color 0.15s",
            opacity: hasContent ? 1 : 0.5,
          }}
          title="Send (Enter×2 or Shift+Enter)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </button>
        </div>
      </div>

    </div>
  );
}
