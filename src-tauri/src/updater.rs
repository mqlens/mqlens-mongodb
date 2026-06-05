//! Channel-aware auto-update.
//!
//! Tauri's updater endpoints are static config, so they can't be switched at
//! runtime. To support a user-selectable channel ("stable" / "dev") we build the
//! updater per check with the endpoint for the chosen channel via
//! `app.updater_builder().endpoints(...)`.
//!
//! - stable → the latest non-prerelease `latest.json`
//! - dev    → `latest.json` attached to the permanent `dev-channel` pre-release
//!
//! Both manifests are signed with the same updater key (configured in
//! tauri.conf.json `plugins.updater.pubkey`), so switching channels is safe.
//! Tauri only updates to a *higher* version, so stable→dev pulls newer dev
//! builds; dev→stable does not auto-downgrade.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

const STABLE_ENDPOINT: &str =
    "https://github.com/mqlens/mqlens-mongodb/releases/latest/download/latest.json";
const DEV_ENDPOINT: &str =
    "https://github.com/mqlens/mqlens-mongodb/releases/download/dev-channel/latest.json";

fn endpoint_for(channel: &str) -> &'static str {
    if channel == "dev" {
        DEV_ENDPOINT
    } else {
        STABLE_ENDPOINT
    }
}

#[derive(Serialize, Clone)]
pub struct UpdateMeta {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: usize,
    total: Option<u64>,
}

async fn fetch_update(
    app: &AppHandle,
    channel: &str,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let url = endpoint_for(channel)
        .parse()
        .map_err(|e| format!("invalid update endpoint: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// Check the given channel's manifest for an available update.
#[tauri::command]
pub async fn update_check(app: AppHandle, channel: String) -> Result<Option<UpdateMeta>, String> {
    let update = fetch_update(&app, &channel).await?;
    Ok(update.map(|u| UpdateMeta {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    }))
}

/// Download + install the available update on the given channel, emitting
/// `update://progress` events. The caller relaunches the app afterward.
#[tauri::command]
pub async fn update_install(app: AppHandle, channel: String) -> Result<(), String> {
    let update = fetch_update(&app, &channel)
        .await?
        .ok_or_else(|| "No update available".to_string())?;
    let mut downloaded: usize = 0;
    let app2 = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
                let _ = app2.emit("update://progress", DownloadProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
