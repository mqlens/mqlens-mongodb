//! Document mutation and import operations.

use crate::limits::{IMPORT_BATCH_SIZE, MAX_IMPORT_DOCS};
use crate::write_guard::{guard_writable, WriteOp};
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
    let started = std::time::Instant::now();
    let result = delete_document_inner(state, id, database, collection, filter).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(database),
        Some(collection),
        "delete_document",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("deleteOne {database}.{collection}"),
        Some(filter),
        &result,
    );
    result
}

async fn delete_document_inner(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    guard_writable(state, id, WriteOp::DeleteOne, false)?;

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
    confirmed: bool,
) -> Result<u64, String> {
    let started = std::time::Instant::now();
    let result = delete_many_inner(state, id, database, collection, filter, confirmed).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(database),
        Some(collection),
        "delete_many",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("deleteMany {database}.{collection}"),
        Some(filter),
        &result,
    );
    result
}

async fn delete_many_inner(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    confirmed: bool,
) -> Result<u64, String> {
    guard_writable(state, id, WriteOp::DeleteMany, confirmed)?;

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
    confirmed: bool,
) -> Result<u64, String> {
    let started = std::time::Instant::now();
    let args = format!("{{\"filter\":{filter},\"update\":{update}}}");
    let result =
        update_many_inner(state, id, database, collection, filter, update, confirmed).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(database),
        Some(collection),
        "update_many",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("updateMany {database}.{collection}"),
        Some(&args),
        &result,
    );
    result
}

async fn update_many_inner(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    update: &str,
    confirmed: bool,
) -> Result<u64, String> {
    guard_writable(state, id, WriteOp::UpdateMany, confirmed)?;

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
    let started = std::time::Instant::now();
    let result = insert_document_inner(state, id, database, collection, document).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(database),
        Some(collection),
        "insert_document",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("insertOne {database}.{collection}"),
        Some(document),
        &result,
    );
    result
}

async fn insert_document_inner(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    document: &str,
) -> Result<String, String> {
    guard_writable(state, id, WriteOp::Insert, false)?;

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

/// A field path that MongoDB cannot address literally in an update.
///
/// A dot makes it traverse into a sub-document and a leading `$` makes it an
/// operator, so a field genuinely *named* `price.usd` cannot be targeted by
/// `$set`/`$unset` at all. Such names are legal in MongoDB documents, and the
/// old whole-document replacement handled them correctly by never naming them.
fn path_is_unaddressable(key: &str) -> bool {
    key.contains('.') || key.starts_with('$')
}

/// Which parts of a document a find projection leaves incomplete.
///
/// A bare "was a projection used?" flag is not enough. `{"address": 1}` includes
/// the whole sub-document, so deleting `address` should remove the field, while
/// `{"address.city": 1}` loads only one leaf and deleting it must not touch the
/// hidden siblings. The distinction is whether the projection names a path
/// *strictly below* the one being written — which reads the same way for
/// inclusions, exclusions (`{"address.zip": 0}` also yields a partial `address`)
/// and operators (`{"roles": {"$slice": 2}}` yields a truncated array).
#[derive(Debug, Default, Clone)]
pub struct ProjectionShape {
    /// Every path the projection names, flattened to dotted form.
    paths: Vec<String>,
    /// The projection could not be parsed, so nothing may be assumed complete.
    opaque: bool,
}

impl ProjectionShape {
    /// Parse a find projection. An unparseable one is treated as naming
    /// everything, so nothing is assumed complete.
    pub fn parse(projection: &str) -> Self {
        let trimmed = projection.trim();
        if trimmed.is_empty() || trimmed == "{}" {
            return Self::default();
        }
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str(trimmed) else {
            return Self {
                paths: Vec::new(),
                opaque: true,
            };
        };
        let mut paths = Vec::new();
        flatten_projection("", &map, &mut paths);
        Self {
            paths,
            opaque: false,
        }
    }

    /// True when nothing was projected away, so the document is whole.
    pub fn is_whole_document(&self) -> bool {
        !self.opaque && self.paths.is_empty()
    }

    /// True when the value at `path` may hold parts that were not loaded.
    fn is_partial_at(&self, path: &str) -> bool {
        if self.opaque {
            return true;
        }
        let prefix = format!("{path}.");
        self.paths.iter().any(|p| p.starts_with(&prefix))
    }
}

fn flatten_projection(
    prefix: &str,
    map: &serde_json::Map<String, serde_json::Value>,
    out: &mut Vec<String>,
) {
    for (key, value) in map {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        match value {
            // `{"address": {"city": 1}}` is the nested spelling of
            // `{"address.city": 1}`; `{"roles": {"$slice": 2}}` names a path
            // below `roles` too, which is exactly what makes it partial.
            serde_json::Value::Object(inner) if !inner.is_empty() => {
                flatten_projection(&path, inner, out);
            }
            _ => out.push(path),
        }
    }
}

/// Build a field-level update from the document as it was loaded and as it was
/// edited (#275).
///
/// The editor is fed whatever the query returned, and a projection makes that a
/// *partial* view of the document. Saving it with `replaceOne` therefore deleted
/// every field the projection had left out. Diffing loaded-against-edited fixes
/// that by construction: a field that was never shown appears in neither side,
/// so no operator mentions it and the stored value is untouched.
///
/// Sub-documents are compared recursively and emitted as dotted paths, because a
/// projection can target a nested path (`{"address.city": 1}`) — setting the
/// whole `address` object would reproduce the same bug one level down. Removals
/// follow the same rule, but only where the projection actually left that
/// sub-tree incomplete: see [`ProjectionShape`].
///
/// Returns `Err` when a changed field cannot be addressed (see
/// [`path_is_unaddressable`]) or when it cannot be written without losing data
/// the projection hid; the caller decides what to do about it.
///
/// An empty `Ok` result means nothing changed.
pub fn build_field_update(
    original: &Document,
    edited: &Document,
    shape: &ProjectionShape,
) -> Result<Document, String> {
    // `_id` is immutable. The old replacement surfaced MongoDB's error; skipping
    // the change silently would report a save that did not happen.
    if let Some(original_id) = original.get("_id") {
        match edited.get("_id") {
            None => {
                return Err("cannot remove _id: a document's _id is immutable. \
                            Restore it and save again."
                    .into())
            }
            Some(edited_id) if edited_id != original_id => {
                return Err("cannot change _id: a document's _id is immutable. \
                            Insert a new document instead."
                    .into())
            }
            Some(_) => {}
        }
    }

    let mut set = Document::new();
    let mut unset = Document::new();
    let mut blocked: Vec<String> = Vec::new();
    let mut partial_writes: Vec<String> = Vec::new();
    diff_documents(
        "", original, edited, shape, &mut set, &mut unset, &mut blocked, &mut partial_writes,
    );

    if !blocked.is_empty() {
        blocked.sort();
        blocked.dedup();
        return Err(format!(
            "cannot update field name(s) {} in place: MongoDB reads \".\" as a path \
             separator and a leading \"$\" as an operator. Re-run the query without a \
             projection so the whole document can be saved.",
            blocked.join(", ")
        ));
    }
    if !partial_writes.is_empty() {
        partial_writes.sort();
        partial_writes.dedup();
        return Err(format!(
            "cannot save field(s) {}: the projection returned only part of their contents, \
             so writing them back would discard the rest. Re-run the query without the \
             projection to edit these.",
            partial_writes.join(", ")
        ));
    }

    let mut update = Document::new();
    if !set.is_empty() {
        update.insert("$set", set);
    }
    if !unset.is_empty() {
        update.insert("$unset", unset);
    }
    Ok(update)
}

#[allow(clippy::too_many_arguments)]
fn diff_documents(
    prefix: &str,
    original: &Document,
    edited: &Document,
    shape: &ProjectionShape,
    set: &mut Document,
    unset: &mut Document,
    blocked: &mut Vec<String>,
    partial_writes: &mut Vec<String>,
) {
    let path_of = |key: &str| {
        if prefix.is_empty() {
            key.to_string()
        } else {
            format!("{prefix}.{key}")
        }
    };
    // `_id` is immutable and validated by the caller; only at the top level, since
    // a nested field may well be called `_id`.
    let is_immutable_id = |key: &str| prefix.is_empty() && key == "_id";

    for (key, new_value) in edited {
        if is_immutable_id(key) {
            continue;
        }
        let path = path_of(key);
        let old = original.get(key);
        let changed = old != Some(new_value);
        if changed && path_is_unaddressable(key) {
            blocked.push(path);
            continue;
        }
        // Anything the projection loaded only partly cannot be written back as a
        // whole value: a `$slice`/`$elemMatch` array would lose its unseen
        // elements, and replacing a partially loaded object — including with a
        // scalar or null — would lose the siblings it hid.
        let old_may_hide_more = matches!(
            old,
            Some(mongodb::bson::Bson::Document(_)) | Some(mongodb::bson::Bson::Array(_))
        );
        let writes_whole_value = !matches!(
            (old, new_value),
            (
                Some(mongodb::bson::Bson::Document(_)),
                mongodb::bson::Bson::Document(_)
            )
        );
        if changed && old_may_hide_more && writes_whole_value && shape.is_partial_at(&path) {
            partial_writes.push(path);
            continue;
        }
        match old {
            None => {
                set.insert(path, new_value.clone());
            }
            Some(old_value) if old_value == new_value => {}
            Some(mongodb::bson::Bson::Document(old_doc)) => match new_value {
                // Both sides are sub-documents: recurse so only the fields that
                // actually differ are written.
                mongodb::bson::Bson::Document(new_doc) => {
                    diff_documents(
                        &path, old_doc, new_doc, shape, set, unset, blocked, partial_writes,
                    );
                }
                _ => {
                    set.insert(path, new_value.clone());
                }
            },
            Some(_) => {
                set.insert(path, new_value.clone());
            }
        }
    }

    for (key, old_value) in original {
        if is_immutable_id(key) || edited.contains_key(key) {
            continue;
        }
        if path_is_unaddressable(key) {
            blocked.push(path_of(key));
            continue;
        }
        let path = path_of(key);
        match old_value {
            mongodb::bson::Bson::Document(old_doc) => {
                unset_removed_subtree(&path, old_doc, shape, unset, blocked);
            }
            // A partially loaded array reaches here rather than the change guard,
            // because the key is simply absent from the edited document. Unsetting
            // it would delete the elements the projection never showed.
            mongodb::bson::Bson::Array(_) if shape.is_partial_at(&path) => {
                partial_writes.push(path);
            }
            _ => {
                unset.insert(path, "");
            }
        }
    }
}

/// Unset a removed sub-document, descending only as far as the projection left
/// it incomplete.
///
/// At a path the projection loaded whole, the field itself is unset — going
/// deeper would leave an empty `{}` behind. Where it loaded only part, the walk
/// continues so the siblings it hid are not taken along. An empty sub-document
/// inside a partial path yields nothing at all: `{}` on screen may be genuinely
/// empty or hidden, and there is no leaf it is safe to unset.
fn unset_removed_subtree(
    path: &str,
    doc: &Document,
    shape: &ProjectionShape,
    unset: &mut Document,
    blocked: &mut Vec<String>,
) {
    if !shape.is_partial_at(path) {
        unset.insert(path.to_string(), "");
        return;
    }
    for (key, value) in doc {
        if path_is_unaddressable(key) {
            blocked.push(format!("{path}.{key}"));
            continue;
        }
        let child = format!("{path}.{key}");
        match value {
            mongodb::bson::Bson::Document(inner) if !inner.is_empty() => {
                unset_removed_subtree(&child, inner, shape, unset, blocked);
            }
            mongodb::bson::Bson::Document(_) => {}
            _ => {
                unset.insert(child, "");
            }
        }
    }
}

pub async fn update_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    original: &str,
    edited: &str,
    projection: &str,
) -> Result<u64, String> {
    let started = std::time::Instant::now();
    let result = update_document_inner(
        state, id, database, collection, filter, original, edited, projection,
    )
    .await;
    // Record the operation that actually ran and the operators it applied. The
    // edited document alone cannot show that removing a field issued `$unset`,
    // so the mutation would not be reconstructable from the log.
    let (summary, args) = match &result {
        Ok((_, applied)) => (
            format!("{} {database}.{collection}", applied.op),
            format!(
                "{{\"filter\":{filter},\"{}\":{}}}",
                applied.op, applied.payload
            ),
        ),
        Err(_) => (
            format!("updateOne {database}.{collection} (failed)"),
            format!("{{\"filter\":{filter},\"edited\":{edited}}}"),
        ),
    };
    let outcome = result.as_ref().map(|(modified, _)| *modified);
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(database),
        Some(collection),
        "update_document",
        crate::audit::OpClass::Write,
        None,
        started,
        &summary,
        Some(&args),
        &outcome,
    );
    result.map(|(modified, _)| modified)
}

/// What [`update_document_inner`] actually sent, for the audit record.
struct AppliedWrite {
    /// `updateOne` or `replaceOne`.
    op: &'static str,
    /// The update document or the replacement, as JSON.
    payload: String,
}

/// Which Mongo write to issue for an edited document.
enum WritePlan {
    Update(Document),
    Replace,
}

#[allow(clippy::too_many_arguments)]
async fn update_document_inner(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    original: &str,
    edited: &str,
    projection: &str,
) -> Result<(u64, AppliedWrite), String> {
    // Still `ReplaceOne`: this is the single-document edit from the grid, and
    // that variant is deliberately outside the confirm-required set. Only the
    // Mongo operation underneath changed.
    guard_writable(state, id, WriteOp::ReplaceOne, false)?;

    let filter_doc = json_to_bson_document(filter)?;
    let original_doc = json_to_bson_document(original)?;
    let edited_doc = json_to_bson_document(edited)?;

    let shape = ProjectionShape::parse(projection);
    let plan = match build_field_update(&original_doc, &edited_doc, &shape) {
        // Mongo rejects an empty update document, and there is nothing to do.
        Ok(update) if update.is_empty() => {
            return Ok((
                0,
                AppliedWrite {
                    op: "updateOne",
                    payload: "{}".into(),
                },
            ));
        }
        Ok(update) => WritePlan::Update(update),
        Err(e) => {
            if !shape.is_whole_document() {
                // The document on screen is incomplete, so replacing it would
                // delete whatever the projection hid. Nothing safe to do here.
                return Err(e);
            }
            // The whole document is loaded, so replacing it is both safe and the
            // only way to address a field whose name contains "." or "$".
            WritePlan::Replace
        }
    };

    let applied = match &plan {
        WritePlan::Update(update) => AppliedWrite {
            op: "updateOne",
            payload: serde_json::to_string(&mongodb::bson::Bson::Document(update.clone()))
                .unwrap_or_else(|_| "{}".into()),
        },
        WritePlan::Replace => AppliedWrite {
            op: "replaceOne",
            payload: edited.to_string(),
        },
    };

    if connection_is_mock(state, id)? {
        return Ok((1, applied));
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<Document>(collection);
    let modified = match plan {
        WritePlan::Update(update) => coll
            .update_one(filter_doc, update)
            .await
            .map_err(|e| format!("Failed to update document: {}", e))?
            .modified_count,
        WritePlan::Replace => coll
            .replace_one(filter_doc, edited_doc)
            .await
            .map_err(|e| format!("Failed to update document: {}", e))?
            .modified_count,
    };
    Ok((modified, applied))
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
    let started = std::time::Instant::now();
    let summary = format!("import {database}.{collection} ({mode}, {} docs)", docs.len());
    let result = import_documents_inner(state, id, database, collection, docs, mode).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(database),
        Some(collection),
        "import_documents",
        crate::audit::OpClass::Write,
        None,
        started,
        &summary,
        None,
        &result,
    );
    result
}

async fn import_documents_inner(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    docs: Vec<serde_json::Value>,
    mode: &str,
) -> Result<ImportResult, String> {
    guard_writable(state, id, WriteOp::Import, false)?;

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
///
/// `op_label` names the operation in the error message on failure (e.g.
/// `"import"` for the import callers below, `"generate"` for
/// `start_generate_task_impl`) — callers share this one insert loop but
/// surface its failure directly as their task's error message, so a single
/// hardcoded "Failed to import: …" would misdescribe a generate-task failure
/// as an import failure.
pub(crate) async fn insert_many_batched(
    coll: &mongodb::Collection<Document>,
    docs: Vec<Document>,
    op_label: &str,
) -> Result<(), String> {
    for chunk in docs.chunks(IMPORT_BATCH_SIZE) {
        if chunk.is_empty() {
            continue;
        }
        coll.insert_many(chunk.to_vec())
            .await
            .map_err(|e| format!("Failed to {}: {}", op_label, e))?;
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
            insert_many_batched(coll, bson_docs, "import").await?;
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
                insert_many_batched(coll, to_insert, "import").await?;
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

    // ── #275: editing a projected document must not wipe unprojected fields ──

    fn doc_of(json: &str) -> mongodb::bson::Document {
        crate::json_to_bson_document(json).expect("parse")
    }

    fn no_projection() -> ProjectionShape {
        ProjectionShape::parse("{}")
    }

    /// A projection that loads only one leaf of `address`.
    fn nested_projection() -> ProjectionShape {
        ProjectionShape::parse(r#"{"address.city":1}"#)
    }

    #[test]
    fn editing_a_projected_field_touches_only_that_field() {
        // The bug: a projection returns {_id, age}, and replacing the document
        // with it deleted username, email, roles, address and the rest.
        let original = doc_of(r#"{"_id":"66a1","age":34}"#);
        let edited = doc_of(r#"{"_id":"66a1","age":35}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");

        assert_eq!(update, doc_of(r#"{"$set":{"age":35}}"#));
        assert!(
            !update.contains_key("$unset"),
            "nothing was shown as removed, so nothing may be unset: {update:?}"
        );
    }

    #[test]
    fn an_unchanged_document_produces_no_update() {
        let d = doc_of(r#"{"_id":"66a1","age":34}"#);
        assert!(build_field_update(&d, &d, &no_projection()).expect("addressable").is_empty());
    }

    #[test]
    fn removing_a_shown_field_unsets_it() {
        let original = doc_of(r#"{"_id":"66a1","age":34,"nickname":"nav"}"#);
        let edited = doc_of(r#"{"_id":"66a1","age":34}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"nickname":""}}"#));
    }

    #[test]
    fn adding_a_field_sets_it() {
        let original = doc_of(r#"{"_id":"66a1","age":34}"#);
        let edited = doc_of(r#"{"_id":"66a1","age":34,"city":"Pforzheim"}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"city":"Pforzheim"}}"#));
    }

    #[test]
    fn a_nested_edit_uses_a_dotted_path_so_siblings_survive() {
        // A projection can target a nested path (`{"address.city": 1}`), so the
        // loaded sub-document is partial too. Setting the whole `address` object
        // would delete street/zip/country — the same bug one level down.
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1","address":{"city":"Berlin"}}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"address.city":"Berlin"}}"#));
    }

    #[test]
    fn a_nested_removal_unsets_the_dotted_path() {
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim","zip":"75172"}}"#);
        let edited = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"address.zip":""}}"#));
    }

    #[test]
    fn removing_a_projected_subdocument_unsets_only_what_was_visible() {
        // Under `{"address.city": 1}` the loaded `address` holds only `city`.
        // Deleting it must not `$unset: address` — that takes street/zip/country
        // with it, which is the very bug this change exists to prevent.
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"address.city":""}}"#));
    }

    #[test]
    fn removing_a_nested_subdocument_unsets_its_leaves_recursively() {
        // `{"a.b.c": 1}` leaves both `a` and `a.b` incomplete, so the walk has to
        // reach the leaves.
        let shape = ProjectionShape::parse(r#"{"a.b.c":1}"#);
        let original =
            doc_of(r#"{"_id":"66a1","a":{"b":{"c":1,"d":2},"e":3}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(
            update,
            doc_of(r#"{"$unset":{"a.b.c":"","a.b.d":"","a.e":""}}"#)
        );
    }

    #[test]
    fn removing_a_subdocument_from_a_whole_document_unsets_the_parent() {
        // Nothing is hidden, so the field itself goes. Unsetting `address.city`
        // alone would leave `address: {}` stored, which is not what the editor
        // showed and still matches `{address: {$exists: true}}`.
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &no_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"address":""}}"#));
    }

    #[test]
    fn removing_an_empty_subdocument_under_a_projection_writes_nothing() {
        // `{}` on screen could be a genuinely empty object, or one whose fields
        // the projection hid — so there is no leaf it is safe to unset.
        let original = doc_of(r#"{"_id":"66a1","address":{}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert!(update.is_empty(), "must not guess at hidden fields: {update:?}");
    }

    #[test]
    fn removing_an_empty_subdocument_from_a_whole_document_unsets_it() {
        // Nothing was hidden, so `{}` really is empty and the removal applies.
        let original = doc_of(r#"{"_id":"66a1","address":{}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &no_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"address":""}}"#));
    }

    #[test]
    fn a_fully_included_subdocument_unsets_its_parent() {
        // `{"address": 1}` loads the whole sub-document, so deleting it must
        // remove the field — not leave `address: {}` behind.
        let shape = ProjectionShape::parse(r#"{"address":1}"#);
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"address":""}}"#));
    }

    #[test]
    fn the_nested_spelling_of_a_projection_is_treated_the_same_as_dotted() {
        // `{"address": {"city": 1}}` means the same as `{"address.city": 1}`.
        let shape = ProjectionShape::parse(r#"{"address":{"city":1}}"#);
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"address.city":""}}"#));
    }

    #[test]
    fn a_nested_exclusion_also_makes_a_subdocument_partial() {
        // `{"address.zip": 0}` returns address without zip, so a removal must
        // still go leaf by leaf.
        let shape = ProjectionShape::parse(r#"{"address.zip":0}"#);
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"address.city":""}}"#));
    }

    #[test]
    fn a_sliced_array_is_refused_rather_than_truncating_the_stored_one() {
        let shape = ProjectionShape::parse(r#"{"roles":{"$slice":2}}"#);
        let original = doc_of(r#"{"_id":"66a1","roles":["admin","devops"]}"#);
        let edited = doc_of(r#"{"_id":"66a1","roles":["admin","editor"]}"#);
        let err = build_field_update(&original, &edited, &shape).expect_err("must refuse");
        assert!(err.contains("roles"), "{err}");
        assert!(err.contains("part of their contents"), "{err}");
    }

    #[test]
    fn replacing_a_partially_projected_object_with_a_scalar_is_refused() {
        // Under `{"address.city": 1}` the loaded `address` hides street and zip;
        // `$set: {address: "unknown"}` would replace the whole stored object.
        let shape = ProjectionShape::parse(r#"{"address.city":1}"#);
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1","address":"unknown"}"#);
        let err = build_field_update(&original, &edited, &shape).expect_err("must refuse");
        assert!(err.contains("address"), "{err}");
        assert!(err.contains("part of their contents"), "{err}");
    }

    #[test]
    fn nulling_a_partially_projected_object_is_refused() {
        let shape = ProjectionShape::parse(r#"{"address.city":1}"#);
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1","address":null}"#);
        assert!(build_field_update(&original, &edited, &shape).is_err());
    }

    #[test]
    fn replacing_a_fully_included_object_with_a_scalar_is_allowed() {
        // Nothing was hidden, so the whole value really is the whole value.
        let shape = ProjectionShape::parse(r#"{"address":1}"#);
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1","address":"unknown"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"address":"unknown"}}"#));
    }

    #[test]
    fn removing_a_partially_projected_array_is_refused() {
        // The key is absent from the edited document, so this never reaches the
        // change guard — but unsetting it would delete the unseen elements.
        let shape = ProjectionShape::parse(r#"{"roles":{"$slice":2}}"#);
        let original = doc_of(r#"{"_id":"66a1","roles":["admin","devops"]}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let err = build_field_update(&original, &edited, &shape).expect_err("must refuse");
        assert!(err.contains("roles"), "{err}");
    }

    #[test]
    fn removing_a_fully_included_array_is_allowed() {
        let shape = ProjectionShape::parse(r#"{"roles":1}"#);
        let original = doc_of(r#"{"_id":"66a1","roles":["admin","devops"]}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$unset":{"roles":""}}"#));
    }

    #[test]
    fn a_fully_included_array_is_editable() {
        let shape = ProjectionShape::parse(r#"{"roles":1}"#);
        let original = doc_of(r#"{"_id":"66a1","roles":["admin","devops"]}"#);
        let edited = doc_of(r#"{"_id":"66a1","roles":["admin","editor"]}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"roles":["admin","editor"]}}"#));
    }

    #[test]
    fn changing_the_id_is_refused_not_silently_dropped() {
        // The old replacement surfaced MongoDB's immutable-field error; skipping
        // the change would report a save that never happened.
        let original = doc_of(r#"{"_id":"66a1","age":34}"#);
        let edited = doc_of(r#"{"_id":"different","age":34}"#);
        let err = build_field_update(&original, &edited, &no_projection())
            .expect_err("must refuse");
        assert!(err.contains("_id"), "{err}");
        assert!(err.contains("immutable"), "{err}");
    }

    #[test]
    fn removing_the_id_is_refused() {
        let original = doc_of(r#"{"_id":"66a1","age":34}"#);
        let edited = doc_of(r#"{"age":34}"#);
        let err = build_field_update(&original, &edited, &no_projection())
            .expect_err("must refuse");
        assert!(err.contains("_id"), "{err}");
    }

    #[test]
    fn an_unparseable_projection_assumes_nothing_is_complete() {
        let shape = ProjectionShape::parse("{not json");
        assert!(!shape.is_whole_document());
        assert!(shape.is_partial_at("anything"));
    }

    #[test]
    fn a_literal_dotted_field_name_is_refused_not_mistargeted() {
        // `price.usd` is a legal field name. Emitting it into `$set` would make
        // MongoDB traverse into a `price` sub-document instead.
        let original = doc_of(r#"{"_id":"66a1","price.usd":10}"#);
        let edited = doc_of(r#"{"_id":"66a1","price.usd":11}"#);
        let err = build_field_update(&original, &edited, &nested_projection()).expect_err("must refuse");
        assert!(err.contains("price.usd"), "{err}");
        assert!(err.contains("projection"), "should say how to proceed: {err}");
    }

    #[test]
    fn a_dollar_prefixed_field_name_is_refused() {
        let original = doc_of(r#"{"_id":"66a1","$weird":1}"#);
        let edited = doc_of(r#"{"_id":"66a1","$weird":2}"#);
        assert!(build_field_update(&original, &edited, &nested_projection()).is_err());
    }

    #[test]
    fn an_untouched_dotted_field_name_does_not_block_the_update() {
        // Only *changed* fields need addressing, so a document merely containing
        // such a name is still editable elsewhere.
        let original = doc_of(r#"{"_id":"66a1","price.usd":10,"age":34}"#);
        let edited = doc_of(r#"{"_id":"66a1","price.usd":10,"age":35}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"age":35}}"#));
    }


    #[test]
    fn arrays_are_replaced_as_a_whole_value() {
        let original = doc_of(r#"{"_id":"66a1","roles":["admin","devops"]}"#);
        let edited = doc_of(r#"{"_id":"66a1","roles":["admin","editor"]}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"roles":["admin","editor"]}}"#));
    }

    #[test]
    fn replacing_a_document_with_a_scalar_sets_the_whole_path() {
        // Written before the diff knew about projections, so it asked for the
        // whole path to be set under a *nested* projection — which is exactly the
        // unsafe write now refused. The behaviour it meant to pin only holds when
        // nothing was hidden; see
        // `replacing_a_partially_projected_object_with_a_scalar_is_refused` for
        // the projected case.
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited = doc_of(r#"{"_id":"66a1","address":"unknown"}"#);
        let update = build_field_update(&original, &edited, &no_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"address":"unknown"}}"#));
    }

    #[test]
    fn a_new_nested_document_is_set_whole() {
        let original = doc_of(r#"{"_id":"66a1"}"#);
        let edited = doc_of(r#"{"_id":"66a1","address":{"city":"Berlin"}}"#);
        let update = build_field_update(&original, &edited, &nested_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"address":{"city":"Berlin"}}}"#));
    }
}
