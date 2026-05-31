//! Server version lookup.

use crate::state::LockExt;
use crate::AppState;

pub async fn get_mongodb_version_impl(state: &AppState, id: &str) -> Result<String, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok("7.0.5".to_string());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let db = client.database("admin");
    let result = db
        .run_command(mongodb::bson::doc! { "buildInfo": 1 })
        .await
        .map_err(|e| format!("Failed to read MongoDB version: {}", e))?;

    let version = result.get_str("version").unwrap_or("unknown").to_string();
    Ok(version)
}
