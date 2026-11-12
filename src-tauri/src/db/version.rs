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

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::metadata::mongo_version(state, &conn).await;
        }
    };

    let db = client.database("admin");
    let result = db
        .run_command(mongodb::bson::doc! { "buildInfo": 1 })
        .await
        .map_err(|e| format!("Failed to read MongoDB version: {}", e))?;

    result
        .get_str("version")
        .map(|version| version.to_string())
        .map_err(|e| format!("MongoDB version missing: {}", e))
}
