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
- **Activity / audit log (local only)** — optional operation history is stored
  in `audit.log.enc` as an append-only log whose records are each encrypted
  individually with the vault key; the decrypted log never touches the
  filesystem. It may include collection names, filters, and (if enabled in
  Settings) document fragments. Protect the vault password. **Export** is an
  explicit user action that writes **plaintext** outside the vault envelope —
  treat exported files as sensitive.
- **Audit log integrity** — every record carries its sequence number and the
  hash of the record before it, and a companion file records how many events the
  log should hold, so deleting, reordering, editing or truncating entries is
  detected when the log is opened; MQLens then stops recording and preserves the
  file instead of writing over it. A crash mid-write is distinguished from
  tampering: only when the recorded count confirms the trailing bytes were an
  interrupted write is that partial record discarded and logging continued.
- **The activity log cannot be erased from the app** — there is no "clear"
  action for an intact log; the retention setting is the only thing that removes
  events, on the schedule you choose. A log that has *failed* verification can be
  discarded so recording can resume, and that always leaves a permanent record
  of the discard which retention will not remove. So a discarded log can never be
  made to look like one that was never discarded.
  Note the limit: the log is encrypted with your own master password on your own
  machine, so it is tamper-**evident**, not tamper-**proof** — anyone holding
  that password can delete it and start fresh.
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
