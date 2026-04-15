/**
 * Minimal interface for xterm.js internal (_core) properties.
 *
 * xterm.js does not expose these in its public API, but we need them
 * for cursor-position calculations, cell dimensions, and color lookups.
 * Using this interface instead of `as any` gives us some structural safety.
 */

import type { Terminal } from "@xterm/xterm";

interface XTermCssCell {
  width: number;
  height: number;
}

interface XTermCssDimensions {
  cell: XTermCssCell;
}

interface XTermDimensions {
  css?: XTermCssDimensions;
}

interface XTermAnsiColor {
  css: string;
}

interface XTermColors {
  background?: { css: string };
  foreground?: { css: string };
  ansi?: XTermAnsiColor[];
}

interface XTermColorManager {
  colors?: XTermColors;
}

export interface XTermCore {
  dimensions?: XTermDimensions;
  _renderService?: {
    dimensions?: XTermDimensions;
  };
  _colorManager?: XTermColorManager;
}

/**
 * Cast a Terminal to access its internal `_core` property.
 * Prefer this over `(terminal as any)._core`.
 */
export function getXTermCore(terminal: Terminal): XTermCore | undefined {
  return (terminal as unknown as { _core?: XTermCore })._core;
}
