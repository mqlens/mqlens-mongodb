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
//! authentication tag. The length prefix is passed as additional authenticated
//! data, so editing that unencrypted header breaks authentication rather than
//! passing as a short append.
//!
//! # Integrity
//!
//! Each record embeds its sequence number and the chain hash of the record
//! before it, where `chain(i) = sha256(chain(i-1) || record_json(i))`. Deleting,
//! reordering or editing a record therefore breaks verification at load time.
//!
//! A *torn tail* — a crash midway through an append — is a different thing from
//! tampering and is handled differently: the trailing partial record is
//! discarded and logging continues. The distinction is whether the frame is
//! physically complete, not where it sits: an incomplete frame is a torn append,
//! while any fully present frame that fails to authenticate means the file was
//! altered, including the very last one. Tampering seals the log (see
//! [`LoadReport::integrity_error`]): the file is left untouched as evidence and
//! appends are refused rather than overwriting it.
//!
//! Note the honest limit: this log is encrypted with the user's own vault key on
//! the user's own machine. It is tamper-*evident*, not tamper-*proof* — whoever
//! holds the master password can always delete the file and start fresh.

use crate::durable;
use crate::vault;
use sha2::{Digest, Sha256};
use std::fs;
use fs4::fs_std::FileExt;
use std::io::{Read, Seek, SeekFrom, Write};
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

/// Size of the plaintext in the state sidecar: `u64` record count + chain head.
const STATE_PLAINTEXT_LEN: usize = 8 + 32;

/// AES-256-GCM framing overhead in a `vault::encrypt` blob: random nonce, then
/// ciphertext (same length as the plaintext), then the authentication tag.
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

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
    // The length prefix is stored unencrypted, so bind it into the record's
    // authentication tag. Editing the prefix then fails to decrypt instead of
    // looking indistinguishable from a partial append.
    //
    // The ciphertext length is fixed by the plaintext length (AES-GCM adds a
    // constant nonce + tag), so it can be computed before encrypting.
    let len: u32 = (NONCE_BYTES + json.len() + TAG_BYTES)
        .try_into()
        .map_err(|_| "audit record exceeds u32 length".to_string())?;
    if len > MAX_RECORD_BYTES {
        return Err(format!("audit record too large ({len} bytes)"));
    }
    let blob = vault::encrypt_with_aad(key, &json, &len.to_be_bytes())?;
    debug_assert_eq!(blob.len(), len as usize, "framed length must match the blob");
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
        // A length no real record could have means the prefix itself was edited,
        // not that an append was cut short — never truncate on those, or the
        // record and everything after it would be deleted silently.
        let minimum = (NONCE_BYTES + TAG_BYTES) as u32;
        if len < minimum || len > MAX_RECORD_BYTES {
            decoded.report.integrity_error = Some(format!(
                "audit log record {} declares an impossible length ({len} bytes) — \
                 the file was modified outside MQLens",
                decoded.seq + 1
            ));
            break;
        }
        // Declared longer than the bytes actually present. Only the final frame
        // can be in this state, and it is what an interrupted append leaves
        // behind. An edited prefix on a complete record is caught instead by the
        // authentication tag below, which covers the prefix as AAD.
        if remaining - LEN_PREFIX < len as usize {
            decoded.report.truncated_tail = true;
            break;
        }
        let body = &bytes[off + LEN_PREFIX..off + LEN_PREFIX + len as usize];

        // Only an *incomplete* frame is a torn append, and that is already
        // handled by the length checks above. A frame that is entirely present
        // reached the disk, so failing to authenticate means it was altered (or
        // the key is wrong) — never truncate it away, or the last record of a
        // tampered log would be silently erased.
        let plain = match vault::decrypt_with_aad(key, body, &len.to_be_bytes()) {
            Ok(p) => p,
            Err(e) => {
                decoded.report.integrity_error = Some(format!(
                    "audit log record {} failed to authenticate ({e}) — the file was \
                     modified outside MQLens, or the vault key does not match",
                    decoded.seq + 1
                ));
                break;
            }
        };
        let record: Record = match serde_json::from_slice(&plain) {
            Ok(r) => r,
            Err(e) => {
                decoded.report.integrity_error =
                    Some(format!("audit log record {} is malformed: {e}", decoded.seq + 1));
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

/// What the state sidecar says the log should contain.
enum RecordedState {
    /// No sidecar on disk.
    Missing,
    /// Present but unreadable under this key.
    Unreadable(String),
    /// Records written, and the chain head after them.
    Known(u64, [u8; 32]),
}

/// Open state: the append handle plus the chain position it continues from.
struct Open {
    /// Held for the whole session. Kept on a sidecar path rather than the log
    /// itself because compaction *replaces* the log file: locking the data file
    /// would release the lock the moment its inode is swapped, letting a second
    /// process lock the new file while the first still appends to the unlinked
    /// old one. The sidecar inode is stable, so the exclusion holds across
    /// compaction. Released when this handle drops.
    lock: fs::File,
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
    lock_path: PathBuf,
    state_path: PathBuf,
    open: Mutex<Option<Open>>,
}

impl AuditLog {
    pub fn new(path: PathBuf) -> Self {
        let mut lock_path = path.clone().into_os_string();
        lock_path.push(".lock");
        let mut state_path = path.clone().into_os_string();
        state_path.push(".state");
        Self {
            path,
            lock_path: PathBuf::from(lock_path),
            state_path: PathBuf::from(state_path),
            open: Mutex::new(None),
        }
    }

    /// Path of the state sidecar, so vault reset and rotation can handle it.
    pub fn state_path(&self) -> &Path {
        &self.state_path
    }

    /// Record the number of events the log should contain, and the chain head
    /// after them.
    ///
    /// This is what makes recovery unambiguous. The leading length prefix is
    /// unauthenticated, so an edited prefix and a genuinely interrupted append
    /// look identical from the file alone — and truncating on that ambiguity
    /// would delete real records. Comparing against a durably recorded count
    /// separates the two: fewer records than expected means removal, the same
    /// count means the trailing bytes really were a partial append. It closes
    /// tail truncation for the same reason. Encrypted under the vault key so it
    /// cannot be forged without it.
    fn write_state(&self, key: &[u8; 32], seq: u64, head: &[u8; 32]) -> Result<(), String> {
        let mut plain = Vec::with_capacity(STATE_PLAINTEXT_LEN);
        plain.extend_from_slice(&seq.to_be_bytes());
        plain.extend_from_slice(head);
        let blob = vault::encrypt(key, &plain)?;
        durable::write_atomic(&self.state_path, &blob)
    }

    fn read_state(&self, key: &[u8; 32]) -> RecordedState {
        if !self.state_path.exists() {
            return RecordedState::Missing;
        }
        let blob = match fs::read(&self.state_path) {
            Ok(b) if !b.is_empty() => b,
            Ok(_) => return RecordedState::Missing,
            Err(e) => return RecordedState::Unreadable(e.to_string()),
        };
        let plain = match vault::decrypt(key, &blob) {
            Ok(p) => p,
            Err(e) => return RecordedState::Unreadable(e),
        };
        if plain.len() != STATE_PLAINTEXT_LEN {
            return RecordedState::Unreadable("unexpected length".into());
        }
        let mut seq_bytes = [0u8; 8];
        seq_bytes.copy_from_slice(&plain[..8]);
        let mut head = [0u8; 32];
        head.copy_from_slice(&plain[8..]);
        RecordedState::Known(u64::from_be_bytes(seq_bytes), head)
    }

    /// Path of the sidecar lock file, so vault reset can clean it up.
    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }

    /// Take the cross-process exclusive lock for this session.
    fn acquire_lock(&self) -> Result<fs::File, String> {
        if let Some(parent) = self.lock_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.lock_path)
            .map_err(|e| format!("open {}: {e}", self.lock_path.display()))?;
        match file.try_lock_exclusive() {
            Ok(true) => Ok(file),
            Ok(false) => Err(format!(
                "another MQLens instance is already recording to the activity log ({}) — \
                 only one instance can record at a time",
                self.path.display()
            )),
            Err(e) => Err(format!("lock {}: {e}", self.lock_path.display())),
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
        self.open_inner(key, None)
    }

    fn open_inner(
        &self,
        key: &[u8; 32],
        held: Option<RetainedLock>,
    ) -> Result<(Vec<AuditEvent>, LoadReport), String> {
        let mut slot = self.open.lock().map_err(|e| e.to_string())?;
        // Drop any previous handle first, releasing its lock.
        if held.is_none() {
            *slot = None;
        }

        // Take the lock before reading, so no other instance can be appending
        // while recovery decides what is a torn tail and what is tampering.
        let lock = match held {
            Some(RetainedLock(file)) => file,
            None => self.acquire_lock()?,
        };
        let mut file = self.open_handle()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|e| format!("read {}: {e}", self.path.display()))?;

        if bytes.is_empty() {
            // An empty file is only "brand new" if nothing was ever recorded.
            // Deleting or truncating the log to zero would otherwise be the one
            // way to erase history without detection, since there are no frames
            // left to fail a check.
            let sealed = match self.read_state(key) {
                RecordedState::Known(expected, _) if expected > 0 => Some(format!(
                    "the audit log is empty but {expected} event(s) were recorded — the file \
                     was deleted or truncated. Discard the damaged log from Activity to \
                     resume recording."
                )),
                RecordedState::Unreadable(why) => Some(format!(
                    "the audit log is empty and its state file could not be read ({why}), so \
                     it cannot be verified. Discard the damaged log from Activity to resume \
                     recording."
                )),
                _ => None,
            };
            if let Some(reason) = sealed {
                // Write nothing: the state file is the surviving evidence.
                *slot = Some(Open {
                    lock,
                    file,
                    seq: 0,
                    head: GENESIS,
                    sealed_reason: Some(reason.clone()),
                });
                return Ok((
                    Vec::new(),
                    LoadReport {
                        records: 0,
                        truncated_tail: false,
                        integrity_error: Some(reason),
                    },
                ));
            }

            // Genuinely new: lay down the header in place, keeping the handle
            // and its lock.
            let header = header_bytes();
            file.write_all(&header)
                .map_err(|e| format!("write {}: {e}", self.path.display()))?;
            file.sync_all()
                .map_err(|e| format!("fsync {}: {e}", self.path.display()))?;
            self.write_state(key, 0, &GENESIS)?;
            *slot = Some(Open {
                lock,
                file,
                seq: 0,
                head: GENESIS,
                sealed_reason: None,
            });
            return Ok((Vec::new(), LoadReport::default()));
        }

        let recorded = self.read_state(key);
        let mut decoded = decode_file(key, &bytes)?;

        // The framing alone cannot tell an edited length prefix from an
        // interrupted append, so trust the durable count instead of guessing.
        // Only when decoding found nothing wrong itself — a broken chain or a
        // failed tag is a more specific diagnosis than a count mismatch.
        if decoded.report.integrity_error.is_none() {
        match recorded {
            RecordedState::Known(expected_seq, expected_head) => {
                if decoded.seq < expected_seq {
                    decoded.report.integrity_error = Some(format!(
                        "audit log is missing records: {} readable, {expected_seq} expected — \
                         records were removed, or a frame header was altered",
                        decoded.seq
                    ));
                } else if decoded.seq == expected_seq && decoded.head != expected_head {
                    decoded.report.integrity_error = Some(
                        "audit log contents do not match their recorded hash — the file was \
                         modified outside MQLens"
                            .into(),
                    );
                }
                // `decoded.seq > expected_seq` is the ordinary crash between an
                // append and its state write: those records authenticated and
                // chained, so they are genuine and the state is refreshed below.
            }
            RecordedState::Missing => {
                decoded.report.integrity_error = Some(
                    "the audit log's state file is missing, so the log cannot be verified \
                     against the number of events it should hold. Discard the damaged log \
                     from Activity to resume recording."
                        .into(),
                );
            }
            RecordedState::Unreadable(why) => {
                decoded.report.integrity_error = Some(format!(
                    "the audit log's state file could not be read ({why}), so the log cannot \
                     be verified. Discard the damaged log from Activity to resume recording."
                ));
            }
        }
        }

        if decoded.report.integrity_error.is_none() && decoded.report.truncated_tail {
            // Confirmed a partial append rather than a removal, so dropping it is
            // safe and leaves the next append on a clean boundary.
            file.set_len(decoded.valid_len as u64)
                .map_err(|e| format!("truncate {}: {e}", self.path.display()))?;
            file.sync_all()
                .map_err(|e| format!("fsync {}: {e}", self.path.display()))?;
        }

        if decoded.report.integrity_error.is_none() {
            // Re-anchor the counter to what the log actually holds, covering both
            // a truncated tail and records that outran their state write.
            self.write_state(key, decoded.seq, &decoded.head)?;
        }

        *slot = Some(Open {
            lock,
            file,
            seq: decoded.seq,
            head: decoded.head,
            sealed_reason: decoded.report.integrity_error.clone(),
        });
        Ok((decoded.events, decoded.report))
    }

    /// Open the log data file for reading and appending. Exclusion is the
    /// sidecar lock's job, not this handle's.
    fn open_handle(&self) -> Result<fs::File, String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            // Never truncate: the whole point is to append to existing history.
            .truncate(false)
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
        // After the record, so a crash between the two leaves the log ahead of
        // the counter — which recovery treats as genuine, not as removal.
        self.write_state(key, open.seq, &open.head)?;
        Ok(())
    }

    /// Rewrite the log to contain exactly `events`, in order.
    ///
    /// Used for retention pruning, clearing, and unsealing after corruption —
    /// the only O(total history) operations, and none of them per-event.
    pub fn compact(&self, key: &[u8; 32], events: &[AuditEvent]) -> Result<(), String> {
        let mut slot = self.open.lock().map_err(|e| e.to_string())?;
        let Some(open) = slot.take() else {
            return Err("audit log is closed".into());
        };
        let (bytes, head, seq) = encode_file(key, events)?;

        // Carry the sidecar lock across untouched: it must stay held for the
        // whole replacement, or another instance could lock the new file while
        // this one still holds the unlinked old inode. Only the *data* handle is
        // closed, because Windows cannot rename over an open file.
        let Open {
            lock,
            file,
            seq: prev_seq,
            head: prev_head,
            sealed_reason: prev_sealed,
        } = open;
        drop(file);

        let replaced = durable::write_atomic(&self.path, &bytes);

        // Restore the session on every path. Returning early here would leave
        // the slot empty and drop the cross-process lock while the in-memory
        // index stayed populated, so `audit_status` would claim auditing was
        // active while every append failed with "audit log is closed".
        let (seq, head, mut sealed_reason) = if replaced.is_ok() {
            (seq, head, None)
        } else {
            (prev_seq, prev_head, prev_sealed)
        };

        // The counter must follow the data file. If it cannot be written, the
        // compacted log no longer matches the count on disk and the next unlock
        // would read that as missing records — so seal now rather than report
        // healthy and fail later.
        let mut state_error = None;
        if replaced.is_ok() {
            if let Err(e) = self.write_state(key, seq, &head) {
                sealed_reason = Some(format!(
                    "the audit log was compacted but its state file could not be updated \
                     ({e}), so the log can no longer be verified. Discard the damaged log \
                     from Activity to resume recording."
                ));
                state_error = Some(e);
            }
        }

        *slot = Some(Open {
            lock,
            file: self.open_handle()?,
            seq,
            head,
            sealed_reason,
        });
        match state_error {
            Some(e) => Err(e),
            None => replaced,
        }
    }

    /// Hex chain head, for recording what a discarded log was verified up to.
    pub fn chain_head_hex(&self) -> Option<String> {
        self.open
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|o| hex32(&o.head)))
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

    /// Close the log but keep its cross-process lock held, for handing to
    /// [`Self::open_retaining`].
    pub fn close_retaining_lock(&self) -> Option<RetainedLock> {
        let mut slot = self.open.lock().ok()?;
        slot.take().map(|open| RetainedLock(open.lock))
    }

    /// Recover the log using a lock that is already held.
    pub fn open_retaining(
        &self,
        key: &[u8; 32],
        lock: RetainedLock,
    ) -> Result<(Vec<AuditEvent>, LoadReport), String> {
        self.open_inner(key, Some(lock))
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
    log_path: &Path,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    if !log_path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(log_path).map_err(|e| format!("read {}: {e}", log_path.display()))?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let decoded = decode_file(old_key, &bytes)?;
    if let Some(reason) = decoded.report.integrity_error {
        return Err(format!("cannot re-encrypt a damaged audit log: {reason}"));
    }
    let (log_bytes, head, seq) = encode_file(new_key, &decoded.events)?;

    // The state sidecar is encrypted under the same key, so it has to be
    // rotated in the same transaction — otherwise the new-key log would be
    // checked against an old-key counter and seal itself on the next unlock.
    let mut state_plain = Vec::with_capacity(STATE_PLAINTEXT_LEN);
    state_plain.extend_from_slice(&seq.to_be_bytes());
    state_plain.extend_from_slice(&head);
    let state_bytes = vault::encrypt(new_key, &state_plain)?;

    let mut state_path = log_path.to_path_buf().into_os_string();
    state_path.push(".state");
    Ok(vec![
        (log_path.to_path_buf(), log_bytes),
        (PathBuf::from(state_path), state_bytes),
    ])
}

/// A held cross-process lock, kept alive across a close/reopen cycle.
///
/// Key rotation must read and replace the log while no other instance can touch
/// it, but it also has to close the session to get a consistent snapshot.
/// Handing the lock through instead of dropping it removes the window where a
/// second instance could take the log and append under the old key.
pub struct RetainedLock(fs::File);

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

        // Read the bytes straight off disk while the log is still open. A crash
        // at this instant would leave exactly this file, because every append is
        // fsynced — so decoding it is the durability guarantee.
        //
        // Deliberately not `mem::forget`: that would leak the handle and hold the
        // advisory lock forever, which a dying process does not do — the OS
        // releases it, the same way dropping the handle does below.
        let on_disk = fs::read(&path).unwrap();
        let decoded = decode_file(&KEY, &on_disk).expect("decode the on-disk image");
        assert_eq!(decoded.events.len(), 2, "both events must already be on disk");
        assert!(!decoded.report.truncated_tail, "{:?}", decoded.report);
        assert!(decoded.report.integrity_error.is_none(), "{:?}", decoded.report);

        drop(log);
        let reopened = AuditLog::new(path);
        let (events, report) = reopened.open(&KEY).expect("reopen");
        assert_eq!(events.len(), 2);
        assert!(report.integrity_error.is_none(), "{report:?}");
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
        let (log, path) = log_with(dir.path(), 2);
        log.close();

        // A real interrupted append leaves partial bytes *and* a counter that
        // still reads 2, because the counter is written after the record. Appending
        // a truncated frame by hand reproduces that; rewriting the file after a
        // successful append would not, and would correctly look like removal.
        let mut partial = fs::OpenOptions::new().append(true).open(&path).unwrap();
        partial.write_all(&[0, 0, 1, 0]).unwrap(); // declares 256 bytes...
        partial.write_all(&[7u8; 40]).unwrap(); // ...but only 40 are present
        drop(partial);

        let reopened = AuditLog::new(path.clone());
        let (events, report) = reopened.open(&KEY).expect("recover");
        assert!(report.truncated_tail, "torn tail must be reported: {report:?}");
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
    fn inflating_the_last_records_length_seals_instead_of_dropping_it() {
        // The one case framing alone cannot classify: a complete record whose
        // prefix is changed to more than the bytes remaining looks exactly like
        // an interrupted append. The durable count is what separates them.
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();

        let mut bytes = fs::read(&path).unwrap();
        let last_start = {
            let mut off = HEADER_LEN;
            let mut prev = off;
            while off < bytes.len() {
                let len = u32::from_be_bytes([
                    bytes[off],
                    bytes[off + 1],
                    bytes[off + 2],
                    bytes[off + 3],
                ]) as usize;
                prev = off;
                off += LEN_PREFIX + len;
            }
            prev
        };
        bytes[last_start..last_start + LEN_PREFIX]
            .copy_from_slice(&(MAX_RECORD_BYTES - 1).to_be_bytes());
        fs::write(&path, &bytes).unwrap();

        let reopened = AuditLog::new(path.clone());
        let (events, report) = reopened.open(&KEY).expect("load");
        assert!(
            report.integrity_error.is_some(),
            "dropping a record must not pass as a torn append: {report:?}"
        );
        assert_eq!(events.len(), 2, "the intact prefix is still readable");
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes,
            "the altered record must be preserved as evidence"
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
    fn a_modified_final_record_seals_the_log_instead_of_being_truncated_away() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();

        // Flip a byte inside the *last* record. Its frame is complete and
        // reaches EOF, so length checks cannot tell it apart from a good record
        // — only the auth tag can, and it must not be mistaken for a torn write.
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        fs::write(&path, &bytes).unwrap();

        let reopened = AuditLog::new(path.clone());
        let (_, report) = reopened.open(&KEY).expect("load");
        assert!(
            report.integrity_error.is_some(),
            "a complete-but-unauthentic final record is tampering, not a torn tail: {report:?}"
        );
        assert!(!report.truncated_tail, "{report:?}");
        assert_eq!(
            fs::read(&path).unwrap().len(),
            bytes.len(),
            "the evidence must not be truncated away"
        );
    }

    #[test]
    fn a_single_record_log_opened_with_the_wrong_key_is_not_silently_emptied() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 1);
        log.close();
        let before = fs::read(&path).unwrap().len();

        let reopened = AuditLog::new(path.clone());
        let (events, report) = reopened.open(&[42u8; 32]).expect("load");
        assert!(events.is_empty());
        assert!(
            report.integrity_error.is_some(),
            "the only record must not be written off as a torn append: {report:?}"
        );
        assert_eq!(fs::read(&path).unwrap().len(), before, "file must be intact");
    }

    /// Overwrite the first record's 4-byte length prefix with `len`.
    fn set_first_length(path: &Path, len: u32) -> Vec<u8> {
        let mut bytes = fs::read(path).unwrap();
        bytes[HEADER_LEN..HEADER_LEN + LEN_PREFIX].copy_from_slice(&len.to_be_bytes());
        fs::write(path, &bytes).unwrap();
        bytes
    }

    #[test]
    fn an_edited_length_prefix_seals_the_log_rather_than_truncating_it() {
        // The prefix is stored unencrypted, so it is the one field an attacker
        // can edit without touching ciphertext. Each of these used to be read as
        // "partial append" and deleted the record and everything after it.
        for bogus in [0u32, 1, 27, MAX_RECORD_BYTES + 1] {
            let dir = tempdir().unwrap();
            let (log, path) = log_with(dir.path(), 3);
            log.close();
            let tampered = set_first_length(&path, bogus);

            let reopened = AuditLog::new(path.clone());
            let (events, report) = reopened.open(&KEY).expect("load");
            assert!(
                report.integrity_error.is_some(),
                "length {bogus} must be reported as tampering: {report:?}"
            );
            assert!(events.is_empty());
            assert_eq!(
                fs::read(&path).unwrap(),
                tampered,
                "length {bogus} must not truncate the file"
            );
        }
    }

    #[test]
    fn a_plausible_but_wrong_length_prefix_fails_authentication() {
        // Big enough to look real and still fit inside the file, so only the
        // AAD binding over the prefix can catch it.
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        log.close();
        let real_len = u32::from_be_bytes([
            fs::read(&path).unwrap()[HEADER_LEN],
            fs::read(&path).unwrap()[HEADER_LEN + 1],
            fs::read(&path).unwrap()[HEADER_LEN + 2],
            fs::read(&path).unwrap()[HEADER_LEN + 3],
        ]);
        let tampered = set_first_length(&path, real_len + 1);

        let reopened = AuditLog::new(path.clone());
        let (_, report) = reopened.open(&KEY).expect("load");
        assert!(
            report.integrity_error.is_some(),
            "a fitting but altered prefix must fail authentication: {report:?}"
        );
        assert_eq!(fs::read(&path).unwrap(), tampered, "file must be intact");
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
    fn a_failed_state_write_seals_but_never_closes_the_session() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);

        // Block only the state sidecar's staging path, so the data file is
        // replaced but the counter cannot follow it.
        let state_tmp = dir.path().join("audit.log.enc.state.tmp");
        fs::create_dir(&state_tmp).unwrap();

        let err = log
            .compact(&KEY, &[event("e3", 1_003)])
            .expect_err("state write must fail");
        assert!(err.contains("state"), "{err}");

        // The session must not be left closed: that would drop the lock while the
        // in-memory index stayed populated, so status would claim auditing works.
        assert!(log.is_open(), "session must stay open");
        assert!(
            log.sealed_reason().is_some(),
            "an unverifiable log must report itself sealed rather than healthy"
        );
        assert!(
            log.append(&KEY, &event("e4", 1_004)).is_err(),
            "a sealed log must refuse appends"
        );

        // And the lock is still held, so no second instance can step in.
        let other = AuditLog::new(path);
        assert!(other.open(&KEY).is_err(), "lock must still be held");
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
    fn a_second_instance_cannot_open_the_same_log() {
        let dir = tempdir().unwrap();
        let (first, path) = log_with(dir.path(), 1);

        // Concurrent appenders would each cache their own seq/head and break the
        // chain, so the second must be refused outright rather than corrupting it.
        let second = AuditLog::new(path.clone());
        let err = second.open(&KEY).unwrap_err();
        assert!(
            err.contains("another MQLens instance"),
            "expected a clear lock message, got: {err}"
        );

        // The first instance keeps working while it holds the lock.
        first.append(&KEY, &event("e2", 2_000)).expect("append");

        // Releasing the lock hands the log over cleanly.
        first.close();
        let (events, report) = second.open(&KEY).expect("open after release");
        assert!(report.integrity_error.is_none(), "{report:?}");
        assert_eq!(
            events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["e1", "e2"]
        );
    }

    #[test]
    fn reopening_in_the_same_instance_does_not_deadlock_on_its_own_lock() {
        let dir = tempdir().unwrap();
        let (log, _path) = log_with(dir.path(), 2);
        // `open` must release the previous handle before taking the lock again.
        let (events, report) = log.open(&KEY).expect("reopen in place");
        assert!(report.integrity_error.is_none(), "{report:?}");
        assert_eq!(events.len(), 2);
        log.append(&KEY, &event("e3", 3_000)).expect("append after reopen");
    }

    #[test]
    fn the_lock_is_never_released_during_compaction() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 3);
        let other = AuditLog::new(path.clone());

        // Compaction replaces the data file's inode. The lock lives on a stable
        // sidecar path precisely so this window does not exist — otherwise a
        // second instance could take the new file while this one appends to the
        // unlinked old one, losing those events silently.
        assert!(other.open(&KEY).is_err(), "locked before compaction");
        log.compact(&KEY, &[event("e3", 1_003)]).expect("compact");
        assert!(other.open(&KEY).is_err(), "must still be locked after compaction");

        log.append(&KEY, &event("e4", 1_004)).expect("append after compact");
        log.close();

        let (events, report) = other.open(&KEY).expect("open once released");
        assert!(report.integrity_error.is_none(), "{report:?}");
        assert_eq!(
            events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["e3", "e4"]
        );
    }

    #[test]
    fn the_lock_lives_on_a_sidecar_path_not_the_log_itself() {
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 1);
        assert_eq!(log.lock_path(), path.with_extension("enc.lock"));
        assert!(log.lock_path().exists(), "sidecar lock file must exist");
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
        let files = prepare_reencrypted(&KEY, &new_key, &path).expect("prepare");
        // The state sidecar is keyed too, so it must rotate alongside the log.
        assert_eq!(files.len(), 2, "log and state sidecar");
        for (target, bytes) in files {
            fs::write(target, bytes).unwrap();
        }

        let reopened = AuditLog::new(path);
        let (events, report) = reopened.open(&new_key).expect("open with new key");
        assert!(report.integrity_error.is_none(), "{report:?}");
        assert_eq!(
            events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["e1", "e2", "e3"]
        );
    }

    #[test]
    fn reencrypting_only_the_log_and_not_its_state_would_seal_it() {
        // Guards the pairing: rotating one without the other leaves a new-key log
        // checked against an old-key counter.
        let dir = tempdir().unwrap();
        let (log, path) = log_with(dir.path(), 2);
        log.close();

        let new_key = [4u8; 32];
        let files = prepare_reencrypted(&KEY, &new_key, &path).expect("prepare");
        let (log_target, log_bytes) = files.into_iter().next().unwrap();
        fs::write(log_target, log_bytes).unwrap();

        let reopened = AuditLog::new(path);
        let (_, report) = reopened.open(&new_key).expect("load");
        assert!(
            report.integrity_error.is_some(),
            "a stale state sidecar must be caught: {report:?}"
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
            .is_empty());
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
