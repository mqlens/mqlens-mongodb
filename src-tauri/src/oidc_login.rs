//! The app side of human MONGODB-OIDC login (#430): which logins are in
//! flight, so the UI can cancel one or send the browser back to it, and the
//! browser openers the connect and test paths hand the flow.

use crate::oidc::{BrowserOpener, OidcError, OidcSession};
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
pub struct LoginRegistration<'a> {
    sessions: &'a OidcSessions,
    login_id: String,
}

impl Drop for LoginRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock_safe() {
            sessions.remove(&self.login_id);
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
pub fn cancel_oidc_login_impl(state: &AppState, login_id: &str) -> Result<(), String> {
    if let Some(session) = live_session(state, login_id)? {
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
/// lookups. Mirrors the driver: option names are case-insensitive and values
/// percent-decoded; `;` is accepted as a separator because
/// `normalize_mongodb_uri_options` turns it into `&` before the driver sees
/// it. The value is compared case-insensitively, a superset of the driver's
/// exact match, since a guard should err towards refusing.
///
/// The URI is the only place the mechanism can come from: an SRV TXT record
/// may carry only `authSource`, `replicaSet` and `loadBalanced`.
pub fn uri_requests_oidc(uri: &str) -> bool {
    let Some((_, query)) = uri.split_once('?') else {
        return false;
    };
    let query = query.split('#').next().unwrap_or_default();
    query.split(['&', ';']).any(|pair| {
        let Some((key, value)) = pair.split_once('=') else {
            return false;
        };
        let value = percent_encoding::percent_decode_str(value).decode_utf8_lossy();
        key.trim().eq_ignore_ascii_case("authMechanism") && value.trim().eq_ignore_ascii_case("MONGODB-OIDC")
    })
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
        ] {
            assert!(uri_requests_oidc(uri), "must detect OIDC in {uri}");
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
