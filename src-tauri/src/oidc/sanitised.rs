/// An error code that has been validated against a whitelist of known
/// RFC 6749 and OIDC Core error identifiers. The field is private to this
/// module and inaccessible from the parent, so no code can construct it
/// with raw unsanitised text. Construction only via `WhitelistedCode::new()`,
/// which either returns a known identifier or `"unrecognized"`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WhitelistedCode(String);

impl WhitelistedCode {
    /// Known error codes from RFC 6749 and OIDC Core. Render only these;
    /// anything else becomes `"unrecognized"` to guarantee no secret leakage.
    const ALLOWED: &'static [&'static str] = &[
        // RFC 6749 §4.1.2.1 Authorization Code Grant error responses
        "invalid_request",
        "unauthorized_client",
        "access_denied",
        "unsupported_response_type",
        "invalid_scope",
        "server_error",
        "temporarily_unavailable",
        // OIDC Core 1.0 authentication error codes
        "interaction_required",
        "login_required",
        "account_selection_required",
        "consent_required",
        "invalid_request_uri",
        "invalid_request_object",
        "request_not_supported",
        "request_uri_not_supported",
        "registration_not_supported",
    ];

    /// Create a code that is guaranteed to render safely. If `raw` matches
    /// a known OAuth/OIDC error identifier, it is stored; otherwise the code
    /// is rendered as `"unrecognized"`.
    pub fn new(raw: &str) -> Self {
        if Self::ALLOWED.contains(&raw) {
            Self(raw.to_string())
        } else {
            Self("unrecognized".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for WhitelistedCode {
    /// Forwards to `new()`, so a raw string still only ever produces a
    /// whitelisted identifier or `"unrecognized"` — this is a convenience
    /// (`.into()`) for test expectations that already have a `&str`, not a
    /// second way to bypass the whitelist. Production code still goes
    /// through `OidcError::idp_oauth_error`.
    fn from(raw: &str) -> Self {
        Self::new(raw)
    }
}

impl serde::Serialize for WhitelistedCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Safe: the value is always a whitelisted identifier or "unrecognized".
        self.0.serialize(serializer)
    }
}
