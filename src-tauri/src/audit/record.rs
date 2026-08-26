//! Soft-fail audit recording from DB / mongosh `_impl`s (#272).

use super::classify::classify_op;
use super::level::{should_record, OpClass};
use super::redact::{redact_text, truncate_args, MAX_ARGS_BYTES};
use super::store::{AuditEvent, SCHEMA_VERSION};
use crate::state::{AppState, LockExt};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Inputs for a single audit attempt. Never causes the Mongo op to fail.
pub struct RecordInput<'a> {
    pub connection_id: Option<&'a str>,
    pub database: Option<&'a str>,
    pub collection: Option<&'a str>,
    /// Logical op / command name (e.g. `delete_many`, `mongosh`).
    pub op: &'a str,
    /// Override class; when `None`, derived via [`classify_op`].
    pub class: Option<OpClass>,
    /// `ui` | `mcp` | `shell` | `tools` — when `None`, inferred from connection meta.
    pub source: Option<&'a str>,
    pub ok: bool,
    pub error: Option<&'a str>,
    pub duration_ms: Option<i64>,
    pub summary: &'a str,
    pub args: Option<&'a str>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn profile_and_source(state: &AppState, connection_id: Option<&str>) -> (Option<String>, String) {
    let Some(id) = connection_id else {
        return (None, "ui".into());
    };
    if let Ok(meta) = state.connection_meta.lock_safe() {
        if let Some(m) = meta.get(id) {
            let source = if m.via_mcp { "mcp" } else { "ui" };
            return (Some(m.name.clone()), source.into());
        }
    }
    (None, "ui".into())
}

/// Record an audit event if enabled, level matches, and vault session is open.
/// Swallows all errors — never fails the caller.
pub fn maybe_record(state: &AppState, input: RecordInput<'_>) {
    if let Err(e) = maybe_record_inner(state, input) {
        eprintln!("audit maybe_record: {e}");
    }
}

fn maybe_record_inner(state: &AppState, input: RecordInput<'_>) -> Result<(), String> {
    let guard = state.audit.lock_safe()?;
    let Some(session) = guard.as_ref() else {
        return Ok(());
    };
    let policy = session.policy();
    if !policy.enabled {
        return Ok(());
    }
    let class = input.class.unwrap_or_else(|| classify_op(input.op));
    if !should_record(policy.level, class) {
        return Ok(());
    }

    let (profile_name, inferred_source) = profile_and_source(state, input.connection_id);
    let source = input
        .source
        .unwrap_or(inferred_source.as_str())
        .to_string();

    let args_json = input.args.map(|raw| {
        let redacted = redact_text(raw);
        let cap = if policy.include_payloads {
            MAX_ARGS_BYTES
        } else {
            2_048
        };
        truncate_args(&redacted, cap)
    });

    let event = AuditEvent {
        id: Uuid::new_v4().to_string(),
        ts: now_ms(),
        connection_id: input.connection_id.map(|s| s.to_string()),
        profile_name,
        database: input.database.map(|s| s.to_string()),
        collection: input.collection.map(|s| s.to_string()),
        op: input.op.to_string(),
        source,
        ok: input.ok,
        error: input.error.map(|s| s.to_string()),
        duration_ms: input.duration_ms,
        summary: input.summary.to_string(),
        args_json: args_json,
        level_at_record: policy.level.as_str().to_string(),
        schema_version: SCHEMA_VERSION,
    };

    let _ = session.try_insert(&event)?;
    Ok(())
}

/// Record from a `Result`, capturing ok/error and elapsed time.
pub fn maybe_record_result<T, E: std::fmt::Display>(
    state: &AppState,
    connection_id: Option<&str>,
    database: Option<&str>,
    collection: Option<&str>,
    op: &str,
    class: OpClass,
    source: Option<&str>,
    started: Instant,
    summary: &str,
    args: Option<&str>,
    result: &Result<T, E>,
) {
    let err_owned = result.as_ref().err().map(|e| e.to_string());
    maybe_record(
        state,
        RecordInput {
            connection_id,
            database,
            collection,
            op,
            class: Some(class),
            source,
            ok: result.is_ok(),
            error: err_owned.as_deref(),
            duration_ms: Some(started.elapsed().as_millis() as i64),
            summary,
            args,
        },
    );
}
