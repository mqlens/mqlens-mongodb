//! Collection, view, and database DDL operations.

use crate::{connection_is_mock, require_real_client, AppState};

#[derive(serde::Serialize)]
pub struct DatabaseRenameResult {
    pub collections: u64,
    pub documents: u64,
}

pub async fn create_collection_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
) -> Result<(), String> {
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
) -> Result<(), String> {
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
) -> Result<(), String> {
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

pub async fn drop_database_impl(state: &AppState, id: &str, database: &str) -> Result<(), String> {
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
) -> Result<DatabaseRenameResult, String> {
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
