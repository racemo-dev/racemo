# Self-Hosting A Signaling Server

Racemo's official signaling relay (`racemo-signal.fly.dev`) is operated as a
managed, closed-source service — see [open-core.md](open-core.md) for the
rationale. This document explains how to point a custom build of Racemo at
your own signaling infrastructure.

> **Note.** The server implementation itself is not included in this
> repository. You will need to provide your own relay that speaks the
> protocol documented in [PROTOCOL.md](PROTOCOL.md).

---

## What you change

Three places reference the default signaling endpoints. All three must be
updated consistently before you build:

| Location | Purpose |
|----------|---------|
| [`src-tauri/src/remote/mod.rs`](../src-tauri/src/remote/mod.rs) constants `DEFAULT_SIGNALING_URL` (`wss://…`) and `DEFAULT_SIGNALING_BASE_URL` (`https://…`) | Rust backend default endpoints |
| [`src/stores/settingsStore.ts`](../src/stores/settingsStore.ts) constant `DEFAULT_SIGNALING_URL` | Frontend fallback (used by the browser client path) |
| [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) `csp.connect-src` entry | Tauri CSP must explicitly allow your `wss://` / `https://` host |

Optionally, users can override the URL at runtime through the settings UI.
If you are only running self-hosted builds for yourself, hardcoding the
constants is fine; if you are distributing, prefer building a runtime
configuration surface.

---

## Server requirements

A compatible signaling server must:

- Accept WebSocket connections over `wss://` (TLS required).
- Implement the message types documented in [PROTOCOL.md](PROTOCOL.md).
- Enforce an origin allowlist that includes `tauri://localhost` and
  `https://tauri.localhost` (Tauri webview origins on macOS/Linux vs Windows).
- Authenticate clients (the official server uses GitHub device-flow JWTs;
  your implementation can differ as long as the client build is compatible).

Practical hints:

- Fly.io, Railway, or a plain Docker host behind a TLS-terminating proxy
  (Caddy, nginx) all work.
- Rate limiting is strongly recommended; see the protocol doc for safe
  per-IP / per-token ceilings.

---

## Trust and responsibility

- Running a custom signaling relay does **not** change the client-side trust
  model documented in [SECURITY.md](../SECURITY.md). Remote peers are still
  treated as trusted users.
- You are responsible for operating your relay safely — TLS certificates,
  abuse controls, log hygiene, etc.
- Security vulnerabilities in your custom relay are out of scope for the
  Racemo security process ([SECURITY.md](../SECURITY.md)). Please do not
  report self-hosted-only issues to that channel.

---

## Keeping in sync with upstream

When pulling upstream changes, watch for modifications to:

- `remote/mod.rs` — new fields in `SignalingMessage` or related types
- `settingsStore.ts` — new fallback URL shape
- `tauri.conf.json` CSP — additions to `connect-src`

If upstream ships a breaking protocol change you will need to update your
relay before rebuilding the client. Pin your fork to a known-good tag if
stability matters more than tracking `main`.
