# LinkedIn post — MQLens v0.13.0 (company page)

Released 2026-07-21 (`mqlens-v0.13.0`). Post from the MQLens company page. LinkedIn favors a strong first line (it truncates after ~2 lines before "…see more"), short paragraphs, a few emojis, and 3–5 hashtags at the end. Attach a screenshot/GIF or a short demo video for reach.

---

## Version A — feature announcement (recommended)

🚀 **MQLens v0.13.0 is here.**

The free, open-source MongoDB GUI just got a lot more capable — and it's still native, private, and telemetry-free.

What's new:

🪟 **Multi-window workspace** — split panes and pop tabs into their own windows across monitors. Your layout and connections come back after a restart.

🤖 **MCP server** — point Claude Code, Cursor, or any MCP client at your databases and let an AI agent list, query, aggregate, explain, and analyze schema. Off by default, opt-in per connection, every write gated behind confirmation.

🎲 **Data generation** — seed collections with realistic fake documents. Point it at an existing collection and it infers the template from your schema.

🛡️ **Production safeguards** — mark a connection read-only or confirm-destructive. Enforced at the command layer, for the UI and AI agents alike. Safe to point at prod.

Free · Apache-2.0 · no telemetry · no account · native (Tauri/Rust, not Electron) · macOS / Windows / Linux.

⬇️ Download & repo: https://github.com/mqlens/mqlens-mongodb

We'd love your feedback — especially on the MCP tooling and the prod-safeguard flow.

\#MongoDB #DeveloperTools #OpenSource #Rust #AI #MCP #Database

---

## Version B — the AI-agent angle (punchier, for wider reach)

🤖 **You can now drive MongoDB from your AI coding agent.**

MQLens v0.13.0 ships an **MCP server**: connect Claude Code or Cursor and an agent can list databases, run queries and aggregations, read explain plans, and analyze schema — as first-class tools.

The part we care most about: it's **safe by design.** Off by default. Opt-in per connection. Every write gated behind explicit confirmation. And you can mark any connection read-only or confirm-destructive — enforced at the command layer, so the agent can't touch what you didn't allow.

Also in v0.13.0: a detachable multi-window workspace across monitors, and schema-aware data generation for seeding test data.

Free, open-source (Apache-2.0), native, no telemetry, no account.

⬇️ https://github.com/mqlens/mqlens-mongodb

\#AI #MCP #MongoDB #DeveloperTools #OpenSource #ClaudeCode #Cursor

---

## Version C — short / mission-led

Working with production data shouldn't feel risky.

**MQLens v0.13.0** adds read-only and confirm-destructive connection modes — mark a connection as protected and writes are blocked (or require typing the collection name), enforced at the command layer for both the UI and AI agents.

It also brings a detachable multi-window workspace, an MCP server so AI agents can query your databases safely, and schema-aware data generation.

Free, open-source, private by default. That's the whole point.

⬇️ https://github.com/mqlens/mqlens-mongodb

\#MongoDB #OpenSource #DeveloperTools #DataSafety

---

## Notes

- **First line matters most** — LinkedIn truncates the preview; Version A/B lead with a hook that stands on its own.
- **Visual**: attach a screenshot, GIF, or a 20–40s demo video (native video gets more reach than an image, and far more than a bare link). Best demos: tab dragged to a second monitor, the read-only banner blocking a write, or an agent running a query via MCP. See `docs/promotion-screenshot-plan.md`.
- **Hashtags**: 3–5 is the sweet spot; more looks spammy. Keep #MongoDB + #OpenSource, swap the rest to match the version's angle.
- **Timing**: Tue–Thu mornings (audience timezone) tend to perform best for B2B/dev content.
- Reply to early comments — LinkedIn's algorithm rewards first-hour engagement.
