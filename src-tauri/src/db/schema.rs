//! Collection schema analysis (M6): sample documents and infer per-field types.

use crate::state::LockExt;
use crate::{mock_db, require_real_client, AppState};
use serde::Serialize;

#[derive(Serialize)]
pub struct TypeCount {
    #[serde(rename = "type")]
    pub type_name: String,
    pub count: usize,
}

#[derive(Serialize)]
pub struct FieldStat {
    pub path: String,
    pub types: Vec<TypeCount>,
    pub presence: usize,
    pub coverage: f64,
}

#[derive(Serialize)]
pub struct SchemaReport {
    pub sampled: usize,
    pub fields: Vec<FieldStat>,
}

fn bson_type_label(b: &mongodb::bson::Bson) -> &'static str {
    use mongodb::bson::Bson;
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binary",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Decimal128(_) => "decimal",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Symbol(_) => "symbol",
        Bson::MinKey => "minKey",
        Bson::MaxKey => "maxKey",
        Bson::Undefined => "undefined",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// Infer a per-field schema (dotted nested paths, type counts, coverage) from a
/// sample of documents. Pure and deterministic (fields sorted by path).
pub fn infer_schema(docs: &[mongodb::bson::Document]) -> SchemaReport {
    use mongodb::bson::Bson;
    use std::collections::BTreeMap;

    // path -> documents containing it; path -> (type label -> count)
    let mut presence: BTreeMap<String, usize> = BTreeMap::new();
    let mut type_counts: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();

    fn walk(
        prefix: &str,
        doc: &mongodb::bson::Document,
        presence: &mut BTreeMap<String, usize>,
        type_counts: &mut BTreeMap<String, BTreeMap<String, usize>>,
    ) {
        for (k, v) in doc.iter() {
            let path = if prefix.is_empty() {
                k.clone()
            } else {
                format!("{}.{}", prefix, k)
            };
            *presence.entry(path.clone()).or_insert(0) += 1;
            *type_counts
                .entry(path.clone())
                .or_default()
                .entry(bson_type_label(v).to_string())
                .or_insert(0) += 1;
            // Recurse into embedded documents; arrays are not recursed (YAGNI).
            if let Bson::Document(sub) = v {
                walk(&path, sub, presence, type_counts);
            }
        }
    }

    for d in docs {
        walk("", d, &mut presence, &mut type_counts);
    }

    let sampled = docs.len();
    let fields = presence
        .into_iter()
        .map(|(path, pres)| {
            let types = type_counts
                .get(&path)
                .map(|m| {
                    m.iter()
                        .map(|(t, c)| TypeCount {
                            type_name: t.clone(),
                            count: *c,
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let coverage = if sampled == 0 {
                0.0
            } else {
                pres as f64 / sampled as f64
            };
            FieldStat {
                path,
                types,
                presence: pres,
                coverage,
            }
        })
        .collect();

    SchemaReport { sampled, fields }
}

pub async fn analyze_schema_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    sample_size: i64,
) -> Result<String, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    let docs: Vec<mongodb::bson::Document> = if is_mock {
        // Mock connections can't aggregate; sample the demo data via find.
        let rows = mock_db::execute_mock_query(database, collection, "", "", sample_size, 0)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let val: serde_json::Value =
                serde_json::from_str(&row).map_err(|e| format!("Mock doc parse error: {}", e))?;
            let doc = mongodb::bson::to_document(&val)
                .map_err(|e| format!("Mock doc conversion error: {}", e))?;
            out.push(doc);
        }
        out
    } else {
        let client = require_real_client(state, id)?;
        let coll = client
            .database(database)
            .collection::<mongodb::bson::Document>(collection);
        let pipeline = vec![mongodb::bson::doc! { "$sample": { "size": sample_size } }];
        let mut cursor = coll
            .aggregate(pipeline)
            .await
            .map_err(|e| format!("Sampling failed: {}", e))?;
        let mut out = Vec::new();
        use futures::stream::StreamExt;
        while let Some(result) = cursor.next().await {
            out.push(result.map_err(|e| format!("Cursor read error: {}", e))?);
        }
        out
    };

    let report = infer_schema(&docs);
    serde_json::to_string(&report).map_err(|e| format!("Serialization error: {}", e))
}
