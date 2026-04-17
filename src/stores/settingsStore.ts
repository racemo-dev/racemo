import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ShellType } from "../types/session";
import { isMac, isWindows, isLinux, canRenderCJK } from "../lib/osUtils";

const MAC_SHELLS: ShellType[] = ["Zsh", "Bash", "Fish"];
const WIN_SHELLS: ShellType[] = ["PowerShell", "Cmd", "Wsl"];
const VALID_SHELLS: ShellType[] = [...MAC_SHELLS, ...WIN_SHELLS];
const isValidShell = (shell: unknown): shell is ShellType =>
  typeof shell === "string" && VALID_SHELLS.includes(shell as ShellType);

const PLATFORM_DEFAULT_SHELL: ShellType =
  isMac() ? "Zsh"
    : isWindows() ? "PowerShell"
      : "Bash"; // Linux default

/** 현재 플랫폼에서 사용 가능한 셸인지 검사 */
const isShellForCurrentPlatform = (shell: ShellType): boolean => {
  if (isMac() || (!isMac() && !isWindows())) return MAC_SHELLS.includes(shell);
  return WIN_SHELLS.includes(shell);
};

export type Language = "en" | "ko";

const ALL_LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
];

/** CJK 폰트가 없으면 한국어 항목 제거 */
export const LANGUAGES = ALL_LANGUAGES.filter(
  (l) => l.value !== "ko" || canRenderCJK()
);

/** 시스템 언어를 감지해 렌더 가능한 언어면 반환, 아니면 "en" */
function detectLanguage(): Language {
  const supported = LANGUAGES.map((l) => l.value);
  const nav = navigator.languages ?? [navigator.language];
  for (const lang of nav) {
    const code = lang.split("-")[0] as Language;
    if (supported.includes(code)) return code;
  }
  return "en";
}

// AI CLI template - use {prompt} as placeholder
export const AI_TEMPLATES = [
  { value: "claude -p {prompt}", label: "Claude" },
  { value: "gemini -p {prompt}", label: "Gemini" },
  { value: "codex exec {prompt}", label: "Codex" },
  { value: "opencode run {prompt}", label: "OpenCode" },
];
export const DEFAULT_AI_TEMPLATE = AI_TEMPLATES[0].value;

export const DEFAULT_SIGNALING_URL = "https://racemo-signal.fly.dev";
export const DEFAULT_SIGNALING_WS_URL = DEFAULT_SIGNALING_URL.replace(/^http/, "ws");

interface SettingsStore {
  fontFamily: string;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  notificationEnabled: boolean;
  notificationThreshold: number;
  soundEnabled: boolean;
  slackWebhookUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  defaultShell: ShellType;
  historyCompletionCount: number;
  language: Language;
  aiTemplate: string;
  shareAliveEnabled: boolean;
  singleClickOpen: boolean;
  imeInterceptEnabled: boolean;
  smartImeEnabled: boolean;

  blockHangulKey: boolean;
  editorMode: "external" | "internal";
  diffMode: "panel" | "window";
  explorerDocsFilter: boolean;
  markdownSourceMode: boolean;
  setFontFamily: (family: string) => void;
  setCursorStyle: (style: "block" | "underline" | "bar") => void;
  setCursorBlink: (blink: boolean) => void;
  setScrollback: (lines: number) => void;
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationThreshold: (seconds: number) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setSlackWebhookUrl: (url: string) => void;
  setTelegramBotToken: (token: string) => void;
  setTelegramChatId: (chatId: string) => void;
  setDefaultShell: (shell: ShellType) => void;
  setHistoryCompletionCount: (count: number) => void;
  setLanguage: (lang: Language) => void;
  setAiTemplate: (template: string) => void;
  setShareAliveEnabled: (enabled: boolean) => void;
  setSingleClickOpen: (enabled: boolean) => void;
  setImeInterceptEnabled: (enabled: boolean) => void;
  setSmartImeEnabled: (enabled: boolean) => void;

  setBlockHangulKey: (enabled: boolean) => void;
  setEditorMode: (mode: "external" | "internal") => void;
  setDiffMode: (mode: "panel" | "window") => void;
  setExplorerDocsFilter: (enabled: boolean) => void;
  setMarkdownSourceMode: (enabled: boolean) => void;
}

export const FONT_FAMILIES = [
  // Cross-platform (requires installation)
  { value: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace", label: "JetBrains Mono" },
  { value: "'Fira Code', 'Cascadia Code', 'Consolas', monospace", label: "Fira Code" },
  // Windows fonts
  { value: "'Cascadia Code', 'Cascadia Mono', 'Consolas', monospace", label: "Cascadia Code" },
  { value: "'Consolas', monospace", label: "Consolas" },
  { value: "'Lucida Console', monospace", label: "Lucida Console" },
  // macOS fonts
  { value: "'SF Mono', 'Monaco', 'Menlo', monospace", label: "SF Mono" },
  { value: "'Monaco', 'Menlo', monospace", label: "Monaco" },
  { value: "'Menlo', monospace", label: "Menlo" },
  // System default
  { value: "monospace", label: "System Mono" },
];

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      fontFamily: "'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Monaco', 'Menlo', monospace",
      cursorStyle: "bar" as const,
      cursorBlink: false,
      scrollback: 10000,
      notificationEnabled: true,
      notificationThreshold: 10,
      soundEnabled: false,
      slackWebhookUrl: "",
      telegramBotToken: "",
      telegramChatId: "",
      defaultShell: PLATFORM_DEFAULT_SHELL,
      historyCompletionCount: 5,
      language: detectLanguage(),
      aiTemplate: DEFAULT_AI_TEMPLATE,
      shareAliveEnabled: false,
      singleClickOpen: true,
      imeInterceptEnabled: true,
      smartImeEnabled: true,

      blockHangulKey: false,
      editorMode: "internal" as "external" | "internal",
      diffMode: "panel" as const,
      explorerDocsFilter: false,
      markdownSourceMode: false,
      setFontFamily: (family) => set({ fontFamily: family }),
      setCursorStyle: (style) => set({ cursorStyle: style }),
      setCursorBlink: (blink) => set({ cursorBlink: blink }),
      setScrollback: (lines) => set({ scrollback: Math.min(Math.max(lines, 1000), 100000) }),
      setNotificationEnabled: (enabled) => set({ notificationEnabled: enabled }),
      setNotificationThreshold: (seconds) => set({ notificationThreshold: Math.min(Math.max(seconds, 5), 300) }),
      setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
      setSlackWebhookUrl: (url) => set({ slackWebhookUrl: url }),
      setTelegramBotToken: (token) => set({ telegramBotToken: token }),
      setTelegramChatId: (chatId) => set({ telegramChatId: chatId }),
      setDefaultShell: (shell) => set({ defaultShell: shell }),
      setHistoryCompletionCount: (count) => set({ historyCompletionCount: Math.min(Math.max(count, 1), 20) }),
      setLanguage: (lang) => set({ language: lang }),
      setAiTemplate: (template) => set({ aiTemplate: template }),
      setShareAliveEnabled: (enabled) => set({ shareAliveEnabled: enabled }),
      setSingleClickOpen: (enabled) => set({ singleClickOpen: enabled }),
      setImeInterceptEnabled: (enabled) => set({ imeInterceptEnabled: enabled }),
      setSmartImeEnabled: (enabled) => set({ smartImeEnabled: enabled }),

      setBlockHangulKey: (enabled) => set({ blockHangulKey: enabled }),
      setEditorMode: (mode) => set({ editorMode: mode }),
      setDiffMode: (mode) => set({ diffMode: mode }),
      setExplorerDocsFilter: (enabled) => set({ explorerDocsFilter: enabled }),
      setMarkdownSourceMode: (enabled) => set({ markdownSourceMode: enabled }),
    }),
    {
      name: "racemo-settings",
      version: 3,
      migrate: (persisted, fromVersion) => {
        const state = persisted as Record<string, unknown>;
        if (fromVersion < 1) {
          // v0: language was hardcoded "ko" — reset to system language if still "ko"
          if (state.language === "ko") {
            state.language = detectLanguage();
          }
        }
        if (fromVersion < 2) {
          // v1: Linux defaults to "internal" (popup) settings mode
          if (isLinux() && state.editorMode === "external") {
            state.editorMode = "internal";
          }
        }
        if (fromVersion < 3) {
          // v2: all platforms default to "internal" (pane) settings mode
          state.editorMode = "internal";
        }
        return state;
      },
      merge: (persisted, current) => {
        const state = persisted as Partial<SettingsStore> | undefined;

        // If there's no persisted state at all, just use the current default.
        if (!state) return current;

        return {
          ...current,
          ...state,
          // Migration: If singleClickOpen is not present in the persisted state,
          // or if it's the first time we're introducing this, force it to true.
          // Since it was 'false' by default before, we can't perfectly know if the user
          // explicitly set it to false. However, for a "fresh install" or those who
          // haven't touched it, we want it to be true.
          singleClickOpen: state.singleClickOpen ?? true,

          // Validate defaultShell — 다른 플랫폼에서 저장된 셸이면 현재 플랫폼 기본값으로 리셋
          defaultShell: (isValidShell(state.defaultShell) && isShellForCurrentPlatform(state.defaultShell))
            ? state.defaultShell : PLATFORM_DEFAULT_SHELL,

          // Migration: "window"/"panel" → "external"/"internal"; default is "internal" (pane mode)
          editorMode: (state.editorMode === "external" || state.editorMode === "internal")
            ? state.editorMode
            : "internal",

          // aiTemplate — 프리셋에 없는 값이면 기본값으로 리셋
          aiTemplate: (state.aiTemplate && AI_TEMPLATES.some((t) => t.value === state.aiTemplate))
            ? state.aiTemplate : DEFAULT_AI_TEMPLATE,

          // CJK 언어가 저장돼 있어도 폰트 없으면 "en"으로 fallback
          language: (state.language && LANGUAGES.some((l) => l.value === state.language))
            ? state.language
            : detectLanguage(),
        };
      },
    },
  ),
);
