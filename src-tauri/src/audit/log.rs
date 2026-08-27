//! Append-only encrypted record log for the audit trail (#272).
//!
//! # Why not a whole-image envelope
//!
//! The first cut sealed the entire SQLite database into `audit.db.enc` on every
//! change. That made per-event durability cost O(total history): each recorded
//! operation re-serialized, re-encrypted and rewrote the whole log, so latency
//! grew with retained history and a partial write could lose *everything*. The
//! only way to bound that was to batch, which reopened a window where a crash
//! lost recent events — exactly the events an audit log exists for.
//!
//! This module removes the trade-off. Each event is one independently encrypted
//! record appended to `audit.log.enc`, so a write is O(1) in history size and
//! can be fsynced on every single event. The in-memory SQLite store becomes a
//! pure query index, rebuilt from this file on unlock.
//!
//! # Format
//!
//! ```text
//! header: b"MQLAUDIT" | u32 BE format version | u32 BE reserved   (16 bytes)
//! record: u32 BE ciphertext length | vault::encrypt(key, record_json)
//! record: ...
//! ```
//!
//! `vault::encrypt` emits a self-contained 12-byte random nonce plus AES-256-GCM
//! ciphertext and tag, so every record stands alone and carries its own
//! authentication tag.
//!
//! # Integrity
//!
//! Each record embeds its sequence number and the chain hash of the record
//! before it, where `chain(i) = sha256(chain(i-1) || record_json(i))`. Deleting,
//! reordering or editing a record therefore breaks verification at load time.
//!
//! A *torn tail* — a crash midway through an append — is a different thing from
//! tampering and is handled differently: the trailing partial record is
//! discarded and logging continues. Corruption anywhere earlier seals the log
//! (see [`LoadReport::integrity_error`]): the file is left untouched as evidence
//! and appends are refused rather than overwriting it.
//!
//! Note the honest limit: this log is encrypted with the user's own vault key on
//! the user's own machine. It is tamper-*evident*, not tamper-*proof* — whoever
//! holds the master password can always delete the file and start fresh.

use crate::durable;
use crate::vault;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::store::AuditEvent;

const MAGIC: &[u8; 8] = b"MQLAUDIT";
const FORMAT_VERSION: u32 = 1;
const HEADER_LEN: usize = 16;
const LEN_PREFIX: usize = 4;

/// Reject absurd record lengths so a corrupt prefix cannot make us allocate
/// gigabytes. Comfortably above one event (64 KiB args + 2 KiB error + fields).
const MAX_RECORD_BYTES: u32 = 8 * 1024 * 1024;

const GENESIS: [u8; 32] = [0u8; 32];

/// One log record: the event plus its position in the hash chain.
#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    /// 1-based position in the log.
    seq: u64,
    /// Hex chain hash of the preceding record; 64 zeros for the first.
    prev: String,
    event: AuditEvent,
}

/// What [`AuditLog::open`] found in the file.
#[derive(Clone, Debug, Default)]
pub struct LoadReport {
    /// Records recovered and verified.
    pub records: u64,
    /// A trailing partial record was discarded — a crash mid-append, not tampering.
    pub truncated_tail: bool,
    /// Verification failed at or before the last record. The log is sealed
    /// against further appends and the file is preserved as evidence.
    pub integrity_error: Option<String>,
}

fn hex32(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

fn chain_next(prev: &[u8; 32], record_json: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(prev);
    hasher.update(record_json);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn header_bytes() -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    out
}

/// Serialize one record and its framed, encrypted on-disk form.
fn encode_record(
    key: &[u8; 32],
    seq: u64,
    prev: &[u8; 32],
    event: &AuditEvent,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    let record = Record {
        seq,
        prev: hex32(prev),
        event: event.clone(),
    };
    let json = serde_json::to_vec(&record).map_err(|e| format!("encode audit record: {e}"))?;
    let blob = vault::encrypt(key, &json)?;
    let len: u32 = blob
        .len()
        .try_into()
        .map_err(|_| "audit record exceeds u32 length".to_string())?;
    if len > MAX_RECORD_BYTES {
        return Err(format!("audit record too large ({len} bytes)"));
    }
    let mut framed = Vec::with_capacity(LEN_PREFIX + blob.len());
    framed.extend_from_slice(&len.to_be_bytes());
    framed.extend_from_slice(&blob);
    Ok((framed, chain_next(prev, &json)))
}

/// Build a whole log file from scratch — used for compaction and key rotation.
fn encode_file(key: &[u8; 32], events: &[AuditEvent]) -> Result<(Vec<u8>, [u8; 32], u64), String> {
    let mut out = header_bytes();
    let mut head = GENESIS;
    let mut seq = 0u64;
    for event in events {
        seq += 1;
        let (framed, next) = encode_record(key, seq, &head, event)?;
        out.extend_from_slice(&framed);
        head = next;
    }
    Ok((out, head, seq))
}

/// Decode every record in `bytes`, verifying the chain.
///
/// `Ok((events, report))` — a torn tail sets `report.truncated_tail` and
/// `report.valid_len` worth of bytes are the ones worth keeping; interior
/// corruption sets `report.integrity_error` and stops the scan.
fn decode_file(key: &[u8; 32], bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() < HEADER_LEN {
        return Err("audit log is shorter than its header".to_string());
    }
    if &bytes[..8] != MAGIC {
        return Err("audit log has an unrecognized header".to_string());
    }
    let version = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    if version != FORMAT_VERSION {
        return Err(format!("unsupported audit log format version {version}"));
    }

    let mut decoded = Decoded {
        events: Vec::new(),
        head: GENESIS,
        seq: 0,
        valid_len: HEADER_LEN,
        report: LoadReport::default(),
    };
    let mut off = HEADER_LEN;

    while off < bytes.len() {
        let remaining = bytes.len() - off;
        if remaining < LEN_PREFIX {
            decoded.report.truncated_tail = true;
            break;
        }
        let len = u32::from_be_bytes([
            bytes[off],
            bytes[off + 1],
            bytes[off + 2],
            bytes[off + 3],
        ]);
        // A length that does not fit the remaining file can only be a partial
        // append; the same is true of an absurd length written into a torn prefix.
        if len == 0 || len > MAX_RECORD_BYTES || remaining - LEN_PREFIX < len as usize {
            decoded.report.truncated_tail = true;
            break;
        }
        let body = &bytes[off + LEN_PREFIX..off + LEN_PREFIX + len as usize];
        let is_last = off + LEN_PREFIX + len as usize == bytes.len();

        let plain = match vault::decrypt(key, body) {
            Ok(p) => p,
            Err(e) => {
                // Only the final record can be a torn write; anything earlier
                // means the file was altered.
                if is_last {
                    decoded.report.truncated_tail = true;
                    break;
                }
                decoded.report.integrity_error =
                    Some(format!("record {} failed to decrypt: {e}", decoded.seq + 1));
                break;
            }
        };
        let record: Record = match serde_json::from_slice(&plain) {
            Ok(r) => r,
            Err(e) => {
                if is_last {
                    decoded.report.truncated_tail = true;
                    break;
                }
                decoded.report.integrity_error =
                    Some(format!("record {} is malformed: {e}", decoded.seq + 1));
                break;
            }
        };

        let expected_seq = decoded.seq + 1;
        if record.seq != expected_seq {
            decoded.report.integrity_error = Some(format!(
                "audit log records are out of order: expected sequence {expected_seq}, found {}",
                record.seq
            ));
            break;
        }
        if record.prev != hex32(&decoded.head) {
            decoded.report.integrity_error = Some(format!(
                "audit log hash chain broken at record {expected_seq} — \
                 the file was modified outside MQLens"
            ));
            break;
        }

        decoded.head = chain_next(&decoded.head, &plain);
        decoded.seq = record.seq;
        decoded.events.push(record.event);
        off += LEN_PREFIX + len as usize;
        decoded.valid_len = off;
    }

    decoded.report.records = decoded.seq;
    Ok(decoded)
}

struct Decoded {
    events: Vec<AuditEvent>,
    head: [u8; 32],
    seq: u64,
    valid_len: usize,
    report: LoadReport,
}

/// Open state: the append handle plus the chain position it continues from.
struct Open {
    file: fs::File,
    seq: u64,
    head: [u8; 32],
    /// Set when the load found interior corruption. Appends are refused so the
    /// damaged file survives for inspection instead of being written over.
    sealed_reason: Option<String>,
}

/// Append-only encrypted audit log.
pub struct AuditLog {
    path: PathBuf,
    open: Mutex<Option<Open>>,
}

impl AuditLog {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            open: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Recover the log and hold it open for appends.
    ///
    /// Returns every verified event in write order so the caller can rebuild the
    /// query index, plus a report describing what recovery had to do.
    pub fn open(&self, key: &[u8; 32]) -> Result<(Vec<AuditEvent>, LoadReport), String> {
        let mut slot = self.open.lock().map_err(|e| e.to_string())?;
        *slot = None;

        if !self.path.exists() {
            durable::write_atomic(&self.path, &header_bytes())?;
            *slot = Some(Open {
                file: self.open_handle()?,
                seq: 0,
                head: GENESIS,
                sealed_reason: None,
            });
            return Ok((Vec::new(), LoadReport::default()));
        }

        let bytes =
            fs::read(&self.path).map_err(|e| format!("read {}: {e}", self.path.display()))?;
        if bytes.is_empty() {
            durable::write_atomic(&self.path, &header_bytes())?;
            *slot = Some(Open {
                file: self.open_handle()?,
                seq: 0,
                head: GENESIS,
                sealed_reason: None,
            });
            return Ok((Vec::new(), LoadReport::default()));
        }

        let decoded = decode_file(key, &bytes)?;
        let file = self.open_handle()?;

        if decoded.report.integrity_error.is_none() && decoded.report.truncated_tail {
            // Drop the partial record so the next append starts on a clean
            // boundary. Safe: it never decrypted, so it was never a whole event.
            file.set_len(decoded.valid_len as u64)
                .map_err(|e| format!("truncate {}: {e}", self.path.display()))?;
            file.sync_all()
                .map_err(|e| format!("fsync {}: {e}", self.path.display()))?;
        }

        *slot = Some(Open {
            file,
            seq: decoded.seq,
            head: decoded.head,
            sealed_reason: decoded.report.integrity_error.clone(),
        });
        Ok((decoded.events, decoded.report))
    }

    fn open_handle(&self) -> Result<fs::File, String> {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.path)
            .map_err(|e| format!("open {}: {e}", self.path.display()))
    }

    /// Append one event and fsync it. O(1) in the size of the existing log.
    pub fn append(&self, key: &[u8; 32], event: &AuditEvent) -> Result<(), String> {
        let mut slot = self.open.lock().map_err(|e| e.to_string())?;
        let open = slot.as_mut().ok_or("audit log is closed")?;
        if let Some(reason) = &open.sealed_reason {
            return Err(format!("audit log is sealed: {reason}"));
        }

        let (framed, next) = encode_record(key, open.seq + 1, &open.head, event)?;
        open.file
            .seek(SeekFrom::End(0))
            .map_err(|e| format!("seek {}: {e}", self.path.display()))?;
        open.file
            .write_all(&framed)
            .map_err(|e| format!("append {}: {e}", self.path.display()))?;
        // The point of the whole design: durability per event, not per batch.
        open.file
            .sync_data()
            .map_err(|e| format!("fsync {}: {e}", self.path.display()))?;

        open.seq += 1;
        open.head = next;
        Ok(())
    }

    /// Rewrite the log to contain exactly `events`, in order.
    ///
    /// Used for retention pruning, clearing, and unsealing after corruption —
    /// the only O(total history) operations, and none of them per-event.
    pub fn compact(&self, key: &[u8; 32], events: &[AuditEvent]) -> Result<(), String> {
        let mut slot = self.open.lock().map_err(|e| e.to_string())?;
        if slot.is_none() {
            return Err("audit log is closed".into());
        }
        let (bytes, head, seq) = encode_file(key, events)?;
        // Drop the handle before replacing the file so Windows can rename over it.
        *slot = None;
        durable::write_atomic(&self.path, &bytes)?;
        *slot = Some(Open {
            file: self.open_handle()?,
            seq,
            head,
            sealed_reason: None,
        });
        Ok(())
    }

    /// Records written so far, or `None` when closed.
    pub fn record_count(&self) -> Option<u64> {
        self.open.lock().ok().and_then(|g| g.as_ref().map(|o| o.seq))
    }

    /// Why appends are being refused, if they are.
    pub fn sealed_reason(&self) -> Option<String> {
        self.open
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|o| o.sealed_reason.clone()))
    }

    pub fn is_open(&self) -> bool {
        self.open.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Release the file handle. Every append is already durable, so there is
    /// nothing to flush.
    pub fn close(&self) {
        if let Ok(mut slot) = self.open.lock() {
            *slot = None;
        }
    }
}

/// Re-encrypt a whole log from `old_key` to `new_key`, returning the new file
/// bytes without writing them.
///
/// Records are individually encrypted, so a password change cannot just
/// re-encrypt one blob: every record is decrypted and the chain rebuilt. Kept
/// separate from writing so `vault_change_password` can prepare every vault file
/// before overwriting any of them.
pub fn prepare_reencrypted(
    old_key: &[u8; 32],
    new_key: &[u8; 32],
    path: &Path,
) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let decoded = decode_file(old_key, &bytes)?;
    if let Some(reason) = decoded.report.integrity_error {
        return Err(format!("cannot re-encrypt a damaged audit log: {reason}"));
    }
    let (out, _, _) = encode_file(new_key, &decoded.events)?;
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::store::SCHEMA_VERSION;
    use tempfile::tempdir;

    fn event(id: &str, ts: i64) -> AuditEvent {
        AuditEvent {
            id: id.into(),
            ts,
            connection_id: Some("c1".into()),
            profile_name: Some("prod".into()),
            database: Some("shop".into()),
            collection: Some("orders".into()),
            op: "drop_collection".into(),
            source: "ui".into(),
            ok: true,
            error: None,
            duration_ms: Some(3),
            summary: format!("dropCollection shop.orders #{id}"),
            args_json: None,
            level_at_record: "A".into(),
            schema_version: SCHEMA_VERSION,
        }
    }

    const KEY: [u8; 32] = [7u8; 32];

    fn log_with(dir: &Path, n: usize) -> (AuditLog, PathBuf) {
        let path = dir.join("audit.log.enc");
        let log = AuditLog::new(path.clone());
        log.open(&KEY).expect("open");
        for i in 1..=n {
            log.append(&KEY, &event(&format!("e{i}"), 1_000 + i as i64))
                .expect("append");
        }
        (log, path)
    }

    #[test]
    fn appends_survive_reopen_in_order() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();

        let reopened = AuditLog::new(path);
        let (events, report) = reopened.open(&KEY).expect("reopen");
        assert_eq!(report.records, 3);
        assert!(!report.truncated_tail);
        assert!(report.integrity_error.is_none());
        let ids: Vec<&str> = events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e1", "e2", "e3"]);
    }

    #[test]
    fn every_append_is_durable_without_close() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 2);
        // Simulate a hard kill: abandon the live handle without closing.
        std::mem::forget(log);

        let reopened = AuditLog::new(path);
        let (events, report) = reopened.open(&KEY).expect("reopen after crash");
        assert_eq!(events.len(), 2, "both events must already be on disk");
        assert!(!report.truncated_tail);
    }

    #[test]
    fn append_cost_does_not_grow_the_rewritten_bytes() {
        // Regression guard for the whole-image design: appending the 50th event
        // must not rewrite the earlier 49. The file grows by one record only.
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 49);
        let before = fs::metadata(&path).unwrap().len();
        log.append(&KEY, &event("e50", 9_999)).expect("append");
        let after = fs::metadata(&path).unwrap().len();
        let one_record = after - before;
        assert!(
            one_record < before / 4,
            "one append grew the file by {one_record} bytes against {before} existing"
        );
    }

    #[test]
    fn torn_tail_is_discarded_and_logging_continues() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();

        // Chop the final record in half, as a crash mid-append would.
        let bytes = fs::read(&path).unwrap();
        fs::write(&path, &bytes[..bytes.len() - 20]).unwrap();

        let reopened = AuditLog::new(path.clone());
        let (events, report) = reopened.open(&KEY).expect("recover");
        assert!(report.truncated_tail, "torn tail must be reported");
        assert!(
            report.integrity_error.is_none(),
            "a torn tail is a crash, not tampering: {report:?}"
        );
        assert_eq!(events.len(), 2, "the two whole records survive");

        // And the log is usable again: the partial record was truncated away.
        reopened.append(&KEY, &event("e4", 4_000)).expect("append");
        reopened.close();
        let again = AuditLog::new(path);
        let (events, report) = again.open(&KEY).expect("reopen");
        assert!(report.integrity_error.is_none(), "{report:?}");
        assert_eq!(
            events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["e1", "e2", "e4"]
        );
    }

    #[test]
    fn interior_tampering_is_detected_and_seals_the_log() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();

        // Flip a byte inside the *first* record's ciphertext.
        let mut bytes = fs::read(&path).unwrap();
        let target = HEADER_LEN + LEN_PREFIX + 4;
        bytes[target] ^= 0xff;
        fs::write(&path, &bytes).unwrap();

        let reopened = AuditLog::new(path.clone());
        let (events, report) = reopened.open(&KEY).expect("load");
        assert!(
            report.integrity_error.is_some(),
            "interior corruption must be reported, not silently truncated"
        );
        assert!(events.is_empty(), "nothing before the damage to recover");

        // Sealed: appending must refuse rather than overwrite the evidence.
        let err = reopened.append(&KEY, &event("e4", 4_000)).unwrap_err();
        assert!(err.contains("sealed"), "{err}");
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes,
            "the damaged file must be preserved untouched"
        );
    }

    #[test]
    fn deleting_a_record_breaks_the_hash_chain() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();

        // Splice out the first record entirely — lengths stay self-consistent,
        // so only the chain and sequence numbers can catch this.
        let bytes = fs::read(&path).unwrap();
        let first_len = u32::from_be_bytes([
            bytes[HEADER_LEN],
            bytes[HEADER_LEN + 1],
            bytes[HEADER_LEN + 2],
            bytes[HEADER_LEN + 3],
        ]) as usize;
        let mut spliced = bytes[..HEADER_LEN].to_vec();
        spliced.extend_from_slice(&bytes[HEADER_LEN + LEN_PREFIX + first_len..]);
        fs::write(&path, &spliced).unwrap();

        let reopened = AuditLog::new(path);
        let (_, report) = reopened.open(&KEY).expect("load");
        let err = report.integrity_error.expect("deletion must be detected");
        assert!(
            err.contains("out of order") || err.contains("chain broken"),
            "{err}"
        );
    }

    #[test]
    fn compact_rewrites_the_log_and_clears_a_seal() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 4);
        // Keep only the two newest, as retention pruning would.
        let keep = vec![event("e3", 1_003), event("e4", 1_004)];
        log.compact(&KEY, &keep).expect("compact");
        log.append(&KEY, &event("e5", 1_005)).expect("append after compact");
        log.close();

        let reopened = AuditLog::new(path);
        let (events, report) = reopened.open(&KEY).expect("reopen");
        assert!(report.integrity_error.is_none(), "{report:?}");
        assert_eq!(
            events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["e3", "e4", "e5"]
        );
    }

    #[test]
    fn compact_to_empty_produces_a_valid_empty_log() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.compact(&KEY, &[]).expect("clear");
        log.close();

        let reopened = AuditLog::new(path);
        let (events, report) = reopened.open(&KEY).expect("reopen");
        assert!(events.is_empty());
        assert_eq!(report.records, 0);
        assert!(report.integrity_error.is_none());
    }

    #[test]
    fn wrong_key_fails_to_load() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 2);
        log.close();
        let reopened = AuditLog::new(path);
        // The first record fails to authenticate and is not the last one.
        let (events, report) = reopened.open(&[9u8; 32]).expect("load");
        assert!(events.is_empty());
        assert!(report.integrity_error.is_some());
    }

    #[test]
    fn rejects_a_foreign_header() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");
        fs::write(&path, b"NOTMQLENS\0\0\0\0\0\0\0").unwrap();
        let log = AuditLog::new(path);
        let err = log.open(&KEY).unwrap_err();
        assert!(err.contains("unrecognized header"), "{err}");
    }

    #[test]
    fn reencrypt_preserves_every_event_under_the_new_key() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();

        let new_key = [4u8; 32];
        let bytes = prepare_reencrypted(&KEY, &new_key, &path)
            .expect("prepare")
            .expect("some bytes");
        fs::write(&path, &bytes).unwrap();

        let reopened = AuditLog::new(path);
        let (events, report) = reopened.open(&new_key).expect("open with new key");
        assert!(report.integrity_error.is_none(), "{report:?}");
        assert_eq!(
            events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["e1", "e2", "e3"]
        );
    }

    #[test]
    fn reencrypt_refuses_a_damaged_log() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();
        let mut bytes = fs::read(&path).unwrap();
        bytes[HEADER_LEN + LEN_PREFIX + 4] ^= 0xff;
        fs::write(&path, &bytes).unwrap();

        let err = prepare_reencrypted(&KEY, &[4u8; 32], &path).unwrap_err();
        assert!(err.contains("damaged"), "{err}");
    }

    #[test]
    fn missing_file_reencrypts_to_nothing() {
        let dir = tempdir().unwrap();
        let absent = dir.path().join("nope.log.enc");
        assert!(prepare_reencrypted(&KEY, &[4u8; 32], &absent)
            .expect("prepare")
            .is_none());
    }

    #[test]
    fn hex32_is_lowercase_and_64_chars() {
        assert_eq!(hex32(&GENESIS), "0".repeat(64));
        let mut b = [0u8; 32];
        b[0] = 0xab;
        b[31] = 0x0f;
        let h = hex32(&b);
        assert_eq!(h.len(), 64);
        assert!(h.starts_with("ab"));
        assert!(h.ends_with("0f"));
    }
}
