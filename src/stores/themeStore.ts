import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ITheme } from "@xterm/xterm";
import { isWindows } from "../lib/osUtils";

export interface AppTheme {
  name: string;
  label: string;
  css: Record<string, string>;
  terminal: ITheme;
}

const themes: AppTheme[] = [
  {
    name: "dark",
    label: "Dark",
    css: {
      "--bg-base": "#0a0a0a",
      "--bg-surface": "#0d0d0d",
      "--bg-elevated": "#111111",
      "--bg-overlay": "#1a1a1a",
      "--border-subtle": "#1a1a1a",
      "--border-default": "#222222",
      "--border-strong": "#333333",
      "--text-primary": "#aaaaaa",
      "--text-secondary": "#737373",
      "--text-tertiary": "#666666",
      "--text-muted": "#555555",
      "--accent-red": "#a85450",
      "--accent-yellow": "#9e7e34",
      "--accent-blue": "#4878a8",
      "--accent-purple": "#8668a8",
      "--accent-cyan": "#4d9198",
      "--status-active": "#4d8a56",
      "--status-inactive": "#555555",
      "--status-warning": "#9e7e34",
      "--bg-sidebar": "#000000",
      "--status-error": "#a85450",
      "--accent-green": "#4d8a56",
      "--bg-hover": "rgba(255,255,255,0.04)",
    },
    terminal: {
      background: "#0a0a0a",
      foreground: "#aaaaaa",
      cursor: "#aaaaaa",
      selectionBackground: "#2a2a2a",
      black: "#0a0a0a",
      red: "#a85450",
      green: "#4d8a56",
      yellow: "#9e7e34",
      blue: "#4878a8",
      magenta: "#8668a8",
      cyan: "#4d9198",
      white: "#aaaaaa",
      brightBlack: "#555555",
      brightRed: "#c06a66",
      brightGreen: "#6aa874",
      brightYellow: "#b89a50",
      brightBlue: "#6090b8",
      brightMagenta: "#9e82b8",
      brightCyan: "#68a8b0",
      brightWhite: "#cccccc",
    },
  },
  {
    name: "midnight",
    label: "Midnight",
    css: {
      "--bg-base": "#0b0e14",
      "--bg-surface": "#0d1017",
      "--bg-elevated": "#11151c",
      "--bg-overlay": "#1a1f2e",
      "--border-subtle": "#1a1f2e",
      "--border-default": "#232a3b",
      "--border-strong": "#2d364a",
      "--text-primary": "#bfbdb6",
      "--text-secondary": "#73808c",
      "--text-tertiary": "#6a7080",
      "--text-muted": "#5d6677",
      "--accent-red": "#f07178",
      "--accent-yellow": "#e6b450",
      "--accent-blue": "#007aff",
      "--accent-purple": "#d2a6ff",
      "--accent-cyan": "#95e6cb",
      "--status-active": "#aad94c",
      "--status-inactive": "#565b66",
      "--status-warning": "#ffb454",
      "--bg-sidebar": "#05070a",
      "--status-error": "#d95757",
      "--accent-green": "#aad94c",
      "--bg-hover": "rgba(255,255,255,0.04)",
    },
    terminal: {
      background: "#0b0e14",
      foreground: "#bfbdb6",
      cursor: "#e6b450",
      selectionBackground: "#2d364a",
      black: "#0b0e14",
      red: "#f07178",
      green: "#aad94c",
      yellow: "#e6b450",
      blue: "#59c2ff",
      magenta: "#d2a6ff",
      cyan: "#95e6cb",
      white: "#bfbdb6",
      brightBlack: "#565b66",
      brightRed: "#f07178",
      brightGreen: "#aad94c",
      brightYellow: "#e6b450",
      brightBlue: "#73b8ff",
      brightMagenta: "#d2a6ff",
      brightCyan: "#95e6cb",
      brightWhite: "#d9d7ce",
    },
  },
  {
    name: "solarized",
    label: "Solarized",
    css: {
      "--bg-base": "#002b36",
      "--bg-surface": "#003340",
      "--bg-elevated": "#073642",
      "--bg-overlay": "#0a4050",
      "--border-subtle": "#0a4050",
      "--border-default": "#124e5c",
      "--border-strong": "#1a6070",
      "--text-primary": "#93a1a1",
      "--text-secondary": "#839496",
      "--text-tertiary": "#728a92",
      "--text-muted": "#6a8088",
      "--accent-red": "#dc322f",
      "--accent-yellow": "#b58900",
      "--accent-blue": "#007aff",
      "--accent-purple": "#6c71c4",
      "--accent-cyan": "#2aa198",
      "--status-active": "#859900",
      "--status-inactive": "#586e75",
      "--status-warning": "#cb4b16",
      "--bg-sidebar": "#001e26",
      "--status-error": "#dc322f",
      "--accent-green": "#859900",
      "--bg-hover": "rgba(255,255,255,0.04)",
    },
    terminal: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#859900",
      brightYellow: "#b58900",
      brightBlue: "#268bd2",
      brightMagenta: "#6c71c4",
      brightCyan: "#2aa198",
      brightWhite: "#fdf6e3",
    },
  },
  {
    name: "nord",
    label: "Nord",
    css: {
      "--bg-base": "#2e3440",
      "--bg-surface": "#313744",
      "--bg-elevated": "#3b4252",
      "--bg-overlay": "#434c5e",
      "--border-subtle": "#3b4252",
      "--border-default": "#434c5e",
      "--border-strong": "#4c566a",
      "--text-primary": "#eceff4",
      "--text-secondary": "#d8dee9",
      "--text-tertiary": "#a0a8b8",
      "--text-muted": "#6a7590",
      "--accent-red": "#bf616a",
      "--accent-yellow": "#ebcb8b",
      "--accent-blue": "#5e81ac",
      "--accent-purple": "#b48ead",
      "--accent-cyan": "#88c0d0",
      "--status-active": "#a3be8c",
      "--status-inactive": "#4c566a",
      "--status-warning": "#d08770",
      "--bg-sidebar": "#272c36",
      "--status-error": "#bf616a",
      "--accent-green": "#a3be8c",
      "--bg-hover": "rgba(255,255,255,0.04)",
    },
    terminal: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    name: "monokai",
    label: "Monokai",
    css: {
      "--bg-base": "#272822",
      "--bg-surface": "#2c2d26",
      "--bg-elevated": "#35362e",
      "--bg-overlay": "#3e3d32",
      "--border-subtle": "#3e3d32",
      "--border-default": "#4a4940",
      "--border-strong": "#5a594e",
      "--text-primary": "#f8f8f2",
      "--text-secondary": "#c0c0b0",
      "--text-tertiary": "#90908a",
      "--text-muted": "#75715e",
      "--accent-red": "#f92672",
      "--accent-yellow": "#e6db74",
      "--accent-blue": "#66d9ef",
      "--accent-purple": "#ae81ff",
      "--accent-cyan": "#66d9ef",
      "--status-active": "#a6e22e",
      "--status-inactive": "#5a594e",
      "--status-warning": "#fd971f",
      "--bg-sidebar": "#1e1f1a",
      "--status-error": "#f92672",
      "--accent-green": "#a6e22e",
      "--bg-hover": "rgba(255,255,255,0.04)",
    },
    terminal: {
      background: "#272822",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#49483e",
      black: "#272822",
      red: "#f92672",
      green: "#a6e22e",
      yellow: "#f4bf75",
      blue: "#66d9ef",
      magenta: "#ae81ff",
      cyan: "#a1efe4",
      white: "#f8f8f2",
      brightBlack: "#75715e",
      brightRed: "#f92672",
      brightGreen: "#a6e22e",
      brightYellow: "#f4bf75",
      brightBlue: "#66d9ef",
      brightMagenta: "#ae81ff",
      brightCyan: "#a1efe4",
      brightWhite: "#f9f8f5",
    },
  },
  {
    name: "rose-pine",
    label: "Rosé Pine",
    css: {
      "--bg-base": "#191724",
      "--bg-surface": "#1f1d2e",
      "--bg-elevated": "#26233a",
      "--bg-overlay": "#302d41",
      "--border-subtle": "#26233a",
      "--border-default": "#302d41",
      "--border-strong": "#403d52",
      "--text-primary": "#e0def4",
      "--text-secondary": "#c4a7e7",
      "--text-tertiary": "#908caa",
      "--text-muted": "#6e6a86",
      "--accent-red": "#eb6f92",
      "--accent-yellow": "#f6c177",
      "--accent-blue": "#31748f",
      "--accent-purple": "#c4a7e7",
      "--accent-cyan": "#9ccfd8",
      "--status-active": "#9ccfd8",
      "--status-inactive": "#403d52",
      "--status-warning": "#f6c177",
      "--bg-sidebar": "#14121f",
      "--status-error": "#eb6f92",
      "--accent-green": "#9ccfd8",
      "--bg-hover": "rgba(255,255,255,0.04)",
    },
    terminal: {
      background: "#191724",
      foreground: "#e0def4",
      cursor: "#e0def4",
      selectionBackground: "#302d41",
      black: "#26233a",
      red: "#eb6f92",
      green: "#9ccfd8",
      yellow: "#f6c177",
      blue: "#31748f",
      magenta: "#c4a7e7",
      cyan: "#ebbcba",
      white: "#e0def4",
      brightBlack: "#6e6a86",
      brightRed: "#eb6f92",
      brightGreen: "#9ccfd8",
      brightYellow: "#f6c177",
      brightBlue: "#31748f",
      brightMagenta: "#c4a7e7",
      brightCyan: "#ebbcba",
      brightWhite: "#e0def4",
    },
  },
  {
    name: "light",
    label: "Light",
    css: {
      "--bg-base": "#fdfdfd",
      "--bg-surface": "#f8f8f8",
      "--bg-elevated": "#f0f0f0",
      "--bg-overlay": "#e8e8e8",
      "--border-subtle": "#e8e8e8",
      "--border-default": "#d0d0d0",
      "--border-strong": "#b0b0b0",
      "--text-primary": "#1a1a1a",
      "--text-secondary": "#555555",
      "--text-tertiary": "#888888",
      "--text-muted": "#bbbbbb",
      "--accent-red": "#dc2626",
      "--accent-yellow": "#ca8a04",
      "--accent-blue": "#007aff",
      "--accent-purple": "#7c3aed",
      "--accent-cyan": "#0891b2",
      "--status-active": "#16a34a",
      "--status-inactive": "#9ca3af",
      "--status-warning": "#d97706",
      "--bg-sidebar": "#e8e8e8",
      "--status-error": "#dc2626",
      "--accent-green": "#16a34a",
      "--bg-hover": "rgba(0,0,0,0.06)",
    },
    terminal: {
      background: "#fdfdfd",
      foreground: "#4b5563",
      cursor: "#4b5563",
      selectionBackground: "#d0d0d0",
      black: "#4b5563",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#c18401",
      blue: "#4078f2",
      magenta: "#a626a4",
      cyan: "#0184bc",
      white: "#a0a4a8",
      brightBlack: "#9ca0a4",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#c8ccd4",
    },
  },
];

interface ThemeStore {
  themeName: string;
  fontSize: number;
  setTheme: (name: string) => void;
  getTheme: () => AppTheme;
  getThemes: () => AppTheme[];
  nextTheme: () => void;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  resetFontSize: () => void;
  setFontSize: (size: number) => void;
}

const DEFAULT_FONT_SIZE = 12;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 28;

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      themeName: "dark",
      fontSize: DEFAULT_FONT_SIZE,
      setTheme: (name) => set({ themeName: name }),
      getTheme: () => themes.find((t) => t.name === get().themeName) ?? themes[0],
      getThemes: () => themes,
      nextTheme: () => {
        const current = get().themeName;
        const idx = themes.findIndex((t) => t.name === current);
        const next = themes[(idx + 1) % themes.length];
        set({ themeName: next.name });
      },
      increaseFontSize: () => set((s) => ({ fontSize: Math.min(s.fontSize + 1, MAX_FONT_SIZE) })),
      decreaseFontSize: () => set((s) => ({ fontSize: Math.max(s.fontSize - 1, MIN_FONT_SIZE) })),
      resetFontSize: () => set({ fontSize: DEFAULT_FONT_SIZE }),
      setFontSize: (size) => set({ fontSize: Math.min(Math.max(size, MIN_FONT_SIZE), MAX_FONT_SIZE) }),
    }),
    {
      name: "racemo-theme",
      partialize: (state) => ({ themeName: state.themeName, fontSize: state.fontSize }),
    },
  ),
);

/**
 * Windows에서 border 색상을 약간 밝게 보정 (서브픽셀 렌더링 차이 보상).
 * Light 테마는 이미 충분히 대비되므로 보정하지 않음.
 */
const BORDER_KEYS = ["--border-subtle", "--border-default", "--border-strong"];
const WIN_BORDER_BOOST = 0x10; // +16 per channel

function boostHex(hex: string, amount: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const r = Math.min(parseInt(hex.slice(1, 3), 16) + amount, 255);
  const g = Math.min(parseInt(hex.slice(3, 5), 16) + amount, 255);
  const b = Math.min(parseInt(hex.slice(5, 7), 16) + amount, 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Apply CSS variables to :root */
export function applyCssTheme(theme: AppTheme): void {
  const root = document.documentElement;
  const needsBoost = isWindows() && theme.name !== "light";

  for (const [key, value] of Object.entries(theme.css)) {
    const adjusted = needsBoost && BORDER_KEYS.includes(key) ? boostHex(value, WIN_BORDER_BOOST) : value;
    root.style.setProperty(key, adjusted);
  }

  // Set color-scheme so native scrollbars match the theme
  root.style.colorScheme = theme.name === "light" ? "light" : "dark";
}
