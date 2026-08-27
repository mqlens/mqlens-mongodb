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
pub use log::{AuditLog, LoadReport};
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
    prune_for_policy(&session, session.policy());

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
    for path in [
        connections::get_audit_log_path(app),
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
