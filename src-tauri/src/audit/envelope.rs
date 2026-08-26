//! Vault AES-GCM envelope for the audit SQLite DB (#272).

use crate::vault;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use super::level::AuditLevel;
use super::store::{AuditEvent, AuditFilter, AuditStore};

/// Encrypt raw SQLite DB bytes with the vault key.
pub fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    vault::encrypt(key, plaintext)
}

/// Decrypt an `audit.db.enc` blob back to SQLite bytes.
pub fn unseal(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, String> {
    vault::decrypt(key, blob)
}

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

/// Open audit session while vault is unlocked; sealed on close/lock.
pub struct AuditSession {
    enc_path: PathBuf,
    store: Mutex<Option<AuditStore>>,
    key: Mutex<Option<[u8; 32]>>,
    dropped: AtomicU64,
    policy: Mutex<AuditPolicy>,
}

impl AuditSession {
    pub fn new(enc_path: PathBuf) -> Self {
        Self {
            enc_path,
            store: Mutex::new(None),
            key: Mutex::new(None),
            dropped: AtomicU64::new(0),
            policy: Mutex::new(AuditPolicy::default()),
        }
    }

    pub fn policy(&self) -> AuditPolicy {
        self.policy
            .lock()
            .map(|g| *g)
            .unwrap_or_default()
    }

    pub fn set_policy(&self, policy: AuditPolicy) {
        if let Ok(mut g) = self.policy.lock() {
            *g = policy;
        }
    }

    pub fn enc_path(&self) -> &Path {
        &self.enc_path
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn is_open(&self) -> bool {
        self.store.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Decrypt envelope (or create empty store) and hold it unlocked.
    pub fn open(&self, key: [u8; 32]) -> Result<(), String> {
        let store = if self.enc_path.exists() {
            let blob = fs::read(&self.enc_path)
                .map_err(|e| format!("read {}: {e}", self.enc_path.display()))?;
            if blob.is_empty() {
                AuditStore::open_memory()?
            } else {
                let plain = unseal(&key, &blob)?;
                AuditStore::from_bytes(&plain)?
            }
        } else {
            AuditStore::open_memory()?
        };
        *self.store.lock().map_err(|e| e.to_string())? = Some(store);
        *self.key.lock().map_err(|e| e.to_string())? = Some(key);
        Ok(())
    }

    /// Encrypt the live store to `enc_path` without closing the session.
    /// Called after every mutation so a crash or `process::exit` cannot lose events.
    pub fn persist(&self) -> Result<(), String> {
        let (plain, key) = {
            let store_guard = self.store.lock().map_err(|e| e.to_string())?;
            let key_guard = self.key.lock().map_err(|e| e.to_string())?;
            let Some(store) = store_guard.as_ref() else {
                return Ok(());
            };
            let Some(key) = key_guard.as_ref() else {
                return Ok(());
            };
            (store.to_bytes()?, *key)
        };
        let blob = seal(&key, &plain)?;
        if let Some(parent) = self.enc_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let tmp = self.enc_path.with_extension("enc.tmp");
        fs::write(&tmp, &blob).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        fs::rename(&tmp, &self.enc_path)
            .map_err(|e| format!("rename {} → {}: {e}", tmp.display(), self.enc_path.display()))?;
        Ok(())
    }

    /// Seal store to `enc_path`, drop plaintext store, clear key.
    pub fn close(&self) -> Result<(), String> {
        self.persist()?;
        self.discard();
        Ok(())
    }

    /// Insert when open; otherwise increment dropped and return Ok(false).
    pub fn try_insert(&self, event: &AuditEvent) -> Result<bool, String> {
        {
            let guard = self.store.lock().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                Some(store) => store.insert(event)?,
                None => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return Ok(false);
                }
            }
        }
        if let Err(e) = self.persist() {
            eprintln!("audit persist after insert: {e}");
            self.dropped.fetch_add(1, Ordering::Relaxed);
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
            self.persist()?;
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
        self.persist()?;
        Ok(n)
    }

    /// Close without sealing (used on vault reset when the enc file is deleted).
    pub fn discard(&self) {
        if let Ok(mut g) = self.store.lock() {
            *g = None;
        }
        if let Ok(mut k) = self.key.lock() {
            *k = None;
        }
    }
}

impl Drop for AuditSession {
    /// Seal to disk if the vault session is still open — covers app quit and
    /// dev reload without an explicit `vault_lock`.
    fn drop(&mut self) {
        if self.is_open() {
            if let Err(e) = self.close() {
                eprintln!("audit session drop: failed to seal: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::store::SCHEMA_VERSION;
    use tempfile::tempdir;

    fn sample(id: &str, ts: i64) -> AuditEvent {
        AuditEvent {
            id: id.into(),
            ts,
            connection_id: None,
            profile_name: None,
            database: Some("db".into()),
            collection: Some("c".into()),
            op: "dropCollection".into(),
            source: "ui".into(),
            ok: true,
            error: None,
            duration_ms: None,
            summary: "dropCollection db.c".into(),
            args_json: None,
            level_at_record: "A".into(),
            schema_version: SCHEMA_VERSION,
        }
    }

    #[test]
    fn seal_unseal_round_trip() {
        let key = [7u8; 32];
        let plain = b"sqlite-bytes-not-real-but-fine";
        let blob = seal(&key, plain).expect("seal");
        assert_ne!(&blob[..], &plain[..]);
        let back = unseal(&key, &blob).expect("unseal");
        assert_eq!(back, plain);
    }

    #[test]
    fn session_close_writes_enc_and_blocks_insert() {
        let dir = tempdir().unwrap();
        let enc = dir.path().join("audit.db.enc");
        let session = AuditSession::new(enc.clone());
        let key = [9u8; 32];
        session.open(key).expect("open");
        assert!(session
            .try_insert(&sample("e1", 100))
            .expect("insert while open"));
        session.close().expect("close");
        assert!(enc.exists(), "envelope file must exist after close");
        assert!(!session.is_open());
        let inserted = session
            .try_insert(&sample("e2", 200))
            .expect("soft-fail insert");
        assert!(!inserted);
        assert_eq!(session.dropped_count(), 1);

        session.open(key).expect("reopen");
        let rows = session.query(&AuditFilter::default()).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "e1");
    }

    #[test]
    fn drop_seals_without_explicit_close() {
        let dir = tempdir().unwrap();
        let enc = dir.path().join("audit.db.enc");
        let key = [9u8; 32];
        {
            let session = AuditSession::new(enc.clone());
            session.open(key).expect("open");
            assert!(session
                .try_insert(&sample("e1", 100))
                .expect("insert while open"));
        }
        assert!(enc.exists(), "envelope file must exist after drop");
        let session2 = AuditSession::new(enc);
        session2.open(key).expect("reopen");
        let rows = session2.query(&AuditFilter::default()).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "e1");
    }

    #[test]
    fn insert_persists_without_close() {
        let dir = tempdir().unwrap();
        let enc = dir.path().join("audit.db.enc");
        let key = [9u8; 32];
        let session = AuditSession::new(enc.clone());
        session.open(key).expect("open");
        assert!(session
            .try_insert(&sample("e1", 100))
            .expect("insert"));
        assert!(
            enc.exists(),
            "envelope must exist after insert, before close"
        );
        // Simulate a hard process exit: the live session is abandoned without close().
        std::mem::forget(session);
        let session2 = AuditSession::new(enc);
        session2.open(key).expect("reopen after crash");
        let rows = session2.query(&AuditFilter::default()).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "e1");
    }

    #[test]
    fn wrong_key_fails_unseal() {
        let key = [1u8; 32];
        let other = [2u8; 32];
        let blob = seal(&key, b"data").expect("seal");
        assert!(unseal(&other, &blob).is_err());
    }
}
