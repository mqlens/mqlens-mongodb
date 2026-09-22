//! The one test that proves the MongoDB driver really completes
//! MONGODB-OIDC through the callback `attach_human_callback` installs (#430).
//! Every other OIDC test mocks the driver away; this one does not, and it is
//! the only proof that the attachment is real — driver 3.9.0 keeps
//! `Callback`'s internals `pub(crate)`, so nothing else can observe it.
//!
//! Skipped unless `MQLENS_TEST_OIDC_URI` is set, because it needs a Percona
//! Server for MongoDB configured to trust our mock IdP. Start one with
//! `scripts/oidc-percona-fixture.sh start`, which prints the two variables
//! this test reads; CI does the same.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_driver_authenticates_a_real_server_through_our_oidc_callback() {
    let Ok(uri) = std::env::var("MQLENS_TEST_OIDC_URI") else {
        eprintln!("skipping: MQLENS_TEST_OIDC_URI is not set");
        return;
    };
    let port: u16 = std::env::var("MQLENS_TEST_OIDC_IDP_PORT")
        .expect("MQLENS_TEST_OIDC_IDP_PORT must accompany MQLENS_TEST_OIDC_URI")
        .parse()
        .expect("MQLENS_TEST_OIDC_IDP_PORT must be a port number");

    let idp = MockIdp::start_tls(ISSUER_HOST, port);
    let http = idp_client(&idp);
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
