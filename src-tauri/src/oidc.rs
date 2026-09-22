//! MONGODB-OIDC support (#430).

use base64::Engine as _;
use rand::RngExt as _;
use sha2::{Digest, Sha256};

mod sanitised;
use sanitised::WhitelistedCode;

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


/// Declare simple error variants, their locale keys, and test data in one place.
/// Adding a variant requires updating exactly one line, and it is impossible
/// for the test data to drift from the enum.
macro_rules! oidc_errors {
    ($($variant:ident => $key:literal),+ $(,)?) => {
        /// Every way human OIDC login can fail, as a closed set. Variants carry no
        /// secret material by construction, so a rendered `OidcError` is safe to log
        /// and safe to hand to the frontend.
        #[derive(Clone, PartialEq, Eq)]
        pub enum OidcError {
            $($variant,)+
            IdpOauthError { code: WhitelistedCode },
        }

        impl std::fmt::Debug for OidcError {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                match self {
                    $(Self::$variant => f.write_str(stringify!($variant)),)+
                    Self::IdpOauthError { code } => {
                        f.debug_struct("IdpOauthError")
                            .field("code", code)
                            .finish()
                    }
                }
            }
        }

        impl serde::Serialize for OidcError {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                match self {
                    $(Self::$variant => {
                        map.serialize_entry("kind", stringify!($variant).to_lowercase().as_str())?;
                    })+
                    Self::IdpOauthError { code } => {
                        map.serialize_entry("kind", "idp_oauth_error")?;
                        map.serialize_entry("code", code)?;
                    }
                }
                map.end()
            }
        }

        impl OidcError {
            pub fn locale_key(&self) -> &'static str {
                match self {
                    $(Self::$variant => $key,)+
                    Self::IdpOauthError { .. } => "auth.oidc.errors.idpOauthError",
                }
            }

            /// Create an IdP OAuth error with the code validated against the
            /// whitelist of known RFC 6749/OIDC error identifiers. Unknown codes
            /// render as "unrecognized" to guarantee no secret material escapes.
            pub fn idp_oauth_error(raw: &str) -> Self {
                Self::IdpOauthError { code: WhitelistedCode::new(raw) }
            }

            #[cfg(test)]
            pub fn all_for_test() -> Vec<OidcError> {
                vec![
                    $(Self::$variant,)+
                    Self::idp_oauth_error("access_denied"),
                ]
            }
        }
    };
}

// Declare all simple variants and their locale keys.
oidc_errors! {
    ConsentDenied => "auth.oidc.errors.consentDenied",
    PortUnavailable => "auth.oidc.errors.portUnavailable",
    BrowserLaunchFailed => "auth.oidc.errors.browserLaunchFailed",
    StateMismatch => "auth.oidc.errors.stateMismatch",
    TokenExchangeFailed => "auth.oidc.errors.tokenExchangeFailed",
    HostNotAllowed => "auth.oidc.errors.hostNotAllowed",
    TokenRejected => "auth.oidc.errors.tokenRejected",
    LoginOkPingFailed => "auth.oidc.errors.loginOkPingFailed",
    MissingClientId => "auth.oidc.errors.missingClientId",
    InsecureEndpoint => "auth.oidc.errors.insecureEndpoint",
    DiscoveryFailed => "auth.oidc.errors.discoveryFailed",
    Cancelled => "auth.oidc.errors.cancelled",
    TimedOut => "auth.oidc.errors.timedOut",
}

impl std::fmt::Display for OidcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            Self::ConsentDenied => "the login was denied",
            Self::PortUnavailable => "could not bind a loopback callback port",
            Self::BrowserLaunchFailed => "could not open the system browser",
            Self::StateMismatch => "the login callback did not match this request",
            Self::IdpOauthError { code } => {
                return write!(f, "identity provider returned an OAuth error: {}", code.as_str());
            }
            Self::TokenExchangeFailed => "the token exchange failed",
            Self::HostNotAllowed => "the MongoDB host is outside ALLOWED_HOSTS",
            Self::TokenRejected => "the token was rejected",
            Self::LoginOkPingFailed => "login succeeded but the database ping failed",
            Self::MissingClientId => "the deployment supplied no OIDC client id",
            Self::InsecureEndpoint => "the identity provider endpoint is not HTTPS",
            Self::DiscoveryFailed => "could not read the identity provider's metadata",
            Self::Cancelled => "the login was cancelled",
            Self::TimedOut => "the browser login expired",
        };
        f.write_str(msg)
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
    /// This test verifies that secrets—including realistic OAuth/OIDC codes
    /// and full URLs—cannot appear in rendered output.
    #[test]
    fn no_error_ever_renders_secret_material() {
        const SECRETS: [&str; 5] = [
            "test-auth-code",
            "test-access-token",
            "test-refresh-token",
            "super-secret-verifier",
            "https://idp.example.com/callback?code=test-auth-code",
        ];

        // Test all variants from all_for_test
        for error in OidcError::all_for_test() {
            let rendered = format!("{error} | {error:?}");
            for secret in SECRETS {
                assert!(
                    !rendered.contains(secret),
                    "{error:?} leaked {secret}: {rendered}"
                );
            }
        }

        // Explicitly test IdpOauthError with realistic secrets. The whitelist
        // guarantees they render as "unrecognized", not as the secret itself.
        for secret in SECRETS {
            let error = OidcError::idp_oauth_error(secret);
            let display = format!("{error}");
            let debug = format!("{error:?}");

            assert!(
                !display.contains(secret),
                "Display leaked {secret} in: {display}"
            );
            assert!(
                !debug.contains(secret),
                "Debug leaked {secret} in: {debug}"
            );
            // Verify unknown codes are rendered as "unrecognized"
            assert!(
                display.contains("unrecognized"),
                "Unknown code should render as 'unrecognized' in: {display}"
            );
        }
    }

    /// The whitelist of known OAuth/OIDC error codes ensures that only
    /// recognized identifiers are rendered. Unknown codes — including
    /// injection attempts — all render as "unrecognized".
    #[test]
    fn oauth_error_codes_are_whitelisted() {
        // Known RFC 6749 error code passes through
        let known = OidcError::idp_oauth_error("access_denied");
        let display = format!("{known}");
        assert!(display.contains("access_denied"));

        // Unknown code renders as unrecognized (guaranteed safe)
        let unknown = OidcError::idp_oauth_error("malicious_error_with_Bearer_token");
        let display = format!("{unknown}");
        assert!(display.contains("unrecognized"));
        assert!(!display.contains("Bearer_token"));
        assert!(!display.contains("malicious"));

        // Injection attempt with newline: still unrecognized and safe
        let injection = OidcError::idp_oauth_error("access_denied\nBearer secret-token");
        let display = format!("{injection}");
        assert!(display.contains("unrecognized"));
        assert!(!display.contains("Bearer"));
        assert!(!display.contains("secret-token"));
    }

    /// Prove that raw text cannot be directly constructed into an error.
    /// `WhitelistedCode` is in a child module with a private field, so the
    /// ONLY way to construct it is via `WhitelistedCode::new()`, which enforces
    /// the whitelist. No code anywhere can write `WhitelistedCode(raw)` directly.
    #[test]
    fn literal_construction_impossible() {
        // These would NOT compile:
        // let _ = WhitelistedCode("secret-code".to_string());
        // Error: tuple struct constructor `WhitelistedCode` is private
        //
        // let _ = OidcError::IdpOauthError {
        //     code: WhitelistedCode("secret-code".to_string())
        // };
        // Error: tuple struct constructor `WhitelistedCode` is private

        // The only way to construct it is via the whitelisting constructor:
        let error = OidcError::idp_oauth_error("secret-code");
        // Unknown codes are rendered as "unrecognized", not the secret
        let debug = format!("{error:?}");
        assert!(!debug.contains("secret-code"), "Debug leaked secret in: {debug}");
        assert!(debug.contains("unrecognized"), "Unknown code should render as unrecognized: {debug}");
    }
}
