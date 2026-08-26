//! Local operation audit log (#272).
//!
//! Level gating, redaction, SQLite store, and vault envelope session.

pub mod envelope;
pub mod level;
pub mod redact;
pub mod store;

pub use envelope::{seal, unseal, AuditSession};
pub use level::{should_record, AuditLevel, OpClass};
pub use redact::{redact_text, truncate_args, MAX_ARGS_BYTES};
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

/// Open (or replace) the audit session after a successful vault unlock.
pub fn open_on_unlock(
    app: &tauri::AppHandle,
    state: &AppState,
    key: [u8; 32],
) -> Result<(), String> {
    // Soft-fail: audit must never block unlock.
    if let Err(e) = open_on_unlock_inner(app, state, key) {
        eprintln!("audit open_on_unlock: {e}");
    }
    Ok(())
}

fn open_on_unlock_inner(
    app: &tauri::AppHandle,
    state: &AppState,
    key: [u8; 32],
) -> Result<(), String> {
    let path = connections::get_audit_enc_path(app);
    let session = AuditSession::new(path);
    session.open(key)?;

    let settings = connections::load_settings_encrypted(
        &connections::get_settings_enc_path(app),
        &key,
    )
    .unwrap_or_default();
    let cutoff = retention_cutoff_ms(settings.audit_retention_days, now_ms());
    let _ = session.prune_before(cutoff);

    *state.audit.lock_safe()? = Some(session);
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
    let mut slot = state.audit.lock_safe()?;
    if let Some(session) = slot.take() {
        session.close()?;
    }
    Ok(())
}

/// Discard session and delete `audit.db.enc` on vault reset.
pub fn reset_store(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    if let Ok(mut slot) = state.audit.lock_safe() {
        if let Some(session) = slot.take() {
            session.discard();
        }
    }
    let path = connections::get_audit_enc_path(app);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
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
