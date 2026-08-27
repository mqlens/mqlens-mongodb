//! SQLite persistence for audit events (#272).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

pub const SCHEMA_VERSION: i32 = 1;

/// Op name of the record left behind when a damaged log is discarded.
///
/// These are the one kind of event that cannot be removed: retention skips them
/// and discarding preserves the existing ones, so a log that was discarded can
/// never be made to look like one that never was.
pub const TOMBSTONE_OP: &str = "audit_log_discarded";

/// One persisted audit row (matches `audit_events` table).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: String,
    pub ts: i64,
    pub connection_id: Option<String>,
    pub profile_name: Option<String>,
    pub database: Option<String>,
    pub collection: Option<String>,
    pub op: String,
    pub source: String,
    pub ok: bool,
    pub error: Option<String>,
    pub duration_ms: Option<i64>,
    pub summary: String,
    pub args_json: Option<String>,
    pub level_at_record: String,
    pub schema_version: i32,
}

/// Filter for listing audit events (all fields optional).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditFilter {
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub collection: Option<String>,
    pub op: Option<String>,
    pub source: Option<String>,
    pub ok: Option<bool>,
    pub ts_from: Option<i64>,
    pub ts_to: Option<i64>,
    pub summary_contains: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// Thread-safe SQLite-backed audit store.
pub struct AuditStore {
    conn: Mutex<Connection>,
}

impl AuditStore {
    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_path(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS audit_events (
                id TEXT PRIMARY KEY NOT NULL,
                ts INTEGER NOT NULL,
                connection_id TEXT,
                profile_name TEXT,
                database TEXT,
                collection TEXT,
                op TEXT NOT NULL,
                source TEXT NOT NULL,
                ok INTEGER NOT NULL,
                error TEXT,
                duration_ms INTEGER,
                summary TEXT NOT NULL,
                args_json TEXT,
                level_at_record TEXT NOT NULL,
                schema_version INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_connection_ts
                ON audit_events(connection_id, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_op_ts ON audit_events(op, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_ns_ts
                ON audit_events(database, collection, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_source_ts ON audit_events(source, ts DESC);
            "#,
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Insert an event, replacing any existing row with the same `id`.
    ///
    /// Replace rather than reject, for two reasons. A background task records a
    /// `running` event when it is queued and then supersedes it with its real
    /// outcome under the same id, so the listing shows one row per operation
    /// instead of two. And rebuilding the index by replaying the append-only log
    /// then converges on the latest state of each event rather than tripping over
    /// the superseded record.
    pub fn insert(&self, event: &AuditEvent) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT OR REPLACE INTO audit_events (
                id, ts, connection_id, profile_name, database, collection,
                op, source, ok, error, duration_ms, summary, args_json,
                level_at_record, schema_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            "#,
            params![
                event.id,
                event.ts,
                event.connection_id,
                event.profile_name,
                event.database,
                event.collection,
                event.op,
                event.source,
                if event.ok { 1 } else { 0 },
                event.error,
                event.duration_ms,
                event.summary,
                event.args_json,
                event.level_at_record,
                event.schema_version,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn query(&self, filter: &AuditFilter) -> Result<Vec<AuditEvent>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut sql = String::from(
            r#"
            SELECT id, ts, connection_id, profile_name, database, collection,
                   op, source, ok, error, duration_ms, summary, args_json,
                   level_at_record, schema_version
            FROM audit_events WHERE 1=1
            "#,
        );
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref v) = filter.connection_id {
            sql.push_str(" AND connection_id = ?");
            values.push(Box::new(v.clone()));
        }
        if let Some(ref v) = filter.database {
            sql.push_str(" AND database = ?");
            values.push(Box::new(v.clone()));
        }
        if let Some(ref v) = filter.collection {
            sql.push_str(" AND collection = ?");
            values.push(Box::new(v.clone()));
        }
        if let Some(ref v) = filter.op {
            sql.push_str(" AND op = ?");
            values.push(Box::new(v.clone()));
        }
        if let Some(ref v) = filter.source {
            sql.push_str(" AND source = ?");
            values.push(Box::new(v.clone()));
        }
        if let Some(ok) = filter.ok {
            sql.push_str(" AND ok = ?");
            values.push(Box::new(if ok { 1 } else { 0 }));
        }
        if let Some(from) = filter.ts_from {
            sql.push_str(" AND ts >= ?");
            values.push(Box::new(from));
        }
        if let Some(to) = filter.ts_to {
            sql.push_str(" AND ts <= ?");
            values.push(Box::new(to));
        }
        if let Some(ref needle) = filter.summary_contains {
            sql.push_str(" AND summary LIKE ?");
            values.push(Box::new(format!("%{needle}%")));
        }

        sql.push_str(" ORDER BY ts DESC");

        if let Some(limit) = filter.limit {
            sql.push_str(" LIMIT ?");
            values.push(Box::new(limit));
        }
        if let Some(offset) = filter.offset {
            sql.push_str(" OFFSET ?");
            values.push(Box::new(offset));
        }

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            values.iter().map(|v| v.as_ref()).collect();
        let rows = stmt
            .query_map(params_ref.as_slice(), |row| {
                Ok(AuditEvent {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    connection_id: row.get(2)?,
                    profile_name: row.get(3)?,
                    database: row.get(4)?,
                    collection: row.get(5)?,
                    op: row.get(6)?,
                    source: row.get(7)?,
                    ok: row.get::<_, i64>(8)? != 0,
                    error: row.get(9)?,
                    duration_ms: row.get(10)?,
                    summary: row.get(11)?,
                    args_json: row.get(12)?,
                    level_at_record: row.get(13)?,
                    schema_version: row.get(14)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Apply retention. Tombstones are exempt: letting them expire would put a
    /// deadline on the record that a log was once discarded.
    pub fn prune_before(&self, ts_ms: i64) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "DELETE FROM audit_events WHERE ts < ?1 AND op != ?2",
                params![ts_ms, TOMBSTONE_OP],
            )
            .map_err(|e| e.to_string())?;
        Ok(n as u64)
    }

    /// Delete every event except tombstones, returning how many were removed.
    ///
    /// Used when discarding a damaged log: the events are unverifiable and go,
    /// but the record of previous discards stays so the history of erasures
    /// accumulates rather than being overwritten.
    pub fn retain_tombstones_only(&self) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute("DELETE FROM audit_events WHERE op != ?1", params![TOMBSTONE_OP])
            .map_err(|e| e.to_string())?;
        Ok(n as u64)
    }

    /// Every event in write order, for rebuilding the append-only log on
    /// compaction. Deliberately not `query`, whose `ORDER BY ts DESC` would
    /// reverse the log and make its hash chain disagree with write order.
    pub fn all_chronological(&self) -> Result<Vec<AuditEvent>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, ts, connection_id, profile_name, database, collection,
                       op, source, ok, error, duration_ms, summary, args_json,
                       level_at_record, schema_version
                FROM audit_events ORDER BY ts ASC, rowid ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AuditEvent {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    connection_id: row.get(2)?,
                    profile_name: row.get(3)?,
                    database: row.get(4)?,
                    collection: row.get(5)?,
                    op: row.get(6)?,
                    source: row.get(7)?,
                    ok: row.get::<_, i64>(8)? != 0,
                    error: row.get(9)?,
                    duration_ms: row.get(10)?,
                    summary: row.get(11)?,
                    args_json: row.get(12)?,
                    level_at_record: row.get(13)?,
                    schema_version: row.get(14)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event(id: &str, ts: i64, op: &str) -> AuditEvent {
        AuditEvent {
            id: id.to_string(),
            ts,
            connection_id: Some("conn-1".into()),
            profile_name: Some("prod".into()),
            database: Some("shop".into()),
            collection: Some("orders".into()),
            op: op.to_string(),
            source: "ui".into(),
            ok: true,
            error: None,
            duration_ms: Some(12),
            summary: format!("{op} shop.orders"),
            args_json: Some(r#"{"filter":{}}"#.into()),
            level_at_record: "A".into(),
            schema_version: SCHEMA_VERSION,
        }
    }

    #[test]
    fn insert_and_query_by_op_returns_event() {
        let store = AuditStore::open_memory().expect("open");
        store
            .insert(&sample_event("e1", 1_000, "dropCollection"))
            .expect("insert");
        let rows = store
            .query(&AuditFilter {
                op: Some("dropCollection".into()),
                ..Default::default()
            })
            .expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "e1");
        assert_eq!(rows[0].op, "dropCollection");
        assert_eq!(rows[0].schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn all_chronological_returns_write_order_not_query_order() {
        let store = AuditStore::open_memory().expect("open");
        store.insert(&sample_event("old", 1_000, "insert")).expect("insert old");
        store.insert(&sample_event("new", 5_000, "deleteMany")).expect("insert new");

        let listed = store.query(&AuditFilter::default()).expect("query");
        assert_eq!(listed[0].id, "new", "listing stays newest-first");

        let chronological = store.all_chronological().expect("chronological");
        assert_eq!(
            chronological.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["old", "new"]
        );
    }

    #[test]
    fn prune_before_deletes_old_keeps_recent() {
        let store = AuditStore::open_memory().expect("open");
        store
            .insert(&sample_event("old", 1_000, "deleteMany"))
            .expect("insert old");
        store
            .insert(&sample_event("new", 5_000, "deleteMany"))
            .expect("insert new");
        let removed = store.prune_before(3_000).expect("prune");
        assert_eq!(removed, 1);
        let rows = store.query(&AuditFilter::default()).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "new");
    }
}
