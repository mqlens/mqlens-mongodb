//! Database metadata and index management.

use crate::state::LockExt;
use crate::write_guard::{guard_writable, WriteOp};
use crate::{mock_db, AppState, CollectionInfo, IndexInfo};

pub async fn list_databases_impl(state: &AppState, id: &str) -> Result<Vec<String>, String> {
    let started = std::time::Instant::now();
    let result = list_databases_impl_inner(state, id).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        None,
        None,
        "list_databases",
        crate::audit::OpClass::ReadHigh,
        None,
        started,
        &"listDatabases".to_string(),
        None,
        &result,
    );
    result
}

async fn list_databases_impl_inner(state: &AppState, id: &str) -> Result<Vec<String>, String> {
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
    let started = std::time::Instant::now();
    let result = list_collections_impl_inner(state, id, db).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        None,
        "list_collections",
        crate::audit::OpClass::ReadHigh,
        None,
        started,
        &format!("listCollections {db}"),
        None,
        &result,
    );
    result
}

/// The type of a collection the server would not describe.
///
/// Deliberately not "collection". Callers decide things from this field, and
/// the two are not the same claim: one says "this is an ordinary collection",
/// the other says "this server did not say". A copy reads it to refuse rather
/// than materialize what might be a view; the sidebar reads it as nothing in
/// particular and draws the generic icon, which is exactly right (#327 review).
pub const UNKNOWN_COLLECTION_TYPE: &str = "unknown";

async fn list_collections_impl_inner(
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
    match full_collection_specs(&database).await {
        Ok(collections) => Ok(collections),
        // Not every MongoDB-compatible service answers `listCollections` with
        // everything the driver's `CollectionSpecification` insists on. It
        // requires `type`, `options` and `info` — and `info.readOnly` as a bare
        // `bool`, with no default anywhere — while Azure Cosmos DB replies with
        // little more than the name. One missing field fails the whole listing,
        // so the tree came up empty while the database's own popover, which
        // asks `dbStats` instead, cheerfully reported the right count (#327).
        //
        // Names alone go out as `nameOnly: true`, which such a service can
        // satisfy, and the driver then reads back only the name. Collections
        // without their type are worth far more than no collections: everything
        // shows as a plain collection, so a view is mislabelled rather than
        // missing.
        Err(spec_error) => {
            let names = database.list_collection_names().await.map_err(|names_error| {
                // Both failures, because the first one is the interesting one:
                // it says what the server would not give, and the second only
                // confirms the fallback did not help either.
                format!("Failed to list collections: {spec_error}; names only: {names_error}")
            })?;
            Ok(names
                .into_iter()
                .map(|name| CollectionInfo {
                    name,
                    collection_type: UNKNOWN_COLLECTION_TYPE.to_string(),
                })
                .collect())
        }
    }
}

/// Every collection with its type, as `listCollections` reports it.
///
/// Preferred because the type is what lets the UI separate Collections from
/// Views and time-series; see the fallback above for when a server cannot
/// answer in that much detail.
async fn full_collection_specs(
    database: &mongodb::Database,
) -> Result<Vec<CollectionInfo>, String> {
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
    let started = std::time::Instant::now();
    let result = list_indexes_impl_inner(state, id, db, collection).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "list_indexes",
        crate::audit::OpClass::ReadHigh,
        None,
        started,
        &format!("listIndexes {db}.{collection}"),
        None,
        &result,
    );
    result
}

async fn list_indexes_impl_inner(
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
    let started = std::time::Instant::now();
    let result = create_index_inner(state, id, db, collection, index_name, keys, unique, sparse).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "create_index",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("createIndex {db}.{collection}.{index_name}"),
        Some(keys),
        &result,
    );
    result
}

async fn create_index_inner(
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
    let started = std::time::Instant::now();
    let result = delete_index_inner(state, id, db, collection, index_name).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "delete_index",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("dropIndex {db}.{collection}.{index_name}"),
        None,
        &result,
    );
    result
}

async fn delete_index_inner(
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The reply a server like Azure Cosmos DB gives to `listCollections`: the
    /// name, and not much else.
    fn sparse_listing_entry() -> mongodb::bson::Document {
        mongodb::bson::doc! { "name": "customers" }
    }

    /// #327: the driver's own type is what fails, before any of our code runs.
    ///
    /// `CollectionSpecification` requires `type`, `options` and `info`, and
    /// `info.readOnly` as a bare bool, with a default on none of them. A server
    /// that answers with less cannot be deserialized into it at all, so the
    /// cursor yields an error, the listing returns `Err`, and the sidebar shows
    /// an empty database — while `dbStats` beside it reports the real count.
    ///
    /// A Cosmos instance is the one thing this cannot be run against here: both
    /// MongoDB-API emulator images are builds whose evaluation period expired,
    /// and the current Linux emulator serves the NoSQL API only. So this pins
    /// the mechanism at the point where it actually breaks — the shape the
    /// driver will not accept — which is checkable without any server at all.
    #[test]
    fn the_driver_cannot_read_a_listing_that_omits_type_options_and_info() {
        let missing_field = |d: mongodb::bson::Document| {
            mongodb::bson::from_document::<mongodb::results::CollectionSpecification>(d)
                .err()
                .expect(
                    "if the driver ever accepts a partial listing, the fallback is dead code \
                     and should be deleted along with this test",
                )
                .to_string()
        };

        // One required field at a time, each refused in turn. Naming them keeps
        // this honest: the listing fails for the reason claimed, not because the
        // document was malformed in some other way.
        assert!(missing_field(sparse_listing_entry()).contains("missing field `type`"));
        assert!(missing_field(mongodb::bson::doc! {
            "name": "customers", "type": "collection"
        })
        .contains("missing field `options`"));
        assert!(missing_field(mongodb::bson::doc! {
            "name": "customers", "type": "collection", "options": {}
        })
        .contains("missing field `info`"));
        // And `info.readOnly` is a bare bool with no default of its own, so even
        // an `info` that is present but empty is not enough.
        assert!(missing_field(mongodb::bson::doc! {
            "name": "customers", "type": "collection", "options": {}, "info": {}
        })
        .contains("missing field `readOnly`"));
    }

    /// The counterpart: what a real MongoDB sends does deserialize, so the
    /// fallback is reached only by servers that answer with less.
    #[test]
    fn a_full_mongodb_listing_still_reads_normally() {
        let spec = mongodb::bson::from_document::<mongodb::results::CollectionSpecification>(
            mongodb::bson::doc! {
                "name": "customers",
                "type": "collection",
                "options": {},
                "info": { "readOnly": false },
            },
        )
        .expect("a complete listing entry must still deserialize");
        assert_eq!(spec.name, "customers");
    }

    /// The other half: what the server *will* answer is enough for names alone,
    /// which is what the fallback asks for.
    #[test]
    fn a_sparse_entry_still_yields_its_name() {
        let name = sparse_listing_entry().get_str("name").unwrap().to_string();
        assert_eq!(name, "customers");
    }

    /// The fallback's type must stay distinguishable from a confirmed one — a
    /// database copy refuses on it rather than materializing what may be a view.
    #[test]
    fn the_unknown_type_is_not_a_claim_about_the_collection() {
        assert_ne!(UNKNOWN_COLLECTION_TYPE, "collection");
        assert_ne!(UNKNOWN_COLLECTION_TYPE, "view");
        assert_ne!(UNKNOWN_COLLECTION_TYPE, "timeseries");
    }
}
