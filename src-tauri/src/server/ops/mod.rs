//! Server adapters: each runs one family of commands through MQLens Server
//! and returns exactly what local mode returns.

pub(crate) mod metadata;

use crate::server::accounts;
use crate::server::remote::RemoteConn;
use crate::server::session::AccountSession;
use crate::AppState;
use std::sync::Arc;

/// The signed-in session of the account a remote connection belongs to,
/// resumed from its stored token when there is none.
pub(crate) async fn session_for(
    state: &AppState,
    conn: &RemoteConn,
) -> Result<Arc<AccountSession>, String> {
    let key = state.require_key()?;
    let account = accounts::find(&conn.accounts_path, &key, &conn.account_id)?;
    state
        .server
        .session(
            &account,
            crate::server::commands::token_store(state, &conn.accounts_path),
        )
        .await
}
