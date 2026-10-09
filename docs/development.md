# Developing MQLens

## Prerequisites

- [Node.js](https://nodejs.org/) 22.12+
- [Rust](https://www.rust-lang.org/tools/install) (stable) and the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS
- [`mongosh`](https://www.mongodb.com/docs/mongodb-shell/) on your `PATH` (only
  needed for the embedded shell)

## Development

```bash
npm install
npm run tauri dev      # run the desktop app with hot reload
```

For something to point the app at, seed the
[local demo database](demo-database.md) — synthetic collections, indexes,
a view, and GridFS files that exercise every major workflow (and match the
screenshots above).

Other useful commands:

```bash
npm run dev            # frontend only (browser, no Tauri APIs)
npm test               # frontend tests (Vitest)
npm run coverage:frontend   # frontend tests with coverage
cargo test --manifest-path src-tauri/Cargo.toml   # backend tests
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --summary-only --ignore-filename-regex 'src-tauri/src/(lib|main)\.rs'   # backend coverage
npm run build          # type-check + build the frontend bundle
```

The backend integration tests (and the coverage figure CI reports) need a real
MongoDB. They skip automatically when `MQLENS_TEST_MONGO_URI` is unset, so set it
to exercise the live database paths:

```bash
docker run -d -p 27017:27017 mongo:7
MQLENS_TEST_MONGO_URI=mongodb://localhost:27017 \
  cargo llvm-cov --manifest-path src-tauri/Cargo.toml --summary-only --ignore-filename-regex 'src-tauri/src/(lib|main)\.rs'
```

## Build

```bash
npm run tauri build    # produce a platform installer / bundle
```


See [contributing](../.github/CONTRIBUTING.md) for contribution guidelines and [the README](../README.md) for installation.
