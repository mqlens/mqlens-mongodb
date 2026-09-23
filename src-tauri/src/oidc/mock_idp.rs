//! A deterministic OIDC provider for tests (#430). Test-only: it mints
//! tokens, which production code must never do. Signed with the RSA
//! keypair in `fixtures/oidc-test-key.pem` — a TEST-ONLY key, not a secret,
//! never used outside tests (see `fixtures/oidc-test-key.README`).

use base64::Engine as _;
use rsa::traits::PublicKeyParts;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::B64;

/// One recorded call to `POST /token`, for tests to assert on afterwards.
///
/// Deliberately does not include the minted access/refresh tokens: nothing
/// in this codebase should log or assert on raw token values, per the
/// no-logging-secrets rule that applies to real OIDC tokens too.
#[derive(Clone, Debug, Default)]
pub struct TokenRequestRecord {
    pub grant_type: String,
    pub code: Option<String>,
    pub code_verifier: Option<String>,
    pub refresh_token: Option<String>,
}

struct Inner {
    issuer: String,
    encoding_key: jsonwebtoken::EncodingKey,
    modulus_b64: String,
    requests: Mutex<Vec<TokenRequestRecord>>,
    /// When set, the discovery document advertises this `issuer` instead of
    /// the real one, while every route still serves from the real loopback
    /// address. Lets tests exercise the defence against an IdP that claims
    /// to be someone else.
    lying_issuer: Mutex<Option<String>>,
    /// When set, `/token` refuses `grant_type=refresh_token` with a
    /// `400 {"error":"invalid_grant"}` while `authorization_code` keeps
    /// working — lets tests exercise the fallback from a stale refresh
    /// token to the interactive flow.
    reject_refresh_tokens: AtomicBool,
    /// Run while serving the discovery document, before the response is
    /// sent — so a test can make something happen at the exact moment
    /// discovery is about to finish.
    discovery_hook: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    /// When set, `/token` answers every request with a `307` to this URL
    /// instead of a token — an IdP (or something in front of it) trying to
    /// bounce the code and verifier somewhere else, e.g. to plain `http://`.
    token_redirect: Mutex<Option<String>>,
    /// When set, `/token` mints its access tokens for an audience other than
    /// the `mqlens` the Percona fixture checks: a well-formed, correctly
    /// signed token MongoDB must nonetheless reject.
    wrong_audience: AtomicBool,
}

/// A single-key, single-issuer OIDC provider double bound to a random
/// loopback port. Every route it serves is deterministic: the same
/// authorization code, the same refresh token, and a JWKS that always
/// describes the signing key used by [`MockIdp::mint_access_token`].
pub struct MockIdp {
    inner: Arc<Inner>,
    // Keeps the listener alive for as long as the MockIdp is; dropping the
    // last Arc closes the socket and the serving thread exits its loop.
    _server: Arc<tiny_http::Server>,
    // Only for `start_tls`: dropping it stops the TLS front's accept loop.
    _tls_front: Option<tokio::sync::oneshot::Sender<()>>,
    tls_addr: Option<std::net::SocketAddr>,
}

impl MockIdp {
    /// Starts serving on `127.0.0.1` at an OS-assigned port, in a background
    /// thread that lives as long as the returned handle.
    pub fn start() -> MockIdp {
        let server = bind_loopback();
        let issuer = format!("http://{}", server.server_addr());
        Self::serve(server, issuer, None)
    }

    /// Serves over HTTPS as `https://{host}:{port}` — the issuer a real
    /// `mongod` can be pointed at, since it refuses plain-HTTP issuers.
    ///
    /// The routes are the same `tiny_http` server as [`MockIdp::start`], on
    /// a random loopback port; a TLS front on `port` terminates TLS with the
    /// TEST-ONLY leaf certificate for `host.docker.internal` in `fixtures/`
    /// and forwards the plaintext to it. Clients must trust
    /// `fixtures/oidc-test-ca.pem` and verify as usual.
    ///
    /// The front binds `MQLENS_TEST_OIDC_IDP_BIND` (default `127.0.0.1`).
    /// Docker Desktop delivers `host.docker.internal` traffic to host
    /// loopback; on Linux it arrives on the docker bridge's gateway address,
    /// which `scripts/oidc-percona-fixture.sh` prints for CI to set.
    pub fn start_tls(host: &str, port: u16) -> MockIdp {
        let server = bind_loopback();
        let backend = server
            .server_addr()
            .to_ip()
            .expect("the mock IdP listens on an IP address");
        let bind = std::env::var("MQLENS_TEST_OIDC_IDP_BIND").unwrap_or_else(|_| "127.0.0.1".into());
        let front = std::net::TcpListener::bind((bind.as_str(), port))
            .unwrap_or_else(|e| panic!("bind the mock IdP's TLS front to {bind}:{port}: {e}"));
        let mut tls_addr = front.local_addr().expect("the TLS front has a local address");
        if tls_addr.ip().is_unspecified() {
            // Bound to every interface: loopback is one of them, and unlike
            // 0.0.0.0 it is a connectable destination on every OS.
            tls_addr.set_ip(std::net::Ipv4Addr::LOCALHOST.into());
        }
        let shutdown = spawn_tls_front(front, backend);
        let mut idp = Self::serve(server, format!("https://{host}:{port}"), Some(shutdown));
        idp.tls_addr = Some(tls_addr);
        idp
    }

    /// Where `start_tls`'s front actually listens, for a client that must
    /// reach the issuer's host name without DNS. `None` for [`MockIdp::start`].
    pub fn tls_addr(&self) -> Option<std::net::SocketAddr> {
        self.tls_addr
    }

    fn serve(
        server: tiny_http::Server,
        issuer: String,
        tls_front: Option<tokio::sync::oneshot::Sender<()>>,
    ) -> MockIdp {
        let pem_path = fixture_path("oidc-test-key.pem");
        let pem = std::fs::read_to_string(&pem_path).unwrap_or_else(|e| {
            panic!(
                "read test-only OIDC signing key at {}: {e}",
                pem_path.display()
            )
        });

        let encoding_key = jsonwebtoken::EncodingKey::from_rsa_pem(pem.as_bytes())
            .expect("parse test-only RSA key for signing");

        use rsa::pkcs8::DecodePrivateKey as _;
        let public_key = rsa::RsaPrivateKey::from_pkcs8_pem(&pem)
            .expect("parse test-only RSA key for JWKS derivation")
            .to_public_key();
        let modulus_b64 = B64.encode(public_key.n_bytes());

        let inner = Arc::new(Inner {
            issuer,
            encoding_key,
            modulus_b64,
            requests: Mutex::new(Vec::new()),
            lying_issuer: Mutex::new(None),
            reject_refresh_tokens: AtomicBool::new(false),
            discovery_hook: Mutex::new(None),
            token_redirect: Mutex::new(None),
            wrong_audience: AtomicBool::new(false),
        });
        let server = Arc::new(server);

        let inner_for_thread = inner.clone();
        let server_for_thread = server.clone();
        std::thread::spawn(move || {
            for request in server_for_thread.incoming_requests() {
                handle_request(request, &inner_for_thread);
            }
        });

        MockIdp {
            inner,
            _server: server,
            _tls_front: tls_front,
            tls_addr: None,
        }
    }

    pub fn issuer(&self) -> String {
        self.inner.issuer.clone()
    }

    /// Mints an RS256 JWT for `subject`/`audience`, signed with the same
    /// test-only key the JWKS route describes.
    pub fn mint_access_token(&self, subject: &str, audience: &str) -> String {
        sign_access_token(&self.inner, subject, audience)
    }

    /// The most recent `POST /token` call this provider has seen, if any.
    pub fn last_token_request(&self) -> Option<TokenRequestRecord> {
        self.inner.requests.lock().unwrap().last().cloned()
    }

    /// From now on, the discovery document's `issuer` field names a
    /// different value than the address actually serving it. Requests still
    /// land on the real loopback server; only the advertised `issuer`
    /// string is a lie.
    pub fn lie_about_issuer(&self) {
        let fake = format!("{}-imposter", self.inner.issuer);
        *self.inner.lying_issuer.lock().unwrap() = Some(fake);
    }

    /// From now on, `/token` rejects `grant_type=refresh_token` with
    /// `400 {"error":"invalid_grant"}`. `authorization_code` requests are
    /// unaffected.
    pub fn reject_refresh_tokens(&self) {
        self.inner.reject_refresh_tokens.store(true, Ordering::SeqCst);
    }

    /// From now on, `hook` runs each time the discovery document is served,
    /// just before the response goes out.
    pub fn on_discovery(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.inner.discovery_hook.lock().unwrap() = Some(Box::new(hook));
    }

    /// From now on, `/token` answers with `307 Temporary Redirect` to `url`
    /// — the status that tells a client to resend the same POST, body and
    /// all, to the new location.
    pub fn redirect_token_requests_to(&self, url: &str) {
        *self.inner.token_redirect.lock().unwrap() = Some(url.to_string());
    }

    /// While `on`, `/token` mints access tokens whose `aud` is not the
    /// `mqlens` a MongoDB deployment configured for this IdP expects.
    pub fn mint_wrong_audience(&self, on: bool) {
        self.inner.wrong_audience.store(on, Ordering::SeqCst);
    }
}

fn bind_loopback() -> tiny_http::Server {
    tiny_http::Server::http("127.0.0.1:0").expect("bind mock IdP to a loopback port")
}

fn fixture_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures").join(name)
}

/// The TEST-ONLY server identity from `fixtures/`: a leaf for
/// `host.docker.internal` signed by `oidc-test-ca.pem`. Uses ring
/// explicitly because the dependency graph enables two rustls providers, so
/// there is no unambiguous process default.
fn tls_server_config() -> rustls::ServerConfig {
    use rustls::pki_types::pem::PemObject as _;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};

    let cert_path = fixture_path("oidc-test-idp.crt.pem");
    let certs = CertificateDer::pem_file_iter(&cert_path)
        .and_then(|certs| certs.collect::<Result<Vec<_>, _>>())
        .unwrap_or_else(|e| panic!("read TEST-ONLY IdP certificate {}: {e}", cert_path.display()));
    let key_path = fixture_path("oidc-test-idp.key.pem");
    let key = PrivateKeyDer::from_pem_file(&key_path)
        .unwrap_or_else(|e| panic!("read TEST-ONLY IdP key {}: {e}", key_path.display()));

    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .expect("the TEST-ONLY IdP certificate and key match")
}

/// Accepts TLS on `front` and pipes each decrypted connection to the plain
/// `tiny_http` server at `backend`. Runs on its own thread and runtime so it
/// works under any test runtime flavour, and stops when the returned sender
/// is dropped (with the `MockIdp` that owns it).
fn spawn_tls_front(
    front: std::net::TcpListener,
    backend: std::net::SocketAddr,
) -> tokio::sync::oneshot::Sender<()> {
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls_server_config()));
    front
        .set_nonblocking(true)
        .expect("make the TLS front non-blocking for tokio");
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build the TLS front's runtime");
        runtime.block_on(async move {
            let front =
                tokio::net::TcpListener::from_std(front).expect("hand the TLS front to tokio");
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => return,
                    accepted = front.accept() => {
                        let Ok((tcp, _)) = accepted else { continue };
                        let acceptor = acceptor.clone();
                        tokio::spawn(async move {
                            // A failed handshake (an untrusting client) just
                            // drops the connection, as a real server would.
                            let Ok(mut tls) = acceptor.accept(tcp).await else { return };
                            let Ok(mut plain) = tokio::net::TcpStream::connect(backend).await else {
                                return;
                            };
                            let _ = tokio::io::copy_bidirectional(&mut tls, &mut plain).await;
                        });
                    }
                }
            }
        });
    });

    shutdown_tx
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Shared by [`MockIdp::mint_access_token`] and the `/token` route so both
/// mint from the same claims shape, signed with the same test-only key.
fn sign_access_token(inner: &Inner, subject: &str, audience: &str) -> String {
    let claims = serde_json::json!({
        "iss": inner.issuer,
        "sub": subject,
        "aud": audience,
        "exp": now_secs() + 3600,
        "iat": now_secs(),
    });
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some("test-key-1".into());
    jsonwebtoken::encode(&header, &claims, &inner.encoding_key)
        .expect("sign JWT with test-only RSA key")
}

fn handle_request(mut request: tiny_http::Request, inner: &Inner) {
    // Split off the query string, if any, so route matching ignores it.
    let (path, query) = match request.url().split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (request.url().to_string(), String::new()),
    };

    let response = match (request.method(), path.as_str()) {
        (tiny_http::Method::Get, "/.well-known/openid-configuration") => {
            let lying = inner.lying_issuer.lock().unwrap().clone();
            let advertised_issuer = lying.as_deref().unwrap_or(&inner.issuer);
            if let Some(hook) = inner.discovery_hook.lock().unwrap().as_ref() {
                hook();
            }
            json_response(discovery_document(&inner.issuer, advertised_issuer))
        }
        (tiny_http::Method::Get, "/jwks") => json_response(jwks_document(&inner.modulus_b64)),
        (tiny_http::Method::Get, "/authorize") => authorize_response(&query),
        (tiny_http::Method::Post, "/token") => {
            let mut body = String::new();
            request
                .as_reader()
                .read_to_string(&mut body)
                .expect("read /token request body");
            let record = parse_token_request(&body);
            let reject_this = record.grant_type == "refresh_token"
                && inner.reject_refresh_tokens.load(Ordering::SeqCst);
            inner.requests.lock().unwrap().push(record);
            let redirect = inner.token_redirect.lock().unwrap().clone();
            if let Some(location) = redirect {
                tiny_http::Response::empty(307)
                    .with_header(
                        tiny_http::Header::from_bytes(&b"Location"[..], location.as_bytes())
                            .expect("Location header is valid ASCII"),
                    )
                    .boxed()
            } else if reject_this {
                json_response_with_status(400, serde_json::json!({"error": "invalid_grant"}))
            } else {
                json_response(token_document(inner, &body))
            }
        }
        _ => tiny_http::Response::empty(404).boxed(),
    };

    let _ = request.respond(response);
}

fn json_response(body: serde_json::Value) -> tiny_http::ResponseBox {
    json_response_with_status(200, body)
}

fn json_response_with_status(status: u16, body: serde_json::Value) -> tiny_http::ResponseBox {
    let bytes = serde_json::to_vec(&body).expect("serialize mock IdP response");
    tiny_http::Response::from_data(bytes)
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("Content-Type header is valid ASCII"),
        )
        .boxed()
}

/// `issuer` is the real address routes are served from (used to build the
/// endpoint URLs); `advertised_issuer` is what the document claims in its
/// `issuer` field, which [`MockIdp::lie_about_issuer`] can make differ.
fn discovery_document(issuer: &str, advertised_issuer: &str) -> serde_json::Value {
    serde_json::json!({
        "issuer": advertised_issuer,
        "authorization_endpoint": format!("{issuer}/authorize"),
        "token_endpoint": format!("{issuer}/token"),
        "jwks_uri": format!("{issuer}/jwks"),
        "response_types_supported": ["code"],
        "code_challenge_methods_supported": ["S256"],
    })
}

fn jwks_document(modulus_b64: &str) -> serde_json::Value {
    serde_json::json!({
        "keys": [{
            "kty": "RSA",
            "alg": "RS256",
            "use": "sig",
            "kid": "test-key-1",
            "n": modulus_b64,
            "e": "AQAB",
        }]
    })
}

/// A fixed test subject/audience: nothing in Task 1 inspects the claims of
/// the token this route hands back, only that the shape is right. Callers
/// that need specific claims use [`MockIdp::mint_access_token`] directly.
fn token_document(inner: &Inner, _body: &str) -> serde_json::Value {
    let audience = if inner.wrong_audience.load(Ordering::SeqCst) { "not-mqlens" } else { "mqlens" };
    let access_token = sign_access_token(inner, "mock-user", audience);

    serde_json::json!({
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": "test-refresh-token",
    })
}

fn authorize_response(query: &str) -> tiny_http::ResponseBox {
    let params = parse_form_pairs(query);
    let redirect_uri = params
        .iter()
        .find(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let state = params.iter().find(|(k, _)| k == "state").map(|(_, v)| v.clone());

    let separator = if redirect_uri.contains('?') { '&' } else { '?' };
    let mut location = format!("{redirect_uri}{separator}code=test-auth-code");
    if let Some(state) = state {
        location.push_str(&format!("&state={state}"));
    }

    tiny_http::Response::empty(302)
        .with_header(
            tiny_http::Header::from_bytes(&b"Location"[..], location.as_bytes())
                .expect("Location header is valid ASCII"),
        )
        .boxed()
}

fn parse_token_request(body: &str) -> TokenRequestRecord {
    let params = parse_form_pairs(body);
    let get = |key: &str| {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    TokenRequestRecord {
        grant_type: get("grant_type").unwrap_or_default(),
        code: get("code"),
        code_verifier: get("code_verifier"),
        refresh_token: get("refresh_token"),
    }
}

/// Minimal `application/x-www-form-urlencoded` parser shared by the query
/// string on `/authorize` and the body of `/token`. Good enough for the
/// ASCII, unreserved-charset values this test double ever sees.
fn parse_form_pairs(input: &str) -> Vec<(String, String)> {
    if input.is_empty() {
        return Vec::new();
    }
    input
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (percent_decode(k), percent_decode(v)),
            None => (percent_decode(pair), String::new()),
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(
                    std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or_default(),
                    16,
                ) {
                    out.push(byte);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn discovery_and_jwks_describe_the_same_signing_key() {
        let idp = MockIdp::start();
        let client = reqwest::Client::new();

        let discovery: serde_json::Value = client
            .get(format!("{}/.well-known/openid-configuration", idp.issuer()))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(discovery["issuer"], idp.issuer());
        assert_eq!(
            discovery["authorization_endpoint"],
            format!("{}/authorize", idp.issuer())
        );
        assert_eq!(discovery["token_endpoint"], format!("{}/token", idp.issuer()));
        assert_eq!(discovery["jwks_uri"], format!("{}/jwks", idp.issuer()));
        assert_eq!(
            discovery["response_types_supported"],
            serde_json::json!(["code"])
        );
        assert_eq!(
            discovery["code_challenge_methods_supported"],
            serde_json::json!(["S256"])
        );

        let jwks: serde_json::Value = client
            .get(format!("{}/jwks", idp.issuer()))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let key = &jwks["keys"][0];
        assert_eq!(key["kty"], "RSA");
        assert_eq!(key["alg"], "RS256");
        assert!(key["n"].as_str().is_some_and(|n| !n.is_empty()));
        assert_eq!(key["e"], "AQAB");
    }

    #[tokio::test]
    async fn minted_access_token_verifies_against_the_published_jwks() {
        let idp = MockIdp::start();
        let token = idp.mint_access_token("user-42", "mqlens");

        // Fetch the JWKS over HTTP and decode with exactly what it publishes,
        // proving the served JWKS and the signing key genuinely agree.
        let jwks: serde_json::Value = reqwest::Client::new()
            .get(format!("{}/jwks", idp.issuer()))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let n = jwks["keys"][0]["n"].as_str().unwrap();
        let e = jwks["keys"][0]["e"].as_str().unwrap();
        let decoding_key = jsonwebtoken::DecodingKey::from_rsa_components(n, e).unwrap();

        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_audience(&["mqlens"]);
        validation.set_issuer(&[idp.issuer()]);

        let data =
            jsonwebtoken::decode::<serde_json::Value>(&token, &decoding_key, &validation).unwrap();

        assert_eq!(data.claims["sub"], "user-42");
        assert_eq!(data.claims["aud"], "mqlens");
        assert_eq!(data.claims["iss"], idp.issuer());
    }

    #[tokio::test]
    async fn authorize_redirects_with_code_and_echoes_state() {
        let idp = MockIdp::start();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();

        let response = client
            .get(format!(
                "{}/authorize?redirect_uri=http://127.0.0.1:9/callback&state=xyz-state&response_type=code",
                idp.issuer()
            ))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(location.starts_with("http://127.0.0.1:9/callback"));
        assert!(location.contains("code=test-auth-code"));
        assert!(location.contains("state=xyz-state"));
    }

    #[tokio::test]
    async fn token_endpoint_records_the_request_and_returns_a_bearer_token() {
        let idp = MockIdp::start();
        let client = reqwest::Client::new();

        let response: serde_json::Value = client
            .post(format!("{}/token", idp.issuer()))
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body("grant_type=authorization_code&code=test-auth-code&code_verifier=verifier-abc")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(response["token_type"], "Bearer");
        assert_eq!(response["expires_in"], 3600);
        assert_eq!(response["refresh_token"], "test-refresh-token");
        assert!(response["access_token"].as_str().is_some_and(|t| !t.is_empty()));

        let recorded = idp.last_token_request().unwrap();
        assert_eq!(recorded.grant_type, "authorization_code");
        assert_eq!(recorded.code.as_deref(), Some("test-auth-code"));
        assert_eq!(recorded.code_verifier.as_deref(), Some("verifier-abc"));
        assert_eq!(recorded.refresh_token, None);
    }

    #[tokio::test]
    async fn reject_refresh_tokens_only_rejects_the_refresh_grant() {
        let idp = MockIdp::start();
        idp.reject_refresh_tokens();
        let client = reqwest::Client::new();

        let refresh_response = client
            .post(format!("{}/token", idp.issuer()))
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body("grant_type=refresh_token&refresh_token=test-refresh-token")
            .send()
            .await
            .unwrap();
        assert_eq!(refresh_response.status(), 400);
        let body: serde_json::Value = refresh_response.json().await.unwrap();
        assert_eq!(body["error"], "invalid_grant");

        // authorization_code keeps working even after reject_refresh_tokens().
        let code_response = client
            .post(format!("{}/token", idp.issuer()))
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body("grant_type=authorization_code&code=test-auth-code&code_verifier=verifier-abc")
            .send()
            .await
            .unwrap();
        assert_eq!(code_response.status(), 200);
    }
}
