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

/// Every way human OIDC login can fail, as a closed set. Variants carry no
/// secret material by construction, so a rendered `OidcError` is safe to log
/// and safe to hand to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum OidcError {
    ConsentDenied,
    PortUnavailable,
    BrowserLaunchFailed,
    StateMismatch,
    IdpOauthError { code: String },
    TokenExchangeFailed,
    HostNotAllowed,
    TokenRejected,
    LoginOkPingFailed,
    MissingClientId,
    InsecureEndpoint,
    DiscoveryFailed,
    Cancelled,
    TimedOut,
}

/// Reduce IdP-supplied text to `[a-z0-9_-]`, capped at 40 chars. OAuth error
/// codes are that shape; anything else is not worth rendering.
fn sanitise_code(raw: &str) -> String {
    raw.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(40)
        .collect()
}

impl OidcError {
    pub fn locale_key(&self) -> &'static str {
        match self {
            Self::ConsentDenied => "auth.oidc.errors.consentDenied",
            Self::PortUnavailable => "auth.oidc.errors.portUnavailable",
            Self::BrowserLaunchFailed => "auth.oidc.errors.browserLaunchFailed",
            Self::StateMismatch => "auth.oidc.errors.stateMismatch",
            Self::IdpOauthError { .. } => "auth.oidc.errors.idpOauthError",
            Self::TokenExchangeFailed => "auth.oidc.errors.tokenExchangeFailed",
            Self::HostNotAllowed => "auth.oidc.errors.hostNotAllowed",
            Self::TokenRejected => "auth.oidc.errors.tokenRejected",
            Self::LoginOkPingFailed => "auth.oidc.errors.loginOkPingFailed",
            Self::MissingClientId => "auth.oidc.errors.missingClientId",
            Self::InsecureEndpoint => "auth.oidc.errors.insecureEndpoint",
            Self::DiscoveryFailed => "auth.oidc.errors.discoveryFailed",
            Self::Cancelled => "auth.oidc.errors.cancelled",
            Self::TimedOut => "auth.oidc.errors.timedOut",
        }
    }

    #[cfg(test)]
    pub fn all_for_test() -> Vec<OidcError> {
        vec![
            Self::ConsentDenied,
            Self::PortUnavailable,
            Self::BrowserLaunchFailed,
            Self::StateMismatch,
            Self::IdpOauthError { code: "access_denied".into() },
            Self::TokenExchangeFailed,
            Self::HostNotAllowed,
            Self::TokenRejected,
            Self::LoginOkPingFailed,
            Self::MissingClientId,
            Self::InsecureEndpoint,
            Self::DiscoveryFailed,
            Self::Cancelled,
            Self::TimedOut,
        ]
    }
}

impl std::fmt::Display for OidcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdpOauthError { code } => {
                write!(f, "identity provider returned an OAuth error: {}", sanitise_code(code))
            }
            other => f.write_str(match other {
                Self::ConsentDenied => "the login was denied",
                Self::PortUnavailable => "could not bind a loopback callback port",
                Self::BrowserLaunchFailed => "could not open the system browser",
                Self::StateMismatch => "the login callback did not match this request",
                Self::TokenExchangeFailed => "the token exchange failed",
                Self::HostNotAllowed => "the MongoDB host is outside ALLOWED_HOSTS",
                Self::TokenRejected => "the token was rejected",
                Self::LoginOkPingFailed => "login succeeded but the database ping failed",
                Self::MissingClientId => "the deployment supplied no OIDC client id",
                Self::InsecureEndpoint => "the identity provider endpoint is not HTTPS",
                Self::DiscoveryFailed => "could not read the identity provider's metadata",
                Self::Cancelled => "the login was cancelled",
                Self::TimedOut => "the browser login expired",
                Self::IdpOauthError { .. } => unreachable!("handled above"),
            }),
        }
    }
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

    #[test]
    fn every_error_maps_to_a_distinct_locale_key() {
        let all = OidcError::all_for_test();
        let keys: std::collections::HashSet<&str> =
            all.iter().map(|e| e.locale_key()).collect();
        assert_eq!(keys.len(), all.len(), "locale keys must be 1:1 with variants");
        for key in keys {
            assert!(key.starts_with("auth.oidc.errors."), "unexpected key {key}");
        }
    }

    /// The whole point of the taxonomy: a rendered error is safe to log.
    #[test]
    fn no_error_ever_renders_secret_material() {
        const SECRETS: [&str; 5] = [
            "test-auth-code",
            "test-access-token",
            "test-refresh-token",
            "super-secret-verifier",
            "https://idp.example.com/callback?code=test-auth-code",
        ];
        for error in OidcError::all_for_test() {
            let rendered = format!("{error} | {error:?}");
            for secret in SECRETS {
                assert!(
                    !rendered.contains(secret),
                    "{error:?} leaked {secret}: {rendered}"
                );
            }
        }
    }

    /// An IdP-supplied OAuth error code is attacker-influenced text. Keep it to a
    /// short, boring shape so it cannot smuggle a token or newline into a log.
    #[test]
    fn oauth_error_codes_are_sanitised() {
        let error = OidcError::IdpOauthError {
            code: "access_denied\nBearer test-access-token".to_string(),
        };
        let rendered = format!("{error}");
        assert!(rendered.contains("access_denied"));
        assert!(!rendered.contains("test-access-token"));
        assert!(!rendered.contains('\n'));
    }
}
