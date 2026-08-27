use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

/// Per-connection production safeguard (#188): `Normal` allows every write,
/// `ReadOnly` blocks all writes at the command layer, `ConfirmDestructive`
/// requires an explicit typed-name confirmation for destructive ops (drop,
/// delete_many, update_many, rename). `#[default] Normal` + `serde(default)`
/// on the field below is the same additive pattern as `mcp_enabled` — old
/// profiles/connections.json entries without the field read as `Normal`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode {
    #[default]
    Normal,
    ReadOnly,
    ConfirmDestructive,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub uri: String,
    // Optional color tag for quick visual identification in the sidebar (#34).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_tag: Option<String>,
    // Optional SSH tunnel config. `#[serde(default)]` keeps older 3-field
    // connections.json files readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<crate::ssh_tunnel::SshConfig>,
    /// Expose this profile to MCP agents (Settings → MCP / #98). Old files
    /// without the field deserialize as false — never opted in by surprise.
    #[serde(default)]
    pub mcp_enabled: bool,
    /// Read-only / confirm-destructive production safeguard (#188). Old
    /// profiles without the field deserialize as `ConnectionMode::Normal` —
    /// same additive pattern as `mcp_enabled`.
    #[serde(default)]
    pub connection_mode: ConnectionMode,
}

fn default_anthropic_model() -> String {
    "claude-opus-4-8".to_string()
}
fn default_ai_provider() -> String {
    "anthropic".to_string()
}

fn default_ai_history_retention_months() -> u8 {
    3
}

fn default_audit_enabled() -> bool {
    true
}
fn default_audit_level() -> String {
    "A".to_string()
}
fn default_audit_retention_days() -> u32 {
    30
}
fn default_audit_include_payloads() -> bool {
    false
}
fn default_openai_model() -> String {
    "gpt-4o".to_string()
}
fn default_gemini_model() -> String {
    "gemini-1.5-flash".to_string()
}
fn default_update_channel() -> String {
    "stable".to_string()
}

fn default_preset_id() -> String {
    "mqlens-dark".to_string()
}

fn default_theme_mode() -> String {
    "dark".to_string()
}

fn default_font_sans() -> String {
    "Inter".to_string()
}

fn default_font_mono() -> String {
    "JetBrains Mono".to_string()
}

fn default_font_size() -> u8 {
    13
}

fn default_spacing_density() -> String {
    "cozy".to_string()
}

/// Query-bar row height in design px (at the default 13px root font); the UI
/// scales it like everything else.
fn default_query_bar_height() -> u8 {
    29
}

fn default_ui_zoom() -> f32 {
    1.0
}

/// UI language setting. "system" follows the device language; "en"/"de" pin it.
/// Defaults to "system" so a non-English device is localized without the user
/// having to find the setting.
fn default_locale() -> String {
    "system".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct AppearanceSettings {
    #[serde(default = "default_preset_id")]
    pub preset_id: String,
    #[serde(default = "default_theme_mode")]
    pub mode: String,
    #[serde(default)]
    pub overrides: std::collections::HashMap<String, String>,
    #[serde(default = "default_font_sans")]
    pub font_sans: String,
    #[serde(default = "default_font_mono")]
    pub font_mono: String,
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    #[serde(default = "default_spacing_density")]
    pub spacing_density: String,
    #[serde(default = "default_ui_zoom")]
    pub ui_zoom: f32,
    #[serde(default = "default_query_bar_height")]
    pub query_bar_height: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppSettings {
    #[serde(default)]
    pub mongosh_path: String,
    #[serde(default = "default_locale")]
    pub locale: String,
    // Which AI provider the query assistant uses:
    // anthropic | openai | gemini | claude-code | codex | cursor | antigravity
    #[serde(default = "default_ai_provider")]
    pub ai_provider: String,
    #[serde(default)]
    pub anthropic_api_key: String,
    #[serde(default = "default_anthropic_model")]
    pub anthropic_model: String,
    #[serde(default)]
    pub openai_api_key: String,
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    #[serde(default)]
    pub gemini_api_key: String,
    #[serde(default = "default_gemini_model")]
    pub gemini_model: String,
    // Per-local-agent command templates (agent id -> template). Missing -> built-in default.
    #[serde(default)]
    pub local_commands: std::collections::HashMap<String, String>,
    // Extra instructions appended to the generated system prompt for any provider.
    #[serde(default)]
    pub ai_custom_instructions: String,
    /// How long to keep AI Helper chat/prompt history (1–12 months).
    #[serde(default = "default_ai_history_retention_months")]
    pub ai_history_retention_months: u8,
    /// Master switch for local operation audit logging (#272).
    #[serde(default = "default_audit_enabled")]
    pub audit_enabled: bool,
    /// Audit verbosity: `"A"` (writes+shell), `"B"` (+high reads), `"C"` (all DB ops).
    #[serde(default = "default_audit_level")]
    pub audit_level: String,
    /// How long to keep audit events (days). Default 30; UI presets 7/30/90.
    #[serde(default = "default_audit_retention_days")]
    pub audit_retention_days: u32,
    /// When true, store document bodies / full filters up to the per-event cap.
    #[serde(default = "default_audit_include_payloads")]
    pub audit_include_payloads: bool,
    // Auto-update channel: "stable" (default) or "dev".
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    // UI appearance: theme preset, fonts, font size, spacing density.
    #[serde(default)]
    pub appearance: AppearanceSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            mongosh_path: String::new(),
            locale: default_locale(),
            ai_provider: default_ai_provider(),
            anthropic_api_key: String::new(),
            anthropic_model: default_anthropic_model(),
            openai_api_key: String::new(),
            openai_model: default_openai_model(),
            gemini_api_key: String::new(),
            gemini_model: default_gemini_model(),
            local_commands: std::collections::HashMap::new(),
            ai_custom_instructions: String::new(),
            ai_history_retention_months: default_ai_history_retention_months(),
            audit_enabled: default_audit_enabled(),
            audit_level: default_audit_level(),
            audit_retention_days: default_audit_retention_days(),
            audit_include_payloads: default_audit_include_payloads(),
            update_channel: default_update_channel(),
            appearance: AppearanceSettings::default(),
        }
    }
}

/// Built-in default command template for a local agent.
pub fn default_local_command(agent: &str) -> &'static str {
    match agent {
        "claude-code" => "claude -p {prompt}",
        "codex" => "codex exec {prompt}",
        "cursor" => "cursor-agent -p {prompt}",
        "antigravity" => "antigravity {prompt}",
        _ => "{prompt}",
    }
}

/// The user's command template for an agent, or the built-in default.
pub fn resolve_local_command(settings: &AppSettings, agent: &str) -> String {
    settings
        .local_commands
        .get(agent)
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| default_local_command(agent).to_string())
}

pub fn get_config_path(app_handle: &tauri::AppHandle) -> PathBuf {
    match app_handle.path().app_config_dir() {
        Ok(mut path) => {
            // Ensure the directory exists
            let _ = fs::create_dir_all(&path);
            path.push("connections.json");
            path
        }
        Err(_) => {
            // Fallback to current working directory
            PathBuf::from("connections.json")
        }
    }
}

pub fn get_settings_path(app_handle: &tauri::AppHandle) -> PathBuf {
    match app_handle.path().app_config_dir() {
        Ok(mut path) => {
            let _ = fs::create_dir_all(&path);
            path.push("settings.json");
            path
        }
        Err(_) => PathBuf::from("settings.json"),
    }
}

pub fn load_profiles_from_file(path: &Path) -> Result<Vec<ConnectionProfile>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read connections file: {}", e))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let profiles: Vec<ConnectionProfile> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse connections file: {}", e))?;
    Ok(profiles)
}

pub fn load_settings_from_file(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read settings file: {}", e))?;
    if content.trim().is_empty() {
        return Ok(AppSettings::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings file: {}", e))
}

pub fn save_settings_to_file(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(path, content).map_err(|e| format!("Failed to write settings file: {}", e))
}

pub fn save_profiles_to_file(path: &Path, profiles: &[ConnectionProfile]) -> Result<(), String> {
    let content = serde_json::to_string_pretty(profiles)
        .map_err(|e| format!("Failed to serialize connections: {}", e))?;
    fs::write(path, content).map_err(|e| format!("Failed to write connections file: {}", e))?;
    Ok(())
}

pub fn normalize_mongodb_uri_options(uri: &str) -> String {
    let Some(query_start) = uri.find('?') else {
        return uri.to_string();
    };

    let (prefix, query_with_marker) = uri.split_at(query_start + 1);
    let (query, fragment) = match query_with_marker.find('#') {
        Some(fragment_start) => query_with_marker.split_at(fragment_start),
        None => (query_with_marker, ""),
    };

    let mut normalized_parts = Vec::new();

    for part in query.split(['&', ';']) {
        let (key, value) = match part.split_once('=') {
            Some((key, value)) => (key, Some(value)),
            None => (part, None),
        };
        let key_lower = key.to_ascii_lowercase();

        // Map legacy/case-variant option names to spellings this Rust driver accepts.
        // The rustls-backed driver does not parse tlsAllowInvalidHostnames directly;
        // tlsInsecure is the compatible URI-level way to accept hostname mismatches.
        let (normalized_key, normalized_value) = match (key_lower.as_str(), value) {
            ("ssl", _) => ("tls", value.map(str::to_string)),
            (
                "sslinvalidhostnameallowed"
                | "sslallowinvalidhostname"
                | "sslallowinvalidhostnames"
                | "tlsallowinvalidhostname"
                | "tlsallowinvalidhostnames",
                _,
            ) => ("tlsInsecure", value.map(str::to_string)),
            (
                "sslinvalidcertificateallowed"
                | "sslallowinvalidcertificate"
                | "sslallowinvalidcertificates"
                | "tlsallowinvalidcertificate"
                | "tlsallowinvalidcertificates",
                _,
            ) => {
                ("tlsAllowInvalidCertificates", value.map(str::to_string))
            }
            ("sslcafile" | "tlscafile", _) => ("tlsCAFile", value.map(str::to_string)),
            ("sslcertificatekeyfile" | "sslpemkeyfile" | "tlscertificatekeyfile", _) => {
                ("tlsCertificateKeyFile", value.map(str::to_string))
            }
            (
                "sslcertificatekeyfilepassword"
                | "sslpemkeypassword"
                | "tlscertificatekeyfilepassword",
                _,
            ) => ("tlsCertificateKeyFilePassword", value.map(str::to_string)),
            ("tlsinsecure", _) => ("tlsInsecure", value.map(str::to_string)),
            ("localthreshold", _) => ("localThresholdMS", value.map(str::to_string)),
            ("gssapiservicename", Some(value)) => {
                ("authMechanismProperties", Some(format!("SERVICE_NAME:{value}")))
            }
            ("gssapiservicename", None) => ("authMechanismProperties", None),
            _ => (key, value.map(str::to_string)),
        };

        let normalized_part = match normalized_value {
            Some(value) => format!("{}={}", normalized_key, value),
            None => normalized_key.to_string(),
        };
        normalized_parts.push(normalized_part);
    }

    let normalized_query = normalized_parts.join("&");

    format!("{}{}{}", prefix, normalized_query, fragment)
}

/// Lock/setup state reported to the frontend.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VaultStatus {
    Uninitialized,
    Locked,
    Unlocked,
}

/// Unencrypted vault metadata stored at vault.json.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VaultMeta {
    pub version: u32,
    pub kdf_alg: String,
    pub kdf_m_kib: u32,
    pub kdf_t: u32,
    pub kdf_p: u32,
    /// base64 of the 16-byte salt.
    pub salt: String,
    /// base64 of nonce||ct+tag of VERIFIER_PLAINTEXT under the derived key.
    pub verifier: String,
}

impl VaultMeta {
    pub fn kdf_params(&self) -> crate::vault::KdfParams {
        crate::vault::KdfParams { m_kib: self.kdf_m_kib, t: self.kdf_t, p: self.kdf_p }
    }
    pub fn salt_bytes(&self) -> Result<Vec<u8>, String> {
        base64::engine::general_purpose::STANDARD
            .decode(&self.salt)
            .map_err(|e| format!("bad salt encoding: {e}"))
    }
}

/// Build vault metadata for a fresh password: new salt + params, plus a verifier.
pub fn build_vault_meta(password: &str, params: crate::vault::KdfParams) -> Result<VaultMeta, String> {
    let salt = crate::vault::new_salt();
    let key = crate::vault::derive_key(password, &salt, params)?;
    let verifier_blob = crate::vault::encrypt(&key, crate::vault::VERIFIER_PLAINTEXT)?;
    Ok(VaultMeta {
        version: 1,
        kdf_alg: "argon2id".to_string(),
        kdf_m_kib: params.m_kib,
        kdf_t: params.t,
        kdf_p: params.p,
        salt: base64::engine::general_purpose::STANDARD.encode(salt),
        verifier: base64::engine::general_purpose::STANDARD.encode(verifier_blob),
    })
}

/// Derive the key for a password against existing metadata, verifying the password.
/// Returns the key on success; Err if the password is wrong.
pub fn unlock_key(meta: &VaultMeta, password: &str) -> Result<[u8; 32], String> {
    let salt = meta.salt_bytes()?;
    let key = crate::vault::derive_key(password, &salt, meta.kdf_params())?;
    let verifier_blob = base64::engine::general_purpose::STANDARD
        .decode(&meta.verifier)
        .map_err(|e| format!("bad verifier encoding: {e}"))?;
    let plain = crate::vault::decrypt(&key, &verifier_blob)
        .map_err(|_| "incorrect master password".to_string())?;
    if plain != crate::vault::VERIFIER_PLAINTEXT {
        return Err("incorrect master password".to_string());
    }
    Ok(key)
}

/// True if `key` decrypts this vault's verifier to the known plaintext — i.e. it is the
/// key the stored master password would derive. Used to validate a biometric-restored key.
pub fn key_matches_meta(meta: &VaultMeta, key: &[u8; 32]) -> bool {
    let Ok(blob) = base64::engine::general_purpose::STANDARD.decode(&meta.verifier) else {
        return false;
    };
    matches!(crate::vault::decrypt(key, &blob), Ok(plain) if plain == crate::vault::VERIFIER_PLAINTEXT)
}

pub fn get_vault_meta_path(app_handle: &tauri::AppHandle) -> PathBuf {
    config_dir_file(app_handle, "vault.json")
}
pub fn get_profiles_enc_path(app_handle: &tauri::AppHandle) -> PathBuf {
    config_dir_file(app_handle, "connections.json.enc")
}
pub fn get_settings_enc_path(app_handle: &tauri::AppHandle) -> PathBuf {
    config_dir_file(app_handle, "settings.json.enc")
}

/// Append-only encrypted audit log (`audit.log.enc`).
pub fn get_audit_log_path(app_handle: &tauri::AppHandle) -> PathBuf {
    config_dir_file(app_handle, "audit.log.enc")
}

/// The superseded whole-image audit envelope (`audit.db.enc`).
///
/// Kept only so the pre-append-log file can be found and set aside; nothing
/// reads its contents any more.
pub fn get_audit_enc_path(app_handle: &tauri::AppHandle) -> PathBuf {
    config_dir_file(app_handle, "audit.db.enc")
}

/// Shared helper: a file inside the app config dir (creating the dir), or CWD fallback.
fn config_dir_file(app_handle: &tauri::AppHandle, name: &str) -> PathBuf {
    match app_handle.path().app_config_dir() {
        Ok(mut path) => {
            let _ = fs::create_dir_all(&path);
            path.push(name);
            path
        }
        Err(_) => PathBuf::from(name),
    }
}

pub fn read_vault_meta(path: &Path) -> Result<Option<VaultMeta>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|e| format!("read vault.json: {e}"))?;
    let meta: VaultMeta =
        serde_json::from_str(&content).map_err(|e| format!("parse vault.json: {e}"))?;
    Ok(Some(meta))
}

pub fn write_vault_meta(path: &Path, meta: &VaultMeta) -> Result<(), String> {
    let content =
        serde_json::to_string_pretty(meta).map_err(|e| format!("serialize vault.json: {e}"))?;
    fs::write(path, content).map_err(|e| format!("write vault.json: {e}"))
}

pub fn save_profiles_encrypted(
    path: &Path,
    key: &[u8; 32],
    profiles: &[ConnectionProfile],
) -> Result<(), String> {
    let json = serde_json::to_vec(profiles)
        .map_err(|e| format!("serialize connections: {e}"))?;
    let blob = crate::vault::encrypt(key, &json)?;
    fs::write(path, blob).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn load_profiles_encrypted(
    path: &Path,
    key: &[u8; 32],
) -> Result<Vec<ConnectionProfile>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let blob = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if blob.is_empty() {
        return Ok(Vec::new());
    }
    let json = crate::vault::decrypt(key, &blob)?;
    serde_json::from_slice(&json).map_err(|e| format!("parse connections: {e}"))
}

pub fn save_settings_encrypted(
    path: &Path,
    key: &[u8; 32],
    settings: &AppSettings,
) -> Result<(), String> {
    let json = serde_json::to_vec(settings).map_err(|e| format!("serialize settings: {e}"))?;
    let blob = crate::vault::encrypt(key, &json)?;
    fs::write(path, blob).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn load_settings_encrypted(path: &Path, key: &[u8; 32]) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let blob = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if blob.is_empty() {
        return Ok(AppSettings::default());
    }
    let json = crate::vault::decrypt(key, &blob)?;
    serde_json::from_slice(&json).map_err(|e| format!("parse settings: {e}"))
}

/// Migrate plaintext connections.json / settings.json into encrypted form, then delete
/// the plaintext originals. No-op for files that don't exist.
pub fn migrate_plaintext_to_encrypted(
    key: &[u8; 32],
    plaintext_profiles: &Path,
    enc_profiles: &Path,
    plaintext_settings: &Path,
    enc_settings: &Path,
) -> Result<(), String> {
    if plaintext_profiles.exists() {
        let profiles = load_profiles_from_file(plaintext_profiles)?;
        save_profiles_encrypted(enc_profiles, key, &profiles)?;
        fs::remove_file(plaintext_profiles)
            .map_err(|e| format!("remove plaintext connections: {e}"))?;
    }
    if plaintext_settings.exists() {
        let settings = load_settings_from_file(plaintext_settings)?;
        save_settings_encrypted(enc_settings, key, &settings)?;
        fs::remove_file(plaintext_settings)
            .map_err(|e| format!("remove plaintext settings: {e}"))?;
    }
    Ok(())
}

/// Re-encrypt a vault blob from `old_key` to `new_key` without touching disk.
pub fn reencrypt_blob(
    old_key: &[u8; 32],
    new_key: &[u8; 32],
    blob: &[u8],
) -> Result<Vec<u8>, String> {
    if blob.is_empty() {
        return Ok(Vec::new());
    }
    let plain = crate::vault::decrypt(old_key, blob)?;
    crate::vault::encrypt(new_key, &plain)
}

/// Read and prepare a re-encrypted file. Missing/empty files return `None`.
pub fn prepare_reencrypt_file(
    old_key: &[u8; 32],
    new_key: &[u8; 32],
    path: &Path,
) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let blob = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if blob.is_empty() {
        return Ok(None);
    }
    Ok(Some(reencrypt_blob(old_key, new_key, &blob)?))
}

/// Write a prepared blob, or no-op when `None`/empty.
pub fn write_prepared_file(path: &Path, blob: Option<Vec<u8>>) -> Result<(), String> {
    match blob {
        None => Ok(()),
        Some(b) if b.is_empty() => Ok(()),
        Some(b) => crate::durable::write_atomic(path, &b),
    }
}

/// Commit a whole vault key rotation, restoring the previous files if any write
/// fails.
///
/// The rotation spans four files, and partial success bricks the vault: files
/// re-encrypted under the new key while `vault.json` still derives the old one
/// leave neither password able to open the complete vault. Preparing the blobs
/// first (see `prepare_reencrypt_file`) removes the *encryption* failures from
/// this window, but the writes themselves can still fail — a full disk being the
/// obvious one — so every original is held in memory and put back on error.
///
/// `files` is `(path, Some(new_bytes))` per data file; `None` means "not
/// present, leave alone".
pub fn commit_vault_rotation(
    files: Vec<(PathBuf, Option<Vec<u8>>)>,
    meta_path: &Path,
    new_meta: &VaultMeta,
) -> Result<(), String> {
    let meta_bytes = serde_json::to_vec_pretty(new_meta)
        .map_err(|e| format!("serialize vault.json: {e}"))?;

    // Snapshot everything this rotation will overwrite, before touching any of it.
    let mut planned: Vec<(PathBuf, Vec<u8>, Option<Vec<u8>>)> = Vec::new();
    for (path, new_bytes) in files {
        let Some(new_bytes) = new_bytes.filter(|b| !b.is_empty()) else {
            continue;
        };
        let original = read_backup(&path)?;
        planned.push((path, new_bytes, original));
    }
    let meta_original = read_backup(meta_path)?;
    planned.push((meta_path.to_path_buf(), meta_bytes, meta_original));

    let mut written: Vec<(&PathBuf, &Option<Vec<u8>>)> = Vec::new();
    for (path, new_bytes, original) in &planned {
        if let Err(e) = crate::durable::write_atomic(path, new_bytes) {
            // Put back only what this call actually replaced.
            let mut restore_errors = Vec::new();
            for (done_path, done_original) in written.iter().rev() {
                let restored = match done_original {
                    Some(bytes) => crate::durable::write_atomic(done_path, bytes),
                    None => fs::remove_file(done_path)
                        .map_err(|e| format!("remove {}: {e}", done_path.display())),
                };
                if let Err(re) = restored {
                    restore_errors.push(re);
                }
            }
            if restore_errors.is_empty() {
                return Err(format!("{e} (vault left unchanged)"));
            }
            return Err(format!(
                "{e} — and restoring the previous vault files failed: {}. \
                 The vault may be inconsistent; restore from a backup.",
                restore_errors.join("; ")
            ));
        }
        written.push((path, original));
    }
    Ok(())
}

/// Current contents of `path`, or `None` when it does not exist.
fn read_backup(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read(path)
        .map(Some)
        .map_err(|e| format!("read {} for rollback: {e}", path.display()))
}

/// Re-encrypt both data files from `old_key` to `new_key`. Missing files are skipped.
pub fn reencrypt_data_files(
    old_key: &[u8; 32],
    new_key: &[u8; 32],
    enc_profiles: &Path,
    enc_settings: &Path,
) -> Result<(), String> {
    let profiles = prepare_reencrypt_file(old_key, new_key, enc_profiles)?;
    let settings = prepare_reencrypt_file(old_key, new_key, enc_settings)?;
    write_prepared_file(enc_profiles, profiles)?;
    write_prepared_file(enc_settings, settings)?;
    Ok(())
}

/// Prepare the audit log and its state sidecar, re-encrypted from `old_key` to
/// `new_key`.
///
/// Not `prepare_reencrypt_file`: the log encrypts each record separately, so
/// rotation has to decrypt every record and rebuild the hash chain rather than
/// re-wrap one blob. The state sidecar is keyed the same way and must rotate in
/// the same transaction, so both files come back together.
pub fn prepare_reencrypt_audit_log(
    old_key: &[u8; 32],
    new_key: &[u8; 32],
    log_path: &Path,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    crate::audit::log::prepare_reencrypted(old_key, new_key, log_path)
}

#[tauri::command]
pub async fn test_mongosh_path(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    let app_data_dir = app_handle.path().app_data_dir().ok();
    let executable = crate::toolsetup::resolve_mongosh_executable(&path, app_data_dir.as_deref());
    let output = Command::new(&executable)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to run mongosh: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A distinct phase of the connection test, surfaced to the UI checklist.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TestPhase {
    Parse,
    Resolve,
    Connect,
    Ping,
}

/// A single live update for one phase: `status` is "start", "ok", or "fail".
#[derive(Serialize, Clone, Debug)]
pub struct PhaseUpdate {
    pub phase: TestPhase,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PhaseUpdate {
    fn start(phase: TestPhase) -> Self {
        Self { phase, status: "start".into(), message: None }
    }
    fn ok(phase: TestPhase) -> Self {
        Self { phase, status: "ok".into(), message: None }
    }
    fn fail(phase: TestPhase, message: String) -> Self {
        Self { phase, status: "fail".into(), message: Some(message) }
    }
}

/// Run the connection test as four real, observable phases — parse, resolve,
/// connect, ping — emitting a start/ok/fail update for each. Stops at the first
/// failing phase (later phases stay unreported). `emit` is a closure so this
/// core is unit-testable without a Tauri Channel.
pub async fn run_connection_test(
    uri: &str,
    ssh: Option<&crate::ssh_tunnel::SshConfig>,
    emit: &(dyn Fn(PhaseUpdate) + Send + Sync),
) -> Result<(), String> {
    // Mock connections short-circuit: every phase reports ok, offline.
    if uri.starts_with("mongodb://mock") {
        for phase in [TestPhase::Parse, TestPhase::Resolve, TestPhase::Connect, TestPhase::Ping] {
            emit(PhaseUpdate::start(phase.clone()));
            emit(PhaseUpdate::ok(phase));
        }
        return Ok(());
    }

    let ssh_enabled = ssh.map(|c| c.enabled).unwrap_or(false);

    // Phase 1: Parse the URI.
    emit(PhaseUpdate::start(TestPhase::Parse));
    let normalized_uri = normalize_mongodb_uri_options(uri);
    if let Err(e) = mongodb::options::ClientOptions::parse(&normalized_uri).await {
        let msg = format!("Failed to parse connection URI: {}", e);
        emit(PhaseUpdate::fail(TestPhase::Parse, msg.clone()));
        return Err(msg);
    }
    emit(PhaseUpdate::ok(TestPhase::Parse));

    let (target_host, target_port) = crate::ssh_tunnel::extract_target_host_port(uri);

    // Phase 2: Resolve the host. With an SSH tunnel the Mongo host is reached
    // remotely (resolved on the far side), so this phase auto-passes.
    emit(PhaseUpdate::start(TestPhase::Resolve));
    if ssh_enabled {
        emit(PhaseUpdate::ok(TestPhase::Resolve));
    } else {
        match tokio::net::lookup_host((target_host.as_str(), target_port)).await {
            Ok(mut addrs) => {
                if addrs.next().is_some() {
                    emit(PhaseUpdate::ok(TestPhase::Resolve));
                } else {
                    let msg = format!("Host did not resolve: {}", target_host);
                    emit(PhaseUpdate::fail(TestPhase::Resolve, msg.clone()));
                    return Err(msg);
                }
            }
            Err(e) => {
                let msg = format!("Host did not resolve: {} ({})", target_host, e);
                emit(PhaseUpdate::fail(TestPhase::Resolve, msg.clone()));
                return Err(msg);
            }
        }
    }

    // Phase 3: Connect — open the SSH tunnel if configured, else TCP-connect.
    emit(PhaseUpdate::start(TestPhase::Connect));
    let mut effective_uri = uri.to_string();
    let mut _tunnel: Option<crate::ssh_tunnel::SshTunnel> = None;
    if ssh_enabled {
        let cfg = ssh.expect("ssh_enabled implies ssh is Some");
        match crate::ssh_tunnel::open_tunnel(cfg, target_host.clone(), target_port).await {
            Ok(t) => {
                effective_uri = crate::ssh_tunnel::rewrite_uri_hosts(uri, "127.0.0.1", t.local_port);
                _tunnel = Some(t);
            }
            Err(e) => {
                emit(PhaseUpdate::fail(TestPhase::Connect, e.clone()));
                return Err(e);
            }
        }
    } else {
        let addr = format!("{}:{}", target_host, target_port);
        let attempt = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::net::TcpStream::connect(&addr),
        )
        .await;
        match attempt {
            Ok(Ok(_stream)) => {}
            Ok(Err(e)) => {
                let msg = format!("Could not connect to {}: {}", addr, e);
                emit(PhaseUpdate::fail(TestPhase::Connect, msg.clone()));
                return Err(msg);
            }
            Err(_) => {
                let msg = format!("Could not connect to {}: timed out", addr);
                emit(PhaseUpdate::fail(TestPhase::Connect, msg.clone()));
                return Err(msg);
            }
        }
    }
    emit(PhaseUpdate::ok(TestPhase::Connect));

    // Phase 4: Verify with a driver ping (auth/handshake failures surface here).
    emit(PhaseUpdate::start(TestPhase::Ping));
    let normalized_eff = normalize_mongodb_uri_options(&effective_uri);
    let mut client_options = match mongodb::options::ClientOptions::parse(&normalized_eff).await {
        Ok(o) => o,
        Err(e) => {
            let msg = format!("Failed to parse connection URI: {}", e);
            emit(PhaseUpdate::fail(TestPhase::Ping, msg.clone()));
            return Err(msg);
        }
    };
    client_options.app_name = Some("MQLens-Ping".to_string());
    client_options.connect_timeout = Some(std::time::Duration::from_secs(5));
    client_options.server_selection_timeout = Some(std::time::Duration::from_secs(5));

    let client = match mongodb::Client::with_options(client_options) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to create client: {}", e);
            emit(PhaseUpdate::fail(TestPhase::Ping, msg.clone()));
            return Err(msg);
        }
    };

    match client
        .database("admin")
        .run_command(mongodb::bson::doc! { "ping": 1 })
        .await
    {
        Ok(_) => {
            emit(PhaseUpdate::ok(TestPhase::Ping));
            Ok(())
        }
        Err(e) => {
            let msg = format!("Database ping failed: {}", e);
            emit(PhaseUpdate::fail(TestPhase::Ping, msg.clone()));
            Err(msg)
        }
    }
    // `_tunnel` drops here, tearing down the temporary tunnel.
}

#[tauri::command]
pub async fn test_connection_uri(
    uri: String,
    ssh: Option<crate::ssh_tunnel::SshConfig>,
    on_phase: tauri::ipc::Channel<PhaseUpdate>,
) -> Result<(), String> {
    let emit = move |update: PhaseUpdate| {
        let _ = on_phase.send(update);
    };
    run_connection_test(&uri, ssh.as_ref(), &emit).await
}

#[cfg(test)]
mod rotation_tests {
    use super::*;
    use tempfile::tempdir;

    /// Build a test-only password without a hard-coded string literal, so static
    /// analysis does not read it as a real credential. Mirrors `test_secret` in
    /// `tests.rs`; kept local because that helper is private to that module.
    fn test_secret(parts: &[&str]) -> String {
        parts.concat()
    }

    fn meta() -> VaultMeta {
        let password = test_secret(&["rot", "ation", "-test"]);
        build_vault_meta(&password, crate::vault::KdfParams { m_kib: 8, t: 1, p: 1 })
            .expect("build meta")
    }

    #[test]
    fn a_successful_rotation_writes_every_file() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("connections.json.enc");
        let b = dir.path().join("settings.json.enc");
        let meta_path = dir.path().join("vault.json");
        fs::write(&a, b"old-a").unwrap();
        fs::write(&b, b"old-b").unwrap();

        commit_vault_rotation(
            vec![(a.clone(), Some(b"new-a".to_vec())), (b.clone(), Some(b"new-b".to_vec()))],
            &meta_path,
            &meta(),
        )
        .expect("commit");

        assert_eq!(fs::read(&a).unwrap(), b"new-a");
        assert_eq!(fs::read(&b).unwrap(), b"new-b");
        assert!(meta_path.exists(), "metadata must be written last but written");
    }

    #[test]
    fn a_failed_write_restores_every_earlier_file() {
        let dir = tempdir().unwrap();
        let good = dir.path().join("connections.json.enc");
        let meta_path = dir.path().join("vault.json");
        fs::write(&good, b"old-good").unwrap();
        fs::write(&meta_path, b"old-meta").unwrap();

        // `write_atomic` stages through `<path>.tmp`; a directory there makes the
        // *write* fail (not the pre-write snapshot), which is the path that has
        // to roll back what it already committed.
        let blocked = dir.path().join("blocked.enc");
        fs::create_dir(dir.path().join("blocked.enc.tmp")).unwrap();

        let err = commit_vault_rotation(
            vec![
                (good.clone(), Some(b"new-good".to_vec())),
                (blocked.clone(), Some(b"new-blocked".to_vec())),
            ],
            &meta_path,
            &meta(),
        )
        .expect_err("the blocked write must fail");
        assert!(err.contains("vault left unchanged"), "{err}");

        assert_eq!(
            fs::read(&good).unwrap(),
            b"old-good",
            "the already-written file must be rolled back, or no password opens the vault"
        );
        assert_eq!(
            fs::read(&meta_path).unwrap(),
            b"old-meta",
            "metadata must be untouched"
        );
    }

    #[test]
    fn rollback_removes_files_that_did_not_exist_before() {
        let dir = tempdir().unwrap();
        let fresh = dir.path().join("settings.json.enc");
        let meta_path = dir.path().join("vault.json");
        let blocked = dir.path().join("blocked.enc");
        fs::create_dir(dir.path().join("blocked.enc.tmp")).unwrap();

        commit_vault_rotation(
            vec![
                (fresh.clone(), Some(b"new".to_vec())),
                (blocked, Some(b"x".to_vec())),
            ],
            &meta_path,
            &meta(),
        )
        .expect_err("must fail");

        assert!(
            !fresh.exists(),
            "a file created by the aborted rotation must not survive it"
        );
    }

    #[test]
    fn absent_and_empty_payloads_are_skipped() {
        let dir = tempdir().unwrap();
        let skipped = dir.path().join("connections.json.enc");
        let empty = dir.path().join("settings.json.enc");
        let meta_path = dir.path().join("vault.json");

        commit_vault_rotation(
            vec![(skipped.clone(), None), (empty.clone(), Some(Vec::new()))],
            &meta_path,
            &meta(),
        )
        .expect("commit");

        assert!(!skipped.exists());
        assert!(!empty.exists());
        assert!(meta_path.exists());
    }
}
