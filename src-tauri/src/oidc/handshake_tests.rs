//! The tests that prove the MongoDB driver really completes MONGODB-OIDC
//! through the callback `attach_human_callback` installs (#430) — attached by
//! hand, and through the app's own connect and connection-test paths. Every
//! other OIDC test mocks the driver away; these do not, and they are the only
//! proof that the attachment is real — driver 3.9.0 keeps `Callback`'s
//! internals `pub(crate)`, so nothing else can observe it.
//!
//! Skipped unless `MQLENS_TEST_OIDC_URI` is set, because they need a Percona
//! Server for MongoDB configured to trust our mock IdP. Start one with
//! `scripts/oidc-percona-fixture.sh start`, which prints the variables these
//! tests read; CI does the same.
//!
//! mongod only fetches an issuer's keys over HTTPS, so the mock IdP serves
//! TLS at `https://host.docker.internal:<MQLENS_TEST_OIDC_IDP_PORT>` with the
//! TEST-ONLY certificate in `fixtures/`. The container resolves that name to
//! this host; this process does not need to, because its HTTP client pins
//! the name to loopback and trusts the TEST-ONLY CA. Certificate verification
//! stays on throughout.

use super::mock_idp::MockIdp;
use super::tests::{simulating_opener_with, test_session};
use super::*;
use mongodb::bson::{doc, Bson};

const ISSUER_HOST: &str = "host.docker.internal";

/// The principal mongod derives for the mock IdP's tokens:
/// `<authNamePrefix>/<sub>` in `$external`. `sub` is fixed by the mock IdP's
/// `/token` route; `test` is the fixture's `authNamePrefix`.
const EXPECTED_USER: &str = "test/mock-user";

/// An HTTP client that reaches the mock IdP the way the container does —
/// by the issuer's own host name — without touching this machine's DNS or
/// hosts file, and that trusts only what a normal client trusts plus the
/// TEST-ONLY CA.
fn idp_client(idp: &MockIdp) -> reqwest::Client {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/oidc-test-ca.pem");
    let ca = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("read TEST-ONLY CA at {}: {e}", path.display()));
    reqwest::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&ca).expect("parse TEST-ONLY CA"))
        .resolve(ISSUER_HOST, idp.tls_addr().expect("a TLS mock IdP"))
        .build()
        .expect("build the IdP HTTP client")
}

/// The fixture's URI and the one mock IdP every test here shares, or `None`
/// (skip) when `MQLENS_TEST_OIDC_URI` is unset.
///
/// Shared because mongod trusts exactly one issuer port: one IdP per test
/// would race to rebind it, since a dropped IdP frees the port only once its
/// TLS thread notices. The IdP runs on its own threads, so it outlives any
/// one test's runtime. Each test still builds its own `idp_client`, whose
/// pooled connections belong to that test's runtime.
fn fixture() -> Option<(String, &'static MockIdp)> {
    static IDP: std::sync::OnceLock<MockIdp> = std::sync::OnceLock::new();
    let Ok(uri) = std::env::var("MQLENS_TEST_OIDC_URI") else {
        eprintln!("skipping: MQLENS_TEST_OIDC_URI is not set");
        return None;
    };
    let idp = IDP.get_or_init(|| {
        let port: u16 = std::env::var("MQLENS_TEST_OIDC_IDP_PORT")
            .expect("MQLENS_TEST_OIDC_IDP_PORT must accompany MQLENS_TEST_OIDC_URI")
            .parse()
            .expect("MQLENS_TEST_OIDC_IDP_PORT must be a port number");
        MockIdp::start_tls(ISSUER_HOST, port)
    });
    Some((uri, idp))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_driver_authenticates_a_real_server_through_our_oidc_callback() {
    let Some((uri, idp)) = fixture() else { return };
    let http = idp_client(idp);
    let (session, phases) = test_session();
    let (opener, opened) = simulating_opener_with(http.clone());

    let mut options = ClientOptions::parse(&uri).await.expect("parse MQLENS_TEST_OIDC_URI");
    options.server_selection_timeout = Some(std::time::Duration::from_secs(15));
    attach_human_callback(&mut options, session, &[], opener, http);
    let client = mongodb::Client::with_options(options).expect("build the driver client");

    // `connectionStatus` runs without authentication, so success alone proves
    // nothing; what matters is who the server says this connection is.
    // Errors are rendered with Display, never Debug, and neither the driver
    // nor our `to_driver_error` puts a token in one.
    let status = match client
        .database("admin")
        .run_command(doc! { "connectionStatus": 1, "showPrivileges": false })
        .await
    {
        Ok(status) => status,
        Err(error) => panic!("the MONGODB-OIDC handshake failed: {error}"),
    };
    let users = status
        .get_document("authInfo")
        .and_then(|info| info.get_array("authenticatedUsers"))
        .expect("connectionStatus must report authInfo.authenticatedUsers")
        .clone();
    assert!(
        users.contains(&Bson::Document(doc! { "user": EXPECTED_USER, "db": "$external" })),
        "the server must have authenticated {EXPECTED_USER} in $external; it reports {users:?}"
    );

    assert_eq!(opened.lock().unwrap().len(), 1, "the flow opens the browser exactly once");
    assert_eq!(
        *phases.lock().unwrap(),
        vec!["WaitingForBrowser".to_string(), "Completed".to_string()],
        "the session saw one interactive login, start to finish"
    );
    let exchange = idp.last_token_request().expect("our flow must have called /token");
    assert_eq!(exchange.grant_type, "authorization_code");
}

// ---- the app's own connect and test paths (#430 Task 12) -------------------
//
// The tests above prove the callback works when attached by hand. These prove
// the app's two client-construction sites attach it — and that the UI's view
// of a login (the Authenticate row, cancel by login id, the registry) matches
// what really happened against a real server.

use super::tests::recording_opener;
use crate::connections::{run_connection_test_with_oidc, PhaseUpdate, TestPhase};
use crate::oidc_login::HumanLogin;
use crate::state::AppState;

type PhaseLog = Arc<std::sync::Mutex<Vec<(TestPhase, String)>>>;

fn phase_recorder() -> (PhaseLog, impl Fn(PhaseUpdate) + Send + Sync) {
    let log: PhaseLog = Default::default();
    let recorder = log.clone();
    (log, move |u: PhaseUpdate| recorder.lock().unwrap().push((u.phase, u.status)))
}

fn row(phase: TestPhase, status: &str) -> (TestPhase, String) {
    (phase, status.to_string())
}

/// Wait until `opened` has a URL — the flow has reached the browser step —
/// then cancel the login by the id the UI would hold.
async fn cancel_once_the_browser_opens(state: &AppState, opened: &std::sync::Mutex<Vec<String>>, login_id: &str) {
    for _ in 0..600 {
        if !opened.lock().unwrap().is_empty() {
            crate::oidc_login::cancel_oidc_login_impl(state, login_id).unwrap();
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the flow never reached the browser step");
}

/// Spec's observed sequence for an OIDC test: Connect ok -> Ping start ->
/// Authenticate start -> Authenticate ok -> Ping ok.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_test_reports_the_real_login_as_its_authenticate_row() {
    let Some((uri, idp)) = fixture() else { return };
    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-ok".into()), open: opener, http };

    let result = run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit).await;

    assert_eq!(result, Ok(()));
    assert_eq!(
        *log.lock().unwrap(),
        vec![
            row(TestPhase::Parse, "start"),
            row(TestPhase::Parse, "ok"),
            row(TestPhase::Resolve, "start"),
            row(TestPhase::Resolve, "ok"),
            row(TestPhase::Connect, "start"),
            row(TestPhase::Connect, "ok"),
            row(TestPhase::Ping, "start"),
            row(TestPhase::Authenticate, "start"),
            row(TestPhase::Authenticate, "ok"),
            row(TestPhase::Ping, "ok"),
        ]
    );
    assert_eq!(opened.lock().unwrap().len(), 1, "one browser login, start to finish");
    assert!(state.oidc_sessions.lock().unwrap().is_empty(), "a finished test leaves no login behind");
}

/// Cancel by login id reaches a real pending login, and the test reports
/// the cancelled login — not the ping error it caused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_connection_test_reports_the_cancelled_login_not_a_ping_error() {
    let Some((uri, idp)) = fixture() else { return };
    let http = idp_client(idp);
    let (opener, opened) = recording_opener();
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-cancel".into()), open: opener, http };

    let (result, ()) = tokio::join!(
        run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit),
        cancel_once_the_browser_opens(&state, &opened, "test-cancel"),
    );

    assert_eq!(result, Err(OidcError::Cancelled.locale_key().to_string()));
    let log = log.lock().unwrap().clone();
    assert!(log.contains(&row(TestPhase::Authenticate, "fail")), "{log:?}");
    assert!(!log.contains(&row(TestPhase::Ping, "fail")), "the failure belongs to Authenticate: {log:?}");
    assert!(state.oidc_sessions.lock().unwrap().is_empty(), "a cancelled test leaves no login behind");
}

/// `connect_db`'s path attaches the callback and keeps the authenticated
/// client, and the login's entry is gone once connect returns.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connecting_runs_the_login_and_keeps_the_authenticated_client() {
    let Some((uri, idp)) = fixture() else { return };
    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let login = HumanLogin { config: None, login_id: Some("connect-ok".into()), open: opener, http };

    let id = crate::connect_db_with_login(&state, &uri, None, login)
        .await
        .unwrap_or_else(|e| panic!("connect must succeed through the browser login: {e}"));

    assert_eq!(opened.lock().unwrap().len(), 1);
    assert!(state.oidc_sessions.lock().unwrap().is_empty(), "a finished connect leaves no login behind");
    let client = state.connections.lock().unwrap().get(&id).cloned().expect("the client is kept");
    let status = client
        .database("admin")
        .run_command(doc! { "connectionStatus": 1 })
        .await
        .unwrap_or_else(|e| panic!("the kept client must stay authenticated: {e}"));
    let users = status.get_document("authInfo").unwrap().get_array("authenticatedUsers").unwrap().clone();
    assert!(users.contains(&Bson::Document(doc! { "user": EXPECTED_USER, "db": "$external" })), "{users:?}");
}

/// Ruling 1's whole point: Connect has no channel, yet its login can be
/// cancelled by the id the UI minted before invoking.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connect_can_be_cancelled_by_its_login_id() {
    let Some((uri, idp)) = fixture() else { return };
    let http = idp_client(idp);
    let (opener, opened) = recording_opener();
    let state = AppState::new();
    let login = HumanLogin { config: None, login_id: Some("connect-cancel".into()), open: opener, http };

    let (result, ()) = tokio::join!(
        crate::connect_db_with_login(&state, &uri, None, login),
        cancel_once_the_browser_opens(&state, &opened, "connect-cancel"),
    );

    assert!(result.is_err(), "a cancelled login must not connect");
    assert!(state.connections.lock().unwrap().is_empty());
    assert!(state.oidc_sessions.lock().unwrap().is_empty(), "a cancelled connect leaves no login behind");
}

// ---- a human who takes their time ------------------------------------------
//
// Every test above completes the IdP redirect the instant the browser
// "opens". A real person takes 30-60 s. The connection test sets 5 s connect
// and server-selection timeouts, and connect sets 10 s (`apply_main_timeouts`),
// so these prove a login slower than both still succeeds.

/// Longer than every timeout either path sets.
const SLOW_HUMAN: std::time::Duration = std::time::Duration::from_secs(12);

/// Like `simulating_opener_with`, but the "human" finishes the IdP redirect
/// only after `SLOW_HUMAN`.
fn slow_opener(http: reqwest::Client) -> BrowserOpener {
    Arc::new(move |url: &str| {
        let url = url.to_string();
        let http = http.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SLOW_HUMAN).await;
            let _ = http.get(&url).send().await;
        });
        Ok(())
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_browser_login_outlasts_the_connection_tests_timeouts() {
    let Some((uri, idp)) = fixture() else { return };
    let http = idp_client(idp);
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-slow".into()), open: slow_opener(http.clone()), http };

    let started = std::time::Instant::now();
    let result = run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit).await;
    let took = started.elapsed();

    assert_eq!(result, Ok(()), "a slow login must still pass the test (took {took:?}): {:?}", log.lock().unwrap());
    assert!(took >= SLOW_HUMAN, "the login must really have been slow, took {took:?}");
    let log = log.lock().unwrap().clone();
    assert!(log.contains(&row(TestPhase::Authenticate, "ok")), "{log:?}");
    assert_eq!(log.last(), Some(&row(TestPhase::Ping, "ok")), "{log:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_browser_login_outlasts_the_connect_timeouts() {
    let Some((uri, idp)) = fixture() else { return };
    let http = idp_client(idp);
    let state = AppState::new();
    let login = HumanLogin { config: None, login_id: Some("connect-slow".into()), open: slow_opener(http.clone()), http };

    let started = std::time::Instant::now();
    let result = crate::connect_db_with_login(&state, &uri, None, login).await;
    let took = started.elapsed();

    let id = result.unwrap_or_else(|e| panic!("a slow login must still connect (took {took:?}): {e}"));
    assert!(took >= SLOW_HUMAN, "the login must really have been slow, took {took:?}");
    assert!(state.connections.lock().unwrap().contains_key(&id));
}
