//! A deterministic OIDC provider for tests (#430). Test-only: it mints
//! tokens, which production code must never do. Signed with the RSA
//! keypair in `fixtures/oidc-test-key.pem` — a TEST-ONLY key, not a secret,
//! never used outside tests (see `fixtures/oidc-test-key.README`).

use base64::Engine as _;
use rsa::traits::PublicKeyParts;
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
}

impl MockIdp {
    /// Starts serving on `127.0.0.1` at an OS-assigned port, in a background
    /// thread that lives as long as the returned handle.
    pub fn start() -> MockIdp {
        let server =
            tiny_http::Server::http("127.0.0.1:0").expect("bind mock IdP to a loopback port");
        let issuer = format!("http://{}", server.server_addr());

        let pem_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/oidc-test-key.pem");
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
            json_response(discovery_document(&inner.issuer))
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
            inner.requests.lock().unwrap().push(record);
            json_response(token_document(inner, &body))
        }
        _ => tiny_http::Response::empty(404).boxed(),
    };

    let _ = request.respond(response);
}

fn json_response(body: serde_json::Value) -> tiny_http::ResponseBox {
    let bytes = serde_json::to_vec(&body).expect("serialize mock IdP response");
    tiny_http::Response::from_data(bytes)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("Content-Type header is valid ASCII"),
        )
        .boxed()
}

fn discovery_document(issuer: &str) -> serde_json::Value {
    serde_json::json!({
        "issuer": issuer,
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
    let access_token = sign_access_token(inner, "mock-user", "mqlens");

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
}
