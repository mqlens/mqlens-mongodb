//! The MQLens Server accounts a user has added.
//!
//! Stored in `server_accounts.json.enc` beside the connection profiles, and
//! encrypted under the vault key like them. An account's refresh token is kept
//! here and nowhere else: it is the one long-lived secret server mode holds, so
//! a session reads it from this file each time it is needed (see `session`),
//! and `ServerAccountView`, the only shape the webview receives, leaves it out.
//! The account password is used once to sign in and never stored.

use crate::server::channel;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// File name of the accounts store in the app config directory.
pub(crate) const ACCOUNTS_FILE_NAME: &str = "server_accounts.json.enc";

/// How an account signs in. Password sign-in is the only method until the
/// server offers OIDC to desktop clients.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthMethod {
    #[default]
    Password,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerAccount {
    pub id: String,
    pub name: String,
    /// Normalized by `channel::normalize_url`.
    pub url: String,
    pub tenant: String,
    pub email: String,
    #[serde(default)]
    pub auth: AuthMethod,
    #[serde(default)]
    pub allow_insecure_http: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_ca_pem: Option<String>,
    /// The stored session, while signed in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

// Written by hand so a logged or panicking account never prints its token.
impl std::fmt::Debug for ServerAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerAccount")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("url", &self.url)
            .field("tenant", &self.tenant)
            .field("email", &self.email)
            .field("auth", &self.auth)
            .field("allow_insecure_http", &self.allow_insecure_http)
            .field("extra_ca_pem", &self.extra_ca_pem.as_ref().map(|_| "<pem>"))
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl ServerAccount {
    pub(crate) fn channel_config(&self) -> channel::ChannelConfig {
        channel::ChannelConfig {
            url: self.url.clone(),
            allow_insecure_http: self.allow_insecure_http,
            extra_ca_pem: self.extra_ca_pem.clone(),
        }
    }

    /// Whether a session stored for `self` still belongs to `other`: the same
    /// user on the same server, reached and trusted the same way. Anything else
    /// signs in again, because the stored token belongs to another identity or
    /// was obtained over a connection the user has since changed.
    pub(crate) fn same_identity(&self, other: &ServerAccount) -> bool {
        self.url == other.url
            && self.tenant == other.tenant
            && self.email.eq_ignore_ascii_case(&other.email)
            && self.auth == other.auth
            && self.allow_insecure_http == other.allow_insecure_http
            && self.extra_ca_pem == other.extra_ca_pem
    }

    pub(crate) fn view(&self) -> ServerAccountView {
        ServerAccountView {
            id: self.id.clone(),
            name: self.name.clone(),
            url: self.url.clone(),
            tenant: self.tenant.clone(),
            email: self.email.clone(),
            allow_insecure_http: self.allow_insecure_http,
            extra_ca_pem: self.extra_ca_pem.clone(),
            signed_in: self.refresh_token.is_some(),
        }
    }
}

/// An account as the webview sees it: everything but the stored session.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerAccountView {
    pub id: String,
    pub name: String,
    pub url: String,
    pub tenant: String,
    pub email: String,
    pub allow_insecure_http: bool,
    pub extra_ca_pem: Option<String>,
    pub signed_in: bool,
}

/// An account as the form submits it. `id` is absent for a new account.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerAccountInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    pub tenant: String,
    pub email: String,
    #[serde(default)]
    pub allow_insecure_http: bool,
    #[serde(default)]
    pub extra_ca_pem: Option<String>,
}

impl ServerAccountInput {
    /// Validates and normalizes the form into an account with no session.
    pub(crate) fn into_account(self) -> Result<ServerAccount, String> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err("Enter a name for this MQLens Server account".to_string());
        }
        let url = channel::normalize_url(&self.url, self.allow_insecure_http)?;
        let tenant = self.tenant.trim();
        if tenant.is_empty() {
            return Err("Enter the MQLens Server tenant".to_string());
        }
        let email = self.email.trim();
        if !looks_like_email(email) {
            return Err("Enter the email address you sign in to MQLens Server with".to_string());
        }
        let extra_ca_pem = channel::normalize_extra_ca(self.extra_ca_pem.as_deref())?;
        let id = self
            .id
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        Ok(ServerAccount {
            id,
            name: name.to_string(),
            url,
            tenant: tenant.to_string(),
            email: email.to_string(),
            auth: AuthMethod::Password,
            allow_insecure_http: self.allow_insecure_http,
            extra_ca_pem,
            refresh_token: None,
        })
    }
}

fn looks_like_email(s: &str) -> bool {
    match s.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && !domain.is_empty()
                && !domain.contains('@')
                && !s.chars().any(char::is_whitespace)
        }
        None => false,
    }
}

/// Every stored account. A missing or empty file is no accounts.
pub(crate) fn load(path: &Path, key: &[u8; 32]) -> Result<Vec<ServerAccount>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let blob = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if blob.is_empty() {
        return Ok(Vec::new());
    }
    let json = crate::vault::decrypt(key, &blob)?;
    serde_json::from_slice(&json).map_err(|e| format!("parse MQLens Server accounts: {e}"))
}

/// Replaces the stored accounts. Atomic, like every other vault file: a
/// truncated write would lose every account and every stored session.
pub(crate) fn save(path: &Path, key: &[u8; 32], accounts: &[ServerAccount]) -> Result<(), String> {
    let json = serde_json::to_vec(accounts)
        .map_err(|e| format!("serialize MQLens Server accounts: {e}"))?;
    let blob = crate::vault::encrypt(key, &json)?;
    crate::durable::write_atomic(path, &blob)
}

/// The cross-process lock on the accounts file, held until the returned handle
/// drops. Blocks while another holder, in this process or another MQLens,
/// has it. The lock is a sidecar beside the file, as for settings; it is not
/// re-entrant, so a holder must not take it again.
pub(crate) fn lock(path: &Path) -> Result<fs::File, String> {
    crate::connections::lock_settings_for_write(path)
}

/// Load, change and save the accounts under the file lock.
pub(crate) fn update<T>(
    path: &Path,
    key: &[u8; 32],
    change: impl FnOnce(&mut Vec<ServerAccount>) -> Result<T, String>,
) -> Result<T, String> {
    let _lock = lock(path)?;
    let mut accounts = load(path, key)?;
    let out = change(&mut accounts)?;
    save(path, key, &accounts)?;
    Ok(out)
}

pub(crate) fn find(path: &Path, key: &[u8; 32], id: &str) -> Result<ServerAccount, String> {
    load(path, key)?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| "MQLens Server account not found".to_string())
}

/// Saves the form: a new account, or an edit that keeps the stored session
/// only when the edit keeps `same_identity`. Returns the account as saved and
/// the one it replaced.
pub(crate) fn save_account(
    path: &Path,
    key: &[u8; 32],
    input: ServerAccountInput,
) -> Result<(ServerAccount, Option<ServerAccount>), String> {
    let mut account = input.into_account()?;
    update(path, key, move |accounts| {
        match accounts.iter_mut().find(|a| a.id == account.id) {
            Some(existing) => {
                let previous = existing.clone();
                if previous.same_identity(&account) {
                    account.refresh_token = previous.refresh_token.clone();
                }
                *existing = account.clone();
                Ok((account, Some(previous)))
            }
            None => {
                accounts.push(account.clone());
                Ok((account, None))
            }
        }
    })
}

/// Removes an account, returning it, or `None` if there was no such account.
pub(crate) fn delete_account(
    path: &Path,
    key: &[u8; 32],
    id: &str,
) -> Result<Option<ServerAccount>, String> {
    update(path, key, |accounts| {
        Ok(accounts
            .iter()
            .position(|a| a.id == id)
            .map(|i| accounts.remove(i)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [3; 32];

    fn input() -> ServerAccountInput {
        ServerAccountInput {
            id: None,
            name: " Acme production ".to_string(),
            url: "https://MQLens.acme.test/".to_string(),
            tenant: " acme ".to_string(),
            email: " ops@acme.test ".to_string(),
            allow_insecure_http: false,
            extra_ca_pem: None,
        }
    }

    fn store() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ACCOUNTS_FILE_NAME);
        (dir, path)
    }

    fn set_token(path: &Path, id: &str, token: &str) {
        update(path, &KEY, |accounts| {
            accounts
                .iter_mut()
                .find(|a| a.id == id)
                .unwrap()
                .refresh_token = Some(token.to_string());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_form_is_validated_and_normalized() {
        let account = input().into_account().unwrap();
        assert_eq!(account.name, "Acme production");
        assert_eq!(account.url, "https://mqlens.acme.test");
        assert_eq!(account.tenant, "acme");
        assert_eq!(account.email, "ops@acme.test");
        assert_eq!(account.auth, AuthMethod::Password);
        assert!(uuid::Uuid::parse_str(&account.id).is_ok(), "{}", account.id);
        assert_eq!(account.refresh_token, None);

        let kept = ServerAccountInput {
            id: Some("acct-1".to_string()),
            ..input()
        };
        assert_eq!(kept.into_account().unwrap().id, "acct-1");
    }

    #[test]
    fn unusable_forms_are_rejected() {
        let cases: [(fn(&mut ServerAccountInput), &str); 6] = [
            (|i| i.name = "  ".to_string(), "Enter a name"),
            (
                |i| i.url = "http://mqlens.acme.test".to_string(),
                "must use https://",
            ),
            (
                |i| i.tenant = String::new(),
                "Enter the MQLens Server tenant",
            ),
            (|i| i.email = "ops".to_string(), "Enter the email address"),
            (
                |i| i.email = "ops @acme.test".to_string(),
                "Enter the email address",
            ),
            (|i| i.extra_ca_pem = Some("nope".to_string()), "must be PEM"),
        ];
        for (break_it, want) in cases {
            let mut form = input();
            break_it(&mut form);
            let err = form.into_account().unwrap_err();
            assert!(err.contains(want), "got {err:?}, want {want:?}");
        }
    }

    #[test]
    fn accounts_are_stored_encrypted() {
        let (_dir, path) = store();
        assert_eq!(load(&path, &KEY).unwrap(), Vec::new());

        let (account, _) = save_account(&path, &KEY, input()).unwrap();
        set_token(&path, &account.id, "refresh-secret");

        let raw = String::from_utf8_lossy(&fs::read(&path).unwrap()).to_string();
        assert!(!raw.contains("ops@acme.test"), "the file is not plaintext");
        assert!(
            !raw.contains("refresh-secret"),
            "the token is not plaintext"
        );

        let loaded = load(&path, &KEY).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].refresh_token.as_deref(), Some("refresh-secret"));
        assert!(load(&path, &[4; 32]).is_err(), "another key cannot read it");
    }

    #[test]
    fn an_edit_keeps_the_session_only_for_the_same_identity() {
        let (_dir, path) = store();
        let (account, previous) = save_account(&path, &KEY, input()).unwrap();
        assert!(previous.is_none());
        set_token(&path, &account.id, "refresh-1");

        let renamed = ServerAccountInput {
            id: Some(account.id.clone()),
            name: "Acme".to_string(),
            ..input()
        };
        let (saved, previous) = save_account(&path, &KEY, renamed).unwrap();
        assert_eq!(saved.refresh_token.as_deref(), Some("refresh-1"));
        assert_eq!(previous.unwrap().name, "Acme production");

        for change in [
            ServerAccountInput {
                url: "https://other.acme.test".to_string(),
                ..input()
            },
            ServerAccountInput {
                tenant: "globex".to_string(),
                ..input()
            },
            ServerAccountInput {
                email: "dba@acme.test".to_string(),
                ..input()
            },
        ] {
            set_token(&path, &account.id, "refresh-1");
            let edit = ServerAccountInput {
                id: Some(account.id.clone()),
                ..change
            };
            let (saved, previous) = save_account(&path, &KEY, edit).unwrap();
            assert_eq!(saved.refresh_token, None, "{saved:?}");
            assert_eq!(
                previous.unwrap().refresh_token.as_deref(),
                Some("refresh-1")
            );
            assert_eq!(find(&path, &KEY, &account.id).unwrap().refresh_token, None);
        }

        // The email's case is not a different user.
        set_token(&path, &account.id, "refresh-2");
        let edit = ServerAccountInput {
            id: Some(account.id.clone()),
            email: "dba@ACME.test".to_string(),
            ..input()
        };
        save_account(&path, &KEY, edit).unwrap();
        let back = ServerAccountInput {
            id: Some(account.id.clone()),
            email: "DBA@acme.test".to_string(),
            ..input()
        };
        let (saved, _) = save_account(&path, &KEY, back).unwrap();
        assert_eq!(saved.refresh_token.as_deref(), Some("refresh-2"));
    }

    #[test]
    fn deleting_returns_the_removed_account() {
        let (_dir, path) = store();
        let (a, _) = save_account(&path, &KEY, input()).unwrap();
        let (b, _) = save_account(&path, &KEY, input()).unwrap();
        assert_eq!(
            delete_account(&path, &KEY, &a.id).unwrap().unwrap().id,
            a.id
        );
        assert!(delete_account(&path, &KEY, &a.id).unwrap().is_none());
        assert_eq!(load(&path, &KEY).unwrap(), vec![b]);
        assert!(find(&path, &KEY, &a.id).unwrap_err().contains("not found"));
    }

    #[test]
    fn neither_the_view_nor_debug_output_carries_the_token() {
        let mut account = input().into_account().unwrap();
        account.refresh_token = Some("refresh-secret".to_string());
        let view = account.view();
        assert!(view.signed_in);
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("refresh-secret"), "{json}");
        assert!(!json.to_lowercase().contains("token"), "{json}");
        assert!(!format!("{account:?}").contains("refresh-secret"));
    }

    // Each thread adds an account through a full load-change-save. Without the
    // file lock, a later save built on a stale load drops the earlier accounts.
    #[test]
    fn concurrent_saves_do_not_lose_accounts() {
        let (_dir, path) = store();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || save_account(&path, &KEY, input()).unwrap())
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(load(&path, &KEY).unwrap().len(), 8);
    }
}
