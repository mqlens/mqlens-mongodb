//! Aggregation pipelines: execute and explain. Real-connection-only.

use crate::limits::MAX_AGGREGATE_RESULTS;
use crate::state::LockExt;
use crate::AppState;

pub async fn execute_aggregate_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    pipeline: &str,
) -> Result<Vec<String>, String> {
    // Parse and validate the pipeline (a JSON array of stage documents) up front so a
    // malformed pipeline fails clearly regardless of the connection type.
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

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Err("Aggregation pipelines are not supported on mock connections".to_string());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);

    let mut cursor = coll
        .aggregate(stages)
        .await
        .map_err(|e| format!("Aggregation failed: {}", e))?;

    let mut results = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        if results.len() >= MAX_AGGREGATE_RESULTS {
            return Err(format!(
                "Aggregation result capped at {} documents — add a $limit stage for larger pipelines",
                MAX_AGGREGATE_RESULTS
            ));
        }
        let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
        let json_val: serde_json::Value =
            serde_json::to_value(&doc).map_err(|e| format!("BSON to JSON error: {}", e))?;
        results.push(serde_json::to_string(&json_val).unwrap());
    }

    Ok(results)
}

/// Explain an entire aggregation pipeline (M1), not just its `$match` stage.
/// Mirrors `execute_aggregate_impl`'s validation and is real-connection-only.
pub async fn explain_aggregate_query_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    pipeline: &str,
) -> Result<String, String> {
    // Parse and validate the pipeline (a JSON array of stage documents) up front.
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

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Err("Aggregation explain is not supported on mock connections".to_string());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let db = client.database(database);
    let command = mongodb::bson::doc! {
        "explain": {
            "aggregate": collection,
            "pipeline": stages,
            "cursor": {}
        },
        "verbosity": "executionStats"
    };

    let explain_result = db
        .run_command(command)
        .await
        .map_err(|e| format!("Explain failed: {}", e))?;

    let json_val: serde_json::Value =
        serde_json::to_value(&explain_result).map_err(|e| format!("BSON to JSON error: {}", e))?;

    Ok(serde_json::to_string_pretty(&json_val).unwrap())
}
