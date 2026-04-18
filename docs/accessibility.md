# Accessibility

Racemo is a GPU-backed terminal application, which puts a hard ceiling on
some accessibility affordances (the terminal surface is a canvas, not
structured text). This document captures what we do support today, what is
explicitly out of scope for now, and what we want from contributors.

---

## Supported today

- **Keyboard-first operation.** All menus, sidebar entries, dialogs, and
  buttons can be reached with `Tab` / `Shift+Tab` and activated with
  `Enter` / `Space`.
- **Explicit focus outlines.** Focus rings are never removed globally. If
  you need to style focus differently, prefer `:focus-visible` and keep the
  outline perceptible against the current theme.
- **Respect for OS settings.** The app honors the OS-reported prefers-color-scheme
  and reduced-motion hints where possible.
- **Logical semantics for chrome.** The sidebar, editor panel, terminal
  pane, and modals all use standard ARIA roles (`dialog`, `tablist`, `tree`,
  etc.) so they cooperate with assistive technology at the chrome level.

## Known limitations

- **Terminal output is not screen-reader addressable.** xterm.js renders to
  a canvas; the scrollback is not exposed as accessible text. Screen-reader
  users can copy buffer contents and read them elsewhere, but live
  announcement of terminal output is not available.
- **Inline code diff views** currently render through a syntax highlighter
  that bypasses some semantic tagging. We are tracking improvements but
  have no ETA.
- **Drag-and-drop layout editing** does not yet have a keyboard-only
  equivalent for every gesture.

## What we ask from contributors

When adding UI, please:

1. Ensure every interactive element has either a visible label or an
   `aria-label`.
2. Preserve `:focus-visible` outlines.
3. Prefer semantic elements (`<button>`, `<a>`, `<label>`) over generic
   `<div>` / `<span>` with click handlers.
4. Test keyboard navigation — a PR that only works with a mouse is not
   complete.
5. For long-running visual effects, respect `prefers-reduced-motion`.

If you run into an accessibility bug, please open an issue tagged
`a11y` — even small reports help prioritize fixes.
