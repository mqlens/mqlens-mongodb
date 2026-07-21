//! MCP read-tool handlers (#98 Task 4).
//!
//! `mcp.rs` stays protocol/lifecycle-only: every `#[tool]` method on
//! `McpServer` is a thin wrapper that resolves an `AppState`/profiles path
//! and immediately delegates to a plain function in this module. Every
//! function here takes `(state: &AppState, ...)` and, for anything that
//! needs profile data, a plain `&std::path::Path` for the encrypted
//! profiles file — the same `workspace::get_impl`/`workspace::apply_impl`
//! idiom used throughout this codebase (see `workspace.rs`'s "Store
//! commands" doc comment): `_impl` functions are testable with a temp-dir
//! path and no live `AppHandle`, and the real path is resolved once, by the
//! `#[tool]` method, via `connections::get_profiles_enc_path(app_handle)`
//! (itself obtained from `McpServer.app_handle`, and the live `AppState`
//! from `app_handle.state::<AppState>()` — see `windows.rs`'s
//! `apply_window_closed_and_broadcast` for the same "resolve `AppState` from
//! an `AppHandle` outside of a `#[tauri::command]`" pattern).
//!
//! **EJSON format note:** every document-shaped seam this module calls
//! (`execute_mql_query_impl`, `execute_aggregate_impl`, `analyze_schema_impl`,
//! `explain_mql_query_impl`, `explain_aggregate_query_impl`) already
//! produces *relaxed* MongoDB Extended JSON — the `mongodb::bson::Document`
//! -> `serde_json::Value` conversion in `db/query.rs`/`db/aggregate.rs`
//! (`serde_json::to_value(&doc)`) goes through `bson` 2.x's `Serialize`
//! impl, which emits `$oid`/`$date`/`$numberLong`/etc. wrappers rather than
//! bson-crate-internal representations. This module never re-encodes that —
//! `find`/`aggregate` re-parse each already-relaxed-EJSON document string
//! back into a `serde_json::Value` purely to embed it (unescaped) inside a
//! JSON envelope (`{"documents": [...], ...}`), not to change its encoding.
//! `explain`/`schema_analysis` pass the underlying impl's JSON string
//! straight through as the tool's text content.

use crate::state::{ConnectionEntry, LockExt};
use crate::write_guard::{guard_writable, WriteOp};
use crate::{AppState, CollectionInfo};
// `rmcp::schemars` re-exports the `schemars` crate (server feature); the
// `JsonSchema` derive macro's generated code refers to the crate by its bare
// name (`schemars::...`), so it must be nameable at this module's root, not
// just its `JsonSchema` trait imported — `rmcp` deliberately doesn't
// re-export it as `schemars` from its own crate root for this to "just
// work" without this explicit `use`.
use rmcp::schemars;
use rmcp::schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

/// `connection not found` — the single uniform error for every "this
/// connection/profile isn't visible to MCP" case (unknown id, live
/// connection whose profile isn't opted in, disconnect of a
/// non-session-owned id). Never differs by reason: an agent must not be
/// able to distinguish "no such connection" from "that connection exists
/// but its profile opted out" (spec: "Non-opted profiles: uniform 'not
/// found' — no existence leak").
const CONNECTION_NOT_FOUND: &str = "connection not found";

/// `profile not found` — `connect`'s uniform error for an unknown or
/// non-opted-in profile id, same rationale as `CONNECTION_NOT_FOUND`.
const PROFILE_NOT_FOUND: &str = "profile not found";

/// `find`/`aggregate` output caps (Global Constraints: "result caps default
/// 50 docs / 1 MB with explicit truncation markers") — the safety net on
/// what's actually returned to the agent, independent of `find`'s own MQL
/// `limit` (below), in case individual documents are large.
pub const CAP_MAX_DOCS: usize = 50;
pub const CAP_MAX_BYTES: usize = 1_000_000;

/// `find`'s MQL `limit` bounds (plan: "limit 50 (cap 200)") — how many
/// documents are *requested* from MongoDB, distinct from `CAP_MAX_DOCS`
/// above (what's returned after capping).
const DEFAULT_FIND_LIMIT: i64 = 50;
const MAX_FIND_LIMIT: i64 = 200;

/// `schema_analysis`'s sample-size default (plan: "sample_size default 100
/// cap 1000") — `analyze_schema_impl` already enforces the cap via
/// `limits::normalize_schema_sample`; this is just the MCP-layer default
/// when the arg is omitted.
const DEFAULT_SCHEMA_SAMPLE: i64 = 100;

// ---------------------------------------------------------------------------
// Cross-cutting: result capping
// ---------------------------------------------------------------------------

/// Cap `docs` to at most `max_docs` entries and `max_bytes` total (summed
/// UTF-8 byte length) — the spec's "result caps ... with explicit
/// truncation markers". The first document is always kept even if it alone
/// exceeds `max_bytes`, so a byte-tight cap never turns a non-empty result
/// into an empty one. Returns the capped documents plus `Some` truncation
/// note iff anything was actually dropped.
pub fn cap_results(docs: Vec<String>, max_docs: usize, max_bytes: usize) -> (Vec<String>, Option<String>) {
    let total = docs.len();
    let mut out = Vec::new();
    let mut bytes = 0usize;
    for doc in docs {
        if out.len() >= max_docs {
            break;
        }
        let len = doc.len();
        if !out.is_empty() && bytes + len > max_bytes {
            break;
        }
        bytes += len;
        out.push(doc);
    }
    let truncated = if out.len() < total {
        Some(format!(
            "truncated to {} of {} document{} ({} bytes) — narrow the filter or lower `limit`/`sampleSize` to see more",
            out.len(),
            total,
            if total == 1 { "" } else { "s" },
            bytes
        ))
    } else {
        None
    };
    (out, truncated)
}

/// Re-parse each already-relaxed-EJSON document string back into a
/// `serde_json::Value` so it can be embedded (unescaped) in a JSON envelope
/// — see the module doc comment's EJSON note. Failure here would mean an
/// `_impl` seam produced non-JSON output, which never happens in practice
/// (every seam builds its strings via `serde_json::to_string`), but the
/// `Result` keeps this an explicit error instead of a panic.
fn parse_ejson_docs(docs: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    docs.into_iter()
        .map(|d| serde_json::from_str(&d).map_err(|e| format!("internal error: query result was not valid JSON: {e}")))
        .collect()
}

/// `cap_results` + `parse_ejson_docs` composed — the shared tail of `find`/
/// `aggregate`. Split out (rather than inlined) so the capping-then-parsing
/// wiring is unit-testable with tiny caps, independent of how much data a
/// mock/real connection happens to have available (the bundled mock demo
/// data has far fewer rows than `CAP_MAX_DOCS`, so exercising real
/// truncation end-to-end through `find_impl` isn't possible without a real
/// cluster — see this module's tests for the direct coverage instead).
fn cap_and_parse(docs: Vec<String>, max_docs: usize, max_bytes: usize) -> Result<(Vec<serde_json::Value>, Option<String>), String> {
    let (capped, truncated) = cap_results(docs, max_docs, max_bytes);
    Ok((parse_ejson_docs(capped)?, truncated))
}

// ---------------------------------------------------------------------------
// Profiles / connections
// ---------------------------------------------------------------------------

/// `list_profiles` result element — id/name/color only. Deliberately has no
/// `uri`/`ssh` field at all (not just omitted at the call site): a
/// connection string can never leave via this struct even if a future edit
/// forgets to filter it out, matching `ConnectionMeta`/`ConnectionEntry`'s
/// own "no uri field to leak" guarantee (see `state.rs`).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_tag: Option<String>,
}

/// `list_profiles` — every MCP-opted-in profile, id/name/color only.
pub fn list_profiles_impl(state: &AppState, profiles_path: &Path) -> Result<Vec<ProfileSummary>, String> {
    let key = state.require_key()?;
    let profiles = crate::connections::load_profiles_encrypted(profiles_path, &key)?;
    Ok(profiles
        .into_iter()
        .filter(|p| p.mcp_enabled)
        .map(|p| ProfileSummary { id: p.id, name: p.name, color_tag: p.color_tag })
        .collect())
}

/// `list_connections` — live connections whose profile is *currently*
/// opted in. Live-checked against the profiles file on every call (not
/// cached at connect time): un-opting a profile hides its connections here
/// immediately, even though the underlying `connect_db` session is
/// untouched — same live-check `require_mcp_connection` uses for the data
/// tools.
pub fn list_connections_impl(state: &AppState, profiles_path: &Path) -> Result<Vec<ConnectionEntry>, String> {
    let key = state.require_key()?;
    let profiles = crate::connections::load_profiles_encrypted(profiles_path, &key)?;
    let opted_in: HashSet<String> = profiles.into_iter().filter(|p| p.mcp_enabled).map(|p| p.id).collect();
    let all = crate::connection_list_impl(state)?;
    Ok(all.into_iter().filter(|c| opted_in.contains(&c.profile_id)).collect())
}

/// `connect` tool args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct ConnectArgs {
    /// Id of an MCP-opted-in profile, as returned by `list_profiles`.
    pub profile_id: String,
}

/// `connect` — opens a real `connect_db` session for an opted-in profile
/// and records it as this MCP session's, so `disconnect` can later close
/// exactly this connection (and no other). The caller (`McpServer::connect`
/// in `mcp.rs`) is responsible for the `connections-changed` broadcast
/// after this returns `Ok` — that needs an `AppHandle`, which this
/// `AppHandle`-free function deliberately doesn't take (same split as
/// `connect_db_impl`/`disconnect_db_impl` themselves).
pub async fn connect_impl(state: &AppState, profiles_path: &Path, profile_id: &str) -> Result<String, String> {
    let key = state.require_key()?;
    let profiles = crate::connections::load_profiles_encrypted(profiles_path, &key)?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id && p.mcp_enabled)
        .ok_or_else(|| PROFILE_NOT_FOUND.to_string())?;

    let connection_id = crate::connect_db_impl(state, &profile.uri, profile.ssh.as_ref()).await?;
    crate::set_connection_meta_impl(state, &connection_id, &profile.id, &profile.name, true, profile.connection_mode)?;
    state.mcp.lock_safe()?.session_connections.insert(connection_id.clone());
    Ok(connection_id)
}

/// `disconnect` — only ever accepts an id this MCP session's own `connect`
/// opened (`McpControl.session_connections`), never a connection a human
/// opened by hand, even one belonging to an opted-in profile. The caller is
/// responsible for the `connections-changed` broadcast, same split as
/// `connect_impl`.
pub async fn disconnect_impl(state: &AppState, connection_id: &str) -> Result<(), String> {
    let is_session_owned = state.mcp.lock_safe()?.session_connections.contains(connection_id);
    if !is_session_owned {
        return Err(CONNECTION_NOT_FOUND.to_string());
    }
    crate::disconnect_db_impl(state, connection_id).await?;
    state.mcp.lock_safe()?.session_connections.remove(connection_id);
    Ok(())
}

/// Shared existence + opt-in guard for every data tool (`list_databases`
/// through `list_indexes`): `connection_id` must both be live (present in
/// `AppState.connection_meta`) and trace back to a currently-opted-in
/// profile. Both failure modes collapse to `CONNECTION_NOT_FOUND` — see its
/// doc comment.
pub fn require_mcp_connection(state: &AppState, profiles_path: &Path, connection_id: &str) -> Result<(), String> {
    let key = state.require_key()?;
    let profile_id = {
        let meta = state.connection_meta.lock_safe()?;
        meta.get(connection_id).map(|m| m.profile_id.clone())
    };
    let profile_id = profile_id.ok_or_else(|| CONNECTION_NOT_FOUND.to_string())?;
    let profiles = crate::connections::load_profiles_encrypted(profiles_path, &key)?;
    if profiles.iter().any(|p| p.id == profile_id && p.mcp_enabled) {
        Ok(())
    } else {
        Err(CONNECTION_NOT_FOUND.to_string())
    }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/// `list_databases` args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct ConnectionIdArgs {
    /// Id returned by `connect` or `list_connections`.
    pub connection_id: String,
}

pub async fn list_databases_tool_impl(state: &AppState, profiles_path: &Path, connection_id: &str) -> Result<Vec<String>, String> {
    require_mcp_connection(state, profiles_path, connection_id)?;
    crate::list_databases_impl(state, connection_id).await
}

/// `list_collections` args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct DatabaseArgs {
    pub connection_id: String,
    pub database: String,
}

pub async fn list_collections_tool_impl(state: &AppState, profiles_path: &Path, connection_id: &str, database: &str) -> Result<Vec<CollectionInfo>, String> {
    require_mcp_connection(state, profiles_path, connection_id)?;
    crate::list_collections_impl(state, connection_id, database).await
}

/// `list_indexes`/`schema_analysis` args shape (also reused as the base for
/// `find`/`aggregate`/`explain`, which add their own fields below).
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct CollectionArgs {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
}

/// One index merged with its usage stats (`list_indexes`). `size_bytes`/
/// `ops` are `None` for mock connections (no storage engine to report
/// sizes/usage from) and whenever `$indexStats`/`$collStats` fails on a
/// real one (views, very old servers) — `index_stats_impl` already degrades
/// gracefully rather than erroring for those cases.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexWithStats {
    pub name: String,
    pub keys: String,
    pub unique: bool,
    pub sparse: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops: Option<i64>,
}

pub async fn list_indexes_tool_impl(
    state: &AppState,
    profiles_path: &Path,
    connection_id: &str,
    database: &str,
    collection: &str,
) -> Result<Vec<IndexWithStats>, String> {
    require_mcp_connection(state, profiles_path, connection_id)?;
    let indexes = crate::list_indexes_impl(state, connection_id, database, collection).await?;
    let is_mock = crate::connection_is_mock(state, connection_id)?;
    // Real-only (plan: "stats optional — real-only"); mock connections
    // report indexes with no stats rather than erroring.
    let stats = if is_mock { None } else { crate::index_stats_impl(state, connection_id, database, collection).await.ok() };
    Ok(indexes
        .into_iter()
        .map(|idx| {
            let stat = stats.as_ref().and_then(|s| s.iter().find(|st| st.name == idx.name));
            IndexWithStats {
                name: idx.name,
                keys: idx.keys,
                unique: idx.unique,
                sparse: idx.sparse,
                size_bytes: stat.map(|s| s.size_bytes),
                ops: stat.map(|s| s.ops),
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// find / aggregate / explain / schema_analysis
// ---------------------------------------------------------------------------

/// `find` args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct FindArgs {
    /// Id returned by `connect` or `list_connections`.
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// MQL filter as a JSON object string, e.g. `{"status":"active"}`. Omit for "match all".
    #[serde(default)]
    pub filter: Option<String>,
    /// MQL sort as a JSON object string, e.g. `{"createdAt":-1}`.
    #[serde(default)]
    pub sort: Option<String>,
    /// MQL projection as a JSON object string, e.g. `{"name":1,"_id":0}`.
    #[serde(default)]
    pub projection: Option<String>,
    /// Max documents to fetch from MongoDB. Default 50, hard cap 200. The
    /// response may be truncated further by the output size cap.
    #[serde(default)]
    pub limit: Option<i64>,
    /// Documents to skip before returning results. Default 0.
    #[serde(default)]
    pub skip: Option<i64>,
    /// Also return a total matching-document count (costs an extra query).
    #[serde(default)]
    pub include_count: Option<bool>,
}

/// `find` result envelope.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub documents: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<String>,
}

/// `""`/whitespace-only -> `"{}"`; anything else passed through as-is —
/// shared by `find`/`explain`'s optional filter/sort/projection args, all
/// of which mean "empty object" the same way.
fn non_empty_or_empty_object(s: Option<String>) -> String {
    s.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "{}".to_string())
}

/// Call-log summary for `find` — namespace + filter size, never the filter's
/// actual contents (same policy `insert_one_summary`/`update_many_summary`/
/// `delete_many_summary`/`create_index_summary` already follow below; `find`
/// previously built its summary inline in `mcp.rs` by interpolating the raw
/// filter JSON text straight into the log, which is exactly the leak those
/// other summaries are careful to avoid). `filter` is already a JSON object
/// *string* (or absent, meaning "match all") — unlike the write tools' typed
/// `serde_json::Value` args, so this measures its byte length directly
/// rather than via `json_byte_len`.
pub fn find_summary(database: &str, collection: &str, filter: Option<&str>) -> String {
    format!("{database}.{collection} find filter_bytes={}", filter.unwrap_or("{}").len())
}

pub async fn find_impl(state: &AppState, profiles_path: &Path, args: FindArgs) -> Result<FindResult, String> {
    require_mcp_connection(state, profiles_path, &args.connection_id)?;
    let filter = non_empty_or_empty_object(args.filter);
    let sort = non_empty_or_empty_object(args.sort);
    let projection = non_empty_or_empty_object(args.projection);
    let limit = normalize_find_limit(args.limit);
    let skip = args.skip.unwrap_or(0).max(0);

    let docs =
        crate::execute_mql_query_impl(state, &args.connection_id, &args.database, &args.collection, &filter, &sort, &projection, limit, skip).await?;
    let (documents, truncated) = cap_and_parse(docs, CAP_MAX_DOCS, CAP_MAX_BYTES)?;

    let count = if args.include_count.unwrap_or(false) {
        Some(crate::count_documents_impl(state, &args.connection_id, &args.database, &args.collection, &filter).await?)
    } else {
        None
    };

    Ok(FindResult { documents, count, truncated })
}

/// Default 50, hard cap 200 (plan: "limit 50 (cap 200)"); a non-positive
/// request falls back to the default rather than being clamped to 1, same
/// shape as `limits::normalize_query_limit`. Pulled out as a pure function
/// so the exact boundary behavior is unit-testable without a connection.
fn normalize_find_limit(requested: Option<i64>) -> i64 {
    let requested = requested.unwrap_or(DEFAULT_FIND_LIMIT);
    if requested <= 0 {
        DEFAULT_FIND_LIMIT
    } else {
        requested.min(MAX_FIND_LIMIT)
    }
}

/// `aggregate` args. `pipeline` is a JSON array of stage objects in the
/// schema (not a pre-serialized string) — schemars gives agents a real
/// array-of-objects shape to fill in; this module serializes it back to a
/// string once, for the existing `execute_aggregate_impl(..., pipeline:
/// &str)` seam.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct AggregateArgs {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// Aggregation pipeline as an array of stage objects, e.g.
    /// `[{"$match": {"status": "active"}}, {"$limit": 10}]`. Stages whose
    /// sole key is `$out` or `$merge` are rejected.
    pub pipeline: Vec<serde_json::Value>,
}

/// `aggregate` result envelope.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AggregateResult {
    pub documents: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<String>,
}

/// True iff `stage` is a JSON object whose *sole* top-level key is `$out`
/// or `$merge`. Deliberately shallow: a `$lookup` sub-pipeline (or any
/// other nested structure) that happens to carry the string `"$merge"` as a
/// VALUE — not as its own single top-level key — must not false-positive.
/// A multi-key object that happens to include `$out`/`$merge` alongside
/// another key isn't a valid single-stage form anyway and is left for the
/// driver/server to reject on its own terms.
fn stage_is_disallowed(stage: &serde_json::Value) -> bool {
    stage
        .as_object()
        .map(|obj| obj.len() == 1 && obj.keys().next().map(|k| k == "$out" || k == "$merge").unwrap_or(false))
        .unwrap_or(false)
}

pub async fn aggregate_impl(state: &AppState, profiles_path: &Path, args: AggregateArgs) -> Result<AggregateResult, String> {
    require_mcp_connection(state, profiles_path, &args.connection_id)?;
    // Reject $out/$merge before anything else touches the pipeline —
    // deliberately ahead of the mock-connection check below, so a rejected
    // pipeline is rejected the same way regardless of connection type.
    if args.pipeline.iter().any(stage_is_disallowed) {
        return Err("aggregation stages $out/$merge are not allowed via MCP".to_string());
    }
    let pipeline_json = serde_json::to_string(&args.pipeline).map_err(|e| format!("serialize pipeline: {e}"))?;
    // `execute_aggregate_impl` is real-connection-only and already returns
    // a clean "not supported on mock connections" error for mocks — no
    // separate `state.mocks` pre-check needed on top of that.
    let docs = crate::execute_aggregate_impl(state, &args.connection_id, &args.database, &args.collection, &pipeline_json).await?;
    let (documents, truncated) = cap_and_parse(docs, CAP_MAX_DOCS, CAP_MAX_BYTES)?;
    Ok(AggregateResult { documents, truncated })
}

/// `explain` args — either `find_filter` (find-style explain) or `pipeline`
/// (aggregate-style explain); `pipeline`, if present, wins.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct ExplainArgs {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// MQL filter as a JSON object string (find-style explain). Ignored if `pipeline` is set.
    #[serde(default)]
    pub find_filter: Option<String>,
    /// Aggregation pipeline as an array of stage objects (aggregate-style explain).
    #[serde(default)]
    pub pipeline: Option<Vec<serde_json::Value>>,
}

pub async fn explain_impl(state: &AppState, profiles_path: &Path, args: ExplainArgs) -> Result<String, String> {
    require_mcp_connection(state, profiles_path, &args.connection_id)?;
    match args.pipeline {
        Some(pipeline) => {
            // Same write-gate `aggregate_impl` applies, and for the same
            // reason: `explain` at `executionStats` verbosity actually
            // EXECUTES the pipeline against the server rather than just
            // planning it, so a `$merge`/`$out` stage reaching
            // `explain_aggregate_query_impl` would write data despite this
            // being nominally a read tool. Checked before the impl is ever
            // called — same exact error string as `aggregate`, same
            // ahead-of-mock-check ordering rationale.
            if pipeline.iter().any(stage_is_disallowed) {
                return Err("aggregation stages $out/$merge are not allowed via MCP".to_string());
            }
            let pipeline_json = serde_json::to_string(&pipeline).map_err(|e| format!("serialize pipeline: {e}"))?;
            crate::explain_aggregate_query_impl(state, &args.connection_id, &args.database, &args.collection, &pipeline_json).await
        }
        None => {
            let filter = non_empty_or_empty_object(args.find_filter);
            crate::explain_mql_query_impl(state, &args.connection_id, &args.database, &args.collection, &filter).await
        }
    }
}

/// `schema_analysis` args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct SchemaAnalysisArgs {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// Documents to sample. Default 100, hard cap 1000.
    #[serde(default)]
    pub sample_size: Option<i64>,
}

pub async fn schema_analysis_impl(state: &AppState, profiles_path: &Path, args: SchemaAnalysisArgs) -> Result<String, String> {
    require_mcp_connection(state, profiles_path, &args.connection_id)?;
    let sample_size = args.sample_size.unwrap_or(DEFAULT_SCHEMA_SAMPLE);
    // `analyze_schema_impl` -> `limits::normalize_schema_sample` already
    // floors non-positive values to 100 and caps at 1000; no duplicate
    // clamping needed here.
    crate::analyze_schema_impl(state, &args.connection_id, &args.database, &args.collection, sample_size).await
}

// ---------------------------------------------------------------------------
// Write tools (#98 Task 5) — insert_one / update_many / delete_many / create_index
// ---------------------------------------------------------------------------

/// The `_confirm` gate's exact rejection message, identical across every
/// destructive tool (`insert_one`, `update_many`, `delete_many`,
/// `create_index`) — an agent can pattern-match on it once rather than per
/// tool.
const CONFIRM_REQUIRED: &str = "Destructive operation blocked: call again with _confirm: true after restating exactly what will be modified.";

/// Shared `_confirm` gate for every destructive tool. Every write-tool impl
/// below calls this *after* `require_mcp_connection` — authorization (does
/// this connection/profile exist and remain opted in?) must be resolved
/// before confirmation, so a non-opted connection id always gets the
/// uniform `CONNECTION_NOT_FOUND` even when `_confirm` is false, never a
/// hint that the operation would otherwise have proceeded.
///
/// `op_desc` names the calling tool for readers of this function and is
/// asserted non-empty in debug builds; it is deliberately NOT interpolated
/// into the returned message — every rejection must be byte-for-byte the
/// same string regardless of which tool or operation triggered it.
fn require_confirm(confirm: bool, op_desc: &str) -> Result<(), String> {
    debug_assert!(!op_desc.trim().is_empty(), "op_desc should name the calling tool/operation");
    if confirm {
        Ok(())
    } else {
        Err(CONFIRM_REQUIRED.to_string())
    }
}

/// Byte length of `value` once serialized to JSON — the building block for
/// call-log summaries that mention *size* without ever including
/// document/filter contents (spec: "NEVER document/filter contents beyond
/// the 200-char truncation").
fn json_byte_len(value: &serde_json::Value) -> usize {
    serde_json::to_string(value).map(|s| s.len()).unwrap_or(0)
}

/// Best-effort: embed `s` as parsed JSON if it happens to already be valid
/// JSON text (every real-connection id string from `insert_document_impl`
/// is — it's built via `Bson::into_relaxed_extjson().to_string()`), else
/// fall back to embedding it as a JSON string literal (the mock path's
/// literal `"mock-inserted-id"` is not itself valid JSON text — it has no
/// surrounding quotes). Keeps `insert_one`'s result valid JSON either way
/// without re-implementing `insert_document_impl`'s id-rendering.
fn embed_json_or_string(s: String) -> serde_json::Value {
    serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s))
}

/// `insert_one` args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct InsertOneArgs {
    /// Id returned by `connect` or `list_connections`.
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// The document to insert, as a JSON object.
    pub document: serde_json::Value,
    /// Must be `true`. Before setting this, restate to the user exactly
    /// what will be inserted (the namespace and a summary of the document)
    /// and get their go-ahead — the call is rejected until then.
    pub _confirm: bool,
}

/// `insert_one` result envelope.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InsertOneResult {
    pub inserted_id: serde_json::Value,
}

/// Call-log summary for `insert_one` — namespace + document size, never the
/// document's actual contents.
pub fn insert_one_summary(database: &str, collection: &str, document: &serde_json::Value, confirmed: bool) -> String {
    format!("{database}.{collection} insert_one document_bytes={} confirmed={confirmed}", json_byte_len(document))
}

pub async fn insert_one_impl(state: &AppState, profiles_path: &Path, args: InsertOneArgs) -> Result<InsertOneResult, String> {
    require_mcp_connection(state, profiles_path, &args.connection_id)?;
    // Connection-mode guard is the OUTER gate (#188 Task 4): it runs after
    // `require_mcp_connection` (an agent must still be opted-in/authorized
    // first) but before `require_confirm`, so a read-only or unconfirmed
    // confirm-destructive connection rejects here — before the tool ever
    // gets to its own `_confirm` message. On a read-only connection ALL
    // four MCP write tools error with the read-only message, even when
    // `_confirm: true`. `insert_one` is non-destructive, so it passes
    // `confirmed=false`: `ConnectionMode::ConfirmDestructive` never blocks
    // it regardless.
    guard_writable(state, &args.connection_id, WriteOp::Insert, false)?;
    require_confirm(args._confirm, "insert_one")?;
    let document_json = serde_json::to_string(&args.document).map_err(|e| format!("serialize document: {e}"))?;
    let inserted_id = crate::insert_document_impl(state, &args.connection_id, &args.database, &args.collection, &document_json).await?;
    Ok(InsertOneResult { inserted_id: embed_json_or_string(inserted_id) })
}

/// `update_many` args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct UpdateManyArgs {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// MQL filter selecting documents to update, as a JSON object.
    pub filter: serde_json::Value,
    /// Update document using operators (e.g. `{"$set": {"field": "value"}}`).
    /// Bare replacement documents are rejected.
    pub update: serde_json::Value,
    /// Must be `true`; see `insert_one`'s `_confirm` doc.
    pub _confirm: bool,
}

/// `update_many` result envelope. `matched_count` isn't available: the
/// underlying `update_many_impl` seam (`db/documents.rs`) only returns
/// `modified_count` — this tool consumes that seam verbatim rather than
/// duplicating the driver call to recover the matched count too.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManyResult {
    pub modified_count: u64,
}

pub fn update_many_summary(database: &str, collection: &str, filter: &serde_json::Value, update: &serde_json::Value, confirmed: bool) -> String {
    format!(
        "{database}.{collection} update_many filter_bytes={} update_bytes={} confirmed={confirmed}",
        json_byte_len(filter),
        json_byte_len(update)
    )
}

pub async fn update_many_tool_impl(state: &AppState, profiles_path: &Path, args: UpdateManyArgs) -> Result<UpdateManyResult, String> {
    require_mcp_connection(state, profiles_path, &args.connection_id)?;
    // Outer gate (see `insert_one_impl`'s comment for the full rationale).
    // `update_many` IS destructive (`WriteOp::is_destructive`), so on a
    // `ConfirmDestructive` connection the guard also enforces `_confirm` —
    // both it and `require_confirm` below would reject an unconfirmed call,
    // but the guard runs first, so its `CONFIRM_MSG` wins over
    // `require_confirm`'s `CONFIRM_REQUIRED` message.
    guard_writable(state, &args.connection_id, WriteOp::UpdateMany, args._confirm)?;
    require_confirm(args._confirm, "update_many")?;
    let filter_json = serde_json::to_string(&args.filter).map_err(|e| format!("serialize filter: {e}"))?;
    let update_json = serde_json::to_string(&args.update).map_err(|e| format!("serialize update: {e}"))?;
    let modified_count = crate::update_many_impl(state, &args.connection_id, &args.database, &args.collection, &filter_json, &update_json, args._confirm).await?;
    Ok(UpdateManyResult { modified_count })
}

/// `delete_many` args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct DeleteManyArgs {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// MQL filter selecting documents to delete, as a JSON object.
    pub filter: serde_json::Value,
    /// Must be `true`; see `insert_one`'s `_confirm` doc.
    pub _confirm: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteManyResult {
    pub deleted_count: u64,
}

pub fn delete_many_summary(database: &str, collection: &str, filter: &serde_json::Value, confirmed: bool) -> String {
    format!("{database}.{collection} delete_many filter_bytes={} confirmed={confirmed}", json_byte_len(filter))
}

pub async fn delete_many_tool_impl(state: &AppState, profiles_path: &Path, args: DeleteManyArgs) -> Result<DeleteManyResult, String> {
    require_mcp_connection(state, profiles_path, &args.connection_id)?;
    // Outer gate (see `insert_one_impl`'s comment). `delete_many` is
    // destructive, same as `update_many`: on `ConfirmDestructive` the guard
    // requires `_confirm` and, if unconfirmed, its `CONFIRM_MSG` wins over
    // `require_confirm`'s message below since the guard runs first.
    guard_writable(state, &args.connection_id, WriteOp::DeleteMany, args._confirm)?;
    require_confirm(args._confirm, "delete_many")?;
    let filter_json = serde_json::to_string(&args.filter).map_err(|e| format!("serialize filter: {e}"))?;
    let deleted_count = crate::delete_many_impl(state, &args.connection_id, &args.database, &args.collection, &filter_json, args._confirm).await?;
    Ok(DeleteManyResult { deleted_count })
}

/// `create_index` args.
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct CreateIndexArgs {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// Index key spec as a JSON object, e.g. `{"email": 1}` or
    /// `{"a": 1, "b": -1}`.
    pub keys: serde_json::Value,
    /// Index name. Defaults to MongoDB's own naming convention (each key's
    /// `field_direction` joined by `_`, e.g. `email_1`) when omitted.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub unique: Option<bool>,
    #[serde(default)]
    pub sparse: Option<bool>,
    /// Must be `true`; see `insert_one`'s `_confirm` doc.
    pub _confirm: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateIndexResult {
    pub name: String,
}

pub fn create_index_summary(
    database: &str,
    collection: &str,
    keys: &serde_json::Value,
    name: Option<&str>,
    unique: bool,
    sparse: bool,
    confirmed: bool,
) -> String {
    format!(
        "{database}.{collection} create_index keys_bytes={} name={} unique={unique} sparse={sparse} confirmed={confirmed}",
        json_byte_len(keys),
        name.unwrap_or("<default>")
    )
}

/// One key's `dir` rendered the way it'd appear in a MongoDB-style default
/// index name: numbers print bare (`1`, `-1`), strings print unquoted
/// (`text`, `2dsphere`), anything else falls back to its JSON rendering.
fn index_dir_token(dir: &serde_json::Value) -> String {
    match dir {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// MongoDB's own default index-name convention: each key's `field_dir`
/// joined by `_` (e.g. `{"a":1,"b":-1}` -> `"a_1_b_-1"`) — mirrors the
/// frontend's `defaultIndexName` (`IndexModal.tsx`) closely enough for an
/// agent-facing default. `keys` must already be a non-empty JSON object;
/// `create_index_impl` itself would reject anything else once it tries to
/// convert `keys` to a BSON document, so failing the same way here (before
/// even reaching the impl) just fails a little earlier when there's no name
/// to fall back to.
fn default_index_name(keys: &serde_json::Value) -> Result<String, String> {
    let obj = keys.as_object().ok_or_else(|| "`keys` must be a JSON object, e.g. {\"field\": 1}".to_string())?;
    if obj.is_empty() {
        return Err("`keys` must have at least one field".to_string());
    }
    Ok(obj.iter().map(|(field, dir)| format!("{field}_{}", index_dir_token(dir))).collect::<Vec<_>>().join("_"))
}

pub async fn create_index_tool_impl(state: &AppState, profiles_path: &Path, args: CreateIndexArgs) -> Result<CreateIndexResult, String> {
    require_mcp_connection(state, profiles_path, &args.connection_id)?;
    // Outer gate (see `insert_one_impl`'s comment). `create_index` is
    // non-destructive, so like `insert_one` it passes `confirmed=false` and
    // is unaffected by `ConnectionMode::ConfirmDestructive`.
    guard_writable(state, &args.connection_id, WriteOp::CreateIndex, false)?;
    require_confirm(args._confirm, "create_index")?;
    let name = match args.name {
        Some(n) if !n.trim().is_empty() => n,
        _ => default_index_name(&args.keys)?,
    };
    let keys_json = serde_json::to_string(&args.keys).map_err(|e| format!("serialize keys: {e}"))?;
    crate::create_index_impl(state, &args.connection_id, &args.database, &args.collection, &name, &keys_json, args.unique.unwrap_or(false), args.sparse.unwrap_or(false))
        .await?;
    Ok(CreateIndexResult { name })
}

// ---------------------------------------------------------------------------
// Call-log summaries
// ---------------------------------------------------------------------------

/// Truncate `s` to at most `max` `char`s (never splitting a UTF-8
/// boundary), appending `…` when truncated — used to keep every
/// `mcp::log_call` summary within the spec's "≤200 chars".
pub fn truncate_summary(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{save_profiles_encrypted, ConnectionProfile};
    use std::path::PathBuf;

    const TEST_KEY: [u8; 32] = [7u8; 32];

    fn unlock(state: &AppState) {
        *state.vault_key.lock().unwrap() = Some(TEST_KEY);
    }

    /// A fresh, unique-per-test path under the OS temp dir — same idiom as
    /// `workspace.rs`'s `store::tmp_path`.
    fn tmp_profiles_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("mqlens-mcp-tools-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    fn profile(id: &str, name: &str, mcp_enabled: bool) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            uri: "mongodb://mock".to_string(),
            color_tag: None,
            ssh: None,
            mcp_enabled,
            connection_mode: Default::default(),
        }
    }

    /// An mcp-enabled profile carrying a non-default `ConnectionMode` —
    /// `connect_impl` propagates `profile.connection_mode` into the live
    /// connection's meta (see `connect_impl_propagates_the_profiles_connection_mode_into_meta`),
    /// so connecting through this profile is how the Task 4 tests below get
    /// a read-only/confirm-destructive MCP connection.
    fn profile_with_mode(id: &str, name: &str, mode: crate::connections::ConnectionMode) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            uri: "mongodb://mock".to_string(),
            color_tag: None,
            ssh: None,
            mcp_enabled: true,
            connection_mode: mode,
        }
    }

    fn write_profiles(path: &Path, profiles: &[ConnectionProfile]) {
        save_profiles_encrypted(path, &TEST_KEY, profiles).unwrap();
    }

    // ---- cap_results / cap_and_parse --------------------------------

    #[test]
    fn cap_results_keeps_the_first_doc_even_over_the_byte_budget() {
        let docs = vec!["x".repeat(2000)];
        let (out, truncated) = cap_results(docs.clone(), 50, 100);
        assert_eq!(out, docs);
        assert!(truncated.is_none(), "a single doc alone must never be reported as truncated");
    }

    #[test]
    fn cap_results_truncates_by_doc_count() {
        let docs: Vec<String> = (0..10).map(|i| format!("{{\"i\":{i}}}")).collect();
        let (out, truncated) = cap_results(docs, 3, 1_000_000);
        assert_eq!(out.len(), 3);
        assert!(truncated.unwrap().contains("3 of 10"));
    }

    #[test]
    fn cap_results_truncates_by_byte_budget() {
        let docs: Vec<String> = (0..5).map(|_| "x".repeat(40)).collect(); // 40 bytes each
        let (out, truncated) = cap_results(docs, 100, 100); // budget fits 2 (80 bytes), not a 3rd (120 > 100)
        assert_eq!(out.len(), 2);
        assert!(truncated.is_some());
    }

    #[test]
    fn cap_results_no_truncation_note_when_everything_fits() {
        let docs = vec!["a".to_string(), "b".to_string()];
        let (out, truncated) = cap_results(docs.clone(), 10, 1000);
        assert_eq!(out, docs);
        assert!(truncated.is_none());
    }

    #[test]
    fn cap_and_parse_truncates_and_still_parses_the_kept_docs() {
        let docs = vec!["{\"a\":1}".to_string(), "{\"a\":2}".to_string(), "{\"a\":3}".to_string()];
        let (values, truncated) = cap_and_parse(docs, 2, 1_000_000).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["a"], 1);
        assert!(truncated.is_some());
    }

    #[test]
    fn normalize_find_limit_defaults_and_caps() {
        assert_eq!(normalize_find_limit(None), DEFAULT_FIND_LIMIT);
        assert_eq!(normalize_find_limit(Some(0)), DEFAULT_FIND_LIMIT);
        assert_eq!(normalize_find_limit(Some(-5)), DEFAULT_FIND_LIMIT);
        assert_eq!(normalize_find_limit(Some(75)), 75);
        assert_eq!(normalize_find_limit(Some(9999)), MAX_FIND_LIMIT);
    }

    #[test]
    fn truncate_summary_never_splits_a_utf8_boundary_and_marks_truncation() {
        assert_eq!(truncate_summary("short", 200), "short");
        let long = "a".repeat(250);
        let out = truncate_summary(&long, 200);
        assert_eq!(out.chars().count(), 200);
        assert!(out.ends_with('…'));
    }

    // ---- $out/$merge rejection ---------------------------------------

    #[test]
    fn stage_is_disallowed_flags_only_exact_single_key_out_or_merge() {
        assert!(stage_is_disallowed(&serde_json::json!({"$out": "target_coll"})));
        assert!(stage_is_disallowed(&serde_json::json!({"$merge": {"into": "target_coll"}})));
        assert!(!stage_is_disallowed(&serde_json::json!({"$match": {"status": "active"}})));
        // $merge appearing as a VALUE (not the stage's own top-level key)
        // inside a $lookup sub-pipeline must not false-positive.
        assert!(!stage_is_disallowed(&serde_json::json!({
            "$lookup": {"from": "other", "pipeline": [{"$project": {"note": "$merge"}}], "as": "joined"}
        })));
        // Multi-key object: not a valid single-stage form either way.
        assert!(!stage_is_disallowed(&serde_json::json!({"$merge": "x", "extra": 1})));
    }

    // ---- list_profiles / list_connections ------------------------------

    #[test]
    fn list_profiles_filters_to_opted_in_only() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("list-profiles.enc");
        write_profiles(&path, &[profile("p1", "In", true), profile("p2", "Out", false)]);

        let out = list_profiles_impl(&state, &path).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "p1");
        assert_eq!(out[0].name, "In");
        // `ProfileSummary` has no `uri` field at all, so there is nothing to
        // assert here beyond "it compiles" — see the struct's doc comment.
    }

    #[test]
    fn list_connections_filters_to_currently_opted_in_profiles_live() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("list-connections.enc");
        write_profiles(&path, &[profile("p1", "In", true), profile("p2", "Out", false)]);

        crate::set_connection_meta_impl(&state, "c1", "p1", "In Conn", true, Default::default()).unwrap();
        crate::set_connection_meta_impl(&state, "c2", "p2", "Out Conn", false, Default::default()).unwrap();

        let out = list_connections_impl(&state, &path).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "c1");
        assert!(out[0].via_mcp);
    }

    // ---- connect / disconnect ------------------------------------------

    #[tokio::test]
    async fn connect_only_allows_opted_in_profiles_with_a_uniform_error() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("connect-opt-in.enc");
        write_profiles(&path, &[profile("p1", "In", true), profile("p2", "Out", false)]);

        assert!(connect_impl(&state, &path, "p1").await.is_ok());

        let not_opted = connect_impl(&state, &path, "p2").await.unwrap_err();
        let unknown = connect_impl(&state, &path, "does-not-exist").await.unwrap_err();
        assert_eq!(not_opted, PROFILE_NOT_FOUND);
        assert_eq!(not_opted, unknown, "non-opted and unknown profile ids must be indistinguishable");
    }

    #[tokio::test]
    async fn connect_sets_via_mcp_meta_and_tracks_the_session_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("connect-meta.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);

        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let meta = state.connection_meta.lock().unwrap().get(&id).cloned().unwrap();
        assert!(meta.via_mcp);
        assert_eq!(meta.profile_id, "p1");
        assert!(state.mcp.lock().unwrap().session_connections.contains(&id));
    }

    // #188: `connect_impl` must carry the profile's `connection_mode` into
    // `ConnectionMeta` verbatim, not silently drop to `Normal` -- the write
    // guard reads it straight off the meta, so an MCP agent connecting to a
    // read-only-tagged profile has to inherit that guard exactly like a
    // human's `set_connection_meta` call would.
    #[tokio::test]
    async fn connect_impl_propagates_the_profiles_connection_mode_into_meta() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("connect-mode.enc");
        write_profiles(
            &path,
            &[ConnectionProfile {
                id: "p1".to_string(),
                name: "Prod".to_string(),
                uri: "mongodb://mock".to_string(),
                color_tag: None,
                ssh: None,
                mcp_enabled: true,
                connection_mode: crate::connections::ConnectionMode::ReadOnly,
            }],
        );

        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let meta = state.connection_meta.lock().unwrap().get(&id).cloned().unwrap();
        assert_eq!(meta.mode, crate::connections::ConnectionMode::ReadOnly);
    }

    #[tokio::test]
    async fn disconnect_only_allows_ids_this_mcp_session_itself_connected() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("disconnect-session.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let mcp_id = connect_impl(&state, &path, "p1").await.unwrap();

        // A human-opened connection to the very same (opted-in) profile —
        // `disconnect` must still refuse it: it never went through
        // `connect_impl`, so it's not in `session_connections`.
        let human_id = crate::connect_db_impl(&state, "mongodb://mock", None).await.unwrap();
        crate::set_connection_meta_impl(&state, &human_id, "p1", "Human", false, Default::default()).unwrap();

        let err = disconnect_impl(&state, &human_id).await.unwrap_err();
        assert_eq!(err, CONNECTION_NOT_FOUND);
        assert!(state.connection_meta.lock().unwrap().contains_key(&human_id), "the human connection must be untouched");

        disconnect_impl(&state, &mcp_id).await.unwrap();
        assert!(state.connection_meta.lock().unwrap().get(&mcp_id).is_none());
        assert!(!state.mcp.lock().unwrap().session_connections.contains(&mcp_id));

        // Disconnecting the same id twice is now "not found" too (it left
        // the session set on the first disconnect).
        let err2 = disconnect_impl(&state, &mcp_id).await.unwrap_err();
        assert_eq!(err2, CONNECTION_NOT_FOUND);
    }

    /// A HUMAN disconnecting (Sidebar's `onDisconnect` -> the `disconnect_db`
    /// command -> `crate::disconnect_db_impl` directly, never going through
    /// this MCP session's own `disconnect_impl`) an agent-opened connection
    /// must not leave a stale entry in `McpControl.session_connections`
    /// (final whole-branch review fix wave) — otherwise that id sits there
    /// forever even though the connection itself is long gone.
    #[tokio::test]
    async fn human_disconnect_of_an_agent_connection_prunes_session_connections() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("disconnect-human-prunes.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let mcp_id = connect_impl(&state, &path, "p1").await.unwrap();
        assert!(state.mcp.lock().unwrap().session_connections.contains(&mcp_id));

        // The human path: `crate::disconnect_db_impl` directly, exactly what
        // the `disconnect_db` Tauri command wraps — never `disconnect_impl`
        // (which requires session ownership) itself.
        crate::disconnect_db_impl(&state, &mcp_id).await.unwrap();

        assert!(
            !state.mcp.lock().unwrap().session_connections.contains(&mcp_id),
            "a human disconnect must prune the id from session_connections, not just tear down the connection"
        );
    }

    // ---- require_mcp_connection -----------------------------------------

    #[tokio::test]
    async fn require_mcp_connection_rejects_unknown_and_non_opted_uniformly() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("require-guard.enc");
        write_profiles(&path, &[profile("p1", "In", true), profile("p2", "Out", false)]);

        let id_in = connect_impl(&state, &path, "p1").await.unwrap();
        let id_out = crate::connect_db_impl(&state, "mongodb://mock", None).await.unwrap();
        crate::set_connection_meta_impl(&state, &id_out, "p2", "Out", false, Default::default()).unwrap();

        assert!(require_mcp_connection(&state, &path, &id_in).is_ok());
        let err_out = require_mcp_connection(&state, &path, &id_out).unwrap_err();
        let err_unknown = require_mcp_connection(&state, &path, "nope").unwrap_err();
        assert_eq!(err_out, CONNECTION_NOT_FOUND);
        assert_eq!(err_out, err_unknown);
    }

    // ---- list_databases / list_collections / list_indexes ---------------

    #[tokio::test]
    async fn list_databases_and_collections_over_a_mock_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("list-db-coll.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let dbs = list_databases_tool_impl(&state, &path, &id).await.unwrap();
        assert!(dbs.contains(&"sales_db".to_string()));

        let colls = list_collections_tool_impl(&state, &path, &id, "sales_db").await.unwrap();
        assert!(colls.iter().any(|c| c.name == "customers"));
    }

    #[tokio::test]
    async fn list_databases_rejects_a_non_opted_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("list-db-guard.enc");
        write_profiles(&path, &[]);
        let err = list_databases_tool_impl(&state, &path, "nope").await.unwrap_err();
        assert_eq!(err, CONNECTION_NOT_FOUND);
    }

    #[tokio::test]
    async fn list_indexes_merges_mock_indexes_without_stats() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("list-indexes.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let out = list_indexes_tool_impl(&state, &path, &id, "sales_db", "customers").await.unwrap();
        assert!(!out.is_empty());
        assert!(out.iter().all(|i| i.size_bytes.is_none() && i.ops.is_none()), "mock indexes must report no stats");
    }

    // ---- find / aggregate / explain / schema_analysis --------------------

    #[tokio::test]
    async fn find_happy_path_over_a_mock_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("find-happy.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let result = find_impl(
            &state,
            &path,
            FindArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "transactions".into(),
                filter: None,
                sort: None,
                projection: None,
                limit: None,
                skip: None,
                include_count: Some(true),
            },
        )
        .await
        .unwrap();

        assert!(!result.documents.is_empty());
        assert_eq!(result.count, Some(result.documents.len() as u64));
        assert!(result.truncated.is_none());
    }

    #[tokio::test]
    async fn find_rejects_a_non_opted_connection_uniformly() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("find-not-found.enc");
        write_profiles(&path, &[]);
        let err = find_impl(
            &state,
            &path,
            FindArgs {
                connection_id: "nope".into(),
                database: "d".into(),
                collection: "c".into(),
                filter: None,
                sort: None,
                projection: None,
                limit: None,
                skip: None,
                include_count: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONNECTION_NOT_FOUND);
    }

    #[tokio::test]
    async fn aggregate_rejects_out_and_merge_stages_before_touching_the_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("aggregate-reject.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap(); // mock connection

        let err = aggregate_impl(
            &state,
            &path,
            AggregateArgs {
                connection_id: id.clone(),
                database: "sales_db".into(),
                collection: "transactions".into(),
                pipeline: vec![serde_json::json!({"$out": "backup"})],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, "aggregation stages $out/$merge are not allowed via MCP");

        let err2 = aggregate_impl(
            &state,
            &path,
            AggregateArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "transactions".into(),
                pipeline: vec![serde_json::json!({"$merge": {"into": "backup"}})],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err2, "aggregation stages $out/$merge are not allowed via MCP");
    }

    #[tokio::test]
    async fn aggregate_allows_a_lookup_stage_carrying_merge_as_a_nested_value() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("aggregate-nested-merge.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap(); // mock connection

        // Mock connections are real-only for aggregate, so this still errors
        // — but it must be the *mock* error, not the $out/$merge rejection,
        // proving the nested "$merge" value didn't trip the guard.
        let err = aggregate_impl(
            &state,
            &path,
            AggregateArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "transactions".into(),
                pipeline: vec![serde_json::json!({
                    "$lookup": {"from": "other", "pipeline": [{"$project": {"note": "$merge"}}], "as": "joined"}
                })],
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("mock"), "expected the mock-connection error, got: {err}");
    }

    #[tokio::test]
    async fn aggregate_over_a_mock_connection_gives_a_clean_error() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("aggregate-mock.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap(); // mock

        let err = aggregate_impl(
            &state,
            &path,
            AggregateArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "transactions".into(),
                pipeline: vec![serde_json::json!({"$match": {"status": "Completed"}})],
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("mock"), "expected a clean mock-connection error, got: {err}");
    }

    #[tokio::test]
    async fn explain_routes_to_find_or_aggregate_explain() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("explain.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap(); // mock

        // find-style explain works over mock connections.
        let out = explain_impl(
            &state,
            &path,
            ExplainArgs { connection_id: id.clone(), database: "sales_db".into(), collection: "transactions".into(), find_filter: None, pipeline: None },
        )
        .await
        .unwrap();
        assert!(!out.is_empty());

        // aggregate-style explain is real-only; mock gives a clean error.
        let err = explain_impl(
            &state,
            &path,
            ExplainArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "transactions".into(),
                find_filter: None,
                pipeline: Some(vec![serde_json::json!({"$match": {}})]),
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("mock"));
    }

    /// Write-gate hole (final whole-branch review fix wave): `explain` at
    /// `executionStats` verbosity EXECUTES an aggregate-style pipeline
    /// against the server rather than merely planning it, so a `$merge`
    /// pipeline reaching `explain_aggregate_query_impl` would write data
    /// despite `explain` being nominally a read tool. Proves the same
    /// denylist `aggregate_impl` uses is applied here too, with the exact
    /// same error string, and — since this is a *mock* connection, whose
    /// `explain_aggregate_query_impl` path would otherwise return a "mock"
    /// error, not the denylist one — that the impl is never reached at all.
    #[tokio::test]
    async fn explain_rejects_out_and_merge_stages_before_touching_the_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("explain-reject.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap(); // mock

        let err = explain_impl(
            &state,
            &path,
            ExplainArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "transactions".into(),
                find_filter: None,
                pipeline: Some(vec![serde_json::json!({"$merge": {"into": "backup"}})]),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, "aggregation stages $out/$merge are not allowed via MCP");
    }

    #[tokio::test]
    async fn schema_analysis_over_a_mock_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("schema.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let out = schema_analysis_impl(
            &state,
            &path,
            SchemaAnalysisArgs { connection_id: id, database: "sales_db".into(), collection: "customers".into(), sample_size: Some(5000) },
        )
        .await
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("sampled").is_some());
    }

    // ---- Task 5: write tools + _confirm gate -----------------------------

    #[test]
    fn require_confirm_rejects_with_the_exact_message() {
        let err = require_confirm(false, "insert_one").unwrap_err();
        assert_eq!(err, "Destructive operation blocked: call again with _confirm: true after restating exactly what will be modified.");
        assert!(require_confirm(true, "insert_one").is_ok());
    }

    #[test]
    fn default_index_name_matches_mongo_convention() {
        assert_eq!(default_index_name(&serde_json::json!({"email": 1})).unwrap(), "email_1");
        assert_eq!(default_index_name(&serde_json::json!({"a": 1, "b": -1})).unwrap(), "a_1_b_-1");
        assert_eq!(default_index_name(&serde_json::json!({"loc": "2dsphere"})).unwrap(), "loc_2dsphere");
        assert!(default_index_name(&serde_json::json!([1, 2])).is_err());
        assert!(default_index_name(&serde_json::json!({})).is_err());
    }

    #[test]
    fn write_tool_summaries_never_embed_document_or_filter_contents() {
        let secret_doc = serde_json::json!({"ssn": "123-45-6789", "salary": 999999});
        let s = insert_one_summary("db", "coll", &secret_doc, true);
        assert!(!s.contains("123-45-6789") && !s.contains("999999"), "summary leaked document contents: {s}");
        assert_eq!(s, "db.coll insert_one document_bytes=37 confirmed=true");

        let filter = serde_json::json!({"password": "hunter2"});
        let update = serde_json::json!({"$set": {"password": "new-secret"}});
        let s = update_many_summary("db", "coll", &filter, &update, false);
        assert!(!s.contains("hunter2") && !s.contains("new-secret"));
        assert!(s.starts_with("db.coll update_many filter_bytes=") && s.contains("confirmed=false"));

        let s = delete_many_summary("db", "coll", &filter, true);
        assert!(!s.contains("hunter2"));
        assert!(s.starts_with("db.coll delete_many filter_bytes=") && s.contains("confirmed=true"));

        let keys = serde_json::json!({"email": 1});
        let s = create_index_summary("db", "coll", &keys, Some("email_1"), true, false, true);
        assert_eq!(s, "db.coll create_index keys_bytes=11 name=email_1 unique=true sparse=false confirmed=true");
        let s_default = create_index_summary("db", "coll", &keys, None, false, false, false);
        assert!(s_default.contains("name=<default>"));

        // `find` isn't a write/destructive tool, but its call-log summary is
        // built the same way (`mcp.rs`'s `find` wrapper) and must follow the
        // same no-content-leak policy — it previously interpolated the raw
        // filter JSON text directly (final whole-branch review fix wave).
        let s = find_summary("db", "coll", Some(r#"{"password":"hunter2"}"#));
        assert!(!s.contains("hunter2"), "find summary leaked filter contents: {s}");
        assert_eq!(s, "db.coll find filter_bytes=22");
        let s_none = find_summary("db", "coll", None);
        assert_eq!(s_none, "db.coll find filter_bytes=2");
    }

    // ---- insert_one --------------------------------------------------

    #[tokio::test]
    async fn insert_one_without_confirm_is_rejected_and_does_not_call_the_impl() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("insert-one-no-confirm.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let err = insert_one_impl(
            &state,
            &path,
            InsertOneArgs { connection_id: id, database: "sales_db".into(), collection: "customers".into(), document: serde_json::json!({"name": "Eve"}), _confirm: false },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONFIRM_REQUIRED);
        // No signal the impl ran beyond the error itself is observable on a
        // mock connection (mock inserts don't persist either way) — the gate
        // returning before `insert_document_impl` is called is what this
        // test actually proves via the exact error text above.
    }

    #[tokio::test]
    async fn insert_one_with_confirm_succeeds_on_mock_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("insert-one-confirm.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let result = insert_one_impl(
            &state,
            &path,
            InsertOneArgs { connection_id: id, database: "sales_db".into(), collection: "customers".into(), document: serde_json::json!({"name": "Eve"}), _confirm: true },
        )
        .await
        .unwrap();
        // Mock path returns `insert_document_impl`'s literal mock id.
        assert_eq!(result.inserted_id, serde_json::Value::String("mock-inserted-id".to_string()));
    }

    #[tokio::test]
    async fn insert_one_rejects_a_non_opted_connection_before_the_confirm_gate() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("insert-one-guard.enc");
        write_profiles(&path, &[]);
        // _confirm: false too — authorization must win regardless, never a
        // hint that the op would proceed if only _confirm were true.
        let err = insert_one_impl(
            &state,
            &path,
            InsertOneArgs { connection_id: "nope".into(), database: "d".into(), collection: "c".into(), document: serde_json::json!({}), _confirm: false },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONNECTION_NOT_FOUND, "authorization must be checked before the confirm gate");
    }

    // ---- update_many ---------------------------------------------------

    #[tokio::test]
    async fn update_many_without_confirm_is_rejected() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("update-many-no-confirm.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let err = update_many_tool_impl(
            &state,
            &path,
            UpdateManyArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "customers".into(),
                filter: serde_json::json!({"tier": "gold"}),
                update: serde_json::json!({"$set": {"tier": "platinum"}}),
                _confirm: false,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONFIRM_REQUIRED);
    }

    #[tokio::test]
    async fn update_many_with_confirm_no_ops_cleanly_on_mock_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("update-many-confirm.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let result = update_many_tool_impl(
            &state,
            &path,
            UpdateManyArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "customers".into(),
                filter: serde_json::json!({"tier": "gold"}),
                update: serde_json::json!({"$set": {"tier": "platinum"}}),
                _confirm: true,
            },
        )
        .await
        .unwrap();
        // `update_many_impl`'s documented mock behavior: no-op, modified_count 0.
        assert_eq!(result.modified_count, 0);
    }

    #[tokio::test]
    async fn update_many_rejects_a_non_opted_connection_with_confirm_false() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("update-many-guard.enc");
        write_profiles(&path, &[]);
        let err = update_many_tool_impl(
            &state,
            &path,
            UpdateManyArgs {
                connection_id: "nope".into(),
                database: "d".into(),
                collection: "c".into(),
                filter: serde_json::json!({}),
                update: serde_json::json!({"$set": {"a": 1}}),
                _confirm: false,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONNECTION_NOT_FOUND);
    }

    // ---- delete_many ---------------------------------------------------

    #[tokio::test]
    async fn delete_many_without_confirm_is_rejected() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("delete-many-no-confirm.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let err = delete_many_tool_impl(
            &state,
            &path,
            DeleteManyArgs { connection_id: id, database: "sales_db".into(), collection: "customers".into(), filter: serde_json::json!({"tier": "X"}), _confirm: false },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONFIRM_REQUIRED);
    }

    #[tokio::test]
    async fn delete_many_with_confirm_no_ops_cleanly_on_mock_connection() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("delete-many-confirm.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let result = delete_many_tool_impl(
            &state,
            &path,
            DeleteManyArgs { connection_id: id, database: "sales_db".into(), collection: "customers".into(), filter: serde_json::json!({"tier": "X"}), _confirm: true },
        )
        .await
        .unwrap();
        // `delete_many_impl`'s documented mock behavior: no-op, deleted_count 0.
        assert_eq!(result.deleted_count, 0);
    }

    #[tokio::test]
    async fn delete_many_rejects_a_non_opted_connection_with_confirm_false() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("delete-many-guard.enc");
        write_profiles(&path, &[]);
        let err = delete_many_tool_impl(
            &state,
            &path,
            DeleteManyArgs { connection_id: "nope".into(), database: "d".into(), collection: "c".into(), filter: serde_json::json!({}), _confirm: false },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONNECTION_NOT_FOUND);
    }

    // ---- create_index ----------------------------------------------------

    #[tokio::test]
    async fn create_index_without_confirm_is_rejected() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("create-index-no-confirm.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let err = create_index_tool_impl(
            &state,
            &path,
            CreateIndexArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "customers".into(),
                keys: serde_json::json!({"email": 1}),
                name: None,
                unique: None,
                sparse: None,
                _confirm: false,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONFIRM_REQUIRED);
    }

    #[tokio::test]
    async fn create_index_with_confirm_succeeds_on_mock_connection_and_defaults_the_name() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("create-index-confirm.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        // `sales_db.customers`'s mock demo data already ships default
        // indexes named `_id_`/`email_1`/`tier_1` (see `mock_db::get_mock_indexes`);
        // `create_index_impl`'s mock branch is a by-name no-op, so this test
        // uses a field with no pre-existing default index to actually
        // exercise the create path (not silently no-op against a same-named
        // default).
        let result = create_index_tool_impl(
            &state,
            &path,
            CreateIndexArgs {
                connection_id: id.clone(),
                database: "sales_db".into(),
                collection: "customers".into(),
                keys: serde_json::json!({"loyaltyPoints": 1}),
                name: None,
                unique: Some(true),
                sparse: None,
                _confirm: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.name, "loyaltyPoints_1");

        // The mock path's `create_index_impl` actually records the index —
        // verify it shows up via the read-side seam already covered by
        // Task 4's tests, proving this tool really called through rather
        // than short-circuiting.
        let indexes = list_indexes_tool_impl(&state, &path, &id, "sales_db", "customers").await.unwrap();
        assert!(indexes.iter().any(|i| i.name == "loyaltyPoints_1" && i.unique), "expected the newly created index to appear: {indexes:?}");
    }

    #[tokio::test]
    async fn create_index_honors_an_explicit_name() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("create-index-explicit-name.enc");
        write_profiles(&path, &[profile("p1", "In", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        let result = create_index_tool_impl(
            &state,
            &path,
            CreateIndexArgs {
                connection_id: id,
                database: "sales_db".into(),
                collection: "customers".into(),
                keys: serde_json::json!({"email": 1}),
                name: Some("by_email".into()),
                unique: None,
                sparse: None,
                _confirm: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.name, "by_email");
    }

    #[tokio::test]
    async fn create_index_rejects_a_non_opted_connection_with_confirm_false() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("create-index-guard.enc");
        write_profiles(&path, &[]);
        let err = create_index_tool_impl(
            &state,
            &path,
            CreateIndexArgs {
                connection_id: "nope".into(),
                database: "d".into(),
                collection: "c".into(),
                keys: serde_json::json!({"a": 1}),
                name: None,
                unique: None,
                sparse: None,
                _confirm: false,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONNECTION_NOT_FOUND);
    }

    // ---- Task 4: connection-mode gate composition (guard_writable runs
    // before require_confirm in all four write tools) ------------------

    #[tokio::test]
    async fn read_only_mcp_connection_blocks_all_four_write_tools_even_with_confirm_true() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("mode-gate-read-only.enc");
        write_profiles(&path, &[profile_with_mode("p1", "RO", crate::connections::ConnectionMode::ReadOnly)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        // Every one of these passes `_confirm: true` — proving the guard,
        // not `require_confirm`, is what's rejecting them: a confirm-only
        // gate would have let these through.
        let err = insert_one_impl(
            &state,
            &path,
            InsertOneArgs { connection_id: id.clone(), database: "d".into(), collection: "c".into(), document: serde_json::json!({"a": 1}), _confirm: true },
        )
        .await
        .unwrap_err();
        assert!(err.contains("read-only"), "insert_one: {err}");

        let err = update_many_tool_impl(
            &state,
            &path,
            UpdateManyArgs {
                connection_id: id.clone(),
                database: "d".into(),
                collection: "c".into(),
                filter: serde_json::json!({}),
                update: serde_json::json!({"$set": {"a": 1}}),
                _confirm: true,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("read-only"), "update_many: {err}");

        let err = delete_many_tool_impl(
            &state,
            &path,
            DeleteManyArgs { connection_id: id.clone(), database: "d".into(), collection: "c".into(), filter: serde_json::json!({}), _confirm: true },
        )
        .await
        .unwrap_err();
        assert!(err.contains("read-only"), "delete_many: {err}");

        let err = create_index_tool_impl(
            &state,
            &path,
            CreateIndexArgs {
                connection_id: id,
                database: "d".into(),
                collection: "c".into(),
                keys: serde_json::json!({"a": 1}),
                name: None,
                unique: None,
                sparse: None,
                _confirm: true,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("read-only"), "create_index: {err}");
    }

    #[tokio::test]
    async fn confirm_destructive_mcp_connection_the_guards_message_wins_over_require_confirms() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("mode-gate-confirm-destructive.enc");
        write_profiles(&path, &[profile_with_mode("p1", "CD", crate::connections::ConnectionMode::ConfirmDestructive)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        // update_many / delete_many unconfirmed: BOTH `guard_writable` and
        // `require_confirm` would reject, but the guard runs first, so its
        // `write_guard::CONFIRM_MSG` is the error actually seen — not
        // `require_confirm`'s `CONFIRM_REQUIRED`.
        let err = update_many_tool_impl(
            &state,
            &path,
            UpdateManyArgs {
                connection_id: id.clone(),
                database: "d".into(),
                collection: "c".into(),
                filter: serde_json::json!({}),
                update: serde_json::json!({"$set": {"a": 1}}),
                _confirm: false,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, crate::write_guard::CONFIRM_MSG, "the GUARD's message must win, not require_confirm's");
        assert_ne!(err, CONFIRM_REQUIRED);

        let err = delete_many_tool_impl(
            &state,
            &path,
            DeleteManyArgs { connection_id: id.clone(), database: "d".into(), collection: "c".into(), filter: serde_json::json!({}), _confirm: false },
        )
        .await
        .unwrap_err();
        assert_eq!(err, crate::write_guard::CONFIRM_MSG, "the GUARD's message must win, not require_confirm's");

        // Confirmed: passes the guard (and require_confirm), reaches the
        // impl's documented mock no-op behavior.
        let result = update_many_tool_impl(
            &state,
            &path,
            UpdateManyArgs {
                connection_id: id.clone(),
                database: "d".into(),
                collection: "c".into(),
                filter: serde_json::json!({}),
                update: serde_json::json!({"$set": {"a": 1}}),
                _confirm: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.modified_count, 0);

        let result = delete_many_tool_impl(
            &state,
            &path,
            DeleteManyArgs { connection_id: id.clone(), database: "d".into(), collection: "c".into(), filter: serde_json::json!({}), _confirm: true },
        )
        .await
        .unwrap();
        assert_eq!(result.deleted_count, 0);

        // insert_one / create_index are non-destructive — `WriteOp::is_destructive`
        // doesn't cover them, so `ConnectionMode::ConfirmDestructive` never
        // blocks them; they pass with `_confirm: true` same as on a normal
        // connection.
        let result = insert_one_impl(
            &state,
            &path,
            InsertOneArgs { connection_id: id.clone(), database: "d".into(), collection: "c".into(), document: serde_json::json!({"a": 1}), _confirm: true },
        )
        .await
        .unwrap();
        assert_eq!(result.inserted_id, serde_json::Value::String("mock-inserted-id".to_string()));

        let result = create_index_tool_impl(
            &state,
            &path,
            CreateIndexArgs {
                connection_id: id,
                database: "d".into(),
                collection: "c".into(),
                keys: serde_json::json!({"a": 1}),
                name: None,
                unique: None,
                sparse: None,
                _confirm: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.name, "a_1");
    }

    #[tokio::test]
    async fn normal_mcp_connection_unchanged_require_confirm_still_blocks_unconfirmed_writes() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("mode-gate-normal.enc");
        write_profiles(&path, &[profile("p1", "Normal", true)]);
        let id = connect_impl(&state, &path, "p1").await.unwrap();

        // On a `Normal` connection the guard always passes, so the
        // pre-existing `require_confirm` behavior is exactly what fires —
        // unchanged from before Task 4.
        let err = insert_one_impl(
            &state,
            &path,
            InsertOneArgs { connection_id: id, database: "d".into(), collection: "c".into(), document: serde_json::json!({"a": 1}), _confirm: false },
        )
        .await
        .unwrap_err();
        assert_eq!(err, CONFIRM_REQUIRED);
    }
}
