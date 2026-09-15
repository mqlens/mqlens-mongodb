//! Server mode: running commands through an MQLens Server instead of a direct
//! MongoDB connection.
//!
//! A desktop user signs in to an MQLens Server account and connects to one of
//! the server's connections. The server holds the connection string and
//! credentials; the desktop only ever sees a connection reference. Local mode
//! does not go through this module.

// The foundation lands before the commands that use it; until server mode is
// routed (accounts, sessions, remote connections), only tests reach it.
#![cfg_attr(not(test), allow(dead_code, unused_macros))]

pub(crate) mod accounts;
pub(crate) mod channel;
pub(crate) mod commands;
pub(crate) mod ejson;
pub(crate) mod errors;
#[cfg(test)]
pub(crate) mod fake;
pub(crate) mod pb;
pub(crate) mod session;

use session::{AccountSession, KeySource, TokenStore};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The live sessions, one per signed-in account.
///
/// Sessions are made on demand: signing in creates one, and after a restart or
/// an unlock the first call that needs an account resumes one from its stored
/// token. Locking the vault drops them all.
#[derive(Default)]
pub(crate) struct ServerRuntime {
    sessions: tokio::sync::Mutex<HashMap<String, Arc<AccountSession>>>,
}

impl ServerRuntime {
    /// The account's live session, resuming one from its stored token when
    /// there is none or the last one ended.
    pub(crate) async fn session(
        &self,
        account: &accounts::ServerAccount,
        store: Arc<dyn TokenStore>,
    ) -> Result<Arc<AccountSession>, String> {
        let mut sessions = self.sessions.lock().await;
        if let Some(existing) = sessions.get(&account.id) {
            if !existing.is_ended() {
                return Ok(existing.clone());
            }
        }
        if account.refresh_token.is_none() {
            sessions.remove(&account.id);
            return Err(format!(
                "Sign in to the MQLens Server account \"{}\" first",
                account.name
            ));
        }
        let session = AccountSession::resume(account, store)?;
        sessions.insert(account.id.clone(), session.clone());
        Ok(session)
    }

    pub(crate) async fn insert(&self, session: Arc<AccountSession>) {
        self.sessions
            .lock()
            .await
            .insert(session.account_id().to_string(), session);
    }

    pub(crate) async fn remove(&self, account_id: &str) -> Option<Arc<AccountSession>> {
        self.sessions.lock().await.remove(account_id)
    }

    /// Drops every session. The vault is locking, and no session may outlive
    /// the key its token is stored under.
    pub(crate) async fn clear(&self) {
        self.sessions.lock().await.clear();
    }
}

/// The vault key as sessions read it: current at the moment a token is stored,
/// so a password change or a lock is never raced by a key captured earlier.
pub(crate) fn key_source(vault_key: Arc<Mutex<Option<[u8; 32]>>>) -> KeySource {
    Arc::new(move || {
        vault_key
            .lock()
            .map_err(|_| "internal state lock poisoned".to_string())?
            .ok_or_else(|| "vault is locked".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::fake::{list_connections, Env, PASSWORD};

    async fn sign_in(env: &Env) -> Arc<AccountSession> {
        match AccountSession::sign_in(&env.account, PASSWORD, env.store()).await {
            Ok(session) => session,
            Err(e) => panic!("sign in failed: {e}"),
        }
    }

    #[tokio::test]
    async fn an_account_without_a_stored_session_must_sign_in_first() {
        let env = Env::new().await;
        let runtime = ServerRuntime::default();
        match runtime.session(&env.stored_account(), env.store()).await {
            Err(e) => assert!(
                e.contains("Sign in to the MQLens Server account \"Acme\""),
                "{e}"
            ),
            Ok(_) => panic!("a session without a stored token"),
        }
    }

    #[tokio::test]
    async fn a_resumed_session_is_shared_until_cleared() {
        let env = Env::new().await;
        sign_in(&env).await;
        let runtime = ServerRuntime::default();

        let a = runtime
            .session(&env.stored_account(), env.store())
            .await
            .unwrap();
        let b = runtime
            .session(&env.stored_account(), env.store())
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        list_connections(&a).await.unwrap();

        runtime.clear().await;
        let c = runtime
            .session(&env.stored_account(), env.store())
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
    }

    #[tokio::test]
    async fn an_ended_session_is_not_handed_out() {
        let env = Env::new().await;
        let runtime = ServerRuntime::default();
        let session = sign_in(&env).await;
        runtime.insert(session.clone()).await;
        session.sign_out().await.unwrap();

        assert!(runtime
            .session(&env.stored_account(), env.store())
            .await
            .is_err());

        let again = sign_in(&env).await;
        runtime.insert(again.clone()).await;
        let current = runtime
            .session(&env.stored_account(), env.store())
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&current, &again));
        assert!(runtime.remove(&env.account.id).await.is_some());
    }

    #[test]
    fn the_key_source_follows_the_vault() {
        let vault_key = Arc::new(Mutex::new(None));
        let source = key_source(vault_key.clone());
        assert_eq!(source().unwrap_err(), "vault is locked");
        *vault_key.lock().unwrap() = Some([1; 32]);
        assert_eq!(source().unwrap(), [1; 32]);
        *vault_key.lock().unwrap() = None;
        assert!(source().is_err());
    }
}
