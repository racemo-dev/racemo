export interface BrowserViewerProps {
  id: string;
  url: string;
  onUrlChange?: (url: string, title?: string) => void;
}

export interface WebviewHandle {
  label: string;
  close: () => Promise<void>;
  setPosition: (x: number, y: number) => Promise<void>;
  setSize: (w: number, h: number) => Promise<void>;
}

export interface UrlHistoryEntry {
  url: string;
  title?: string;
  ts: number;
}

export const BLOCKED_SCHEMES = /^(javascript|data|file):/i;
