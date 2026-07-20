//! Document mutation and import operations.

use crate::limits::{IMPORT_BATCH_SIZE, MAX_IMPORT_DOCS};
use crate::{connection_is_mock, require_real_client, AppState};

use mongodb::bson::Document;
use std::collections::HashMap;

// Convert a parsed JSON value into a BSON Document, interpreting MongoDB Extended
// JSON (e.g. {"$oid": "..."} -> ObjectId, {"$date": ...} -> DateTime) so that writes
// match documents by their real _id type rather than a literal sub-document.
fn value_to_bson_document(value: serde_json::Value) -> Result<Document, String> {
    let bson = mongodb::bson::Bson::try_from(value)
        .map_err(|e| format!("Invalid BSON/Extended JSON: {}", e))?;
    match bson {
        mongodb::bson::Bson::Document(doc) => Ok(doc),
        _ => Err("Expected a JSON object (e.g. { \"field\": value })".to_string()),
    }
}

// Parse a JSON string into a BSON Document, interpreting MongoDB Extended JSON.
pub fn json_to_bson_document(s: &str) -> Result<Document, String> {
    let value: serde_json::Value =
        serde_json::from_str(s).map_err(|e| format!("Invalid JSON: {}", e))?;
    value_to_bson_document(value)
}

/// Parse a JSON array of documents (`[{…}, {…}]`) — the JSON-array import format.
pub fn parse_json_array_docs(text: &str) -> Result<Vec<Document>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let arr = match value {
        serde_json::Value::Array(arr) => arr,
        _ => return Err("Expected a JSON array of documents".to_string()),
    };
    arr.into_iter().map(value_to_bson_document).collect()
}

/// CSV import parsing options (camelCase over IPC). Defaults reproduce the
/// pre-options behavior exactly.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvImportOptions {
    pub delimiter: String,
    pub quote: String,
    pub skip_lines: u32,
    pub has_headers: bool,
    pub column_types: HashMap<String, CsvColumnType>,
}

impl Default for CsvImportOptions {
    fn default() -> Self {
        Self {
            delimiter: ",".into(),
            quote: "\"".into(),
            skip_lines: 0,
            has_headers: true,
            column_types: HashMap::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CsvColumnType {
    #[default]
    Auto,
    String,
    Number,
    Boolean,
    Date,
    Json,
}

pub fn validate_csv_import_options(o: &CsvImportOptions) -> Result<(), String> {
    if o.delimiter.len() != 1 || !o.delimiter.is_ascii() {
        return Err("CSV delimiter must be a single ASCII character".to_string());
    }
    if o.quote.len() != 1 || !o.quote.is_ascii() {
        return Err("CSV text qualifier must be a single ASCII character".to_string());
    }
    Ok(())
}

pub fn generated_headers(n: usize) -> Vec<String> {
    (1..=n).map(|i| format!("col{}", i)).collect()
}

/// Convert one CSV cell under an explicit or auto type. `row` is 1-based
/// (data rows, excluding the header) for error messages.
fn convert_csv_cell(
    cell: &str,
    column: &str,
    ty: CsvColumnType,
    row: usize,
) -> Result<serde_json::Value, String> {
    let fail = |ty_name: &str| {
        Err(format!(
            "CSV row {}, column \"{}\": cannot convert \"{}\" to {}",
            row, column, cell, ty_name
        ))
    };
    match ty {
        CsvColumnType::Auto => Ok(revive_csv_cell(cell)),
        CsvColumnType::String => Ok(serde_json::Value::String(cell.to_string())),
        CsvColumnType::Number => {
            if let Ok(i) = cell.trim().parse::<i64>() {
                // Route through the canonical EJSON $numberLong wrapper so the
                // revived value is always Bson::Int64, regardless of whether it
                // happens to fit i32 (bson's plain-number TryFrom auto-downcasts
                // in-range integers to Int32, which would make column typing
                // magnitude-dependent instead of deterministic).
                Ok(serde_json::json!({ "$numberLong": i.to_string() }))
            } else if let Ok(f) = cell.trim().parse::<f64>() {
                Ok(serde_json::Value::from(f))
            } else {
                fail("number")
            }
        }
        CsvColumnType::Boolean => match cell.trim().to_ascii_lowercase().as_str() {
            "true" => Ok(serde_json::Value::Bool(true)),
            "false" => Ok(serde_json::Value::Bool(false)),
            _ => fail("boolean"),
        },
        CsvColumnType::Date => {
            // RFC-3339 or epoch millis → canonical EJSON $date, revived to
            // Bson::DateTime by value_to_bson_document.
            let millis: Option<i64> = if let Ok(ms) = cell.trim().parse::<i64>() {
                Some(ms)
            } else {
                mongodb::bson::DateTime::parse_rfc3339_str(cell.trim())
                    .ok()
                    .map(|dt| dt.timestamp_millis())
            };
            match millis {
                Some(ms) => Ok(serde_json::json!({
                    "$date": { "$numberLong": ms.to_string() }
                })),
                None => fail("date (RFC-3339 or epoch millis)"),
            }
        }
        CsvColumnType::Json => serde_json::from_str(cell).or_else(|_| fail("json")),
    }
}

/// Build one document from a CSV record. Missing cells become empty strings
/// (auto) / conversion errors (explicit types other than String).
pub fn csv_record_to_doc(
    headers: &[String],
    record: &csv::StringRecord,
    options: &CsvImportOptions,
    row: usize,
) -> Result<Document, String> {
    let mut map = serde_json::Map::with_capacity(headers.len());
    for (col, header) in headers.iter().enumerate() {
        let cell = record.get(col).unwrap_or("");
        let ty = options
            .column_types
            .get(header)
            .copied()
            .unwrap_or(CsvColumnType::Auto);
        map.insert(header.clone(), convert_csv_cell(cell, header, ty, row)?);
    }
    value_to_bson_document(serde_json::Value::Object(map))
}

/// A CSV cell becomes its JSON value when parseable, otherwise the raw string
/// (matching the frontend importer's `parseCell`).
fn revive_csv_cell(cell: &str) -> serde_json::Value {
    if cell.is_empty() {
        return serde_json::Value::String(String::new());
    }
    serde_json::from_str(cell).unwrap_or_else(|_| serde_json::Value::String(cell.to_string()))
}

pub async fn delete_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    // Parse/validate up front so bad input fails the same way for mock & real.
    let filter_doc = json_to_bson_document(filter)?;

    if connection_is_mock(state, id)? {
        return Ok(1);
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .delete_one(filter_doc)
        .await
        .map_err(|e| format!("Failed to delete document: {}", e))?;
    Ok(res.deleted_count)
}

pub async fn delete_many_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    if connection_is_mock(state, id)? {
        return Ok(0); // mock connections don't persist deletes
    }
    let client = require_real_client(state, id)?;
    let res = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection)
        .delete_many(filter_doc)
        .await
        .map_err(|e| format!("Failed to delete documents: {}", e))?;
    Ok(res.deleted_count)
}

pub async fn update_many_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    update: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    let update_doc = json_to_bson_document(update)?;
    // Require an operator-keyed update ({ "$set": … }); reject bare replacements
    // / empty updates so a bulk op can't silently overwrite whole documents.
    if update_doc.is_empty() || !update_doc.keys().all(|k| k.starts_with('$')) {
        return Err("Update must use operators like $set (e.g. { \"$set\": { … } })".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(0); // mock connections don't persist updates
    }
    let client = require_real_client(state, id)?;
    let res = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection)
        .update_many(filter_doc, update_doc)
        .await
        .map_err(|e| format!("Failed to update documents: {}", e))?;
    Ok(res.modified_count)
}

pub async fn insert_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    document: &str,
) -> Result<String, String> {
    let doc = json_to_bson_document(document)?;

    if connection_is_mock(state, id)? {
        return Ok("mock-inserted-id".to_string());
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .insert_one(doc)
        .await
        .map_err(|e| format!("Failed to insert document: {}", e))?;
    // Return the inserted id as a JSON string (Extended JSON for ObjectId etc.).
    Ok(res.inserted_id.into_relaxed_extjson().to_string())
}

pub async fn update_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    replacement: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    let replacement_doc = json_to_bson_document(replacement)?;

    if connection_is_mock(state, id)? {
        return Ok(1);
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .replace_one(filter_doc, replacement_doc)
        .await
        .map_err(|e| format!("Failed to update document: {}", e))?;
    Ok(res.modified_count)
}

#[derive(serde::Serialize)]
pub struct ImportResult {
    pub inserted: u64,
    pub updated: u64,
    pub skipped: u64,
}

// Bulk-import documents with a duplicate-handling mode:
//   "skip"   - insert_many(ordered:false); duplicate-key rows are counted as skipped.
//   "update" - per doc replace_one({_id}, doc, upsert:true); no _id -> insert.
//   "abort"  - if any incoming _id already exists, write nothing and error.
// Documents are already-validated JSON values from the frontend codec; each is
// converted to BSON here as a safety net.
pub async fn import_documents_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    docs: Vec<serde_json::Value>,
    mode: &str,
) -> Result<ImportResult, String> {
    // Convert all docs up front; a bad doc fails the whole import before writing.
    let mut bson_docs: Vec<Document> = Vec::with_capacity(docs.len());
    for value in docs {
        bson_docs.push(value_to_bson_document(value)?);
    }
    finalize_import(state, id, database, collection, bson_docs, mode).await
}

/// Enforce the batch cap, short-circuit mock connections (validate only), then
/// write the documents to the live collection under the duplicate-handling mode.
async fn finalize_import(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    bson_docs: Vec<Document>,
    mode: &str,
) -> Result<ImportResult, String> {
    if bson_docs.len() > MAX_IMPORT_DOCS {
        return Err(format!(
            "Import too large ({} documents). Maximum per batch is {} — split the file or use collection export/import on disk.",
            bson_docs.len(),
            MAX_IMPORT_DOCS
        ));
    }

    if connection_is_mock(state, id)? {
        // Mock connections validate but do not persist.
        return Ok(match mode {
            "update" => ImportResult {
                inserted: 0,
                updated: bson_docs.len() as u64,
                skipped: 0,
            },
            _ => ImportResult {
                inserted: bson_docs.len() as u64,
                updated: 0,
                skipped: 0,
            },
        });
    }

    let client = require_real_client(state, id)?;
    let coll = client.database(database).collection::<Document>(collection);
    write_imported_docs(&coll, bson_docs, mode).await
}

/// Insert already-converted BSON documents in `IMPORT_BATCH_SIZE` chunks, no
/// upsert/dedup bookkeeping. Hoisted out of `write_imported_docs` (Task 3,
/// data generation) as the narrower reuse for pure-insert callers:
/// `write_imported_docs`'s "skip"/"abort" modes both run an `existing_ids`
/// `$in` lookup per batch to detect duplicate `_id`s before inserting, which
/// is wasted work for a caller — like the generate task — that only ever
/// inserts freshly generated documents and has no upsert/duplicate semantics
/// to honor. `pub(crate)` so `db::generate` can call it directly.
pub(crate) async fn insert_many_batched(
    coll: &mongodb::Collection<Document>,
    docs: Vec<Document>,
) -> Result<(), String> {
    for chunk in docs.chunks(IMPORT_BATCH_SIZE) {
        if chunk.is_empty() {
            continue;
        }
        coll.insert_many(chunk.to_vec())
            .await
            .map_err(|e| format!("Failed to import: {}", e))?;
    }
    Ok(())
}

/// Write already-converted BSON documents to a live collection under the
/// duplicate-handling mode. Shared by the JSON-value and file import paths.
pub(crate) async fn write_imported_docs(
    coll: &mongodb::Collection<Document>,
    bson_docs: Vec<Document>,
    mode: &str,
) -> Result<ImportResult, String> {
    // Collect the set of incoming _ids that already exist in the collection,
    // keyed by their stringified BSON (same rendering on both sides). Used by
    // skip (partition) and abort (pre-check) so we never rely on bulk-write
    // error introspection, which varies across driver versions.
    async fn existing_ids(
        coll: &mongodb::Collection<mongodb::bson::Document>,
        docs: &[mongodb::bson::Document],
    ) -> Result<std::collections::HashSet<String>, String> {
        let ids: Vec<mongodb::bson::Bson> =
            docs.iter().filter_map(|d| d.get("_id").cloned()).collect();
        let mut found = std::collections::HashSet::new();
        if ids.is_empty() {
            return Ok(found);
        }
        use futures::stream::StreamExt;
        for chunk in ids.chunks(IMPORT_BATCH_SIZE) {
            let mut cursor = coll
                .find(mongodb::bson::doc! { "_id": { "$in": chunk } })
                .await
                .map_err(|e| format!("Failed to check existing documents: {}", e))?;
            while let Some(result) = cursor.next().await {
                let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
                if let Some(id_val) = doc.get("_id") {
                    found.insert(id_val.to_string());
                }
            }
        }
        Ok(found)
    }

    match mode {
        "update" => {
            // Existing _ids get replaced (counts as updated); everything else is
            // inserted. This is an upsert-by-_id without relying on the driver's
            // option setters, which vary across versions.
            let existing = existing_ids(coll, &bson_docs).await?;
            let mut inserted = 0u64;
            let mut updated = 0u64;
            for doc in bson_docs {
                match doc.get("_id").cloned() {
                    Some(id_val) if existing.contains(&id_val.to_string()) => {
                        let filter = mongodb::bson::doc! { "_id": id_val };
                        let res = coll
                            .replace_one(filter, doc)
                            .await
                            .map_err(|e| format!("Failed to import (update): {}", e))?;
                        updated += res.modified_count;
                    }
                    _ => {
                        coll.insert_one(doc)
                            .await
                            .map_err(|e| format!("Failed to import (insert): {}", e))?;
                        inserted += 1;
                    }
                }
            }
            Ok(ImportResult {
                inserted,
                updated,
                skipped: 0,
            })
        }
        "abort" => {
            // Any incoming _id already present -> abort, write nothing.
            let existing = existing_ids(coll, &bson_docs).await?;
            if !existing.is_empty() {
                return Err(format!(
                    "Import aborted: {} document(s) already exist",
                    existing.len()
                ));
            }
            let total = bson_docs.len() as u64;
            insert_many_batched(coll, bson_docs).await?;
            Ok(ImportResult {
                inserted: total,
                updated: 0,
                skipped: 0,
            })
        }
        _ => {
            // "skip" (default): insert only docs whose _id does not already exist;
            // count existing ones as skipped. Docs without an _id always insert.
            let existing = existing_ids(coll, &bson_docs).await?;
            let total = bson_docs.len() as u64;
            let to_insert: Vec<mongodb::bson::Document> = bson_docs
                .into_iter()
                .filter(|d| match d.get("_id") {
                    Some(id_val) => !existing.contains(&id_val.to_string()),
                    None => true,
                })
                .collect();
            let inserted = to_insert.len() as u64;
            if !to_insert.is_empty() {
                insert_many_batched(coll, to_insert).await?;
            }
            Ok(ImportResult {
                inserted,
                updated: 0,
                skipped: total - inserted,
            })
        }
    }
}

// The option-matrix CSV parsing tests that used to live here (default
// options, delimiter/qualifier/skip_lines/headerless combos, explicit column
// types incl. failure context) now exercise db::import::ImportReader — the
// path the shipping import pipeline actually uses. See db/import.rs's `csv_*`
// tests. validate_csv_import_options is a pure helper with no ImportReader
// equivalent, so its test stays here.
#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod csv_import_tests {
    use super::*;

    #[test]
    fn validate_rejects_multi_char_delimiter_or_quote() {
        let mut o = CsvImportOptions::default();
        o.delimiter = "ab".into();
        assert!(validate_csv_import_options(&o).is_err());
        let mut o = CsvImportOptions::default();
        o.quote = "€".into();
        assert!(validate_csv_import_options(&o).is_err());
        assert!(validate_csv_import_options(&CsvImportOptions::default()).is_ok());
    }
}
