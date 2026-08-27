//! Pure cryptography for the credential vault: Argon2id key derivation and
//! AES-256-GCM authenticated encryption. No file I/O and no Tauri types here so
//! every function is unit-testable in isolation.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::Rng;

/// Constant plaintext encrypted under the derived key to form the unlock verifier.
pub const VERIFIER_PLAINTEXT: &[u8] = b"mqlens-vault-v1";

/// Argon2id cost parameters. Persisted in vault.json so they can evolve.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        // ~64 MiB, 3 iterations, 1 lane: ~0.3-0.5s unlock on a typical laptop.
        Self { m_kib: 65536, t: 3, p: 1 }
    }
}

/// Derive a 32-byte key from a password and salt using Argon2id.
pub fn derive_key(password: &str, salt: &[u8], params: KdfParams) -> Result<[u8; 32], String> {
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(params.m_kib, params.t, params.p, Some(32))
            .map_err(|e| format!("invalid argon2 params: {e}"))?,
    );
    let mut key = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("key derivation failed: {e}"))?;
    Ok(key)
}

/// 16 random salt bytes.
pub fn new_salt() -> [u8; 16] {
    rand::thread_rng().gen()
}

/// 12 random nonce bytes (AES-GCM standard nonce size).
pub fn new_nonce() -> [u8; 12] {
    rand::thread_rng().gen()
}

/// Encrypt plaintext, returning `nonce(12) || ciphertext+tag`.
pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    encrypt_with_aad(key, plaintext, b"")
}

/// Encrypt with additional authenticated data.
///
/// `aad` is not stored in the blob, but altering it makes decryption fail. The
/// audit log uses this to authenticate each record's *unencrypted* length
/// prefix: without it, editing that prefix looks exactly like a partial write.
pub fn encrypt_with_aad(
    key: &[u8; 32],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = new_nonce();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut out = nonce_bytes.to_vec();
    let ct = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|_| "encryption failed".to_string())?;
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, String> {
    decrypt_with_aad(key, blob, b"")
}

/// Decrypt a blob produced by [`encrypt_with_aad`]. `aad` must match exactly.
pub fn decrypt_with_aad(
    key: &[u8; 32],
    blob: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    if blob.len() < 12 {
        return Err("ciphertext too short".to_string());
    }
    let (nonce_bytes, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), Payload { msg: ct, aad })
        .map_err(|_| "decryption failed (wrong password or corrupt data)".to_string())
}
