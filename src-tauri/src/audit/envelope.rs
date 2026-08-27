//! Vault-backed audit session: policy, the durable log, and the query index (#272).
//!
//! Encryption itself lives in [`super::log`], which encrypts each record
//! individually. This module owns the session lifecycle around it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use super::level::AuditLevel;
use super::log::{AuditLog, LoadReport, RetainedLock};
use super::store::{AuditEvent, AuditFilter, AuditStore, SCHEMA_VERSION, TOMBSTONE_OP};

/// Cached audit settings for the open vault session (refreshed on unlock / save).
#[derive(Clone, Copy, Debug)]
pub struct AuditPolicy {
    pub enabled: bool,
    pub level: AuditLevel,
    pub include_payloads: bool,
    pub retention_days: u32,
}

impl Default for AuditPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            level: AuditLevel::A,
            include_payloads: false,
            retention_days: 30,
        }
    }
}

/// Build the record left behind when a damaged log is discarded.
///
/// Everything that matters goes in `summary` and `error`, which are stored at
/// every level and under any payload setting — unlike `args_json`, which the
/// payload gate can drop.
fn tombstone(
    discarded: u64,
    verified_count: u64,
    verified_head: Option<&str>,
    reason: &str,
) -> AuditEvent {
    let head = verified_head
        .map(|h| &h[..h.len().min(16)])
        .unwrap_or("unknown");
    AuditEvent {
        id: uuid::Uuid::new_v4().to_string(),
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        connection_id: None,
        profile_name: None,
        database: None,
        collection: None,
        op: TOMBSTONE_OP.to_string(),
        source: "ui".into(),
        ok: false,
        error: Some(reason.to_string()),
        duration_ms: None,
        summary: format!(
            "damaged activity log discarded — {discarded} readable event(s) removed, \
             the rest unverifiable; verified {verified_count} record(s) up to chain {head}"
        ),
        args_json: None,
        level_at_record: "-".into(),
        schema_version: SCHEMA_VERSION,
    }
}

/// Open audit session while the vault is unlocked.
///
/// Holds two things: the append-only encrypted log, which is the durable source
/// of truth, and an in-memory SQLite index rebuilt from it for querying. Every
/// recorded event is appended and fsynced immediately — there is no snapshot to
/// batch and no window in which a crash loses recent events.
pub struct AuditSession {
    log: AuditLog,
    store: Mutex<Option<AuditStore>>,
    key: Mutex<Option<[u8; 32]>>,
    dropped: AtomicU64,
    policy: Mutex<AuditPolicy>,
    /// Set when the log failed verification on load: the file is preserved and
    /// appends refused, so the UI must say auditing has stopped.
    integrity_error: Mutex<Option<String>>,
}

impl AuditSession {
    pub fn new(log_path: PathBuf) -> Self {
        Self {
            log: AuditLog::new(log_path),
            store: Mutex::new(None),
            key: Mutex::new(None),
            dropped: AtomicU64::new(0),
            policy: Mutex::new(AuditPolicy::default()),
            integrity_error: Mutex::new(None),
        }
    }

    pub fn policy(&self) -> AuditPolicy {
        self.policy.lock().map(|g| *g).unwrap_or_default()
    }

    pub fn set_policy(&self, policy: AuditPolicy) {
        if let Ok(mut g) = self.policy.lock() {
            *g = policy;
        }
    }

    pub fn log_path(&self) -> &Path {
        self.log.path()
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Why the log stopped accepting events, if it has.
    ///
    /// Falls through to the log's own seal so a seal created *after* load — a
    /// compaction that replaced the file but could not update its counter —
    /// cannot leave status reporting healthy while every append is refused.
    pub fn integrity_error(&self) -> Option<String> {
        self.integrity_error
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .or_else(|| self.log.sealed_reason())
    }

    pub fn is_open(&self) -> bool {
        self.store.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Recover the log and rebuild the query index from it.
    pub fn open(&self, key: [u8; 32]) -> Result<LoadReport, String> {
        let (events, report) = self.log.open(&key)?;
        self.seed_index(key, events, &report)?;
        Ok(report)
    }

    /// Build the in-memory query index from recovered records.
    fn seed_index(
        &self,
        key: [u8; 32],
        events: Vec<AuditEvent>,
        report: &LoadReport,
    ) -> Result<(), String> {
        let store = AuditStore::open_memory()?;
        // Replay in write order: `insert` replaces by id, so a task's terminal
        // record supersedes the `running` one it wrote when it was queued.
        for event in &events {
            if let Err(e) = store.insert(event) {
                eprintln!("audit index rebuild skipped {}: {e}", event.id);
            }
        }
        *self.store.lock().map_err(|e| e.to_string())? = Some(store);
        *self.key.lock().map_err(|e| e.to_string())? = Some(key);
        if let Ok(mut slot) = self.integrity_error.lock() {
            *slot = report.integrity_error.clone();
        }
        if report.truncated_tail {
            eprintln!(
                "audit log: discarded a partial trailing record after an unclean exit ({} kept)",
                report.records
            );
        }
        Ok(())
    }

    /// Append when open; otherwise count the event as dropped and return `Ok(false)`.
    pub fn try_insert(&self, event: &AuditEvent) -> Result<bool, String> {
        let key = {
            let guard = self.key.lock().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                Some(k) => *k,
                None => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return Ok(false);
                }
            }
        };
        // Durable first: the log is the record of truth, the index is derived.
        // Indexing an event the log rejected would show history that cannot
        // survive a restart.
        if let Err(e) = self.log.append(&key, event) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return Err(e);
        }
        let guard = self.store.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(store) => store.insert(event)?,
            None => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn query(&self, filter: &AuditFilter) -> Result<Vec<AuditEvent>, String> {
        let guard = self.store.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(store) => store.query(filter),
            None => Err("audit session is closed".into()),
        }
    }

    /// Apply retention. A no-op on a sealed log: pruning compacts, and
    /// compaction would replace the very file being preserved as evidence and
    /// clear its seal. Only an explicit [`Self::discard_damaged_log`] may do that.
    pub fn prune_before(&self, ts_ms: i64) -> Result<u64, String> {
        if let Some(reason) = self.integrity_error() {
            eprintln!("audit: skipping retention prune, log is sealed: {reason}");
            return Ok(0);
        }
        let n = {
            let guard = self.store.lock().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                Some(store) => store.prune_before(ts_ms)?,
                None => return Ok(0),
            }
        };
        if n > 0 {
            // Retention must reach the durable log too, not just the index.
            self.compact_log_from_index()?;
        }
        Ok(n)
    }

    /// Discard a *damaged* log and resume recording, leaving a permanent record
    /// that it happened.
    ///
    /// Deliberately not a general "clear": retention is the only way a healthy
    /// log shrinks. An audit trail with a one-click erase button defeats every
    /// integrity check around it — those checks would then only defend against
    /// someone *without* access to the app, which is the wrong adversary. So this
    /// refuses unless the log is already sealed, and even then it writes a
    /// tombstone as the first record of the new chain. Retention skips tombstones
    /// and a discard preserves any that are still readable.
    ///
    /// The guarantee is therefore: a discard always leaves a record of itself, so
    /// a discarded log can never be made to look like one that never was. It is
    /// *not* that the full history of discards survives — damaging the file can
    /// destroy earlier tombstones along with everything else, though doing so
    /// seals the log again and so leaves a fresh one.
    pub fn discard_damaged_log(&self) -> Result<u64, String> {
        let Some(reason) = self.integrity_error() else {
            return Err("the activity log is intact, so there is nothing to discard. \
                        Old events are removed automatically by the retention setting."
                .into());
        };

        let verified_head = self.log.chain_head_hex();
        let verified_count = self.log.record_count().unwrap_or(0);

        let discarded = {
            let guard = self.store.lock().map_err(|e| e.to_string())?;
            let Some(store) = guard.as_ref() else {
                return Err("audit session is closed".into());
            };
            let discarded = store.retain_tombstones_only()?;
            store.insert(&tombstone(
                discarded,
                verified_count,
                verified_head.as_deref(),
                &reason,
            ))?;
            discarded
        };

        // Compaction is what actually replaces the sealed file, and it clears the
        // log's own seal; the session's copy is cleared alongside it.
        self.compact_log_from_index()?;
        if let Ok(mut slot) = self.integrity_error.lock() {
            *slot = None;
        }
        Ok(discarded)
    }

    /// Rewrite the log to match the index exactly.
    fn compact_log_from_index(&self) -> Result<(), String> {
        let key = {
            let guard = self.key.lock().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                Some(k) => *k,
                None => return Ok(()),
            }
        };
        let events = {
            let guard = self.store.lock().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                Some(store) => store.all_chronological()?,
                None => return Ok(()),
            }
        };
        self.log.compact(&key, &events)
    }

    /// Close the session. Every event is already durable, so this only releases
    /// the file handle and forgets the key.
    pub fn close(&self) -> Result<(), String> {
        self.discard();
        Ok(())
    }

    /// Close the session but keep the log's cross-process lock held, so a key
    /// rotation can replace the file with no window for another instance to
    /// take it and append under the old key.
    pub fn close_retaining_lock(&self) -> Option<RetainedLock> {
        let retained = self.log.close_retaining_lock();
        if let Ok(mut g) = self.store.lock() {
            *g = None;
        }
        if let Ok(mut k) = self.key.lock() {
            *k = None;
        }
        retained
    }

    /// Reopen using a lock handed over by [`Self::close_retaining_lock`].
    pub fn open_retaining(&self, key: [u8; 32], lock: RetainedLock) -> Result<LoadReport, String> {
        let (events, report) = self.log.open_retaining(&key, lock)?;
        self.seed_index(key, events, &report)?;
        Ok(report)
    }

    /// Drop the in-memory index, the key and the file handle.
    pub fn discard(&self) {
        self.log.close();
        if let Ok(mut g) = self.store.lock() {
            *g = None;
        }
        if let Ok(mut k) = self.key.lock() {
            *k = None;
        }
    }
}

impl Drop for AuditSession {
    fn drop(&mut self) {
        self.discard();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::store::SCHEMA_VERSION;
    use tempfile::tempdir;

    const KEY: [u8; 32] = [9u8; 32];

    fn sample(id: &str, ts: i64) -> AuditEvent {
        AuditEvent {
            id: id.into(),
            ts,
            connection_id: None,
            profile_name: None,
            database: Some("db".into()),
            collection: Some("c".into()),
            op: "drop_collection".into(),
            source: "ui".into(),
            ok: true,
            error: None,
            duration_ms: None,
            summary: format!("dropCollection db.c {id}"),
            args_json: None,
            level_at_record: "A".into(),
            schema_version: SCHEMA_VERSION,
        }
    }

    fn ids(session: &AuditSession) -> Vec<String> {
        let mut rows = session.query(&AuditFilter::default()).expect("query");
        rows.sort_by_key(|e| e.ts);
        rows.into_iter().map(|e| e.id).collect()
    }

    #[test]
    fn events_survive_a_hard_exit_with_no_close() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");
        let session = AuditSession::new(path.clone());
        session.open(KEY).expect("open");
        assert!(session.try_insert(&sample("e1", 100)).expect("insert"));
        assert!(session.try_insert(&sample("e2", 200)).expect("insert"));
        // Dropped without close(): every append was already fsynced, so nothing
        // depends on an orderly shutdown. Dropping rather than `mem::forget`ing
        // because a dying process releases the log's advisory lock, and a leaked
        // handle would not.
        drop(session);

        let reopened = AuditSession::new(path);
        let report = reopened.open(KEY).expect("reopen");
        assert_eq!(report.records, 2);
        assert!(report.integrity_error.is_none());
        assert_eq!(ids(&reopened), ["e1", "e2"]);
    }

    #[test]
    fn insert_is_refused_and_counted_after_close() {
        let dir = tempdir().unwrap();
        let session = AuditSession::new(dir.path().join("audit.log.enc"));
        session.open(KEY).expect("open");
        assert!(session.try_insert(&sample("e1", 100)).expect("insert"));
        session.close().expect("close");
        assert!(!session.is_open());

        assert!(!session.try_insert(&sample("e2", 200)).expect("soft-fail"));
        assert_eq!(session.dropped_count(), 1);
    }

    #[test]
    fn prune_reaches_the_durable_log_not_just_the_index() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");
        let session = AuditSession::new(path.clone());
        session.open(KEY).expect("open");
        session.try_insert(&sample("old", 1_000)).expect("insert");
        session.try_insert(&sample("new", 5_000)).expect("insert");
        assert_eq!(session.prune_before(3_000).expect("prune"), 1);
        session.close().expect("close");

        // The pruned event must not come back from the log on the next unlock.
        let reopened = AuditSession::new(path);
        reopened.open(KEY).expect("reopen");
        assert_eq!(ids(&reopened), ["new"]);
    }

    #[test]
    fn an_intact_log_cannot_be_erased() {
        let dir = tempdir().unwrap();
        let session = AuditSession::new(dir.path().join("audit.log.enc"));
        session.open(KEY).expect("open");
        session.try_insert(&sample("e1", 100)).expect("insert");

        // The whole point of the split: retention removes events, a human cannot.
        let err = session.discard_damaged_log().expect_err("must refuse");
        assert!(err.contains("intact"), "{err}");
        assert!(err.contains("retention"), "{err}");
        assert_eq!(ids(&session), ["e1"], "the event must survive");
    }

    #[test]
    fn a_tampered_log_surfaces_an_integrity_error_and_stops_recording() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");
        let session = AuditSession::new(path.clone());
        session.open(KEY).expect("open");
        session.try_insert(&sample("e1", 100)).expect("insert");
        session.try_insert(&sample("e2", 200)).expect("insert");
        session.close().expect("close");

        // Damage the *last* record: earlier ones stay readable, which is the
        // interesting case — a partial recovery followed by a discard.
        let mut bytes = std::fs::read(&path).unwrap();
        let len = bytes.len();
        *bytes.last_mut().unwrap() ^= 0xff;
        std::fs::write(&path, &bytes).unwrap();

        let reopened = AuditSession::new(path.clone());
        let report = reopened.open(KEY).expect("open a damaged log");
        assert!(report.integrity_error.is_some(), "{report:?}");
        assert!(reopened.integrity_error().is_some());

        // Recording stops rather than overwriting the evidence.
        assert!(reopened.try_insert(&sample("e3", 300)).is_err());
        assert_eq!(std::fs::read(&path).unwrap().len(), len);

        // Discarding is the documented way back to a working log — and it must
        // leave a permanent record that it happened.
        let discarded = reopened.discard_damaged_log().expect("discard");
        assert_eq!(discarded, 1, "the readable event is removed with the rest");
        assert!(reopened.integrity_error().is_none(), "seal must be cleared");
        assert!(reopened.try_insert(&sample("e4", 400)).expect("insert"));

        let rows = reopened.query(&AuditFilter::default()).expect("query");
        let tomb: Vec<_> = rows
            .iter()
            .filter(|e| e.op == crate::audit::store::TOMBSTONE_OP)
            .collect();
        assert_eq!(tomb.len(), 1, "exactly one tombstone");
        assert!(!tomb[0].ok, "a discard is not a success");
        assert!(tomb[0].summary.contains("discarded"), "{}", tomb[0].summary);
        assert!(
            tomb[0].error.as_deref().unwrap_or("").len() > 0,
            "the tombstone must carry why the log was unverifiable"
        );
    }

    #[test]
    fn a_tombstone_survives_retention_and_accumulates_across_discards() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");

        let damage_last_record = || {
            let mut bytes = std::fs::read(&path).unwrap();
            *bytes.last_mut().unwrap() ^= 0xff;
            std::fs::write(&path, &bytes).unwrap();
        };

        let session = AuditSession::new(path.clone());
        session.open(KEY).expect("open");
        session.try_insert(&sample("e1", 100)).expect("insert");
        session.close().expect("close");
        damage_last_record();

        let s1 = AuditSession::new(path.clone());
        s1.open(KEY).expect("open damaged");
        s1.discard_damaged_log().expect("discard");

        // Retention must not put a deadline on the record that a discard happened.
        assert_eq!(
            s1.prune_before(i64::MAX).expect("prune"),
            0,
            "a tombstone must not be pruned away"
        );
        assert_eq!(
            s1.query(&AuditFilter::default()).expect("query").len(),
            1,
            "the tombstone remains"
        );

        // Record again, damage the new record, discard again: the earlier
        // tombstone is still readable, so the two accumulate.
        s1.try_insert(&sample("e2", 200)).expect("insert");
        s1.close().expect("close");
        damage_last_record();

        let s2 = AuditSession::new(path);
        s2.open(KEY).expect("open damaged again");
        s2.discard_damaged_log().expect("second discard");

        let rows = s2.query(&AuditFilter::default()).expect("query");
        let tombs = rows
            .iter()
            .filter(|e| e.op == crate::audit::store::TOMBSTONE_OP)
            .count();
        assert_eq!(tombs, 2, "a readable earlier discard must stay on record");
    }

    #[test]
    fn policy_defaults_to_level_a_without_payloads() {
        let dir = tempdir().unwrap();
        let session = AuditSession::new(dir.path().join("audit.log.enc"));
        let policy = session.policy();
        assert!(policy.enabled);
        assert_eq!(policy.level, AuditLevel::A);
        assert!(!policy.include_payloads);
        assert_eq!(policy.retention_days, 30);
    }
}
