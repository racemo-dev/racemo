# Contributing to Racemo

Thank you for your interest in contributing to Racemo! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js 20+
- Rust 1.75+
- Platform-specific Tauri v2 dependencies ([see Tauri docs](https://v2.tauri.app/start/prerequisites/))

### Setup

```bash
git clone https://github.com/racemo-dev/racemo.git
cd racemo
npm ci
npm run tauri:dev
```

Development mode requires the Vite dev server to bind to port `5173`. If the port is unavailable, stop the existing process or adjust the Vite/Tauri dev configuration (`src-tauri/tauri.conf.json` → `devUrl`) before running `npm run tauri:dev`.

## Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run the verification steps below
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.)
6. Push and open a Pull Request

## Verification (Required Before PR)

All changes must pass the following checks in order. Each command should be run from the repository root:

```bash
npm run check                                                     # Lint + TypeScript check
cd src-tauri && cargo test                                        # Tauri backend tests
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings   # No warnings
npm run build                                                     # Frontend build
npx playwright test                                               # E2E tests
```

`npm run check` runs ESLint and the TypeScript compiler in `--noEmit` mode. Use `npm run lint:fix` to auto-fix what can be fixed automatically.

### Pre-commit hook

When you run `npm install`, [husky](https://typicode.github.io/husky/) sets up a pre-commit hook that runs ESLint on staged `.ts`/`.tsx` files via [lint-staged](https://github.com/lint-staged/lint-staged). **Commits with lint errors will be blocked**, so you'll catch issues before they reach CI. If you ever need to bypass it for a work-in-progress commit, use `git commit --no-verify` (but the PR Check workflow will still enforce it).

## Continuous Integration

When you open a pull request, GitHub Actions automatically runs the **PR Check** workflow (`.github/workflows/pr-check.yml`) on Ubuntu. It executes:

- `npm run lint` — ESLint
- `cd src-tauri && cargo test` — Rust tests
- `cd src-tauri && cargo clippy -- -D warnings` — zero warnings required
- `npm run build` — frontend build (TypeScript + Vite)

Your PR cannot be merged until all checks pass. Run the verification commands above locally first to avoid round-trips.

> **Note:** PR Check does not run a full Tauri bundle build. Native bundling (`tauri build`) is verified separately by maintainers before each release. If your PR touches `tauri.conf.json`, `Cargo.toml`, or platform-specific code, please mention it in the PR description so a maintainer can run a manual bundle check.

## Project Structure

- `src/` — React frontend (TypeScript)
- `src-tauri/` — Tauri backend (Rust)
- `docs/` — Documentation (internal)

## Code Style

- **Rust**: Follow `cargo clippy` recommendations. Zero warnings.
- **TypeScript/React**: ESLint + Prettier (configured in project).
- Keep changes focused — one concern per PR.

## Reporting Issues

- Use [GitHub Issues](https://github.com/racemo-dev/racemo/issues)
- Include OS, version, and steps to reproduce

## Debugging

DevTools is disabled by default in production builds. To enable it for development, set `devtools` to `true` in `src-tauri/tauri.conf.json`:

```json
"devtools": true
```

## Release Builds

Official release builds are maintainer-only. Published releases use Tauri updater signing. The private signing key (`TAURI_SIGNING_PRIVATE_KEY`) is not included in this repository and must be provided through maintainer-local environment variables or CI secrets.

Contributors do not need the signing key for normal development or PR validation.

Per-platform release pipeline:

| Platform | How it builds | Workflow / Script |
|----------|---------------|-------------------|
| Linux    | GitHub Actions on `v*` tag push | `.github/workflows/release-linux.yml` |
| macOS    | Local script (maintainer machine) | `gh-local-release-mac.sh` |
| Windows  | Local script (maintainer machine, Certum code signing) | `gh-local-release-windows.ps1` |

Linux releases are fully automated — pushing a `v*` tag triggers a build and uploads artifacts (`.AppImage`, `.AppImage.sig`, `.deb`) to the GitHub Release as a draft. macOS and Windows are released from a maintainer's machine because they require platform-specific code signing setup.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
