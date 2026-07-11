# Local demo database

A seeded MongoDB database for developing MQLens, reproducing the README
screenshots, and exercising every major workflow — browsing, querying,
aggregations, indexes and explain plans, views, import/export, dump/restore,
and GridFS — without touching real data.

Everything here runs locally against a throwaway server. **Never use real
secrets or production data for screenshots or test runs** — the seed data is
entirely synthetic, and connection strings in captures should point at
`localhost` only.

## 1. Start MongoDB locally

Any local MongoDB ≥ 6.0 works. The quickest option is Docker:

```bash
docker run -d --rm --name mqlens-demo -p 27017:27017 mongo:7
```

(Or use an existing local `mongod`; nothing in the seed requires a replica set
or auth.)

## 2. Seed the demo data

From the repository root:

```bash
mongosh mongodb://localhost:27017 -f scripts/seed-demo-data.js
```

The script drops and recreates a single database, **`mqlens_demo`**, and prints
a document-count summary when it finishes:

| Collection | Docs | What it's for |
|---|---|---|
| `products` | 5 | Small flat collection — quick browsing, editing, schema view |
| `customers` | 36 | Unique index (`email_1`), tags array, lifecycle facets |
| `orders` | 180 | Nested `items` array + `shipping` subdocument, three secondary indexes — the main collection for queries, aggregations, and explain plans |
| `events` | 260 | Time-series-ish audit log with a compound index |
| `active_customer_revenue` | view | Aggregation view over `orders` (revenue by region) |
| `fs.files` / `fs.chunks` | 2 files | Real GridFS files with consistent chunks — list, download, and delete all work |

Re-running the script is safe: it drops `mqlens_demo` first and reseeds from
scratch, so it doubles as a reset button after destructive experiments.

## 3. Connect from MQLens

Add a connection with the URI `mongodb://localhost:27017` (name it something
like `Local demo`), connect, and open `mqlens_demo`.

## 4. Suggested test flows

- **Query bar** — on `orders`: `{ status: "shipped", region: "Europe" }`, or a
  range like `{ total: { $gt: 300 } }`.
- **Explain plans** — the query above uses `status_1_createdAt_-1` /
  `region_1_total_-1`; drop the filter to compare against a COLLSCAN. Sorting
  by `createdAt` shows index-backed sorts.
- **Aggregation** — group revenue by region on `orders`, then compare with the
  prebuilt `active_customer_revenue` view.
- **Indexes** — `customers.email_1` is unique: inserting a duplicate email
  demonstrates constraint errors safely.
- **Import/export** — export `orders` as NDJSON/BSON/CSV, reimport into a new
  collection; the `events` collection is good for filtered exports.
- **Dump & restore** — a database-scope dump of `mqlens_demo` is small and
  fast; restoring with renames exercises the namespace mapping.
- **GridFS** — the two seeded files have real chunk data, so download and
  delete flows work end to end; upload something to round-trip.

## 5. Cleaning up

```bash
docker stop mqlens-demo    # container was started with --rm
```

Or, to remove just the data while keeping the server:
`mongosh mongodb://localhost:27017 --eval 'db.getSiblingDB("mqlens_demo").dropDatabase()'`.
