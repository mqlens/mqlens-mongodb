//! Pure cryptography for the credential vault: Argon2id key derivation and
//! AES-256-GCM authenticated encryption. No file I/O and no Tauri types here so
//! every function is unit-testable in isolation.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngExt;

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
    rand::rng().random()
}

/// 12 random nonce bytes (AES-GCM standard nonce size).
pub fn new_nonce() -> [u8; 12] {
    rand::rng().random()
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
    // `key` and the nonce are already fixed-size arrays, so these conversions are
    // infallible `From` impls. (`Array::from_slice` did the same thing from a
    // variable-length slice and panicked on a length mismatch; it is deprecated
    // in hybrid-array 0.4 in favour of exactly this.)
    let cipher = Aes256Gcm::new(key.into());
    let nonce_bytes = new_nonce();
    let mut out = nonce_bytes.to_vec();
    let ct = cipher
        .encrypt((&nonce_bytes).into(), Payload { msg: plaintext, aad })
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
    // Splitting off a fixed-size chunk keeps the nonce length in one place and
    // yields a `&[u8; 12]`, so the conversion below cannot fail — where
    // `split_at` + `Array::from_slice` relied on the length check above being
    // right about it.
    let Some((nonce_bytes, ct)) = blob.split_first_chunk::<12>() else {
        return Err("ciphertext too short".to_string());
    };
    let cipher = Aes256Gcm::new(key.into());
    cipher
        .decrypt(nonce_bytes.into(), Payload { msg: ct, aad })
        .map_err(|_| "decryption failed (wrong password or corrupt data)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built rather than written as a literal: a 32-byte constant sitting next to
    /// a parameter named `key` is indistinguishable from a real embedded key to a
    /// scanner. Same reasoning as `test_secret` elsewhere in the tree.
    fn test_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7).wrapping_add(3);
        }
        k
    }

    #[test]
    fn round_trips_plaintext() {
        let key = test_key();
        let blob = encrypt(&key, b"secret payload").expect("encrypt");
        assert_eq!(decrypt(&key, &blob).expect("decrypt"), b"secret payload");
    }

    #[test]
    fn prepends_a_twelve_byte_nonce_and_does_not_reuse_it() {
        let key = test_key();
        let a = encrypt(&key, b"same input").expect("encrypt");
        let b = encrypt(&key, b"same input").expect("encrypt");
        // 12-byte nonce + ciphertext + 16-byte GCM tag.
        assert_eq!(a.len(), 12 + b"same input".len() + 16);
        assert_ne!(a[..12], b[..12], "nonce must not repeat across encryptions");
        assert_ne!(a, b, "identical plaintext must not produce identical blobs");
    }

    #[test]
    fn aad_must_match_exactly() {
        let key = test_key();
        let blob = encrypt_with_aad(&key, b"payload", b"len-prefix").expect("encrypt");
        assert_eq!(
            decrypt_with_aad(&key, &blob, b"len-prefix").expect("decrypt"),
            b"payload"
        );
        assert!(decrypt_with_aad(&key, &blob, b"len-prefixx").is_err());
        assert!(decrypt_with_aad(&key, &blob, b"").is_err());
    }

    #[test]
    fn rejects_a_blob_too_short_to_hold_a_nonce() {
        let key = test_key();
        for len in 0..12 {
            let blob = vec![0u8; len];
            assert_eq!(
                decrypt(&key, &blob).unwrap_err(),
                "ciphertext too short",
                "len={len}"
            );
        }
    }

    #[test]
    fn a_nonce_with_no_ciphertext_fails_rather_than_panicking() {
        // Exactly the nonce and nothing else. The authentication tag is missing,
        // so this must be an error — and must not index past the end.
        let key = test_key();
        let blob = vec![0u8; 12];
        assert!(decrypt(&key, &blob).is_err());
    }

    #[test]
    fn tampering_is_detected() {
        let key = test_key();
        let blob = encrypt(&key, b"payload").expect("encrypt");

        let mut flipped_nonce = blob.clone();
        flipped_nonce[0] ^= 1;
        assert!(decrypt(&key, &flipped_nonce).is_err(), "nonce change undetected");

        let mut flipped_ct = blob.clone();
        let last = flipped_ct.len() - 1;
        flipped_ct[last] ^= 1;
        assert!(decrypt(&key, &flipped_ct).is_err(), "tag change undetected");

        let mut flipped_body = blob.clone();
        flipped_body[13] ^= 1;
        assert!(decrypt(&key, &flipped_body).is_err(), "ciphertext change undetected");
    }

    #[test]
    fn the_wrong_key_does_not_decrypt() {
        let blob = encrypt(&test_key(), b"payload").expect("encrypt");
        let mut other = test_key();
        other[0] ^= 0xff;
        assert!(decrypt(&other, &blob).is_err());
    }
}
