import type { ILinkProvider, ILink, IBufferRange, Terminal } from "@xterm/xterm";
import { open } from "@tauri-apps/plugin-shell";
import { useSessionStore } from "../stores/sessionStore";

const URL_RE = /https?:\/\/[^\s)>\]"'`]+/g;
const FILE_RE = /(?:\/[\w.-]+)+(?::(\d+)(?::(\d+))?)?|\.\/[\w./-]+(?::(\d+)(?::(\d+))?)?/g;

function isLikelyFilePath(text: string): boolean {
  return /\.\w+/.test(text) || text.endsWith("/");
}

function resolveFilePath(raw: string, cwd: string): string {
  if (raw.startsWith("/")) return raw;
  if (raw.startsWith("./")) return `${cwd}/${raw.slice(2)}`;
  return `${cwd}/${raw}`;
}

export function createLinkProviderWithTerminal(terminal: Terminal, ptyId: string): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const lineText = line.translateToString(true);
      const links: ILink[] = [];

      // Detect URLs
      let match: RegExpExecArray | null;
      URL_RE.lastIndex = 0;
      while ((match = URL_RE.exec(lineText)) !== null) {
        const url = match[0].replace(/[.,;:!?]+$/, "");
        const startX = match.index;
        const range: IBufferRange = {
          start: { x: startX + 1, y: bufferLineNumber },
          end: { x: startX + url.length, y: bufferLineNumber },
        };
        links.push({
          range,
          text: url,
          decorations: { pointerCursor: true, underline: true },
          activate: (_event: MouseEvent, text: string) => {
            open(text).catch(console.error);
          },
        });
      }

      // Detect file paths with optional :line:col
      FILE_RE.lastIndex = 0;
      while ((match = FILE_RE.exec(lineText)) !== null) {
        const fullMatch = match[0];
        const cleaned = fullMatch.replace(/[,;:!?]+$/, "");
        const colonIdx = cleaned.search(/:\d+/);
        const filePath = colonIdx >= 0 ? cleaned.slice(0, colonIdx) : cleaned;

        if (!isLikelyFilePath(filePath)) continue;

        const startX = match.index;
        const range: IBufferRange = {
          start: { x: startX + 1, y: bufferLineNumber },
          end: { x: startX + cleaned.length, y: bufferLineNumber },
        };

        links.push({
          range,
          text: cleaned,
          decorations: { pointerCursor: true, underline: true },
          activate: (_event: MouseEvent, text: string) => {
            const pathColonMatch = text.match(/^(.+?)(?::(\d+)(?::(\d+))?)?$/);
            if (!pathColonMatch) return;
            const rawPath = pathColonMatch[1];
            const cwd = useSessionStore.getState().paneCwds[ptyId] || "";
            const absPath = resolveFilePath(rawPath, cwd);
            open(absPath).catch(console.error);
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
