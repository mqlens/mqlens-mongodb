# MCP tool reference

MQLens can run a local [Model Context Protocol](https://modelcontextprotocol.io) server so
agents like Claude Code and Cursor can query (and, with explicit confirmation, write to) your
MongoDB connections. It's **off by default**, and only connections you explicitly opt in are
ever visible to an agent.

This page is a reference for the 16 tools the server exposes. It's generated from
[`fixtures/mcp-tools-golden.json`](../fixtures/mcp-tools-golden.json), the same golden fixture
`cargo test`'s `mcp::tests::tools_list_matches_golden_fixture` checks the live `tools/list`
response against — so the table below is always exactly what a connected agent sees. A test
(`mcp::tests::mcp_tools_doc_lists_every_tool_from_the_golden_fixture`) fails CI if this file
drifts out of sync with the fixture.

## Enabling the server

1. Open **Settings → MCP** (vault must be unlocked).
2. Flip **Enabled**. MQLens starts a local HTTP server (default port `8765`, configurable before
   enabling) and mints a bearer token.
3. In the same panel, copy the ready-made snippet for your client:

   **Claude Code** — run in a terminal:
   ```
   claude mcp add --transport http mqlens http://127.0.0.1:8765/mcp --header "Authorization: Bearer <token>"
   ```

   **Cursor** — add to its MCP server configuration:
   ```json
   {
     "mcpServers": {
       "mqlens": {
         "url": "http://127.0.0.1:8765/mcp",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```

   Replace `<token>` with the actual bearer token shown (and copyable) in the panel. Other
   MCP-compatible clients (streamable HTTP transport, bearer auth) work the same way.
4. Per connection, open **Connection Manager** and check **"Expose to MCP agents"** for each
   profile you want an agent to be able to see. Nothing is exposed by opt-in default — a
   connection stays invisible to MCP until you flip that flag on it, even while the server itself
   is enabled.

Once connected, any connection an agent opens through `connect` shows a **"via MCP"** badge next
to it in the sidebar, in every open window, so it's always visible when an agent (not you) is
driving a connection.

Locking the vault or toggling the server off immediately stops it — in-flight requests are
allowed to finish (a short drain window) but new ones are refused, and connected clients see a
clean connection error rather than a hang. Regenerating the bearer token invalidates the old one
immediately; existing client configs using it must be updated.

## The `_confirm` rule

Every tool that mutates data (`insert_one`, `update_many`, `delete_many`, `create_index`) requires
an explicit `_confirm: true` argument. Calling one of these tools without it is always rejected
with an error telling the agent to restate exactly what will change (namespace, filter/keys,
and — for inserts/updates — a summary of the document) and get the user's go-ahead first, then
call again with `_confirm: true`. There is no way to skip this by omission or default; every
destructive call fails closed until confirmed.

Aggregation is read-only end to end: any pipeline stage whose sole key is `$out` or `$merge` is
rejected outright, `_confirm` or not, since those can write data outside the tool's own
namespace/filter contract.

## Result caps

Read tools cap what comes back so a single call can't flood the agent's context:

- `find` / `aggregate`: capped at 50 documents or 1MB of output, whichever comes first; `find`'s
  own `limit` argument additionally caps at 200 documents requested from MongoDB. A non-null
  `truncated` field in the response means the cap was hit — narrow the filter or lower `limit` to
  see more.
- `schema_analysis`: sampled at 100 documents by default, hard-capped at 1000 via `sample_size`.

## Tools

<!-- BEGIN GENERATED TOOL TABLE -->
### `aggregate`

Run a MongoDB aggregation pipeline. Returns {"documents": [...relaxed EJSON...], "truncated"?}. Real connections only (not the demo/mock data). Stages whose sole key is $out or $merge are rejected — MCP is read-only for aggregation.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes |  |
| `database` | string | yes |  |
| `collection` | string | yes |  |
| `pipeline` | array | yes | Aggregation pipeline as an array of stage objects, e.g. `[{"$match": {"status": "active"}}, {"$limit": 10}]`. Stages whose sole key is `$out` or `$merge` are rejected. |

### `connect`

Open a live connection to an MCP-opted-in profile (by id, from `list_profiles`). Returns {"connectionId": "..."} for use with every other data tool. Every window's sidebar shows this connection with a "via MCP" badge.

| Arg | Type | Required | Description |
|---|---|---|---|
| `profile_id` | string | yes | Id of an MCP-opted-in profile, as returned by `list_profiles`. |

### `create_index`

Create an index. `name` defaults to MongoDB's own naming convention (each key's field_direction joined by `_`, e.g. `email_1`) when omitted. DESTRUCTIVE — requires `_confirm: true`. Before calling with `_confirm: true`, restate to the user exactly what will be created (the namespace and the key spec) and get their go-ahead. Without `_confirm: true` the call is rejected with an error telling you to do that; call again with `_confirm: true` once you have.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes |  |
| `database` | string | yes |  |
| `collection` | string | yes |  |
| `keys` | any | yes | Index key spec as a JSON object, e.g. `{"email": 1}` or `{"a": 1, "b": -1}`. |
| `name` | string | no | Index name. Defaults to MongoDB's own naming convention (each key's `field_direction` joined by `_`, e.g. `email_1`) when omitted. |
| `unique` | boolean | no |  |
| `sparse` | boolean | no |  |
| `_confirm` | boolean | yes | Must be `true`; see `insert_one`'s `_confirm` doc. |

### `delete_many`

Delete every document matching `filter`. DESTRUCTIVE — requires `_confirm: true`. Before calling with `_confirm: true`, restate to the user exactly what will be deleted (the namespace and the filter) and get their go-ahead. Without `_confirm: true` the call is rejected with an error telling you to do that; call again with `_confirm: true` once you have.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes |  |
| `database` | string | yes |  |
| `collection` | string | yes |  |
| `filter` | any | yes | MQL filter selecting documents to delete, as a JSON object. |
| `_confirm` | boolean | yes | Must be `true`; see `insert_one`'s `_confirm` doc. |

### `disconnect`

Close a connection previously opened by this MCP session's `connect` call. Cannot disconnect a connection a human opened via the app UI, even if its profile is opted in.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes | Id returned by `connect` or `list_connections`. |

### `explain`

Explain a find filter or an aggregation pipeline (executionStats verbosity). Pass `pipeline` for an aggregate-style explain (real connections only) or `findFilter` for a find-style explain.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes |  |
| `database` | string | yes |  |
| `collection` | string | yes |  |
| `find_filter` | string | no | MQL filter as a JSON object string (find-style explain). Ignored if `pipeline` is set. |
| `pipeline` | array | no | Aggregation pipeline as an array of stage objects (aggregate-style explain). |

### `find`

Run a MongoDB find query. Returns {"documents": [...relaxed EJSON...], "count"?, "truncated"?}. Results are capped (default 50 docs / 1MB; `limit` also caps at 200) — a non-null `truncated` means narrow the filter or lower `limit`.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes | Id returned by `connect` or `list_connections`. |
| `database` | string | yes |  |
| `collection` | string | yes |  |
| `filter` | string | no | MQL filter as a JSON object string, e.g. `{"status":"active"}`. Omit for "match all". |
| `sort` | string | no | MQL sort as a JSON object string, e.g. `{"createdAt":-1}`. |
| `projection` | string | no | MQL projection as a JSON object string, e.g. `{"name":1,"_id":0}`. |
| `limit` | integer | no | Max documents to fetch from MongoDB. Default 50, hard cap 200. The response may be truncated further by the output size cap. |
| `skip` | integer | no | Documents to skip before returning results. Default 0. |
| `include_count` | boolean | no | Also return a total matching-document count (costs an extra query). |

### `insert_one`

Insert one document. DESTRUCTIVE — requires `_confirm: true`. Before calling with `_confirm: true`, restate to the user exactly what will be inserted (the namespace and a summary of the document) and get their go-ahead. Without `_confirm: true` the call is rejected with an error telling you to do that; call again with `_confirm: true` once you have.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes | Id returned by `connect` or `list_connections`. |
| `database` | string | yes |  |
| `collection` | string | yes |  |
| `document` | any | yes | The document to insert, as a JSON object. |
| `_confirm` | boolean | yes | Must be `true`. Before setting this, restate to the user exactly what will be inserted (the namespace and a summary of the document) and get their go-ahead — the call is rejected until then. |

### `list_collections`

List collections (and their type: collection/view/timeseries) in a database.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes |  |
| `database` | string | yes |  |

### `list_connections`

List currently live MongoDB connections whose profile is opted in to MCP access. Use a returned id with `find`/`aggregate`/etc, or `connect` a not-yet-connected opted-in profile first.

_No arguments._

### `list_databases`

List database names visible on a connection.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes | Id returned by `connect` or `list_connections`. |

### `list_indexes`

List a collection's indexes merged with usage stats (size, ops since last restart) where available. Mock/demo connections report indexes with no stats.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes |  |
| `database` | string | yes |  |
| `collection` | string | yes |  |

### `list_profiles`

List MongoDB connection profiles opted in to MCP access (Settings → Connection Manager → "Expose to MCP agents"). Returns id/name/colorTag only — never a connection string. Call this before `connect`.

_No arguments._

### `ping`

Health check for the MQLens MCP server. Returns "pong <version>" — call this first to confirm the server is reachable and the bearer token is valid.

_No arguments._

### `schema_analysis`

Infer a collection's schema by sampling documents: per-field types, presence/coverage, and low-cardinality enum values. `sampleSize` defaults to 100, hard cap 1000.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes |  |
| `database` | string | yes |  |
| `collection` | string | yes |  |
| `sample_size` | integer | no | Documents to sample. Default 100, hard cap 1000. |

### `update_many`

Update every document matching `filter` using operators (e.g. {"$set": {...}}) — bare replacement documents are rejected. DESTRUCTIVE — requires `_confirm: true`. Before calling with `_confirm: true`, restate to the user exactly what will be modified (the namespace, the filter, and the update) and get their go-ahead. Without `_confirm: true` the call is rejected with an error telling you to do that; call again with `_confirm: true` once you have.

| Arg | Type | Required | Description |
|---|---|---|---|
| `connection_id` | string | yes |  |
| `database` | string | yes |  |
| `collection` | string | yes |  |
| `filter` | any | yes | MQL filter selecting documents to update, as a JSON object. |
| `update` | any | yes | Update document using operators (e.g. `{"$set": {"field": "value"}}`). Bare replacement documents are rejected. |
| `_confirm` | boolean | yes | Must be `true`; see `insert_one`'s `_confirm` doc. |
<!-- END GENERATED TOOL TABLE -->
