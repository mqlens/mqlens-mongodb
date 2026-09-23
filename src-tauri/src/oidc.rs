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
    if url.starts_with("https://") {
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

/// The query parameters an IdP redirect to `/callback` carries. `state` is
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

/// Which page a callback's own query parameters call for, decided before
/// the request is answered — `handle_callback` must not respond "success"
/// for a request that the params themselves show was a denial or was
/// malformed, even though the real state/error/code interpretation
/// (`interpret_callback`) only happens later, inside `wait()`.
fn callback_outcome_page(params: &CallbackParams) -> &'static str {
    if params.error.is_some() {
        CALLBACK_NOT_COMPLETED_PAGE
    } else if params.code.is_some() {
        CALLBACK_SUCCESS_PAGE
    } else {
        CALLBACK_NOT_COMPLETED_PAGE
    }
}

fn handle_callback(
    uri: axum::http::Uri,
    result_tx: std::sync::Arc<StdMutex<Option<oneshot::Sender<CallbackParams>>>>,
) -> axum::response::Html<&'static str> {
    let params = parse_callback_params(uri.query().unwrap_or(""));
    let outcome_page = callback_outcome_page(&params);
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

/// A one-shot HTTP server on a loopback port, waiting for exactly one
/// `GET /callback` from the system browser. Modeled on the MCP server's own
/// `TcpListener::bind` + `axum::serve(..).with_graceful_shutdown(..)`
/// idiom (`mcp.rs`).
pub struct LoopbackListener {
    pub redirect_uri: String,
    result_rx: StdMutex<Option<oneshot::Receiver<CallbackParams>>>,
    shutdown_tx: StdMutex<Option<oneshot::Sender<()>>>,
}

impl LoopbackListener {
    /// Bind an ephemeral port on loopback only (`127.0.0.1:0` — never a LAN
    /// interface) and start serving `GET /callback` in the background. The
    /// server accepts exactly one request that finds the one-shot sender
    /// still present; every later request (replay, reload) gets
    /// [`CALLBACK_REPLAY_PAGE`] instead and does not touch the waiter.
    pub async fn bind() -> Result<Self, OidcError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| OidcError::PortUnavailable)?;
        let port = listener
            .local_addr()
            .map_err(|_| OidcError::PortUnavailable)?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");

        let (result_tx, result_rx) = oneshot::channel::<CallbackParams>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let result_tx = std::sync::Arc::new(StdMutex::new(Some(result_tx)));

        let router = axum::Router::new().route(
            "/callback",
            axum::routing::get(move |uri: axum::http::Uri| {
                let result_tx = std::sync::Arc::clone(&result_tx);
                async move { handle_callback(uri, result_tx) }
            }),
        );

        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router.into_make_service())
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
            {
                eprintln!("oidc::LoopbackListener: axum::serve exited with an error: {e}");
            }
        });

        Ok(Self {
            redirect_uri,
            result_rx: StdMutex::new(Some(result_rx)),
            shutdown_tx: StdMutex::new(Some(shutdown_tx)),
        })
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

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

/// `expires_in` is IdP-controlled, so the addition is checked: a value too
/// large to represent as an `Instant` is treated as no expiry at all rather
/// than panicking inside the driver's authentication path.
fn into_idp_response(token: TokenResponse) -> IdpServerResponse {
    let expires = token.expires_in.and_then(|secs| {
        std::time::Instant::now().checked_add(std::time::Duration::from_secs(secs))
    });
    IdpServerResponse::builder()
        .access_token(token.access_token)
        .expires(expires)
        .refresh_token(token.refresh_token)
        .build()
}

/// POST the form and map the response. Every failure collapses to
/// `TokenExchangeFailed`: the underlying reqwest error can carry the request
/// URL, which carries the code, so it must not reach the error.
async fn post_token_form(
    endpoints: &Endpoints,
    form: &[(&str, &str)],
    http: &reqwest::Client,
) -> Result<IdpServerResponse, OidcError> {
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
    Ok(into_idp_response(token))
}

/// Exchange an authorization code (with its PKCE verifier) for tokens.
pub async fn exchange_code(
    endpoints: &Endpoints,
    client_id: &str,
    code: &str,
    verifier: &PkceVerifier,
    redirect_uri: &str,
    http: &reqwest::Client,
) -> Result<IdpServerResponse, OidcError> {
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
    )
    .await
}

/// Use a refresh token to obtain a new access token.
pub async fn refresh_token(
    endpoints: &Endpoints,
    client_id: &str,
    refresh: &str,
    http: &reqwest::Client,
) -> Result<IdpServerResponse, OidcError> {
    post_token_form(
        endpoints,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", client_id),
        ],
        http,
    )
    .await
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
    Completed,
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
) -> Result<IdpServerResponse, OidcError> {
    let result = run_flow_inner(ctx, &session, open, http).await;
    match &result {
        Ok(_) => session.emit(OidcPhase::Completed),
        Err(error) => session.emit(OidcPhase::Failed(error.clone())),
    }
    result
}

async fn run_flow_inner(
    ctx: CallbackContext,
    session: &OidcSession,
    open: BrowserOpener,
    http: reqwest::Client,
) -> Result<IdpServerResponse, OidcError> {
    let idp = ctx.idp_info.ok_or(OidcError::DiscoveryFailed)?;
    let endpoints = discover(&idp.issuer, &http).await?;
    let client_id = idp.client_id.clone().ok_or(OidcError::MissingClientId)?;

    // A cached refresh token is tried first and never opens a browser. A
    // rejected refresh (expired, revoked) is not returned as an error here —
    // it falls through to the interactive flow below.
    if let Some(refresh) = ctx.refresh_token.as_deref() {
        if let Ok(response) = refresh_token(&endpoints, &client_id, refresh, &http).await {
            return Ok(response);
        }
    }

    let listener = LoopbackListener::bind().await?;
    let request = build_authorization_request(&endpoints, &idp, &listener.redirect_uri)?;
    // Captured before `listener` is moved into `wait()` below.
    let redirect_uri = listener.redirect_uri.clone();

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
    // random, not by declaration order. Without `biased`, a callback that
    // has already arrived could still lose to a deadline that elapsed or a
    // cancel that landed in that same wake — reporting `TimedOut` or
    // `Cancelled` while silently discarding an authorization code already in
    // hand. `biased` makes the listener win deterministically whenever it
    // is ready, and the deadline/cancel arms still fire normally whenever it
    // genuinely is not.
    let code = tokio::select! {
        biased;
        result = listener.wait(&request.state) => result?,
        _ = wait_for_deadline(ctx.timeout) => return Err(OidcError::TimedOut),
        _ = wait_for_cancel(session) => return Err(OidcError::Cancelled),
    };

    exchange_code(&endpoints, &client_id, &code, &request.verifier, &redirect_uri, &http).await
}

use futures::future::FutureExt as _;
use mongodb::options::oidc::Callback;
use mongodb::options::{AuthMechanism, ClientOptions};

/// Attach the human OIDC callback — and only for `MONGODB-OIDC`. Every other
/// mechanism is left exactly as parsed.
///
/// `allowed_hosts` is applied here rather than in the URI because
/// `ClientOptions::parse` rejects `ALLOWED_HOSTS` outright. An empty list
/// leaves the driver's own secure defaults in place; we never broaden them.
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
    allowed_hosts: &[String],
    open: BrowserOpener,
    http: reqwest::Client,
) {
    let Some(credential) = options.credential.as_mut() else {
        return;
    };
    if credential.mechanism != Some(AuthMechanism::MongoDbOidc) {
        return;
    }

    if !allowed_hosts.is_empty() {
        let hosts: mongodb::bson::Array = allowed_hosts
            .iter()
            .map(|host| mongodb::bson::Bson::String(host.clone()))
            .collect();
        let properties = credential
            .mechanism_properties
            .get_or_insert_with(mongodb::bson::Document::new);
        properties.insert("ALLOWED_HOSTS", hosts);
    }

    credential.oidc_callback = Callback::human(move |context: CallbackContext| {
        let session = session.clone();
        let open = open.clone();
        let http = http.clone();
        async move {
            run_flow(context, session, open, http)
                .await
                .map_err(to_driver_error)
        }
        .boxed()
    });
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
        let source = include_str!("oidc.rs");
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
        let source = include_str!("oidc.rs");
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
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        assert!(redirect.starts_with("http://127.0.0.1:"), "got {redirect}");

        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let response = get(&format!("{redirect}?code=test-auth-code&state=state-abc")).await;

        assert!(response.status().is_success());
        let page = response.text().await.unwrap();
        assert!(!page.contains("test-auth-code"), "the success page must not echo the code");

        assert_eq!(waiter.await.unwrap(), Ok("test-auth-code".to_string()));
    }

    #[tokio::test]
    async fn a_mismatched_state_is_refused() {
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        get(&format!("{redirect}?code=test-auth-code&state=state-WRONG")).await;
        assert_eq!(waiter.await.unwrap(), Err(OidcError::StateMismatch));
    }

    #[tokio::test]
    async fn an_oauth_error_is_reported_as_denied_consent() {
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        get(&format!("{redirect}?error=access_denied&state=state-abc")).await;
        assert_eq!(waiter.await.unwrap(), Err(OidcError::ConsentDenied));
    }

    #[tokio::test]
    async fn other_oauth_errors_keep_their_code() {
        let listener = LoopbackListener::bind().await.unwrap();
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
        let listener = LoopbackListener::bind().await.unwrap();
        let base = listener.redirect_uri.replace("/callback", "");
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let response = get(&format!("{base}/?code=test-auth-code&state=state-abc")).await;
        assert_eq!(response.status(), 404);
        // The real callback still works afterwards.
        get(&format!("{base}/callback?code=test-auth-code&state=state-abc")).await;
        assert_eq!(waiter.await.unwrap(), Ok("test-auth-code".to_string()));
    }

    #[tokio::test]
    async fn a_post_is_not_the_callback() {
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let response = reqwest::Client::new()
            .post(format!("{redirect}?code=test-auth-code&state=state-abc"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 405);

        get(&format!("{redirect}?code=test-auth-code&state=state-abc")).await;
        assert_eq!(waiter.await.unwrap(), Ok("test-auth-code".to_string()));
    }

    #[tokio::test]
    async fn a_callback_without_a_code_is_refused() {
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        get(&format!("{redirect}?state=state-abc")).await;
        assert_eq!(waiter.await.unwrap(), Err(OidcError::TokenExchangeFailed));
    }

    #[tokio::test]
    async fn a_dropped_listener_releases_its_port_without_waiting() {
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        drop(listener);

        let released = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if reqwest::Client::new().get(&redirect).send().await.is_err() {
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
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let response = get(&format!("{redirect}?error=access_denied&state=state-abc")).await;
        let page = response.text().await.unwrap();
        assert!(!page.contains("Login complete"), "a denied login must not show the success page: {page}");
        assert!(waiter.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn a_malformed_callback_does_not_claim_success_in_the_browser() {
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });
        let response = get(&format!("{redirect}?state=state-abc")).await;
        let page = response.text().await.unwrap();
        assert!(!page.contains("Login complete"), "a malformed callback must not show the success page: {page}");
        assert!(waiter.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn concurrent_requests_deliver_exactly_one_result() {
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri.clone();
        let waiter = tokio::spawn(async move { listener.wait("state-abc").await });

        let url_a = format!("{redirect}?code=code-a&state=state-abc");
        let url_b = format!("{redirect}?code=code-b&state=state-abc");
        let (response_a, response_b) = tokio::join!(get(&url_a), get(&url_b));
        let (page_a, page_b) = (response_a.text().await.unwrap(), response_b.text().await.unwrap());

        let successes = [&page_a, &page_b].into_iter().filter(|p| p.as_str() == CALLBACK_SUCCESS_PAGE).count();
        let replays = [&page_a, &page_b].into_iter().filter(|p| p.as_str() == CALLBACK_REPLAY_PAGE).count();
        assert_eq!(successes, 1, "exactly one concurrent request must see the success page");
        assert_eq!(replays, 1, "exactly one concurrent request must see the replay page");

        let result = waiter.await.unwrap();
        assert!(result == Ok("code-a".to_string()) || result == Ok("code-b".to_string()), "got {result:?}");
    }

    #[tokio::test]
    async fn shutdown_releases_the_port_and_resolves_the_waiter() {
        let listener = LoopbackListener::bind().await.unwrap();
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

        let response = exchange_code(
            &endpoints,
            "client-abc",
            "test-auth-code",
            &verifier,
            "http://127.0.0.1:1/callback",
            &http,
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
        });
        assert_eq!(response.expires, None);
    }

    #[tokio::test]
    async fn refreshing_uses_the_refresh_grant() {
        let idp = MockIdp::start();
        let http = reqwest::Client::new();
        let endpoints = discover(&idp.issuer(), &http).await.unwrap();

        let response = refresh_token(&endpoints, "client-abc", "test-refresh-token", &http)
            .await
            .unwrap();
        assert!(!response.access_token.is_empty());

        let sent = idp.last_token_request().unwrap();
        assert_eq!(sent.grant_type, "refresh_token");
        assert_eq!(sent.refresh_token.as_deref(), Some("test-refresh-token"));
        assert_eq!(sent.code, None);
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
        )
        .await
        .unwrap_err();
        let rendered = format!("{error} | {error:?}");
        assert!(!rendered.contains("test-auth-code"), "got {rendered}");
        assert!(!rendered.contains("super-secret-verifier"), "got {rendered}");
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
    // (reqwest follows the mock IdP's 302 to our /callback), standing in
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
    /// our loopback `/callback`. Stands in for a human clicking through the
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

    /// Like `simulating_opener`, but completes the IdP redirect *before
    /// returning* rather than merely kicking it off — so that by the time
    /// `run_flow_inner` reaches its `tokio::select!`, the loopback
    /// listener's oneshot has already fired and that arm is genuinely ready
    /// on the very first poll, not just "ready soon". `open` is a
    /// synchronous `Fn`, so it can't `.await` the GET itself: the GET runs
    /// on a plain OS thread with its own standalone tokio runtime, and
    /// `open` blocks (via `JoinHandle::join`) until that thread is done.
    /// Requires a multi-threaded test runtime with at least one other
    /// worker thread free to run the listener's own accept loop while this
    /// one blocks — see the callers, which use
    /// `#[tokio::test(flavor = "multi_thread", ...)]`.
    pub(super) fn completing_opener() -> (BrowserOpener, Arc<StdMutex<Vec<String>>>) {
        let opened = Arc::new(StdMutex::new(Vec::new()));
        let recorder = opened.clone();
        let opener: BrowserOpener = Arc::new(move |url: &str| {
            recorder.lock().unwrap().push(url.to_string());
            let url = url.to_string();
            let handle = std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new()
                    .expect("build a standalone runtime for the completing opener");
                rt.block_on(async {
                    let _ = reqwest::Client::new().get(&url).send().await;
                });
            });
            handle.join().expect("completing opener thread panicked");
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
        )
        .await
        .unwrap();

        assert!(!response.access_token.is_empty());
        assert_eq!(opened.lock().unwrap().len(), 1, "the browser opens exactly once");
        let phases = phases.lock().unwrap().clone();
        assert_eq!(phases, vec!["WaitingForBrowser".to_string(), "Completed".to_string()]);
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
        )
        .await
        .unwrap();

        assert!(!response.access_token.is_empty());
        assert_eq!(opened.lock().unwrap().len(), 1, "it must recover interactively");
    }

    #[tokio::test]
    async fn cancelling_returns_promptly_and_does_not_hang() {
        // `idp` is started but deliberately never contacted: `recording_opener`
        // never navigates, so nothing ever drives a callback into the
        // loopback listener, and `run_flow` must fall out via cancellation
        // instead of hanging on a callback that will never arrive.
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
            run_flow(context_for(&idp, None), session, opener, reqwest::Client::new()),
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
        // `idp` is started but deliberately never contacted, since
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
            run_flow(context, session, opener, reqwest::Client::new()),
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
        let result = run_flow(context, session, opener, reqwest::Client::new()).await;
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
            run_flow(context_for(&idp_a, None), session_a, opener_a, reqwest::Client::new()),
            run_flow(context_for(&idp_b, None), session_b, opener_b, reqwest::Client::new()),
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

    /// Drives the real `run_flow` through the exact race the review
    /// flagged: by the time `run_flow_inner` reaches its `tokio::select!`,
    /// all three arms are already ready on the very first poll —
    /// `completing_opener` has already driven the callback into the
    /// loopback listener's oneshot before `run_flow_inner` even calls
    /// `open()`'s continuation, the deadline is already in the past, and
    /// the session is already cancelled. Without `biased;` (and the
    /// listener arm listed first) in `run_flow_inner`'s `select!`, the
    /// random tie-break would discard the held authorization code roughly
    /// two times out of three; looping 50 times makes a regression catch
    /// near-certain.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_callback_already_in_hand_beats_an_already_elapsed_deadline_and_a_pre_cancelled_session(
    ) {
        let idp = MockIdp::start();

        for _ in 0..50 {
            let (session, _) = test_session();
            session.cancel();
            let (opener, _) = completing_opener();

            let mut context = context_for(&idp, None);
            context.timeout = Some(std::time::Instant::now() - std::time::Duration::from_secs(1));

            let result = run_flow(context, session, opener, reqwest::Client::new()).await;
            match result {
                Ok(response) => assert!(!response.access_token.is_empty()),
                Err(error) => panic!(
                    "a callback already in hand must win over an already-elapsed \
                     deadline and a pre-cancelled session; got {error:?}"
                ),
            }
        }
    }

    mod attach_human_callback_tests {
        use super::*;

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
                &["mongo.corp.example.com".to_string()],
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
                &["mongo.corp.example.com".to_string()],
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
                &[],
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
                &["mongo.corp.example.com".to_string()],
                noop_opener(),
                reqwest::Client::new(),
            );
            assert!(options.credential.is_none());
        }
    }
}
