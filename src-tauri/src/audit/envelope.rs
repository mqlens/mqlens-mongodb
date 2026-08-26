//! Vault AES-GCM envelope for the audit SQLite DB (#272).

use crate::vault;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use super::store::{AuditEvent, AuditFilter, AuditStore};

/// Encrypt raw SQLite DB bytes with the vault key.
pub fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    vault::encrypt(key, plaintext)
}

/// Decrypt an `audit.db.enc` blob back to SQLite bytes.
pub fn unseal(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, String> {
    vault::decrypt(key, blob)
}

/// Open audit session while vault is unlocked; sealed on close/lock.
pub struct AuditSession {
    enc_path: PathBuf,
    store: Mutex<Option<AuditStore>>,
    key: Mutex<Option<[u8; 32]>>,
    dropped: AtomicU64,
}

impl AuditSession {
    pub fn new(enc_path: PathBuf) -> Self {
        Self {
            enc_path,
            store: Mutex::new(None),
            key: Mutex::new(None),
            dropped: AtomicU64::new(0),
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

    /// Seal store to `enc_path`, drop plaintext store, clear key.
    pub fn close(&self) -> Result<(), String> {
        let mut store_guard = self.store.lock().map_err(|e| e.to_string())?;
        let mut key_guard = self.key.lock().map_err(|e| e.to_string())?;
        let key = key_guard
            .take()
            .ok_or_else(|| "audit session has no key".to_string())?;
        if let Some(store) = store_guard.take() {
            let plain = store.to_bytes()?;
            let blob = seal(&key, &plain)?;
            if let Some(parent) = self.enc_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("create {}: {e}", parent.display()))?;
            }
            fs::write(&self.enc_path, blob)
                .map_err(|e| format!("write {}: {e}", self.enc_path.display()))?;
        }
        Ok(())
    }

    /// Insert when open; otherwise increment dropped and return Ok(false).
    pub fn try_insert(&self, event: &AuditEvent) -> Result<bool, String> {
        let guard = self.store.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(store) => {
                store.insert(event)?;
                Ok(true)
            }
            None => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                Ok(false)
            }
        }
    }

    pub fn query(&self, filter: &AuditFilter) -> Result<Vec<AuditEvent>, String> {
        let guard = self.store.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(store) => store.query(filter),
            None => Err("audit session is closed".into()),
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
    fn wrong_key_fails_unseal() {
        let key = [1u8; 32];
        let other = [2u8; 32];
        let blob = seal(&key, b"data").expect("seal");
        assert!(unseal(&other, &blob).is_err());
    }
}
