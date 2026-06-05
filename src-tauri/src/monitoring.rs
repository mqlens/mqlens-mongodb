//! Cluster monitoring: curated `serverStatus`, current operations (+ kill), and
//! the database profiler. Live admin/db commands are run against the real client;
//! mock connections return synthetic data so the dashboard works in demo mode.
//!
//! The curation functions (raw BSON `Document` -> typed struct) are pure and
//! unit-tested; the async `*_impl` wrappers just run the command and curate.

use crate::{connection_is_mock, require_real_client, AppState};
use mongodb::bson::{doc, Bson, Document};
use serde::Serialize;

// BSON numbers arrive as Int32 / Int64 / Double; coerce any of them to i64.
fn num(d: &Document, key: &str) -> i64 {
    match d.get(key) {
        Some(Bson::Int32(v)) => *v as i64,
        Some(Bson::Int64(v)) => *v,
        Some(Bson::Double(v)) => *v as i64,
        _ => 0,
    }
}
fn fnum(d: &Document, key: &str) -> f64 {
    match d.get(key) {
        Some(Bson::Int32(v)) => *v as f64,
        Some(Bson::Int64(v)) => *v as f64,
        Some(Bson::Double(v)) => *v,
        _ => 0.0,
    }
}
fn sub<'a>(d: &'a Document, key: &str) -> Option<&'a Document> {
    d.get_document(key).ok()
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connections {
    pub current: i64,
    pub available: i64,
    pub total_created: i64,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpCounters {
    pub insert: i64,
    pub query: i64,
    pub update: i64,
    pub delete: i64,
    pub getmore: i64,
    pub command: i64,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub resident_mb: i64,
    pub virtual_mb: i64,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub bytes_in: i64,
    pub bytes_out: i64,
    pub num_requests: i64,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub bytes_in_cache: i64,
    pub max_bytes: i64,
    pub dirty_bytes: i64,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub host: String,
    pub version: String,
    pub uptime_seconds: f64,
    pub connections: Connections,
    pub opcounters: OpCounters,
    pub memory: Memory,
    pub network: Network,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<CacheStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repl_set: Option<String>,
}

/// Curate a raw `serverStatus` document into the dashboard's subset.
pub fn curate_server_status(raw: &Document) -> ServerStatus {
    let connections = sub(raw, "connections")
        .map(|c| Connections {
            current: num(c, "current"),
            available: num(c, "available"),
            total_created: num(c, "totalCreated"),
        })
        .unwrap_or_default();
    let opcounters = sub(raw, "opcounters")
        .map(|o| OpCounters {
            insert: num(o, "insert"),
            query: num(o, "query"),
            update: num(o, "update"),
            delete: num(o, "delete"),
            getmore: num(o, "getmore"),
            command: num(o, "command"),
        })
        .unwrap_or_default();
    let memory = sub(raw, "mem")
        .map(|m| Memory { resident_mb: num(m, "resident"), virtual_mb: num(m, "virtual") })
        .unwrap_or_default();
    let network = sub(raw, "network")
        .map(|n| Network {
            bytes_in: num(n, "bytesIn"),
            bytes_out: num(n, "bytesOut"),
            num_requests: num(n, "numRequests"),
        })
        .unwrap_or_default();
    let cache = sub(raw, "wiredTiger")
        .and_then(|wt| sub(wt, "cache"))
        .map(|c| CacheStats {
            bytes_in_cache: num(c, "bytes currently in the cache"),
            max_bytes: num(c, "maximum bytes configured"),
            dirty_bytes: num(c, "tracked dirty bytes in the cache"),
        });
    let repl_set = sub(raw, "repl").and_then(|r| r.get_str("setName").ok().map(String::from));

    ServerStatus {
        host: raw.get_str("host").unwrap_or_default().to_string(),
        version: raw.get_str("version").unwrap_or_default().to_string(),
        uptime_seconds: fnum(raw, "uptime"),
        connections,
        opcounters,
        memory,
        network,
        cache,
        repl_set,
    }
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentOp {
    pub opid: i64,
    pub op: String,
    pub ns: String,
    pub secs_running: i64,
    pub client: String,
    pub desc: String,
    pub command: String,
}

/// Keep the current-op payload bounded so a busy/large cluster can't flood the
/// IPC boundary and hang the UI: retain at most `MAX_OPS` ops (the caller sorts
/// longest-running first) and truncate each command string to `MAX_CMD_CHARS`.
const MAX_OPS: usize = 200;
const MAX_CMD_CHARS: usize = 2000;

pub fn cap_current_ops(mut ops: Vec<CurrentOp>) -> Vec<CurrentOp> {
    ops.truncate(MAX_OPS);
    for o in &mut ops {
        if o.command.chars().count() > MAX_CMD_CHARS {
            // char-boundary safe (commands can contain multibyte UTF-8).
            let truncated: String = o.command.chars().take(MAX_CMD_CHARS).collect();
            o.command = format!("{truncated}…");
        }
    }
    ops
}

/// Curate one `inprog` entry into a CurrentOp row. The full command is kept here;
/// `cap_current_ops` bounds it for transport. The UI ellipsizes it in the table.
pub fn curate_current_op(d: &Document) -> CurrentOp {
    let command = d.get("command").map(|c| c.to_string()).unwrap_or_default();
    CurrentOp {
        opid: num(d, "opid"),
        op: d.get_str("op").unwrap_or_default().to_string(),
        ns: d.get_str("ns").unwrap_or_default().to_string(),
        secs_running: num(d, "secs_running"),
        client: d.get_str("client").unwrap_or_default().to_string(),
        desc: d.get_str("desc").unwrap_or_default().to_string(),
        command,
    }
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilingStatus {
    pub level: i64,
    pub slow_ms: i64,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEntry {
    pub op: String,
    pub ns: String,
    pub millis: i64,
    pub ts_ms: i64,
    pub plan_summary: String,
    pub command: String,
}

/// Curate one `system.profile` document into a slow-query row.
pub fn curate_profile_entry(d: &Document) -> ProfileEntry {
    let ts_ms = match d.get("ts") {
        Some(Bson::DateTime(dt)) => dt.timestamp_millis(),
        _ => 0,
    };
    let command = d.get("command").map(|c| c.to_string()).unwrap_or_default();
    ProfileEntry {
        op: d.get_str("op").unwrap_or_default().to_string(),
        ns: d.get_str("ns").unwrap_or_default().to_string(),
        millis: num(d, "millis"),
        ts_ms,
        plan_summary: d.get_str("planSummary").unwrap_or_default().to_string(),
        command,
    }
}

// ── Mock data (demo connections) ──────────────────────────────────────────────

fn mock_server_status() -> ServerStatus {
    ServerStatus {
        host: "mqlens-demo:27017".into(),
        version: "7.0.0".into(),
        uptime_seconds: 86_400.0,
        connections: Connections { current: 7, available: 838_853, total_created: 412 },
        opcounters: OpCounters { insert: 1200, query: 53_400, update: 980, delete: 120, getmore: 8400, command: 91_000 },
        memory: Memory { resident_mb: 412, virtual_mb: 2_810 },
        network: Network { bytes_in: 8_400_000, bytes_out: 19_200_000, num_requests: 64_000 },
        cache: Some(CacheStats { bytes_in_cache: 268_435_456, max_bytes: 536_870_912, dirty_bytes: 12_582_912 }),
        repl_set: None,
    }
}

// ── Async command impls ───────────────────────────────────────────────────────

pub async fn server_status_impl(state: &AppState, id: &str) -> Result<ServerStatus, String> {
    if connection_is_mock(state, id)? {
        return Ok(mock_server_status());
    }
    let client = require_real_client(state, id)?;
    let raw = client
        .database("admin")
        .run_command(doc! { "serverStatus": 1 })
        .await
        .map_err(|e| format!("serverStatus failed: {}", e))?;
    Ok(curate_server_status(&raw))
}

pub async fn current_ops_impl(state: &AppState, id: &str) -> Result<Vec<CurrentOp>, String> {
    if connection_is_mock(state, id)? {
        return Ok(vec![CurrentOp {
            opid: 10241,
            op: "query".into(),
            ns: "sales_db.orders".into(),
            secs_running: 3,
            client: "127.0.0.1:51544".into(),
            desc: "conn412".into(),
            command: "{ find: \"orders\", filter: { status: \"open\" } }".into(),
        }]);
    }
    let client = require_real_client(state, id)?;
    let raw = client
        .database("admin")
        .run_command(doc! { "currentOp": 1, "active": true })
        .await
        .map_err(|e| format!("currentOp failed: {}", e))?;
    let inprog = raw.get_array("inprog").map_err(|_| "currentOp returned no inprog".to_string())?;
    let mut ops: Vec<CurrentOp> = inprog
        .iter()
        .filter_map(|b| b.as_document())
        // Skip idle/no-op connections.
        .filter(|d| d.get_str("op").map(|o| o != "none").unwrap_or(true))
        .map(curate_current_op)
        .collect();
    ops.sort_by(|a, b| b.secs_running.cmp(&a.secs_running));
    Ok(cap_current_ops(ops))
}

pub async fn kill_op_impl(state: &AppState, id: &str, opid: i64) -> Result<(), String> {
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database("admin")
        .run_command(doc! { "killOp": 1, "op": opid })
        .await
        .map_err(|e| format!("killOp failed: {}", e))?;
    Ok(())
}

pub async fn profiling_status_impl(state: &AppState, id: &str, database: &str) -> Result<ProfilingStatus, String> {
    if connection_is_mock(state, id)? {
        return Ok(ProfilingStatus { level: 0, slow_ms: 100 });
    }
    let client = require_real_client(state, id)?;
    let raw = client
        .database(database)
        .run_command(doc! { "profile": -1 })
        .await
        .map_err(|e| format!("get profiling status failed: {}", e))?;
    Ok(ProfilingStatus { level: num(&raw, "was"), slow_ms: num(&raw, "slowms") })
}

pub async fn set_profiling_level_impl(
    state: &AppState,
    id: &str,
    database: &str,
    level: i32,
    slow_ms: i32,
) -> Result<ProfilingStatus, String> {
    if connection_is_mock(state, id)? {
        return Ok(ProfilingStatus { level: level as i64, slow_ms: slow_ms as i64 });
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .run_command(doc! { "profile": level, "slowms": slow_ms })
        .await
        .map_err(|e| format!("set profiling level failed: {}", e))?;
    profiling_status_impl(state, id, database).await
}

pub async fn read_profile_impl(
    state: &AppState,
    id: &str,
    database: &str,
    limit: i64,
) -> Result<Vec<ProfileEntry>, String> {
    if connection_is_mock(state, id)? {
        return Ok(vec![ProfileEntry {
            op: "query".into(),
            ns: "sales_db.orders".into(),
            millis: 142,
            ts_ms: 1_749_427_200_000,
            plan_summary: "COLLSCAN".into(),
            command: "{ find: \"orders\", filter: { region: \"EU\" } }".into(),
        }]);
    }
    let client = require_real_client(state, id)?;
    let mut cursor = client
        .database(database)
        .collection::<Document>("system.profile")
        .find(doc! {})
        .sort(doc! { "ts": -1 })
        .limit(limit.clamp(1, 500))
        .await
        .map_err(|e| format!("read profile failed (is profiling enabled?): {}", e))?;
    let mut out = Vec::new();
    use futures::stream::StreamExt;
    while let Some(next) = cursor.next().await {
        match next {
            Ok(d) => out.push(curate_profile_entry(&d)),
            Err(e) => return Err(format!("read profile cursor error: {}", e)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, DateTime};

    #[test]
    fn curates_server_status_subset() {
        let raw = doc! {
            "host": "h:27017", "version": "7.0.0", "uptime": 3600.0,
            "connections": { "current": 5i32, "available": 100i64, "totalCreated": 42i32 },
            "opcounters": { "insert": 1i64, "query": 2i64, "update": 3i64, "delete": 4i64, "getmore": 5i64, "command": 6i64 },
            "mem": { "resident": 200i32, "virtual": 2000i32 },
            "network": { "bytesIn": 1000i64, "bytesOut": 2000i64, "numRequests": 30i64 },
            "wiredTiger": { "cache": { "bytes currently in the cache": 1024i64, "maximum bytes configured": 4096i64, "tracked dirty bytes in the cache": 128i64 } },
            "repl": { "setName": "rs0" },
        };
        let s = curate_server_status(&raw);
        assert_eq!(s.host, "h:27017");
        assert_eq!(s.version, "7.0.0");
        assert_eq!(s.uptime_seconds, 3600.0);
        assert_eq!(s.connections, Connections { current: 5, available: 100, total_created: 42 });
        assert_eq!(s.opcounters.query, 2);
        assert_eq!(s.memory, Memory { resident_mb: 200, virtual_mb: 2000 });
        assert_eq!(s.network.num_requests, 30);
        assert_eq!(s.cache, Some(CacheStats { bytes_in_cache: 1024, max_bytes: 4096, dirty_bytes: 128 }));
        assert_eq!(s.repl_set.as_deref(), Some("rs0"));
    }

    #[test]
    fn server_status_is_resilient_to_missing_sections() {
        let s = curate_server_status(&doc! { "host": "h" });
        assert_eq!(s.host, "h");
        assert_eq!(s.connections, Connections::default());
        assert!(s.cache.is_none());
        assert!(s.repl_set.is_none());
    }

    #[test]
    fn curates_current_op_keeps_full_command() {
        let long = "x".repeat(400);
        let d = doc! { "opid": 99i32, "op": "query", "ns": "db.c", "secs_running": 4i64, "client": "1.2.3.4", "desc": "conn1", "command": { "find": long.clone() } };
        let op = curate_current_op(&d);
        assert_eq!(op.opid, 99);
        assert_eq!(op.ns, "db.c");
        assert_eq!(op.secs_running, 4);
        assert!(op.command.contains(&long), "full command is preserved");
    }

    #[test]
    fn cap_current_ops_limits_count_and_command_length() {
        let big = "x".repeat(5000);
        let ops: Vec<CurrentOp> = (0..300)
            .map(|i| CurrentOp {
                opid: i,
                op: "query".into(),
                ns: "db.c".into(),
                secs_running: 0,
                client: String::new(),
                desc: String::new(),
                command: big.clone(),
            })
            .collect();
        let capped = cap_current_ops(ops);
        assert_eq!(capped.len(), 200, "op count is capped");
        assert_eq!(capped[0].command.chars().count(), 2001, "command truncated to MAX + ellipsis");
        assert!(capped[0].command.ends_with('…'));
    }

    #[test]
    fn cap_current_ops_leaves_short_commands_intact() {
        let ops = vec![CurrentOp {
            opid: 1,
            op: "query".into(),
            ns: "db.c".into(),
            secs_running: 0,
            client: String::new(),
            desc: String::new(),
            command: "{ find: \"c\" }".into(),
        }];
        let capped = cap_current_ops(ops);
        assert_eq!(capped[0].command, "{ find: \"c\" }");
    }

    #[test]
    fn curates_profile_entry_with_timestamp() {
        let d = doc! { "op": "query", "ns": "db.c", "millis": 142i64, "ts": DateTime::from_millis(1_700_000_000_000), "planSummary": "COLLSCAN", "command": { "find": "c" } };
        let p = curate_profile_entry(&d);
        assert_eq!(p.millis, 142);
        assert_eq!(p.ts_ms, 1_700_000_000_000);
        assert_eq!(p.plan_summary, "COLLSCAN");
    }
}
