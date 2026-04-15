## What's New

---

### Features
- **remote** — Host PTY resize synced to remote clients using min(host, remote) strategy
- **remote** — Device list now shows OS info immediately
- **remote** — Session list auto-requested on device connection
- **remote** — Browser mode now supports pane resizing
- **explorer** — Folder pinning in the file explorer
- **explorer** — File system watcher with real-time event updates, root-level drag & drop, and auto-refresh after commands
- **editor** — Code editor theme variables, Ctrl+A select all, and improved file reading

### Improvements
- **ai-log** — Provider icons now displayed in history rows
- **explorer** — Switched from HTML5 drag-and-drop to pointer-based implementation for better reliability
- **terminal** — Adjusted line height from 1.0 to 1.1 for improved readability
- **ui** — Replaced hardcoded colors with CSS variables for consistent theming

### Security
- **P2P remote terminal** — Strengthened security for remote terminal connections
- **Updater** — Removed shell injection vulnerability, switched to ditto, added auto-restart
- **Code review fixes** — Security, performance, and structural improvements based on code review

### Bug Fixes
- **remote** — Fixed terminal size sync and cursor misalignment during remote sessions
- **remote** — Unblocked file browsing outside home drive on Windows
- **remote** — Fixed account hosting incorrectly routing to pairing mode
- **remote** — Reverted PTY output session isolation to broadcast
- **window** — Fixed window resize and transparent background issues on Linux/Windows
- **explorer** — Fixed destination folder not refreshing after drag-and-drop move
- **ui** — Adjusted Linux window rounding to match macOS native size
- **signaling** — Fixed WebSocket URL query parameter naming
- **ai-log** — Improved Gemini log folder filtering and working directory matching accuracy
- **server/explorer** — Fixed fs-watcher dev conflicts, explorer drag-and-drop issues, and session cleanup
- **updater** — Gated unused PathBuf import on non-Windows targets
- **dialog** — Fixed @tauri-apps/plugin-dialog version mismatch (2.6.0 → 2.7.0)
