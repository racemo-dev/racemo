import { logger } from "../../../lib/logger";
import type { UrlHistoryEntry } from "./types";

const URL_HISTORY_KEY = "browser-url-history";
const MAX_HISTORY = 200;

let _historyCache: UrlHistoryEntry[] | null = null;

export function loadUrlHistory(): UrlHistoryEntry[] {
  if (_historyCache) return _historyCache;
  try {
    const raw = localStorage.getItem(URL_HISTORY_KEY);
    _historyCache = raw ? JSON.parse(raw) : [];
  } catch { _historyCache = []; }
  return _historyCache!;
}

export function saveUrlHistory(entries: UrlHistoryEntry[]) {
  const trimmed = entries.slice(0, MAX_HISTORY);
  _historyCache = trimmed;
  try { localStorage.setItem(URL_HISTORY_KEY, JSON.stringify(trimmed)); } catch (e) { logger.warn("[BrowserViewer:saveUrlHistory] failed:", e); }
}

export function addToUrlHistory(url: string, title?: string) {
  if (!url || url === "about:blank") return;
  const entries = loadUrlHistory();
  const filtered = entries.filter((e) => e.url !== url);
  filtered.unshift({ url, title, ts: Date.now() });
  saveUrlHistory(filtered);
}
