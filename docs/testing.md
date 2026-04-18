# Testing Guide

This project has three test suites. All three should stay green before a PR
is ready for review.

| Suite | Command | Scope |
|-------|---------|-------|
| Rust unit + integration | `cd src-tauri && cargo test` | Tauri command layer, IPC server, remote host, PTY, editor/git helpers |
| Lint / static | `npm run lint` + `cd src-tauri && cargo clippy -- -D warnings` | Style, unused code, obvious bugs |
| Frontend build | `npm run build` | Production Vite + Tauri bundle sanity check |
| End-to-end | `npx playwright test` | Browser-level smoke tests that drive the dev server |

The same commands run in CI — see [.github/workflows/pr-check.yml](../.github/workflows/pr-check.yml).

---

## Rust tests

- **Location.** Tests live either next to the module under a
  `#[cfg(test)] mod tests` block, or in `src-tauri/src/tests/` for multi-module
  integration cases.
- **Naming.** Files follow `{module}_test.rs`. Functions follow
  `<behavior>_<condition>_<expected>` — e.g. `resize_pty_remote_no_broadcast_when_size_unchanged`.
- **No global state.** Prefer constructing fresh `IpcServer` / `SessionStore`
  instances per test to keep them parallel-safe.
- **No real clocks or network.** Use explicit durations and `tokio::time::pause`
  where timing matters. Mock WebRTC peers with loopback channels instead of
  real STUN/TURN.
- **Run a single test.** `cargo test <substring>` or
  `cargo test -- --nocapture` for stdout.

## Frontend & E2E

- **Unit tests** for frontend helpers can live under `src/**/*.test.ts(x)`
  alongside the subject. They are executed through the Vite/Vitest toolchain
  when we add it; for now, critical frontend logic is covered via Rust layer
  tests and Playwright.
- **Playwright.** Tests live in [`tests/`](../tests) and are configured in
  [`playwright.config.ts`](../playwright.config.ts). The dev server is started
  automatically.
- **Flake prevention.** Do not `sleep` or wait on wall-clock time. Use
  Playwright's auto-waiting locators (`expect(locator).toBeVisible()`).
  Anything that depends on a real PTY roundtrip should assert on observable
  DOM state, not on fixed delays.

---

## What to add when you change code

- New Tauri command → unit test in `#[cfg(test)]` exercising the happy path
  and at least one error path.
- New IPC message type → a round-trip serde test.
- New user-facing UI flow → a Playwright smoke test in `tests/`.
- Security-sensitive change → document the invariant in the test name.

If you change behavior that a test was verifying and the test goes red, fix
the code — do not rewrite the test to match the new behavior unless the test
itself was wrong.
