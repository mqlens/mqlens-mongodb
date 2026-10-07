//! Server adapters: each runs one family of commands through MQLens Server
//! and returns exactly what local mode returns.

pub(crate) mod ddl;
pub(crate) mod metadata;
pub(crate) mod monitoring;
pub(crate) mod query;
pub(crate) mod stats;
pub(crate) mod users;

use crate::server::accounts;
use crate::server::remote::RemoteConn;
use crate::server::session::AccountSession;
use crate::AppState;
use std::sync::Arc;

/// Signed in to the fake's account and connected to its connection "c1";
/// returns the state and the desktop connection id.
#[cfg(test)]
pub(crate) async fn connected(env: &crate::server::fake::Env) -> (AppState, String) {
    use crate::server::commands::{server_connect_impl, sign_in_impl};
    let state = AppState::new();
    *state.vault_key.lock().unwrap() = Some(crate::server::fake::KEY);
    sign_in_impl(
        &state,
        &env.path,
        &env.account.id,
        crate::server::fake::PASSWORD.to_string(),
    )
    .await
    .unwrap();
    let id = server_connect_impl(&state, &env.path, &env.account.id, "c1")
        .await
        .unwrap()
        .id;
    (state, id)
}

const ACCOUNT_REPOINTED: &str = "This connection's MQLens Server account now signs in to another server or as another user. Reconnect.";

/// The signed-in session of the account a remote connection belongs to,
/// resumed from its stored token when there is none.
pub(crate) async fn session_for(
    state: &AppState,
    conn: &RemoteConn,
) -> Result<Arc<AccountSession>, String> {
    let key = state.require_key()?;
    let account = accounts::find(&conn.accounts_path, &key, &conn.account_id)?;
    // Repointed at another server or user since the connection was made: its
    // session would run the command somewhere else than this connection means.
    if !account.same_identity(&conn.identity) {
        return Err(ACCOUNT_REPOINTED.to_string());
    }
    state
        .server
        .session(
            &account,
            crate::server::commands::token_store(state, &conn.accounts_path),
        )
        .await
}
