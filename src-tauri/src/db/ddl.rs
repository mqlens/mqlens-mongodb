//! Collection, view, and database DDL operations.

use crate::write_guard::{guard_writable, WriteOp};
use crate::{connection_is_mock, require_real_client, AppState};

#[derive(serde::Serialize)]
pub struct DatabaseRenameResult {
    pub collections: u64,
    pub documents: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionValidation {
    pub validator: String,
    pub validation_level: String,
    pub validation_action: String,
}

pub async fn create_collection_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CreateCollection, false)?;

    if collection.trim().is_empty() {
        return Err("Collection name is required".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .create_collection(collection)
        .await
        .map_err(|e| format!("Failed to create collection: {}", e))
}

pub async fn create_view_impl(
    state: &AppState,
    id: &str,
    database: &str,
    view_name: &str,
    source_collection: &str,
    pipeline: &str,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CreateView, false)?;

    if view_name.trim().is_empty() {
        return Err("View name is required".to_string());
    }
    if source_collection.trim().is_empty() {
        return Err("Source collection is required".to_string());
    }
    // Validate the pipeline (a JSON array of stage documents) up front.
    let pipeline_val: serde_json::Value = if pipeline.trim().is_empty() {
        serde_json::Value::Array(Vec::new())
    } else {
        serde_json::from_str(pipeline)
            .map_err(|e| format!("Invalid aggregation pipeline JSON: {}", e))?
    };
    let stages_val = pipeline_val
        .as_array()
        .ok_or_else(|| "Aggregation pipeline must be a JSON array of stages".to_string())?;
    let mut stages: Vec<mongodb::bson::Document> = Vec::with_capacity(stages_val.len());
    for stage in stages_val {
        let doc = mongodb::bson::to_document(stage)
            .map_err(|e| format!("Invalid aggregation stage: {}", e))?;
        stages.push(doc);
    }

    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .create_collection(view_name)
        .view_on(source_collection.to_string())
        .pipeline(stages)
        .await
        .map_err(|e| format!("Failed to create view: {}", e))
}

pub async fn drop_collection_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    confirmed: bool,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::Drop, confirmed)?;

    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .collection::<mongodb::bson::Document>(collection)
        .drop()
        .await
        .map_err(|e| format!("Failed to drop collection: {}", e))
}

pub async fn rename_collection_impl(
    state: &AppState,
    id: &str,
    database: &str,
    from: &str,
    to: &str,
    confirmed: bool,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::Rename, confirmed)?;

    if from.trim().is_empty() || to.trim().is_empty() {
        return Err("Collection name is required".to_string());
    }
    if from == to {
        return Err("New collection name must be different".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database("admin")
        .run_command(mongodb::bson::doc! {
            "renameCollection": format!("{}.{}", database, from),
            "to": format!("{}.{}", database, to),
            "dropTarget": false,
        })
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to rename collection: {}", e))
}

pub async fn get_collection_options_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
) -> Result<CollectionValidation, String> {
    if connection_is_mock(state, id)? {
        return Ok(CollectionValidation {
            validator: "{}".into(),
            validation_level: String::new(),
            validation_action: String::new(),
        });
    }
    let client = require_real_client(state, id)?;
    let db = client.database(database);
    let mut cursor = db
        .list_collections()
        .filter(mongodb::bson::doc! { "name": collection })
        .await
        .map_err(|e| format!("Failed to read collection options: {}", e))?;
    use futures::stream::StreamExt;
    let spec = match cursor.next().await {
        Some(r) => r.map_err(|e| format!("Collection read error: {}", e))?,
        None => return Err(format!("Collection \"{}\" not found", collection)),
    };
    let validator = match &spec.options.validator {
        Some(doc) => serde_json::to_string_pretty(doc)
            .map_err(|e| format!("Failed to serialize validator: {}", e))?,
        None => "{}".to_string(),
    };
    let validation_level = match &spec.options.validation_level {
        Some(mongodb::options::ValidationLevel::Off) => "off",
        Some(mongodb::options::ValidationLevel::Moderate) => "moderate",
        Some(mongodb::options::ValidationLevel::Strict) => "strict",
        _ => "",
    }
    .to_string();
    let validation_action = match &spec.options.validation_action {
        Some(mongodb::options::ValidationAction::Error) => "error",
        Some(mongodb::options::ValidationAction::Warn) => "warn",
        _ => "",
    }
    .to_string();
    Ok(CollectionValidation {
        validator,
        validation_level,
        validation_action,
    })
}

pub async fn set_validator_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    validator: &str,
    validation_level: &str,
    validation_action: &str,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CollMod, false)?;

    if collection.trim().is_empty() {
        return Err("Collection name is required".into());
    }
    let validator_val: serde_json::Value = if validator.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(validator)
            .map_err(|e| format!("Invalid validator JSON: {}", e))?
    };
    if !validator_val.is_object() {
        return Err("Validator must be a JSON object".into());
    }
    let validator_doc = mongodb::bson::to_document(&validator_val)
        .map_err(|e| format!("Failed to convert validator to BSON: {}", e))?;
    let level = if validation_level.is_empty() {
        None
    } else {
        Some(validation_level)
    };
    let action = if validation_action.is_empty() {
        None
    } else {
        Some(validation_action)
    };
    let command = build_collmod_command(collection, validator_doc, level, action)?;
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .run_command(command)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to apply validation rules: {}", e))
}

pub async fn drop_database_impl(
    state: &AppState,
    id: &str,
    database: &str,
    confirmed: bool,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::Drop, confirmed)?;

    if database.trim().is_empty() {
        return Err("Database name is required".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .drop()
        .await
        .map_err(|e| format!("Failed to drop database: {}", e))
}

pub async fn rename_database_impl(
    state: &AppState,
    id: &str,
    from: &str,
    to: &str,
    drop_source: bool,
    confirmed: bool,
) -> Result<DatabaseRenameResult, String> {
    // `rename_database_impl` was found during Task 2 to be a mutating
    // command outside the plan's Task 2 coverage list (see write_guard.rs's
    // module doc for detail); Task 2 guarded it with a hardcoded
    // `confirmed=false` interim. It's at least as destructive as
    // `rename_collection` (renames every collection in the db, optionally
    // drops the source), so — like `rename_collection` — Task 3 gives it a
    // real `confirmed` command arg here.
    guard_writable(state, id, WriteOp::Rename, confirmed)?;

    if from.trim().is_empty() || to.trim().is_empty() {
        return Err("Database name is required".to_string());
    }
    if from == to {
        return Err("New database name must be different".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(DatabaseRenameResult {
            collections: 0,
            documents: 0,
        });
    }

    let client = require_real_client(state, id)?;
    let db_names = client
        .list_database_names()
        .await
        .map_err(|e| format!("Failed to list databases: {}", e))?;
    if !db_names.iter().any(|name| name == from) {
        return Err(format!("Source database \"{}\" does not exist", from));
    }
    if db_names.iter().any(|name| name == to) {
        return Err(format!("Target database \"{}\" already exists", to));
    }

    let source_db = client.database(from);
    let target_db = client.database(to);
    let mut coll_cursor = source_db
        .list_collections()
        .await
        .map_err(|e| format!("Failed to list source collections: {}", e))?;

    let mut specs = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = coll_cursor.next().await {
        let spec = result.map_err(|e| format!("Collection read error: {}", e))?;
        match spec.collection_type {
            mongodb::results::CollectionType::Collection => specs.push(spec),
            mongodb::results::CollectionType::View => {
                return Err(format!(
                    "Cannot rename database: collection \"{}\" is a view",
                    spec.name
                ));
            }
            mongodb::results::CollectionType::Timeseries => {
                return Err(format!(
                    "Cannot rename database: collection \"{}\" is time-series",
                    spec.name
                ));
            }
            _ => {
                return Err(format!(
                    "Cannot rename database: collection \"{}\" has an unsupported type",
                    spec.name
                ));
            }
        }
    }
    if specs.is_empty() {
        return Err(format!(
            "Source database \"{}\" has no collections to copy",
            from
        ));
    }

    let copy_result = async {
        let mut copied_collections = 0u64;
        let mut copied_documents = 0u64;

        for spec in &specs {
            let source_coll = source_db.collection::<mongodb::bson::Document>(&spec.name);
            let target_coll = target_db.collection::<mongodb::bson::Document>(&spec.name);

            target_db
                .create_collection(&spec.name)
                .await
                .map_err(|e| format!("Failed to create target collection {}: {}", spec.name, e))?;

            let mut doc_cursor = source_coll
                .find(mongodb::bson::doc! {})
                .await
                .map_err(|e| format!("Failed to read source collection {}: {}", spec.name, e))?;
            let mut batch = Vec::with_capacity(500);
            while let Some(result) = doc_cursor.next().await {
                batch.push(result.map_err(|e| format!("Cursor read error: {}", e))?);
                if batch.len() >= 500 {
                    copied_documents += batch.len() as u64;
                    target_coll
                        .insert_many(std::mem::take(&mut batch))
                        .await
                        .map_err(|e| {
                            format!("Failed to copy documents for {}: {}", spec.name, e)
                        })?;
                }
            }
            if !batch.is_empty() {
                copied_documents += batch.len() as u64;
                target_coll
                    .insert_many(batch)
                    .await
                    .map_err(|e| format!("Failed to copy documents for {}: {}", spec.name, e))?;
            }

            let mut idx_cursor = source_coll
                .list_indexes()
                .await
                .map_err(|e| format!("Failed to list indexes for {}: {}", spec.name, e))?;
            while let Some(result) = idx_cursor.next().await {
                let index = result.map_err(|e| format!("Index read error: {}", e))?;
                let name = index
                    .options
                    .as_ref()
                    .and_then(|o| o.name.as_deref())
                    .unwrap_or("");
                if name != "_id_" {
                    target_coll
                        .create_index(index)
                        .await
                        .map_err(|e| format!("Failed to recreate index on {}: {}", spec.name, e))?;
                }
            }

            let source_count = source_coll
                .count_documents(mongodb::bson::doc! {})
                .await
                .map_err(|e| format!("Failed to count source collection {}: {}", spec.name, e))?;
            let target_count = target_coll
                .count_documents(mongodb::bson::doc! {})
                .await
                .map_err(|e| format!("Failed to count target collection {}: {}", spec.name, e))?;
            if source_count != target_count {
                return Err(format!(
                    "Copied collection {} failed verification: source has {}, target has {}",
                    spec.name, source_count, target_count
                ));
            }
            copied_collections += 1;
        }

        Ok(DatabaseRenameResult {
            collections: copied_collections,
            documents: copied_documents,
        })
    }
    .await;

    match copy_result {
        Ok(result) => {
            if drop_source {
                source_db.drop().await.map_err(|e| {
                    format!("Copied target, but failed to drop source database: {}", e)
                })?;
            }
            Ok(result)
        }
        Err(err) => {
            let _ = target_db.drop().await;
            Err(err)
        }
    }
}

// Helper functions for validation rules (Tasks 1-3)
fn validation_level_value(level: Option<&str>) -> Result<Option<&str>, String> {
    match level {
        None | Some("") => Ok(None),
        Some(v @ ("off" | "moderate" | "strict")) => Ok(Some(v)),
        Some(other) => Err(format!("Invalid validationLevel: {}", other)),
    }
}

fn validation_action_value(action: Option<&str>) -> Result<Option<&str>, String> {
    match action {
        None | Some("") => Ok(None),
        Some(v @ ("error" | "warn")) => Ok(Some(v)),
        Some(other) => Err(format!("Invalid validationAction: {}", other)),
    }
}

fn build_collmod_command(
    collection: &str,
    validator: mongodb::bson::Document,
    level: Option<&str>,
    action: Option<&str>,
) -> Result<mongodb::bson::Document, String> {
    let mut cmd = mongodb::bson::doc! { "collMod": collection, "validator": validator };
    if let Some(lvl) = validation_level_value(level)? {
        cmd.insert("validationLevel", lvl);
    }
    if let Some(act) = validation_action_value(action)? {
        cmd.insert("validationAction", act);
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_collmod_full() {
        let validator = mongodb::bson::doc! { "$jsonSchema": { "type": "object" } };
        let result = build_collmod_command("test_coll", validator.clone(), Some("moderate"), Some("error"));

        assert!(result.is_ok());
        let cmd = result.unwrap();
        assert_eq!(cmd.get_str("collMod").unwrap(), "test_coll");
        assert!(cmd.contains_key("validator"));
        assert_eq!(cmd.get_str("validationLevel").unwrap(), "moderate");
        assert_eq!(cmd.get_str("validationAction").unwrap(), "error");
    }

    #[test]
    fn test_build_collmod_empty_opts() {
        let validator = mongodb::bson::doc! { "$jsonSchema": { "type": "object" } };
        let result = build_collmod_command("test_coll", validator.clone(), Some(""), Some(""));

        assert!(result.is_ok());
        let cmd = result.unwrap();
        assert_eq!(cmd.get_str("collMod").unwrap(), "test_coll");
        assert!(cmd.contains_key("validator"));
        assert!(!cmd.contains_key("validationLevel"));
        assert!(!cmd.contains_key("validationAction"));
    }

    #[test]
    fn test_build_collmod_invalid_level() {
        let validator = mongodb::bson::doc! { "$jsonSchema": { "type": "object" } };
        let result = build_collmod_command("test_coll", validator, Some("invalid"), Some("error"));

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("validationLevel"));
    }

    #[tokio::test]
    async fn test_get_collection_options_mock() {
        let state = crate::AppState::new();
        let conn_id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("mock connect");

        let opts = get_collection_options_impl(&state, &conn_id, "sales_db", "customers")
            .await
            .expect("get collection options");

        assert_eq!(opts.validator, "{}");
        assert_eq!(opts.validation_level, "");
        assert_eq!(opts.validation_action, "");
    }

    #[tokio::test]
    async fn test_set_validator_malformed_json() {
        let state = crate::AppState::new();
        let conn_id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("mock connect");

        let result = set_validator_impl(
            &state,
            &conn_id,
            "db",
            "coll",
            "{invalid json",
            "moderate",
            "error",
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid validator JSON"));
    }

    #[tokio::test]
    async fn test_set_validator_non_object_rejected() {
        let state = crate::AppState::new();
        let conn_id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("mock connect");

        let result = set_validator_impl(&state, &conn_id, "db", "coll", "[1,2,3]", "", "")
            .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must be a JSON object"));
    }

    #[tokio::test]
    async fn test_set_validator_invalid_level_rejected() {
        let state = crate::AppState::new();
        let conn_id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("mock connect");

        let result = set_validator_impl(
            &state,
            &conn_id,
            "db",
            "coll",
            "{}",
            "invalid_level",
            "error",
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("validationLevel"));
    }

    #[tokio::test]
    async fn test_set_validator_empty_clears() {
        let state = crate::AppState::new();
        let conn_id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("mock connect");

        let result = set_validator_impl(&state, &conn_id, "db", "coll", "", "", "")
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_set_validator_valid() {
        let state = crate::AppState::new();
        let conn_id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("mock connect");

        let result = set_validator_impl(
            &state,
            &conn_id,
            "db",
            "coll",
            r#"{"$jsonSchema": {"type": "object"}}"#,
            "moderate",
            "error",
        )
        .await;

        assert!(result.is_ok());
    }
}
