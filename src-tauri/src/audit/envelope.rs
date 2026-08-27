//! Vault-backed audit session: policy, the durable log, and the query index (#272).
//!
//! Encryption itself lives in [`super::log`], which encrypts each record
//! individually. This module owns the session lifecycle around it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use super::level::AuditLevel;
use super::log::{AuditLog, LoadReport};
use super::store::{AuditEvent, AuditFilter, AuditStore};

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
    pub fn integrity_error(&self) -> Option<String> {
        self.integrity_error.lock().ok().and_then(|g| g.clone())
    }

    pub fn is_open(&self) -> bool {
        self.store.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Recover the log and rebuild the query index from it.
    pub fn open(&self, key: [u8; 32]) -> Result<LoadReport, String> {
        let (events, report) = self.log.open(&key)?;
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
        Ok(report)
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

    pub fn prune_before(&self, ts_ms: i64) -> Result<u64, String> {
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

    pub fn clear_all(&self) -> Result<u64, String> {
        let n = {
            let guard = self.store.lock().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                Some(store) => store.clear_all()?,
                None => return Err("audit session is closed".into()),
            }
        };
        // Also the way out of a sealed log: compaction writes a fresh chain.
        self.compact_log_from_index()?;
        if let Ok(mut slot) = self.integrity_error.lock() {
            *slot = None;
        }
        Ok(n)
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
    fn clear_all_does_not_come_back_from_the_log() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");
        let session = AuditSession::new(path.clone());
        session.open(KEY).expect("open");
        session.try_insert(&sample("e1", 100)).expect("insert");
        session.try_insert(&sample("e2", 200)).expect("insert");
        assert_eq!(session.clear_all().expect("clear"), 2);
        session.close().expect("close");

        let reopened = AuditSession::new(path);
        let report = reopened.open(KEY).expect("reopen");
        assert_eq!(report.records, 0);
        assert!(ids(&reopened).is_empty());
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

        let mut bytes = std::fs::read(&path).unwrap();
        let len = bytes.len();
        bytes[24] ^= 0xff; // inside the first record's ciphertext
        std::fs::write(&path, &bytes).unwrap();

        let reopened = AuditSession::new(path.clone());
        let report = reopened.open(KEY).expect("open a damaged log");
        assert!(report.integrity_error.is_some(), "{report:?}");
        assert!(reopened.integrity_error().is_some());

        // Recording stops rather than overwriting the evidence.
        assert!(reopened.try_insert(&sample("e3", 300)).is_err());
        assert_eq!(std::fs::read(&path).unwrap().len(), len);

        // Clearing is the documented way back to a working log.
        reopened.clear_all().expect("clear");
        assert!(reopened.integrity_error().is_none());
        assert!(reopened.try_insert(&sample("e4", 400)).expect("insert"));
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
