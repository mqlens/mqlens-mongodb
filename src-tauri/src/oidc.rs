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
#[derive(Clone, PartialEq, Eq)]
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

    /// Test fixtures only (the RFC 7636 vector, redaction checks). A
    /// production verifier always comes from `generate()`.
    #[cfg(test)]
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
    AccessTokenTypeRejected => "auth.oidc.errors.accessTokenTypeRejected",
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
            Self::AccessTokenTypeRejected => "MongoDB refused the access token's type",
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

/// The endpoints an IdP advertises via discovery, both HTTPS-validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub authorization: String,
    pub token: String,
}

/// IdP endpoints must be HTTPS. The loopback exception lives in its own
/// item-level `#[cfg(test)]`-gated function (below), not as an inline `if
/// cfg(test)` check here — a release binary does not compile
/// `loopback_exception`'s body at all, so no refactor of this function can
/// widen the exception into a runtime flag without a release build failing
/// to compile.
pub fn require_secure(url: &str) -> Result<(), OidcError> {
    // A URI scheme is case-insensitive (RFC 3986 §3.1): `HTTPS://` is TLS too.
    if url.get(..8).is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://")) {
        return Ok(());
    }
    #[cfg(test)]
    if loopback_exception(url) {
        return Ok(());
    }
    Err(OidcError::InsecureEndpoint)
}

/// The `http://` loopback exception, used only so tests can run a mock IdP
/// on `127.0.0.1`/`[::1]`. Gated at the item level, not just at its call
/// site in `require_secure`: a release build never compiles this function's
/// body, so relocating this check (or calling it unconditionally) fails to
/// build in release mode rather than merely failing a test that might not
/// notice the move.
#[cfg(test)]
fn loopback_exception(url: &str) -> bool {
    url.starts_with("http://127.0.0.1:") || url.starts_with("http://[::1]:")
}

#[derive(serde::Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
}

/// Fetch `{issuer}/.well-known/openid-configuration` and validate it. The
/// document must name the issuer we asked for, and both endpoints must be
/// HTTPS — an IdP that points us somewhere else is not one we follow.
pub async fn discover(issuer: &str, http: &reqwest::Client) -> Result<Endpoints, OidcError> {
    require_secure(issuer)?;
    let url = format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/'));
    let document: DiscoveryDocument = http
        .get(&url)
        .send()
        .await
        .map_err(|_| OidcError::DiscoveryFailed)?
        .error_for_status()
        .map_err(|_| OidcError::DiscoveryFailed)?
        .json()
        .await
        .map_err(|_| OidcError::DiscoveryFailed)?;

    if document.issuer.trim_end_matches('/') != issuer.trim_end_matches('/') {
        return Err(OidcError::DiscoveryFailed);
    }
    require_secure(&document.authorization_endpoint)?;
    require_secure(&document.token_endpoint)?;

    Ok(Endpoints {
        authorization: document.authorization_endpoint,
        token: document.token_endpoint,
    })
}

/// The HTTP client production logins use to talk to the identity provider.
///
/// - Normal TLS trust, never relaxed — whatever the MongoDB connection's own
///   TLS settings allow. It trusts the bundled public roots and the OS
///   certificate store (reqwest's `rustls-tls` and `rustls-tls-native-roots`),
///   so an IdP behind an internal CA or a TLS-inspecting proxy works.
///   `SSL_CERT_FILE`/`SSL_CERT_DIR`, when set, replace the OS store.
/// - No redirects followed: a `307` from the token endpoint would resend the
///   POST, authorization code and PKCE verifier included, wherever it
///   points — plain `http://` among them.
/// - Every request bounded on its own, well inside the driver's five-minute
///   deadline. `run_flow` races the whole flow against that deadline anyway;
///   these just stop one stuck request from using all of it.
///
/// Keep this a bare `.build()` of `idp_http_client_builder`: the OS-store
/// test (`the_idp_client_also_trusts_the_os_certificate_store`) exercises the
/// builder, so anything added here would go untested.
pub fn idp_http_client() -> Result<reqwest::Client, reqwest::Error> {
    idp_http_client_builder(IDP_CONNECT_TIMEOUT, IDP_REQUEST_TIMEOUT).build()
}

const IDP_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const IDP_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn idp_http_client_builder(
    connect_timeout: std::time::Duration,
    request_timeout: std::time::Duration,
) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(request_timeout)
        .redirect(reqwest::redirect::Policy::none())
}

use mongodb::options::oidc::IdpServerInfo;

#[derive(Debug, PartialEq, Eq)]
pub struct AuthorizationRequest {
    pub url: String,
    pub state: String,
    pub nonce: String,
    pub verifier: PkceVerifier,
}

/// Percent-encode everything that is not an RFC 3986 unreserved character, so
/// a scope or redirect containing `&`, `#` or a space cannot change what the
/// URL means.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{:02X}", other),
        })
        .collect()
}

/// Build the Authorization Code + PKCE request. IdP identity comes from
/// `idp` — the metadata MongoDB handed us — never from the connection editor.
pub fn build_authorization_request(
    endpoints: &Endpoints,
    idp: &IdpServerInfo,
    redirect_uri: &str,
) -> Result<AuthorizationRequest, OidcError> {
    require_secure(&endpoints.authorization)?;
    let client_id = idp.client_id.as_deref().ok_or(OidcError::MissingClientId)?;

    let verifier = PkceVerifier::generate();
    let state = random_token();
    let nonce = random_token();

    let mut scopes = vec!["openid".to_string()];
    for scope in idp.request_scopes.iter().flatten() {
        if scope != "openid" {
            scopes.push(scope.clone());
        }
    }

    let separator = if endpoints.authorization.contains('?') { '&' } else { '?' };
    let url = format!(
        "{base}{separator}response_type=code&client_id={client}&redirect_uri={redirect}\
         &scope={scope}&state={state}&nonce={nonce}&code_challenge={challenge}\
         &code_challenge_method=S256",
        base = endpoints.authorization,
        client = encode(client_id),
        redirect = encode(redirect_uri),
        scope = encode(&scopes.join(" ")),
        state = encode(&state),
        nonce = encode(&nonce),
        challenge = encode(&verifier.challenge()),
    );

    Ok(AuthorizationRequest { url, state, nonce, verifier })
}

/// The query parameters an IdP redirect to `/redirect` carries. `state` is
/// always present in practice (an IdP that omits it fails the constant-time
/// comparison against our expected state, same as any other mismatch), so
/// it is not optional here.
#[derive(Debug, Default)]
struct CallbackParams {
    code: Option<String>,
    state: String,
    error: Option<String>,
}

/// Minimal `application/x-www-form-urlencoded` decoding for the callback's
/// query string: `+` is a space, `%XX` is a byte. Kept local rather than
/// pulled in as a dependency (`axum`'s own decoder lives behind a `query`
/// feature we do not otherwise need) — the values here are IdP-controlled
/// tokens and error codes, not free text, so a minimal decoder is enough.
fn decode_query_value(value: &str) -> String {
    let bytes = value.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16)
            {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_callback_params(query: &str) -> CallbackParams {
    let mut params = CallbackParams::default();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = decode_query_value(value);
        match key {
            "code" => params.code = Some(value),
            "state" => params.state = value,
            "error" => params.error = Some(value),
            _ => {}
        }
    }
    params
}

/// Interpret one callback request against the state we sent. Order matters:
/// a wrong `state` is refused before an `error` or a missing `code` is even
/// considered, because a request whose state does not match ours is not
/// authenticated as a response to *our* login attempt at all.
fn interpret_callback(params: CallbackParams, expected_state: &str) -> Result<String, OidcError> {
    if !crate::mcp::constant_time_eq(params.state.as_bytes(), expected_state.as_bytes()) {
        return Err(OidcError::StateMismatch);
    }
    if let Some(error) = params.error {
        return Err(if error == "access_denied" {
            OidcError::ConsentDenied
        } else {
            OidcError::idp_oauth_error(&error)
        });
    }
    params.code.ok_or(OidcError::TokenExchangeFailed)
}

/// The success page shown in the user's browser after a callback resolves
/// the login. Deliberately inert: no code, token or state appears here —
/// this page is rendered in a real, un-sandboxed browser tab, so anything
/// it echoed would sit in that tab's history and any extension reading the
/// page.
const CALLBACK_SUCCESS_PAGE: &str =
    "<!DOCTYPE html><html><head><title>MQLens</title></head><body>\
     <p>Login complete. You can close this window and return to MQLens.</p>\
     </body></html>";

/// Shown for a callback that is not a completed login — an `error` (denied
/// consent or any other OAuth error) or a request with neither `error` nor
/// `code`. Deliberately generic and, like the other pages, a pure static
/// literal with no interpolation: it must never echo the error code, since
/// that is exactly the material `interpret_callback`/`WhitelistedCode`
/// exist to keep out of anything rendered back to the user.
const CALLBACK_NOT_COMPLETED_PAGE: &str =
    "<!DOCTYPE html><html><head><title>MQLens</title></head><body>\
     <p>Login was not completed. You can close this window and return to MQLens.</p>\
     </body></html>";

/// Shown to a second request against an already-completed callback (a
/// reload, a replay, a second tab) — the first request already took the
/// one-shot sender, so this one never touches it.
const CALLBACK_REPLAY_PAGE: &str =
    "<!DOCTYPE html><html><head><title>MQLens</title></head><body>\
     <p>This login has already completed. You can close this window.</p>\
     </body></html>";

/// Which page a callback calls for, decided before the request is answered.
/// The result itself is decided later, in `wait()` (`interpret_callback`), but
/// the tab only ever sees this page, so it must not say "Login complete" for a
/// request `wait()` will refuse: a denial, a callback with no code, or one whose
/// state is missing or not the state this login sent. Until the listener is
/// told that state (`expect_state`), no callback can be vouched for.
fn callback_outcome_page(params: &CallbackParams, expected_state: Option<&str>) -> &'static str {
    let state_matches = expected_state
        .is_some_and(|expected| crate::mcp::constant_time_eq(params.state.as_bytes(), expected.as_bytes()));
    if state_matches && params.error.is_none() && params.code.is_some() {
        CALLBACK_SUCCESS_PAGE
    } else {
        CALLBACK_NOT_COMPLETED_PAGE
    }
}

/// One callback, from its `application/x-www-form-urlencoded` parameters:
/// the query string of a GET redirect, or the body of a `form_post` POST.
/// Both take the same path, state check and one-shot completion included.
fn handle_callback(
    encoded_params: &str,
    result_tx: std::sync::Arc<StdMutex<Option<oneshot::Sender<CallbackParams>>>>,
    expected_state: &std::sync::OnceLock<String>,
) -> axum::response::Html<&'static str> {
    let params = parse_callback_params(encoded_params);
    let outcome_page = callback_outcome_page(&params, expected_state.get().map(String::as_str));
    let sender = result_tx.lock().expect("callback result mutex poisoned").take();
    match sender {
        Some(tx) => {
            let _ = tx.send(params);
            axum::response::Html(outcome_page)
        }
        None => axum::response::Html(CALLBACK_REPLAY_PAGE),
    }
}

use std::sync::Mutex as StdMutex;
use tokio::sync::oneshot;

/// The loopback port of the redirect MongoDB's own tools register
/// (@mongodb-js/oidc-plugin, behind mongosh and Compass). Identity providers
/// such as Entra ID, and OAuth 2.1, match a redirect URI exactly, port
/// included, so an ephemeral port would be refused; this one lets an existing
/// registration for those tools serve MQLens unchanged.
pub const REDIRECT_PORT: u16 = 27097;

/// The path of that redirect.
const REDIRECT_PATH: &str = "/redirect";

/// The port a login's listener binds. Tests bind ephemeral ports instead, so
/// tests running in parallel don't contend for the one registered port. A
/// compile-time switch, like `loopback_exception`, never a runtime one.
#[cfg(not(test))]
const LISTEN_PORT: u16 = REDIRECT_PORT;
#[cfg(test)]
const LISTEN_PORT: u16 = 0;

/// The redirect URI for a listener on `port`, sent in the authorization
/// request and again, identically, in the token exchange.
fn redirect_uri_for(port: u16) -> String {
    format!("http://localhost:{port}{REDIRECT_PATH}")
}

/// A one-shot HTTP server on the loopback redirect, waiting for exactly one
/// request to [`REDIRECT_PATH`] from the system browser (a GET redirect, or a
/// POST for `response_mode=form_post`). Modeled on the MCP server's own
/// `TcpListener::bind` + `axum::serve(..).with_graceful_shutdown(..)`
/// idiom (`mcp.rs`).
pub struct LoopbackListener {
    pub redirect_uri: String,
    result_rx: StdMutex<Option<oneshot::Receiver<CallbackParams>>>,
    /// Stops every address's server: sending, or dropping the sender,
    /// resolves each one's graceful shutdown.
    shutdown_tx: StdMutex<Option<tokio::sync::watch::Sender<()>>>,
    /// The `state` this login sent, shared with the callback handler so the
    /// page it answers with can check it (see `callback_outcome_page`).
    expected_state: std::sync::Arc<std::sync::OnceLock<String>>,
}

/// Bind `port` (0: any free one) on the loopback addresses `localhost` can
/// resolve to. `127.0.0.1` is required. `::1` is bound too wherever the
/// machine has IPv6 loopback, since a browser may try it first; if another
/// process already holds the port there, the browser could hand that process
/// this login's code, so that is refused like a taken `127.0.0.1`.
async fn bind_loopback(port: u16) -> Result<Vec<tokio::net::TcpListener>, OidcError> {
    // An ephemeral port is picked on 127.0.0.1 and may happen to be taken on
    // ::1; pick again then. A requested port gets one try, and no substitute.
    let attempts = if port == 0 { 5 } else { 1 };
    for _ in 0..attempts {
        let v4 = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|_| OidcError::PortUnavailable)?;
        let bound = v4.local_addr().map_err(|_| OidcError::PortUnavailable)?.port();
        match tokio::net::TcpListener::bind(("::1", bound)).await {
            Ok(v6) => return Ok(vec![v4, v6]),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            // No IPv6 loopback here, so `localhost` cannot resolve to it.
            Err(_) => return Ok(vec![v4]),
        }
    }
    Err(OidcError::PortUnavailable)
}

impl LoopbackListener {
    /// Bind `port` on loopback only (see `bind_loopback`; never a LAN
    /// interface) and start serving [`REDIRECT_PATH`] (GET and POST) in the
    /// background. Logins use [`REDIRECT_PORT`]; a port another process holds
    /// is `PortUnavailable`, never swapped for another. The server accepts
    /// exactly one request that finds the one-shot sender still present;
    /// every later request (replay, reload) gets [`CALLBACK_REPLAY_PAGE`]
    /// instead and does not touch the waiter.
    pub async fn bind(port: u16) -> Result<Self, OidcError> {
        let listeners = bind_loopback(port).await?;
        let port = listeners[0].local_addr().map_err(|_| OidcError::PortUnavailable)?.port();
        let redirect_uri = redirect_uri_for(port);

        let (result_tx, result_rx) = oneshot::channel::<CallbackParams>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(());
        let result_tx = std::sync::Arc::new(StdMutex::new(Some(result_tx)));
        let expected_state = std::sync::Arc::new(std::sync::OnceLock::new());
        let handler_state = std::sync::Arc::clone(&expected_state);

        // GET for the usual redirect (`response_mode=query`); POST for a
        // provider that answers with `response_mode=form_post`, whose
        // parameters are in the body. A POST's query string is not read.
        let (get_tx, get_state) = (std::sync::Arc::clone(&result_tx), std::sync::Arc::clone(&handler_state));
        let router = axum::Router::new().route(
            REDIRECT_PATH,
            axum::routing::get(move |uri: axum::http::Uri| {
                let result_tx = std::sync::Arc::clone(&get_tx);
                let expected_state = std::sync::Arc::clone(&get_state);
                async move { handle_callback(uri.query().unwrap_or(""), result_tx, &expected_state) }
            })
            .post(move |body: String| {
                let result_tx = std::sync::Arc::clone(&result_tx);
                let expected_state = std::sync::Arc::clone(&handler_state);
                async move { handle_callback(&body, result_tx, &expected_state) }
            }),
        );

        for listener in listeners {
            let router = router.clone();
            let mut shutdown_rx = shutdown_rx.clone();
            tokio::spawn(async move {
                if let Err(e) = axum::serve(listener, router.into_make_service())
                    .with_graceful_shutdown(async move {
                        let _ = shutdown_rx.changed().await;
                    })
                    .await
                {
                    eprintln!("oidc::LoopbackListener: axum::serve exited with an error: {e}");
                }
            });
        }

        Ok(Self {
            redirect_uri,
            result_rx: StdMutex::new(Some(result_rx)),
            shutdown_tx: StdMutex::new(Some(shutdown_tx)),
            expected_state,
        })
    }

    /// Tell the listener the `state` this login sent, before the browser is
    /// opened, so the page a callback gets can say "Login complete" only for
    /// a callback `wait()` will accept. Set once; a later call is ignored.
    pub fn expect_state(&self, state: &str) {
        let _ = self.expected_state.set(state.to_string());
    }

    /// Wait for the one callback request, interpret it against
    /// `expected_state`, and return the authorization code. Every exit path
    /// — success, any refusal, or the receiver closing because `shutdown()`
    /// was called first — shuts the listener down before returning, so no
    /// path leaks the bound socket.
    pub async fn wait(self, expected_state: &str) -> Result<String, OidcError> {
        let rx = self.result_rx.lock().expect("result mutex poisoned").take();
        let outcome = match rx {
            Some(rx) => match rx.await {
                Ok(params) => interpret_callback(params, expected_state),
                // The sender was dropped without sending: the server shut
                // down (via `shutdown()`, called before or during this
                // wait) before a callback ever arrived.
                Err(_) => Err(OidcError::Cancelled),
            },
            // Already taken by a previous `wait()` call.
            None => Err(OidcError::Cancelled),
        };
        self.shutdown();
        outcome
    }

    /// Drop the socket immediately. Safe to call more than once (a second
    /// call finds the sender already taken and is a no-op) and safe to call
    /// before `wait()` — `wait()` then sees the closed channel and returns
    /// `Err(OidcError::Cancelled)` promptly rather than hanging.
    pub fn shutdown(&self) {
        if let Some(tx) = self.shutdown_tx.lock().expect("shutdown mutex poisoned").take() {
            let _ = tx.send(());
        }
    }
}

/// A caller that drops a bound `LoopbackListener` without ever calling
/// `wait()` or `shutdown()` — an early `?` on an unrelated error, most
/// likely — must not leave the spawned server task and its bound socket
/// running until the process exits. `shutdown()` is already `&self` and
/// idempotent, so this introduces no new invariant beyond the one
/// `shutdown()` and `wait()` already uphold.
impl Drop for LoopbackListener {
    fn drop(&mut self) {
        self.shutdown();
    }
}

use mongodb::options::oidc::IdpServerResponse;

/// Which of the IdP's tokens the driver hands MongoDB as its credential.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TokenChoice {
    /// The access token — the OAuth credential, and MongoDB's default.
    #[default]
    AccessToken,
    /// The ID token: the profile's "Use ID token instead of access token",
    /// for an IdP whose access tokens MongoDB refuses (mongosh's
    /// `--oidcIdTokenAsAccessToken`).
    IdToken,
}

impl TokenChoice {
    pub fn for_profile(use_id_token: bool) -> Self {
        if use_id_token { Self::IdToken } else { Self::AccessToken }
    }
}

/// Which token a completed login handed the driver — all a later rejection
/// needs to be explained. Carries nothing secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presented {
    /// The access token, with a JWT `typ` MongoDB accepts (or not a JWT at
    /// all, which MongoDB refuses for its own reasons).
    AccessToken,
    /// The access token, with a JWT `typ` MongoDB refuses.
    AccessTokenOfRefusedType,
    /// The ID token.
    IdToken,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

/// Pick the token the driver hands MongoDB, and map the rest of the
/// response onto the driver's type.
///
/// With [`TokenChoice::IdToken`] the ID token becomes the credential, so it
/// must be this login's: its `nonce` claim must equal the one the
/// authorization request sent (`expected_nonce`), compared in constant time.
/// A missing or different nonce is `StateMismatch` — the same meaning for
/// the user as a callback that does not match its request. A refresh sends
/// no nonce, so its ID token is not checked for one (`expected_nonce` is
/// `None`). The signature, issuer and audience are not checked here:
/// MongoDB verifies them against the IdP's keys. The token and its claims
/// are never logged or put in an error.
///
/// `expires_in` is IdP-controlled, so the addition is checked: a value too
/// large to represent as an `Instant` is treated as no expiry at all rather
/// than panicking inside the driver's authentication path. With the ID token
/// as the credential, the expiry is the earlier of `expires_in` and the ID
/// token's own `exp` (see `instant_of_exp`), so the driver never holds on to
/// an ID token MongoDB will already refuse.
fn into_idp_response(
    token: TokenResponse,
    choice: TokenChoice,
    expected_nonce: Option<&str>,
) -> Result<(IdpServerResponse, Presented), OidcError> {
    let expires_in = token.expires_in.and_then(|secs| {
        std::time::Instant::now().checked_add(std::time::Duration::from_secs(secs))
    });
    let (credential, presented, expires) = match choice {
        TokenChoice::AccessToken => {
            let presented = if mongodb_refuses_jwt_type(&token.access_token) {
                Presented::AccessTokenOfRefusedType
            } else {
                Presented::AccessToken
            };
            (token.access_token, presented, expires_in)
        }
        TokenChoice::IdToken => {
            let id_token = token.id_token.ok_or(OidcError::TokenExchangeFailed)?;
            let claims = jwt_segment(&id_token, 1).ok_or(OidcError::TokenExchangeFailed)?;
            if let Some(expected) = expected_nonce {
                let nonce = claims.get("nonce").and_then(|n| n.as_str()).unwrap_or_default();
                if nonce.is_empty() || !crate::mcp::constant_time_eq(nonce.as_bytes(), expected.as_bytes()) {
                    return Err(OidcError::StateMismatch);
                }
            }
            // `expires_in` describes the access token. MongoDB checks the ID
            // token, so the driver must drop it by the ID token's own `exp`
            // when that comes first.
            let expires = match (expires_in, instant_of_exp(claims.get("exp"))) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            (id_token, Presented::IdToken, expires)
        }
    };
    let response = IdpServerResponse::builder()
        .access_token(credential)
        .expires(expires)
        .refresh_token(token.refresh_token)
        .build();
    Ok((response, presented))
}

/// A JWT `exp` claim (NumericDate: seconds since the Unix epoch, possibly
/// fractional) as an `Instant`. IdP-controlled, so every step is checked:
/// a missing or non-numeric `exp` is `None`; one already past is now, the
/// earliest instant there is; one too far out to represent is `None`, no
/// bound at all, like an absurd `expires_in`.
fn instant_of_exp(exp: Option<&serde_json::Value>) -> Option<std::time::Instant> {
    let exp = exp?.as_f64().filter(|secs| secs.is_finite())?;
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs_f64();
    let now = std::time::Instant::now();
    let remaining = exp - now_unix;
    if remaining <= 0.0 {
        return Some(now);
    }
    now.checked_add(std::time::Duration::try_from_secs_f64(remaining).ok()?)
}

/// Segment `index` of a compact JWS (0: the JOSE header, 1: the claims),
/// base64url-decoded and parsed as a JSON object. `None` for anything that
/// is not a three-segment JWS with a JSON object there. Nothing is verified.
fn jwt_segment(token: &str, index: usize) -> Option<serde_json::Map<String, serde_json::Value>> {
    let segments: Vec<&str> = token.split('.').collect();
    if segments.len() != 3 {
        return None;
    }
    let bytes = B64.decode(segments[index]).ok()?;
    match serde_json::from_slice(&bytes).ok()? {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Whether MongoDB's JWT parser will refuse `token` for its header's `typ`.
/// MongoDB (`src/mongo/crypto/jws_validated_token.cpp`) accepts a `typ` that
/// is absent or exactly `"JWT"`, and nothing else — RFC 9068 access tokens
/// (`"at+jwt"`, as cidaas issues) included. MongoDB tells the client only
/// "Authentication failed.", so this is how a rejection is explained. A
/// token that is not a JWT is refused for other reasons: `false`.
///
/// Limits of the hint this drives (`AccessTokenTypeRejected`):
/// - It is accurate only while MongoDB keeps that check (error 7095401,
///   `jws_validated_token.cpp:98`). Should a MongoDB release accept `at+jwt`,
///   the hint could name a cause that no longer applies. Re-check it on
///   upgrades.
/// - MongoDB reads the token's body (`iss`/`aud`, to pick the identity
///   provider) before it checks `typ`. An `at+jwt` token that also has a
///   wrong issuer or audience fails that body check first, yet still gets
///   the hint, because MQLens cannot see which check failed.
/// - So the advice ("use the ID token") is always a necessary fix for such a
///   token, but not always a sufficient one.
fn mongodb_refuses_jwt_type(token: &str) -> bool {
    jwt_segment(token, 0).is_some_and(|header| match header.get("typ") {
        None => false,
        Some(typ) => typ.as_str() != Some("JWT"),
    })
}

/// POST the form and map the response. Every failure collapses to
/// `TokenExchangeFailed`: the underlying reqwest error can carry the request
/// URL, which carries the code, so it must not reach the error.
async fn post_token_form(
    endpoints: &Endpoints,
    form: &[(&str, &str)],
    http: &reqwest::Client,
    choice: TokenChoice,
    expected_nonce: Option<&str>,
) -> Result<(IdpServerResponse, Presented), OidcError> {
    require_secure(&endpoints.token)?;
    let response = http
        .post(&endpoints.token)
        .form(form)
        .send()
        .await
        .map_err(|_| OidcError::TokenExchangeFailed)?;
    if !response.status().is_success() {
        return Err(OidcError::TokenExchangeFailed);
    }
    let token: TokenResponse = response.json().await.map_err(|_| OidcError::TokenExchangeFailed)?;
    into_idp_response(token, choice, expected_nonce)
}

/// Exchange an authorization code (with its PKCE verifier) for tokens, and
/// pick the one the driver gets. `nonce` is the one this login's
/// authorization request sent; an ID token must carry it.
#[allow(clippy::too_many_arguments)]
pub async fn exchange_code(
    endpoints: &Endpoints,
    client_id: &str,
    code: &str,
    verifier: &PkceVerifier,
    redirect_uri: &str,
    http: &reqwest::Client,
    choice: TokenChoice,
    nonce: &str,
) -> Result<(IdpServerResponse, Presented), OidcError> {
    post_token_form(
        endpoints,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier.as_str()),
        ],
        http,
        choice,
        Some(nonce),
    )
    .await
}

/// Use a refresh token to obtain a new token of `choice`'s kind.
pub async fn refresh_token(
    endpoints: &Endpoints,
    client_id: &str,
    refresh: &str,
    http: &reqwest::Client,
    choice: TokenChoice,
) -> Result<(IdpServerResponse, Presented), OidcError> {
    let (mut response, presented) = post_token_form(
        endpoints,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", client_id),
        ],
        http,
        choice,
        None,
    )
    .await?;
    // A provider that does not rotate refresh tokens answers without one, and
    // the one just used stays valid. The driver caches whatever this response
    // carries in place of its old one, so hand that one back rather than
    // leave the next expiry to a browser login.
    if response.refresh_token.is_none() {
        response.refresh_token = Some(refresh.to_string());
    }
    Ok((response, presented))
}

use mongodb::options::oidc::CallbackContext;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What the UI is told as a login attempt progresses. Carries no secret
/// material: `Failed` wraps an `OidcError`, which is itself constructed to
/// never contain a token, code or verifier.
#[derive(Debug)]
pub enum OidcPhase {
    WaitingForBrowser,
    /// The IdP handed over a token and the flow gave it to the driver —
    /// before MongoDB has seen it.
    Completed(Presented),
    Failed(OidcError),
}

/// How the flow reports phase changes back to whatever is driving it (the
/// Tauri command layer in production, a recording closure in tests).
pub type PhaseSink = Arc<dyn Fn(OidcPhase) + Send + Sync>;

/// How the flow asks something outside itself to open a URL in the user's
/// browser. Synchronous because a real browser launcher (`open::that` and
/// similar) is synchronous; it only has to hand the OS a URL to open, not
/// wait for the login to finish.
pub type BrowserOpener = Arc<dyn Fn(&str) -> Result<(), OidcError> + Send + Sync>;

/// One login attempt's shared state. The driver calls our callback from its
/// own task, so this is how the UI learns a browser is waiting and how a
/// cancel gets back down into the flow.
pub struct OidcSession {
    cancelled: AtomicBool,
    authorization_url: StdMutex<Option<String>>,
    sink: PhaseSink,
}

impl OidcSession {
    pub fn new(sink: PhaseSink) -> Arc<Self> {
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            authorization_url: StdMutex::new(None),
            sink,
        })
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Forget a cancel. Only for `LoginRegistration`'s drop: once a login's
    /// entry is gone nothing can cancel it, and a stale flag would fail the
    /// kept client's next re-login before it starts.
    pub(crate) fn clear_cancel(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// The URL the browser was sent to, so the UI can offer "Open browser
    /// again" without rebuilding the request (which would rotate `state`).
    pub fn authorization_url(&self) -> Option<String> {
        self.authorization_url.lock().ok()?.clone()
    }

    pub(crate) fn set_authorization_url(&self, url: String) {
        *self.authorization_url.lock().expect("authorization_url mutex poisoned") = Some(url);
    }

    fn emit(&self, phase: OidcPhase) {
        (self.sink)(phase);
    }
}

/// Poll `session.is_cancelled()` until it flips, for racing inside
/// `tokio::select!`. 100ms is frequent enough that a cancel is noticed
/// promptly without spinning.
async fn wait_for_cancel(session: &OidcSession) {
    loop {
        if session.is_cancelled() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Resolve at `deadline`, or never if there is none — letting `tokio::select!`
/// treat "no deadline" as simply disabling that race arm.
async fn wait_for_deadline(deadline: Option<std::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await,
        None => std::future::pending().await,
    }
}

/// The orchestrated MONGODB-OIDC human flow: the single function the
/// MongoDB driver's callback calls. Tries a cached refresh token first (no
/// browser); falls back to a full interactive Authorization Code + PKCE
/// login raced against the deadline the driver gave us and against the
/// session being cancelled.
///
/// Every exit path reports to `session`'s `PhaseSink` exactly once: `Failed`
/// on any error, `Completed` on success. A successful refresh reports
/// `Completed` alone, with no `WaitingForBrowser` — the whole point of the
/// refresh grant is that no browser is ever involved.
pub async fn run_flow(
    ctx: CallbackContext,
    session: Arc<OidcSession>,
    open: BrowserOpener,
    http: reqwest::Client,
    choice: TokenChoice,
) -> Result<IdpServerResponse, OidcError> {
    // The whole body — discovery, refresh, the browser wait and the code
    // exchange — runs under the driver's deadline and the session's cancel
    // (spec: "the whole callback body runs under timeout_at(ctx.timeout)
    // raced against the session's cancel flag"). The driver passes the
    // deadline in but never enforces it, and during a reauth it holds the
    // client's credential-cache lock while this runs, so an IdP that hangs
    // mid-request must not be able to hang the login with it.
    //
    // `biased;` with the flow first, for the same reason as the listener
    // race in `run_flow_inner`: an outcome the flow already has in the same
    // wake as the deadline or a cancel is the real answer and must not be
    // discarded by a random tie-break. Losing arms drop the flow future, and
    // with it any bound `LoopbackListener`, whose `Drop` releases the port.
    let deadline = ctx.timeout;
    let result = tokio::select! {
        biased;
        result = run_flow_inner(ctx, &session, open, http, choice) => result,
        _ = wait_for_deadline(deadline) => Err(OidcError::TimedOut),
        _ = wait_for_cancel(&session) => Err(OidcError::Cancelled),
    };
    match result {
        Ok((response, presented)) => {
            session.emit(OidcPhase::Completed(presented));
            Ok(response)
        }
        Err(error) => {
            session.emit(OidcPhase::Failed(error.clone()));
            Err(error)
        }
    }
}

async fn run_flow_inner(
    ctx: CallbackContext,
    session: &OidcSession,
    open: BrowserOpener,
    http: reqwest::Client,
    choice: TokenChoice,
) -> Result<(IdpServerResponse, Presented), OidcError> {
    let idp = ctx.idp_info.ok_or(OidcError::DiscoveryFailed)?;
    let endpoints = discover(&idp.issuer, &http).await?;
    let client_id = idp.client_id.clone().ok_or(OidcError::MissingClientId)?;

    // A cached refresh token is tried first and never opens a browser. A
    // rejected refresh (expired, revoked) is not returned as an error here —
    // it falls through to the interactive flow below.
    if let Some(refresh) = ctx.refresh_token.as_deref() {
        if let Ok(response) = refresh_token(&endpoints, &client_id, refresh, &http, choice).await {
            return Ok(response);
        }
    }

    let listener = LoopbackListener::bind(LISTEN_PORT).await?;
    let request = build_authorization_request(&endpoints, &idp, &listener.redirect_uri)?;
    // Before the browser opens, so even a callback that beats `wait()` gets
    // the page its state earns.
    listener.expect_state(&request.state);
    // Captured before `listener` is moved into `wait()` below.
    let redirect_uri = listener.redirect_uri.clone();

    // `run_flow`'s race notices a cancel only on its next poll tick, and
    // once discovery (or a rejected refresh) resolves, this function runs
    // straight to `open()` without yielding. A cancel that landed in that
    // gap must still never put a login page in front of the user.
    if session.is_cancelled() {
        return Err(OidcError::Cancelled);
    }
    session.set_authorization_url(request.url.clone());
    session.emit(OidcPhase::WaitingForBrowser);
    open(&request.url)?;

    // `listener.wait(..)` consumes the listener. If a different arm wins,
    // tokio::select! drops this future (and the listener with it) before
    // running that arm's body — `LoopbackListener`'s `Drop` impl already
    // shuts the socket down, so no explicit shutdown call is needed on the
    // timeout/cancel paths. On the winning `wait()` path, `wait()` itself
    // shuts down before returning (Task 6).
    //
    // `biased;` with the listener arm listed first: a plain `tokio::select!`
    // breaks ties among branches that are ready in the *same* poll at
    // random, not by declaration order. With `biased`, a callback that has
    // already arrived beats a deadline that elapsed or a cancel that landed
    // in that same wake, and the deadline/cancel arms still fire normally
    // whenever the callback genuinely has not arrived.
    //
    // That settles the login only when the callback needs no further I/O:
    // a denial, or a state mismatch, is reported as itself rather than as
    // `TimedOut` or `Cancelled`. An authorization code is not protected this
    // way. Its exchange below is more I/O inside `run_flow`'s whole-body
    // race, so a deadline or cancel that is ready when the exchange first
    // waits still wins there, and the code is discarded. The spec accepts
    // that: the whole callback body runs under the deadline and the cancel.
    let code = tokio::select! {
        biased;
        result = listener.wait(&request.state) => result?,
        _ = wait_for_deadline(ctx.timeout) => return Err(OidcError::TimedOut),
        _ = wait_for_cancel(session) => return Err(OidcError::Cancelled),
    };

    exchange_code(&endpoints, &client_id, &code, &request.verifier, &redirect_uri, &http, choice, &request.nonce).await
}

use futures::future::FutureExt as _;
use mongodb::options::oidc::Callback;
use mongodb::options::{AuthMechanism, ClientOptions};

/// Attach the human OIDC callback — and only for `MONGODB-OIDC`. Every other
/// mechanism is left exactly as parsed.
///
/// `config` is the profile's OIDC settings, whole, so a new setting reaches
/// the flow without another parameter here. Its `allowed_hosts` is applied
/// here rather than in the URI because `ClientOptions::parse` rejects
/// `ALLOWED_HOSTS` outright. An empty list leaves the driver's own secure
/// defaults in place; we never broaden them. Its `use_id_token` picks the
/// token the flow hands the driver.
///
/// `http` is injected rather than built here so callers can supply a client
/// with different TLS trust (e.g. a test's self-signed CA) without this
/// function ever touching the MongoDB connection's own TLS settings.
///
/// The callback attachment itself is not observable through driver 3.9.0's
/// public API — `Callback`'s internals are `pub(crate)`, so nothing outside
/// the driver crate can distinguish an attached human callback from the
/// default one just by inspecting `ClientOptions` afterward. That the
/// closure actually reaches `run_flow` is proven only by a real handshake
/// (Task 10), not by any test in this module.
pub fn attach_human_callback(
    options: &mut ClientOptions,
    session: Arc<OidcSession>,
    config: &crate::connections::OidcProfileConfig,
    open: BrowserOpener,
    http: reqwest::Client,
) {
    let Some(credential) = options.credential.as_mut() else {
        return;
    };
    if credential.mechanism != Some(AuthMechanism::MongoDbOidc) {
        return;
    }

    if !config.allowed_hosts.is_empty() {
        let hosts: mongodb::bson::Array = config
            .allowed_hosts
            .iter()
            .map(|host| mongodb::bson::Bson::String(host.clone()))
            .collect();
        let properties = credential
            .mechanism_properties
            .get_or_insert_with(mongodb::bson::Document::new);
        properties.insert("ALLOWED_HOSTS", hosts);
    }

    let choice = TokenChoice::for_profile(config.use_id_token);
    credential.oidc_callback = Callback::human(move |context: CallbackContext| {
        let session = session.clone();
        let open = open.clone();
        let http = http.clone();
        async move {
            run_flow(context, session, open, http, choice)
                .await
                .map_err(to_driver_error)
        }
        .boxed()
    });
}

/// The MongoDB driver's `ALLOWED_HOSTS` when a profile sets none. A copy of
/// mongodb 3.9.0's private `DEFAULT_ALLOWED_HOSTS`
/// (`src/client/auth/oidc.rs:52-61`); re-check it on a driver upgrade.
const DRIVER_DEFAULT_ALLOWED_HOSTS: &[&str] = &[
    "*.mongodb.net",
    "*.mongodb-qa.net",
    "*.mongodb-dev.net",
    "*.mongodbgov.net",
    "localhost",
    "127.0.0.1",
    "::1",
    "*.mongo.com",
];

/// Whether the driver would let a human OIDC login go ahead against `host`,
/// given a profile's custom `allowed_hosts` (empty: the driver's defaults).
///
/// For a connection through an SSH tunnel, whose real host the driver never
/// sees. It must decide exactly as the driver would, so it replicates mongodb
/// 3.9.0's private `validate_address_with_allowed_hosts`
/// (`src/client/auth/oidc.rs:773-794`, with `get_allowed_hosts` at `:752-771`):
/// a pattern equal to the host, or a `*.`-prefixed pattern the host ends with
/// minus its `*`. The host is normalised first by the driver's own
/// `ServerAddress::parse` (`src/client/options.rs:233-332`), as every
/// connection address is: an IP in canonical form without brackets, a host
/// name lowercased. Patterns are compared verbatim, as the driver compares
/// them. A host the driver could not parse is never allowed.
pub fn host_is_allowed(host: &str, allowed_hosts: &[String]) -> bool {
    let Ok(mongodb::options::ServerAddress::Tcp { host, .. }) = mongodb::options::ServerAddress::parse(host) else {
        return false;
    };
    let matches = |pattern: &str| pattern == host || (pattern.starts_with("*.") && host.ends_with(&pattern[1..]));
    if allowed_hosts.is_empty() {
        DRIVER_DEFAULT_ALLOWED_HOSTS.iter().any(|pattern| matches(pattern))
    } else {
        allowed_hosts.iter().any(|pattern| matches(pattern))
    }
}

/// Map our taxonomy onto a driver error. The message is the category only —
/// `OidcError::Display` is already safe to surface.
fn to_driver_error(error: OidcError) -> mongodb::error::Error {
    mongodb::error::Error::custom(format!("{error}"))
}

#[cfg(test)]
pub mod mock_idp;

#[cfg(test)]
mod handshake_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use mock_idp::MockIdp;

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

    /// A verifier must only ever come from `generate()` in production: one
    /// built from a caller-chosen string is predictable. `from_string` exists
    /// for the RFC vector above and similar fixtures, so it is compiled into
    /// test builds only — a production caller then fails to build in release.
    #[test]
    fn a_verifier_can_be_built_from_a_string_only_in_tests() {
        // Normalised: a Windows checkout with core.autocrlf=true has CRLF.
        let source = include_str!("oidc.rs").replace("\r\n", "\n");
        let production_source = source
            .split("\n#[cfg(test)]\nmod tests {")
            .next()
            .expect("mod tests must exist");
        assert!(
            production_source.contains("    #[cfg(test)]\n    pub fn from_string("),
            "PkceVerifier::from_string must carry an item-level #[cfg(test)]"
        );
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

    /// Every key the Rust side can emit must be one the frontend can
    /// translate, in every shipped language, and one the i18n scanner is told
    /// about (the keys are only ever read dynamically, so it cannot find them
    /// on its own) — and no catalog may carry an `auth.oidc.errors.*` key the
    /// Rust side never emits. `all_for_test()` is generated by the same macro
    /// as the enum, so a new variant is covered here without touching this
    /// test.
    #[test]
    fn every_error_key_is_translated_in_every_language_and_known_to_the_i18n_config() {
        const CATALOGS: [(&str, &str); 3] = [
            ("en", include_str!("../../src/locales/en/connections.json")),
            ("de", include_str!("../../src/locales/de/connections.json")),
            ("zh-Hans", include_str!("../../src/locales/zh-Hans/connections.json")),
        ];
        const I18N_CONFIG: &str = include_str!("../../i18next.config.ts");
        const PREFIX: &str = "auth.oidc.errors.";

        let emitted: std::collections::BTreeSet<&str> =
            OidcError::all_for_test().iter().map(|e| e.locale_key()).collect();

        for (language, raw) in CATALOGS {
            let catalog: serde_json::Value = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("{language}/connections.json is not JSON: {e}"));
            let errors = catalog
                .pointer("/auth/oidc/errors")
                .and_then(serde_json::Value::as_object)
                .unwrap_or_else(|| panic!("{language}/connections.json has no auth.oidc.errors object"));
            let translated: std::collections::BTreeSet<String> =
                errors.keys().map(|k| format!("{PREFIX}{k}")).collect();
            for key in &emitted {
                let message = errors.get(&key[PREFIX.len()..]).and_then(serde_json::Value::as_str);
                assert!(
                    message.is_some_and(|m| !m.trim().is_empty()),
                    "{language}/connections.json has no message for {key}"
                );
            }
            let extras: Vec<&String> = translated.iter().filter(|k| !emitted.contains(k.as_str())).collect();
            assert!(extras.is_empty(), "{language}/connections.json has keys no OidcError emits: {extras:?}");
        }

        for key in &emitted {
            assert!(
                I18N_CONFIG.contains(&format!("'connections:{key}'")),
                "i18next.config.ts does not list connections:{key}"
            );
        }
        let listed: Vec<&str> = I18N_CONFIG
            .split("'connections:")
            .skip(1)
            .filter_map(|rest| rest.split('\'').next())
            .filter(|key| key.starts_with(PREFIX))
            .filter(|key| !emitted.contains(key))
            .collect();
        assert!(listed.is_empty(), "i18next.config.ts lists keys no OidcError emits: {listed:?}");
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

    #[test]
    fn plain_http_endpoints_are_refused() {
        assert_eq!(
            require_secure("http://idp.example.com/authorize"),
            Err(OidcError::InsecureEndpoint)
        );
        assert_eq!(require_secure("https://idp.example.com/authorize"), Ok(()));
    }

    /// A URI scheme is case-insensitive (RFC 3986 §3.1), so an upper- or
    /// mixed-case `https` is still TLS; an upper-case `http` is still not
    /// (PR #433 review).
    #[test]
    fn the_https_scheme_is_recognised_in_any_case() {
        assert_eq!(require_secure("HTTPS://idp.example.com/authorize"), Ok(()));
        assert_eq!(require_secure("Https://idp.example.com/authorize"), Ok(()));
        assert_eq!(require_secure("HTTP://idp.example.com/authorize"), Err(OidcError::InsecureEndpoint));
        assert_eq!(require_secure("https:/idp.example.com/authorize"), Err(OidcError::InsecureEndpoint));
    }

    /// The loopback exception exists only so tests can run a mock IdP. It is
    /// `#[cfg(test)]`-gated, so this passing here says nothing about release
    /// builds — `the_http_exception_is_compile_time_only` below is the real
    /// guard.
    #[test]
    fn loopback_http_is_allowed_in_tests_only() {
        assert_eq!(require_secure("http://127.0.0.1:8080/authorize"), Ok(()));
        // Not loopback, still refused even under cfg(test).
        assert_eq!(
            require_secure("http://10.0.0.5:8080/authorize"),
            Err(OidcError::InsecureEndpoint)
        );
    }

    #[tokio::test]
    async fn discovery_reads_the_endpoints_the_idp_advertises() {
        let idp = MockIdp::start();
        let http = reqwest::Client::new();
        let endpoints = discover(&idp.issuer(), &http).await.unwrap();
        assert_eq!(endpoints.authorization, format!("{}/authorize", idp.issuer()));
        assert_eq!(endpoints.token, format!("{}/token", idp.issuer()));
    }

    /// The brief's original version of this test swapped `127.0.0.1` for
    /// `localhost` in the requested issuer URL. That exercises scheme
    /// validation (`localhost` is not loopback-whitelisted, so it would
    /// have failed as `InsecureEndpoint`, not `DiscoveryFailed`) rather than
    /// issuer matching. This version keeps the request on `127.0.0.1` and
    /// makes the *document* lie about its own issuer instead, which is the
    /// actual defence under test: an IdP claiming to be someone else.
    #[tokio::test]
    async fn discovery_rejects_an_issuer_that_does_not_match_itself() {
        let idp = MockIdp::start();
        idp.lie_about_issuer();
        let http = reqwest::Client::new();
        assert_eq!(discover(&idp.issuer(), &http).await, Err(OidcError::DiscoveryFailed));
    }

    /// Guards the release-build guarantee that endpoint validation has no
    /// runtime-reachable `http://` acceptance path. Both checks scan only
    /// the *production* portion of this file — everything before `mod
    /// tests` — deliberately excluding the test module itself, whose own
    /// doc comments (like this one) legitimately discuss the very
    /// substrings the scan looks for; scanning them would make this test
    /// fail on its own explanation rather than on a real bypass. Two
    /// checks, deliberately different in kind:
    ///
    /// 1. Structural: `loopback_exception` — the only place in this module
    ///    that accepts a plain `http://` URL — must carry an item-level
    ///    `#[cfg(test)]`. That property is enforced by the compiler, not by
    ///    this test: a release build does not compile that function's body
    ///    at all, so a future refactor that extracts the check into a
    ///    helper and calls it unconditionally (the bypass a bare `if
    ///    cfg(test)` inline check was vulnerable to) fails to *build* in
    ///    release mode, regardless of whether this test still passes.
    /// 2. Textual, as a backstop over the whole production span
    ///    (deliberately not scoped to one function's span, so moving code
    ///    elsewhere in the module cannot hide it): no environment-variable
    ///    lookup appears anywhere, so nobody has turned the exception into
    ///    a runtime flag.
    ///
    /// This does not prove no *other*, differently-named helper could ever
    /// accept `http://` unconditionally — no text scan can rule that out.
    /// It proves this specific exception cannot be relocated out from under
    /// its gate without a release build breaking.
    #[test]
    fn the_http_exception_is_compile_time_only() {
        // Normalised: a Windows checkout with core.autocrlf=true has CRLF.
        let source = include_str!("oidc.rs").replace("\r\n", "\n");
        let production_source = source
            .split("\n#[cfg(test)]\nmod tests {")
            .next()
            .expect("mod tests must exist");
        assert!(
            production_source.contains("#[cfg(test)]\nfn loopback_exception"),
            "the http:// loopback exception must be its own item-level \
             #[cfg(test)]-gated function, not just an `if` inside \
             require_secure — an item-level gate means a release build \
             fails to compile if the check is ever called from outside \
             #[cfg(test)]"
        );
        assert!(
            !production_source.contains("env::var") && !production_source.contains("env!"),
            "the http:// exception must never be reachable at runtime via an environment variable"
        );
    }

    fn test_endpoints() -> Endpoints {
        Endpoints {
            authorization: "https://idp.example.com/authorize".into(),
            token: "https://idp.example.com/token".into(),
        }
    }

    fn idp_info(client_id: Option<&str>, scopes: Option<Vec<&str>>) -> IdpServerInfo {
        IdpServerInfo::builder()
            .issuer("https://idp.example.com".to_string())
            .client_id(client_id.map(str::to_string))
            .request_scopes(scopes.map(|s| s.into_iter().map(str::to_string).collect()))
            .build()
    }

    #[test]
    fn the_authorization_url_carries_everything_the_idp_needs() {
        let request = build_authorization_request(
            &test_endpoints(),
            &idp_info(Some("client-abc"), Some(vec!["profile"])),
            "http://127.0.0.1:41234/callback",
        )
        .unwrap();

        let url = url_params(&request.url);
        assert_eq!(url.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(url.get("client_id").map(String::as_str), Some("client-abc"));
        assert_eq!(
            url.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:41234/callback")
        );
        assert_eq!(url.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(url.get("code_challenge"), Some(&request.verifier.challenge()));
        assert_eq!(url.get("state"), Some(&request.state));
        assert_eq!(url.get("nonce"), Some(&request.nonce));
        // `openid` is always requested; the IdP's own scopes are added to it.
        let scope = url.get("scope").cloned().unwrap_or_default();
        assert!(scope.split(' ').any(|s| s == "openid"), "got {scope}");
        assert!(scope.split(' ').any(|s| s == "profile"), "got {scope}");
    }

    #[test]
    fn the_verifier_never_appears_in_the_authorization_url() {
        let request = build_authorization_request(
            &test_endpoints(),
            &idp_info(Some("client-abc"), None),
            "http://127.0.0.1:41234/callback",
        )
        .unwrap();
        assert!(
            !request.url.contains(request.verifier.as_str()),
            "the verifier must stay local until the token exchange"
        );
    }

    #[test]
    fn a_deployment_without_a_client_id_fails_loudly() {
        assert_eq!(
            build_authorization_request(
                &test_endpoints(),
                &idp_info(None, None),
                "http://127.0.0.1:41234/callback",
            ),
            Err(OidcError::MissingClientId)
        );
    }

    #[test]
    fn two_requests_never_share_state_nonce_or_verifier() {
        let a = build_authorization_request(&test_endpoints(), &idp_info(Some("c"), None), "http://127.0.0.1:1/callback").unwrap();
        let b = build_authorization_request(&test_endpoints(), &idp_info(Some("c"), None), "http://127.0.0.1:1/callback").unwrap();
        assert_ne!(a.state, b.state);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.verifier.as_str(), b.verifier.as_str());
    }

    /// Minimal query parser so the assertions above read as data, not regex.
    fn url_params(url: &str) -> std::collections::HashMap<String, String> {
        url.split_once('?')
            .map(|(_, query)| query)
            .unwrap_or("")
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| {
                (
                    k.to_string(),
                    percent_decode(v),
                )
            })
            .collect()
    }

    async fn get(url: &str) -> reqwest::Response {
        reqwest::Client::new().get(url).send().await.unwrap()
    }

    #[tokio::test]
    async fn a_matching_callback_yields_the_authorization_code() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        assert!(redirect.starts_with("http://localhost:") && redirect.ends_with("/redirect"), "got {redirect}");

        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let response = get(&format!("{redirect}?code=test-auth-code&state=state-abc")).await;

        assert!(response.status().is_success());
        let page = response.text().await.unwrap();
        assert!(!page.contains("test-auth-code"), "the success page must not echo the code");

        assert_eq!(waiter.await.unwrap(), Ok("test-auth-code".to_string()));
    }

    #[tokio::test]
    async fn a_mismatched_state_is_refused() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        get(&format!("{redirect}?code=test-auth-code&state=state-WRONG")).await;
        assert_eq!(waiter.await.unwrap(), Err(OidcError::StateMismatch));
    }

    #[tokio::test]
    async fn an_oauth_error_is_reported_as_denied_consent() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        get(&format!("{redirect}?error=access_denied&state=state-abc")).await;
        assert_eq!(waiter.await.unwrap(), Err(OidcError::ConsentDenied));
    }

    #[tokio::test]
    async fn other_oauth_errors_keep_their_code() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        get(&format!("{redirect}?error=invalid_scope&state=state-abc")).await;
        assert_eq!(
            waiter.await.unwrap(),
            Err(OidcError::IdpOauthError { code: "invalid_scope".into() })
        );
    }

    #[tokio::test]
    async fn the_wrong_path_is_not_the_callback() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let base = listener.redirect_uri.replace("/redirect", "");
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let response = get(&format!("{base}/?code=test-auth-code&state=state-abc")).await;
        assert_eq!(response.status(), 404);
        // Nor is the old `/callback` path.
        let response = get(&format!("{base}/callback?code=test-auth-code&state=state-abc")).await;
        assert_eq!(response.status(), 404);
        // The real callback still works afterwards.
        get(&format!("{base}/redirect?code=test-auth-code&state=state-abc")).await;
        assert_eq!(waiter.await.unwrap(), Ok("test-auth-code".to_string()));
    }

    // ---- the registered redirect (PR #433 review) ------------------------

    /// Identity providers such as Entra ID match the redirect URI exactly,
    /// port included. MQLens uses the one MongoDB's own tools register
    /// (@mongodb-js/oidc-plugin, behind mongosh and Compass), so their
    /// existing app registration works unchanged.
    #[test]
    fn the_redirect_is_the_one_mongodbs_own_tools_register() {
        assert_eq!(REDIRECT_PORT, 27097);
        assert_eq!(redirect_uri_for(REDIRECT_PORT), "http://localhost:27097/redirect");
    }

    /// A free port, released again, for a test to bind by number.
    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn a_listener_on_a_given_port_serves_the_redirect_there_as_localhost() {
        let port = free_port();
        let listener = LoopbackListener::bind(port).await.unwrap();
        assert_eq!(listener.redirect_uri, format!("http://localhost:{port}/redirect"));
        listener.expect_state("state-abc");
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let page = get(&format!("http://localhost:{port}/redirect?code=test-auth-code&state=state-abc"))
            .await
            .text()
            .await
            .unwrap();

        assert_eq!(page, CALLBACK_SUCCESS_PAGE);
        assert_eq!(waiter.await.unwrap(), Ok("test-auth-code".to_string()));
    }

    /// The registered port taken by another process must be reported, never
    /// swapped for a random one the provider would refuse.
    #[tokio::test]
    async fn a_port_already_in_use_is_reported_rather_than_swapped_for_another() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();

        let result = LoopbackListener::bind(port).await;

        assert_eq!(result.err(), Some(OidcError::PortUnavailable));
    }

    /// `localhost` may resolve to `::1` first. If another process holds the
    /// port there, the browser could hand it this login's code, so that is
    /// refused too even though `127.0.0.1` is free.
    #[tokio::test]
    async fn a_port_already_in_use_on_ipv6_loopback_is_reported_too() {
        let Ok(taken) = std::net::TcpListener::bind(("::1", 0)) else {
            eprintln!("skipping: no IPv6 loopback on this machine");
            return;
        };
        let port = taken.local_addr().unwrap().port();
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
            eprintln!("skipping: the same port is taken on 127.0.0.1 too");
            return;
        }

        let result = LoopbackListener::bind(port).await;

        assert_eq!(result.err(), Some(OidcError::PortUnavailable));
    }

    /// A provider answering with `response_mode=form_post` sends the same
    /// parameters as a form body, in a POST (PR #433 review).
    async fn post_form(url: &str, body: &str) -> reqwest::Response {
        reqwest::Client::new()
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body.to_string())
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_form_post_callback_yields_the_authorization_code() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        listener.expect_state("state-abc");
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let response = post_form(&redirect, "code=test-auth-code&state=state-abc").await;

        assert!(response.status().is_success(), "got {}", response.status());
        assert_eq!(response.text().await.unwrap(), CALLBACK_SUCCESS_PAGE);
        assert_eq!(waiter.await.unwrap(), Ok("test-auth-code".to_string()));
    }

    #[tokio::test]
    async fn a_form_post_callback_with_the_wrong_state_is_refused() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        listener.expect_state("state-abc");
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let page = post_form(&redirect, "code=test-auth-code&state=someone-elses").await.text().await.unwrap();

        assert_eq!(page, CALLBACK_NOT_COMPLETED_PAGE);
        assert_eq!(waiter.await.unwrap(), Err(OidcError::StateMismatch));
    }

    #[tokio::test]
    async fn a_form_post_callback_carrying_a_provider_error_is_refused() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        listener.expect_state("state-abc");
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let page = post_form(&redirect, "error=access_denied&state=state-abc").await.text().await.unwrap();

        assert_eq!(page, CALLBACK_NOT_COMPLETED_PAGE);
        assert_eq!(waiter.await.unwrap(), Err(OidcError::ConsentDenied));
    }

    /// A form post's parameters are in its body. The query string of a POST
    /// is not read, so a state or code there cannot complete the login.
    #[tokio::test]
    async fn a_form_post_reads_its_body_not_its_query_string() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        listener.expect_state("state-abc");
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let url = format!("{redirect}?code=test-auth-code&state=state-abc");
        let page = post_form(&url, "").await.text().await.unwrap();

        assert_eq!(page, CALLBACK_NOT_COMPLETED_PAGE);
        assert_eq!(waiter.await.unwrap(), Err(OidcError::StateMismatch));
    }

    #[tokio::test]
    async fn a_callback_without_a_code_is_refused() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        get(&format!("{redirect}?state=state-abc")).await;
        assert_eq!(waiter.await.unwrap(), Err(OidcError::TokenExchangeFailed));
    }

    #[tokio::test]
    async fn a_dropped_listener_releases_its_port_without_waiting() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let port = listener.redirect_uri.rsplit(':').next().unwrap().trim_end_matches(REDIRECT_PATH).parse::<u16>().unwrap();
        let ipv6 = std::net::TcpListener::bind(("::1", 0)).is_ok();
        drop(listener);

        // Released means bindable again, on every loopback address it held.
        // (Probing with requests instead is slow on Windows, where a refused
        // loopback connection takes about two seconds per address.)
        let released = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let v4 = std::net::TcpListener::bind(("127.0.0.1", port)).is_ok();
                let v6 = !ipv6 || std::net::TcpListener::bind(("::1", port)).is_ok();
                if v4 && v6 {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(
            released.is_ok(),
            "the socket must be released after the listener is dropped without wait()/shutdown()"
        );
    }

    #[tokio::test]
    async fn a_denied_login_does_not_claim_success_in_the_browser() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let response = get(&format!("{redirect}?error=access_denied&state=state-abc")).await;
        let page = response.text().await.unwrap();
        assert!(!page.contains("Login complete"), "a denied login must not show the success page: {page}");
        assert!(waiter.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn a_malformed_callback_does_not_claim_success_in_the_browser() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let response = get(&format!("{redirect}?state=state-abc")).await;
        let page = response.text().await.unwrap();
        assert!(!page.contains("Login complete"), "a malformed callback must not show the success page: {page}");
        assert!(waiter.await.unwrap().is_err());
    }

    // The page is chosen when the request is answered, so it must check the
    // state itself: `wait()` refusing a mismatch afterwards is too late for
    // the tab, which would already say "Login complete" (PR #433 review).
    #[tokio::test]
    async fn a_callback_with_the_wrong_state_does_not_claim_success_in_the_browser() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        listener.expect_state("state-abc");
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let page = get(&format!("{redirect}?code=test-auth-code&state=someone-elses")).await.text().await.unwrap();
        assert_eq!(page, CALLBACK_NOT_COMPLETED_PAGE);
        assert_eq!(waiter.await.unwrap(), Err(OidcError::StateMismatch));
    }

    #[tokio::test]
    async fn a_callback_with_no_state_does_not_claim_success_in_the_browser() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        listener.expect_state("state-abc");
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let page = get(&format!("{redirect}?code=test-auth-code")).await.text().await.unwrap();
        assert_eq!(page, CALLBACK_NOT_COMPLETED_PAGE);
        assert_eq!(waiter.await.unwrap(), Err(OidcError::StateMismatch));
    }

    #[tokio::test]
    async fn a_callback_with_the_expected_state_shows_the_success_page() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        listener.expect_state("state-abc");
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let page = get(&format!("{redirect}?code=test-auth-code&state=state-abc")).await.text().await.unwrap();
        assert_eq!(page, CALLBACK_SUCCESS_PAGE);
        assert_eq!(waiter.await.unwrap(), Ok("test-auth-code".to_string()));
    }

    /// Fails closed: a listener that was never told the state cannot vouch
    /// for any callback, so it never says "Login complete".
    #[tokio::test]
    async fn a_listener_never_told_the_state_shows_no_success_page() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let page = get(&format!("{redirect}?code=test-auth-code&state=state-abc")).await.text().await.unwrap();
        assert_eq!(page, CALLBACK_NOT_COMPLETED_PAGE);
        listener.shutdown();
    }

    #[tokio::test]
    async fn concurrent_requests_deliver_exactly_one_result() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        listener.expect_state("state-abc");
        let redirect = listener.redirect_uri.clone();

        let url_a = format!("{redirect}?code=code-a&state=state-abc");
        let url_b = format!("{redirect}?code=code-b&state=state-abc");
        let (response_a, response_b) = tokio::join!(get(&url_a), get(&url_b));
        let (page_a, page_b) = (response_a.text().await.unwrap(), response_b.text().await.unwrap());
        // Waited on only now: `wait()` shuts the server down as soon as it
        // has a result, which could cut off the other request before it is
        // read. The one-shot keeps the first result until then.
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let successes = [&page_a, &page_b].into_iter().filter(|p| p.as_str() == CALLBACK_SUCCESS_PAGE).count();
        let replays = [&page_a, &page_b].into_iter().filter(|p| p.as_str() == CALLBACK_REPLAY_PAGE).count();
        assert_eq!(successes, 1, "exactly one concurrent request must see the success page");
        assert_eq!(replays, 1, "exactly one concurrent request must see the replay page");

        let result = waiter.await.unwrap();
        assert!(result == Ok("code-a".to_string()) || result == Ok("code-b".to_string()), "got {result:?}");
    }

    #[tokio::test]
    async fn shutdown_releases_the_port_and_resolves_the_waiter() {
        let listener = LoopbackListener::bind(0).await.unwrap();
        let redirect = listener.redirect_uri.clone();
        listener.shutdown();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            listener.wait("state-abc"),
        )
        .await
        .expect("wait must return promptly after shutdown, not hang");
        assert_eq!(result, Err(OidcError::Cancelled));
        assert!(
            reqwest::Client::new().get(&redirect).send().await.is_err(),
            "the socket must be closed"
        );
    }

    #[tokio::test]
    async fn exchanging_a_code_sends_the_verifier_and_returns_a_token() {
        let idp = MockIdp::start();
        let http = reqwest::Client::new();
        let endpoints = discover(&idp.issuer(), &http).await.unwrap();
        let verifier = PkceVerifier::from_string("verifier-xyz".to_string());

        let (response, _) = exchange_code(
            &endpoints,
            "client-abc",
            "test-auth-code",
            &verifier,
            "http://127.0.0.1:1/callback",
            &http,
            TokenChoice::AccessToken,
            "test-nonce",
        )
        .await
        .unwrap();

        assert!(!response.access_token.is_empty());
        assert_eq!(response.refresh_token.as_deref(), Some("test-refresh-token"));
        assert!(response.expires.is_some(), "expires_in must become an Instant");

        let sent = idp.last_token_request().unwrap();
        assert_eq!(sent.grant_type, "authorization_code");
        assert_eq!(sent.code.as_deref(), Some("test-auth-code"));
        assert_eq!(sent.code_verifier.as_deref(), Some("verifier-xyz"));
    }

    /// `expires_in` is IdP-controlled. An absurd value must not panic in the
    /// auth path (`Instant + Duration` overflow does); it means "no usable
    /// expiry", which the driver treats as a token that never expires early.
    #[test]
    fn an_absurd_expires_in_is_no_expiry_rather_than_a_panic() {
        let response = into_idp_response(TokenResponse {
            access_token: "test-access-token".into(),
            expires_in: Some(u64::MAX),
            refresh_token: None,
            id_token: None,
        }, TokenChoice::AccessToken, None)
        .unwrap()
        .0;
        assert_eq!(response.expires, None);
    }

    #[tokio::test]
    async fn refreshing_uses_the_refresh_grant() {
        let idp = MockIdp::start();
        let http = reqwest::Client::new();
        let endpoints = discover(&idp.issuer(), &http).await.unwrap();

        let (response, _) = refresh_token(&endpoints, "client-abc", "test-refresh-token", &http, TokenChoice::AccessToken)
            .await
            .unwrap();
        assert!(!response.access_token.is_empty());

        let sent = idp.last_token_request().unwrap();
        assert_eq!(sent.grant_type, "refresh_token");
        assert_eq!(sent.refresh_token.as_deref(), Some("test-refresh-token"));
        assert_eq!(sent.code, None);
    }

    /// A provider that does not rotate refresh tokens answers a refresh with
    /// none. The driver replaces its cached refresh token with whatever the
    /// response carries, so the one just used must be handed back, or the
    /// next expiry needs a browser login (PR #433 review).
    #[tokio::test]
    async fn a_refresh_answered_without_a_refresh_token_keeps_the_one_it_used() {
        let idp = MockIdp::start();
        idp.keep_refresh_tokens(true);
        let http = reqwest::Client::new();
        let endpoints = discover(&idp.issuer(), &http).await.unwrap();

        let (response, _) =
            refresh_token(&endpoints, "client-abc", "the-refresh-token-in-use", &http, TokenChoice::AccessToken)
                .await
                .unwrap();

        assert_eq!(response.refresh_token.as_deref(), Some("the-refresh-token-in-use"));
    }

    /// A provider that rotates them sends a new one, which replaces the old.
    #[tokio::test]
    async fn a_refresh_answered_with_a_new_refresh_token_hands_back_the_new_one() {
        let idp = MockIdp::start();
        let http = reqwest::Client::new();
        let endpoints = discover(&idp.issuer(), &http).await.unwrap();

        let (response, _) =
            refresh_token(&endpoints, "client-abc", "the-refresh-token-in-use", &http, TokenChoice::AccessToken)
                .await
                .unwrap();

        assert_eq!(response.refresh_token.as_deref(), Some("test-refresh-token"));
    }

    #[tokio::test]
    async fn a_non_https_token_endpoint_is_refused_before_any_request() {
        let http = reqwest::Client::new();
        let endpoints = Endpoints {
            authorization: "https://idp.example.com/authorize".into(),
            token: "http://10.0.0.5/token".into(),
        };
        // `assert_eq!` can't compare the whole `Result` here: `IdpServerResponse`
        // (mongodb 3.9.0) derives no `PartialEq`. `matches!` checks the same
        // thing — refused with `InsecureEndpoint` — without needing one.
        let result = exchange_code(
            &endpoints,
            "client-abc",
            "test-auth-code",
            &PkceVerifier::from_string("v".into()),
            "http://127.0.0.1:1/callback",
            &http,
            TokenChoice::AccessToken,
            "test-nonce",
        )
        .await;
        assert!(
            matches!(result, Err(OidcError::InsecureEndpoint)),
            "expected Err(InsecureEndpoint) before any request, got {result:?}"
        );
    }

    #[tokio::test]
    async fn a_failed_exchange_does_not_leak_the_code() {
        let http = reqwest::Client::new();
        let endpoints = Endpoints {
            authorization: "https://127.0.0.1:1/authorize".into(),
            token: "https://127.0.0.1:1/token".into(),
        };
        let error = exchange_code(
            &endpoints,
            "client-abc",
            "test-auth-code",
            &PkceVerifier::from_string("super-secret-verifier".into()),
            "http://127.0.0.1:1/callback",
            &http,
            TokenChoice::AccessToken,
            "test-nonce",
        )
        .await
        .unwrap_err();
        let rendered = format!("{error} | {error:?}");
        assert!(!rendered.contains("test-auth-code"), "got {rendered}");
        assert!(!rendered.contains("super-secret-verifier"), "got {rendered}");
    }

    // ---- the production IdP client -----------------------------------------

    /// A TCP listener that counts the connections it accepts and drops each
    /// one immediately. Returns its URL and the counter.
    async fn counting_sink() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/stolen", listener.local_addr().unwrap());
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = count.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        (url, count)
    }

    /// M9: a `307` tells a client to resend the same POST, body included, to
    /// wherever it points. Followed, one to `http://` would put the code and
    /// the PKCE verifier on the wire in clear. The production client follows
    /// no redirect at all; the exchange simply fails.
    #[tokio::test]
    async fn the_idp_client_never_follows_a_redirect_with_the_code() {
        let idp = MockIdp::start();
        let (elsewhere, reached) = counting_sink().await;
        idp.redirect_token_requests_to(&elsewhere);
        let http = idp_http_client().unwrap();
        let endpoints = discover(&idp.issuer(), &http).await.unwrap();

        let result = exchange_code(
            &endpoints,
            "client-abc",
            "test-auth-code",
            &PkceVerifier::from_string("super-secret-verifier".into()),
            "http://127.0.0.1:1/callback",
            &http,
            TokenChoice::AccessToken,
            "test-nonce",
        )
        .await;

        assert!(matches!(result, Err(OidcError::TokenExchangeFailed)), "got {:?}", result.as_ref().map(|_| ()));
        assert_eq!(
            reached.load(Ordering::SeqCst),
            0,
            "the code and verifier must never be resent to a redirect target"
        );
    }

    /// No-redirects covers discovery too: an IdP whose `.well-known` document
    /// redirects, even to a valid document on the same host, fails discovery.
    /// docs/oidc.md says so under `discoveryFailed`.
    #[tokio::test]
    async fn discovery_follows_no_redirect_either() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let issuer = format!("http://{}", server.server_addr());
        let document = serde_json::json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/authorize"),
            "token_endpoint": format!("{issuer}/token"),
        })
        .to_string();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let response = if request.url() == "/.well-known/openid-configuration" {
                    tiny_http::Response::from_string("")
                        .with_status_code(302)
                        .with_header(tiny_http::Header::from_bytes("Location", "/moved/openid-configuration").unwrap())
                } else {
                    tiny_http::Response::from_string(document.clone())
                        .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
                };
                let _ = request.respond(response);
            }
        });

        let result = discover(&issuer, &idp_http_client().unwrap()).await;

        assert!(matches!(result, Err(OidcError::DiscoveryFailed)), "got {result:?}");
    }

    /// Each IdP request is bounded on its own, below the driver's deadline:
    /// a server that accepts and never answers ends in an error, not a hang.
    #[tokio::test]
    async fn the_idp_client_gives_up_on_a_server_that_never_answers() {
        let port = crate::oidc_login::test_support::silent_server().await;
        let http = idp_http_client_builder(
            std::time::Duration::from_millis(500),
            std::time::Duration::from_millis(300),
        )
        .build()
        .unwrap();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            http.get(format!("http://127.0.0.1:{port}/.well-known/openid-configuration")).send(),
        )
        .await
        .expect("a request to a silent server must time out on its own");

        assert!(result.as_ref().is_err_and(|e| e.is_timeout()), "got {result:?}");
    }

    /// The production client trusts exactly what a normal client trusts. A
    /// server whose certificate chains only to the TEST-ONLY CA must be
    /// refused — by the same client every production login uses.
    #[tokio::test]
    async fn the_idp_client_never_trusts_an_unknown_certificate_authority() {
        let idp = MockIdp::start_tls("host.docker.internal", 0);
        let addr = idp.tls_addr().expect("a TLS mock IdP");
        let http = idp_http_client().unwrap();

        let result = http
            .get(format!("https://{addr}/.well-known/openid-configuration"))
            .send()
            .await;

        assert!(result.is_err(), "a certificate from an untrusted CA must be refused, got {result:?}");
    }

    // ---- allowed hosts, matched as driver 3.9.0 matches them ------------

    fn list(hosts: &[&str]) -> Vec<String> {
        hosts.iter().map(|h| h.to_string()).collect()
    }

    #[test]
    fn with_no_custom_list_the_driver_defaults_decide() {
        for host in [
            "cluster0.abcd.mongodb.net",
            "x.mongodb-qa.net",
            "x.mongodb-dev.net",
            "x.mongodbgov.net",
            "localhost",
            "127.0.0.1",
            "[::1]",
            "x.mongo.com",
        ] {
            assert!(host_is_allowed(host, &[]), "{host} is in the driver's defaults");
        }
        for host in ["db.internal", "10.0.0.5", "[::2]", "mongodb.net", "evilmongodb.net", "mongodb.net.evil.example"] {
            assert!(!host_is_allowed(host, &[]), "{host} is outside the driver's defaults");
        }
    }

    #[test]
    fn a_custom_list_replaces_the_driver_defaults() {
        let custom = list(&["*.corp.example"]);
        assert!(host_is_allowed("db.corp.example", &custom));
        for host in ["localhost", "127.0.0.1", "[::1]", "cluster0.abcd.mongodb.net"] {
            assert!(!host_is_allowed(host, &custom), "{host} is only in the defaults");
        }
    }

    /// `*.domain` matches by suffix `.domain`: any depth of subdomain, never
    /// the bare domain. Any other pattern, `*` included, is exact.
    #[test]
    fn a_wildcard_is_a_dot_suffix_and_everything_else_is_exact() {
        let custom = list(&["*.corp.example", "*db.example", "*"]);
        assert!(host_is_allowed("a.b.corp.example", &custom));
        assert!(!host_is_allowed("corp.example", &custom));
        assert!(!host_is_allowed("evilcorp.example", &custom));
        assert!(!host_is_allowed("mydb.example", &custom));
        assert!(!host_is_allowed("anything.example", &custom));
    }

    /// The driver lowercases a host name and prints an IP address in its
    /// canonical form, without brackets, then compares each pattern
    /// verbatim.
    #[test]
    fn hosts_are_normalised_as_the_driver_does_and_patterns_are_not() {
        assert!(host_is_allowed("DB.Corp.Example", &list(&["db.corp.example"])));
        assert!(!host_is_allowed("db.corp.example", &list(&["DB.corp.example"])));
        assert!(host_is_allowed("[0:0:0:0:0:0:0:1]", &[]));
        assert!(host_is_allowed("[::1]", &list(&["::1"])));
        assert!(!host_is_allowed("[::1]", &list(&["[::1]"])));
        assert!(host_is_allowed("[FE80::1]", &list(&["fe80::1"])));
    }

    /// Fail closed: a host the driver could not parse is never allowed.
    #[test]
    fn an_unparseable_host_is_never_allowed() {
        assert!(!host_is_allowed("", &list(&[""])));
        assert!(!host_is_allowed("[not-an-ip]", &list(&["[not-an-ip]", "not-an-ip"])));
    }

    /// Set only in the child process `the_idp_client_also_trusts_the_os_certificate_store`
    /// starts, which is the only place `SSL_CERT_FILE` names the TEST-ONLY CA.
    const OS_STORE_CHILD: &str = "MQLENS_TEST_OS_STORE_CHILD";

    /// An identity provider behind an internal CA, or any IdP reached through
    /// a TLS-inspecting proxy (Zscaler, Netskope), presents a chain that ends
    /// in a root only the operating system's certificate store holds. The
    /// browser trusts that store, so the production client must too.
    ///
    /// `rustls-native-certs` (0.8.4, `src/lib.rs` `load_native_certs`) reads
    /// `SSL_CERT_FILE` in place of the platform store on every OS, so pointing
    /// it at the TEST-ONLY CA stands in for an OS store holding a corporate
    /// root, with nothing installed on this machine. The variable is
    /// process-global and tests run in parallel, so it is set only in a child
    /// run of this same test binary, filtered to the one test below.
    #[test]
    fn the_idp_client_also_trusts_the_os_certificate_store() {
        let ca = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/oidc-test-ca.pem");
        let (_, module) = module_path!().split_once("::").expect("a crate-qualified module path");
        let child_test = format!("{module}::the_idp_client_reaches_a_server_whose_root_is_only_in_ssl_cert_file");

        let output = std::process::Command::new(std::env::current_exe().expect("this test binary's path"))
            .args([child_test.as_str(), "--exact", "--include-ignored", "--nocapture", "--test-threads=1"])
            .env(OS_STORE_CHILD, "1")
            .env("SSL_CERT_FILE", &ca)
            .env_remove("SSL_CERT_DIR")
            .env_remove("MQLENS_TEST_OIDC_IDP_BIND")
            .output()
            .expect("run this test binary again as a child");

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success() && stdout.contains("test result: ok. 1 passed"),
            "with SSL_CERT_FILE naming the TEST-ONLY CA, the production IdP client must \
             complete a TLS request to a server that chains only to it\n\
             --- child stdout ---\n{stdout}\n--- child stderr ---\n{stderr}"
        );
    }

    /// The child half of `the_idp_client_also_trusts_the_os_certificate_store`;
    /// a no-op anywhere else. The client is production's own builder with its
    /// production bounds. The only addition is a DNS pin, because the TEST-ONLY
    /// leaf names `host.docker.internal`. No `add_root_certificate`: the
    /// TEST-ONLY CA can only be trusted through the OS-store roots.
    #[tokio::test]
    #[ignore = "run only as a child of the_idp_client_also_trusts_the_os_certificate_store"]
    async fn the_idp_client_reaches_a_server_whose_root_is_only_in_ssl_cert_file() {
        if std::env::var_os(OS_STORE_CHILD).is_none() {
            return;
        }
        let idp = MockIdp::start_tls("host.docker.internal", 0);
        let addr = idp.tls_addr().expect("a TLS mock IdP");
        let http = idp_http_client_builder(IDP_CONNECT_TIMEOUT, IDP_REQUEST_TIMEOUT)
            .resolve("host.docker.internal", addr)
            .build()
            .expect("build the production IdP client");

        let result = http
            .get(format!("https://host.docker.internal:{}/.well-known/openid-configuration", addr.port()))
            .send()
            .await;

        match result {
            Ok(response) => assert!(response.status().is_success(), "got {}", response.status()),
            Err(error) => panic!("the request must succeed over verified TLS, got {error:?}"),
        }
    }

    /// The production bounds: every request well inside the driver's
    /// five-minute callback deadline.
    #[test]
    fn the_idp_client_timeouts_sit_well_inside_the_drivers_deadline() {
        assert!(IDP_CONNECT_TIMEOUT <= IDP_REQUEST_TIMEOUT);
        assert!(IDP_REQUEST_TIMEOUT <= std::time::Duration::from_secs(60));
    }

    fn percent_decode(value: &str) -> String {
        let bytes = value.replace('+', " ").into_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let Ok(byte) = u8::from_str_radix(
                    std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"),
                    16,
                ) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    // --- Task 8: session, cancellation and the orchestrated flow ---
    //
    // The brief's `recording_opener` only records the authorization URL; it
    // never navigates to it, so nothing ever drives the IdP's redirect into
    // our loopback listener and a success-path test using it alone would
    // hang until the deadline. Two openers are used instead:
    // `simulating_opener` additionally fires a GET at the recorded URL
    // (reqwest follows the mock IdP's 302 to our /redirect), standing in
    // for a human completing the browser flow; `recording_opener` stays as
    // the brief describes it, for the "user never completes" tests.

    pub(super) fn test_session() -> (Arc<OidcSession>, Arc<StdMutex<Vec<String>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let recorder = seen.clone();
        let sink: PhaseSink = Arc::new(move |phase| {
            recorder.lock().unwrap().push(format!("{phase:?}"));
        });
        (OidcSession::new(sink), seen)
    }

    /// Records the URL instead of opening a browser, and never navigates to
    /// it. Stands in for a browser the user never completes.
    pub(super) fn recording_opener() -> (BrowserOpener, Arc<StdMutex<Vec<String>>>) {
        let opened = Arc::new(StdMutex::new(Vec::new()));
        let recorder = opened.clone();
        let opener: BrowserOpener = Arc::new(move |url: &str| {
            recorder.lock().unwrap().push(url.to_string());
            Ok(())
        });
        (opener, opened)
    }

    /// Records the URL *and* fetches it, so the mock IdP's redirect lands on
    /// our loopback `/redirect`. Stands in for a human clicking through the
    /// browser. Fires the GET on a spawned task rather than blocking: `open`
    /// is a synchronous callback (real browser launchers are synchronous),
    /// so it cannot itself await a response.
    pub(super) fn simulating_opener() -> (BrowserOpener, Arc<StdMutex<Vec<String>>>) {
        simulating_opener_with(reqwest::Client::new())
    }

    /// `simulating_opener`, browsing with `http` — for an IdP that only a
    /// specially configured client can reach (Task 10's TLS mock IdP, whose
    /// CA and host name a default client knows nothing about).
    pub(super) fn simulating_opener_with(
        http: reqwest::Client,
    ) -> (BrowserOpener, Arc<StdMutex<Vec<String>>>) {
        let opened = Arc::new(StdMutex::new(Vec::new()));
        let recorder = opened.clone();
        let opener: BrowserOpener = Arc::new(move |url: &str| {
            recorder.lock().unwrap().push(url.to_string());
            let url = url.to_string();
            let http = http.clone();
            tokio::spawn(async move {
                let _ = http.get(&url).send().await;
            });
            Ok(())
        });
        (opener, opened)
    }

    fn context_for(idp: &MockIdp, refresh: Option<&str>) -> CallbackContext {
        CallbackContext::builder()
            .version(1u32)
            .timeout(Some(std::time::Instant::now() + std::time::Duration::from_secs(30)))
            .refresh_token(refresh.map(str::to_string))
            .idp_info(Some(
                IdpServerInfo::builder()
                    .issuer(idp.issuer())
                    .client_id(Some("mqlens-test".to_string()))
                    .request_scopes(None)
                    .build(),
            ))
            .build()
    }

    #[tokio::test]
    async fn a_full_interactive_login_returns_a_token_and_reports_its_phases() {
        let idp = MockIdp::start();
        let (session, phases) = test_session();
        let (opener, opened) = simulating_opener();

        let response = run_flow(
            context_for(&idp, None),
            session,
            opener,
            reqwest::Client::new(),
            TokenChoice::AccessToken,
        )
        .await
        .unwrap();

        assert!(!response.access_token.is_empty());
        assert_eq!(opened.lock().unwrap().len(), 1, "the browser opens exactly once");
        let phases = phases.lock().unwrap().clone();
        assert_eq!(phases, vec!["WaitingForBrowser".to_string(), "Completed(AccessToken)".to_string()]);
    }

    /// The listener says "Login complete" only for the state it was told to
    /// expect, so the real flow must tell it before the browser opens, or
    /// every successful login would end on "Login was not completed".
    #[tokio::test]
    async fn a_completed_login_leaves_the_browser_on_the_success_page() {
        let idp = MockIdp::start();
        let (session, _) = test_session();
        let page = Arc::new(StdMutex::new(None::<String>));
        let sink = page.clone();
        let opener: BrowserOpener = Arc::new(move |url: &str| {
            let (url, sink) = (url.to_string(), sink.clone());
            tokio::spawn(async move {
                let text = reqwest::Client::new().get(&url).send().await.unwrap().text().await.unwrap();
                *sink.lock().unwrap() = Some(text);
            });
            Ok(())
        });

        run_flow(context_for(&idp, None), session, opener, reqwest::Client::new(), TokenChoice::AccessToken)
            .await
            .unwrap();

        // The browser's fetch reads the page body after the flow has its code,
        // so it can finish a moment after run_flow returns.
        let page = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(text) = page.lock().unwrap().clone() {
                    return text;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the browser must receive a page");
        assert_eq!(page, CALLBACK_SUCCESS_PAGE);
    }

    #[tokio::test]
    async fn a_valid_refresh_token_skips_the_browser_entirely() {
        let idp = MockIdp::start();
        let (session, phases) = test_session();
        let (opener, opened) = recording_opener();

        let response = run_flow(
            context_for(&idp, Some("test-refresh-token")),
            session,
            opener,
            reqwest::Client::new(),
            TokenChoice::AccessToken,
        )
        .await
        .unwrap();

        assert!(!response.access_token.is_empty());
        assert!(opened.lock().unwrap().is_empty(), "refresh must not open a browser");
        assert!(
            !phases.lock().unwrap().iter().any(|p| p == "WaitingForBrowser"),
            "refresh must not announce a browser wait"
        );
    }

    #[tokio::test]
    async fn a_rejected_refresh_token_falls_back_to_the_browser() {
        let idp = MockIdp::start();
        idp.reject_refresh_tokens();
        let (session, _) = test_session();
        let (opener, opened) = simulating_opener();

        let response = run_flow(
            context_for(&idp, Some("stale-refresh-token")),
            session,
            opener,
            reqwest::Client::new(),
            TokenChoice::AccessToken,
        )
        .await
        .unwrap();

        assert!(!response.access_token.is_empty());
        assert_eq!(opened.lock().unwrap().len(), 1, "it must recover interactively");
    }

    #[tokio::test]
    async fn cancelling_returns_promptly_and_does_not_hang() {
        // `idp` serves discovery, so the flow reaches the browser step, but
        // its login is never completed: `recording_opener` never navigates,
        // so nothing ever drives a callback into the loopback listener, and
        // `run_flow` must fall out via cancellation instead of hanging on a
        // callback that will never arrive.
        let idp = MockIdp::start();
        let (session, _) = test_session();
        let (opener, _) = recording_opener();

        let cancelling = session.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            cancelling.cancel();
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_flow(context_for(&idp, None), session, opener, reqwest::Client::new(), TokenChoice::AccessToken),
        )
        .await
        .expect("cancel must not leave the flow hanging");
        // `IdpServerResponse` (mongodb 3.9.0) derives no `PartialEq`, so the
        // `Ok` arm can't be compared with `assert_eq!`; `matches!` checks
        // the same thing without needing one (see `a_non_https_token_endpoint_is_refused_before_any_request` above).
        assert!(matches!(result, Err(OidcError::Cancelled)), "got {result:?}");
    }

    #[tokio::test]
    async fn an_expired_deadline_reports_a_timeout() {
        // Same as `cancelling_returns_promptly_and_does_not_hang` above:
        // `idp` serves discovery, but its login is never completed, since
        // `recording_opener` never navigates — `run_flow` must fall out via
        // the deadline instead of hanging on a callback that will never
        // arrive.
        let idp = MockIdp::start();
        let (session, _) = test_session();
        let (opener, _) = recording_opener();

        let context = CallbackContext::builder()
            .version(1u32)
            .timeout(Some(std::time::Instant::now() + std::time::Duration::from_millis(200)))
            .refresh_token(None)
            .idp_info(Some(
                IdpServerInfo::builder()
                    .issuer(idp.issuer())
                    .client_id(Some("mqlens-test".to_string()))
                    .request_scopes(None)
                    .build(),
            ))
            .build();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_flow(context, session, opener, reqwest::Client::new(), TokenChoice::AccessToken),
        )
        .await
        .expect("the deadline must be honoured");
        assert!(matches!(result, Err(OidcError::TimedOut)), "got {result:?}");
    }

    #[tokio::test]
    async fn a_missing_idp_info_is_a_clear_error_not_a_panic() {
        let (session, _) = test_session();
        let (opener, _) = recording_opener();
        let context = CallbackContext::builder()
            .version(1u32)
            .timeout(None)
            .refresh_token(None)
            .idp_info(None)
            .build();
        let result = run_flow(context, session, opener, reqwest::Client::new(), TokenChoice::AccessToken).await;
        assert!(matches!(result, Err(OidcError::DiscoveryFailed)), "got {result:?}");
    }

    #[tokio::test]
    async fn two_concurrent_logins_keep_their_state_and_tokens_apart() {
        let idp_a = MockIdp::start();
        let idp_b = MockIdp::start();
        let (session_a, _) = test_session();
        let (session_b, _) = test_session();
        let (opener_a, opened_a) = simulating_opener();
        let (opener_b, opened_b) = simulating_opener();

        let (a, b) = tokio::join!(
            run_flow(context_for(&idp_a, None), session_a, opener_a, reqwest::Client::new(), TokenChoice::AccessToken),
            run_flow(context_for(&idp_b, None), session_b, opener_b, reqwest::Client::new(), TokenChoice::AccessToken),
        );

        let (a, b) = (a.unwrap(), b.unwrap());
        assert_ne!(a.access_token, b.access_token, "tokens must not cross sessions");

        let state_a = query_value(&opened_a.lock().unwrap()[0], "state");
        let state_b = query_value(&opened_b.lock().unwrap()[0], "state");
        assert_ne!(state_a, state_b, "state must not cross sessions");
    }

    fn query_value(url: &str, key: &str) -> String {
        url_params(url).get(key).cloned().unwrap_or_default()
    }

    // --- T21: "Use ID token instead of access token" ---

    /// A compact JWS with `header` and `claims` and a dummy signature: MQLens
    /// never verifies one (MongoDB does), so these need not be signed.
    fn unsigned_jwt(header: serde_json::Value, claims: serde_json::Value) -> String {
        format!("{}.{}.c2ln", B64.encode(header.to_string()), B64.encode(claims.to_string()))
    }

    /// A test's own view of a token the flow handed the driver.
    fn claims_of(token: &str) -> serde_json::Value {
        let payload = token.split('.').nth(1).expect("a JWT has a payload");
        serde_json::from_slice(&B64.decode(payload).expect("base64url payload")).expect("JSON claims")
    }

    fn tokens(id_token: Option<String>) -> TokenResponse {
        TokenResponse {
            access_token: "the-access-token".into(),
            expires_in: Some(3600),
            refresh_token: Some("the-refresh-token".into()),
            id_token,
        }
    }

    fn id_token_with(claims: serde_json::Value) -> Option<String> {
        Some(unsigned_jwt(serde_json::json!({"alg": "RS256", "typ": "JWT"}), claims))
    }

    // --- the ID token's own expiry (T21 polish) ---

    fn unix_now() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
    }

    /// The expiry the driver is given for an ID token with `exp` (a JSON
    /// value, or none) and a response whose `expires_in` is `expires_in`,
    /// as seconds from now (`None`: no expiry).
    fn id_token_expiry(exp: Option<serde_json::Value>, expires_in: Option<u64>) -> Option<u64> {
        let mut claims = serde_json::json!({"sub": "u", "nonce": "nonce-1"});
        if let Some(exp) = exp {
            claims["exp"] = exp;
        }
        let token = TokenResponse { expires_in, ..tokens(id_token_with(claims)) };
        let before = std::time::Instant::now();
        let (response, _) = into_idp_response(token, TokenChoice::IdToken, Some("nonce-1")).unwrap();
        response.expires.map(|at| at.saturating_duration_since(before).as_secs())
    }

    /// Within a few seconds of `expected`, allowing for the clock ticking
    /// between the test building the token and the flow reading the time.
    fn assert_about(actual: Option<u64>, expected: u64) {
        let actual = actual.expect("an expiry");
        assert!(actual.abs_diff(expected) <= 5, "expected about {expected}s from now, got {actual}s");
    }

    /// With the ID token as the credential, the driver must drop it when
    /// the ID token expires, even if the access token lives on: MongoDB
    /// checks the token it was given.
    #[test]
    fn an_id_token_expiring_before_the_access_token_sets_the_expiry() {
        assert_about(id_token_expiry(Some(serde_json::json!(unix_now() + 600)), Some(3600)), 600);
    }

    #[test]
    fn an_id_token_expiring_after_the_access_token_keeps_expires_in() {
        assert_about(id_token_expiry(Some(serde_json::json!(unix_now() + 7200)), Some(3600)), 3600);
    }

    #[test]
    fn an_id_token_without_a_numeric_exp_keeps_expires_in() {
        assert_about(id_token_expiry(None, Some(3600)), 3600);
        assert_about(id_token_expiry(Some(serde_json::json!("soon")), Some(3600)), 3600);
        assert_about(id_token_expiry(Some(serde_json::Value::Null), Some(3600)), 3600);
    }

    /// Already expired: the earliest instant there is — now — not a panic
    /// and not the access token's lifetime.
    #[test]
    fn an_id_token_already_expired_expires_now() {
        assert_about(id_token_expiry(Some(serde_json::json!(unix_now() - 600)), Some(3600)), 0);
        assert_about(id_token_expiry(Some(serde_json::json!(-1)), Some(3600)), 0);
    }

    /// With no `expires_in` the ID token's `exp` is the only bound.
    #[test]
    fn an_id_token_exp_bounds_a_response_without_expires_in() {
        assert_about(id_token_expiry(Some(serde_json::json!(unix_now() + 600)), None), 600);
        assert_eq!(id_token_expiry(None, None), None);
    }

    /// An `exp` too far out to represent is no bound at all: checked, not
    /// a panic.
    #[test]
    fn an_absurd_id_token_exp_is_no_bound_rather_than_a_panic() {
        assert_about(id_token_expiry(Some(serde_json::json!(u64::MAX)), Some(3600)), 3600);
        assert_about(id_token_expiry(Some(serde_json::json!(1e300)), Some(3600)), 3600);
        assert_eq!(id_token_expiry(Some(serde_json::json!(u64::MAX)), None), None);
    }

    /// Access-token mode never looks at the ID token's expiry.
    #[test]
    fn with_the_option_off_the_id_tokens_exp_is_ignored() {
        let id_token = id_token_with(serde_json::json!({"nonce": "nonce-1", "exp": unix_now() + 600}));
        let before = std::time::Instant::now();
        let (response, _) =
            into_idp_response(tokens(id_token), TokenChoice::AccessToken, Some("nonce-1")).unwrap();
        assert_about(response.expires.map(|at| at.saturating_duration_since(before).as_secs()), 3600);
    }

    #[test]
    fn an_id_token_carrying_the_logins_nonce_is_what_the_driver_gets() {
        let id_token = id_token_with(serde_json::json!({"sub": "u", "nonce": "nonce-1"}));

        let (response, presented) =
            into_idp_response(tokens(id_token.clone()), TokenChoice::IdToken, Some("nonce-1")).unwrap();

        assert_eq!(Some(response.access_token), id_token, "the ID token is the credential");
        assert_eq!(presented, Presented::IdToken);
        assert_eq!(response.refresh_token.as_deref(), Some("the-refresh-token"), "the refresh token is kept");
        assert!(response.expires.is_some(), "the response's expiry is kept");
    }

    /// The ID token becomes the credential, so one minted for another login
    /// (a replay, or a mix-up between two logins) must never be sent.
    #[test]
    fn an_id_token_with_another_nonce_is_refused_as_a_state_mismatch() {
        let id_token = id_token_with(serde_json::json!({"sub": "u", "nonce": "nonce-2"}));

        let result = into_idp_response(tokens(id_token), TokenChoice::IdToken, Some("nonce-1"));

        assert!(matches!(result, Err(OidcError::StateMismatch)), "got {:?}", result.map(|(_, p)| p));
    }

    #[test]
    fn an_id_token_without_a_nonce_is_refused_as_a_state_mismatch() {
        for claims in [
            serde_json::json!({"sub": "u"}),
            serde_json::json!({"sub": "u", "nonce": null}),
            serde_json::json!({"sub": "u", "nonce": 7}),
            serde_json::json!({"sub": "u", "nonce": ""}),
        ] {
            let result = into_idp_response(tokens(id_token_with(claims.clone())), TokenChoice::IdToken, Some("nonce-1"));
            assert!(matches!(result, Err(OidcError::StateMismatch)), "{claims}: got {:?}", result.map(|(_, p)| p));
        }
        // A missing nonce is never a match, not even for an empty expected
        // one (the flow never sends one, but nothing here relies on that).
        let result = into_idp_response(tokens(id_token_with(serde_json::json!({"sub": "u"}))), TokenChoice::IdToken, Some(""));
        assert!(matches!(result, Err(OidcError::StateMismatch)), "got {:?}", result.map(|(_, p)| p));
    }

    #[test]
    fn no_id_token_with_the_option_on_is_a_failed_exchange() {
        let result = into_idp_response(tokens(None), TokenChoice::IdToken, Some("nonce-1"));

        assert!(matches!(result, Err(OidcError::TokenExchangeFailed)), "got {:?}", result.map(|(_, p)| p));
    }

    #[test]
    fn a_malformed_id_token_is_a_failed_exchange() {
        let not_json = format!("e30.{}.c2ln", B64.encode("not json"));
        let not_an_object = format!("e30.{}.c2ln", B64.encode("[\"nonce-1\"]"));
        for malformed in ["", "opaque-token", "e30.e30", "e30.!!!.c2ln", "e30.e30.c2ln.extra", &not_json, &not_an_object] {
            let result = into_idp_response(tokens(Some(malformed.to_string())), TokenChoice::IdToken, Some("nonce-1"));
            assert!(
                matches!(result, Err(OidcError::TokenExchangeFailed)),
                "{malformed:?}: got {:?}",
                result.map(|(_, p)| p)
            );
        }
    }

    /// A refresh exchange sends no nonce, so its ID token is not checked for
    /// one — but it must still be an ID token.
    #[test]
    fn a_refreshed_id_token_is_used_without_a_nonce_check() {
        let id_token = id_token_with(serde_json::json!({"sub": "u"}));

        let (response, presented) = into_idp_response(tokens(id_token.clone()), TokenChoice::IdToken, None).unwrap();

        assert_eq!(Some(response.access_token), id_token);
        assert_eq!(presented, Presented::IdToken);
        let malformed = into_idp_response(tokens(Some("opaque".into())), TokenChoice::IdToken, None);
        assert!(matches!(malformed, Err(OidcError::TokenExchangeFailed)), "got {:?}", malformed.map(|(_, p)| p));
    }

    /// With the option off nothing about the ID token matters — not even
    /// one that would fail every check above.
    #[test]
    fn with_the_option_off_the_access_token_is_handed_over_whatever_the_id_token_says() {
        for id_token in [None, Some("opaque".to_string()), id_token_with(serde_json::json!({"nonce": "nonce-2"}))] {
            let (response, presented) =
                into_idp_response(tokens(id_token), TokenChoice::AccessToken, Some("nonce-1")).unwrap();
            assert_eq!(response.access_token, "the-access-token");
            assert_eq!(presented, Presented::AccessToken);
        }
    }

    /// MongoDB's JWT parser (`jws_validated_token.cpp`) accepts a `typ` that
    /// is absent or exactly `"JWT"`, and refuses any other — RFC 9068's
    /// `"at+jwt"` among them. A token that is not a JWT at all is refused
    /// for other reasons, so it is not called a type problem.
    #[test]
    fn an_access_token_is_classified_by_the_typ_mongodb_accepts() {
        let claims = serde_json::json!({"sub": "u"});
        for (access_token, expected) in [
            (unsigned_jwt(serde_json::json!({"alg": "RS256"}), claims.clone()), Presented::AccessToken),
            (unsigned_jwt(serde_json::json!({"alg": "RS256", "typ": "JWT"}), claims.clone()), Presented::AccessToken),
            (
                unsigned_jwt(serde_json::json!({"alg": "RS256", "typ": "at+jwt"}), claims.clone()),
                Presented::AccessTokenOfRefusedType,
            ),
            (
                unsigned_jwt(serde_json::json!({"alg": "RS256", "typ": "jwt"}), claims.clone()),
                Presented::AccessTokenOfRefusedType,
            ),
            ("opaque-access-token".to_string(), Presented::AccessToken),
            ("e30.e30".to_string(), Presented::AccessToken),
        ] {
            let token = TokenResponse { access_token: access_token.clone(), ..tokens(None) };
            let (response, presented) = into_idp_response(token, TokenChoice::AccessToken, Some("nonce-1")).unwrap();
            assert_eq!(presented, expected, "{access_token}");
            assert_eq!(response.access_token, access_token, "the access token is handed over unchanged");
        }
    }

    #[tokio::test]
    async fn a_login_with_the_id_token_option_hands_the_driver_this_logins_id_token() {
        let idp = MockIdp::start();
        let (session, phases) = test_session();
        let (opener, opened) = simulating_opener();

        let response = run_flow(context_for(&idp, None), session, opener, reqwest::Client::new(), TokenChoice::IdToken)
            .await
            .unwrap();

        let claims = claims_of(&response.access_token);
        assert_eq!(claims["aud"], "mqlens-test", "an ID token, whose audience is the client id");
        assert_eq!(claims["nonce"], query_value(&opened.lock().unwrap()[0], "nonce"));
        assert_eq!(*phases.lock().unwrap(), vec!["WaitingForBrowser".to_string(), "Completed(IdToken)".to_string()]);
    }

    #[tokio::test]
    async fn a_login_whose_id_token_carries_another_nonce_is_refused() {
        let idp = MockIdp::start();
        idp.mint_wrong_nonce(true);
        let (session, phases) = test_session();
        let (opener, _) = simulating_opener();

        let result =
            run_flow(context_for(&idp, None), session, opener, reqwest::Client::new(), TokenChoice::IdToken).await;

        assert!(matches!(result, Err(OidcError::StateMismatch)), "got {:?}", result.as_ref().map(|_| ()));
        assert_eq!(phases.lock().unwrap().last().map(String::as_str), Some("Failed(StateMismatch)"));
    }

    #[tokio::test]
    async fn a_login_whose_idp_sends_no_id_token_fails_the_exchange() {
        let idp = MockIdp::start();
        idp.omit_id_tokens(true);
        let (session, _) = test_session();
        let (opener, _) = simulating_opener();

        let result =
            run_flow(context_for(&idp, None), session, opener, reqwest::Client::new(), TokenChoice::IdToken).await;

        assert!(matches!(result, Err(OidcError::TokenExchangeFailed)), "got {:?}", result.as_ref().map(|_| ()));
    }

    #[tokio::test]
    async fn a_refresh_with_the_id_token_option_hands_over_the_refreshed_id_token() {
        let idp = MockIdp::start();
        let (session, _) = test_session();
        let (opener, opened) = recording_opener();

        let response = run_flow(
            context_for(&idp, Some("test-refresh-token")),
            session,
            opener,
            reqwest::Client::new(),
            TokenChoice::IdToken,
        )
        .await
        .unwrap();

        assert!(opened.lock().unwrap().is_empty(), "a refresh opens no browser");
        assert_eq!(claims_of(&response.access_token)["aud"], "mqlens-test");
    }

    /// A refresh that brings no new ID token must not leave the driver with
    /// a stale one: the login starts over in the browser.
    #[tokio::test]
    async fn a_refresh_without_an_id_token_falls_back_to_the_browser() {
        let idp = MockIdp::start();
        idp.omit_id_token_on_refresh(true);
        let (session, _) = test_session();
        let (opener, opened) = simulating_opener();

        let response = run_flow(
            context_for(&idp, Some("test-refresh-token")),
            session,
            opener,
            reqwest::Client::new(),
            TokenChoice::IdToken,
        )
        .await
        .unwrap();

        assert_eq!(opened.lock().unwrap().len(), 1, "it must log in again interactively");
        let claims = claims_of(&response.access_token);
        assert_eq!(claims["nonce"], query_value(&opened.lock().unwrap()[0], "nonce"), "the interactive login's ID token");
    }

    #[tokio::test]
    async fn with_the_option_off_an_at_jwt_access_token_is_handed_over_and_reported_as_a_refused_type() {
        let idp = MockIdp::start();
        idp.mint_at_jwt_access_tokens(true);
        let (session, phases) = test_session();
        let (opener, _) = simulating_opener();

        let response =
            run_flow(context_for(&idp, None), session, opener, reqwest::Client::new(), TokenChoice::AccessToken)
                .await
                .unwrap();

        assert_eq!(claims_of(&response.access_token)["aud"], "mqlens", "still the access token");
        assert_eq!(
            *phases.lock().unwrap(),
            vec!["WaitingForBrowser".to_string(), "Completed(AccessTokenOfRefusedType)".to_string()]
        );
    }

    /// A browser answer that has already landed when the deadline passes and
    /// a cancel arrives is what the user did — it must be what the flow
    /// reports, not "expired" or "cancelled".
    ///
    /// The test polls `run_flow` by hand, so nothing moves between polls
    /// except what the test does. It drives the flow to the browser step,
    /// then — with the flow held still — delivers a denial to the loopback
    /// listener, cancels the session, and waits out a near deadline and a
    /// tick of the cancel poll. The next poll finds every arm of both races
    /// ready at once: `run_flow_inner`'s listener/deadline/cancel `select!`,
    /// and `run_flow`'s whole-body race around it. Both are `biased;` with
    /// the flow first; drop either and the random tie-break reports
    /// `TimedOut` or `Cancelled` about two times out of three, so 50
    /// iterations make a regression catch near-certain.
    ///
    /// A denial rather than a code: with the whole body under the deadline
    /// (spec line 153), a code in hand still needs a network exchange, which
    /// a deadline that has already passed rightly abandons — a success cannot
    /// win this race by design. A denial is the final answer the callback
    /// itself carries.
    #[tokio::test]
    async fn a_browser_answer_already_in_hand_beats_a_later_cancel_and_an_elapsed_deadline() {
        use std::task::Poll;
        let idp = MockIdp::start();

        for _ in 0..50 {
            let (session, _) = test_session();
            let (opener, opened) = recording_opener();
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
            let mut context = context_for(&idp, None);
            context.timeout = Some(deadline);

            let flow = run_flow(context, session.clone(), opener, reqwest::Client::new(), TokenChoice::AccessToken);
            tokio::pin!(flow);

            // To the browser step, one poll at a time.
            while opened.lock().unwrap().is_empty() {
                if let Poll::Ready(result) = futures::poll!(&mut flow) {
                    panic!("premise: the flow must reach the browser step, got {result:?}");
                }
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }

            // The flow is not polled again until all three have happened.
            let url = opened.lock().unwrap()[0].clone();
            let callback = format!(
                "{}?error=access_denied&state={}",
                query_value(&url, "redirect_uri"),
                query_value(&url, "state"),
            );
            reqwest::Client::new().get(&callback).send().await.expect("deliver the denial");
            session.cancel();
            let until = deadline.max(std::time::Instant::now()) + std::time::Duration::from_millis(150);
            tokio::time::sleep_until(tokio::time::Instant::from_std(until)).await;

            let result = match futures::poll!(&mut flow) {
                Poll::Ready(result) => result,
                Poll::Pending => panic!("every arm of both races is ready; the flow must finish in this poll"),
            };
            assert!(
                matches!(result, Err(OidcError::ConsentDenied)),
                "the denial already in hand must win over a later cancel and an \
                 elapsed deadline; got {result:?}"
            );
        }
    }

    fn context_with_issuer(issuer: String, timeout: std::time::Duration) -> CallbackContext {
        CallbackContext::builder()
            .version(1u32)
            .timeout(Some(std::time::Instant::now() + timeout))
            .refresh_token(None)
            .idp_info(Some(
                IdpServerInfo::builder()
                    .issuer(issuer)
                    .client_id(Some("mqlens-test".to_string()))
                    .request_scopes(None)
                    .build(),
            ))
            .build()
    }

    /// Spec line 153: the *whole* callback body is raced against cancel, not
    /// just the browser wait. An IdP that accepts the connection and never
    /// answers discovery must not keep a cancelled login alive — and must
    /// never get as far as opening a browser.
    #[tokio::test]
    async fn a_cancel_during_discovery_returns_promptly_without_opening_the_browser() {
        let port = crate::oidc_login::test_support::silent_server().await;
        let (session, phases) = test_session();
        let (opener, opened) = recording_opener();
        let cancelling = session.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            cancelling.cancel();
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_flow(
                context_with_issuer(format!("http://127.0.0.1:{port}"), std::time::Duration::from_secs(30)),
                session,
                opener,
                reqwest::Client::new(),
                TokenChoice::AccessToken,
            ),
        )
        .await
        .expect("a cancel during discovery must not leave the flow hanging");

        assert!(matches!(result, Err(OidcError::Cancelled)), "got {result:?}");
        assert!(opened.lock().unwrap().is_empty(), "a cancelled login must never open the browser");
        assert_eq!(*phases.lock().unwrap(), vec!["Failed(Cancelled)".to_string()]);
    }

    /// The driver hands us a deadline but does not enforce it; during a
    /// reauth it holds the client's credential-cache lock while our callback
    /// runs. A hung IdP must therefore end at the deadline, not hang forever.
    #[tokio::test]
    async fn an_unresponsive_idp_times_out_instead_of_hanging() {
        let port = crate::oidc_login::test_support::silent_server().await;
        let (session, _) = test_session();
        let (opener, opened) = recording_opener();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_flow(
                context_with_issuer(format!("http://127.0.0.1:{port}"), std::time::Duration::from_millis(300)),
                session,
                opener,
                reqwest::Client::new(),
                TokenChoice::AccessToken,
            ),
        )
        .await
        .expect("an unresponsive IdP must not hang the flow past its deadline");

        assert!(matches!(result, Err(OidcError::TimedOut)), "got {result:?}");
        assert!(opened.lock().unwrap().is_empty());
    }

    /// The race only notices a cancel on its next poll tick; once discovery
    /// resolves, the flow runs straight through to `open()` without yielding.
    /// A cancel that lands just as discovery finishes must still stop it
    /// short of the browser — here the IdP itself cancels while serving the
    /// discovery document.
    #[tokio::test]
    async fn a_cancel_that_lands_as_discovery_finishes_never_opens_the_browser() {
        let idp = MockIdp::start();
        let (session, phases) = test_session();
        let cancelling = session.clone();
        idp.on_discovery(move || cancelling.cancel());
        let (opener, opened) = recording_opener();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_flow(context_for(&idp, None), session, opener, reqwest::Client::new(), TokenChoice::AccessToken),
        )
        .await
        .expect("the flow must not hang");

        assert!(matches!(result, Err(OidcError::Cancelled)), "got {result:?}");
        assert!(opened.lock().unwrap().is_empty(), "a cancelled login must never open the browser");
        assert!(
            !phases.lock().unwrap().iter().any(|p| p == "WaitingForBrowser"),
            "a cancelled login must not announce a browser wait: {:?}",
            phases.lock().unwrap()
        );
    }

    mod attach_human_callback_tests {
        use super::*;
        use crate::connections::OidcProfileConfig;

        fn noop_session() -> Arc<OidcSession> {
            OidcSession::new(Arc::new(|_| {}))
        }

        fn noop_opener() -> BrowserOpener {
            Arc::new(|_: &str| Ok(()))
        }

        /// `attach_human_callback`'s callback attachment itself is not
        /// observable through driver 3.9.0's public API: `Callback`'s
        /// internals (`FunctionInner`, its cache) are `pub(crate)`, so nothing
        /// outside the driver crate can tell an attached human callback apart
        /// from the default one just by inspecting `ClientOptions`. That the
        /// closure actually reaches `run_flow` is proven only by Task 10's
        /// real handshake test. What *is* observable here, and what this
        /// test actually checks, is the mechanism guard's other real effect:
        /// a non-`MONGODB-OIDC` credential must come back byte-for-byte
        /// unchanged, including a field the OIDC branch does write
        /// (`mechanism_properties`) — so a missing or broken early return
        /// would show up as a genuine equality failure, not merely as an
        /// unset field.
        #[tokio::test]
        async fn a_non_oidc_credential_is_left_exactly_as_parsed() {
            let mut scram = ClientOptions::parse(
                "mongodb://user:pass@localhost:27017/?authMechanism=SCRAM-SHA-256",
            )
            .await
            .unwrap();
            let before = scram.credential.clone();
            attach_human_callback(
                &mut scram,
                noop_session(),
                &OidcProfileConfig { allowed_hosts: vec!["mongo.corp.example.com".to_string()], ..Default::default() },
                noop_opener(),
                reqwest::Client::new(),
            );
            assert_eq!(scram.credential, before, "SCRAM must be untouched");
        }

        #[tokio::test]
        async fn allowed_hosts_are_applied_as_a_mechanism_property_not_a_uri_option() {
            let mut options = ClientOptions::parse(
                "mongodb://mongo.corp.example.com:27017/?authMechanism=MONGODB-OIDC&authSource=$external",
            )
            .await
            .unwrap();
            attach_human_callback(
                &mut options,
                noop_session(),
                &OidcProfileConfig { allowed_hosts: vec!["mongo.corp.example.com".to_string()], ..Default::default() },
                noop_opener(),
                reqwest::Client::new(),
            );

            let properties = options
                .credential
                .as_ref()
                .unwrap()
                .mechanism_properties
                .as_ref()
                .expect("ALLOWED_HOSTS must be set");
            let hosts = properties.get_array("ALLOWED_HOSTS").unwrap();
            assert_eq!(hosts.len(), 1);
            assert_eq!(hosts[0].as_str(), Some("mongo.corp.example.com"));
        }

        /// The driver rejects ALLOWED_HOSTS in a URI outright. This pins that we
        /// never try, because the failure mode is a connection that cannot even
        /// parse.
        #[tokio::test]
        async fn allowed_hosts_in_a_uri_is_a_parse_error_we_must_never_produce() {
            let parsed = ClientOptions::parse(
                "mongodb://localhost:27017/?authMechanism=MONGODB-OIDC&authMechanismProperties=ALLOWED_HOSTS:example.com",
            )
            .await;
            assert!(parsed.is_err(), "the driver must still reject this");
        }

        #[tokio::test]
        async fn an_empty_allowed_hosts_list_leaves_the_driver_defaults_alone() {
            let mut options = ClientOptions::parse(
                "mongodb://localhost:27017/?authMechanism=MONGODB-OIDC&authSource=$external",
            )
            .await
            .unwrap();
            attach_human_callback(
                &mut options,
                noop_session(),
                &OidcProfileConfig::default(),
                noop_opener(),
                reqwest::Client::new(),
            );
            let has_hosts = options
                .credential
                .as_ref()
                .unwrap()
                .mechanism_properties
                .as_ref()
                .is_some_and(|p| p.get_array("ALLOWED_HOSTS").is_ok());
            assert!(!has_hosts, "no explicit hosts means the driver's secure defaults apply");
        }

        /// A URI with no credential at all (no auth mechanism, no userinfo)
        /// must not panic — the `let Some(credential) = ... else { return }`
        /// guard is the only thing standing between this and an unwrap on
        /// `None`.
        #[tokio::test]
        async fn a_uri_with_no_credential_is_a_no_op() {
            let mut options = ClientOptions::parse("mongodb://localhost:27017/")
                .await
                .unwrap();
            assert!(options.credential.is_none(), "test assumption: no credential was parsed");
            attach_human_callback(
                &mut options,
                noop_session(),
                &OidcProfileConfig { allowed_hosts: vec!["mongo.corp.example.com".to_string()], ..Default::default() },
                noop_opener(),
                reqwest::Client::new(),
            );
            assert!(options.credential.is_none());
        }
    }
}
