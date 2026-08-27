//! Soft-fail audit recording from DB / mongosh `_impl`s (#272).

use super::classify::classify_op;
use super::level::{should_record, OpClass};
use super::redact::{redact_error, redact_text, truncate_args, MAX_ARGS_BYTES};
use super::store::{AuditEvent, SCHEMA_VERSION};
use super::envelope::{AuditPolicy, AuditSession};
use crate::state::{AppState, LockExt};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Shared handle to the audit session slot in `AppState`.
pub type SessionSlot = Arc<Mutex<Option<AuditSession>>>;

/// Terminal task events waiting for the audit session to reopen.
pub type PendingSlot = Arc<Mutex<Vec<AuditEvent>>>;

/// Cap the parked queue so a long-locked vault cannot grow it without bound.
/// Far above any plausible number of background tasks in one lock window.
const MAX_PENDING_EVENTS: usize = 1024;

tokio::task_local! {
    /// Invoking surface for audit attribution, scoped around one tool call.
    static AUDIT_SOURCE: &'static str;
}

/// Run `fut` with the audit source pinned to `source` (e.g. `"mcp"`).
///
/// The MCP tools share the same `_impl`s as the UI, and a connection's
/// `via_mcp` flag records who *opened* it, not who is calling now —
/// `require_mcp_connection` deliberately accepts any live opted-in connection.
/// Without this scope an agent's reads and destructive writes on a UI-opened
/// connection were attributed to the human UI.
pub async fn with_source<F>(source: &'static str, fut: F) -> F::Output
where
    F: std::future::Future,
{
    AUDIT_SOURCE.scope(source, fut).await
}

/// The source pinned by an enclosing [`with_source`] scope, if any.
fn scoped_source() -> Option<&'static str> {
    AUDIT_SOURCE.try_with(|s| *s).ok()
}

/// Inputs for a single audit attempt. Never causes the Mongo op to fail.
pub struct RecordInput<'a> {
    /// Reuse an existing event id to *supersede* that event instead of adding a
    /// row. Used by background tasks to replace their `running` event with the
    /// real outcome. `None` mints a fresh id.
    pub event_id: Option<&'a str>,
    /// Pin the event's timestamp. A superseding record keeps the original time
    /// so the row does not jump around the listing when a long task finishes.
    pub ts: Option<i64>,
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
    let (profile_name, inferred_source) = profile_and_source(state, input.connection_id);
    // Explicit override wins, then the invoking surface pinned by the caller's
    // `with_source` scope, and only then the connection's provenance.
    let source = input
        .source
        .map(|s| s.to_string())
        .or_else(|| scoped_source().map(|s| s.to_string()))
        .unwrap_or(inferred_source);
    record_into(&state.audit, profile_name, source, input)
}

/// Build and insert the event against an already-resolved profile and source.
///
/// Split out of [`maybe_record_inner`] so [`TaskAuditContext`] can record from a
/// spawned task that no longer has an `&AppState` to resolve them from.
fn record_into(
    slot: &SessionSlot,
    profile_name: Option<String>,
    source: String,
    input: RecordInput<'_>,
) -> Result<(), String> {
    let guard = slot.lock().map_err(|e| e.to_string())?;
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

    let event = build_event(&input, profile_name, source, policy);

    let _ = session.try_insert(&event)?;
    let cutoff = super::retention_cutoff_ms(policy.retention_days, now_ms());
    let _ = session.prune_before(cutoff);
    Ok(())
}

/// Assemble the stored row, applying the payload gate to both args and errors.
fn build_event(
    input: &RecordInput<'_>,
    profile_name: Option<String>,
    source: String,
    policy: AuditPolicy,
) -> AuditEvent {
    let args_json = if policy.include_payloads {
        input.args.map(|raw| {
            let redacted = redact_text(raw);
            truncate_args(&redacted, MAX_ARGS_BYTES)
        })
    } else {
        None
    };

    AuditEvent {
        id: input
            .event_id
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        ts: input.ts.unwrap_or_else(now_ms),
        connection_id: input.connection_id.map(|s| s.to_string()),
        profile_name,
        database: input.database.map(|s| s.to_string()),
        collection: input.collection.map(|s| s.to_string()),
        op: input.op.to_string(),
        source,
        ok: input.ok,
        // Errors carry payload values of their own (dup-key / validation
        // errors embed rejected documents), so they are sanitized against the
        // same payload gate as `args_json` rather than stored verbatim.
        error: input
            .error
            .map(|s| redact_error(s, policy.include_payloads)),
        duration_ms: input.duration_ms,
        summary: input.summary.to_string(),
        args_json,
        level_at_record: policy.level.as_str().to_string(),
        schema_version: SCHEMA_VERSION,
    }
}

/// Record a background task's start only when no background task will record it.
///
/// A queued task writes its own `running` event and later supersedes it with the
/// terminal outcome, so recording queue acceptance here as well would put two
/// rows in the listing for every import, copy, generate and restore. Two cases
/// still have to be recorded at this level, because nothing runs in the
/// background to do it:
///
/// - a **rejected** start (read-only connection, invalid mode) — exactly the
///   blocked destructive attempt an audit log needs;
/// - a task that **completed inline**, as mock/demo connections do.
#[allow(clippy::too_many_arguments)]
pub fn maybe_record_task_start(
    state: &AppState,
    connection_id: Option<&str>,
    database: Option<&str>,
    collection: Option<&str>,
    op: &str,
    started: Instant,
    summary: &str,
    args: Option<&str>,
    result: &Result<crate::TaskInfo, String>,
) {
    let (outcome, ok, error) = match result {
        Err(e) => ("rejected", false, Some(e.clone())),
        // Still running: the spawned task owns this event from here on.
        Ok(task) if task.status == "running" => return,
        Ok(task) => (
            task.status.as_str(),
            task.status == "completed",
            task.error.clone(),
        ),
    };
    maybe_record(
        state,
        RecordInput {
            event_id: None,
            ts: None,
            connection_id,
            database,
            collection,
            op,
            class: Some(OpClass::Write),
            source: None,
            ok,
            error: error.as_deref(),
            duration_ms: Some(started.elapsed().as_millis() as i64),
            summary: &format!("{summary} ({outcome})"),
            args,
        },
    );
}

/// Apply the policy's retention window immediately.
fn prune_now(session: &AuditSession, policy: AuditPolicy) {
    let cutoff = super::retention_cutoff_ms(policy.retention_days, now_ms());
    let _ = session.prune_before(cutoff);
}

/// Hold a terminal event until the audit session reopens.
fn park_pending(pending: &PendingSlot, event: AuditEvent, outcome: &str) {
    let Ok(mut queue) = pending.lock() else {
        return;
    };
    // Same id supersedes, so replacing a parked event is correct rather than
    // additive if a task somehow reports twice.
    if let Some(existing) = queue.iter_mut().find(|e| e.id == event.id) {
        *existing = event;
        return;
    }
    if queue.len() >= MAX_PENDING_EVENTS {
        eprintln!("audit: dropping parked {outcome} event, queue is full");
        return;
    }
    queue.push(event);
}

/// Write every parked terminal event into a freshly opened session.
///
/// Returns how many were written. Events that cannot be written stay parked.
pub fn flush_pending(slot: &SessionSlot, pending: &PendingSlot) -> usize {
    let Ok(mut queue) = pending.lock() else {
        return 0;
    };
    if queue.is_empty() {
        return 0;
    }
    let Ok(guard) = slot.lock() else {
        return 0;
    };
    let Some(session) = guard.as_ref() else {
        return 0;
    };
    let policy = session.policy();
    let mut written = 0;
    queue.retain(|event| match session.try_insert(event) {
        Ok(true) => {
            // Same reason as `TaskAuditContext::write`: these inserts skip
            // `record_into`, and a parked event's timestamp can already be past
            // the retention cutoff by the time the vault reopens.
            prune_now(session, policy);
            written += 1;
            false
        }
        Ok(false) => true,
        Err(e) => {
            eprintln!("audit: could not flush parked event {}: {e}", event.id);
            true
        }
    });
    written
}

/// Audit context captured when a background task is queued, so the task can
/// record its own terminal outcome after the queuing command has returned.
///
/// Queue acceptance and the task's real result are separate facts: recording only
/// the former logged `ok: true` for imports/copies/restores that later failed,
/// were cancelled, or wrote only partially.
#[derive(Clone)]
pub struct TaskAuditContext {
    slot: SessionSlot,
    /// Where a terminal event goes if the vault locked before the task finished.
    pending: PendingSlot,
    /// Vault generation this task belongs to, and the live counter to compare
    /// against. A reset bumps the counter, which invalidates this context.
    generation: u64,
    generation_now: Arc<std::sync::atomic::AtomicU64>,
    /// Policy in force when the task was queued. `None` means the `running`
    /// event was never recorded (auditing off, or the level excluded it), and
    /// the terminal event is skipped for the same reason.
    policy: Option<AuditPolicy>,
    /// Stable across the `running` record and the terminal one, so the second
    /// replaces the first instead of adding a row.
    event_id: String,
    /// Time the task was queued; kept on the terminal record too.
    ts: i64,
    connection_id: Option<String>,
    profile_name: Option<String>,
    database: Option<String>,
    collection: Option<String>,
    op: String,
    source: String,
    summary: String,
}

impl TaskAuditContext {
    /// Capture the context and record the task as `running`.
    ///
    /// Recording immediately matters: if the app dies mid-import the log still
    /// shows the operation was started, which a terminal-only event would miss.
    pub fn capture(
        state: &AppState,
        connection_id: Option<&str>,
        database: Option<&str>,
        collection: Option<&str>,
        op: &str,
        summary: &str,
    ) -> Self {
        let (profile_name, inferred_source) = profile_and_source(state, connection_id);
        let source = scoped_source()
            .map(|s| s.to_string())
            .unwrap_or(inferred_source);
        let policy = state
            .audit
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.policy()))
            .filter(|p| p.enabled && should_record(p.level, OpClass::Write));
        let ctx = Self {
            slot: Arc::clone(&state.audit),
            pending: Arc::clone(&state.audit_pending),
            generation: state
                .audit_generation
                .load(std::sync::atomic::Ordering::Acquire),
            generation_now: Arc::clone(&state.audit_generation),
            policy,
            event_id: Uuid::new_v4().to_string(),
            ts: now_ms(),
            connection_id: connection_id.map(|s| s.to_string()),
            profile_name,
            database: database.map(|s| s.to_string()),
            collection: collection.map(|s| s.to_string()),
            op: op.to_string(),
            source,
            summary: summary.to_string(),
        };
        ctx.write("running", true, None, None);
        ctx
    }

    /// Record the task's terminal state, replacing its `running` event.
    /// `outcome` is `completed`, `failed` or `cancelled`.
    pub fn record_terminal(&self, outcome: &str, error: Option<&str>, duration_ms: Option<i64>) {
        self.write(outcome, outcome == "completed", error, duration_ms);
    }

    fn write(&self, outcome: &str, ok: bool, error: Option<&str>, duration_ms: Option<i64>) {
        // Nothing recorded the `running` event, so there is no row to supersede.
        let Some(policy) = self.policy else {
            return;
        };
        // The vault this task belonged to was reset; its history is gone and this
        // event must not land in the replacement vault's log.
        if self
            .generation_now
            .load(std::sync::atomic::Ordering::Acquire)
            != self.generation
        {
            return;
        }
        let summary = format!("{} ({outcome})", self.summary);
        let input = RecordInput {
            event_id: Some(&self.event_id),
            ts: Some(self.ts),
            connection_id: self.connection_id.as_deref(),
            database: self.database.as_deref(),
            collection: self.collection.as_deref(),
            op: &self.op,
            class: Some(OpClass::Write),
            source: None,
            ok,
            error,
            duration_ms,
            summary: &summary,
            args: None,
        };
        let event = build_event(
            &input,
            self.profile_name.clone(),
            self.source.clone(),
            policy,
        );

        // `vault_lock` does not cancel background tasks, so a task can finish
        // while the session is closed. Dropping the event here would leave the
        // durable log claiming the operation is still running forever, so park
        // it and let the next unlock write it.
        let inserted = match self.slot.lock() {
            Ok(guard) => match guard.as_ref() {
                Some(session) => match session.try_insert(&event) {
                    Ok(done) => {
                        // This path bypasses `record_into`, so retention has to be
                        // applied here too: a task queued before the cutoff — or
                        // parked through a long lock — keeps its original
                        // timestamp and would otherwise sit past its window until
                        // some unrelated operation pruned it.
                        prune_now(session, policy);
                        done
                    }
                    Err(e) => {
                        eprintln!("audit task record ({outcome}): {e}");
                        false
                    }
                },
                None => false,
            },
            Err(e) => {
                eprintln!("audit task record ({outcome}): {e}");
                false
            }
        };
        if !inserted {
            park_pending(&self.pending, event, outcome);
        }
    }
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
            event_id: None,
            ts: None,
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

/// Record a background task's *rejected* start, and nothing on success.
///
/// A queued task records its own `running` event and then its terminal outcome
/// under the same id, so also recording queue acceptance here would put two rows
/// in the listing for every import, copy, generate and restore. A rejection —
/// a read-only connection, an invalid mode — never reaches the task, so it has
/// to be recorded at this level or it is lost.
#[allow(clippy::too_many_arguments)]
pub fn maybe_record_rejection<T, E: std::fmt::Display>(
    state: &AppState,
    connection_id: Option<&str>,
    database: Option<&str>,
    collection: Option<&str>,
    op: &str,
    started: Instant,
    summary: &str,
    args: Option<&str>,
    result: &Result<T, E>,
) {
    let Err(err) = result else {
        return;
    };
    let err = err.to_string();
    maybe_record(
        state,
        RecordInput {
            event_id: None,
            ts: None,
            connection_id,
            database,
            collection,
            op,
            class: Some(OpClass::Write),
            source: None,
            ok: false,
            error: Some(&err),
            duration_ms: Some(started.elapsed().as_millis() as i64),
            summary: &format!("{summary} (rejected)"),
            args,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::envelope::AuditPolicy;
    use crate::audit::level::AuditLevel;
    use crate::audit::store::AuditFilter;

    fn state_with_open_session(dir: &std::path::Path) -> AppState {
        let state = AppState::new();
        let session = AuditSession::new(dir.join("audit.log.enc"));
        session.open([5u8; 32]).expect("open session");
        session.set_policy(AuditPolicy {
            enabled: true,
            level: AuditLevel::C,
            include_payloads: false,
            retention_days: 30,
        });
        *state.audit.lock().unwrap() = Some(session);
        state
    }

    fn drop_input<'a>(source: Option<&'a str>) -> RecordInput<'a> {
        RecordInput {
            event_id: None,
            ts: None,
            connection_id: Some("c1"),
            database: Some("shop"),
            collection: Some("orders"),
            op: "drop_collection",
            class: None,
            source,
            ok: true,
            error: None,
            duration_ms: None,
            summary: "dropCollection shop.orders",
            args: None,
        }
    }

    fn only_source(state: &AppState) -> String {
        let guard = state.audit.lock().unwrap();
        let rows = guard
            .as_ref()
            .unwrap()
            .query(&AuditFilter::default())
            .expect("query");
        assert_eq!(rows.len(), 1, "expected exactly one recorded event");
        rows[0].source.clone()
    }

    #[tokio::test]
    async fn scoped_source_overrides_connection_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        // No `connection_meta` entry, so provenance inference would say "ui".
        with_source("mcp", async {
            maybe_record(&state, drop_input(None));
        })
        .await;
        assert_eq!(only_source(&state), "mcp");
    }

    #[tokio::test]
    async fn explicit_source_wins_over_scope() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        with_source("mcp", async {
            maybe_record(&state, drop_input(Some("shell")));
        })
        .await;
        assert_eq!(only_source(&state), "shell");
    }

    #[tokio::test]
    async fn without_a_scope_source_falls_back_to_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        maybe_record(&state, drop_input(None));
        assert_eq!(only_source(&state), "ui");
    }

    #[tokio::test]
    async fn task_context_captures_the_scoped_source_and_records_terminal_state() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        let ctx = with_source("mcp", async {
            TaskAuditContext::capture(
                &state,
                Some("c1"),
                Some("shop"),
                Some("orders"),
                "start_import_task",
                "import shop.orders (json, skip)",
            )
        })
        .await;
        ctx.record_terminal("failed", Some("boom"), Some(7));

        let guard = state.audit.lock().unwrap();
        let rows = guard
            .as_ref()
            .unwrap()
            .query(&AuditFilter::default())
            .expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "mcp");
        assert!(!rows[0].ok, "a failed task must not be recorded as ok");
        assert!(rows[0].summary.ends_with("(failed)"), "{}", rows[0].summary);
        assert_eq!(rows[0].error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn a_task_produces_exactly_one_row_not_two() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        let ctx = TaskAuditContext::capture(
            &state,
            Some("c1"),
            Some("shop"),
            Some("orders"),
            "start_collection_copy",
            "copy shop.orders → shop.orders_copy",
        );
        // Queued: visible immediately, so a mid-task crash still leaves a trace.
        {
            let guard = state.audit.lock().unwrap();
            let rows = guard
                .as_ref()
                .unwrap()
                .query(&AuditFilter::default())
                .expect("query");
            assert_eq!(rows.len(), 1);
            assert!(rows[0].summary.ends_with("(running)"), "{}", rows[0].summary);
        }

        ctx.record_terminal("completed", None, Some(50));

        let guard = state.audit.lock().unwrap();
        let rows = guard
            .as_ref()
            .unwrap()
            .query(&AuditFilter::default())
            .expect("query");
        assert_eq!(
            rows.len(),
            1,
            "the terminal record must supersede the running one, not add a row"
        );
        assert!(rows[0].summary.ends_with("(completed)"), "{}", rows[0].summary);
        assert_eq!(rows[0].duration_ms, Some(50));
    }

    #[tokio::test]
    async fn a_superseding_record_keeps_the_original_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        let ctx = TaskAuditContext::capture(
            &state,
            Some("c1"),
            Some("shop"),
            None,
            "start_database_copy",
            "copy database a → shop",
        );
        let queued_ts = {
            let guard = state.audit.lock().unwrap();
            guard.as_ref().unwrap().query(&AuditFilter::default()).unwrap()[0].ts
        };
        ctx.record_terminal("failed", Some("boom"), Some(9));

        let guard = state.audit.lock().unwrap();
        let rows = guard.as_ref().unwrap().query(&AuditFilter::default()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].ts, queued_ts,
            "a long task finishing must not reorder its row in the listing"
        );
        assert!(!rows[0].ok);
    }

    fn task(status: &str, error: Option<&str>) -> crate::TaskInfo {
        crate::TaskInfo {
            id: "t1".into(),
            kind: "import".into(),
            label: "Import".into(),
            status: status.into(),
            processed: 0,
            total: None,
            message: String::new(),
            path: None,
            error: error.map(|e| e.to_string()),
            created_at_ms: 0,
            finished_at_ms: None,
            sub_label: None,
            items_processed: None,
            items_total: None,
            summary: None,
        }
    }

    fn rows(state: &AppState) -> Vec<AuditEvent> {
        let guard = state.audit.lock().unwrap();
        guard
            .as_ref()
            .unwrap()
            .query(&AuditFilter::default())
            .expect("query")
    }

    fn record_start(state: &AppState, result: &Result<crate::TaskInfo, String>) {
        maybe_record_task_start(
            state,
            Some("c1"),
            Some("shop"),
            Some("orders"),
            "start_import_task",
            Instant::now(),
            "import shop.orders (json, skip)",
            None,
            result,
        );
    }

    #[tokio::test]
    async fn a_queued_task_start_is_left_for_the_task_itself_to_record() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        record_start(&state, &Ok(task("running", None)));
        assert!(
            rows(&state).is_empty(),
            "queue acceptance must not be recorded — it would double-log every task"
        );
    }

    #[tokio::test]
    async fn a_rejected_start_is_recorded_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        record_start(&state, &Err("connection is read-only".into()));
        let rows = rows(&state);
        assert_eq!(rows.len(), 1, "a blocked destructive attempt must be logged");
        assert!(!rows[0].ok);
        assert!(rows[0].summary.ends_with("(rejected)"), "{}", rows[0].summary);
        assert_eq!(rows[0].error.as_deref(), Some("connection is read-only"));
    }

    #[tokio::test]
    async fn a_task_that_finished_inline_is_recorded_here() {
        // Mock/demo connections complete without spawning anything, so nothing
        // else would ever record them.
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        record_start(&state, &Ok(task("completed", None)));
        let rows = rows(&state);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].ok);
        assert!(rows[0].summary.ends_with("(completed)"), "{}", rows[0].summary);
    }

    #[tokio::test]
    async fn a_task_finishing_while_the_vault_is_locked_is_written_on_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        let ctx = TaskAuditContext::capture(
            &state,
            Some("c1"),
            Some("shop"),
            Some("orders"),
            "start_import_task",
            "import shop.orders (json, skip)",
        );

        // The user locks the vault; `vault_lock` does not cancel the task.
        let session = state.audit.lock().unwrap().take().unwrap();
        session.close().expect("close");

        ctx.record_terminal("failed", Some("boom"), Some(11));
        assert_eq!(
            state.audit_pending.lock().unwrap().len(),
            1,
            "the outcome must be parked, not dropped"
        );

        // Unlock: the same session file, reopened.
        session.open([5u8; 32]).expect("reopen");
        *state.audit.lock().unwrap() = Some(session);
        assert_eq!(flush_pending(&state.audit, &state.audit_pending), 1);
        assert!(state.audit_pending.lock().unwrap().is_empty());

        let rows = rows(&state);
        assert_eq!(rows.len(), 1, "still one row, not a duplicate");
        assert!(!rows[0].ok, "the failure must not stay recorded as running");
        assert!(rows[0].summary.ends_with("(failed)"), "{}", rows[0].summary);
        assert_eq!(rows[0].error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn a_task_whose_level_excluded_it_records_nothing_at_either_end() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        let session = AuditSession::new(dir.path().join("audit.log.enc"));
        session.open([5u8; 32]).expect("open");
        session.set_policy(AuditPolicy {
            enabled: false,
            level: AuditLevel::C,
            include_payloads: false,
            retention_days: 30,
        });
        *state.audit.lock().unwrap() = Some(session);

        let ctx = TaskAuditContext::capture(
            &state,
            Some("c1"),
            Some("shop"),
            None,
            "start_database_copy",
            "copy database a → shop",
        );
        ctx.record_terminal("completed", None, Some(5));

        assert!(rows(&state).is_empty(), "auditing is disabled");
        assert!(
            state.audit_pending.lock().unwrap().is_empty(),
            "a skipped event must not be parked either"
        );
    }

    #[tokio::test]
    async fn a_reset_vault_discards_a_parked_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        let ctx = TaskAuditContext::capture(
            &state,
            Some("c1"),
            Some("shop"),
            Some("orders"),
            "start_import_task",
            "import shop.orders (json, skip)",
        );

        // The vault is reset while the task is still running: its history is gone.
        let session = state.audit.lock().unwrap().take().unwrap();
        session.close().expect("close");
        state.audit_pending.lock().unwrap().clear();
        state
            .audit_generation
            .fetch_add(1, std::sync::atomic::Ordering::Release);

        ctx.record_terminal("completed", None, Some(5));
        assert!(
            state.audit_pending.lock().unwrap().is_empty(),
            "an outcome from the reset vault must not be parked for the next one"
        );
    }

    #[tokio::test]
    async fn completed_task_is_recorded_as_ok() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open_session(dir.path());
        let ctx = TaskAuditContext::capture(
            &state,
            Some("c1"),
            Some("shop"),
            None,
            "start_database_copy",
            "copy database a → shop",
        );
        ctx.record_terminal("completed", None, Some(12));

        let guard = state.audit.lock().unwrap();
        let rows = guard
            .as_ref()
            .unwrap()
            .query(&AuditFilter::default())
            .expect("query");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].ok);
        assert!(rows[0].summary.ends_with("(completed)"), "{}", rows[0].summary);
    }
}
