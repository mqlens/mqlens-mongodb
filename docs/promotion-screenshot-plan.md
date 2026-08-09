# Promotion Screenshot Plan

## Goal

Create real MQLens product screenshots against a seeded local MongoDB database and use them on the website and docs.

## Demo Data

- Database: `mqlens_demo`
- Collections:
  - `orders`: order documents with status, customer, region, totals, items, payment, shipping, and timestamps.
  - `customers`: customer profiles with plan, region, spend, and support metadata.
  - `products`: product catalog rows for lookup and browsing examples.
  - `events`: application event documents for query/filter examples.
- Indexes:
  - `orders.status + orders.createdAt`
  - `orders.region + orders.total`
  - `customers.email`
  - `events.type + events.createdAt`

## Screenshot Set

1. Quick Start: clean first-run workspace.
2. Connection setup: URI/profile flow for local MongoDB.
3. Documents browser: connected database tree plus real customer documents.
4. Visual query builder and AI assistant panels.
5. Index detail and GridFS file browsing screens.

## Website Updates

- Add a real screenshot strip/gallery to the homepage near the hero/features.
- Add screenshots to docs under the first-connection workflow.
- Add a collection-workspace screenshot to the aggregation guide to show where the Aggregation tab lives.

## Verification

- Seed script runs idempotently against local MongoDB.
- MQLens launches against the seeded database.
- Real app screenshots are committed under `website/public/screenshots/`.
- `npm run build` in `website/` completes.
