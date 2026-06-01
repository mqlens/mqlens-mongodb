//! Biometric unlock: stash the derived vault key in the OS biometric store (macOS Touch ID
//! keychain / Windows Hello) so the vault can be unlocked without retyping the master
//! password. The key never leaves the Rust backend; only our commands touch the plugin.

use crate::connections::{self, key_matches_meta, VaultMeta};
use base64::Engine as _;

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
