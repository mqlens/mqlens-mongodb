//! MONGODB-OIDC support (#430).

use base64::Engine as _;
use rand::RngExt as _;
use sha2::{Digest, Sha256};

pub(crate) const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// A PKCE code verifier. Deliberately opaque: its `Debug` redacts, because a
/// verifier in a log is as good as the authorization code it protects.
#[derive(Clone)]
pub struct PkceVerifier(String);

impl std::fmt::Debug for PkceVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PkceVerifier(<redacted>)")
    }
}

impl PkceVerifier {
    pub fn generate() -> Self {
        let bytes: [u8; 32] = rand::rng().random();
        Self(B64.encode(bytes))
    }

    pub fn from_string(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The S256 challenge: BASE64URL(SHA256(ASCII(verifier))), unpadded.
    pub fn challenge(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.0.as_bytes());
        B64.encode(hasher.finalize())
    }
}

/// 32 CSPRNG bytes, base64url-unpadded. Used for `state` and `nonce`.
pub fn random_token() -> String {
    let bytes: [u8; 32] = rand::rng().random();
    B64.encode(bytes)
}

#[cfg(test)]
pub mod mock_idp;

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7636 Appendix B's worked example. If this drifts, our challenge is
    /// not the one any IdP will compute.
    #[test]
    fn pkce_challenge_matches_the_rfc_7636_vector() {
        let verifier = PkceVerifier::from_string(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_string(),
        );
        assert_eq!(verifier.challenge(), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generated_verifiers_are_high_entropy_and_url_safe() {
        let a = PkceVerifier::generate();
        let b = PkceVerifier::generate();
        assert_ne!(a.as_str(), b.as_str(), "two verifiers must not collide");
        // 32 bytes base64url-unpadded is 43 chars, inside RFC 7636's 43..=128.
        assert_eq!(a.as_str().len(), 43);
        assert!(
            a.as_str().chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "verifier must be base64url with no padding: {}",
            a.as_str()
        );
    }

    #[test]
    fn a_verifier_never_prints_itself() {
        let verifier = PkceVerifier::from_string("super-secret-verifier".to_string());
        let rendered = format!("{:?}", verifier);
        assert!(!rendered.contains("super-secret-verifier"), "got {rendered}");
    }

    #[test]
    fn random_tokens_do_not_repeat() {
        let tokens: std::collections::HashSet<String> =
            (0..64).map(|_| random_token()).collect();
        assert_eq!(tokens.len(), 64);
    }
}
