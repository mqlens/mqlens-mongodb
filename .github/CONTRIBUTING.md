# Contributing to MQLens

Thanks for your interest in improving MQLens! This guide covers how to set up the
project, the development workflow, and how to get changes merged.

By participating, you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug or workflow issue** — use the in-app **Help → Report a bug**, or
  open a [bug report](https://github.com/mqlens/mqlens-mongodb/issues/new?template=bug_report.yml).
- **Request a feature** — open a [feature request](https://github.com/mqlens/mqlens-mongodb/issues/new?template=feature_request.yml).
  Larger ideas are tracked on the [roadmap board](https://github.com/orgs/mqlens/projects/2) and under the
  [`roadmap`](https://github.com/mqlens/mqlens-mongodb/labels/roadmap) label — see [docs/ROADMAP.md](../docs/ROADMAP.md).
- **Pick up an issue** — [`good first issue`](https://github.com/mqlens/mqlens-mongodb/labels/good%20first%20issue)
  is a good place to start. Comment to claim it.
- **Improve docs** — README, in-app text, or the website under `website/`.

## Prerequisites

- **Node.js 20+** and **npm**
- **Rust** (stable, via [rustup](https://rustup.rs))
- Platform build dependencies for [Tauri v2](https://tauri.app/start/prerequisites/).
  On Debian/Ubuntu: `libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev
  libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev libssl-dev libkrb5-dev
  clang libclang-dev build-essential`.

## Getting started

```bash
git clone https://github.com/mqlens/mqlens-mongodb.git
cd mqlens-mongodb
npm ci
npm run tauri dev      # run the desktop app (Rust backend + React frontend)
```

Other useful scripts:

```bash
npm run dev            # frontend only (Vite), no Tauri backend
npm run build          # type-check + production frontend build (tsc && vite build)
npm run tauri build    # build the native app bundles
```

## Tests & checks

Please make sure these pass before opening a PR:

```bash
npx tsc --noEmit                                   # TypeScript type-check
npm test                                           # frontend tests (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml    # Rust tests
```

The CI workflow runs these on every PR.

## Development workflow

- **Branch from `dev`** and open your PR **against `dev`** (the default branch).
  `main` is release-only — merges to `main` cut a versioned release.
- Use a focused branch name, e.g. `feat/...`, `fix/...`, `docs/...`.
- Keep PRs scoped to one change; include tests for new behavior.
- Follow [Conventional Commits](https://www.conventionalcommits.org) for commit
  messages (`feat:`, `fix:`, `docs:`, `chore:`, …) — the release version is
  derived automatically from these on merge to `main`.
- Match the surrounding code's style and patterns; this repo favors small,
  focused files with clear responsibilities.

## Privacy & security expectations

MQLens is local-first with **zero telemetry**. Please don't add analytics,
crash reporters, network beacons, or anything that phones home. Never commit
secrets, credentials, or real connection strings. For security issues, see
[SECURITY.md](SECURITY.md) — do **not** open a public issue.

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache-2.0](../LICENSE) license.
