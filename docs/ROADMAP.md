# MQLens Roadmap

> **Live board:** [MQLens Roadmap (GitHub Project)](https://github.com/orgs/mqlens/projects/2)  
> **Milestones:** [github.com/mqlens/mqlens-mongodb/milestones](https://github.com/mqlens/mqlens-mongodb/milestones)

Current stable release: **[v0.8.0](https://github.com/mqlens/mqlens-mongodb/releases/latest)**  
**v0.9.0 milestone complete** (shipped Jun 16, 2026) — release tag to follow.

Each upcoming milestone is planned as a **10-day** window. Dates below are targets, not hard deadlines.

## v0.10.0 — Import, export & migration

Window: **Jun 17 – Jun 26, 2026** · [Milestone](https://github.com/mqlens/mqlens-mongodb/milestone/2)

Complete data movement workflows for production use.

| Issue | Title |
|-------|-------|
| [#126](https://github.com/mqlens/mqlens-mongodb/issues/126) | GridFS: upload + delete |
| [#127](https://github.com/mqlens/mqlens-mongodb/issues/127) | BSON + NDJSON import/export |
| [#128](https://github.com/mqlens/mqlens-mongodb/issues/128) | Streaming background import |
| [#129](https://github.com/mqlens/mqlens-mongodb/issues/129) | Export filtered query results |
| [#122](https://github.com/mqlens/mqlens-mongodb/issues/122) | Copy DBs/collections across clusters |
| [#115](https://github.com/mqlens/mqlens-mongodb/issues/115) | Connection URI import/export + redaction |

## Docs & community

Window: **Jun 27 – Jul 6, 2026** · [Milestone](https://github.com/mqlens/mqlens-mongodb/milestone/6)

| Issue | Title |
|-------|-------|
| [#29](https://github.com/mqlens/mqlens-mongodb/issues/29) | Windows install notes |
| [#30](https://github.com/mqlens/mqlens-mongodb/issues/30) | Linux install notes |
| [#31](https://github.com/mqlens/mqlens-mongodb/issues/31) | Local demo database guide |
| [#28](https://github.com/mqlens/mqlens-mongodb/issues/28) | Workflow feedback (meta) |

## v0.11.0 — Shell & connections

Window: **Jul 7 – Jul 16, 2026** · [Milestone](https://github.com/mqlens/mqlens-mongodb/milestone/3)

Zero-friction mongosh and enterprise SSH workflows.

| Issue | Title |
|-------|-------|
| [#124](https://github.com/mqlens/mqlens-mongodb/issues/124) | Mongosh: auto-detect + guided install |
| [#125](https://github.com/mqlens/mqlens-mongodb/issues/125) | Mongosh: optional bundled binary |
| [#130](https://github.com/mqlens/mqlens-mongodb/issues/130) | SSH agent / certificate auth |

## v0.12.0 — DBA & operations

Window: **Jul 17 – Jul 26, 2026** · [Milestone](https://github.com/mqlens/mqlens-mongodb/milestone/4)

| Issue | Title |
|-------|-------|
| [#90](https://github.com/mqlens/mqlens-mongodb/issues/90) | Index usage stats + suggestions |
| [#93](https://github.com/mqlens/mqlens-mongodb/issues/93) | Validation rules editor ($jsonSchema) |
| [#114](https://github.com/mqlens/mqlens-mongodb/issues/114) | Cluster health monitor (replica set) |
| [#92](https://github.com/mqlens/mqlens-mongodb/issues/92) | Document diff |

## v1.0.0 — Platform & ecosystem

Window: **Jul 27 – Aug 5, 2026** · [Milestone](https://github.com/mqlens/mqlens-mongodb/milestone/5)

| Issue | Title |
|-------|-------|
| [#123](https://github.com/mqlens/mqlens-mongodb/issues/123) | Internationalization (i18n) |
| [#97](https://github.com/mqlens/mqlens-mongodb/issues/97) | Multi-panel / detachable tabs |
| [#98](https://github.com/mqlens/mqlens-mongodb/issues/98) | MCP server (expose MQLens as AI tools) |
| [#91](https://github.com/mqlens/mqlens-mongodb/issues/91) | Data generation (Faker) |

## Shipped — v0.9.0 (Jun 16, 2026)

Stability & polish: bug fixes, UX polish, and test coverage.

| Issue | Title |
|-------|-------|
| [#120](https://github.com/mqlens/mqlens-mongodb/issues/120) | Per-tab query editor state |
| [#131](https://github.com/mqlens/mqlens-mongodb/issues/131) | ⌘/Ctrl+F sidebar search shortcut |
| [#119](https://github.com/mqlens/mqlens-mongodb/issues/119) | UI zoom % in status bar |
| [#34](https://github.com/mqlens/mqlens-mongodb/issues/34) | Per-connection color tag picker |
| [#133](https://github.com/mqlens/mqlens-mongodb/issues/133) | Updater: graceful offline behavior |
| [#132](https://github.com/mqlens/mqlens-mongodb/issues/132) | Keyboard shortcuts reference page |
| [#134](https://github.com/mqlens/mqlens-mongodb/issues/134) | Tests: ExportView + TaskManager |

## Shipped earlier

- Command palette (#94)
- Sidebar folders, pins, favorites (#95)
- Curated theme system (#96)
- Font size setting (#113)
- MongoDB user management UI (#108)
- Cluster monitoring tab (#50)

## Suggest something new

Open a [feature request](https://github.com/mqlens/mqlens-mongodb/issues/new?template=feature_request.yml) or comment on [#28](https://github.com/mqlens/mqlens-mongodb/issues/28).
