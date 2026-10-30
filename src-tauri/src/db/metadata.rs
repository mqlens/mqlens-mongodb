//! Database metadata and index management.

use crate::state::LockExt;
use crate::write_guard::{guard_writable, WriteOp};
use crate::{mock_db, AppState, CollectionInfo, IndexInfo};
use mongodb::bson::{doc, Bson, Document};

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

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::metadata::list_databases(state, &conn).await;
        }
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

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::metadata::list_collections(state, &conn, db).await;
        }
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

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::metadata::list_indexes(state, &conn, db, collection).await;
        }
    };

    // As a raw command: the driver's IndexModel drops what it does not know.
    let mut cursor = client
        .database(db)
        .run_cursor_command(doc! { "listIndexes": collection })
        .await
        .map_err(|e| format!("Failed to list indexes: {}", e))?;

    let mut specs = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        specs.push(result.map_err(|e| format!("Index read error: {}", e))?);
    }
    with_simple_collation(&mut specs);

    Ok(specs.iter().map(index_info).collect())
}

/// MongoDB lists the simple collation as no collation at all, while an index
/// created without one takes the collection's default, which `_id_` lists. On
/// such a collection this says so: a rebuild would otherwise change the index,
/// or fail on a type that takes no other collation.
pub(crate) fn with_simple_collation(specs: &mut [Document]) {
    let has_default = specs.iter().any(|spec| {
        spec.get_str("name").is_ok_and(|name| name == "_id_") && spec.contains_key("collation")
    });
    if has_default {
        for spec in specs.iter_mut().filter(|spec| !spec.contains_key("collation")) {
            spec.insert("collation", doc! { "locale": "simple" });
        }
    }
}

/// Relaxed Extended JSON writes an Int64 as a bare number, which JavaScript
/// rounds past 2^53. A rebuild would write the rounded value back.
fn keep_large_integers(value: &mut serde_json::Value) {
    use serde_json::Value;
    const SAFE: u64 = (1 << 53) - 1;
    match value {
        Value::Number(n) if n.as_i64().is_some_and(|n| n.unsigned_abs() > SAFE) => {
            *value = serde_json::json!({ "$numberLong": n.to_string() });
        }
        Value::Array(items) => items.iter_mut().for_each(keep_large_integers),
        Value::Object(fields) => fields.values_mut().for_each(keep_large_integers),
        _ => {}
    }
}

/// What the index document `spec` lists for one index.
pub(crate) fn index_info(spec: &Document) -> IndexInfo {
    let key = spec.get_document("key").cloned().unwrap_or_default();
    let info = IndexInfo {
        name: spec.get_str("name").unwrap_or_default().to_string(),
        // Serialize the real key pattern (preserves field order + direction/type).
        keys: serde_json::to_string(&key).unwrap_or_else(|_| "{}".to_string()),
        unique: is_set(spec, "unique"),
        sparse: is_set(spec, "sparse"),
        ..Default::default()
    };
    with_spec_details(info, spec)
}

/// Whether a flag is on. An index built long ago can hold it as a number.
fn is_set(spec: &Document, field: &str) -> bool {
    match spec.get(field) {
        Some(Bson::Boolean(on)) => *on,
        Some(Bson::Int32(n)) => *n != 0,
        Some(Bson::Int64(n)) => *n != 0,
        Some(Bson::Double(n)) => *n != 0.0,
        _ => false,
    }
}

fn ttl_seconds(spec: &Document) -> Option<i64> {
    match spec.get("expireAfterSeconds") {
        Some(Bson::Int32(n)) => Some(i64::from(*n)),
        Some(Bson::Int64(n)) => Some(*n),
        Some(Bson::Double(n)) => Some(*n as i64),
        _ => None,
    }
}

/// `info` with what the index document `spec` says beyond keys and flags: its
/// TTL, whether it is hidden, its partial filter, and the document itself.
pub(crate) fn with_spec_details(mut info: IndexInfo, spec: &Document) -> IndexInfo {
    info.expire_after_seconds = ttl_seconds(spec);
    info.hidden = is_set(spec, "hidden");
    info.partial_filter_expression = spec
        .get_document("partialFilterExpression")
        .ok()
        .and_then(|filter| serde_json::to_string(filter).ok());
    info.spec = (!spec.is_empty()).then(|| {
        let mut json = Bson::Document(spec.clone()).into_relaxed_extjson();
        keep_large_integers(&mut json);
        json.to_string()
    });
    info
}

pub(crate) const TTL_SINGLE_FIELD: &str = "A TTL index must have exactly one key field";
pub(crate) const TTL_NOT_ID: &str = "A TTL index cannot be on _id";
pub(crate) const TTL_RANGE: &str =
    "Expire after seconds must be a whole number from 0 to 2147483647";

fn check_ttl_seconds(seconds: i64) -> Result<(), String> {
    if (0..=i64::from(i32::MAX)).contains(&seconds) {
        Ok(())
    } else {
        Err(TTL_RANGE.to_string())
    }
}

/// MongoDB's rules for a TTL index: one field, not `_id`, a 32-bit expiry.
fn check_ttl(keys: &Document, seconds: i64) -> Result<(), String> {
    if keys.len() != 1 {
        return Err(TTL_SINGLE_FIELD.to_string());
    }
    if keys.contains_key("_id") {
        return Err(TTL_NOT_ID.to_string());
    }
    check_ttl_seconds(seconds)
}

fn set_expiry_command(collection: &str, index_name: &str, seconds: i64) -> Document {
    doc! {
        "collMod": collection,
        "index": { "name": index_name, "expireAfterSeconds": seconds },
    }
}

/// Changes a TTL index's expiry in place with `collMod`, without rebuilding it.
pub async fn set_index_expiry_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    expire_after_seconds: i64,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let result =
        set_index_expiry_inner(state, id, db, collection, index_name, expire_after_seconds).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "set_index_expiry",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("collMod {db}.{collection}.{index_name} expireAfterSeconds={expire_after_seconds}"),
        None,
        &result,
    );
    result
}

async fn set_index_expiry_inner(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    expire_after_seconds: i64,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CollMod, false)?;
    check_ttl_seconds(expire_after_seconds)?;

    if crate::connection_is_mock(state, id)? {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        let list = mock_indexes
            .entry(key)
            .or_insert_with(|| mock_db::get_mock_indexes(db, collection));
        return match list
            .iter_mut()
            .find(|i| i.name == index_name && i.expire_after_seconds.is_some())
        {
            Some(index) => {
                index.expire_after_seconds = Some(expire_after_seconds);
                Ok(())
            }
            None => Err(format!("Index {index_name} has no TTL to change")),
        };
    }

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::ddl::set_index_expiry(
                state, &conn, db, collection, index_name, expire_after_seconds,
            )
            .await;
        }
    };
    client
        .database(db)
        .run_command(set_expiry_command(collection, index_name, expire_after_seconds))
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to change the index expiry: {}", e))
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
    expire_after_seconds: Option<i64>,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let result = create_index_inner(state, id, db, collection, index_name, keys, unique, sparse, expire_after_seconds).await;
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
    expire_after_seconds: Option<i64>,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CreateIndex, false)?;

    let value: serde_json::Value =
        serde_json::from_str(keys).map_err(|e| format!("Invalid JSON keys: {}", e))?;
    let keys_doc = mongodb::bson::to_document(&value)
        .map_err(|e| format!("Failed to convert keys JSON to BSON: {}", e))?;
    if let Some(seconds) = expire_after_seconds {
        check_ttl(&keys_doc, seconds)?;
    }

    let mut spec = doc! { "key": keys_doc, "name": index_name };
    if unique {
        spec.insert("unique", true);
    }
    if sparse {
        spec.insert("sparse", true);
    }
    if let Some(seconds) = expire_after_seconds {
        // Checked above to fit.
        spec.insert("expireAfterSeconds", seconds as i32);
    }
    create_from_spec(state, id, db, collection, spec, None).await
}

pub(crate) const SPEC_SHAPE: &str = "An index document needs a name and a key with at least one field";
pub(crate) const NO_REMOTE_COMMIT_QUORUM: &str =
    "MQLens Server connections cannot set a commit quorum yet";

/// An index document as the UI sends it, in Extended JSON so a date in a
/// partial filter stays a date.
fn parse_index_spec(spec: &str) -> Result<Document, String> {
    let value: serde_json::Value =
        serde_json::from_str(spec).map_err(|e| format!("Invalid index document: {e}"))?;
    let spec = match Bson::try_from(value) {
        Ok(Bson::Document(spec)) => spec,
        Ok(_) => return Err(SPEC_SHAPE.to_string()),
        Err(e) => return Err(format!("Invalid index document: {e}")),
    };
    let named = spec.get_str("name").is_ok_and(|name| !name.is_empty());
    let keyed = spec.get_document("key").is_ok_and(|key| !key.is_empty());
    if named && keyed {
        Ok(spec)
    } else {
        Err(SPEC_SHAPE.to_string())
    }
}

/// A number of voting members, or the name of a quorum.
fn commit_quorum(value: &str) -> Bson {
    match value.parse::<i32>() {
        Ok(members) => Bson::Int32(members),
        Err(_) => Bson::String(value.to_string()),
    }
}

fn create_indexes_command(collection: &str, spec: Document, quorum: Option<&str>) -> Document {
    let mut command = doc! { "createIndexes": collection, "indexes": [spec] };
    if let Some(quorum) = quorum {
        command.insert("commitQuorum", commit_quorum(quorum));
    }
    command
}

/// Creates an index from its whole document, every option in it.
pub async fn create_index_spec_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    spec: &str,
    commit_quorum: Option<&str>,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let result = create_index_spec_inner(state, id, db, collection, spec, commit_quorum).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "create_index",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("createIndex {db}.{collection}"),
        Some(spec),
        &result,
    );
    result
}

async fn create_index_spec_inner(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    spec: &str,
    commit_quorum: Option<&str>,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CreateIndex, false)?;
    let spec = parse_index_spec(spec)?;
    create_from_spec(state, id, db, collection, spec, commit_quorum).await
}

async fn create_from_spec(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    spec: Document,
    commit_quorum: Option<&str>,
) -> Result<(), String> {
    if let Some(seconds) = ttl_seconds(&spec) {
        check_ttl(&spec.get_document("key").cloned().unwrap_or_default(), seconds)?;
    }

    if crate::connection_is_mock(state, id)? {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        let list = mock_indexes
            .entry(key)
            .or_insert_with(|| mock_db::get_mock_indexes(db, collection));
        let info = index_info(&spec);
        if !list.iter().any(|i| i.name == info.name) {
            list.push(info);
        }
        return Ok(());
    }

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            if commit_quorum.is_some() {
                return Err(NO_REMOTE_COMMIT_QUORUM.to_string());
            }
            return crate::server::ops::write::create_index(state, &conn, db, collection, &spec)
                .await;
        }
    };

    client
        .database(db)
        .run_command(create_indexes_command(collection, spec, commit_quorum))
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to create index: {}", e))
}

/// An option `collMod` changes on an index in place, named as MongoDB names it.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IndexOption {
    Hidden,
    PrepareUnique,
    Unique,
}

impl IndexOption {
    fn field(self) -> &'static str {
        match self {
            IndexOption::Hidden => "hidden",
            IndexOption::PrepareUnique => "prepareUnique",
            IndexOption::Unique => "unique",
        }
    }
}

fn set_option_command(
    collection: &str,
    index_name: &str,
    option: IndexOption,
    value: bool,
) -> Document {
    let mut index = doc! { "name": index_name };
    index.insert(option.field(), value);
    doc! { "collMod": collection, "index": index }
}

/// Hides or shows an index, or moves it towards unique, without rebuilding it.
/// MongoDB will not make an index non-unique, and says so.
pub async fn set_index_option_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    option: IndexOption,
    value: bool,
) -> Result<(), String> {
    crate::server::routes::refuse_deferred(state, "set_index_option", &[id])?;
    let started = std::time::Instant::now();
    let result = set_index_option_inner(state, id, db, collection, index_name, option, value).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "set_index_option",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("collMod {db}.{collection}.{index_name} {}={value}", option.field()),
        None,
        &result,
    );
    result
}

async fn set_index_option_inner(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    option: IndexOption,
    value: bool,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CollMod, false)?;

    if crate::connection_is_mock(state, id)? {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        let list = mock_indexes
            .entry(key)
            .or_insert_with(|| mock_db::get_mock_indexes(db, collection));
        let index = list
            .iter_mut()
            .find(|i| i.name == index_name)
            .ok_or_else(|| format!("Index {index_name} was not found"))?;
        let mut spec = parse_index_spec(index.spec.as_deref().unwrap_or_default())?;
        if option == IndexOption::Unique && !is_set(&spec, "prepareUnique") {
            return Err(
                "Cannot make index unique with 'prepareUnique=false'. Run collMod to set it first."
                    .to_string(),
            );
        }
        spec.insert(option.field(), value);
        *index = index_info(&spec);
        return Ok(());
    }

    let crate::server::remote::Route::Local(client) = crate::server::remote::route(state, id)?
    else {
        return Err(crate::server::remote::NOT_SERVED.to_string());
    };
    client
        .database(db)
        .run_command(set_option_command(collection, index_name, option, value))
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to change the index: {}", e))
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

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            use crate::server::ops::write;
            return write::drop_index(state, &conn, db, collection, index_name).await;
        }
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

    async fn mock_connection() -> (AppState, String) {
        let state = AppState::new();
        let id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .unwrap();
        (state, id)
    }

    async fn listed(state: &AppState, id: &str, name: &str) -> IndexInfo {
        list_indexes_impl(state, id, "sales_db", "customers")
            .await
            .unwrap()
            .into_iter()
            .find(|i| i.name == name)
            .unwrap()
    }

    // The document as listIndexes gives it: the common options reach their
    // fields, and the whole of it stays on `spec`, the driver's model dropping
    // what it does not know, such as prepareUnique.
    #[test]
    fn an_index_lists_every_option_of_its_document() {
        let spec = mongodb::bson::doc! {
            "v": 2, "key": { "createdAt": 1 }, "name": "createdAt_1", "unique": true,
            "sparse": 1, "expireAfterSeconds": 86400, "hidden": true,
            "partialFilterExpression": { "archived": true },
            "prepareUnique": true, "collation": { "locale": "de", "strength": 2 },
        };
        let info = index_info(&spec);
        assert_eq!(info.name, "createdAt_1");
        assert_eq!(info.keys, r#"{"createdAt":1}"#);
        assert!(info.unique && info.sparse && info.hidden);
        assert_eq!(info.expire_after_seconds, Some(86400));
        assert_eq!(
            info.partial_filter_expression.as_deref(),
            Some(r#"{"archived":true}"#)
        );
        let listed: serde_json::Value =
            serde_json::from_str(info.spec.as_deref().unwrap()).unwrap();
        assert_eq!(listed["prepareUnique"], true);
        assert_eq!(listed["collation"]["strength"], 2);
    }

    // MongoDB lists the simple collation as none, and an index created without
    // one takes the collection's default, which `_id_` lists.
    #[test]
    fn an_index_on_a_collated_collection_says_when_it_is_simple() {
        let mut specs = vec![
            doc! { "key": { "_id": 1 }, "name": "_id_", "collation": { "locale": "en" } },
            doc! { "key": { "a": 1 }, "name": "a_1" },
            doc! { "key": { "b": 1 }, "name": "b_1", "collation": { "locale": "de" } },
        ];
        with_simple_collation(&mut specs);
        assert_eq!(specs[1].get_document("collation").unwrap(), &doc! { "locale": "simple" });
        assert_eq!(specs[2].get_document("collation").unwrap(), &doc! { "locale": "de" });

        let mut plain = vec![
            doc! { "key": { "_id": 1 }, "name": "_id_" },
            doc! { "key": { "a": 1 }, "name": "a_1" },
        ];
        with_simple_collation(&mut plain);
        assert!(!plain[1].contains_key("collation"));
    }

    // JavaScript rounds an integer past 2^53, and a rebuild would write it back.
    #[test]
    fn a_large_integer_survives_the_ui() {
        let spec = doc! {
            "key": { "a": 1 }, "name": "a_1",
            "partialFilterExpression": { "$and": [{ "a": { "$gt": 9_007_199_254_740_993_i64 } }] },
        };
        let listed = index_info(&spec).spec.unwrap();
        assert!(listed.contains(r#""$numberLong":"9007199254740993""#), "{listed}");
        assert_eq!(parse_index_spec(&listed).unwrap(), spec);
    }

    // A date in a partial filter is a date, there and back through the UI.
    #[test]
    fn an_index_document_keeps_its_bson_types_through_json() {
        let spec = parse_index_spec(
            r#"{"key":{"a":1},"name":"a_1","partialFilterExpression":{"at":{"$gt":{"$date":"2026-01-01T00:00:00Z"}}}}"#,
        )
        .unwrap();
        let filter = spec.get_document("partialFilterExpression").unwrap();
        assert!(matches!(
            filter.get_document("at").unwrap().get("$gt"),
            Some(mongodb::bson::Bson::DateTime(_))
        ));
        assert_eq!(
            parse_index_spec(index_info(&spec).spec.as_deref().unwrap()).unwrap(),
            spec
        );
    }

    #[test]
    fn an_index_document_needs_a_key_and_a_name() {
        assert!(parse_index_spec("not json").unwrap_err().contains("Invalid index document"));
        assert_eq!(parse_index_spec("[1]").unwrap_err(), SPEC_SHAPE);
        assert_eq!(parse_index_spec(r#"{"name":"a"}"#).unwrap_err(), SPEC_SHAPE);
        assert_eq!(parse_index_spec(r#"{"key":{}, "name":"a"}"#).unwrap_err(), SPEC_SHAPE);
        assert_eq!(parse_index_spec(r#"{"key":{"a":1}}"#).unwrap_err(), SPEC_SHAPE);
    }

    #[tokio::test]
    async fn an_index_document_is_created_whole() {
        let (state, id) = mock_connection().await;
        create_index_spec_impl(
            &state,
            &id,
            "sales_db",
            "customers",
            r#"{"key":{"bio":"text"},"name":"bio_text","default_language":"german","hidden":true}"#,
            None,
        )
        .await
        .unwrap();
        let info = listed(&state, &id, "bio_text").await;
        assert_eq!(info.keys, r#"{"bio":"text"}"#);
        assert!(info.hidden);
        assert!(info.spec.unwrap().contains("german"));
    }

    #[tokio::test]
    async fn a_ttl_in_an_index_document_follows_mongodb_rules() {
        let (state, id) = mock_connection().await;
        let create = |spec: &'static str| {
            let (state, id) = (&state, id.clone());
            async move {
                create_index_spec_impl(state, &id, "sales_db", "customers", spec, None)
                    .await
                    .unwrap_err()
            }
        };
        assert_eq!(
            create(r#"{"key":{"a":1,"b":1},"name":"t","expireAfterSeconds":60}"#).await,
            TTL_SINGLE_FIELD
        );
        assert_eq!(
            create(r#"{"key":{"_id":1},"name":"t","expireAfterSeconds":60}"#).await,
            TTL_NOT_ID
        );
        assert_eq!(
            create(r#"{"key":{"a":1},"name":"t","expireAfterSeconds":-1}"#).await,
            TTL_RANGE
        );
    }

    #[test]
    fn a_commit_quorum_is_a_member_count_or_a_name() {
        use mongodb::bson::Bson;
        assert_eq!(commit_quorum("2"), Bson::Int32(2));
        assert_eq!(commit_quorum("majority"), Bson::String("majority".into()));
        assert_eq!(commit_quorum("votingMembers"), Bson::String("votingMembers".into()));
    }

    // createIndexes' own shape, as MongoDB documents it.
    #[test]
    fn the_create_is_a_create_indexes_with_the_whole_document() {
        let spec = mongodb::bson::doc! { "key": { "a": 1 }, "name": "a_1", "hidden": true };
        assert_eq!(
            create_indexes_command("events", spec.clone(), None),
            mongodb::bson::doc! { "createIndexes": "events", "indexes": [spec.clone()] }
        );
        assert_eq!(
            create_indexes_command("events", spec.clone(), Some("majority")),
            mongodb::bson::doc! {
                "createIndexes": "events", "indexes": [spec], "commitQuorum": "majority",
            }
        );
    }

    // Payloads for an index without any of these stay exactly as they were.
    #[test]
    fn a_plain_index_serializes_as_before() {
        let plain = IndexInfo {
            name: "a_1".into(),
            keys: r#"{"a":1}"#.into(),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            serde_json::json!({ "name": "a_1", "keys": "{\"a\":1}", "unique": false, "sparse": false })
        );
        let ttl = IndexInfo {
            expire_after_seconds: Some(60),
            hidden: true,
            partial_filter_expression: Some("{}".into()),
            ..plain
        };
        let value = serde_json::to_value(&ttl).unwrap();
        assert_eq!(value["expireAfterSeconds"], 60);
        assert_eq!(value["hidden"], true);
        assert_eq!(value["partialFilterExpression"], "{}");
    }

    #[tokio::test]
    async fn a_ttl_index_is_created_and_listed_with_its_expiry() {
        let (state, id) = mock_connection().await;
        create_index_impl(
            &state, &id, "sales_db", "customers", "createdAt_1", r#"{"createdAt":1}"#, false,
            false, Some(3600),
        )
        .await
        .unwrap();
        assert_eq!(
            listed(&state, &id, "createdAt_1").await.expire_after_seconds,
            Some(3600)
        );
    }

    // MongoDB's rules for a TTL index, refused before any request.
    #[tokio::test]
    async fn a_ttl_index_follows_mongodb_rules() {
        let (state, id) = mock_connection().await;
        let create = |keys: &'static str, ttl: i64| {
            let (state, id) = (&state, id.clone());
            async move {
                create_index_impl(state, &id, "sales_db", "customers", "t", keys, false, false, Some(ttl))
                    .await
                    .unwrap_err()
            }
        };
        assert_eq!(create(r#"{"a":1,"b":1}"#, 60).await, TTL_SINGLE_FIELD);
        assert_eq!(create(r#"{"_id":1}"#, 60).await, TTL_NOT_ID);
        assert_eq!(create(r#"{"a":1}"#, -1).await, TTL_RANGE);
        assert_eq!(create(r#"{"a":1}"#, 2_147_483_648).await, TTL_RANGE);
        assert!(list_indexes_impl(&state, &id, "sales_db", "customers")
            .await
            .unwrap()
            .iter()
            .all(|i| i.name != "t"));
        // The bounds themselves are allowed.
        for (name, ttl) in [("zero", 0), ("max", 2_147_483_647)] {
            create_index_impl(&state, &id, "sales_db", "customers", name, r#"{"a":1}"#, false, false, Some(ttl))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn the_expiry_of_a_ttl_index_changes_in_place() {
        let (state, id) = mock_connection().await;
        create_index_impl(
            &state, &id, "sales_db", "customers", "createdAt_1", r#"{"createdAt":1}"#, false,
            false, Some(3600),
        )
        .await
        .unwrap();
        set_index_expiry_impl(&state, &id, "sales_db", "customers", "createdAt_1", 86400)
            .await
            .unwrap();
        assert_eq!(
            listed(&state, &id, "createdAt_1").await.expire_after_seconds,
            Some(86400)
        );
        assert_eq!(
            set_index_expiry_impl(&state, &id, "sales_db", "customers", "createdAt_1", -5)
                .await
                .unwrap_err(),
            TTL_RANGE
        );
        assert_eq!(
            set_index_expiry_impl(&state, &id, "sales_db", "customers", "email_1", 60)
                .await
                .unwrap_err(),
            "Index email_1 has no TTL to change"
        );
    }

    // collMod's own shape, as MongoDB documents it.
    #[test]
    fn the_option_change_is_a_collmod_on_the_index_name() {
        assert_eq!(
            set_option_command("events", "a_1", IndexOption::Hidden, true),
            doc! { "collMod": "events", "index": { "name": "a_1", "hidden": true } }
        );
        assert_eq!(
            set_option_command("events", "a_1", IndexOption::PrepareUnique, false),
            doc! { "collMod": "events", "index": { "name": "a_1", "prepareUnique": false } }
        );
        assert_eq!(
            set_option_command("events", "a_1", IndexOption::Unique, true),
            doc! { "collMod": "events", "index": { "name": "a_1", "unique": true } }
        );
    }

    #[test]
    fn the_ui_names_the_options_as_mongodb_does() {
        let option = |name: &str| serde_json::from_value::<IndexOption>(name.into()).unwrap();
        assert_eq!(option("hidden"), IndexOption::Hidden);
        assert_eq!(option("prepareUnique"), IndexOption::PrepareUnique);
        assert_eq!(option("unique"), IndexOption::Unique);
    }

    #[tokio::test]
    async fn hiding_an_index_shows_in_its_listing() {
        let (state, id) = mock_connection().await;
        let set = |name: &'static str, on: bool| {
            let (state, id) = (&state, id.clone());
            async move {
                set_index_option_impl(state, &id, "sales_db", "customers", name, IndexOption::Hidden, on).await
            }
        };
        set("email_1", true).await.unwrap();
        assert!(listed(&state, &id, "email_1").await.hidden);
        set("email_1", false).await.unwrap();
        assert!(!listed(&state, &id, "email_1").await.hidden);
        assert_eq!(
            set("nope_1", true).await.unwrap_err(),
            "Index nope_1 was not found"
        );
    }

    // As MongoDB answers: unique only after prepareUnique.
    #[tokio::test]
    async fn an_index_turns_unique_only_once_prepared() {
        let (state, id) = mock_connection().await;
        let set = |option: IndexOption| {
            let (state, id) = (&state, id.clone());
            async move {
                set_index_option_impl(state, &id, "sales_db", "customers", "email_1", option, true).await
            }
        };
        assert!(set(IndexOption::Unique).await.unwrap_err().contains("prepareUnique"));
        set(IndexOption::PrepareUnique).await.unwrap();
        set(IndexOption::Unique).await.unwrap();
        assert!(listed(&state, &id, "email_1").await.unique);
    }

    #[test]
    fn the_expiry_change_is_a_collmod_on_the_index_name() {
        assert_eq!(
            set_expiry_command("events", "createdAt_1", 60),
            mongodb::bson::doc! {
                "collMod": "events",
                "index": { "name": "createdAt_1", "expireAfterSeconds": 60_i64 },
            }
        );
    }
}
