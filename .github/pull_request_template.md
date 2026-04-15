## Summary

<!-- What does this PR do? Keep it brief. -->

## Changes

-

## Test Plan

Run locally before pushing — the **PR Check** workflow will verify these on Ubuntu automatically once you push:

- [ ] `cd src-tauri && cargo test` passes
- [ ] `cd src-tauri && cargo clippy -- -D warnings` — zero warnings
- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds
- [ ] `npx playwright test` passes (if UI changes)

> If this PR touches `tauri.conf.json`, `Cargo.toml`, or platform-specific code, mention it here so a maintainer can run a manual bundle check.

## Screenshots

<!-- If applicable, add screenshots or GIFs. -->
