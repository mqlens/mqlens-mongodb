# Reddit post — MQLens v0.13.0

Released 2026-07-21 (`mqlens-v0.13.0`). Post as a **text/self post** (not a bare link — self-promo filters), add a screenshot or GIF, and check each sub's self-promotion rules first.

---

## Primary — r/mongodb (also fits r/database)

**Title**

```
MQLens v0.13.0 — a free, native MongoDB GUI: multi-window workspace, an MCP server for AI agents, data generation, and read-only "prod safeguard" connections
```

**Body**

Hey r/mongodb — I've been building **MQLens**, a free and open-source (Apache-2.0) MongoDB desktop app, and just shipped v0.13.0. It's native (Tauri/Rust, not Electron), no telemetry, no account, and your connection credentials are encrypted locally. Here's what's new in this release:

**🪟 Detachable multi-window workspace** — split the workspace into panes and pop tabs out into their own OS windows, so you can spread a shell, a query, and cluster health across monitors. Your layout, tabs, and open connections come back after a restart (one click to reconnect).

**🤖 MCP server** — expose your connections to Claude Code, Cursor, or any MCP client as tools, so an AI agent can list databases, run finds/aggregations, explain plans, and analyze schema. It's **off by default**, opt-in per connection, and every write is gated behind explicit confirmation — the agent can't touch a connection you didn't tick.

**🎲 Data generation** — seed a collection with realistic fake documents from a template (names, emails, dates, nested objects, arrays, enums). "Generate more like this" infers the template from an existing collection's schema. Preview before you insert; large counts run as a background task.

**🛡️ Production safeguards** — mark a connection **read-only** or **confirm-destructive**. Enforced at the command layer (not just hidden buttons), for the UI *and* AI agents alike — read-only blocks every write; confirm-destructive makes you type the collection name before a drop/delete-many. "Safe to point at prod."

Also in there from recent releases: cluster health monitor, index usage stats + ESR suggestions, validation-rules editor, side-by-side document diff, import/export, GridFS, embedded mongosh.

Free, cross-platform (macOS/Windows/Linux), signed + notarized builds. Would genuinely love feedback — especially on the MCP tooling and the prod-safeguard flow, both new this release.

Repo + downloads: https://github.com/mqlens/mqlens-mongodb

---

## r/rust

**Title**

```
MQLens v0.13.0 — a MongoDB GUI built in Rust + Tauri (not Electron): multi-window, an MCP server, and command-layer write safeguards
```

**Body**

Shipped v0.13.0 of **MQLens**, a free/open-source (Apache-2.0) MongoDB desktop app built on **Tauri v2 + Rust** (React 19 frontend). It stays native and light — no Electron, no telemetry, no account, credentials encrypted locally with AES-256-GCM + Argon2id.

New this release:

- **Detachable multi-window workspace** — split panes + tabs you can pop into their own OS windows across monitors, with full session restore. The layout model is a pure Rust-mirrored reducer, kept in sync across windows via a backend event broadcast.
- **Embedded MCP server** (`rmcp` over loopback HTTP) — exposes your connections to Claude Code / Cursor as MCP tools; opt-in per connection, off by default, bearer-token auth, every write gated behind explicit confirmation.
- **Production-safeguard connection modes** — read-only / confirm-destructive, enforced by a single `guard_writable` choke point that every mutating command routes through (with a test that parses the real command list and asserts all ~110 are classified — so a new unguarded write fails CI). The AI agents inherit the same gate.
- **Data generation** — deterministic seeded fake-document generator (using `fake`) with schema inference.

Cross-platform, signed + notarized builds. Happy to talk about the Tauri architecture, the multi-window sync, or the command-guard design.

Repo: https://github.com/mqlens/mqlens-mongodb

---

## r/opensource / r/selfhosted

**Title**

```
MQLens v0.13.0 — free, Apache-2.0 MongoDB GUI, no telemetry, no account, local encrypted vault (now with multi-window, AI-agent tools, and read-only prod safeguards)
```

**Body**

**MQLens** is a free and open-source (Apache-2.0) MongoDB desktop client focused on owning your own tooling: **no telemetry, no account, nothing phoned home**, credentials encrypted locally, signed + notarized builds. Native Tauri/Rust app, not Electron.

Just shipped v0.13.0:

- **Multi-window workspace** — split panes and detachable windows across monitors, with session restore.
- **MCP server** — let Claude Code / Cursor / any MCP client drive your databases as tools; off by default, opt-in per connection, writes gated.
- **Data generation** — seed collections with realistic fake data, schema-aware.
- **Read-only / confirm-destructive connection modes** — command-layer enforced, so "safe to point at prod" actually means it.

Plus cluster health, index stats, validation rules, document diff, import/export, GridFS, embedded mongosh.

macOS / Windows / Linux. Feedback welcome.

Repo + downloads: https://github.com/mqlens/mqlens-mongodb

---

## r/programming / r/webdev (short)

**Title**

```
I built a free MongoDB GUI you can drive from Claude Code / Cursor — MQLens v0.13.0 ships an MCP server (plus multi-window + prod safeguards)
```

**Body**

v0.13.0 of **MQLens** (free, Apache-2.0, native Tauri app) adds an **MCP server**: point Claude Code or Cursor at it and an agent can list databases, run queries/aggregations, explain plans, and analyze schema — off by default, opt-in per connection, every write gated behind confirmation. Also new: detachable multi-window workspace across monitors, schema-aware data generation, and read-only / confirm-destructive connection modes enforced at the command layer (for the UI and the AI agent alike). No telemetry, no account, local encrypted vault.

https://github.com/mqlens/mqlens-mongodb

---

## Pre-post checklist

- [ ] Add a screenshot or short GIF (best demos: dragging a tab to a second monitor, the data-generation preview, or the read-only banner blocking a write). See `docs/promotion-screenshot-plan.md`.
- [ ] Post as a self/text post, repo link in the body — not a bare link post.
- [ ] Re-read each subreddit's self-promotion / "Show-off" rules; some require a flair or a dedicated thread.
- [ ] Reply to early comments quickly — engagement in the first hour drives reach.
