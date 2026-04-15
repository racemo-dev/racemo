export const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  feat:     { bg: "color-mix(in srgb, var(--accent-cyan) 12%, transparent)", text: "var(--accent-cyan)" },
  fix:      { bg: "color-mix(in srgb, var(--accent-red) 12%, transparent)", text: "var(--accent-red)" },
  refactor: { bg: "color-mix(in srgb, var(--accent-purple) 12%, transparent)", text: "var(--accent-purple)" },
  docs:     { bg: "color-mix(in srgb, var(--accent-green) 12%, transparent)", text: "var(--accent-green)" },
  style:    { bg: "color-mix(in srgb, var(--accent-yellow) 12%, transparent)", text: "var(--accent-yellow)" },
  test:     { bg: "color-mix(in srgb, var(--accent-blue) 12%, transparent)", text: "var(--accent-blue)" },
  chore:    { bg: "color-mix(in srgb, var(--text-muted) 12%, transparent)", text: "var(--text-muted)" },
  perf:     { bg: "color-mix(in srgb, var(--status-warning) 12%, transparent)", text: "var(--status-warning)" },
};

export const AI_COMMIT_STYLES = `
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  @keyframes thinking-dot {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.9); }
    40% { opacity: 1; transform: scale(1.4); }
  }
  @keyframes wave-bar {
    0%, 100% { height: 4px; opacity: 0.35; }
    50% { height: 22px; opacity: 1; }
  }
  .ai-output-line strong { color: var(--text-primary); font-weight: 700; }
  .ai-output-line em { color: var(--accent-blue); font-style: italic; }
  .ai-output-line code { background: var(--bg-overlay); color: var(--accent-red); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
`;

export const TERMINAL_STYLES = `
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes wave-bar { 0%, 100% { height: 4px; opacity: 0.35; } 50% { height: 18px; opacity: 1; } }
  .git-output-line strong { color: var(--text-primary); font-weight: 700; }
  .git-output-line em { color: var(--accent-blue); font-style: italic; }
  .git-output-line code { background: var(--bg-overlay); color: var(--accent-red); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
  .git-output-line ul, .git-output-line ol { margin: 2px 0 2px 16px; padding: 0; }
  .git-output-line li { margin: 1px 0; }
  .git-output-line a { color: var(--accent-blue); text-decoration: underline; }
`;
