//! Command bodies for MQLens Server accounts and sessions.
//!
//! Each takes the accounts file path explicitly, like the other `_impl`s, so
//! tests run against a temporary file with no `AppHandle`.

use crate::server::accounts::{self, ServerAccount, ServerAccountInput, ServerAccountView};
use crate::server::channel::client;
use crate::server::key_source;
use crate::server::pb::mqlens::v1::capability_service_client::CapabilityServiceClient;
use crate::server::pb::mqlens::v1::connection_service_client::ConnectionServiceClient;
use crate::server::pb::mqlens::v1::metadata_service_client::MetadataServiceClient;
use crate::server::pb::mqlens::v1::{
    GetCapabilitiesRequest, ListConnectionsRequest, MongoVersionRequest,
};
use crate::server::remote::RemoteConn;
use crate::server::session::{self, blocking, AccountSession, FileTokenStore, TokenStore};
use crate::state::LockExt;
use crate::AppState;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

/// How long a vault reset waits for its sessions to end on their servers.
const RESET_SIGN_OUT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountDeleteResult {
    pub deleted: bool,
    pub session_revoked: Option<bool>,
}

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

pub(crate) fn token_store(state: &AppState, path: &Path) -> Arc<dyn TokenStore> {
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
    let file = path.to_path_buf();
    let current = key_source(state.vault_key.clone());
    let (saved, previous) =
        blocking(move || accounts::save_account_while(&file, &key, Some(&current), input)).await?;
    // An edit to another server or user drops the stored session (see
    // `save_account`). Ended now with the token the save actually replaced,
    // including one a concurrent sign-in stored a moment before.
    let mut warning = None;
    if saved.refresh_token.is_none() {
        state.server.remove(&saved.id).await;
        if let Some(previous) = previous {
            if let Some(token) = previous.refresh_token.as_deref() {
                if !session::revoke(&previous, token).await {
                    warning = Some(
                        "The previous server session could not be revoked and may still be active."
                            .to_string(),
                    );
                }
            }
        }
    }
    let mut view = saved.view();
    view.warning = warning;
    Ok(view)
}

pub(crate) async fn account_delete_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
) -> Result<AccountDeleteResult, String> {
    let key = state.require_key()?;
    // Removed first, under the file lock, so the session ended below is exactly
    // the one stored at that moment, including one a sign-in stored just before.
    // A sign-in storing later finds the account gone and ends its own session.
    let file = path.to_path_buf();
    let id = account_id.to_string();
    let current = key_source(state.vault_key.clone());
    let removed =
        blocking(move || accounts::delete_account_while(&file, &key, Some(&current), &id)).await?;
    state.server.remove(account_id).await;
    let mut session_revoked = None;
    if let Some(account) = &removed {
        if let Some(token) = account.refresh_token.as_deref() {
            session_revoked = Some(session::revoke(account, token).await);
        }
    }
    Ok(AccountDeleteResult { deleted: removed.is_some(), session_revoked })
}

pub(crate) async fn sign_in_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
    password: String,
) -> Result<ServerAccountView, String> {
    // Serialize the whole login-and-store operation with vault_lock and reset.
    // Otherwise either can clear the key after the token store reads it but
    // before the encrypted token is written or this command checks the key.
    let meta_path = accounts::vault_meta_path(path);
    let _vault_lock =
        blocking(move || crate::connections::lock_vault_for_write(&meta_path)).await?;
    let password = Zeroizing::new(password);
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    // A session already stored stays until the new one replaces it, so a
    // mistyped password or a failed login leaves the user signed in.
    // `AccountSession::sign_in` ends the session it displaces on the server.
    let session = AccountSession::sign_in_with_vault_operation_lock_held(
        &account,
        &password,
        token_store(state, path),
    )
    .await?;
    state.server.insert(session.clone()).await;
    // The vault may have locked while the server answered; a session must not
    // be left behind for a locked vault.
    if state.require_key().is_err() {
        state.server.remove(account_id).await;
        return Err("vault is locked".to_string());
    }
    // Checked once the session is in the runtime, where a later sign-out or
    // delete finds it: one that came first, while this sign-in was still
    // ending the session it displaced, already ended this one.
    let stored_token_is_ours = session
        .stored_token_is_ours_with_vault_operation_lock_held()
        .await;
    match stored_token_is_ours {
        Some(true) => {}
        // A concurrent sign-in stored its own and ended this one. The account
        // is signed in with that session, resumed from the store on next use.
        Some(false) => {
            state.server.remove(account_id).await;
        }
        None => {
            state.server.remove(account_id).await;
            return Err(
                "This MQLens Server account was signed out, deleted or changed while signing in."
                    .to_string(),
            );
        }
    }
    let mut view = account.view();
    view.signed_in = true;
    view.warning = session.displaced_session_warning().map(str::to_string);
    Ok(view)
}

pub(crate) async fn sign_out_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
) -> Result<SignOutResult, String> {
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    let session = current_session(state, path, &account).await?;
    let ended_on_server = session.sign_out().await?;
    Ok(SignOutResult { ended_on_server })
}

/// A remote connection the desktop connected to, under its new desktop id.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerConnectResult {
    pub id: String,
    pub mongo_version: String,
    pub op_classes: Vec<String>,
}

/// Connects to one of the account's server connections: asks the server what
/// the user may do there, pings the deployment through it, and registers the
/// connection under a new desktop id. No driver client is made, and no
/// connection string reaches the desktop.
pub(crate) async fn server_connect_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
    remote_id: &str,
) -> Result<ServerConnectResult, String> {
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    let session = state
        .server
        .session(&account, token_store(state, path))
        .await?;
    let capabilities = session
        .call(
            GetCapabilitiesRequest {
                connection_ids: vec![remote_id.to_string()],
            },
            |channel, request| async move {
                client!(CapabilityServiceClient, channel)
                    .get_capabilities(request)
                    .await
            },
        )
        .await?;
    // Empty for a connection the user cannot reach, whether or not it exists.
    let op_classes = capabilities
        .connections
        .into_iter()
        .find(|c| c.connection_id == remote_id)
        .map(|c| c.op_classes)
        .unwrap_or_default();
    if op_classes.is_empty() {
        return Err(format!(
            "This connection is not available to you on the MQLens Server account \"{}\"",
            account.name
        ));
    }
    let api_version = crate::server::remote::negotiate(
        capabilities.min_api_version,
        capabilities.max_api_version,
    )?;
    session.speak(api_version);
    let version = session
        .call(
            MongoVersionRequest {
                connection_id: remote_id.to_string(),
            },
            |channel, request| async move {
                client!(MetadataServiceClient, channel)
                    .mongo_version(request)
                    .await
            },
        )
        .await?;

    let id = uuid::Uuid::new_v4().to_string();
    state.mocks.lock_safe()?.insert(id.clone(), false);
    state.server.add_remote(RemoteConn {
        desktop_id: id.clone(),
        account_id: account.id.clone(),
        identity: ServerAccount {
            refresh_token: None,
            ..account.clone()
        },
        accounts_path: path.to_path_buf(),
        account_name: account.name.clone(),
        server_url: account.url.clone(),
        remote_id: remote_id.to_string(),
        op_classes: op_classes.clone(),
        api_version,
    })?;
    Ok(ServerConnectResult {
        id,
        mongo_version: version.version,
        op_classes,
    })
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

/// The MQLens Server part of a vault reset: removes the accounts file and then
/// vault.json under the accounts lock, and hands back the stored sessions still
/// to be ended on their servers. Sessions are dropped here regardless. `key` is
/// the vault key being discarded, taken by the caller before anything waits,
/// or `None` when the vault is locked and the tokens cannot be read. A locked
/// reset is rejected while the accounts file exists, because deleting it
/// would discard the only credentials that can revoke those sessions. The
/// forgotten-password recovery path may explicitly opt into that loss after
/// warning the user.
/// `other_files` are the vault's other files, removed first under the same
/// lock.
pub(crate) async fn reset_accounts(
    state: &AppState,
    path: &Path,
    key: Option<[u8; 32]>,
    other_files: Vec<std::path::PathBuf>,
) -> Result<PendingSignOuts, String> {
    reset_accounts_with_policy(state, path, key, other_files, false).await
}

pub(crate) async fn reset_accounts_with_policy(
    state: &AppState,
    path: &Path,
    key: Option<[u8; 32]>,
    other_files: Vec<std::path::PathBuf>,
    allow_unrevoked_server_sessions: bool,
) -> Result<PendingSignOuts, String> {
    reset_accounts_within(
        state,
        path,
        key,
        other_files,
        allow_unrevoked_server_sessions,
        RESET_SIGN_OUT_TIMEOUT,
    )
    .await
}

/// Sessions a vault reset took out of the accounts file and has yet to end on
/// their servers. The reset finishes them once its other files are gone:
/// their tokens exist nowhere else, so a task left running in the background
/// would be cancelled with the app and leave those sessions live.
#[must_use = "a reset must finish ending the sessions it took"]
pub(crate) struct PendingSignOuts {
    taken: Vec<(ServerAccount, String)>,
    limit: Duration,
    /// Why removing the vault metadata failed after the accounts file was
    /// gone. Revocations are attempted regardless: their tokens exist nowhere
    /// else.
    failed: Option<String>,
}

impl PendingSignOuts {
    /// Ends every session, each within its own time limit and all at once, so
    /// one unreachable server cannot use up the time every other one needed.
    /// An unreachable server cannot hold up a reset, but failed revocations
    /// are reported because their tokens were already removed from the vault.
    pub(crate) async fn finish(self) -> Result<Option<String>, String> {
        let limit = self.limit;
        let revokes = self
            .taken
            .iter()
            .map(|(account, token)| tokio::time::timeout(limit, session::revoke(account, token)));
        let unconfirmed = futures::future::join_all(revokes)
            .await
            .into_iter()
            .filter(|result| !matches!(result, Ok(true)))
            .count();

        let revocation_warning = (unconfirmed > 0).then(|| {
            let sessions = if unconfirmed == 1 {
                "session"
            } else {
                "sessions"
            };
            format!(
                "Could not confirm revocation of {unconfirmed} MQLens Server {sessions}; they may still be active."
            )
        });
        if let Some(failed) = self.failed {
            let mut failures = vec![failed];
            if let Some(warning) = revocation_warning {
                failures.push(warning);
            }
            Err(failures.join(" "))
        } else if let Some(warning) = revocation_warning {
            Ok(Some(format!("Vault reset completed, but {warning}")))
        } else {
            Ok(None)
        }
    }
}

const RESET_KEY_CHANGED: &str =
    "The vault password was changed while the vault was being reset. Nothing was removed; reset again.";

/// Each account gets `limit` of its own when the sign-outs are finished.
async fn reset_accounts_within(
    state: &AppState,
    path: &Path,
    key: Option<[u8; 32]>,
    other_files: Vec<std::path::PathBuf>,
    allow_unrevoked_server_sessions: bool,
    limit: Duration,
) -> Result<PendingSignOuts, String> {
    state.server.clear().await;
    // One locked step checks the key, takes every stored token and removes the
    // vault's other files, the accounts file and then the vault metadata, last,
    // so a failure part way leaves a vault that still opens. A password change
    // holds this lock through its rotation, in any MQLens process, so it runs
    // wholly before or after. After it, nothing can present one of these tokens
    // again while it is revoked (which would trip the server's reuse check),
    // a sign-in still in flight finds its account gone and ends its own
    // session, and a write from any process sees the vault gone and is refused.
    // No lock is held across the network calls below.
    let file = path.to_path_buf();
    let (taken, failed) = blocking(move || {
        let _lock = accounts::lock(&file)?;
        if key.is_none() && file.exists() && !allow_unrevoked_server_sessions {
            return Err("Unlock the vault before resetting its MQLens Server accounts.".to_string());
        }
        // The key was captured before this lock was free. A password change
        // meanwhile, here or in another MQLens process, rotated the vault to
        // another key: going on would read no tokens and delete a vault this
        // reset never saw. An unreadable vault.json is left to the load below.
        if let Some(key) = &key {
            let meta = crate::connections::read_vault_meta(&accounts::vault_meta_path(&file));
            if meta
                .ok()
                .flatten()
                .is_some_and(|meta| !crate::connections::key_matches_meta(&meta, key))
            {
                return Err(RESET_KEY_CHANGED.to_string());
            }
        }
        let taken: Vec<(ServerAccount, String)> = match key {
            Some(key) => accounts::load(&file, &key)?,
            None => Vec::new(),
        }
        .into_iter()
        .filter_map(|a| a.refresh_token.clone().map(|token| (a, token)))
        .collect();
        let remove = |p: &Path| match p.exists() {
            true => std::fs::remove_file(p).map_err(|e| format!("remove {}: {e}", p.display())),
            false => Ok(()),
        };
        // Still in the file, the tokens need no ending: the reset failed and
        // the vault still opens.
        for p in &other_files {
            remove(p)?;
        }
        remove(&file)?;
        Ok((taken, remove(&accounts::vault_meta_path(&file)).err()))
    })
    .await?;
    // Not ended here: waiting on servers now would leave the vault half
    // removed, vault.json gone and its other files still there, for as long as
    // the slowest server, and another window could set up a new vault in that
    // gap only to lose it to the rest of the reset.
    Ok(PendingSignOuts {
        taken,
        limit,
        failed,
    })
}

/// The session to end for `account` as it is stored now, taken out of the
/// runtime. A cached session for an identity the account no longer has is
/// dropped: signing it out would find no token of its own and end nothing.
async fn current_session(
    state: &AppState,
    path: &Path,
    account: &ServerAccount,
) -> Result<Arc<AccountSession>, String> {
    match state.server.remove(&account.id).await {
        Some(session) if session.serves(account) => Ok(session),
        _ => AccountSession::resume(account, token_store(state, path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::fake::{file_store, write_vault_meta, Env, EMAIL, KEY, PASSWORD, TENANT};

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
    async fn signing_in_again_reports_when_the_previous_session_cannot_be_revoked() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake.with(|s| s.refresh_failures.push(tonic::Code::Unavailable));

        let view = sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();

        assert!(view.signed_in);
        assert!(view
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("previous server session")));
        env.fake.with(|s| assert_eq!(s.live_families(), 2));
    }

    // A mistyped password, or a login that fails, must not cost the user the
    // session they already have: it is replaced only once a new one exists.
    #[tokio::test]
    async fn a_failed_sign_in_keeps_the_current_session() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        sign_in_impl(&state, &env.path, id, "nope".to_string())
            .await
            .unwrap_err();
        assert!(account_list_impl(&state, &env.path).unwrap()[0].signed_in);
        env.fake.with(|s| assert_eq!(s.live_families(), 1));
        list_connections_impl(&state, &env.path, id).await.unwrap();
    }

    // Another window deletes the account while this sign-in is still ending
    // the session it displaced. The delete ended the new session too, so the
    // sign-in must not then report the account signed in.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_sign_in_overtaken_by_a_delete_does_not_report_success() {
        let env = Env::new().await;
        let state = Arc::new(unlocked());
        let id = env.account.id.clone();
        sign_in_impl(&state, &env.path, &id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake
            .with(|s| s.logout_delay = Duration::from_millis(400));
        let signing_in = {
            let state = state.clone();
            let path = env.path.clone();
            let id = id.clone();
            tokio::spawn(
                async move { sign_in_impl(&state, &path, &id, PASSWORD.to_string()).await },
            )
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        let deleting = {
            let state = state.clone();
            let path = env.path.clone();
            let id = id.clone();
            tokio::spawn(async move { account_delete_impl(&state, &path, &id).await })
        };

        let result = signing_in.await.unwrap();
        deleting.await.unwrap().unwrap();
        assert!(
            result.is_err(),
            "reported signed in to a deleted account: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn vault_lock_waits_for_a_sign_in_to_finish_storing_its_token() {
        let env = Env::new().await;
        let state = Arc::new(unlocked());
        env.fake
            .with(|s| s.login_delay = Duration::from_millis(300));
        let signing_in = {
            let state = state.clone();
            let path = env.path.clone();
            let id = env.account.id.clone();
            tokio::spawn(async move {
                sign_in_impl(&state, &path, &id, PASSWORD.to_string()).await
            })
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            while env.fake.with(|s| s.login_starts == 0) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("sign-in did not reach the server");

        let lock_acquired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let waiting_for_lock = {
            let path = accounts::vault_meta_path(&env.path);
            let lock_acquired = lock_acquired.clone();
            tokio::spawn(async move {
                let lock = blocking(move || crate::connections::lock_vault_for_write(&path))
                    .await
                    .unwrap();
                lock_acquired.store(true, std::sync::atomic::Ordering::SeqCst);
                lock
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !lock_acquired.load(std::sync::atomic::Ordering::SeqCst),
            "vault lock passed a sign-in that had not committed yet"
        );

        let view = signing_in.await.unwrap().unwrap();
        assert!(view.signed_in);
        let vault_lock = waiting_for_lock.await.unwrap();
        *state.vault_key.lock().unwrap() = None;
        state.server.clear().await;
        drop(vault_lock);

        assert!(env.stored_token().is_some());
        env.fake.with(|s| assert_eq!(s.live_families(), 1));
    }

    async fn signed_in_state(env: &Env) -> AppState {
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();
        state
    }

    // A server connection becomes a desktop connection: a new id, with what
    // the user may do there, routed to the server and never given a driver
    // client.
    #[tokio::test]
    async fn connecting_registers_a_remote_connection() {
        let env = Env::new().await;
        let state = signed_in_state(&env).await;

        let connected = server_connect_impl(&state, &env.path, &env.account.id, "c1")
            .await
            .unwrap();

        assert_eq!(connected.mongo_version, "8.0.4");
        assert_eq!(connected.op_classes, ["read", "write"]);
        assert_ne!(connected.id, "c1", "the desktop id is its own");
        match crate::server::remote::route(&state, &connected.id).unwrap() {
            crate::server::remote::Route::Remote(conn) => {
                assert_eq!(conn.remote_id, "c1");
                assert_eq!(conn.account_id, env.account.id);
                assert_eq!(conn.api_version, crate::server::remote::API_VERSIONS.1);
            }
            crate::server::remote::Route::Local(_) => panic!("routed to a driver client"),
        }
        assert_eq!(crate::connection_is_mock(&state, &connected.id), Ok(false));
        assert!(crate::require_real_client(&state, &connected.id).is_err());
    }

    // A server that speaks no API version this desktop does is not connected,
    // and the user is told which side to update.
    #[tokio::test]
    async fn a_server_with_no_api_version_in_common_is_not_connected() {
        let env = Env::new().await;
        let state = signed_in_state(&env).await;
        env.fake.with(|s| s.max_api_version = 1);

        let err = server_connect_impl(&state, &env.path, &env.account.id, "c1")
            .await
            .unwrap_err();

        assert!(err.contains("Update MQLens Server"), "{err}");
        assert!(
            state.mocks.lock().unwrap().is_empty(),
            "something was registered"
        );
    }

    // Once connected, every request speaks the agreed version, the ping
    // included, as the server checks it on each one.
    #[tokio::test]
    async fn every_request_on_a_connection_speaks_its_api_version() {
        let env = Env::new().await;
        let state = signed_in_state(&env).await;
        let connected = server_connect_impl(&state, &env.path, &env.account.id, "c1")
            .await
            .unwrap();
        let ping = env
            .fake
            .with(|s| s.api_versions_seen.borrow().last().copied());
        assert_eq!(ping, Some(2), "the ping");
        env.fake.with(|s| s.api_versions_seen.borrow_mut().clear());

        crate::db::metadata::list_databases_impl(&state, &connected.id)
            .await
            .unwrap();

        let seen = env.fake.with(|s| s.api_versions_seen.borrow().clone());
        assert!(!seen.is_empty() && seen.iter().all(|v| *v == 2), "{seen:?}");
    }

    // The server reports no op classes for a connection the user cannot
    // reach, whether or not it exists.
    #[tokio::test]
    async fn a_connection_the_user_cannot_reach_is_not_connected() {
        let env = Env::new().await;
        let state = signed_in_state(&env).await;

        let err = server_connect_impl(&state, &env.path, &env.account.id, "c9")
            .await
            .unwrap_err();

        assert!(err.contains("not available to you"), "{err}");
        assert!(
            state.mocks.lock().unwrap().is_empty(),
            "something was registered"
        );
    }

    #[tokio::test]
    async fn a_deployment_the_server_cannot_reach_is_not_connected() {
        let env = Env::new().await;
        let state = signed_in_state(&env).await;
        env.fake
            .with(|s| s.version_failure = Some(tonic::Code::Unavailable));

        let err = server_connect_impl(&state, &env.path, &env.account.id, "c1")
            .await
            .unwrap_err();

        assert!(err.contains("unavailable"), "{err}");
        assert!(
            state.mocks.lock().unwrap().is_empty(),
            "something was registered"
        );
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

        let result = account_delete_impl(&state, &env.path, id).await.unwrap();
        assert!(result.deleted);
        assert_eq!(result.session_revoked, Some(true));
        assert!(account_list_impl(&state, &env.path).unwrap().is_empty());
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
        // Deleting what is already gone is fine.
        assert!(!account_delete_impl(&state, &env.path, id)
            .await
            .unwrap()
            .deleted);
    }

    #[tokio::test]
    async fn deleting_an_account_reports_when_its_session_cannot_be_revoked() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake.with(|s| s.refresh_failures.push(tonic::Code::Unavailable));

        let result = account_delete_impl(&state, &env.path, &env.account.id)
            .await
            .unwrap();

        assert!(result.deleted);
        assert_eq!(result.session_revoked, Some(false));
        assert!(account_list_impl(&state, &env.path).unwrap().is_empty());
        env.fake.with(|s| assert_eq!(s.live_families(), 1));
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

    // Another instance repointed the account (here, the same server reached by
    // another name) and signed in again, while this one still caches the old
    // session. Signing out here must end the sign-in that is current.
    #[tokio::test]
    async fn signing_out_ends_the_current_session_not_a_stale_cached_one() {
        let env = Env::new().await;
        let here = unlocked();
        let elsewhere = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&here, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();

        let moved = ServerAccountInput {
            url: env.account.url.replace("127.0.0.1", "localhost"),
            ..form(&env)
        };
        account_save_impl(&elsewhere, &env.path, moved)
            .await
            .unwrap();
        sign_in_impl(&elsewhere, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake.with(|s| assert_eq!(s.live_families(), 1));

        let result = sign_out_impl(&here, &env.path, id).await.unwrap();
        assert!(result.ended_on_server);
        assert!(!account_list_impl(&here, &env.path).unwrap()[0].signed_in);
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the current sign-in is still live on the server"
            )
        });
    }

    // A sign-in can store its session after a delete has started. The delete
    // must end whatever session the account holds when it is removed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deleting_ends_a_session_stored_while_the_delete_waited() {
        let env = Env::new().await;
        let state = Arc::new(unlocked());

        // A live session for this account, obtained through a separate store.
        let other = tempfile::tempdir().unwrap();
        let other_path = other.path().join(accounts::ACCOUNTS_FILE_NAME);
        std::fs::copy(&env.path, &other_path).unwrap();
        if let Err(e) =
            AccountSession::sign_in(&env.account, PASSWORD, file_store(&other_path)).await
        {
            panic!("sign in failed: {e}");
        }
        let token = accounts::find(&other_path, &KEY, &env.account.id)
            .unwrap()
            .refresh_token
            .unwrap();

        // The delete has to wait for the accounts lock...
        let held = accounts::lock(&env.path).unwrap();
        let deleting = {
            let state = state.clone();
            let path = env.path.clone();
            let id = env.account.id.clone();
            tokio::spawn(async move { account_delete_impl(&state, &path, &id).await })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        // ...while the session is stored under it, as a sign-in finishing then does.
        let mut all = accounts::load(&env.path, &KEY).unwrap();
        all[0].refresh_token = Some(token);
        accounts::save(&env.path, &KEY, &all).unwrap();
        drop(held);

        deleting.await.unwrap().unwrap();
        assert!(account_list_impl(&state, &env.path).unwrap().is_empty());
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the deleted account's session is still live on the server"
            )
        });
    }

    // An edit waiting on the accounts lock can be overtaken by a vault reset in
    // another window, and a new vault set up under another key. It must not then
    // write the accounts file under the key the reset discarded.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_edit_that_outlives_a_vault_reset_writes_nothing() {
        let env = Env::new().await;
        let state = Arc::new(unlocked());

        let held = accounts::lock(&env.path).unwrap();
        let editing = {
            let state = state.clone();
            let path = env.path.clone();
            let renamed = ServerAccountInput {
                name: "Renamed".to_string(),
                ..form(&env)
            };
            tokio::spawn(async move { account_save_impl(&state, &path, renamed).await })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        // The reset, under the lock, and a new vault with another key.
        std::fs::remove_file(accounts::vault_meta_path(&env.path)).unwrap();
        std::fs::remove_file(&env.path).unwrap();
        *state.vault_key.lock().unwrap() = Some([9; 32]);
        write_vault_meta(&env.path, &[9; 32]);
        drop(held);

        let result = editing.await.unwrap();
        assert!(result.is_err(), "the edit went through: {result:?}");
        assert!(
            !env.path.exists(),
            "the edit recreated the accounts file under the discarded key"
        );
    }

    // Two windows signing in to the same signed-out account at once each get a
    // server session; only one can be stored, and the other must be ended.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_first_sign_ins_leave_one_live_session() {
        let env = Env::new().await;
        let a = Arc::new(unlocked());
        let b = Arc::new(unlocked());
        env.fake
            .with(|s| s.login_delay = Duration::from_millis(200));
        let sign_in = |state: Arc<AppState>| {
            let path = env.path.clone();
            let id = env.account.id.clone();
            tokio::spawn(
                async move { sign_in_impl(&state, &path, &id, PASSWORD.to_string()).await },
            )
        };
        let (x, y) = (sign_in(a.clone()), sign_in(b.clone()));
        x.await.unwrap().unwrap();
        y.await.unwrap().unwrap();

        env.fake.with(|s| {
            assert_eq!(s.logins, 2);
            assert_eq!(
                s.live_families(),
                1,
                "a displaced sign-in is still live on the server"
            );
        });
        // Both windows go on working with the session that is stored.
        list_connections_impl(&a, &env.path, &env.account.id)
            .await
            .unwrap();
        list_connections_impl(&b, &env.path, &env.account.id)
            .await
            .unwrap();
    }

    // One unreachable server must not use up the reset's time for everyone:
    // every other account's session still gets ended before its token is gone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reset_reaches_every_account_even_if_one_server_hangs() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();

        // A server that accepts connections and never answers.
        let hung = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hung_url = format!("http://{}", hung.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = hung.accept().await {
                held.push(socket);
            }
        });
        // Listed first, so it would be first in line for the accounts lock.
        accounts::update(&env.path, &KEY, |all| {
            let mut stuck = ServerAccountInput {
                id: None,
                name: "Hung".to_string(),
                url: hung_url,
                tenant: TENANT.to_string(),
                email: EMAIL.to_string(),
                allow_insecure_http: false,
                extra_ca_pem: None,
            }
            .into_account()?;
            stuck.refresh_token = Some("refresh-for-the-hung-server".to_string());
            all.insert(0, stuck);
            Ok(())
        })
        .unwrap();

        let started = std::time::Instant::now();
        let warning = reset_accounts_within(
            &state,
            &env.path,
            Some(KEY),
            Vec::new(),
            false,
            Duration::from_millis(500),
        )
        .await
        .unwrap()
        .finish()
        .await
        .unwrap()
        .expect("the timed out revocation must be reported");
        assert!(warning.contains("1 MQLens Server session"), "{warning}");
        assert!(warning.contains("may still be active"), "{warning}");
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the reachable server's session was never ended"
            )
        });
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    // Another MQLens process reset the vault while this one still holds the old
    // key. Writing the accounts file with that key would leave the new vault a
    // file it cannot read.
    #[tokio::test]
    async fn account_writes_are_refused_once_another_process_reset_the_vault() {
        let env = Env::new().await;
        let state = unlocked();
        let fresh = ServerAccountInput {
            id: None,
            name: "Second".to_string(),
            ..form(&env)
        };
        std::fs::remove_file(env.path.with_file_name("vault.json")).unwrap();
        std::fs::remove_file(&env.path).unwrap();

        let err = account_save_impl(&state, &env.path, fresh.clone())
            .await
            .unwrap_err();
        assert!(err.contains("locked or reset"), "{err}");
        assert!(account_delete_impl(&state, &env.path, &env.account.id)
            .await
            .is_err());
        assert!(
            !env.path.exists(),
            "a write recreated the accounts file under the discarded key"
        );

        // The other process then set up a new vault, under another key.
        write_vault_meta(&env.path, &[9; 32]);
        assert!(account_save_impl(&state, &env.path, fresh).await.is_err());
        assert!(!env.path.exists());
    }

    // A sign-in can land while a reset is revoking the stored sessions. It must
    // not leave a session the reset never saw, live on the server.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_sign_in_landing_during_a_reset_leaves_no_live_session() {
        let env = Env::new().await;
        let state = Arc::new(unlocked());
        env.fake
            .with(|s| s.login_delay = Duration::from_millis(300));
        let signing_in = {
            let state = state.clone();
            let path = env.path.clone();
            let id = env.account.id.clone();
            tokio::spawn(
                async move { sign_in_impl(&state, &path, &id, PASSWORD.to_string()).await },
            )
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        reset_accounts_within(
            &state,
            &env.path,
            Some(KEY),
            Vec::new(),
            false,
            Duration::from_millis(500),
        )
        .await
        .unwrap()
        .finish()
        .await
        .unwrap();

        let result = signing_in.await.unwrap();
        assert!(
            result.is_err(),
            "the sign-in went through during the reset: {result:?}"
        );
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the sign-in left a session the reset never ended"
            )
        });
    }

    // An edit to another identity drops the stored session. When a sign-in
    // stored one just before the edit's write, that is the session to end.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_identity_edit_ends_a_session_stored_while_it_waited() {
        let env = Env::new().await;
        let state = Arc::new(unlocked());

        let other = tempfile::tempdir().unwrap();
        let other_path = other.path().join(accounts::ACCOUNTS_FILE_NAME);
        std::fs::copy(&env.path, &other_path).unwrap();
        if let Err(e) =
            AccountSession::sign_in(&env.account, PASSWORD, file_store(&other_path)).await
        {
            panic!("sign in failed: {e}");
        }
        let token = accounts::find(&other_path, &KEY, &env.account.id)
            .unwrap()
            .refresh_token
            .unwrap();

        let held = accounts::lock(&env.path).unwrap();
        let editing = {
            let state = state.clone();
            let path = env.path.clone();
            let moved = ServerAccountInput {
                email: "dba@acme.test".to_string(),
                ..form(&env)
            };
            tokio::spawn(async move { account_save_impl(&state, &path, moved).await })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut all = accounts::load(&env.path, &KEY).unwrap();
        all[0].refresh_token = Some(token);
        accounts::save(&env.path, &KEY, &all).unwrap();
        drop(held);

        let view = editing.await.unwrap().unwrap();
        assert!(!view.signed_in);
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the session the edit displaced is still live on the server"
            )
        });
    }

    // The reset step removes vault.json. If it then waited on servers, the vault
    // would look uninitialized for that long while its other files were still
    // there, and another window could set up a new vault in the gap only for
    // the rest of the reset to delete it. The step must hand the revocations
    // back and return at once; finishing them still reaches every server.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_reset_step_returns_without_waiting_on_servers() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();
        let hung = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hung_url = format!("http://{}", hung.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = hung.accept().await {
                held.push(socket);
            }
        });
        accounts::update(&env.path, &KEY, |all| {
            let mut stuck = ServerAccountInput {
                id: None,
                name: "Hung".to_string(),
                url: hung_url,
                tenant: TENANT.to_string(),
                email: EMAIL.to_string(),
                allow_insecure_http: false,
                extra_ca_pem: None,
            }
            .into_account()?;
            stuck.refresh_token = Some("refresh-for-the-hung-server".to_string());
            all.insert(0, stuck);
            Ok(())
        })
        .unwrap();

        let started = std::time::Instant::now();
        let pending = reset_accounts_within(
            &state,
            &env.path,
            Some(KEY),
            Vec::new(),
            false,
            Duration::from_secs(3),
        )
        .await
        .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the reset step waited {:?} on servers",
            started.elapsed()
        );
        assert!(!env.path.exists());
        pending.finish().await.unwrap();
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
    }

    // The reset hands the sign-outs back instead of leaving them to a
    // background task, which closing the app right after would cancel with the
    // tokens already deleted. Once finished, every reachable session is over.
    #[tokio::test]
    async fn a_reset_ends_every_session_before_it_finishes() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake
            .with(|s| s.logout_delay = Duration::from_millis(300));

        let pending = reset_accounts(&state, &env.path, Some(KEY), Vec::new())
            .await
            .unwrap();
        assert!(!env.path.exists());
        pending.finish().await.unwrap();
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the reset finished with a session still live"
            )
        });
    }

    #[tokio::test]
    async fn a_reset_reports_when_a_server_cannot_confirm_revocation() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake
            .with(|s| s.refresh_failures.push(tonic::Code::Unavailable));

        let pending = reset_accounts(&state, &env.path, Some(KEY), Vec::new())
            .await
            .unwrap();
        let warning = pending
            .finish()
            .await
            .unwrap()
            .expect("the failed revocation must be reported");

        assert!(warning.contains("1 MQLens Server session"), "{warning}");
        assert!(warning.contains("may still be active"), "{warning}");
        assert!(!env.path.exists());
        env.fake.with(|s| assert_eq!(s.live_families(), 1));
    }

    // vault.json is what makes the other files a vault, so it goes last: a
    // reset that fails part way leaves a vault that still opens.
    #[tokio::test]
    async fn a_reset_that_cannot_remove_the_accounts_keeps_the_vault() {
        let env = Env::new().await;
        let state = unlocked();
        std::fs::remove_file(&env.path).unwrap();
        std::fs::create_dir(&env.path).unwrap();

        assert!(reset_accounts(&state, &env.path, Some(KEY), Vec::new())
            .await
            .is_err());
        assert!(
            accounts::vault_meta_path(&env.path).exists(),
            "vault.json went before the accounts file"
        );
    }

    // A password change, here or in another process, can rotate the vault
    // while the reset waits for the accounts lock. The key the reset captured
    // then reads nothing, and it must not take that for "no sessions" and
    // delete the rotated vault.
    #[tokio::test]
    async fn a_reset_with_a_key_the_vault_no_longer_uses_changes_nothing() {
        let env = Env::new().await;
        let state = unlocked();
        let rotated = [9; 32];
        std::fs::remove_file(&env.path).unwrap();
        accounts::update(&env.path, &rotated, |all| {
            all.push(env.account.clone());
            Ok(())
        })
        .unwrap();
        write_vault_meta(&env.path, &rotated);

        let result = reset_accounts(&state, &env.path, Some(KEY), Vec::new()).await;
        assert!(result.is_err(), "the reset went ahead with a stale key");
        assert!(env.path.exists(), "the rotated accounts file was deleted");
        assert!(accounts::vault_meta_path(&env.path).exists());
    }

    #[tokio::test]
    async fn a_vault_reset_ends_stored_sessions_first() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();

        reset_accounts(&state, &env.path, Some(KEY), Vec::new())
            .await
            .unwrap()
            .finish()
            .await
            .unwrap();
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
        assert!(!env.path.exists());
        assert!(!accounts::vault_meta_path(&env.path).exists());

        // Locked, there is no key to read tokens with; the files still go.
        let locked = AppState::new();
        write_vault_meta(&env.path, &KEY);
        reset_accounts(&locked, &env.path, None, Vec::new())
            .await
            .unwrap()
            .finish()
            .await
            .unwrap();
        assert!(!accounts::vault_meta_path(&env.path).exists());
    }

    #[tokio::test]
    async fn a_locked_vault_reset_keeps_server_tokens_until_they_can_be_revoked() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();
        *state.vault_key.lock().unwrap() = None;

        let error = reset_accounts(&state, &env.path, None, Vec::new())
            .await
            .err()
            .expect("a locked reset must not delete unrecoverable refresh tokens");
        assert!(error.contains("Unlock the vault"), "unexpected error: {error}");
        assert!(env.path.exists(), "the accounts file was deleted while locked");
        env.fake.with(|s| assert_eq!(s.live_families(), 1));

        let pending = reset_accounts(&state, &env.path, Some(KEY), Vec::new())
            .await
            .unwrap();
        pending.finish().await.unwrap();
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
    }
}
