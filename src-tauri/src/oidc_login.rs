//! The app side of human MONGODB-OIDC login (#430): which logins are in
//! flight, so the UI can cancel one or send the browser back to it, and the
//! browser openers the connect and test paths hand the flow.

use crate::connections::OidcProfileConfig;
use crate::oidc::{attach_human_callback, BrowserOpener, OidcError, OidcSession, Presented};
use mongodb::options::{AuthMechanism, ClientOptions};
use crate::state::{AppState, LockExt};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Logins whose connect or test call is still in flight, by login id.
pub type OidcSessions = Mutex<HashMap<String, Arc<OidcSession>>>;

/// One login's entry in `OidcSessions`, removed when this is dropped.
///
/// The connect and test paths hold one for exactly the length of their call,
/// so the entry goes on every exit — success, failure, cancel, or an early
/// `?` return — without each path having to remember to clean up.
///
/// The driver's callback closure keeps its own `Arc<OidcSession>`, so
/// dropping the entry does not end the session: the client can still
/// reauthenticate for as long as it lives, and dropping the client releases
/// it. The consequence, accepted for phase 1: an interactive re-login in the
/// middle of a session (reached only when the IdP rejects the refresh token)
/// has no entry here and so cannot be cancelled from the UI. The driver's
/// five-minute callback deadline still bounds it.
///
/// Dropping it also clears the session's cancel flag. A cancel that lands
/// after the login completed but before the call returned would otherwise
/// stay set on the session the kept client's callback reuses, failing every
/// later re-login instantly; once the entry is gone nothing can deliver a
/// cancel, so there is nothing left for the flag to mean.
pub struct LoginRegistration<'a> {
    sessions: &'a OidcSessions,
    login_id: String,
}

impl Drop for LoginRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock_safe() {
            if let Some(session) = sessions.remove(&self.login_id) {
                session.clear_cancel();
            }
        }
    }
}

/// Register `session` under the caller's `login_id` — the id the frontend
/// minted before invoking, so it can name this login to cancel it while the
/// call is still in flight. Without one, a fresh id is used: the login is
/// still tracked and cleaned up, but no UI can cancel it.
///
/// An id that is already in flight is refused, because the first call's
/// cleanup would otherwise remove the second login's entry.
pub fn register_login(
    sessions: &OidcSessions,
    login_id: Option<String>,
    session: Arc<OidcSession>,
) -> Result<LoginRegistration<'_>, String> {
    let login_id = login_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut live = sessions.lock_safe()?;
    if live.contains_key(&login_id) {
        return Err("an OIDC login with this id is already in progress".to_string());
    }
    live.insert(login_id.clone(), session);
    Ok(LoginRegistration { sessions, login_id })
}

fn live_session(state: &AppState, login_id: &str) -> Result<Option<Arc<OidcSession>>, String> {
    Ok(state.oidc_sessions.lock_safe()?.get(login_id).cloned())
}

/// Cancel a login in flight. An unknown id is not an error: the dialog can
/// close after the flow already finished and its entry is gone.
///
/// The flag is set with the registry lock held. `LoginRegistration`'s drop
/// removes the entry and clears the flag under that lock, so a cancel lands
/// either before it (and is cleared) or after it (and finds no entry). Set
/// after releasing the lock, it could land after the drop and stay set,
/// failing every later re-login of the kept client as `Cancelled`.
pub fn cancel_oidc_login_impl(state: &AppState, login_id: &str) -> Result<(), String> {
    let sessions = state.oidc_sessions.lock_safe()?;
    if let Some(session) = sessions.get(login_id) {
        session.cancel();
    }
    Ok(())
}

/// Send the browser back to a login in flight ("Open browser again").
///
/// Reuses the URL the flow already sent the browser to. Rebuilding the
/// authorization request would rotate `state` and the PKCE challenge, and the
/// loopback listener would then reject the login the user completes.
///
/// An unknown id, and a login that has no URL yet, are both `Ok(())` with
/// nothing opened. Both are benign races with one right outcome: the login
/// finished between the button painting and the click, or discovery is still
/// running and the flow is about to open the browser itself. An error there
/// would only put a misleading toast over a login that is fine. A browser
/// that fails to open is an error, reported as its locale key.
pub fn reopen_oidc_login_impl(
    state: &AppState,
    login_id: &str,
    open: &BrowserOpener,
) -> Result<(), String> {
    let Some(url) = live_session(state, login_id)?.and_then(|session| session.authorization_url()) else {
        return Ok(());
    };
    open(&url).map_err(|error| error.locale_key().to_string())
}

/// How a connect or test call runs a human OIDC login, should its connection
/// string ask for one. Grouped because every such call needs all four.
pub struct HumanLogin<'a> {
    /// The profile's OIDC settings; `None` leaves the driver's defaults.
    pub config: Option<&'a OidcProfileConfig>,
    /// The id the UI minted to cancel or reopen this login, if any.
    pub login_id: Option<String>,
    pub open: BrowserOpener,
    /// For the IdP. `None` — production — builds `oidc::idp_http_client`
    /// (normal TLS trust, no redirects, bounded requests), and only once
    /// `prepare_human_login` knows the connection is OIDC. Only tests
    /// substitute one that also trusts a TEST-ONLY CA.
    pub http: Option<reqwest::Client>,
}

impl<'a> HumanLogin<'a> {
    /// A login the user started and is watching: the system browser opens.
    pub fn interactive(config: Option<&'a OidcProfileConfig>, login_id: Option<String>, open: BrowserOpener) -> Self {
        Self { config, login_id, open, http: None }
    }

    /// For callers no human is watching: no browser ever opens.
    pub fn unattended() -> Self {
        Self::interactive(None, None, no_browser_opener())
    }
}

/// What a login has reported during one connect or test call, kept so that a
/// ping that then fails is explained by the login, as a locale key, rather
/// than by the driver's English (the Rust side never formats user-facing
/// text).
#[derive(Default, Debug)]
pub struct LoginReport {
    failure: Option<OidcError>,
    /// What the login handed the driver, once it completed.
    completed: Option<Presented>,
}

impl LoginReport {
    pub fn record(&mut self, phase: &crate::oidc::OidcPhase) {
        match phase {
            crate::oidc::OidcPhase::WaitingForBrowser => {}
            crate::oidc::OidcPhase::Completed(presented) => self.completed = Some(*presented),
            crate::oidc::OidcPhase::Failed(error) => self.failure = Some(error.clone()),
        }
    }

    /// How a failed ping is explained by the login, given the driver's error,
    /// or `None` when no login accounts for it (every other mechanism, or an
    /// OIDC failure before anything to do with the login).
    pub fn ping_failure(&self, error: &mongodb::error::Error) -> Option<PingFailure> {
        self.explain(DriverFailure::of(error))
    }

    /// `ping_failure`'s locale key, for the connect path, which has no rows.
    pub fn ping_failure_key(&self, error: &mongodb::error::Error) -> Option<&'static str> {
        self.ping_failure(error).map(PingFailure::key)
    }

    fn explain(&self, driver: DriverFailure) -> Option<PingFailure> {
        // Checked by the driver before it calls back, so whether or not a
        // login ran says nothing about it.
        if driver == DriverFailure::HostNotAllowed {
            return Some(PingFailure::AuthenticateFailed(OidcError::HostNotAllowed.locale_key()));
        }
        match (&self.failure, self.completed) {
            (Some(error), _) => Some(PingFailure::LoginFailed(error.locale_key())),
            // The flow reports `Completed` as soon as the IdP hands over a
            // token, before MongoDB has seen it; an authentication failure
            // after that is MongoDB rejecting the token.
            //
            // MongoDB tells the client only "Authentication failed." — why
            // ("Unknown type of token") stays in its log. So when the login
            // handed over an access token whose `typ` MongoDB's parser
            // refuses, that is the explanation, with its fix: the profile's
            // "Use ID token" option. Only with the option off: with it on,
            // an ID token was sent and the rejection is the plain one.
            (None, Some(Presented::AccessTokenOfRefusedType)) if driver == DriverFailure::AuthenticationFailed => {
                Some(PingFailure::AuthenticateFailed(OidcError::AccessTokenTypeRejected.locale_key()))
            }
            (None, Some(_)) if driver == DriverFailure::AuthenticationFailed => {
                Some(PingFailure::AuthenticateFailed(OidcError::TokenRejected.locale_key()))
            }
            (None, Some(_)) => Some(PingFailure::PingFailed(OidcError::LoginOkPingFailed.locale_key())),
            (None, None) => None,
        }
    }
}

/// A failed ping, as the login explains it — and so which row of the
/// connection test it belongs to. Each carries its locale key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PingFailure {
    /// The login itself failed, and has already said so (the test's
    /// Authenticate row is already red).
    LoginFailed(&'static str),
    /// Authentication failed outside the flow: the driver refused the host
    /// before calling back, or MongoDB rejected the token the login
    /// produced. Authenticate's failure, not yet reported — and on the test
    /// path, possibly over a row the login already marked ok.
    AuthenticateFailed(&'static str),
    /// The login succeeded and the ping failed for another reason.
    PingFailed(&'static str),
}

impl PingFailure {
    pub fn key(self) -> &'static str {
        match self {
            Self::LoginFailed(key) | Self::AuthenticateFailed(key) | Self::PingFailed(key) => key,
        }
    }
}

/// What a driver error says about authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DriverFailure {
    /// The driver's own allowed-hosts check refused the server.
    HostNotAllowed,
    /// Authentication failed: the driver's authentication error, or the
    /// server's `AuthenticationFailed` (code 18).
    AuthenticationFailed,
    Other,
}

impl DriverFailure {
    /// Reads the error and every driver error it wraps. Our own callback's
    /// failures reach the driver as `Error::custom`, never as an
    /// authentication error, so a login failure is not mistaken for one.
    pub(crate) fn of(error: &mongodb::error::Error) -> Self {
        use mongodb::error::ErrorKind;
        let chain = std::iter::successors(Some(error), |e| {
            std::error::Error::source(*e).and_then(|s| s.downcast_ref::<mongodb::error::Error>())
        });
        let mut found = Self::Other;
        for error in chain {
            match error.kind.as_ref() {
                // Driver 3.9.0's wording (`client/auth/oidc.rs`,
                // `validate_address_with_allowed_hosts`), pinned by the
                // real-server test that provokes it.
                ErrorKind::Authentication { message, .. } if message.contains("allowed list of hosts") => {
                    return Self::HostNotAllowed;
                }
                ErrorKind::Authentication { .. } => found = Self::AuthenticationFailed,
                ErrorKind::Command(command) if command.code == AUTHENTICATION_FAILED => {
                    found = Self::AuthenticationFailed;
                }
                _ => {}
            }
        }
        found
    }
}

/// MongoDB's `AuthenticationFailed` server error code.
const AUTHENTICATION_FAILED: i32 = 18;

/// Whether parsed options authenticate with `MONGODB-OIDC`.
pub fn uses_oidc(options: &ClientOptions) -> bool {
    options.credential.as_ref().and_then(|c| c.mechanism.as_ref()) == Some(&AuthMechanism::MongoDbOidc)
}

/// The one place a client-construction site turns a `MONGODB-OIDC`
/// connection into a human login: register `session` so the UI can reach it,
/// then attach the driver callback with the profile's allowed hosts. Every
/// other mechanism is left exactly as parsed and registers nothing.
///
/// The caller keeps the returned registration alive for the length of its
/// call; dropping it removes the entry.
pub fn prepare_human_login<'s>(
    options: &mut ClientOptions,
    sessions: &'s OidcSessions,
    login: HumanLogin<'_>,
    session: Arc<OidcSession>,
) -> Result<Option<LoginRegistration<'s>>, String> {
    if !uses_oidc(options) {
        return Ok(None);
    }
    let registration = register_login(sessions, login.login_id.clone(), session.clone())?;
    attach_human_login(options, login, session)?;
    Ok(Some(registration))
}

/// `prepare_human_login` for a caller that registered `session` itself,
/// earlier — the connect path does so before its SSH tunnel and URI parse,
/// so a cancel sent during them is not lost. Attaches the driver callback
/// only for `MONGODB-OIDC`; registers nothing.
pub fn attach_human_login(
    options: &mut ClientOptions,
    login: HumanLogin<'_>,
    session: Arc<OidcSession>,
) -> Result<(), String> {
    if !uses_oidc(options) {
        return Ok(());
    }
    let defaults = OidcProfileConfig::default();
    let config = login.config.unwrap_or(&defaults);
    let http = idp_client(login.http)?;
    attach_human_callback(options, session, config, login.open, http);
    Ok(())
}

/// For an OIDC connection through an SSH tunnel, before the tunnel opens.
///
/// The driver checks allowed hosts against the address it connects to, and
/// through a tunnel that is always `127.0.0.1`. Its defaults allow that, so
/// its check would pass every tunnelled connection, and a custom list
/// without `127.0.0.1` would refuse every one. So the real target host, the
/// one the tunnel forwards to, is checked here against the effective list:
/// the profile's custom list, or else the driver's defaults. A refusal comes
/// before any tunnel or browser opens.
///
/// On success it returns the config the login goes on with: the profile's,
/// with only its custom list cleared, so the driver keeps its defaults and
/// admits the tunnel's `127.0.0.1`. The remote host is never added to the
/// driver's list, and any other profile setting is kept.
pub fn check_real_host_before_tunnel(
    uri: &str,
    config: Option<&OidcProfileConfig>,
) -> Result<OidcProfileConfig, String> {
    let (host, _) = crate::ssh_tunnel::extract_target_host_port(uri);
    let allowed_hosts = config.map(|c| c.allowed_hosts.as_slice()).unwrap_or(&[]);
    if !crate::oidc::host_is_allowed(&host, allowed_hosts) {
        return Err(OidcError::HostNotAllowed.locale_key().to_string());
    }
    let mut tunnelled = config.cloned().unwrap_or_default();
    tunnelled.allowed_hosts.clear();
    Ok(tunnelled)
}

/// The IdP client a login uses: the one a test injected, or else
/// production's (`oidc::idp_http_client` — no redirects, bounded requests,
/// normal TLS trust).
fn idp_client(injected: Option<reqwest::Client>) -> Result<reqwest::Client, String> {
    match injected {
        Some(http) => Ok(http),
        None => crate::oidc::idp_http_client()
            .map_err(|e| format!("Failed to create the identity provider client: {e}")),
    }
}

/// The opener for user-initiated connects and tests: the system browser.
pub fn system_browser_opener() -> BrowserOpener {
    Arc::new(|url: &str| {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| OidcError::BrowserLaunchFailed)
    })
}

/// The opener for paths no human is watching (`connect_db_impl`'s callers,
/// which include the MCP connect tool): it never opens a browser, so an
/// OIDC login reached there fails with `BrowserLaunchFailed` instead of
/// putting a login page on the user's desktop. The MCP guard refuses OIDC
/// profiles before this is ever reached; this is the second line.
pub fn no_browser_opener() -> BrowserOpener {
    Arc::new(|_url: &str| Err(OidcError::BrowserLaunchFailed))
}

/// Whether a connection string asks for `MONGODB-OIDC`, decided from the
/// string alone — no `ClientOptions::parse`, which can perform SRV and TXT
/// lookups.
///
/// It reads the exact string the driver is given — the URI after
/// `normalize_mongodb_uri_options`, which turns `;` into `&` and puts any
/// `#…` back after the query — and tokenises it the way driver 3.9.0's
/// `ConnectionString::parse` does: the query starts at the first `?`, options
/// split on `&` only, with no fragment handling (so `#&authMechanism=…` is
/// still an option), keys compared lowercased, values percent-decoded. Two
/// deliberate supersets, since a guard should err towards refusing: the key
/// is trimmed, and the value is trimmed and compared case-insensitively where
/// the driver wants an exact `MONGODB-OIDC`.
///
/// The URI is the only place the mechanism can come from: an SRV TXT record
/// may carry only `authSource`, `replicaSet` and `loadBalanced`.
pub fn uri_requests_oidc(uri: &str) -> bool {
    let normalized = crate::connections::normalize_mongodb_uri_options(uri);
    let Some((_, query)) = normalized.split_once('?') else {
        return false;
    };
    query.split('&').any(|pair| {
        let Some((key, value)) = pair.split_once('=') else {
            return false;
        };
        let value = percent_encoding::percent_decode_str(value).decode_utf8_lossy();
        key.trim().to_lowercase() == "authmechanism" && value.trim().eq_ignore_ascii_case("MONGODB-OIDC")
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    /// A TCP listener that accepts and then never says a word. A connect or
    /// connection test against it gets as far as the driver trying to reach
    /// the server — where a login would be registered and authentication
    /// would happen — with no MongoDB anywhere. Returns its port.
    pub(crate) async fn silent_server() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        port
    }

    /// A loopback port nothing listens on: connecting to it is refused at
    /// once. Bound and released, so no other test holds it at that moment.
    pub(crate) fn closed_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    /// An SSH tunnel config whose server is `127.0.0.1:port`.
    pub(crate) fn ssh_to(port: u16) -> crate::ssh_tunnel::SshConfig {
        crate::ssh_tunnel::SshConfig {
            enabled: true,
            host: "127.0.0.1".into(),
            port,
            user: "u".into(),
            auth: crate::ssh_tunnel::SshAuth::Password { password: "p".into() },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn quiet_session() -> Arc<OidcSession> {
        OidcSession::new(Arc::new(|_| {}))
    }

    fn recording_opener() -> (BrowserOpener, Arc<StdMutex<Vec<String>>>) {
        let opened = Arc::new(StdMutex::new(Vec::new()));
        let recorder = opened.clone();
        let opener: BrowserOpener = Arc::new(move |url: &str| {
            recorder.lock().unwrap().push(url.to_string());
            Ok(())
        });
        (opener, opened)
    }

    fn live_ids(sessions: &OidcSessions) -> Vec<String> {
        let mut ids: Vec<String> = sessions.lock().unwrap().keys().cloned().collect();
        ids.sort();
        ids
    }

    // ---- cancel ----------------------------------------------------------

    /// The dialog can close after the flow already finished and its entry is
    /// gone; that race must not surface as an error.
    #[test]
    fn cancelling_an_unknown_login_is_not_an_error() {
        let state = AppState::new();
        assert!(cancel_oidc_login_impl(&state, "no-such-id").is_ok());
    }

    #[test]
    fn cancelling_a_live_login_cancels_that_session_and_no_other() {
        let state = AppState::new();
        let target = quiet_session();
        let bystander = quiet_session();
        let _a = register_login(&state.oidc_sessions, Some("login-a".into()), target.clone()).unwrap();
        let _b = register_login(&state.oidc_sessions, Some("login-b".into()), bystander.clone()).unwrap();

        cancel_oidc_login_impl(&state, "login-a").unwrap();

        assert!(target.is_cancelled(), "the named login must be cancelled");
        assert!(!bystander.is_cancelled(), "another login in flight must be left alone");
    }

    // ---- reopen ----------------------------------------------------------

    /// Rebuilding the request would rotate `state` and strand the login the
    /// listener is waiting for, so reopening must reuse the stored URL.
    #[test]
    fn reopening_a_login_sends_the_browser_back_to_the_url_it_already_has() {
        let state = AppState::new();
        let session = quiet_session();
        let url = "https://idp.example/authorize?client_id=mqlens&state=s1&code_challenge=c1";
        session.set_authorization_url(url.to_string());
        let _reg = register_login(&state.oidc_sessions, Some("login-1".into()), session).unwrap();
        let (opener, opened) = recording_opener();

        reopen_oidc_login_impl(&state, "login-1", &opener).unwrap();
        reopen_oidc_login_impl(&state, "login-1", &opener).unwrap();

        assert_eq!(*opened.lock().unwrap(), vec![url.to_string(), url.to_string()]);
    }

    /// Same race as cancel: the login finished between the button painting
    /// and the click. There is nothing to reopen and nothing to report.
    #[test]
    fn reopening_an_unknown_login_opens_nothing_and_is_not_an_error() {
        let state = AppState::new();
        let (opener, opened) = recording_opener();

        assert!(reopen_oidc_login_impl(&state, "no-such-id", &opener).is_ok());
        assert!(opened.lock().unwrap().is_empty());
    }

    /// Before the flow reaches the browser step (discovery still running)
    /// there is no URL yet, and the flow is about to open the browser itself.
    #[test]
    fn reopening_before_the_flow_has_a_url_opens_nothing_and_is_not_an_error() {
        let state = AppState::new();
        let _reg = register_login(&state.oidc_sessions, Some("login-1".into()), quiet_session()).unwrap();
        let (opener, opened) = recording_opener();

        assert!(reopen_oidc_login_impl(&state, "login-1", &opener).is_ok());
        assert!(opened.lock().unwrap().is_empty());
    }

    #[test]
    fn a_browser_that_will_not_reopen_reports_the_launch_failure_key() {
        let state = AppState::new();
        let session = quiet_session();
        session.set_authorization_url("https://idp.example/authorize?state=s1".to_string());
        let _reg = register_login(&state.oidc_sessions, Some("login-1".into()), session).unwrap();
        let failing: BrowserOpener = Arc::new(|_url: &str| Err(OidcError::BrowserLaunchFailed));

        let error = reopen_oidc_login_impl(&state, "login-1", &failing).unwrap_err();

        assert_eq!(error, OidcError::BrowserLaunchFailed.locale_key());
    }

    // ---- registration ----------------------------------------------------

    #[test]
    fn a_login_is_registered_under_the_callers_id_until_its_registration_drops() {
        let sessions = OidcSessions::default();
        let session = quiet_session();

        let registration = register_login(&sessions, Some("login-1".into()), session.clone()).unwrap();
        let held = sessions.lock().unwrap().get("login-1").cloned().expect("registered under the caller's id");
        assert!(Arc::ptr_eq(&held, &session), "the registry must hold the very session the driver uses");

        drop(registration);
        assert!(live_ids(&sessions).is_empty(), "the entry must go when the call it belongs to ends");
    }

    /// A cancel can land after the login completed but before its call
    /// returned (the dialog closing at that moment). The kept client's
    /// driver callback holds this same session for every later re-login, so
    /// a flag left set would fail each of them instantly as `Cancelled`.
    /// Once the entry is gone nothing can deliver a cancel, so deregistering
    /// clears it.
    #[test]
    fn deregistering_a_login_clears_a_cancel_that_landed_after_it_finished() {
        let sessions = OidcSessions::default();
        let session = quiet_session();
        let registration = register_login(&sessions, Some("login-1".into()), session.clone()).unwrap();
        session.cancel();
        assert!(session.is_cancelled(), "premise: the late cancel reached the session");

        drop(registration);

        assert!(!session.is_cancelled(), "a later re-login on the kept client must not start cancelled");
    }

    /// Without a caller id the login is still tracked (and still cleaned up);
    /// the UI just cannot name it to cancel it.
    #[test]
    fn a_login_without_a_caller_id_is_registered_under_a_fresh_one() {
        let sessions = OidcSessions::default();

        let first = register_login(&sessions, None, quiet_session()).unwrap();
        let second = register_login(&sessions, None, quiet_session()).unwrap();
        let ids = live_ids(&sessions);
        assert_eq!(ids.len(), 2, "two anonymous logins must not share an id: {ids:?}");
        assert!(ids.iter().all(|id| !id.is_empty()));

        drop(first);
        drop(second);
        assert!(live_ids(&sessions).is_empty());
    }

    /// A second login under a live id would let the first call's cleanup
    /// remove the second's entry, making it uncancellable.
    #[test]
    fn a_login_id_already_in_flight_is_refused_and_the_first_login_keeps_its_entry() {
        let sessions = OidcSessions::default();
        let first = quiet_session();
        let _reg = register_login(&sessions, Some("login-1".into()), first.clone()).unwrap();

        assert!(register_login(&sessions, Some("login-1".into()), quiet_session()).is_err());

        let held = sessions.lock().unwrap().get("login-1").cloned().unwrap();
        assert!(Arc::ptr_eq(&held, &first));
    }

    /// A cancel that races the login's end must leave no flag behind. Either
    /// order is fine alone: a cancel first is cleared by the entry's drop,
    /// and a cancel after finds no entry. A cancel that looked the session
    /// up before the drop but set the flag after it would leave it set,
    /// failing every later re-login of the kept client as `Cancelled`.
    ///
    /// No seam can force that interleaving, so this races the two many times.
    /// Both sides spin on a shared round counter, so each round they start
    /// within a few instructions of each other. A regression is caught with
    /// high probability, not certainty. A pass never depends on timing,
    /// since with the lock held across the cancel no interleaving leaves the
    /// flag set.
    #[test]
    fn a_cancel_racing_the_end_of_its_login_never_leaves_the_flag_set() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        const ROUNDS: usize = 1_000_000;
        let state = AppState::new();
        let started = AtomicUsize::new(0);
        let finished = AtomicUsize::new(0);
        let mut stale = 0;
        // Spins, but yields to the scheduler every 128 spins, so an
        // oversubscribed parallel test run cannot stall the two threads on
        // each other. Waits are usually far shorter than that.
        let wait_for = |counter: &AtomicUsize, round: usize| {
            let mut spins: u32 = 0;
            while counter.load(Ordering::Acquire) != round {
                spins = spins.wrapping_add(1);
                if spins % 128 == 0 {
                    std::thread::yield_now();
                } else {
                    std::hint::spin_loop();
                }
            }
        };
        std::thread::scope(|s| {
            s.spawn(|| {
                for round in 1..=ROUNDS {
                    wait_for(&started, round);
                    cancel_oidc_login_impl(&state, "racing").unwrap();
                    finished.store(round, Ordering::Release);
                }
            });
            for round in 1..=ROUNDS {
                let session = quiet_session();
                let registration =
                    register_login(&state.oidc_sessions, Some("racing".into()), session.clone()).unwrap();
                started.store(round, Ordering::Release);
                // A delay that sweeps across rounds, so some drops land
                // between the cancel's lookup and its store.
                for _ in 0..round % 256 {
                    std::hint::spin_loop();
                }
                drop(registration);
                wait_for(&finished, round);
                if session.is_cancelled() {
                    stale += 1;
                }
            }
        });
        assert_eq!(stale, 0, "a cancel landed after its login's entry was dropped, in {stale} of {ROUNDS} rounds");
    }

    // ---- prepare_human_login ---------------------------------------------

    async fn parsed(uri: &str) -> mongodb::options::ClientOptions {
        mongodb::options::ClientOptions::parse(uri).await.expect("a literal URI parses without I/O")
    }

    #[tokio::test]
    async fn an_oidc_connection_registers_its_login_under_the_callers_id() {
        let sessions = OidcSessions::default();
        let mut options = parsed("mongodb://127.0.0.1:1/?authMechanism=MONGODB-OIDC&authSource=$external").await;
        let session = quiet_session();
        let login = HumanLogin { login_id: Some("login-1".into()), ..HumanLogin::unattended() };

        let registration = prepare_human_login(&mut options, &sessions, login, session.clone()).unwrap();

        assert!(registration.is_some());
        let held = sessions.lock().unwrap().get("login-1").cloned().expect("registered under the caller's id");
        assert!(Arc::ptr_eq(&held, &session));
        drop(registration);
        assert!(live_ids(&sessions).is_empty());
    }

    /// Only OIDC has a login to cancel; every other mechanism leaves the
    /// registry alone.
    #[tokio::test]
    async fn a_non_oidc_connection_registers_nothing() {
        let sessions = OidcSessions::default();
        let mut options = parsed("mongodb://u:pw@127.0.0.1:1/?authMechanism=SCRAM-SHA-256&authSource=admin").await;
        let login = HumanLogin { login_id: Some("login-1".into()), ..HumanLogin::unattended() };

        let registration = prepare_human_login(&mut options, &sessions, login, quiet_session()).unwrap();

        assert!(registration.is_none());
        assert!(live_ids(&sessions).is_empty());
    }

    /// `ALLOWED_HOSTS` reaches the driver through the profile config, never
    /// the URI (which the driver would reject).
    #[tokio::test]
    async fn the_profiles_allowed_hosts_reach_the_driver_credential() {
        let sessions = OidcSessions::default();
        let mut options = parsed("mongodb://127.0.0.1:1/?authMechanism=MONGODB-OIDC&authSource=$external").await;
        let config = crate::connections::OidcProfileConfig { allowed_hosts: vec!["*.corp.example".into()], ..Default::default() };
        let login = HumanLogin { config: Some(&config), ..HumanLogin::unattended() };

        let _registration = prepare_human_login(&mut options, &sessions, login, quiet_session()).unwrap();

        let properties = options
            .credential
            .as_ref()
            .and_then(|c| c.mechanism_properties.as_ref())
            .expect("allowed hosts must land in the mechanism properties");
        assert_eq!(
            properties.get_array("ALLOWED_HOSTS").unwrap(),
            &vec![mongodb::bson::Bson::String("*.corp.example".into())]
        );
    }

    // ---- the connect path ------------------------------------------------

    use super::test_support::silent_server;

    /// Connect has no phase channel, so the only way the UI can cancel its
    /// login is by the id it minted before invoking. The entry must exist
    /// under that id while the call runs, and be gone once it fails.
    #[tokio::test]
    async fn an_oidc_connect_registers_its_login_while_in_flight_and_removes_it_when_it_fails() {
        let state = AppState::new();
        let port = silent_server().await;
        let uri = format!(
            "mongodb://127.0.0.1:{port}/?authMechanism=MONGODB-OIDC&authSource=$external&serverSelectionTimeoutMS=1500"
        );

        let call = crate::connect_db_with_oidc_impl(
            &state,
            &uri,
            None,
            None,
            Some("connect-login".into()),
            no_browser_opener(),
        );
        let watch = async {
            for _ in 0..200 {
                if state.oidc_sessions.lock().unwrap().contains_key("connect-login") {
                    return true;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            false
        };
        let (result, registered) = tokio::join!(call, watch);

        assert!(registered, "the login must be registered under the caller's id while connect runs");
        assert!(result.is_err(), "nothing answers, so the connect must fail");
        assert!(live_ids(&state.oidc_sessions).is_empty(), "a failed connect must leave no login behind");
        assert!(state.connections.lock().unwrap().is_empty());
    }

    /// The UI can cancel the moment it has invoked, and the SSH tunnel and
    /// `ClientOptions::parse` (SRV and TXT lookups) can take a while before
    /// the driver ever calls back. The login must already be registered
    /// through that window, so a cancel sent then reaches the session the
    /// callback will use instead of finding no entry and being dropped.
    #[tokio::test]
    async fn an_oidc_connect_is_cancellable_while_its_ssh_tunnel_is_still_opening() {
        let state = AppState::new();
        // An SSH server that never sends its banner: the tunnel stays opening.
        let ssh_port = silent_server().await;
        let ssh = crate::ssh_tunnel::SshConfig {
            enabled: true,
            host: "127.0.0.1".into(),
            port: ssh_port,
            user: "u".into(),
            auth: crate::ssh_tunnel::SshAuth::Password { password: "p".into() },
        };
        let uri = "mongodb://db.internal:27017/?authMechanism=MONGODB-OIDC&authSource=$external";
        // The real host is allowed, so the tunnel is actually attempted.
        let config = OidcProfileConfig { allowed_hosts: vec!["db.internal".into()], ..Default::default() };
        let login = HumanLogin {
            config: Some(&config),
            login_id: Some("tunnel-login".into()),
            ..HumanLogin::unattended()
        };

        let call = crate::connect_db_with_login(&state, uri, Some(&ssh), login);
        // Cancels from inside the race, while the connect call is still
        // alive: once it is dropped its registration goes with it.
        let cancel_while_opening = async {
            for _ in 0..200 {
                let live = state.oidc_sessions.lock().unwrap().get("tunnel-login").cloned();
                if let Some(session) = live {
                    cancel_oidc_login_impl(&state, "tunnel-login").unwrap();
                    return Some(session.is_cancelled());
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            None
        };
        let cancelled = tokio::select! {
            result = call => panic!("premise: the tunnel to a silent SSH server must still be opening, got {result:?}"),
            cancelled = cancel_while_opening => cancelled.expect("the login must be registered before the tunnel opens"),
        };

        assert!(cancelled, "the cancel must reach the session the callback will use");
    }

    /// The connection test's twin of the case above (PR #433 review): closing
    /// the editor cancels by the test's login id while the tunnel, a DNS
    /// lookup or the URI parse is still pending, and that cancel must reach
    /// the session instead of finding no entry and letting the test go on to
    /// open a browser.
    #[tokio::test]
    async fn an_oidc_connection_test_is_cancellable_while_its_ssh_tunnel_is_still_opening() {
        let state = AppState::new();
        let ssh_port = silent_server().await;
        let ssh = crate::ssh_tunnel::SshConfig {
            enabled: true,
            host: "127.0.0.1".into(),
            port: ssh_port,
            user: "u".into(),
            auth: crate::ssh_tunnel::SshAuth::Password { password: "p".into() },
        };
        let uri = "mongodb://db.internal:27017/?authMechanism=MONGODB-OIDC&authSource=$external";
        let config = OidcProfileConfig { allowed_hosts: vec!["db.internal".into()], ..Default::default() };
        let login = HumanLogin {
            config: Some(&config),
            login_id: Some("test-tunnel-login".into()),
            ..HumanLogin::unattended()
        };
        let emit = |_: crate::connections::PhaseUpdate| {};

        let call =
            crate::connections::run_connection_test_with_oidc(&state.oidc_sessions, uri, Some(&ssh), login, &emit);
        let cancel_while_opening = async {
            for _ in 0..200 {
                let live = state.oidc_sessions.lock().unwrap().get("test-tunnel-login").cloned();
                if let Some(session) = live {
                    cancel_oidc_login_impl(&state, "test-tunnel-login").unwrap();
                    return Some(session.is_cancelled());
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            None
        };
        let cancelled = tokio::select! {
            result = call => panic!("premise: the tunnel to a silent SSH server must still be opening, got {result:?}"),
            cancelled = cancel_while_opening => cancelled.expect("the login must be registered before the tunnel opens"),
        };

        assert!(cancelled, "the cancel must reach the session the callback will use");
    }

    // ---- the embedded shell and "Use ID token" (PR #433 review) ---------

    const SHELL_OIDC_URI: &str = "mongodb://db.internal:27017/?authMechanism=MONGODB-OIDC&authSource=$external";

    /// mongosh runs its own login from the URI alone, which cannot carry the
    /// profile's OIDC settings. On a connection whose login sends the ID
    /// token, mongosh must be told to send its own ID token too, or MongoDB
    /// refuses the shell's login exactly as it refused the access token.
    #[test]
    fn mongosh_on_a_connection_that_sends_the_id_token_is_told_to_do_the_same() {
        let state = AppState::new();
        state.conn_oidc_id_token.lock().unwrap().insert("conn-1".to_string());

        let args = crate::mongosh_uri_args(&state, "conn-1", SHELL_OIDC_URI).unwrap();

        let uri = crate::connections::normalize_mongodb_uri_options(SHELL_OIDC_URI);
        assert_eq!(args, vec!["--quiet".to_string(), "--oidcIdTokenAsAccessToken".to_string(), uri]);
    }

    #[test]
    fn mongosh_on_any_other_connection_gets_only_the_uri() {
        let state = AppState::new();

        let args = crate::mongosh_uri_args(&state, "conn-1", SHELL_OIDC_URI).unwrap();

        let uri = crate::connections::normalize_mongodb_uri_options(SHELL_OIDC_URI);
        assert_eq!(args, vec!["--quiet".to_string(), uri]);
    }

    #[tokio::test]
    async fn disconnecting_forgets_that_a_connection_sends_the_id_token() {
        let state = AppState::new();
        state.conn_oidc_id_token.lock().unwrap().insert("conn-1".to_string());

        crate::disconnect_db_impl(&state, "conn-1").await.unwrap();

        assert!(!state.conn_oidc_id_token.lock().unwrap().contains("conn-1"));
    }

    // ---- allowed hosts through an SSH tunnel -----------------------------

    use super::test_support::{closed_port, ssh_to};

    const HOST_NOT_ALLOWED: &str = "auth.oidc.errors.hostNotAllowed";

    /// Through a tunnel the driver only ever sees `127.0.0.1`, so the real
    /// host must be checked before the tunnel opens. The SSH port is closed:
    /// had the tunnel been tried, this would be an SSH connection error.
    #[tokio::test]
    async fn an_oidc_connect_over_ssh_refuses_a_real_host_outside_the_allowed_list_before_tunnelling() {
        let state = AppState::new();
        let ssh = ssh_to(closed_port());
        let config = OidcProfileConfig { allowed_hosts: vec!["*.corp.example".into()], ..Default::default() };
        let (open, opened) = recording_opener();
        let login = HumanLogin { config: Some(&config), open, ..HumanLogin::unattended() };
        let uri = "mongodb://db.internal:27017/?authMechanism=MONGODB-OIDC&authSource=$external";

        let result = crate::connect_db_with_login(&state, uri, Some(&ssh), login).await;

        assert_eq!(result, Err(HOST_NOT_ALLOWED.to_string()));
        assert!(opened.lock().unwrap().is_empty(), "no browser may open");
        assert!(live_ids(&state.oidc_sessions).is_empty());
    }

    /// With no custom list, the effective list is the driver's defaults, and
    /// a tunnelled connection no longer slips through on `127.0.0.1`.
    #[tokio::test]
    async fn an_oidc_connect_over_ssh_checks_the_real_host_against_the_driver_defaults() {
        let state = AppState::new();
        let ssh = ssh_to(closed_port());
        let uri = "mongodb://db.internal:27017/?authMechanism=MONGODB-OIDC&authSource=$external";

        let result = crate::connect_db_with_login(&state, uri, Some(&ssh), HumanLogin::unattended()).await;

        assert_eq!(result, Err(HOST_NOT_ALLOWED.to_string()));
    }

    /// An allowed real host gets past the check and on to the tunnel, which
    /// is what fails here. A custom list without `127.0.0.1` is fine.
    #[tokio::test]
    async fn an_oidc_connect_over_ssh_whose_real_host_is_allowed_goes_on_to_the_tunnel() {
        let state = AppState::new();
        let ssh_port = closed_port();
        let ssh = ssh_to(ssh_port);
        let config = OidcProfileConfig { allowed_hosts: vec!["*.internal".into()], ..Default::default() };
        let login = HumanLogin { config: Some(&config), ..HumanLogin::unattended() };
        let uri = "mongodb://db.internal:27017/?authMechanism=MONGODB-OIDC&authSource=$external";

        let result = crate::connect_db_with_login(&state, uri, Some(&ssh), login).await;

        let error = result.expect_err("nothing listens on the SSH port");
        assert!(
            error.starts_with(&format!("SSH connection to 127.0.0.1:{ssh_port} failed")),
            "the tunnel must have been tried, got {error}"
        );
    }

    /// Once the real host passes, the driver is left on its defaults, which
    /// allow the tunnel's `127.0.0.1`. The profile's list, and with it the
    /// remote host, never reaches the driver.
    #[tokio::test]
    async fn once_the_real_host_passes_the_driver_gets_no_custom_list() {
        let config = OidcProfileConfig { allowed_hosts: vec!["db.internal".into()], ..Default::default() };
        let uri = "mongodb://db.internal:27017/?authMechanism=MONGODB-OIDC&authSource=$external";

        let tunnelled = check_real_host_before_tunnel(uri, Some(&config)).expect("db.internal is allowed");
        let login = HumanLogin { config: Some(&tunnelled), ..HumanLogin::unattended() };

        let sessions = OidcSessions::default();
        let mut options =
            parsed("mongodb://127.0.0.1:1/?authMechanism=MONGODB-OIDC&authSource=$external&directConnection=true").await;
        let _registration = prepare_human_login(&mut options, &sessions, login, quiet_session()).unwrap();
        let properties = options.credential.as_ref().and_then(|c| c.mechanism_properties.as_ref());
        assert!(
            properties.is_none_or(|p| !p.contains_key("ALLOWED_HOSTS")),
            "the driver must get no custom list, got {properties:?}"
        );
    }

    #[test]
    fn a_real_host_outside_the_list_is_refused_with_the_host_not_allowed_key() {
        let config = OidcProfileConfig { allowed_hosts: vec!["*.corp.example".into()], ..Default::default() };
        let uri = "mongodb://user@db.internal:27017,db2.corp.example/?authMechanism=MONGODB-OIDC";

        let result = check_real_host_before_tunnel(uri, Some(&config)).map(|_| ());

        assert_eq!(result, Err(HOST_NOT_ALLOWED.to_string()));
    }

    /// Allowed hosts are OIDC's alone; other mechanisms tunnel as before.
    #[tokio::test]
    async fn a_non_oidc_connect_over_ssh_is_not_checked_against_allowed_hosts() {
        let state = AppState::new();
        let ssh_port = closed_port();
        let ssh = ssh_to(ssh_port);
        let uri = "mongodb://u:pw@db.internal:27017/?authMechanism=SCRAM-SHA-256&authSource=admin";

        let result = crate::connect_db_with_login(&state, uri, Some(&ssh), HumanLogin::unattended()).await;

        let error = result.expect_err("nothing listens on the SSH port");
        assert!(error.starts_with("SSH connection to"), "got {error}");
    }

    // ---- LoginReport -----------------------------------------------------

    fn report_of(phases: Vec<crate::oidc::OidcPhase>) -> LoginReport {
        let mut report = LoginReport::default();
        for phase in &phases {
            report.record(phase);
        }
        report
    }

    use crate::oidc::OidcPhase;

    #[test]
    fn a_ping_failure_with_no_login_is_not_explained_by_one() {
        assert_eq!(report_of(vec![]).explain(DriverFailure::Other), None);
        assert_eq!(report_of(vec![OidcPhase::WaitingForBrowser]).explain(DriverFailure::Other), None);
        // An authentication failure no login preceded is some other
        // mechanism's (a SCRAM password, say): the driver explains it.
        assert_eq!(report_of(vec![]).explain(DriverFailure::AuthenticationFailed), None);
    }

    #[test]
    fn a_ping_failure_after_a_failed_login_is_the_logins_failure() {
        let report = report_of(vec![OidcPhase::WaitingForBrowser, OidcPhase::Failed(OidcError::Cancelled)]);
        assert_eq!(report.explain(DriverFailure::Other), Some(PingFailure::LoginFailed("auth.oidc.errors.cancelled")));
    }

    /// `loginOkPingFailed` stays for what it says: the login worked and the
    /// ping then failed for a reason that is not authentication.
    #[test]
    fn a_non_authentication_failure_after_a_completed_login_is_login_ok_ping_failed() {
        let report = report_of(vec![OidcPhase::WaitingForBrowser, OidcPhase::Completed(crate::oidc::Presented::AccessToken)]);
        assert_eq!(
            report.explain(DriverFailure::Other),
            Some(PingFailure::PingFailed("auth.oidc.errors.loginOkPingFailed"))
        );
    }

    /// The flow reports `Completed` as soon as the IdP hands over a token,
    /// before MongoDB has looked at it. An authentication failure after that
    /// is MongoDB rejecting the token — Authenticate's failure, not "login
    /// succeeded, check the network".
    #[test]
    fn an_authentication_failure_after_a_completed_login_is_token_rejected() {
        let report = report_of(vec![OidcPhase::WaitingForBrowser, OidcPhase::Completed(crate::oidc::Presented::AccessToken)]);
        assert_eq!(
            report.explain(DriverFailure::AuthenticationFailed),
            Some(PingFailure::AuthenticateFailed("auth.oidc.errors.tokenRejected"))
        );
    }

    /// MongoDB tells the client only "Authentication failed." — the reason
    /// ("Unknown type of token") stays in the server's log. The login knows
    /// it handed over an access token whose `typ` MongoDB refuses, so a
    /// rejection after that is explained by it, with the fix: the option.
    #[test]
    fn a_rejection_after_an_access_token_of_a_refused_type_points_at_the_id_token_option() {
        let report = report_of(vec![
            OidcPhase::WaitingForBrowser,
            OidcPhase::Completed(Presented::AccessTokenOfRefusedType),
        ]);
        assert_eq!(
            report.explain(DriverFailure::AuthenticationFailed),
            Some(PingFailure::AuthenticateFailed("auth.oidc.errors.accessTokenTypeRejected"))
        );
    }

    /// With the option on the ID token was sent, so the hint would be wrong:
    /// the rejection is the plain one.
    #[test]
    fn a_rejection_of_an_id_token_stays_token_rejected() {
        let report = report_of(vec![OidcPhase::WaitingForBrowser, OidcPhase::Completed(Presented::IdToken)]);
        assert_eq!(
            report.explain(DriverFailure::AuthenticationFailed),
            Some(PingFailure::AuthenticateFailed("auth.oidc.errors.tokenRejected"))
        );
    }

    /// The token's type explains a rejection, not a ping that failed for
    /// another reason after authentication succeeded.
    #[test]
    fn a_refused_type_explains_only_an_authentication_failure() {
        let report = report_of(vec![
            OidcPhase::WaitingForBrowser,
            OidcPhase::Completed(Presented::AccessTokenOfRefusedType),
        ]);
        assert_eq!(
            report.explain(DriverFailure::Other),
            Some(PingFailure::PingFailed("auth.oidc.errors.loginOkPingFailed"))
        );
    }

    /// The tunnel path clears only the custom host list.
    #[test]
    fn a_tunnelled_login_keeps_the_id_token_option() {
        let config = OidcProfileConfig { allowed_hosts: vec!["db.internal".into()], use_id_token: true };
        let uri = "mongodb://db.internal:27017/?authMechanism=MONGODB-OIDC&authSource=$external";

        let tunnelled = check_real_host_before_tunnel(uri, Some(&config)).expect("db.internal is allowed");

        assert_eq!(tunnelled, OidcProfileConfig { allowed_hosts: vec![], use_id_token: true });
    }

    /// The driver checks allowed hosts before it ever calls back, so no
    /// login has reported anything; the refusal is Authenticate's all the
    /// same.
    #[test]
    fn a_host_outside_the_allowed_hosts_is_host_not_allowed_whether_or_not_a_login_ran() {
        for phases in [vec![], vec![OidcPhase::WaitingForBrowser, OidcPhase::Completed(crate::oidc::Presented::AccessToken)]] {
            assert_eq!(
                report_of(phases).explain(DriverFailure::HostNotAllowed),
                Some(PingFailure::AuthenticateFailed("auth.oidc.errors.hostNotAllowed"))
            );
        }
    }

    /// A failure is the more specific explanation, whatever else was seen.
    #[test]
    fn a_login_failure_outranks_an_earlier_completion() {
        let report = report_of(vec![OidcPhase::Completed(crate::oidc::Presented::AccessToken), OidcPhase::Failed(OidcError::TimedOut)]);
        assert_eq!(
            report.explain(DriverFailure::AuthenticationFailed),
            Some(PingFailure::LoginFailed("auth.oidc.errors.timedOut"))
        );
    }

    /// A server-side authentication failure (code 18, `AuthenticationFailed`)
    /// is one; anything else — our own callback's error included — is not.
    #[test]
    fn server_authentication_failures_are_told_apart_from_other_errors() {
        let rejected: mongodb::error::CommandError = serde_json::from_value(serde_json::json!({
            "code": 18,
            "codeName": "AuthenticationFailed",
            "errmsg": "Authentication failed.",
        }))
        .unwrap();
        let rejected = mongodb::error::Error::from(mongodb::error::ErrorKind::Command(rejected));
        assert_eq!(DriverFailure::of(&rejected), DriverFailure::AuthenticationFailed);

        let unrelated: mongodb::error::CommandError = serde_json::from_value(serde_json::json!({
            "code": 2,
            "codeName": "BadValue",
            "errmsg": "failCommand",
        }))
        .unwrap();
        let unrelated = mongodb::error::Error::from(mongodb::error::ErrorKind::Command(unrelated));
        assert_eq!(DriverFailure::of(&unrelated), DriverFailure::Other);

        let ours = mongodb::error::Error::custom(format!("{}", OidcError::Cancelled));
        assert_eq!(DriverFailure::of(&ours), DriverFailure::Other);
    }

    /// Every connect and test describes a login, SCRAM included, so building
    /// the IdP client up front would be wasted work for all of them — and
    /// `reqwest::Client::new` panics if the TLS backend fails to initialise.
    #[test]
    fn describing_a_login_builds_no_http_client() {
        assert!(HumanLogin::unattended().http.is_none());
        assert!(HumanLogin::interactive(None, Some("login-1".into()), no_browser_opener()).http.is_none());
    }

    /// A production login — no client injected — must get the hardened IdP
    /// client, not a default one: here, one that will not resend the code
    /// and verifier to wherever a `307` points.
    #[tokio::test]
    async fn a_login_without_an_injected_client_uses_the_hardened_idp_client() {
        let sink = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let elsewhere = format!("http://{}/stolen", sink.local_addr().unwrap());
        let reached = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = reached.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = sink.accept().await {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                drop(socket);
            }
        });
        let idp = crate::oidc::mock_idp::MockIdp::start();
        idp.redirect_token_requests_to(&elsewhere);

        let http = idp_client(None).unwrap();
        let endpoints = crate::oidc::discover(&idp.issuer(), &http).await.unwrap();
        let _ = crate::oidc::refresh_token(&endpoints, "client-abc", "test-refresh-token", &http, crate::oidc::TokenChoice::AccessToken).await;

        assert_eq!(reached.load(std::sync::atomic::Ordering::SeqCst), 0, "a redirect must not be followed");
    }

    // ---- openers ---------------------------------------------------------

    #[test]
    fn the_non_interactive_opener_never_opens_a_browser() {
        let opener = no_browser_opener();
        assert_eq!(opener("https://idp.example/authorize"), Err(OidcError::BrowserLaunchFailed));
    }

    // ---- uri_requests_oidc -----------------------------------------------

    #[test]
    fn an_oidc_mechanism_in_the_query_is_detected_however_it_is_spelled() {
        for uri in [
            "mongodb://h:27017/?authMechanism=MONGODB-OIDC&authSource=$external",
            "mongodb://h/?authSource=%24external&authmechanism=MONGODB-OIDC",
            "mongodb://h/?AUTHMECHANISM=mongodb-oidc",
            "mongodb://h/db?authMechanism=MONGODB%2DOIDC",
            "mongodb+srv://cluster.example.com/?retryWrites=true;authMechanism=MONGODB-OIDC",
            "mongodb://h/?authMechanism= MONGODB-OIDC ",
            // The driver has no fragment handling: after `#` the `&` still
            // starts a new option, and normalisation puts the fragment back.
            "mongodb://h/?appName=x#&authMechanism=MONGODB-OIDC&authSource=$external",
        ] {
            assert!(uri_requests_oidc(uri), "must detect OIDC in {uri}");
        }
    }

    /// The guard must read a URI exactly as the driver does. Each entry here
    /// is first confirmed to parse as MONGODB-OIDC by the driver itself — fed
    /// the normalised string, which is what the connect path hands it — so a
    /// tokenising difference on any axis (where the query starts, fragments,
    /// separators, key case, percent-encoding) shows up as a miss. Literal
    /// hosts only, so parsing does no I/O.
    #[tokio::test]
    async fn every_uri_the_driver_parses_as_oidc_is_refused() {
        for uri in [
            "mongodb://h/?authMechanism=MONGODB-OIDC&authSource=$external",
            "mongodb://h/?appName=x#&authMechanism=MONGODB-OIDC&authSource=$external",
            "mongodb://h/?appName=a#b&authMechanism=MONGODB-OIDC&authSource=$external",
            "mongodb://h/#?authMechanism=MONGODB-OIDC&authSource=$external",
            "mongodb://h/?authmechanism=MONGODB%2DOIDC&authSource=%24external",
            "mongodb://h/?AUTHMECHANISM=MONGODB-OIDC&authSource=$external",
            "mongodb://h1:27017,h2:27018/db?retryWrites=true;authMechanism=MONGODB-OIDC;authSource=$external",
        ] {
            let normalized = crate::connections::normalize_mongodb_uri_options(uri);
            let options = mongodb::options::ClientOptions::parse(&normalized)
                .await
                .unwrap_or_else(|e| panic!("premise: the driver must parse {uri}: {e}"));
            assert!(uses_oidc(&options), "premise: the driver must read {uri} as MONGODB-OIDC");
            assert!(uri_requests_oidc(uri), "the guard must refuse {uri}, which the driver reads as OIDC");
        }
    }

    #[test]
    fn other_mechanisms_and_look_alikes_outside_the_mechanism_option_are_not_oidc() {
        for uri in [
            "mongodb://h:27017/",
            "mongodb://h/?authMechanism=SCRAM-SHA-256",
            "mongodb://u:pw@h/?authMechanism=MONGODB-X509",
            "mongodb://MONGODB-OIDC:pw@h/?authSource=admin",
            "mongodb://h/authMechanism=MONGODB-OIDC",
            "mongodb://h/?authMechanismProperties=ENVIRONMENT:MONGODB-OIDC",
            "mongodb://h/?appName=authMechanism=MONGODB-OIDC",
        ] {
            assert!(!uri_requests_oidc(uri), "must not treat {uri} as OIDC");
        }
    }
}
