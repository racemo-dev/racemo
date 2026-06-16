## What's New

---

### Features
- **terminal** — New bottom input bar (TerminalInputBar) with image DnD attach, double-enter send, and inline `/clear` and close buttons
- **ai-commit** — Redesigned as a draggable non-blocking floating panel with inline/dock modes; promoted to a full GitPanel overlay
- **ai-commit** — Auto-generate commit messages and query commit patches over the remote API
- **image** — Compression progress spinner and savings popup on attachment thumbnails; new `compress_image_for_ai` command
- **remote** — Mobile sync v2: command completion notifications, pull-based prompt model, persistent `device_id` across restarts
- **remote** — Desktop ↔ mobile prompts WS sync pipeline with a new signaling wire protocol
- **prompts** — Dedicated sidebar panel with testing status, folder filter, and folder tag UI
- **remote** — File API expansion: `read_file` range reads, `file_stat`, `write_file` `createParents` + base64 encoding, deep-path validation
- **remote** — Editor sync: open/close editor tabs and saved files reflected on the host; diff viewing with `contextLines` in remote sessions
- **remote** — Worktree DataChannel API; chunked `ApiResponse` to prevent SCTP drops on large payloads
- **presence** — Desktop presence loop, `update_sessions` WS push to signaling, presence channel split, remote share start
- **remote** — Expanded mobile commit/diff/session API surface and hardened error handling
- **pty** — Ack-based flow control + alt-screen scrollback separation, child process cleanup, history expanded to 1 MB with ESC-safe trim
- **terminal** — Heavy recovery shortcut for unresponsive terminals; per-pane last executed command persisted
- **pane** — `Cmd+Arrow` to move between panes; tab-close confirmation dialog when closing the last pane
- **sidebar** — Terminals & Servers popup
- **explorer** — Right-click context menu on empty area; tooltips on file/folder names
- **tab** — Recent folders show full path with double-click to open in a new tab
- **git** — Diff view moved from an overlay popup to an editor panel tab
- **signaling** — Supabase 24h keepalive ping to avoid free-plan suspension
- **terminal** — Toast UI restoration plus an on-demand WebGL glyph recovery command

### Improvements
- **prompts** — Persisted store migrated to the Tauri filesystem
- **api** — Removed local axum REST API on port 7399 in favor of the IPC client
- **command-palette** — Removed unused snippet feature

### Bug Fixes
- **terminal** — xterm WebGL atlas merge glyph corruption fixed at the root, with a recovery mechanism; CJK glyph refresh on addon load; resize `NaN` guard and ghost-text artifact cleanup; canvas refresh after pane close
- **pty** — Restored history no longer wiped by initial clear; resize min-clamp removed and duplicate history send prevented; `PtyHistoryRequest` split out with single-lock query and uniform error handling
- **terminal** — Enter on empty input sends a newline; `^[OA` print after abnormal exit fixed; IME interceptor guards the new input bar textarea
- **ui** — Drag & drop double-firing fixed; hit-test scoped to current pane container; z-index / physical-pixel mismatch false positives resolved; file DnD allowed on inactive panes; image drop no longer force-opens a closed input bar
- **worktree** — Recursive flag restored when deleting folders; root directory context menu hides rename/trash
- **session** — `session-list-changed` stale snapshot and double `setSessions` fixed; inactive session hiding switched to `display:none`; `PtyExit` no longer kills the whole connection
- **remote** — Windows HOME-external path access restriction restored; `PtyResized` delivered to mobile clients; browser client `PtyHistoryRequest` send method added; API errors logged on the server
- **signaling** — `host_disconnect` sends `shutting_down` to mobile + session-change tracing; JWT expiry refreshes the token instead of forcing logout; Fly.io idle-machine shutdown prevented via self-ping; WS connection sends `Origin` header; host plan verification moved to DB query; WebRTC signal types added to the relay allowlist; 403 message generalized
- **editor** — Auto-save no longer triggers fs-watcher reload (cursor reset gone); save failures surface as toasts; resize ratio preserved; file saves unified through `apiWriteTextFile` for remote sessions
- **browser** — Popup layers no longer hidden behind the webview; browser panel uses full width when there is no session
- **diff** — UI-scale support and header layout fixes
