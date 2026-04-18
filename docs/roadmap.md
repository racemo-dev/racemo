# Roadmap

This roadmap is directional.
Items listed here are priorities or active explorations, not delivery guarantees.
For bug reports and feature requests use [GitHub Issues](https://github.com/racemo-dev/racemo/issues);
items graduate from issues into this file once they have a concrete plan.

---

## Near-Term (next release window)

**Security & reliability**

- [ ] Local IPC socket hardening — move off `/tmp`, enforce exclusive creation with `0600` perms
- [ ] Local HTTP API (`127.0.0.1:7399`) bearer token auth
- [ ] Move Slack / Telegram integration secrets out of `localStorage` into the Tauri vault
- [ ] Per-pane tail buffer for secret masking (catch chunk-split secrets)
- [ ] CSP `'unsafe-inline'` removal after inline-style audit
- [ ] Unknown remote pane IDs rejected instead of silently warned

**Contributor experience**

- [ ] TESTING.md — Playwright + cargo test patterns
- [ ] Self-hosting guide for a custom signaling server
- [ ] macOS / Windows release automation (Linux is already automated)
- [ ] main-branch protection + PR labeler on the public mirror

---

## Product Work

- [ ] Image + PDF preview in the editor panel
- [ ] Process manager: dev-server port detection + one-click kill
- [ ] Command timeline — prompt-to-prompt jump, separators, execution time, exit-code badge
- [ ] Better session recovery UX across app restarts
- [ ] Terminal quality-of-life: `Ctrl+F` search, `Shift+PgUp/PgDn` scroll, Smart copy (ANSI-stripped), clickable URLs / file paths

## Remote & Collaboration

- [ ] Clearer host/client state visibility during WebRTC setup
- [ ] Diagnostics panel for remote connection failures
- [ ] Opt-in allowlist for Windows remote file access (currently all drives — see [SECURITY.md](../SECURITY.md))
- [ ] Lightweight browser client over time

## AI & Workflow

- [ ] Command-failure explanations and recovery suggestions
- [ ] Stronger AI history / timeline tooling across supported assistants
- [ ] Workflow helpers around commit generation and command recall

---

## Not A Commitment

Racemo is in developer preview.
Order and scope can change based on security work, maintenance needs, and real user feedback.
Items without a checkbox are still exploratory and may be dropped.
