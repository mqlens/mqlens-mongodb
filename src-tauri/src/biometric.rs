//! Biometric unlock: stash the derived vault key in the OS biometric store (macOS Touch ID
//! keychain / Windows Hello) so the vault can be unlocked without retyping the master
//! password. The key never leaves the Rust backend; only our commands touch the plugin.

use crate::connections::{self, key_matches_meta, VaultMeta};
use crate::state::LockExt;
use crate::AppState;
use base64::Engine as _;
use tauri_plugin_biometry::{
    BiometryExt, BiometryType, DataOptions, GetDataOptions, SetDataOptions,
};

/// Keychain/Hello item coordinates. `(domain, name)` identifies the stored secret.
pub const BIO_DOMAIN: &str = "com.mqlens.app.vault";
pub const BIO_NAME: &str = "vault-key";

/// Reported to the frontend so it knows whether to offer/auto-trigger biometrics.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    /// A biometric sensor exists and is usable on this machine.
    pub available: bool,
    /// 0=none, 1=auto, 2=TouchID, 3=FaceID (mirrors the plugin's BiometryType).
    pub biometry_type: u8,
    /// A vault key has been stored behind biometrics on this machine.
    pub enrolled: bool,
}

/// Base64-encode the 32-byte vault key for storage.
pub fn encode_key(key: &[u8; 32]) -> String {
    base64::engine::general_purpose::STANDARD.encode(key)
}

/// Decode a stored base64 blob and confirm it is a valid 32-byte key for this vault.
/// Rejects non-base64, wrong-length, and verifier-mismatched data.
pub fn decode_and_verify_key(meta: &VaultMeta, data: &str) -> Result<[u8; 32], String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "stored biometric key is not valid base64".to_string())?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "stored biometric key has the wrong length".to_string())?;
    if !key_matches_meta(meta, &key) {
        return Err("stored biometric key does not match this vault".to_string());
    }
    Ok(key)
}

/// Read the vault metadata or error if the vault was never initialized.
pub(crate) fn read_meta(app: &tauri::AppHandle) -> Result<VaultMeta, String> {
    let path = connections::get_vault_meta_path(app);
    connections::read_vault_meta(&path)?.ok_or_else(|| "vault is not initialized".to_string())
}

fn biometry_type_code(t: &BiometryType) -> u8 {
    match t {
        BiometryType::TouchID => 2,
        BiometryType::FaceID => 3,
        BiometryType::Auto => 1, // plugin "let the OS choose" sentinel; not a real sensor type
        _ => 0,
    }
}

/// Whether a sensor is available and whether a key is already stored here. Never hard-fails:
/// any plugin/platform error reads as unavailable so the unlock screen stays usable.
#[tauri::command]
pub async fn biometric_status(app: tauri::AppHandle) -> Result<BiometricStatus, String> {
    let status = app.biometry().status();
    let (available, biometry_type) = match status {
        Ok(s) => (s.is_available, biometry_type_code(&s.biometry_type)),
        Err(_) => (false, 0),
    };
    let enrolled = available
        && app
            .biometry()
            .has_data(DataOptions {
                domain: BIO_DOMAIN.to_string(),
                name: BIO_NAME.to_string(),
            })
            .unwrap_or(false);
    Ok(BiometricStatus {
        available,
        biometry_type,
        enrolled,
    })
}

/// Store the current in-memory vault key behind biometrics. Requires the vault to be unlocked.
#[tauri::command]
pub async fn biometric_enable(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let key = state.require_key()?;
    app.biometry()
        .set_data(SetDataOptions {
            domain: BIO_DOMAIN.to_string(),
            name: BIO_NAME.to_string(),
            data: encode_key(&key),
        })
        .map_err(|e| format!("Failed to store biometric key: {e}"))
}

/// Prompt for biometrics, restore the vault key, verify it against the vault, and unlock.
#[tauri::command]
pub async fn biometric_unlock(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<connections::VaultStatus, String> {
    let meta = read_meta(&app)?;
    let resp = app
        .biometry()
        .get_data(GetDataOptions {
            domain: BIO_DOMAIN.to_string(),
            name: BIO_NAME.to_string(),
            reason: "Unlock MQLens".to_string(),
            cancel_title: Some("Use password".to_string()),
        })
        .map_err(|e| format!("biometric: {e}"))?;

    match decode_and_verify_key(&meta, &resp.data) {
        Ok(key) => {
            *state.vault_key.lock_safe()? = Some(key);
            Ok(connections::VaultStatus::Unlocked)
        }
        Err(e) => {
            // Purge a stale/corrupt item so the next launch goes straight to the password form.
            let _ = remove_stored_key(&app);
            Err(format!(
                "{e}. Unlock with your master password and re-enable biometrics."
            ))
        }
    }
}

/// Forget the stored key (toggle off).
#[tauri::command]
pub async fn biometric_disable(app: tauri::AppHandle) -> Result<(), String> {
    // Best-effort: removing an already-absent item is a no-op success.
    let _ = remove_stored_key(&app);
    Ok(())
}

/// Backend helper: remove the stored item (used by disable, reset, and stale-key purge).
pub(crate) fn remove_stored_key(app: &tauri::AppHandle) -> Result<(), String> {
    app.biometry()
        .remove_data(DataOptions {
            domain: BIO_DOMAIN.to_string(),
            name: BIO_NAME.to_string(),
        })
        .map_err(|e| format!("Failed to remove biometric key: {e}"))
}

/// Backend helper (Approach A): if biometrics are enrolled, re-store the given key. Best-effort.
pub(crate) fn restore_key_if_enrolled(app: &tauri::AppHandle, key: &[u8; 32]) {
    let enrolled = app
        .biometry()
        .has_data(DataOptions {
            domain: BIO_DOMAIN.to_string(),
            name: BIO_NAME.to_string(),
        })
        .unwrap_or(false);
    if enrolled {
        let _ = app.biometry().set_data(SetDataOptions {
            domain: BIO_DOMAIN.to_string(),
            name: BIO_NAME.to_string(),
            data: encode_key(key),
        });
    }
}
