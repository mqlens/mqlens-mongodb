//! Find-style queries: execute, count, and explain MQL filters.

use crate::state::LockExt;
use crate::{mock_db, AppState};

pub async fn execute_mql_query_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    sort: &str,
    projection: &str,
    limit: i64,
    skip: i64,
) -> Result<Vec<String>, String> {
    // Validate projection JSON up front (applies on the real path; mock ignores fields).
    let projection_doc: Option<mongodb::bson::Document> =
        if projection.trim().is_empty() || projection.trim() == "{}" {
            None
        } else {
            let val: serde_json::Value = serde_json::from_str(projection)
                .map_err(|e| format!("Invalid MQL projection JSON: {}", e))?;
            Some(
                mongodb::bson::to_document(&val)
                    .map_err(|e| format!("BSON conversion error: {}", e))?,
            )
        };

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return mock_db::execute_mock_query(database, collection, filter, sort, limit, skip);
    }

    let filter_val: serde_json::Value = if filter.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(filter).map_err(|e| format!("Invalid MQL filter JSON: {}", e))?
    };

    let sort_val: serde_json::Value = if sort.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(sort).map_err(|e| format!("Invalid MQL sort JSON: {}", e))?
    };

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let db = client.database(database);
    let coll = db.collection::<mongodb::bson::Document>(collection);

    // Convert filter serde_json::Value to BSON Document
    let filter_doc = mongodb::bson::to_document(&filter_val)
        .map_err(|e| format!("BSON conversion error: {}", e))?;

    // Convert sort serde_json::Value to BSON Document
    let sort_doc: Option<mongodb::bson::Document> =
        if sort_val.is_object() && !sort_val.as_object().unwrap().is_empty() {
            let doc = mongodb::bson::to_document(&sort_val)
                .map_err(|e| format!("BSON conversion error: {}", e))?;
            Some(doc)
        } else {
            None
        };

    let mut find_builder = coll.find(filter_doc);
    if let Some(sort) = sort_doc {
        find_builder = find_builder.sort(sort);
    }
    if let Some(projection) = projection_doc {
        find_builder = find_builder.projection(projection);
    }
    if limit > 0 {
        find_builder = find_builder.limit(limit);
    }
    if skip > 0 {
        find_builder = find_builder.skip(skip as u64);
    }

    let mut cursor = find_builder
        .await
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut results = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
        let json_val: serde_json::Value =
            serde_json::to_value(&doc).map_err(|e| format!("BSON to JSON error: {}", e))?;
        results.push(serde_json::to_string(&json_val).unwrap());
    }

    Ok(results)
}

pub async fn count_documents_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return mock_db::count_mock_documents(database, collection, filter);
    }

    let trimmed = filter.trim();
    let is_empty_filter = trimmed.is_empty() || trimmed == "{}";

    let filter_val: serde_json::Value = if is_empty_filter {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(filter).map_err(|e| format!("Invalid MQL filter JSON: {}", e))?
    };
    let filter_doc = mongodb::bson::to_document(&filter_val)
        .map_err(|e| format!("BSON conversion error: {}", e))?;

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

    // Empty filter: use the fast metadata estimate instead of a full scan.
    let count = if is_empty_filter {
        coll.estimated_document_count()
            .await
            .map_err(|e| format!("Failed to estimate document count: {}", e))?
    } else {
        coll.count_documents(filter_doc)
            .await
            .map_err(|e| format!("Count failed: {}", e))?
    };
    Ok(count)
}

pub async fn explain_mql_query_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<String, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok(mock_db::get_mock_explain(database, collection, filter));
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let db = client.database(database);
    let filter_val: serde_json::Value = if filter.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(filter).map_err(|e| format!("Invalid MQL filter JSON: {}", e))?
    };

    let filter_doc = mongodb::bson::to_document(&filter_val)
        .map_err(|e| format!("BSON conversion error: {}", e))?;

    let command = mongodb::bson::doc! {
        "explain": {
            "find": collection,
            "filter": filter_doc
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
