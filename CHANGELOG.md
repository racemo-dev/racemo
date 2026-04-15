# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.4] - 2026-04-09

### Added
- Remote terminal sharing restored — share a session across devices signed in to the same GitHub account over P2P WebRTC
- Remote session tabs show the correct platform icon (macOS / Linux / Windows) via a new `host_os` field on the session proto
- Worktree integration — creating a git worktree auto-opens its session, deleting a worktree cleans up the related session
- VS Code-style sidebar shortcuts: `Cmd+Shift+E/F/G/H/L` and `Cmd+,`
- Share/Connect status badges restored in the title bar; sidebar login/user menu restored
- Frontend logs now forward through a new `fe_log` Tauri command into the same log file as the backend
- `racemo-server` daemon writes to a persistent file on Unix instead of the Tauri-redirected `/dev/null`

### Improved
- Token storage moved from the OS keychain to a machine-bound ChaCha20-Poly1305 encrypted file, removing the repeated keychain password prompt on every dev rebuild on macOS
- Connect icon redesigned as a cleaner two-ring chain link
- macOS traffic-light spacing increased so the first tab no longer sits flush against the close button
- README: Remote feature section and comparison row restored after the feature came back

### Fixed
- **Share flow** — clicking Share while logged out now waits for the GitHub device flow to complete and automatically resumes hosting once authenticated; no second click required
- **Device-flow popup** — accidentally clicking outside the GitHub auth modal no longer cancels the in-flight login; polling continues in the background and picks up the token when the browser flow finishes
- **Remote input** — keys typed in a remote terminal tab now reach the host PTY. A `pty_id` vs pane-container `id` namespace conflation in the pane validator was silently rejecting every `TerminalInput` message
- **WebRTC connectivity** — same-machine and same-LAN remote connections now actually establish. ICE gathering is restricted to IPv4 UDP (works around a webrtc-rs bind failure on macOS link-local IPv6), mDNS candidates are disabled (removes a `0.0.0.0:5353` collision when one process hosts and connects at once), and the overly aggressive private-IP candidate filter has been removed (account-bound peers are not third parties)
- **Updater UI** — the "Updating… 0%" toast no longer stays frozen when the download source (GitHub asset redirect) does not advertise Content-Length; the toast now shows downloaded KB/MB instead
- **Settings** — `editorMode` default is now `internal` on every platform

### Security
- `tauri.conf.json` runtime `devtools` flag set to `false` as defense in depth; the `devtools` Cargo feature remains opt-in so release builds continue to ship without inspector support
- `package.json` now declares `license: Apache-2.0` to match `Cargo.toml` and the `LICENSE` file

### Changed
- **macOS release ships as a single universal binary.** Instead of separate `Racemo_<ver>_Mac_aarch64.dmg` / `Racemo_<ver>_Mac_x64.dmg` artifacts, v0.0.5 and later ship `Racemo_<ver>_Mac.dmg` with both Apple Silicon and Intel code fused together. Users no longer have to pick an architecture, and the release page's macOS asset count is cut in half. Existing installs continue to auto-update normally — the updater manifest points both `darwin-aarch64` and `darwin-x86_64` entries at the same universal bundle.

### Removed
- **Linux `.deb` package dropped from release artifacts.** Tauri's built-in updater on Linux only replaces AppImage binaries; a `.deb` install cannot be in-place upgraded, so users who installed the deb were silently stuck on whatever version they first grabbed. Rather than ship an artifact whose users can never update themselves, we ship only the `.AppImage` (x64 and aarch64) going forward. If you were on a deb install, download the AppImage once and auto-updates will work from that point on. A proper APT repo may come back in a future release.

## [0.0.3] - 2026-04-06

### Added
- Inline browser tabs with URL autocomplete and navigation
- Unified AI logs panel (Claude Code, Codex CLI, Gemini CLI, OpenCode)
- Shell integration via OSC 133 prompt markers (bash/zsh/fish)
- Mermaid diagram rendering in the built-in markdown editor
- Tab context menu (close, close others, close to the right, rename)
- Explorer .gitignore-aware filtering and document-only view mode
- Multi-language syntax highlighting in the built-in editor
- Browser tab state save/restore

### Improved
- Git background sync interval reduced from 10s to 5s
- Claude log panel filters across all session panes
- Markdown editor source mode toggle from settings
- AI template input replaced with curated preset dropdown
- Updater moved to title bar with improved empty state

### Security
- HTTP API hardened with path traversal protection and CORS restrictions
- CSP tightened — removed `unsafe-eval` and `unsafe-inline` from script-src
- Remote access: private IP/mDNS filtering, pairing code entropy increased to 8 digits
- DOMPurify applied to Mermaid SVG and Marked HTML output
- GitHub Actions pinned to commit SHA
- Signaling server CORS restricted to Tauri origin only

### Fixed
- Abnormally small window on HiDPI display changes
- Webview creation lock not releasing on failure
- Commit tooltip position to follow mouse cursor
- Broadcast input sync and status dot visibility
- OpenCode SQLite connection (removed unnecessary NO_MUTEX flag)
- Linux Tux icon replaced with official SVG
