import { useCallback, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowClockwise, Lock, Wrench, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { isTauri } from "../../../lib/bridge";
import { logger } from "../../../lib/logger";
import type { BrowserViewerProps, UrlHistoryEntry } from "./types";
import { BLOCKED_SCHEMES } from "./types";
import { loadUrlHistory, addToUrlHistory } from "./urlHistory";
import {
  webviewRegistry, navLocks,
  getOrCreateWebview, hideWebview, hideAllBrowserWebviews,
} from "./webviewHelpers";
import NavButton from "./NavButton";

export default function BrowserViewer({ id, url, onUrlChange }: BrowserViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [addressValue, setAddressValue] = useState(url);
  const [isLoading, setIsLoading] = useState(false);
  const rectRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<UrlHistoryEntry[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [hasWebview, setHasWebview] = useState(false);
  const typedValue = useRef("");

  useEffect(() => { setAddressValue(url); }, [url]);

  // Show/create webview on mount, hide on unmount
  useEffect(() => {
    if (!isTauri()) return;
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const r = { x: Math.round(rect.left) + 1, y: Math.round(rect.top), width: Math.max(0, Math.round(rect.width) - 2), height: Math.round(rect.height) };
    rectRef.current = r;

    if (r.width <= 0 || r.height <= 0) return;

    for (const [otherId] of webviewRegistry) {
      if (otherId !== id) hideWebview(otherId);
    }

    if (!url) {
      hideAllBrowserWebviews();
      setHasWebview(false);
      setTimeout(() => addressRef.current?.focus(), 100);
      return;
    }

    setIsLoading(true);
    getOrCreateWebview(id, url, r)
      .then(() => { setIsLoading(false); setHasWebview(true); })
      .catch(() => setIsLoading(false));

    return () => { hideWebview(id); };
  }, [id, url]);

  // Listen for URL changes from Rust on_page_load
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    listen<{ label: string; url: string }>("browser-url-changed", (event) => {
      if (!active) return;
      const wv = webviewRegistry.get(id);
      if (!wv || wv.label !== event.payload.label) return;

      const newUrl = event.payload.url;
      if (newUrl && newUrl !== "about:blank") {
        setAddressValue(newUrl);
        setIsLoading(false);
        const host = (() => { try { return new URL(newUrl).hostname; } catch { return undefined; } })();
        addToUrlHistory(newUrl, host);
        onUrlChange?.(newUrl, host);
      }
    }).then((fn) => { if (active) unlisten = fn; else fn(); });

    return () => { active = false; unlisten?.(); };
  }, [id, onUrlChange]);

  // Sync position on resize
  useEffect(() => {
    if (!isTauri()) return;
    const container = containerRef.current;
    if (!container) return;

    let rafId = 0;
    const sync = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const wv = webviewRegistry.get(id);
        if (!wv) return;
        const rect = container.getBoundingClientRect();
        const x = Math.round(rect.left) + 1;
        const y = Math.round(rect.top);
        const w = Math.max(0, Math.round(rect.width) - 2);
        const h = Math.round(rect.height);
        if (w > 0 && h > 0) {
          rectRef.current = { x, y, width: w, height: h };
          wv.setPosition(x, y).catch(() => {});
          wv.setSize(w, h).catch(() => {});
        }
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(container);
    window.addEventListener("resize", sync);
    return () => { cancelAnimationFrame(rafId); observer.disconnect(); window.removeEventListener("resize", sync); };
  }, [id]);

  // Hide/show webview when modal overlays appear/disappear
  useEffect(() => {
    if (!isTauri()) return;

    const onHide = () => {
      const wv = webviewRegistry.get(id);
      if (!wv) return;
      invoke("webview_hide", { label: wv.label }).catch(() => {});
    };
    const onShow = () => {
      const wv = webviewRegistry.get(id);
      if (!wv) return;
      invoke("webview_show", { label: wv.label }).catch(() => {});
    };

    window.addEventListener("browser-webview-hide", onHide);
    window.addEventListener("browser-webview-show", onShow);
    return () => {
      window.removeEventListener("browser-webview-hide", onHide);
      window.removeEventListener("browser-webview-show", onShow);
    };
  }, [id]);

  // Close suggestions on outside click
  useEffect(() => {
    if (!showSuggestions) return;
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) &&
          addressRef.current && !addressRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSuggestions]);

  const navigate = useCallback(async (targetUrl: string) => {
    let normalized = targetUrl.trim();
    if (!normalized) return;

    if (BLOCKED_SCHEMES.test(normalized)) return;

    if (!/^https?:\/\//i.test(normalized)) {
      if (/^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}/.test(normalized)) {
        normalized = `https://${normalized}`;
      } else {
        normalized = `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
      }
    }
    setAddressValue(normalized);
    setShowSuggestions(false);

    if (navLocks.get(id)) return;
    navLocks.set(id, true);
    setIsLoading(true);

    try {
      const existing = webviewRegistry.get(id);
      if (existing) {
        await invoke("webview_navigate", { label: existing.label, url: normalized });
      } else {
        await getOrCreateWebview(id, normalized, rectRef.current);
        setHasWebview(true);
      }
    } catch (e) {
      logger.error("[BrowserViewer] navigate error:", e);
      setIsLoading(false);
    } finally {
      navLocks.delete(id);
      // isLoading cleared by browser-url-changed event; fallback timeout for failures
      setTimeout(() => setIsLoading(false), 10000);
    }

    const host = (() => { try { return new URL(normalized).hostname; } catch { return undefined; } })();
    addToUrlHistory(normalized, host);
    onUrlChange?.(normalized, host);
  }, [id, onUrlChange]);

  const handleGoBack = useCallback(() => {
    const wv = webviewRegistry.get(id);
    if (wv) {
      setIsLoading(true);
      invoke("webview_go_back", { label: wv.label }).catch(() => setIsLoading(false));
      setTimeout(() => setIsLoading(false), 5000);
    }
  }, [id]);

  const handleGoForward = useCallback(() => {
    const wv = webviewRegistry.get(id);
    if (wv) {
      setIsLoading(true);
      invoke("webview_go_forward", { label: wv.label }).catch(() => setIsLoading(false));
      setTimeout(() => setIsLoading(false), 5000);
    }
  }, [id]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (selectedSuggestion >= 0 && selectedSuggestion < suggestions.length) {
        navigate(suggestions[selectedSuggestion].url);
      } else {
        navigate(addressValue);
      }
      addressRef.current?.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestion((prev) => {
        const next = Math.min(prev + 1, suggestions.length - 1);
        setAddressValue(next >= 0 ? suggestions[next].url : typedValue.current);
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestion((prev) => {
        const next = Math.max(prev - 1, -1);
        setAddressValue(next >= 0 ? suggestions[next].url : typedValue.current);
        return next;
      });
    } else if (e.key === "Tab") {
      if (showSuggestions && suggestions.length > 0) {
        e.preventDefault();
        const idx = selectedSuggestion >= 0 ? selectedSuggestion : 0;
        const url = suggestions[idx].url.replace(/^https?:\/\//, "");
        setAddressValue(url);
        setSelectedSuggestion(idx);
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      addressRef.current?.blur();
    }
  }, [addressValue, navigate, selectedSuggestion, suggestions, showSuggestions]);

  const handleReload = useCallback(() => {
    const wv = webviewRegistry.get(id);
    if (wv) invoke("webview_reload", { label: wv.label }).catch(logger.error);
  }, [id]);

  const handleDevtools = useCallback(() => {
    const wv = webviewRegistry.get(id);
    if (wv) invoke("webview_toggle_devtools", { label: wv.label }).catch(logger.error);
  }, [id]);

  const updateSuggestions = useCallback((val: string) => {
    if (val.trim().length === 0) {
      const entries = loadUrlHistory().slice(0, 8);
      setSuggestions(entries);
      setShowSuggestions(entries.length > 0);
    } else {
      const query = val.toLowerCase();
      const stripped = query.replace(/^https?:\/\/(www\.)?/, "");
      const matched = loadUrlHistory()
        .filter((entry) => entry.url.toLowerCase().includes(query) || (entry.title && entry.title.toLowerCase().includes(query)));
      // Sort: prefix match on domain/path first, then recency
      matched.sort((a, b) => {
        const aUrl = a.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "");
        const bUrl = b.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "");
        const aPrefix = aUrl.startsWith(stripped) ? 1 : 0;
        const bPrefix = bUrl.startsWith(stripped) ? 1 : 0;
        if (aPrefix !== bPrefix) return bPrefix - aPrefix;
        // Exact domain match bonus
        const aDomain = aUrl.split("/")[0];
        const bDomain = bUrl.split("/")[0];
        const aExact = aDomain === stripped || aDomain.startsWith(stripped) ? 1 : 0;
        const bExact = bDomain === stripped || bDomain.startsWith(stripped) ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        // Shorter URL first (more relevant)
        return a.url.length - b.url.length;
      });
      setSuggestions(matched.slice(0, 8));
      setShowSuggestions(matched.length > 0);
    }
  }, []);

  const handleAddressChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    typedValue.current = val;
    setAddressValue(val);
    setSelectedSuggestion(-1);
    updateSuggestions(val);
  }, [updateSuggestions]);

  const justFocused = useRef(false);
  const handleAddressFocus = useCallback(() => {
    justFocused.current = true;
    requestAnimationFrame(() => addressRef.current?.select());
    updateSuggestions(addressValue);
  }, [addressValue, updateSuggestions]);
  const handleAddressMouseUp = useCallback((e: React.MouseEvent) => {
    if (justFocused.current) {
      e.preventDefault();
      justFocused.current = false;
    }
  }, []);

  const isHttps = addressValue.startsWith("https://");

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center shrink-0 gap-1 px-2"
        style={{ height: "calc(32px * var(--ui-scale))", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-default)" }}
      >
        <NavButton onClick={handleGoBack} title="Back">
          <CaretLeft size={14} weight="bold" />
        </NavButton>
        <NavButton onClick={handleGoForward} title="Forward">
          <CaretRight size={14} weight="bold" />
        </NavButton>
        <NavButton onClick={handleReload} title="Reload">
          <ArrowClockwise size={14} weight={isLoading ? "fill" : "bold"} className={isLoading ? "animate-spin" : ""} />
        </NavButton>
        <div className="relative flex-1 min-w-0">
          <div
            className="flex items-center gap-1.5 px-2 rounded"
            style={{ height: "calc(22px * var(--ui-scale))", background: "var(--bg-input)", border: "1px solid var(--border-default)" }}
          >
            {isHttps && <Lock size={11} weight="fill" style={{ color: "var(--text-muted)", flexShrink: 0 }} />}
            <input
              ref={addressRef}
              type="text"
              value={addressValue}
              onChange={handleAddressChange}
              onKeyDown={handleKeyDown}
              onFocus={handleAddressFocus}
              onMouseUp={handleAddressMouseUp}
              onBlur={() => { justFocused.current = false; setTimeout(() => setShowSuggestions(false), 150); }}
              className="flex-1 min-w-0"
              style={{ background: "transparent", border: "none", outline: "none", color: "var(--text-primary)", fontSize: "var(--fs-11)", fontFamily: "var(--font-mono, monospace)" }}
              spellCheck={false}
            />
          </div>
          {showSuggestions && suggestions.length > 0 && (
            <div
              ref={suggestionsRef}
              className="absolute left-0 right-0 z-50 overflow-hidden rounded-b"
              style={{
                top: "100%",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
                borderTop: "none",
                maxHeight: 300,
                overflowY: "auto",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              }}
            >
              {suggestions.map((entry, i) => (
                <div
                  key={entry.url}
                  className="flex items-center gap-2 px-2 cursor-pointer"
                  style={{
                    height: "calc(28px * var(--ui-scale))",
                    background: i === selectedSuggestion ? "var(--bg-hover, rgba(255,255,255,0.08))" : "transparent",
                    color: "var(--text-primary)",
                    fontSize: "var(--fs-11)",
                    fontFamily: "var(--font-mono, monospace)",
                  }}
                  onMouseEnter={() => setSelectedSuggestion(i)}
                  onMouseDown={(e) => { e.preventDefault(); navigate(entry.url); }}
                >
                  <span className="truncate" style={{ color: "var(--text-primary)" }}>
                    {entry.title ? `${entry.title} \u2014 ` : ""}
                  </span>
                  <span className="truncate" style={{ color: "var(--text-muted)", flexShrink: 0 }}>
                    {entry.url.replace(/^https?:\/\//, "")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        {hasWebview && (
          <NavButton onClick={handleDevtools} title="DevTools">
            <Wrench size={14} />
          </NavButton>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" style={{ background: "var(--bg-base)" }}>
        {!isTauri() && (
          <div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)" }}>
            Browser is only available in the desktop app.
          </div>
        )}
      </div>
    </div>
  );
}
