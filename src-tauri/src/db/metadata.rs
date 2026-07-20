//! Database metadata and index management.

use crate::state::LockExt;
use crate::write_guard::{guard_writable, WriteOp};
use crate::{mock_db, AppState, CollectionInfo, IndexInfo};

pub async fn list_databases_impl(state: &AppState, id: &str) -> Result<Vec<String>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok(vec![
            "admin".to_string(),
            "config".to_string(),
            "local".to_string(),
            "sales_db".to_string(),
            "user_analytics".to_string(),
        ]);
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let dbs = client
        .list_database_names()
        .await
        .map_err(|e| format!("Failed to list databases: {}", e))?;

    Ok(dbs)
}

pub async fn list_collections_impl(
    state: &AppState,
    id: &str,
    db: &str,
) -> Result<Vec<CollectionInfo>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok(mock_db::get_mock_collections(db)
            .into_iter()
            .map(|(name, collection_type)| CollectionInfo {
                name,
                collection_type: collection_type.to_string(),
            })
            .collect());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let database = client.database(db);
    // Use list_collections (not list_collection_names) so we can read each
    // collection's type and let the UI separate Collections / Views / etc.
    let mut cursor = database
        .list_collections()
        .await
        .map_err(|e| format!("Failed to list collections: {}", e))?;

    let mut collections = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let spec = result.map_err(|e| format!("Collection read error: {}", e))?;
        let collection_type = match spec.collection_type {
            mongodb::results::CollectionType::View => "view",
            mongodb::results::CollectionType::Timeseries => "timeseries",
            _ => "collection",
        };
        collections.push(CollectionInfo {
            name: spec.name,
            collection_type: collection_type.to_string(),
        });
    }

    Ok(collections)
}

pub async fn list_indexes_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
) -> Result<Vec<IndexInfo>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        return Ok(mock_indexes.get(&key).unwrap().clone());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    let mut cursor = coll
        .list_indexes()
        .await
        .map_err(|e| format!("Failed to list indexes: {}", e))?;

    let mut indexes = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let index_model = result.map_err(|e| format!("Index read error: {}", e))?;
        // Serialize the real key pattern (preserves field order + direction/type).
        let keys = serde_json::to_string(&index_model.keys).unwrap_or_else(|_| "{}".to_string());
        let name = index_model
            .options
            .as_ref()
            .and_then(|o| o.name.clone())
            .unwrap_or_default();
        let unique = index_model
            .options
            .as_ref()
            .and_then(|o| o.unique)
            .unwrap_or(false);
        let sparse = index_model
            .options
            .as_ref()
            .and_then(|o| o.sparse)
            .unwrap_or(false);
        indexes.push(IndexInfo {
            name,
            keys,
            unique,
            sparse,
        });
    }

    Ok(indexes)
}

pub async fn create_index_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    keys: &str,
    unique: bool,
    sparse: bool,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CreateIndex, false)?;

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        let list = mock_indexes.get_mut(&key).unwrap();
        if !list.iter().any(|i| i.name == index_name) {
            list.push(IndexInfo {
                name: index_name.to_string(),
                keys: keys.to_string(),
                unique,
                sparse,
            });
        }
        return Ok(());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    let value: serde_json::Value =
        serde_json::from_str(keys).map_err(|e| format!("Invalid JSON keys: {}", e))?;
    let keys_doc = mongodb::bson::to_document(&value)
        .map_err(|e| format!("Failed to convert keys JSON to BSON: {}", e))?;

    let mut options = mongodb::options::IndexOptions::builder()
        .name(index_name.to_string())
        .build();

    if unique {
        options.unique = Some(true);
    }
    if sparse {
        options.sparse = Some(true);
    }

    let model = mongodb::IndexModel::builder()
        .keys(keys_doc)
        .options(options)
        .build();

    coll.create_index(model)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to create index: {}", e))
}

pub async fn delete_index_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::DropIndex, false)?;

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        let list = mock_indexes.get_mut(&key).unwrap();
        list.retain(|x| x.name != index_name);
        return Ok(());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    coll.drop_index(index_name)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to delete index: {}", e))
}
