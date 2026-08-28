//! Local operation audit log (#272).
//!
//! Level gating, redaction, SQLite store, vault envelope, and soft-fail recording.

pub mod classify;
pub mod envelope;
pub mod level;
pub mod log;
pub mod record;
pub mod redact;
pub mod store;

pub use classify::classify_op;
pub use envelope::{AuditPolicy, AuditSession};
pub use log::{AuditLog, LoadReport, RetainedLock};
pub use level::{should_record, AuditLevel, OpClass};
pub use record::{
    flush_pending, maybe_record, maybe_record_result, maybe_record_task_start, with_source,
    RecordInput, TaskAuditContext,
};
pub use redact::{redact_error, redact_text, truncate_args, MAX_ARGS_BYTES, MAX_ERROR_BYTES};
pub use store::{AuditEvent, AuditFilter, AuditStore, SCHEMA_VERSION};

use crate::connections::{self, AppSettings};
use crate::state::{AppState, LockExt};
use std::time::{SystemTime, UNIX_EPOCH};

/// Clamp retention days to a sane range (1..=365).
pub fn clamp_retention_days(days: u32) -> u32 {
    days.clamp(1, 365)
}

/// Unix-ms cutoff for pruning given retention days and "now".
pub fn retention_cutoff_ms(retention_days: u32, now_ms: i64) -> i64 {
    let days = clamp_retention_days(retention_days) as i64;
    now_ms.saturating_sub(days.saturating_mul(86_400_000))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn policy_from_settings(settings: &AppSettings) -> AuditPolicy {
    AuditPolicy {
        enabled: settings.audit_enabled,
        level: AuditLevel::parse(&settings.audit_level),
        include_payloads: settings.audit_include_payloads,
        retention_days: settings.audit_retention_days,
    }
}

fn prune_for_policy(session: &AuditSession, policy: AuditPolicy) {
    let cutoff = retention_cutoff_ms(policy.retention_days, now_ms());
    let _ = session.prune_before(cutoff);
}

/// Record (or clear) the reason auditing is inactive while the vault is unlocked.
fn set_degraded(state: &AppState, reason: Option<String>) {
    if let Ok(mut slot) = state.audit_degraded.lock_safe() {
        *slot = reason;
    }
}

/// Why auditing is inactive despite an unlocked vault, if it is.
pub fn degraded_reason(state: &AppState) -> Option<String> {
    state.audit_degraded.lock_safe().ok().and_then(|g| g.clone())
}

/// Open (or replace) the audit session after a successful vault unlock.
///
/// A failure here must not block the unlock itself — a corrupt `audit.log.enc`
/// would otherwise lock the user out of their own vault. Instead the reason is
/// stored so [`degraded_reason`] can surface it and the error is returned for
/// callers that want to react.
pub fn open_on_unlock(
    app: &tauri::AppHandle,
    state: &AppState,
    key: [u8; 32],
) -> Result<(), String> {
    match open_on_unlock_inner(app, state, key) {
        Ok(()) => {
            set_degraded(state, None);
            Ok(())
        }
        Err(e) => {
            eprintln!("audit open_on_unlock: {e}");
            set_degraded(state, Some(e.clone()));
            Err(e)
        }
    }
}

fn open_on_unlock_inner(
    app: &tauri::AppHandle,
    state: &AppState,
    key: [u8; 32],
) -> Result<(), String> {
    let mut slot = state.audit.lock_safe()?;
    if let Some(existing) = slot.take() {
        if let Err(e) = existing.close() {
            eprintln!("audit close before reopen: {e}");
        }
    }

    supersede_legacy_envelope(app);

    let path = connections::get_audit_log_path(app);
    let session = AuditSession::new(path);
    let report = session.open(key)?;
    if let Some(err) = &report.integrity_error {
        eprintln!("audit log integrity: {err}");
    }

    let settings = connections::load_settings_encrypted(
        &connections::get_settings_enc_path(app),
        &key,
    )
    .unwrap_or_default();
    session.set_policy(policy_from_settings(&settings));
    // Never prune a sealed log: retention compacts, and compaction rewrites the
    // file and clears the seal, destroying the corrupted frame and everything
    // after it — exactly what sealing exists to preserve.
    if report.integrity_error.is_none() {
        prune_for_policy(&session, session.policy());
    }

    *slot = Some(session);
    drop(slot);

    // Background tasks that finished while the vault was locked parked their
    // terminal events; write them now so nothing stays marked `running`.
    let flushed = record::flush_pending(&state.audit, &state.audit_pending);
    if flushed > 0 {
        eprintln!("audit: wrote {flushed} task outcome(s) recorded while the vault was locked");
    }
    Ok(())
}

/// Close the session for a key rotation, keeping the log's cross-process lock.
///
/// Releasing it would let a second instance take the log and append under the
/// old key while rotation swaps in the new-key file — on Unix that second
/// process keeps writing to the unlinked old inode, so those events vanish.
/// What a key rotation is holding on the audit log while it runs.
pub enum AuditRotationGuard {
    /// A session was suspended; its lock is carried through and the session is
    /// reopened afterwards.
    Session(RetainedLock),
    /// There was no session to suspend, so the lock was taken purely to keep
    /// other instances off the files. Released afterwards, and whether auditing
    /// then reopens is decided by the settings as usual.
    LockOnly(RetainedLock),
}

/// Hold the audit log for the duration of a key rotation.
///
/// Rotation rewrites `audit.log.enc` and its state sidecar, so it must exclude
/// other instances whether or not *this* one is recording. When another instance
/// owns the log this fails, and rotation must abort: rewriting the vault metadata
/// while that instance keeps appending under the old key leaves activity history
/// no password can open.
pub fn hold_for_rotation(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<AuditRotationGuard, String> {
    hold_for_rotation_at(state, connections::get_audit_log_path(app))
}

/// The path-taking half, so the no-session branch is reachable from tests
/// without an `AppHandle`.
fn hold_for_rotation_at(
    state: &AppState,
    log_path: std::path::PathBuf,
) -> Result<AuditRotationGuard, String> {
    if let Some(lock) = suspend_for_rotation(state) {
        return Ok(AuditRotationGuard::Session(lock));
    }
    // `suspend_for_rotation` clears the degradation reason before it discovers
    // there is no session to suspend, so bailing out here would leave the vault
    // unlocked, auditing inactive, and nothing left to say why — the Activity
    // panel would show "unknown reason" after a password change it refused to
    // make. The acquisition error is the live reason, so record that.
    AuditSession::new(log_path)
        .acquire_retained_lock()
        .map(AuditRotationGuard::LockOnly)
        .map_err(|e| {
            set_degraded(state, Some(e.clone()));
            e
        })
}

pub fn suspend_for_rotation(state: &AppState) -> Option<RetainedLock> {
    set_degraded(state, None);
    let mut slot = state.audit.lock_safe().ok()?;
    let session = slot.take()?;
    session.close_retaining_lock()
}

/// Reopen after a rotation, reusing the lock held throughout it.
pub fn resume_after_rotation(
    app: &tauri::AppHandle,
    state: &AppState,
    key: [u8; 32],
    lock: RetainedLock,
) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let mut slot = state.audit.lock_safe()?;
        let session = AuditSession::new(connections::get_audit_log_path(app));
        let report = session.open_retaining(key, lock)?;
        if let Some(err) = &report.integrity_error {
            eprintln!("audit log integrity: {err}");
        }
        let settings = load_settings_for_key(app, &key);
        session.set_policy(policy_from_settings(&settings));
        if report.integrity_error.is_none() {
            prune_for_policy(&session, session.policy());
        }
        *slot = Some(session);
        Ok(())
    })();
    match &result {
        Ok(()) => set_degraded(state, None),
        Err(e) => {
            eprintln!("audit resume_after_rotation: {e}");
            set_degraded(state, Some(e.clone()));
        }
    }
    result
}

/// Seal and drop the audit session on vault lock.
pub fn close_on_lock(state: &AppState) -> Result<(), String> {
    if let Err(e) = close_on_lock_inner(state) {
        eprintln!("audit close_on_lock: {e}");
    }
    Ok(())
}

fn close_on_lock_inner(state: &AppState) -> Result<(), String> {
    set_degraded(state, None);
    let mut slot = state.audit.lock_safe()?;
    if let Some(session) = slot.take() {
        session.close()?;
    }
    Ok(())
}

/// Move a pre-append-log `audit.db.enc` out of the way.
///
/// The whole-image envelope was replaced by `audit.log.enc` before this feature
/// shipped, so there is no released format to migrate. The old file is renamed
/// rather than deleted so a developer's local history is not silently destroyed.
fn supersede_legacy_envelope(app: &tauri::AppHandle) {
    let legacy = connections::get_audit_enc_path(app);
    if !legacy.exists() {
        return;
    }
    let superseded = legacy.with_extension("enc.superseded");
    match std::fs::rename(&legacy, &superseded) {
        Ok(()) => eprintln!(
            "audit: {} predates the append-only log format; renamed to {}",
            legacy.display(),
            superseded.display()
        ),
        Err(e) => eprintln!("audit: could not set aside {}: {e}", legacy.display()),
    }
}

/// Discard session and delete the audit log on vault reset.
pub fn reset_store(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    if let Ok(mut slot) = state.audit.lock_safe() {
        if let Some(session) = slot.take() {
            session.discard();
        }
    }

    // A reset destroys the vault this history belonged to. Anything still parked
    // from it must not be flushed into the *next* vault's log — including errors
    // that were sanitized under the old vault's payload policy. Bumping the
    // generation also stops background tasks still holding an old
    // `TaskAuditContext` from parking their outcome after the reset.
    if let Ok(mut pending) = state.audit_pending.lock_safe() {
        let dropped = pending.len();
        pending.clear();
        if dropped > 0 {
            eprintln!("audit: discarded {dropped} parked event(s) belonging to the reset vault");
        }
    }
    state
        .audit_generation
        .fetch_add(1, std::sync::atomic::Ordering::Release);

    let log_path = connections::get_audit_log_path(app);
    let sidecar = |suffix: &str| {
        let mut p = log_path.clone().into_os_string();
        p.push(suffix);
        std::path::PathBuf::from(p)
    };
    for path in [
        log_path.clone(),
        // The state sidecar holds the expected record count; leaving it behind
        // would make the next vault's fresh log look like records were removed.
        sidecar(".state"),
        sidecar(".lock"),
        connections::get_audit_enc_path(app),
    ] {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("remove {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Refresh in-memory audit policy after settings are saved (vault unlocked).
pub fn refresh_policy_from_settings(state: &AppState, settings: &AppSettings) {
    let policy = policy_from_settings(settings);
    if let Ok(guard) = state.audit.lock_safe() {
        if let Some(session) = guard.as_ref() {
            session.set_policy(policy);
            // `prune_before` refuses on a sealed log; saving a shorter retention
            // window must not become a way to overwrite preserved evidence.
            prune_for_policy(session, policy);
        }
    }
}

/// Current settings snapshot for audit decisions (defaults if locked/unloadable).
pub fn load_settings_for_key(app: &tauri::AppHandle, key: &[u8; 32]) -> AppSettings {
    connections::load_settings_encrypted(&connections::get_settings_enc_path(app), key)
        .unwrap_or_default()
}

#[cfg(test)]
mod retention_tests {
    use super::*;

    #[test]
    fn clamp_and_cutoff() {
        assert_eq!(clamp_retention_days(0), 1);
        assert_eq!(clamp_retention_days(400), 365);
        assert_eq!(clamp_retention_days(30), 30);
        let cutoff = retention_cutoff_ms(1, 86_400_000 * 10);
        assert_eq!(cutoff, 86_400_000 * 9);
    }
}

#[cfg(test)]
mod rotation_lock_tests {
    use super::*;
    use crate::audit::envelope::AuditPolicy;
    use crate::audit::level::AuditLevel;
    use tempfile::tempdir;

    const KEY: [u8; 32] = [9u8; 32];

    fn policy() -> AuditPolicy {
        AuditPolicy {
            enabled: true,
            level: AuditLevel::C,
            include_payloads: false,
            retention_days: 30,
        }
    }

    #[test]
    fn a_suspended_session_hands_its_own_lock_through() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");
        let state = AppState::new();
        let session = AuditSession::new(path.clone());
        session.open(KEY).expect("open");
        session.set_policy(policy());
        *state.audit.lock().unwrap() = Some(session);

        match hold_for_rotation_at(&state, path) {
            Ok(AuditRotationGuard::Session(_)) => {}
            other => panic!("expected the session's lock to be carried through: {:?}", other.is_ok()),
        }
        assert!(
            state.audit.lock().unwrap().is_none(),
            "the session must be suspended for the rotation"
        );
    }

    #[test]
    fn no_session_takes_the_lock_purely_for_exclusion() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");
        let state = AppState::new();

        match hold_for_rotation_at(&state, path) {
            Ok(AuditRotationGuard::LockOnly(_)) => {}
            other => panic!("expected a lock-only guard: {:?}", other.is_ok()),
        }
        assert!(
            degraded_reason(&state).is_none(),
            "taking the lock successfully is not a degraded state"
        );
    }

    #[test]
    fn a_refused_rotation_still_explains_why_auditing_is_inactive() {
        // `suspend_for_rotation` clears the degradation reason before it finds
        // there is no session, so without care a refused password change leaves
        // the Activity panel saying "inactive" with nothing to show for it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.log.enc");

        // Another instance owns the log.
        let owner = AuditSession::new(path.clone());
        owner.open(KEY).expect("owner opens");

        let state = AppState::new();
        set_degraded(&state, Some("an earlier reason".into()));

        let err = hold_for_rotation_at(&state, path.clone())
            .err()
            .expect("must refuse while another instance holds the log");
        assert!(
            err.contains("another MQLens instance"),
            "the error should name the cause: {err}"
        );
        assert_eq!(
            degraded_reason(&state).as_deref(),
            Some(err.as_str()),
            "the live reason must survive the refusal"
        );

        // And once the other instance lets go, rotation can proceed. `close`
        // returns a Result; a failure here must fail the test, or the assertion
        // below could pass because the lock leaked rather than because it was
        // released.
        owner.close().expect("owner releases the log");
        assert!(hold_for_rotation_at(&state, path).is_ok());
    }
}
