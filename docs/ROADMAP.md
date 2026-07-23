# MQLens Roadmap

> **Live board:** [MQLens Roadmap (GitHub Project)](https://github.com/orgs/mqlens/projects/2)  
> **Milestones:** [github.com/mqlens/mqlens-mongodb/milestones](https://github.com/mqlens/mqlens-mongodb/milestones)

Current stable release: **[v0.14.0](https://github.com/mqlens/mqlens-mongodb/releases/latest)** (shipped Jul 24, 2026)

Each upcoming milestone is planned as a **10-day** window. Dates below are targets, not hard deadlines.

## v0.15.0 — i18n, live data & query power

Window: **Jul 27 – Aug 5, 2026** · [Milestone](https://github.com/mqlens/mqlens-mongodb/milestone/8)

Internationalization (touches every string — gets its own milestone), plus the query-surface differentiators.

| Issue | Title |
|-------|-------|
| [#123](https://github.com/mqlens/mqlens-mongodb/issues/123) | Internationalization (i18n): multi-language UI support |
| [#190](https://github.com/mqlens/mqlens-mongodb/issues/190) | Change streams: live collection tail viewer |
| [#191](https://github.com/mqlens/mqlens-mongodb/issues/191) | Aggregation builder UX: reorder, per-stage disable, run-to-here, undo/redo |
| [#192](https://github.com/mqlens/mqlens-mongodb/issues/192) | Atlas Search & Vector Search: index management + stage autocomplete |

## v0.16.0 — parity & power features

Window: **Aug 6 – Aug 15, 2026** · [Milestone](https://github.com/mqlens/mqlens-mongodb/milestone/10)

An optional pre-1.0 release closing the competitive parity gaps found in a feature audit. None are launch blockers — if we choose to launch sooner, these move to v1.1.

| Issue | Title |
|-------|-------|
| [#210](https://github.com/mqlens/mqlens-mongodb/issues/210) | Geospatial map view: visualize GeoJSON / 2dsphere data on a map |
| [#211](https://github.com/mqlens/mqlens-mongodb/issues/211) | Roles & privileges management (custom roles, grant/revoke) |
| [#212](https://github.com/mqlens/mqlens-mongodb/issues/212) | Data compare & sync between collections/clusters |
| [#213](https://github.com/mqlens/mqlens-mongodb/issues/213) | Multi-document transaction runner (commit/rollback) |
| [#214](https://github.com/mqlens/mqlens-mongodb/issues/214) | Collation as a first-class query & index option |

## v1.0.0 — Hardening & launch

Window: **Aug 16 – Aug 25, 2026** · [Milestone](https://github.com/mqlens/mqlens-mongodb/milestone/5)

A thin, confidence-stamped release: no big feature merges. Bug triage, performance/accessibility passes, RC soak on the dev channel, and the launch itself.

| Issue | Title |
|-------|-------|
| [#194](https://github.com/mqlens/mqlens-mongodb/issues/194) | 1.0 hardening: bug triage, perf & a11y pass, RC soak |
| [#195](https://github.com/mqlens/mqlens-mongodb/issues/195) | 1.0 launch: promotion screenshots, website refresh, announcement |
| [#193](https://github.com/mqlens/mqlens-mongodb/issues/193) | Website: free SEO tool pages |

## Shipped — v0.14.0 (Jul 24, 2026)

Multiple tabs per collection: [release notes](https://github.com/mqlens/mqlens-mongodb/releases/tag/mqlens-v0.14.0)

| Issue | Title |
|-------|-------|
| [#206](https://github.com/mqlens/mqlens-mongodb/issues/206) | Multiple tabs per collection — Open in New Tab, double-click, Duplicate Tab; refresh-all duplicates; horizontal tab-strip scroll |

## Shipped — v0.13.0 (Jul 21, 2026)

Workspace & extensibility, plus production-safety wins: [release notes](https://github.com/mqlens/mqlens-mongodb/releases/tag/mqlens-v0.13.0)

| Issue | Title |
|-------|-------|
| [#97](https://github.com/mqlens/mqlens-mongodb/issues/97) | Multi-panel workspace / detachable tabs |
| [#98](https://github.com/mqlens/mqlens-mongodb/issues/98) | MCP server (expose MQLens as AI tools) |
| [#91](https://github.com/mqlens/mqlens-mongodb/issues/91) | Data generation (Faker) |
| [#188](https://github.com/mqlens/mqlens-mongodb/issues/188) | Read-only / production-safeguard connection mode |

## Shipped — v0.12.0 (Jul 16, 2026)

DBA & operations: [release notes](https://github.com/mqlens/mqlens-mongodb/releases/tag/mqlens-v0.12.0)

| Issue | Title |
|-------|-------|
| [#90](https://github.com/mqlens/mqlens-mongodb/issues/90) | Index usage stats + ESR suggestions |
| [#93](https://github.com/mqlens/mqlens-mongodb/issues/93) | Validation rules editor ($jsonSchema) |
| [#114](https://github.com/mqlens/mqlens-mongodb/issues/114) | Cluster health monitor (replica set) |
| [#92](https://github.com/mqlens/mqlens-mongodb/issues/92) | Document diff |

## Shipped — v0.11.0 (Jul 13, 2026)

Shell & connections: mongosh auto-detect + guided install (#124), optional bundled binary (#125), SSH agent / certificate auth (#130).

## Shipped — v0.10.0 (Jun 26, 2026)

Import, export & migration: GridFS upload/delete (#126), BSON + NDJSON import/export (#127), streaming background import (#128), filtered export (#129), cross-cluster copy (#122), URI import/export + redaction (#115).

## Shipped — v0.9.0 (Jun 16, 2026)

Stability & polish: per-tab query editor state (#120), sidebar search shortcut (#131), UI zoom (#119), connection color tags (#34), offline-graceful updater (#133), shortcuts reference (#132), ExportView + TaskManager tests (#134).

## Shipped earlier

- Command palette (#94)
- Sidebar folders, pins, favorites (#95)
- Curated theme system (#96)
- Font size setting (#113)
- MongoDB user management UI (#108)
- Cluster monitoring tab (#50)

## Suggest something new

Open a [feature request](https://github.com/mqlens/mqlens-mongodb/issues/new?template=feature_request.yml) or comment on [#28](https://github.com/mqlens/mqlens-mongodb/issues/28).
