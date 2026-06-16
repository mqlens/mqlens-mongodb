# Security Policy

MQLens is a local-first MongoDB GUI that handles connection credentials, so we
take security seriously. Thank you for helping keep users safe.

## Supported versions

Security fixes target the **latest release**. Please upgrade to the newest
version (the in-app updater or the [Releases](https://github.com/mqlens/mqlens-mongodb/releases/latest)
page) before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately, using either:

1. **GitHub Private Vulnerability Reporting** (preferred) — on the repository's
   **Security** tab, click **Report a vulnerability**. This keeps the report
   confidential until a fix is released.
2. **Email** — **dev@mqlens.com** with subject `MQLens security`.

Please include:

- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Affected version and OS
- Any suggested remediation

We aim to acknowledge reports within a few days and to coordinate a fix and
disclosure timeline with you. We'll credit reporters who wish to be named once a
fix ships.

## Scope

In scope: the desktop app and its handling of credentials, the encrypted vault,
the connection layer (TLS/SSH/SOCKS5/auth), the in-app updater, and the build
artifacts. Out of scope: vulnerabilities in MongoDB itself or in third-party
services you connect to.

## Security model (for context)

- **No telemetry** — nothing is tracked or transmitted.
- **No account** — there is no MQLens backend.
- **Credentials encrypted at rest** with AES-256-GCM and Argon2id key
  derivation, behind a master password (with optional biometric unlock).
- **Signed builds** — macOS notarized, Windows signed, and GPG-signed Linux
  artifacts; updater artifacts are signed and verified before install.
- **Apache-2.0** — the source is open for review.

## Known dependency advisories

Some GitHub Dependabot alerts reflect **transitive Linux-only dependencies** we
cannot patch in this repository alone:

- **`glib` (< 0.20)** — pulled in by Tauri’s GTK3 / WebKitGTK stack on Linux.
  The unsoundness in `VariantStrIter` is fixed in `glib` 0.20+, but gtk-rs 0.18
  (GTK3) is unmaintained and Tauri has not yet completed its GTK4 migration.
  We track upstream: [tauri#12048](https://github.com/tauri-apps/tauri/issues/12048),
  [wry#1474](https://github.com/tauri-apps/wry/issues/1474). Risk is limited to
  Linux builds; macOS and Windows are unaffected.
