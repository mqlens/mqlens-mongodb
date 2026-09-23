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

/// A test that arms a failpoint on one of our app names holds this
/// exclusively. Every other test holds it shared, so an armed failpoint can
/// only ever hit the test that armed it.
static FAILPOINT_LOCK: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

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
    let _shared = FAILPOINT_LOCK.read().await;
    let http = idp_client(idp);
    let (session, phases) = test_session();
    let (opener, opened) = simulating_opener_with(http.clone());

    let mut options = ClientOptions::parse(&uri).await.expect("parse MQLENS_TEST_OIDC_URI");
    options.server_selection_timeout = Some(std::time::Duration::from_secs(15));
    attach_human_callback(&mut options, session, &crate::connections::OidcProfileConfig::default(), opener, http);
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
        vec!["WaitingForBrowser".to_string(), "Completed(AccessToken)".to_string()],
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
    let _shared = FAILPOINT_LOCK.read().await;
    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-ok".into()), open: opener, http: Some(http) };

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
    let _shared = FAILPOINT_LOCK.read().await;
    let http = idp_client(idp);
    let (opener, opened) = recording_opener();
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-cancel".into()), open: opener, http: Some(http) };

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
    let _shared = FAILPOINT_LOCK.read().await;
    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let login = HumanLogin { config: None, login_id: Some("connect-ok".into()), open: opener, http: Some(http) };

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
    assert!(
        !state.conn_oidc_id_token.lock().unwrap().contains(&id),
        "a login that sends the access token must not start mongosh with the ID-token flag"
    );
}

/// Ruling 1's whole point: Connect has no channel, yet its login can be
/// cancelled by the id the UI minted before invoking.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connect_can_be_cancelled_by_its_login_id() {
    let Some((uri, idp)) = fixture() else { return };
    let _shared = FAILPOINT_LOCK.read().await;
    let http = idp_client(idp);
    let (opener, opened) = recording_opener();
    let state = AppState::new();
    let login = HumanLogin { config: None, login_id: Some("connect-cancel".into()), open: opener, http: Some(http) };

    let (result, ()) = tokio::join!(
        crate::connect_db_with_login(&state, &uri, None, login),
        cancel_once_the_browser_opens(&state, &opened, "connect-cancel"),
    );

    // A locale key, never the driver's English, so the UI can tell a
    // cancelled login from a real failure.
    assert_eq!(result, Err(OidcError::Cancelled.locale_key().to_string()), "a cancelled login must not connect");
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
    let _shared = FAILPOINT_LOCK.read().await;
    let http = idp_client(idp);
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-slow".into()), open: slow_opener(http.clone()), http: Some(http) };

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
    let _shared = FAILPOINT_LOCK.read().await;
    let http = idp_client(idp);
    let state = AppState::new();
    let login = HumanLogin { config: None, login_id: Some("connect-slow".into()), open: slow_opener(http.clone()), http: Some(http) };

    let started = std::time::Instant::now();
    let result = crate::connect_db_with_login(&state, &uri, None, login).await;
    let took = started.elapsed();

    let id = result.unwrap_or_else(|e| panic!("a slow login must still connect (took {took:?}): {e}"));
    assert!(took >= SLOW_HUMAN, "the login must really have been slow, took {took:?}");
    assert!(state.connections.lock().unwrap().contains_key(&id));
}

// ---- the login succeeded, the ping did not -------------------------------

/// Arm mongod's `failCommand` so the next `ping` from `app_name` fails. A
/// ping is only sent once the connection's handshake, OIDC login included,
/// has finished, so this fails the ping *after* a successful login. Needs the
/// fixture's `enableTestCommands`. Returns the admin client, to disarm with.
async fn fail_next_ping_from(uri: &str, app_name: &str) -> mongodb::Client {
    let base = uri.split('?').next().expect("the fixture URI has a host part");
    let admin = mongodb::Client::with_uri_str(format!("{base}?directConnection=true"))
        .await
        .expect("an admin client for the fixture");
    admin
        .database("admin")
        .run_command(doc! {
            "configureFailPoint": "failCommand",
            "mode": { "times": 1 },
            "data": { "failCommands": ["ping"], "errorCode": 2, "appName": app_name },
        })
        .await
        .unwrap_or_else(|e| panic!("arm failCommand (does the fixture set enableTestCommands?): {e}"));
    admin
}

async fn disarm(admin: &mongodb::Client) {
    let _ = admin
        .database("admin")
        .run_command(doc! { "configureFailPoint": "failCommand", "mode": "off" })
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_test_whose_ping_fails_after_the_login_reports_login_ok_ping_failed() {
    let Some((uri, idp)) = fixture() else { return };
    let _exclusive = FAILPOINT_LOCK.write().await;
    let admin = fail_next_ping_from(&uri, "MQLens-Ping").await;
    let http = idp_client(idp);
    let (opener, _opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-ping-fails".into()), open: opener, http: Some(http) };

    let result = run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit).await;
    disarm(&admin).await;

    let key = OidcError::LoginOkPingFailed.locale_key().to_string();
    assert_eq!(result, Err(key.clone()));
    let log = log.lock().unwrap().clone();
    assert!(log.contains(&row(TestPhase::Authenticate, "ok")), "the login itself succeeded: {log:?}");
    assert_eq!(log.last(), Some(&row(TestPhase::Ping, "fail")), "the failure is Ping's: {log:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connect_whose_ping_fails_after_the_login_reports_login_ok_ping_failed() {
    let Some((uri, idp)) = fixture() else { return };
    let _exclusive = FAILPOINT_LOCK.write().await;
    let admin = fail_next_ping_from(&uri, "MQLens-Engine").await;
    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let login = HumanLogin { config: None, login_id: Some("connect-ping-fails".into()), open: opener, http: Some(http) };

    let result = crate::connect_db_with_login(&state, &uri, None, login).await;
    disarm(&admin).await;

    assert_eq!(opened.lock().unwrap().len(), 1, "the login ran");
    assert_eq!(result, Err(OidcError::LoginOkPingFailed.locale_key().to_string()));
    assert!(state.connections.lock().unwrap().is_empty());
}

// ---- authentication refused outside the flow -------------------------------
//
// Two refusals the flow itself never sees: the driver checking allowed hosts
// before it calls back at all, and MongoDB rejecting the token a completed
// login produced. Both are Authenticate's failure, with their own key.

/// The driver refuses a host outside `ALLOWED_HOSTS` before our callback
/// runs, so no login reports anything. Both paths must still name the cause
/// as a locale key rather than echo the driver's English, and the test must
/// fail its Authenticate row — not Ping.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_outside_the_allowed_hosts_is_reported_as_host_not_allowed() {
    let Some((uri, idp)) = fixture() else { return };
    let _shared = FAILPOINT_LOCK.read().await;
    let config = crate::connections::OidcProfileConfig { allowed_hosts: vec!["nothing.example".into()], ..Default::default() };
    let key = OidcError::HostNotAllowed.locale_key().to_string();

    let http = idp_client(idp);
    let (opener, opened) = recording_opener();
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: Some(&config), login_id: Some("test-host".into()), open: opener, http: Some(http) };
    let result = run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit).await;

    assert_eq!(result, Err(key.clone()));
    let log = log.lock().unwrap().clone();
    assert!(log.contains(&row(TestPhase::Authenticate, "fail")), "{log:?}");
    assert!(!log.contains(&row(TestPhase::Ping, "fail")), "the refusal belongs to Authenticate: {log:?}");
    assert!(opened.lock().unwrap().is_empty(), "the driver refuses before any browser login");

    let http = idp_client(idp);
    let (opener, opened) = recording_opener();
    let login = HumanLogin { config: Some(&config), login_id: Some("connect-host".into()), open: opener, http: Some(http) };
    let result = crate::connect_db_with_login(&state, &uri, None, login).await;

    assert_eq!(result, Err(key));
    assert!(opened.lock().unwrap().is_empty());
    assert!(state.connections.lock().unwrap().is_empty());
}

/// Switches the shared IdP to wrong-audience tokens, and back when dropped —
/// on a panic too, so no later test inherits it.
struct WrongAudience<'a>(&'a MockIdp);

impl<'a> WrongAudience<'a> {
    fn on(idp: &'a MockIdp) -> Self {
        idp.mint_wrong_audience(true);
        Self(idp)
    }
}

impl Drop for WrongAudience<'_> {
    fn drop(&mut self) {
        self.0.mint_wrong_audience(false);
    }
}

/// The browser login completes and the flow reports it — before MongoDB has
/// seen the token. MongoDB then rejects it (wrong `aud`). That is
/// `tokenRejected` on both paths, and the test's Authenticate row, already
/// painted ok, must turn red rather than leave a green row and blame Ping.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_token_mongodb_rejects_is_reported_as_token_rejected() {
    let Some((uri, idp)) = fixture() else { return };
    // Exclusive: every other test shares this IdP and needs good tokens.
    let _exclusive = FAILPOINT_LOCK.write().await;
    let _wrong = WrongAudience::on(idp);
    let key = OidcError::TokenRejected.locale_key().to_string();

    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-rejected".into()), open: opener, http: Some(http) };
    let result = run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit).await;

    assert_eq!(result, Err(key.clone()), "{:?}", log.lock().unwrap());
    assert_eq!(opened.lock().unwrap().len(), 1, "the browser login ran");
    let log = log.lock().unwrap().clone();
    let authenticate: Vec<&str> =
        log.iter().filter(|(phase, _)| *phase == TestPhase::Authenticate).map(|(_, status)| status.as_str()).collect();
    assert_eq!(authenticate.last(), Some(&"fail"), "the Authenticate row must end red: {log:?}");
    assert!(!log.contains(&row(TestPhase::Ping, "fail")), "the rejection belongs to Authenticate: {log:?}");

    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let login = HumanLogin { config: None, login_id: Some("connect-rejected".into()), open: opener, http: Some(http) };
    let result = crate::connect_db_with_login(&state, &uri, None, login).await;

    assert_eq!(result, Err(key));
    assert_eq!(opened.lock().unwrap().len(), 1, "the browser login ran");
    assert!(state.connections.lock().unwrap().is_empty());
}

// ---- "Use ID token instead of access token" (T21) ---------------------------
//
// cidaas mints access tokens with the RFC 9068 header `typ: "at+jwt"`, and
// MongoDB's JWT parser refuses every `typ` but an absent one or `"JWT"`. Its
// ID tokens are plain `"JWT"`, so the escape hatch (mongosh's
// `--oidcIdTokenAsAccessToken`) is to send the ID token instead. An ID
// token's `aud` is the client id, so those tests use the fixture's second
// server, whose `audience` is the client id (`MQLENS_TEST_OIDC_ID_TOKEN_URI`).
//
// Every test here switches the shared IdP, so each holds the lock exclusively.

/// The ID-token server's URI and the shared IdP, or `None` (skip).
fn id_token_fixture() -> Option<(String, &'static MockIdp)> {
    let (_, idp) = fixture()?;
    let Ok(uri) = std::env::var("MQLENS_TEST_OIDC_ID_TOKEN_URI") else {
        eprintln!("skipping: MQLENS_TEST_OIDC_ID_TOKEN_URI is not set");
        return None;
    };
    Some((uri, idp))
}

/// Turns one of the shared IdP's switches on, and off again when dropped —
/// on a panic too, so no later test inherits it.
struct Switch<'a> {
    idp: &'a MockIdp,
    set: fn(&MockIdp, bool),
}

impl<'a> Switch<'a> {
    fn on(idp: &'a MockIdp, set: fn(&MockIdp, bool)) -> Self {
        set(idp, true);
        Self { idp, set }
    }
}

impl Drop for Switch<'_> {
    fn drop(&mut self) {
        (self.set)(self.idp, false);
    }
}

fn id_token_config() -> crate::connections::OidcProfileConfig {
    crate::connections::OidcProfileConfig { use_id_token: true, ..Default::default() }
}

/// How many MONGODB-OIDC authentications the server behind `uri` has let
/// through, from its own `serverStatus` — so a test can show a login never
/// authenticated, not merely that our call returned an error.
async fn successful_oidc_authentications(uri: &str) -> i64 {
    let base = uri.split('?').next().expect("the fixture URI has a host part");
    let admin = mongodb::Client::with_uri_str(format!("{base}?directConnection=true"))
        .await
        .expect("an admin client for the fixture");
    let status = admin
        .database("admin")
        .run_command(doc! { "serverStatus": 1 })
        .await
        .unwrap_or_else(|e| panic!("serverStatus: {e}"));
    let counter = status
        .get_document("security")
        .and_then(|s| s.get_document("authentication"))
        .and_then(|a| a.get_document("mechanisms"))
        .and_then(|m| m.get_document("MONGODB-OIDC"))
        .and_then(|o| o.get_document("authenticate"))
        .map(|a| a.get("successful").cloned())
        .unwrap_or_else(|e| panic!("serverStatus has no MONGODB-OIDC counters: {e}"));
    match counter {
        Some(Bson::Int64(n)) => n,
        Some(Bson::Int32(n)) => n.into(),
        other => panic!("unexpected successful-authentications counter: {other:?}"),
    }
}

/// (a) The access token's type is one MongoDB refuses and the option is off:
/// both paths name the fix, as a locale key, on the Authenticate row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_at_jwt_access_token_mongodb_refuses_is_reported_with_the_id_token_hint() {
    let Some((uri, idp)) = fixture() else { return };
    let _exclusive = FAILPOINT_LOCK.write().await;
    let _at_jwt = Switch::on(idp, MockIdp::mint_at_jwt_access_tokens);
    let key = OidcError::AccessTokenTypeRejected.locale_key().to_string();

    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: None, login_id: Some("test-at-jwt".into()), open: opener, http: Some(http) };
    let result = run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit).await;

    assert_eq!(result, Err(key.clone()), "{:?}", log.lock().unwrap());
    assert_eq!(opened.lock().unwrap().len(), 1, "the browser login ran");
    let log = log.lock().unwrap().clone();
    let authenticate: Vec<&str> =
        log.iter().filter(|(phase, _)| *phase == TestPhase::Authenticate).map(|(_, status)| status.as_str()).collect();
    assert_eq!(authenticate.last(), Some(&"fail"), "the Authenticate row must end red: {log:?}");
    assert!(!log.contains(&row(TestPhase::Ping, "fail")), "the rejection belongs to Authenticate: {log:?}");

    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let login = HumanLogin { config: None, login_id: Some("connect-at-jwt".into()), open: opener, http: Some(http) };
    let result = crate::connect_db_with_login(&state, &uri, None, login).await;

    assert_eq!(result, Err(key));
    assert_eq!(opened.lock().unwrap().len(), 1, "the browser login ran");
    assert!(state.connections.lock().unwrap().is_empty());
}

/// (b) The same IdP, with the option on: the ID token authenticates, on
/// both paths, as the expected principal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_the_id_token_option_an_idp_whose_access_tokens_mongodb_refuses_still_logs_in() {
    let Some((uri, idp)) = id_token_fixture() else { return };
    let _exclusive = FAILPOINT_LOCK.write().await;
    let _at_jwt = Switch::on(idp, MockIdp::mint_at_jwt_access_tokens);
    let config = id_token_config();

    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: Some(&config), login_id: Some("test-id-token".into()), open: opener, http: Some(http) };
    let result = run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit).await;

    assert_eq!(result, Ok(()), "{:?}", log.lock().unwrap());
    assert_eq!(opened.lock().unwrap().len(), 1, "one browser login");
    assert_eq!(log.lock().unwrap().last(), Some(&row(TestPhase::Ping, "ok")));

    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let login = HumanLogin { config: Some(&config), login_id: Some("connect-id-token".into()), open: opener, http: Some(http) };
    let id = crate::connect_db_with_login(&state, &uri, None, login)
        .await
        .unwrap_or_else(|e| panic!("connect must succeed with the ID token: {e}"));

    assert_eq!(opened.lock().unwrap().len(), 1);
    let client = state.connections.lock().unwrap().get(&id).cloned().expect("the client is kept");
    let status = client
        .database("admin")
        .run_command(doc! { "connectionStatus": 1 })
        .await
        .unwrap_or_else(|e| panic!("the kept client must stay authenticated: {e}"));
    let users = status.get_document("authInfo").unwrap().get_array("authenticatedUsers").unwrap().clone();
    assert!(users.contains(&Bson::Document(doc! { "user": EXPECTED_USER, "db": "$external" })), "{users:?}");
    assert!(
        state.conn_oidc_id_token.lock().unwrap().contains(&id),
        "the embedded shell on this connection must be told to send the ID token too"
    );
}

/// (c) An ID token minted for another login (wrong nonce) is refused before
/// it reaches the driver — on both paths — and the server authenticates
/// nobody, although the token is otherwise one it would accept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_id_token_with_another_nonce_is_refused_and_never_authenticates() {
    let Some((uri, idp)) = id_token_fixture() else { return };
    let _exclusive = FAILPOINT_LOCK.write().await;
    let _wrong_nonce = Switch::on(idp, MockIdp::mint_wrong_nonce);
    let config = id_token_config();
    let key = OidcError::StateMismatch.locale_key().to_string();
    let before = successful_oidc_authentications(&uri).await;

    let http = idp_client(idp);
    let (opener, opened) = simulating_opener_with(http.clone());
    let state = AppState::new();
    let (log, emit) = phase_recorder();
    let login = HumanLogin { config: Some(&config), login_id: Some("test-nonce".into()), open: opener, http: Some(http) };
    let result = run_connection_test_with_oidc(&state.oidc_sessions, &uri, None, login, &emit).await;

    assert_eq!(result, Err(key.clone()), "{:?}", log.lock().unwrap());
    assert_eq!(opened.lock().unwrap().len(), 1, "the browser login ran");
    assert!(log.lock().unwrap().contains(&row(TestPhase::Authenticate, "fail")), "{:?}", log.lock().unwrap());

    let http = idp_client(idp);
    let (opener, _) = simulating_opener_with(http.clone());
    let login = HumanLogin { config: Some(&config), login_id: Some("connect-nonce".into()), open: opener, http: Some(http) };
    let result = crate::connect_db_with_login(&state, &uri, None, login).await;

    assert_eq!(result, Err(key));
    assert!(state.connections.lock().unwrap().is_empty());
    assert_eq!(successful_oidc_authentications(&uri).await, before, "the server must have authenticated nobody");
}
