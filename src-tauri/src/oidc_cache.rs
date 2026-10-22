//! Versioned refresh-token state, kept inside connections.enc only (#439).
//! Like @mongodb-js/oidc-plugin, match all server IdP metadata before reuse.
//! Access/ID tokens never cross this persistence boundary.
use crate::connections::{ConnectionProfile, OidcProfileConfig};
use mongodb::options::oidc::IdpServerInfo;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Metadata {
    issuer: String,
    client_id: Option<String>,
    scopes: Option<Vec<String>>,
}
impl From<&IdpServerInfo> for Metadata {
    fn from(idp: &IdpServerInfo) -> Self {
        Self {
            issuer: idp.issuer.clone(),
            client_id: idp.client_id.clone(),
            scopes: idp.request_scopes.clone(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RefreshToken {
    metadata: Metadata,
    token: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Slot {
    version: u8,
    generation: String,
    token: Option<RefreshToken>,
}
impl Default for Slot {
    fn default() -> Self {
        Self {
            version: 1,
            generation: uuid::Uuid::new_v4().to_string(),
            token: None,
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct EncryptedProfiles {
    pub profiles: Vec<ConnectionProfile>,
    #[serde(default)]
    pub oidc: HashMap<String, Slot>,
}

/// No Debug/Serialize: a cache handle and its tokens never reach IPC or logs.
pub struct TokenCache {
    path: PathBuf,
    meta_path: PathBuf,
    key: Arc<Mutex<Option<[u8; 32]>>>,
    profile: ConnectionProfile,
    generation: String,
}

impl TokenCache {
    pub fn open(
        path: PathBuf,
        meta_path: PathBuf,
        key: Arc<Mutex<Option<[u8; 32]>>>,
        id: &str,
        uri: &str,
        config: Option<&OidcProfileConfig>,
        ssh: Option<&crate::ssh_tunnel::SshConfig>,
    ) -> Result<Option<Arc<Self>>, String> {
        let _lock = crate::connections::lock_vault_for_write(&meta_path)?;
        let vault_key = checked_key(&key, &meta_path)?;
        let mut data = crate::connections::load_encrypted_profiles(&path, &vault_key)?;
        let Some(profile) = data
            .profiles
            .iter()
            .find(|p| {
                p.id == id
                    && p.uri == crate::connections::normalize_mongodb_uri_options(uri)
                    && p.oidc.as_ref() == config
                    && p.ssh.as_ref() == ssh
                    && p.oidc.as_ref().is_some_and(|c| c.remember_login)
                    && crate::oidc_login::uri_requests_oidc(&p.uri)
            })
            .cloned()
        else {
            return Ok(None);
        };
        let slot = data.oidc.entry(id.to_string()).or_default();
        if slot.version != 1 {
            *slot = Slot::default();
        }
        let generation = slot.generation.clone();
        crate::connections::save_encrypted_profiles(&path, &vault_key, &data)?;
        Ok(Some(Arc::new(Self {
            path,
            meta_path,
            key,
            profile,
            generation,
        })))
    }

    pub(crate) async fn load_async(self: &Arc<Self>, metadata: &Metadata) -> Option<String> {
        let (cache, metadata) = (self.clone(), metadata.clone());
        crate::server::session::blocking(move || cache.load(&metadata))
            .await
            .ok()
            .flatten()
    }

    pub(crate) async fn replace_async(
        self: &Arc<Self>,
        metadata: &Metadata,
        expected: Option<&str>,
        token: Option<&str>,
    ) {
        let (cache, metadata) = (self.clone(), metadata.clone());
        let (expected, token) = (expected.map(str::to_string), token.map(str::to_string));
        let _ = crate::server::session::blocking(move || {
            cache.replace(&metadata, expected.as_deref(), token.as_deref())
        })
        .await;
    }

    fn update<T>(&self, action: impl FnOnce(&mut Slot) -> T) -> Result<Option<T>, String> {
        let _lock = crate::connections::lock_vault_for_write(&self.meta_path)?;
        let key = checked_key(&self.key, &self.meta_path)?;
        let mut data = crate::connections::load_encrypted_profiles(&self.path, &key)?;
        if !data.profiles.iter().any(|p| {
            p.id == self.profile.id
                && p.uri == self.profile.uri
                && p.oidc == self.profile.oidc
                && p.ssh == self.profile.ssh
        }) {
            return Ok(None);
        }
        let Some(slot) = data.oidc.get_mut(&self.profile.id) else {
            return Ok(None);
        };
        if slot.version != 1 || slot.generation != self.generation {
            return Ok(None);
        }
        let result = action(slot);
        crate::connections::save_encrypted_profiles(&self.path, &key, &data)?;
        Ok(Some(result))
    }

    pub(crate) fn load(&self, metadata: &Metadata) -> Result<Option<String>, String> {
        self.update(|slot| {
            if slot.token.as_ref().is_some_and(|t| &t.metadata != metadata) {
                slot.token = None;
            }
            slot.token.as_ref().map(|t| t.token.clone())
        })
        .map(|v| v.flatten())
    }

    pub(crate) fn replace(
        &self,
        metadata: &Metadata,
        expected: Option<&str>,
        token: Option<&str>,
    ) -> Result<(), String> {
        self.update(|slot| {
            // A refresh finishing late must not overwrite a newer rotated token.
            if slot.token.as_ref().map(|t| t.token.as_str()) == expected {
                slot.token = token.map(|t| RefreshToken {
                    metadata: metadata.clone(),
                    token: t.to_string(),
                });
            }
        })?;
        Ok(())
    }
}

fn checked_key(
    key: &Mutex<Option<[u8; 32]>>,
    meta_path: &std::path::Path,
) -> Result<[u8; 32], String> {
    use crate::state::LockExt;
    let key = key
        .lock_safe()?
        .ok_or_else(|| "vault is locked".to_string())?;
    let meta = crate::connections::read_vault_meta(meta_path)?
        .ok_or_else(|| "vault is not initialized".to_string())?;
    if !crate::connections::key_matches_meta(&meta, &key) {
        return Err("vault key changed; unlock again".to_string());
    }
    Ok(key)
}

pub(crate) fn forget(path: &std::path::Path, key: &[u8; 32], id: &str) -> Result<(), String> {
    let mut data = crate::connections::load_encrypted_profiles(path, key)?;
    if let Some(slot) = data.oidc.get_mut(id) {
        *slot = Slot::default();
    }
    crate::connections::save_encrypted_profiles(path, key, &data)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::connections::*;

    pub(crate) struct Fixture {
        _dir: tempfile::TempDir,
        path: PathBuf,
        meta: PathBuf,
        key: Arc<Mutex<Option<[u8; 32]>>>,
        profile: ConnectionProfile,
    }
    impl Fixture {
        pub(crate) fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("connections.enc");
            let meta = dir.path().join("vault.json");
            let metadata = build_vault_meta(
                "test-password",
                crate::vault::KdfParams {
                    m_kib: 8,
                    t: 1,
                    p: 1,
                },
            )
            .unwrap();
            let key = unlock_key(&metadata, "test-password").unwrap();
            write_vault_meta(&meta, &metadata).unwrap();
            let profile: ConnectionProfile = serde_json::from_value(serde_json::json!({
                "id": "profile-1", "name": "OIDC", "uri": "mongodb://localhost/?authMechanism=MONGODB-OIDC",
                "oidc": { "remember_login": true }
            })).unwrap();
            save_profiles_encrypted(&path, &key, &[profile.clone()]).unwrap();
            Self {
                _dir: dir,
                path,
                meta,
                key: Arc::new(Mutex::new(Some(key))),
                profile,
            }
        }
        pub(crate) fn cache(&self) -> Arc<TokenCache> {
            TokenCache::open(
                self.path.clone(),
                self.meta.clone(),
                self.key.clone(),
                &self.profile.id,
                &self.profile.uri,
                self.profile.oidc.as_ref(),
                self.profile.ssh.as_ref(),
            )
            .unwrap()
            .unwrap()
        }
        fn key(&self) -> [u8; 32] {
            self.key.lock().unwrap().unwrap()
        }
        pub(crate) fn retarget(&mut self, uri: &str, config: OidcProfileConfig) {
            self.profile.uri = uri.to_string();
            self.profile.oidc = Some(config);
            save_profiles_encrypted(&self.path, &self.key(), &[self.profile.clone()]).unwrap();
        }
    }
    fn metadata(issuer: &str, client: &str) -> Metadata {
        Metadata::from(
            &IdpServerInfo::builder()
                .issuer(issuer.to_string())
                .client_id(Some(client.to_string()))
                .build(),
        )
    }

    #[test]
    fn restart_restores_only_encrypted_refresh_tokens_and_preserves_profile_edits() {
        let f = Fixture::new();
        let meta = metadata("https://idp.example", "client");
        let cache = f.cache();
        cache
            .replace(&meta, None, Some("synthetic-refresh-secret"))
            .unwrap();
        drop(cache);
        assert_eq!(
            f.cache().load(&meta).unwrap().as_deref(),
            Some("synthetic-refresh-secret")
        );
        let bytes = std::fs::read(&f.path).unwrap();
        assert!(!bytes
            .windows(b"synthetic-refresh-secret".len())
            .any(|w| w == b"synthetic-refresh-secret"));
        let profiles = load_profiles_encrypted(&f.path, &f.key()).unwrap();
        assert!(!serde_json::to_string(&profiles)
            .unwrap()
            .contains("synthetic-refresh-secret"));
        assert!(!serde_json::to_string(&profiles)
            .unwrap()
            .contains("oidcPluginState"));
        let mut renamed = f.profile.clone();
        renamed.name = "Renamed".into();
        save_profiles_encrypted(&f.path, &f.key(), &[renamed]).unwrap();
        assert!(f.cache().load(&meta).unwrap().is_some());
    }

    #[test]
    fn metadata_changes_discard_tokens_without_sending_them_to_another_issuer_client_or_scope() {
        let f = Fixture::new();
        let cache = f.cache();
        let meta = metadata("https://idp.example", "client");
        for changed in [
            metadata("https://other.example", "client"),
            metadata("https://idp.example", "other"),
            Metadata {
                scopes: Some(vec!["different".into()]),
                ..meta.clone()
            },
        ] {
            cache
                .replace(&meta, None, Some("synthetic-refresh-secret"))
                .unwrap();
            assert!(cache.load(&changed).unwrap().is_none());
            assert!(cache.load(&meta).unwrap().is_none());
        }
    }

    #[test]
    fn forget_and_stale_refreshes_cannot_restore_or_overwrite_a_newer_token() {
        let f = Fixture::new();
        let meta = metadata("https://idp.example", "client");
        let old = f.cache();
        old.replace(&meta, None, Some("first")).unwrap();
        old.replace(&meta, Some("first"), Some("rotated")).unwrap();
        old.replace(&meta, Some("first"), None).unwrap();
        assert_eq!(old.load(&meta).unwrap().as_deref(), Some("rotated"));
        forget(&f.path, &f.key(), &f.profile.id).unwrap();
        old.replace(&meta, None, Some("late")).unwrap();
        assert!(old.load(&meta).unwrap().is_none());
        assert!(f.cache().load(&meta).unwrap().is_none());
    }

    #[test]
    fn opt_out_retarget_delete_and_token_choice_changes_invalidate_existing_callbacks() {
        for change in 0..4 {
            let f = Fixture::new();
            let cache = f.cache();
            let meta = metadata("https://idp.example", "client");
            cache
                .replace(&meta, None, Some("synthetic-refresh-secret"))
                .unwrap();
            let mut p = f.profile.clone();
            match change {
                0 => p.oidc.as_mut().unwrap().remember_login = false,
                1 => p.uri = "mongodb://another/?authMechanism=MONGODB-OIDC".into(),
                2 => p.oidc.as_mut().unwrap().use_id_token = true,
                _ => {}
            }
            save_profiles_encrypted(
                &f.path,
                &f.key(),
                if change == 3 {
                    &[]
                } else {
                    std::slice::from_ref(&p)
                },
            )
            .unwrap();
            cache.replace(&meta, None, Some("late")).unwrap();
            assert!(cache.load(&meta).unwrap().is_none());
            assert!(load_encrypted_profiles(&f.path, &f.key())
                .unwrap()
                .oidc
                .is_empty());
        }
    }

    #[test]
    fn only_an_exact_opted_in_saved_oidc_profile_can_open_a_cache() {
        let f = Fixture::new();
        for (id, uri, config) in [
            ("unknown", f.profile.uri.as_str(), f.profile.oidc.as_ref()),
            (
                "profile-1",
                "mongodb://other/?authMechanism=MONGODB-OIDC",
                f.profile.oidc.as_ref(),
            ),
            ("profile-1", f.profile.uri.as_str(), None),
        ] {
            assert!(TokenCache::open(
                f.path.clone(),
                f.meta.clone(),
                f.key.clone(),
                id,
                uri,
                config,
                None
            )
            .unwrap()
            .is_none());
        }
        let mut p = f.profile.clone();
        p.oidc = None;
        save_profiles_encrypted(&f.path, &f.key(), &[p]).unwrap();
        assert!(TokenCache::open(
            f.path.clone(),
            f.meta.clone(),
            f.key.clone(),
            "profile-1",
            &f.profile.uri,
            f.profile.oidc.as_ref(),
            None
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn legacy_vault_arrays_migrate_without_changing_plain_profile_format() {
        let f = Fixture::new();
        let blob = crate::vault::encrypt(
            &f.key(),
            &serde_json::to_vec(&vec![f.profile.clone()]).unwrap(),
        )
        .unwrap();
        std::fs::write(&f.path, blob).unwrap();
        assert_eq!(
            load_profiles_encrypted(&f.path, &f.key()).unwrap(),
            vec![f.profile.clone()]
        );
        let cache = f.cache();
        cache
            .replace(
                &metadata("https://idp.example", "client"),
                None,
                Some("test"),
            )
            .unwrap();
        assert_eq!(
            load_profiles_encrypted(&f.path, &f.key()).unwrap(),
            vec![f.profile]
        );
    }

    #[test]
    fn lock_reset_rotation_and_unknown_cache_versions_fail_closed() {
        let f = Fixture::new();
        let cache = f.cache();
        let meta = metadata("https://idp.example", "client");
        cache.replace(&meta, None, Some("test")).unwrap();
        *f.key.lock().unwrap() = None;
        assert_eq!(cache.load(&meta).unwrap_err(), "vault is locked");
        *f.key.lock().unwrap() = Some([0; 32]);
        assert!(cache.load(&meta).is_err());
        std::fs::remove_file(&f.meta).unwrap();
        assert_eq!(cache.load(&meta).unwrap_err(), "vault is not initialized");
        let g = Fixture::new();
        let cache = g.cache();
        let mut data = load_encrypted_profiles(&g.path, &g.key()).unwrap();
        data.oidc.get_mut("profile-1").unwrap().version = 2;
        save_encrypted_profiles(&g.path, &g.key(), &data).unwrap();
        assert!(cache.load(&meta).unwrap().is_none());
        assert!(g.cache().load(&meta).unwrap().is_none());
    }

    #[tokio::test]
    async fn restarted_native_flow_refreshes_silently_and_rejection_clears_saved_token() {
        use crate::oidc::{mock_idp::MockIdp, run_flow, OidcSession, TokenChoice};
        use mongodb::options::oidc::CallbackContext;
        let f = Fixture::new();
        let idp = MockIdp::start();
        let meta = metadata(&idp.issuer(), "mqlens-test");
        f.cache()
            .replace(&meta, None, Some("synthetic-refresh"))
            .unwrap();
        let context = || {
            CallbackContext::builder()
                .version(1u32)
                .timeout(Some(
                    std::time::Instant::now() + std::time::Duration::from_secs(10),
                ))
                .idp_info(Some(
                    IdpServerInfo::builder()
                        .issuer(idp.issuer())
                        .client_id(Some("mqlens-test".to_string()))
                        .build(),
                ))
                .build()
        };
        let session = OidcSession::new(Arc::new(|_| {}));
        session.set_cache(Some(f.cache()));
        let result = run_flow(
            context(),
            session,
            crate::oidc_login::no_browser_opener(),
            reqwest::Client::new(),
            TokenChoice::AccessToken,
        )
        .await
        .unwrap();
        assert!(!result.access_token.is_empty());
        assert_eq!(
            idp.last_token_request().unwrap().grant_type,
            "refresh_token"
        );
        assert_eq!(f.cache().load(&meta).unwrap(), result.refresh_token);
        idp.reject_refresh_tokens();
        let session = OidcSession::new(Arc::new(|_| {}));
        session.set_cache(Some(f.cache()));
        assert!(run_flow(
            context(),
            session,
            crate::oidc_login::no_browser_opener(),
            reqwest::Client::new(),
            TokenChoice::AccessToken
        )
        .await
        .is_err());
        assert!(f.cache().load(&meta).unwrap().is_none());
    }
}
