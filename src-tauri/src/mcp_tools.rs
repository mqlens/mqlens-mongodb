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
    crate::set_connection_meta_impl(state, &connection_id, &profile.id, &profile.name, true)?;
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
        ConnectionProfile { id: id.to_string(), name: name.to_string(), uri: "mongodb://mock".to_string(), color_tag: None, ssh: None, mcp_enabled }
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

        crate::set_connection_meta_impl(&state, "c1", "p1", "In Conn", true).unwrap();
        crate::set_connection_meta_impl(&state, "c2", "p2", "Out Conn", false).unwrap();

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
        crate::set_connection_meta_impl(&state, &human_id, "p1", "Human", false).unwrap();

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

    // ---- require_mcp_connection -----------------------------------------

    #[tokio::test]
    async fn require_mcp_connection_rejects_unknown_and_non_opted_uniformly() {
        let state = AppState::new();
        unlock(&state);
        let path = tmp_profiles_path("require-guard.enc");
        write_profiles(&path, &[profile("p1", "In", true), profile("p2", "Out", false)]);

        let id_in = connect_impl(&state, &path, "p1").await.unwrap();
        let id_out = crate::connect_db_impl(&state, "mongodb://mock", None).await.unwrap();
        crate::set_connection_meta_impl(&state, &id_out, "p2", "Out", false).unwrap();

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
}
