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

### Server mode end to end

`src-tauri/src/server/e2e_tests.rs` checks [server mode](server-mode.md) against
a real [MQLens Server](https://github.com/mqlens/mqlens-server). Each test runs
an op class through the server and locally against the same MongoDB, and the
two must agree. The tests skip unless the server variables are set.

Start a MongoDB and a server with an owner account from a checkout of
`mqlens-server`. The keys and the password below are throwaway test values:

```bash
docker run -d -p 27017:27017 mongo:7
MQLENS_LISTEN_ADDR=127.0.0.1:18443 MQLENS_DATA_DIR=/tmp/mqlens-e2e \
MQLENS_MASTER_KEY=test-master-key MQLENS_JWT_SIGNING_KEY=test-signing-key \
MQLENS_BOOTSTRAP_TENANT=e2e MQLENS_BOOTSTRAP_EMAIL=owner@e2e.test \
MQLENS_BOOTSTRAP_PASSWORD=test-password \
  go run ./cmd/mqlens-server
```

Then run the tests from this repository:

```bash
MQLENS_TEST_SERVER_URL=http://127.0.0.1:18443 MQLENS_TEST_SERVER_TENANT=e2e \
MQLENS_TEST_SERVER_EMAIL=owner@e2e.test MQLENS_TEST_SERVER_PASSWORD=test-password \
MQLENS_TEST_MONGO_URI=mongodb://localhost:27017 \
  cargo test --manifest-path src-tauri/Cargo.toml server::e2e_tests
```

Each test creates its own server connection and database, and removes both.
Optional variables:

- `MQLENS_TEST_SERVER_MONGO_URI`: the MongoDB as the server reaches it, when that
  differs from `MQLENS_TEST_MONGO_URI` (a server in a container, for example).
- `MQLENS_TEST_SERVER_SHELL=1`: also check the shell, which needs `mongosh` on
  the server's host.

## Build

```bash
npm run tauri build    # produce a platform installer / bundle
```


See [contributing](../.github/CONTRIBUTING.md) for contribution guidelines and [the README](../README.md) for installation.
