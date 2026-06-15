//! Collection schema analysis (M6): sample documents and infer per-field types.

use crate::limits::normalize_schema_sample;
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
    #[serde(rename = "enumValues", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
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

const ENUM_MAX: usize = 25;

/// Returns the canonical string form of a scalar value eligible for enum
/// detection (string/number/bool), or None for anything else (objects, arrays,
/// ObjectId, dates, null, etc. are not enum candidates).
fn enum_scalar(b: &mongodb::bson::Bson) -> Option<String> {
    use mongodb::bson::Bson;
    match b {
        Bson::String(s) => Some(s.clone()),
        Bson::Int32(n) => Some(n.to_string()),
        Bson::Int64(n) => Some(n.to_string()),
        Bson::Double(n) => Some(n.to_string()),
        Bson::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Infer a per-field schema (dotted nested paths, type counts, coverage) from a
/// sample of documents. Pure and deterministic (fields sorted by path).
pub fn infer_schema(docs: &[mongodb::bson::Document]) -> SchemaReport {
    use mongodb::bson::Bson;
    use std::collections::{BTreeMap, BTreeSet};

    let mut presence: BTreeMap<String, usize> = BTreeMap::new();
    let mut type_counts: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    // Enum tracking: distinct scalar values per path; disqualified = saw a
    // non-enumerable value (object/array/objectId/date/...) or exceeded ENUM_MAX.
    let mut values: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut disqualified: BTreeSet<String> = BTreeSet::new();

    fn walk(
        prefix: &str,
        doc: &mongodb::bson::Document,
        presence: &mut BTreeMap<String, usize>,
        type_counts: &mut BTreeMap<String, BTreeMap<String, usize>>,
        values: &mut BTreeMap<String, BTreeSet<String>>,
        disqualified: &mut BTreeSet<String>,
    ) {
        for (k, v) in doc.iter() {
            let path = if prefix.is_empty() { k.clone() } else { format!("{}.{}", prefix, k) };
            *presence.entry(path.clone()).or_insert(0) += 1;
            *type_counts
                .entry(path.clone())
                .or_default()
                .entry(bson_type_label(v).to_string())
                .or_insert(0) += 1;

            if !disqualified.contains(&path) {
                match enum_scalar(v) {
                    Some(s) => {
                        let set = values.entry(path.clone()).or_default();
                        set.insert(s);
                        if set.len() > ENUM_MAX {
                            disqualified.insert(path.clone());
                            values.remove(&path);
                        }
                    }
                    None => {
                        // Null neither adds nor disqualifies; everything else (object,
                        // array, objectId, date, ...) disqualifies the field as an enum.
                        if !matches!(v, Bson::Null) {
                            disqualified.insert(path.clone());
                            values.remove(&path);
                        }
                    }
                }
            }

            if let Bson::Document(sub) = v {
                walk(&path, sub, presence, type_counts, values, disqualified);
            }
        }
    }

    for d in docs {
        walk("", d, &mut presence, &mut type_counts, &mut values, &mut disqualified);
    }

    let sampled = docs.len();
    let fields = presence
        .into_iter()
        .map(|(path, pres)| {
            let types = type_counts
                .get(&path)
                .map(|m| {
                    m.iter()
                        .map(|(t, c)| TypeCount { type_name: t.clone(), count: *c })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let coverage = if sampled == 0 { 0.0 } else { pres as f64 / sampled as f64 };
            let enum_values = if disqualified.contains(&path) {
                None
            } else {
                values.get(&path).filter(|s| !s.is_empty() && s.len() <= ENUM_MAX)
                    .map(|s| s.iter().cloned().collect::<Vec<_>>())
            };
            FieldStat { path, types, presence: pres, coverage, enum_values }
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
    let sample_size = normalize_schema_sample(sample_size);
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

#[cfg(test)]
mod tests {
    use super::infer_schema;
    use mongodb::bson::doc;

    fn field<'a>(r: &'a super::SchemaReport, path: &str) -> &'a super::FieldStat {
        r.fields.iter().find(|f| f.path == path).expect("field present")
    }

    #[test]
    fn detects_low_cardinality_string_enum() {
        let docs = vec![
            doc! {"plan": "Free"}, doc! {"plan": "Team"},
            doc! {"plan": "Free"}, doc! {"plan": "Business"},
        ];
        let r = infer_schema(&docs);
        let e = field(&r, "plan").enum_values.clone().expect("enum");
        assert_eq!(e, vec!["Business".to_string(), "Free".to_string(), "Team".to_string()]);
    }

    #[test]
    fn no_enum_when_too_many_distinct() {
        let docs: Vec<_> = (0..30).map(|i| doc! {"name": format!("n{}", i)}).collect();
        let r = infer_schema(&docs);
        assert!(field(&r, "name").enum_values.is_none());
    }

    #[test]
    fn no_enum_for_non_scalar_or_complex_leaf() {
        let docs = vec![doc! {"tags": ["a", "b"]}, doc! {"addr": {"zip": "1"}}];
        let r = infer_schema(&docs);
        assert!(field(&r, "tags").enum_values.is_none());     // array
        assert!(field(&r, "addr").enum_values.is_none());     // object
        assert!(field(&r, "addr.zip").enum_values.is_some()); // nested scalar still enumerates
    }

    #[test]
    fn enumerates_numbers_and_bools() {
        let docs = vec![doc! {"seats": 3i32, "active": true}, doc! {"seats": 4i32, "active": false}];
        let r = infer_schema(&docs);
        assert_eq!(field(&r, "seats").enum_values.clone().unwrap(), vec!["3".to_string(), "4".to_string()]);
        assert_eq!(field(&r, "active").enum_values.clone().unwrap(), vec!["false".to_string(), "true".to_string()]);
    }
}
