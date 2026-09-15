//! Command bodies for MQLens Server accounts and sessions.
//!
//! Each takes the accounts file path explicitly, like the other `_impl`s, so
//! tests run against a temporary file with no `AppHandle`.

use crate::server::accounts::{self, ServerAccount, ServerAccountInput, ServerAccountView};
use crate::server::channel::client;
use crate::server::key_source;
use crate::server::pb::mqlens::v1::connection_service_client::ConnectionServiceClient;
use crate::server::pb::mqlens::v1::ListConnectionsRequest;
use crate::server::session::{blocking, AccountSession, FileTokenStore, TokenStore};
use crate::AppState;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

/// How long a vault reset waits for its sessions to end on their servers.
const RESET_SIGN_OUT_TIMEOUT: Duration = Duration::from_secs(10);

/// One of the server's connections as the webview sees it: a reference, never
/// a connection string or credential, and what the user may do there.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteConnectionView {
    pub id: String,
    pub name: String,
    pub tags: Vec<String>,
    pub deployment_kind: String,
    pub op_classes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignOutResult {
    /// False when the server could not confirm it: the session is gone here,
    /// but may stay usable on the server until it expires.
    pub ended_on_server: bool,
}

fn token_store(state: &AppState, path: &Path) -> Arc<dyn TokenStore> {
    Arc::new(FileTokenStore::new(
        path.to_path_buf(),
        key_source(state.vault_key.clone()),
    ))
}

pub(crate) fn account_list_impl(
    state: &AppState,
    path: &Path,
) -> Result<Vec<ServerAccountView>, String> {
    let key = state.require_key()?;
    Ok(accounts::load(path, &key)?
        .iter()
        .map(ServerAccount::view)
        .collect())
}

pub(crate) async fn account_save_impl(
    state: &AppState,
    path: &Path,
    input: ServerAccountInput,
) -> Result<ServerAccountView, String> {
    let key = state.require_key()?;
    let candidate = input.clone().into_account()?;
    // An edit that changes who or where the account signs in ends its session
    // first, while the stored token can still log it out on the server.
    let existing = accounts::load(path, &key)?
        .into_iter()
        .find(|a| a.id == candidate.id);
    if let Some(existing) = existing {
        if existing.refresh_token.is_some() && !existing.same_identity(&candidate) {
            sign_out_account(state, path, &existing).await;
        }
    }
    let file = path.to_path_buf();
    let (saved, _) = blocking(move || accounts::save_account(&file, &key, input)).await?;
    if saved.refresh_token.is_none() {
        state.server.remove(&saved.id).await;
    }
    Ok(saved.view())
}

pub(crate) async fn account_delete_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
) -> Result<(), String> {
    let key = state.require_key()?;
    let existing = accounts::load(path, &key)?
        .into_iter()
        .find(|a| a.id == account_id);
    if let Some(existing) = existing.filter(|a| a.refresh_token.is_some()) {
        sign_out_account(state, path, &existing).await;
    }
    state.server.remove(account_id).await;
    let file = path.to_path_buf();
    let id = account_id.to_string();
    blocking(move || accounts::delete_account(&file, &key, &id)).await?;
    Ok(())
}

pub(crate) async fn sign_in_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
    password: String,
) -> Result<ServerAccountView, String> {
    let password = Zeroizing::new(password);
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    // Signing in again replaces the stored session: end that one properly
    // rather than leave it usable on the server.
    if account.refresh_token.is_some() {
        sign_out_account(state, path, &account).await;
    }
    let session = AccountSession::sign_in(&account, &password, token_store(state, path)).await?;
    state.server.insert(session).await;
    // The vault may have locked while the server answered; a session must not
    // be left behind for a locked vault.
    if state.require_key().is_err() {
        state.server.remove(account_id).await;
        return Err("vault is locked".to_string());
    }
    let mut view = account.view();
    view.signed_in = true;
    Ok(view)
}

pub(crate) async fn sign_out_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
) -> Result<SignOutResult, String> {
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    let session = match state.server.remove(account_id).await {
        Some(session) => session,
        None => AccountSession::resume(&account, token_store(state, path))?,
    };
    let ended_on_server = session.sign_out().await?;
    Ok(SignOutResult { ended_on_server })
}

pub(crate) async fn list_connections_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
) -> Result<Vec<RemoteConnectionView>, String> {
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    let session = state
        .server
        .session(&account, token_store(state, path))
        .await?;
    let response = session
        .call(ListConnectionsRequest {}, |channel, request| async move {
            client!(ConnectionServiceClient, channel)
                .list_connections(request)
                .await
        })
        .await?;
    Ok(response
        .connections
        .into_iter()
        .map(|c| RemoteConnectionView {
            id: c.id,
            name: c.name,
            tags: c.tags,
            deployment_kind: c.deployment_kind,
            op_classes: c.op_classes,
        })
        .collect())
}

/// Ends every stored session before a vault reset makes the accounts file
/// unreadable. Best effort and bounded: an unreachable server must not hold up
/// a reset, and sessions are dropped here regardless.
pub(crate) async fn sign_out_all_best_effort(state: &AppState, path: &Path) {
    if let Ok(key) = state.require_key() {
        if let Ok(all) = accounts::load(path, &key) {
            let sign_outs = all
                .iter()
                .filter(|a| a.refresh_token.is_some())
                .map(|a| sign_out_account(state, path, a));
            let _ =
                tokio::time::timeout(RESET_SIGN_OUT_TIMEOUT, futures::future::join_all(sign_outs))
                    .await;
        }
    }
    state.server.clear().await;
}

/// Ends an account's session on the server and here, best effort. Returns
/// whether the server confirmed it.
async fn sign_out_account(state: &AppState, path: &Path, account: &ServerAccount) -> bool {
    let session = match state.server.remove(&account.id).await {
        Some(session) => session,
        None => match AccountSession::resume(account, token_store(state, path)) {
            Ok(session) => session,
            Err(_) => return false,
        },
    };
    session.sign_out().await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::fake::{Env, EMAIL, KEY, PASSWORD, TENANT};

    fn unlocked() -> AppState {
        let state = AppState::new();
        *state.vault_key.lock().unwrap() = Some(KEY);
        state
    }

    fn form(env: &Env) -> ServerAccountInput {
        ServerAccountInput {
            id: Some(env.account.id.clone()),
            name: env.account.name.clone(),
            url: env.account.url.clone(),
            tenant: TENANT.to_string(),
            email: EMAIL.to_string(),
            allow_insecure_http: false,
            extra_ca_pem: None,
        }
    }

    #[tokio::test]
    async fn every_command_needs_an_unlocked_vault() {
        let env = Env::new().await;
        let state = AppState::new();
        let id = env.account.id.as_str();
        assert_eq!(
            account_list_impl(&state, &env.path).unwrap_err(),
            "vault is locked"
        );
        assert!(account_save_impl(&state, &env.path, form(&env))
            .await
            .is_err());
        assert!(account_delete_impl(&state, &env.path, id).await.is_err());
        assert!(sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .is_err());
        assert!(sign_out_impl(&state, &env.path, id).await.is_err());
        assert!(list_connections_impl(&state, &env.path, id).await.is_err());
        env.fake.with(|s| assert_eq!(s.logins, 0));
    }

    #[tokio::test]
    async fn signing_in_lists_the_servers_connections() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();

        let err = list_connections_impl(&state, &env.path, id)
            .await
            .unwrap_err();
        assert!(err.contains("Sign in"), "{err}");

        let view = sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        assert!(view.signed_in);
        assert!(account_list_impl(&state, &env.path).unwrap()[0].signed_in);

        let connections = list_connections_impl(&state, &env.path, id).await.unwrap();
        assert_eq!(
            connections,
            vec![RemoteConnectionView {
                id: "c1".to_string(),
                name: "Orders".to_string(),
                tags: vec!["prod".to_string()],
                deployment_kind: "replica_set".to_string(),
                op_classes: vec!["read".to_string(), "write".to_string()],
            }]
        );
        // The session made at sign-in is reused: no refresh was needed.
        env.fake.with(|s| assert_eq!(s.refreshes, 0));
    }

    #[tokio::test]
    async fn a_failed_sign_in_leaves_the_account_signed_out() {
        let env = Env::new().await;
        let state = unlocked();
        let err = sign_in_impl(&state, &env.path, &env.account.id, "nope".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("did not accept"), "{err}");
        assert!(!account_list_impl(&state, &env.path).unwrap()[0].signed_in);
    }

    #[tokio::test]
    async fn signing_in_again_ends_the_previous_session() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake.with(|s| {
            assert_eq!(s.logouts, 1);
            assert_eq!(s.live_families(), 1);
        });
        list_connections_impl(&state, &env.path, id).await.unwrap();
    }

    #[tokio::test]
    async fn signing_out_ends_the_session_everywhere() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();

        let result = sign_out_impl(&state, &env.path, id).await.unwrap();
        assert!(result.ended_on_server);
        assert!(!account_list_impl(&state, &env.path).unwrap()[0].signed_in);
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
        assert!(list_connections_impl(&state, &env.path, id).await.is_err());

        // Signing out an account that is not signed in is not an error.
        assert!(
            sign_out_impl(&state, &env.path, id)
                .await
                .unwrap()
                .ended_on_server
        );
    }

    #[tokio::test]
    async fn renaming_keeps_the_session_but_changing_identity_ends_it() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();

        let renamed = ServerAccountInput {
            name: "Acme prod".to_string(),
            ..form(&env)
        };
        let view = account_save_impl(&state, &env.path, renamed).await.unwrap();
        assert!(view.signed_in);
        assert_eq!(view.name, "Acme prod");
        list_connections_impl(&state, &env.path, id).await.unwrap();

        let other_user = ServerAccountInput {
            email: "dba@acme.test".to_string(),
            ..form(&env)
        };
        let view = account_save_impl(&state, &env.path, other_user)
            .await
            .unwrap();
        assert!(!view.signed_in);
        env.fake.with(|s| {
            assert_eq!(s.logouts, 1);
            assert_eq!(s.live_families(), 0);
        });
        assert!(list_connections_impl(&state, &env.path, id).await.is_err());
    }

    #[tokio::test]
    async fn deleting_a_signed_in_account_ends_its_session() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();

        account_delete_impl(&state, &env.path, id).await.unwrap();
        assert!(account_list_impl(&state, &env.path).unwrap().is_empty());
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
        // Deleting what is already gone is fine.
        account_delete_impl(&state, &env.path, id).await.unwrap();
    }

    #[tokio::test]
    async fn a_new_account_is_saved_signed_out() {
        let env = Env::new().await;
        let state = unlocked();
        let fresh = ServerAccountInput {
            id: None,
            name: "Second".to_string(),
            ..form(&env)
        };
        let view = account_save_impl(&state, &env.path, fresh).await.unwrap();
        assert!(!view.signed_in);
        assert_ne!(view.id, env.account.id);
        assert_eq!(account_list_impl(&state, &env.path).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_vault_reset_ends_stored_sessions_first() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();

        sign_out_all_best_effort(&state, &env.path).await;
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
        assert!(!account_list_impl(&state, &env.path).unwrap()[0].signed_in);

        // Locked, there is nothing it can read; it still drops live sessions.
        let locked = AppState::new();
        sign_out_all_best_effort(&locked, &env.path).await;
    }
}
