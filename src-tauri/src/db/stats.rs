//! Database / collection / index statistics for the sidebar stats popovers
//! (#178). Same shape as monitoring.rs: pure curation functions (unit-tested)
//! + async `*_impl` wrappers with mock branches for demo mode.

use crate::{connection_is_mock, require_real_client, AppState};
use mongodb::bson::{doc, Bson, Document};
use serde::Serialize;

fn num(d: &Document, key: &str) -> i64 {
    match d.get(key) {
        Some(Bson::Int32(v)) => *v as i64,
        Some(Bson::Int64(v)) => *v,
        Some(Bson::Double(v)) => *v as i64,
        _ => 0,
    }
}
fn fnum(d: &Document, key: &str) -> f64 {
    match d.get(key) {
        Some(Bson::Int32(v)) => *v as f64,
        Some(Bson::Int64(v)) => *v as f64,
        Some(Bson::Double(v)) => *v,
        _ => 0.0,
    }
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbStatsUi {
    pub collections: i64,
    pub views: i64,
    pub objects: i64,
    pub avg_obj_size: f64,
    pub data_size: i64,
    pub storage_size: i64,
    pub indexes: i64,
    pub total_index_size: i64,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollStatsUi {
    pub count: i64,
    pub avg_obj_size: f64,
    pub size: i64,
    pub storage_size: i64,
    pub nindexes: i64,
    pub total_index_size: i64,
    pub capped: bool,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatUi {
    pub name: String,
    pub size_bytes: i64,
    /// Accesses since the counter started ($indexStats); 0 when unavailable.
    pub ops: i64,
    pub since_ms: i64,
}

/// Curate a raw `dbStats` command reply.
pub fn curate_db_stats(raw: &Document) -> DbStatsUi {
    DbStatsUi {
        collections: num(raw, "collections"),
        views: num(raw, "views"),
        objects: num(raw, "objects"),
        avg_obj_size: fnum(raw, "avgObjSize"),
        data_size: num(raw, "dataSize"),
        storage_size: num(raw, "storageSize"),
        indexes: num(raw, "indexes"),
        total_index_size: num(raw, "totalIndexSize"),
    }
}

/// Curate the `storageStats` subdocument of a `$collStats` aggregation result.
pub fn curate_coll_stats(storage: &Document) -> CollStatsUi {
    CollStatsUi {
        count: num(storage, "count"),
        avg_obj_size: fnum(storage, "avgObjSize"),
        size: num(storage, "size"),
        storage_size: num(storage, "storageSize"),
        nindexes: num(storage, "nindexes"),
        total_index_size: num(storage, "totalIndexSize"),
        capped: storage.get_bool("capped").unwrap_or(false),
    }
}

/// Join `$collStats.storageStats.indexSizes` (authoritative index list) with
/// `$indexStats` usage docs; indexes missing from `$indexStats` report zero
/// usage. Sorted by on-disk size, largest first.
pub fn curate_index_stats(index_sizes: &Document, stats_docs: &[Document]) -> Vec<IndexStatUi> {
    let usage = |name: &str| -> (i64, i64) {
        stats_docs
            .iter()
            .find(|d| d.get_str("name").ok() == Some(name))
            .and_then(|d| d.get_document("accesses").ok())
            .map(|a| {
                let since = match a.get("since") {
                    Some(Bson::DateTime(dt)) => dt.timestamp_millis(),
                    _ => 0,
                };
                (num(a, "ops"), since)
            })
            .unwrap_or((0, 0))
    };
    let mut out: Vec<IndexStatUi> = index_sizes
        .iter()
        .map(|(name, size)| {
            let (ops, since_ms) = usage(name);
            IndexStatUi {
                name: name.clone(),
                size_bytes: match size {
                    Bson::Int32(v) => *v as i64,
                    Bson::Int64(v) => *v,
                    Bson::Double(v) => *v as i64,
                    _ => 0,
                },
                ops,
                since_ms,
            }
        })
        .collect();
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

// ── Mock data (demo connections) ─────────────────────────────────────────────

fn mock_db_stats(db: &str) -> DbStatsUi {
    match db {
        "sales_db" => DbStatsUi { collections: 4, views: 0, objects: 12, avg_obj_size: 512.0, data_size: 6_144, storage_size: 24_576, indexes: 10, total_index_size: 40_960 },
        "user_analytics" => DbStatsUi { collections: 2, views: 0, objects: 6, avg_obj_size: 384.0, data_size: 2_304, storage_size: 12_288, indexes: 5, total_index_size: 20_480 },
        _ => DbStatsUi { collections: 2, views: 0, objects: 2, avg_obj_size: 128.0, data_size: 256, storage_size: 8_192, indexes: 2, total_index_size: 8_192 },
    }
}

fn mock_coll_stats() -> CollStatsUi {
    CollStatsUi { count: 3, avg_obj_size: 512.0, size: 1_536, storage_size: 8_192, nindexes: 3, total_index_size: 12_288, capped: false }
}

fn mock_index_stats(db: &str, coll: &str) -> Vec<IndexStatUi> {
    crate::mock_db::get_mock_indexes(db, coll)
        .into_iter()
        .enumerate()
        .map(|(i, info)| IndexStatUi {
            name: info.name.clone(),
            size_bytes: 36_864 - (i as i64) * 8_192,
            ops: if info.name == "_id_" { 10_500 } else { 42 * (i as i64 + 1) },
            since_ms: 1_749_427_200_000,
        })
        .collect()
}

// ── Async command impls ──────────────────────────────────────────────────────

pub async fn db_stats_impl(state: &AppState, id: &str, db: &str) -> Result<DbStatsUi, String> {
    if connection_is_mock(state, id)? {
        return Ok(mock_db_stats(db));
    }
    let client = require_real_client(state, id)?;
    let raw = client
        .database(db)
        .run_command(doc! { "dbStats": 1 })
        .await
        .map_err(|e| format!("dbStats failed: {}", e))?;
    Ok(curate_db_stats(&raw))
}

/// Run `$collStats {storageStats}` and return the first result's storageStats.
async fn coll_storage_stats(
    client: &mongodb::Client,
    db: &str,
    coll: &str,
) -> Result<Document, String> {
    use futures::stream::StreamExt;
    let mut cursor = client
        .database(db)
        .collection::<Document>(coll)
        .aggregate(vec![doc! { "$collStats": { "storageStats": {} } }])
        .await
        .map_err(|e| format!("collStats failed: {}", e))?;
    match cursor.next().await {
        Some(Ok(d)) => Ok(d.get_document("storageStats").cloned().unwrap_or_default()),
        Some(Err(e)) => Err(format!("collStats cursor error: {}", e)),
        None => Ok(Document::new()),
    }
}

pub async fn coll_stats_impl(state: &AppState, id: &str, db: &str, coll: &str) -> Result<CollStatsUi, String> {
    if connection_is_mock(state, id)? {
        return Ok(mock_coll_stats());
    }
    let client = require_real_client(state, id)?;
    let storage = coll_storage_stats(&client, db, coll).await?;
    Ok(curate_coll_stats(&storage))
}

pub async fn index_stats_impl(state: &AppState, id: &str, db: &str, coll: &str) -> Result<Vec<IndexStatUi>, String> {
    if connection_is_mock(state, id)? {
        return Ok(mock_index_stats(db, coll));
    }
    let client = require_real_client(state, id)?;
    let storage = coll_storage_stats(&client, db, coll).await?;
    let index_sizes = storage.get_document("indexSizes").cloned().unwrap_or_default();
    use futures::stream::StreamExt;
    let mut stats_docs: Vec<Document> = Vec::new();
    // $indexStats can fail on views / old servers — degrade to zero usage.
    if let Ok(mut cursor) = client
        .database(db)
        .collection::<Document>(coll)
        .aggregate(vec![doc! { "$indexStats": {} }])
        .await
    {
        while let Some(Ok(d)) = cursor.next().await {
            stats_docs.push(d);
        }
    }
    Ok(curate_index_stats(&index_sizes, &stats_docs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, DateTime};

    #[test]
    fn curates_db_stats_subset() {
        let raw = doc! {
            "db": "sales_db", "collections": 4i32, "views": 1i32, "objects": 12_345i64,
            "avgObjSize": 512.5, "dataSize": 6_324_712i64, "storageSize": 2_502_656i64,
            "indexes": 9i32, "totalIndexSize": 1_105_920i64, "ok": 1.0,
        };
        let s = curate_db_stats(&raw);
        assert_eq!(s.collections, 4);
        assert_eq!(s.views, 1);
        assert_eq!(s.objects, 12_345);
        assert_eq!(s.avg_obj_size, 512.5);
        assert_eq!(s.data_size, 6_324_712);
        assert_eq!(s.storage_size, 2_502_656);
        assert_eq!(s.indexes, 9);
        assert_eq!(s.total_index_size, 1_105_920);
    }

    #[test]
    fn db_stats_resilient_to_missing_fields() {
        let s = curate_db_stats(&doc! { "db": "x" });
        assert_eq!(s, DbStatsUi::default());
    }

    #[test]
    fn curates_coll_stats_from_storage_stats() {
        let storage = doc! {
            "count": 5_000i64, "avgObjSize": 256i32, "size": 1_280_000i64,
            "storageSize": 540_672i64, "nindexes": 3i32, "totalIndexSize": 122_880i64,
            "capped": false,
        };
        let s = curate_coll_stats(&storage);
        assert_eq!(s.count, 5_000);
        assert_eq!(s.avg_obj_size, 256.0);
        assert_eq!(s.size, 1_280_000);
        assert_eq!(s.storage_size, 540_672);
        assert_eq!(s.nindexes, 3);
        assert_eq!(s.total_index_size, 122_880);
        assert!(!s.capped);
    }

    #[test]
    fn curates_index_stats_joining_sizes_and_usage() {
        let sizes = doc! { "_id_": 36_864i64, "email_1": 20_480i64, "unused_1": 8_192i64 };
        let stats = vec![
            doc! { "name": "_id_", "accesses": { "ops": 10_500i64, "since": DateTime::from_millis(1_700_000_000_000) } },
            doc! { "name": "email_1", "accesses": { "ops": 42i64, "since": DateTime::from_millis(1_700_000_000_000) } },
            // "unused_1" intentionally absent from $indexStats output.
        ];
        let out = curate_index_stats(&sizes, &stats);
        assert_eq!(out.len(), 3);
        let id = out.iter().find(|i| i.name == "_id_").unwrap();
        assert_eq!(id.size_bytes, 36_864);
        assert_eq!(id.ops, 10_500);
        assert_eq!(id.since_ms, 1_700_000_000_000);
        let unused = out.iter().find(|i| i.name == "unused_1").unwrap();
        assert_eq!(unused.size_bytes, 8_192);
        assert_eq!(unused.ops, 0, "index absent from $indexStats reports zero usage");
        assert_eq!(unused.since_ms, 0);
    }

    #[test]
    fn index_stats_sorted_by_size_desc() {
        let sizes = doc! { "small_1": 100i64, "big_1": 900i64 };
        let out = curate_index_stats(&sizes, &[]);
        assert_eq!(out[0].name, "big_1");
        assert_eq!(out[1].name, "small_1");
    }
}
