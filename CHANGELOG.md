# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.8] - 2026-04-17

### Added
- **Per-session Secret Masking is now actually applied to terminal output.** Previously the privacy toggle existed but `maskSecrets()` was never called — turning it on had no effect. The masker now runs on every PTY write (local and remote) via a new `writeToTerminal()` helper in `src/lib/terminalWrite.ts`.
- `ARCHITECTURE.md` at the repository root for contributor onboarding.
- `.github/CODEOWNERS` for automatic reviewer assignment.
- `.github/FUNDING.yml` enabling the Sponsor button.
- `package.json` metadata: `description`, `keywords`, `homepage`, `repository`, `bugs`, `engines`.
- `SECURITY.md` — new **Remote Host Trust Model** section documenting the intentional Windows path policy (remote peers may access all drives because non-system-drive workflows like `D:\work` are common).

### Fixed
- **Secret Masking + ANSI regression.** A long secret (e.g. 40-char API key) being masked to 8-char dots used to offset every subsequent ANSI color escape, corrupting terminal rendering. The detector was rewritten to tokenise input into ANSI and plain-text segments and apply patterns only to plain text; ANSI sequences are passed through untouched, so length changes no longer misalign anything.
- **`webview_navigate` no longer uses `eval()`.** Switched to `Webview::navigate()` (Tauri 2.10 API) with explicit URL parsing via `tauri::Url::parse()`.
- **Root-level React crashes no longer blank the whole window.** `ErrorBoundary` is now applied at the app root (Sidebar / TabBar / PaneLayout / StatusBar / all lazy modals are covered) with a minimal "Application error" fallback and Reload button. The existing InlineEditorPanel boundary is preserved underneath.
- **Mutex poison crashes** in `git.rs` and `ipc/client.rs`. `.lock().expect("poisoned")` replaced with `.lock().unwrap_or_else(|e| e.into_inner())`, so a thread panic inside a lock no longer takes down the whole process.
- **Signaling URL inconsistency.** The browser fallback in `remoteStore` was using a hardcoded `wss://racemo-signal.fly.dev` that could drift from the `DEFAULT_SIGNALING_URL` constant. Both locations now derive from the same constant via a new `DEFAULT_SIGNALING_WS_URL`.

### Security
- `npm audit` clean. Upgraded Vite to `^7.3.2` and ran `npm audit fix`, clearing the previously reported advisories (Vite, `chevrotain`/`lodash-es` via mermaid transitive, `dompurify`, `protobufjs`).

### Known Limitations
- Secret masking operates **per PTY write chunk**. A secret split across two chunks (e.g. `sk-abc` arriving in one burst and `def123...` in the next) is not detected in this release. A per-pane tail buffer is planned for v0.0.9.

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
