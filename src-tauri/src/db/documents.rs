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
    // Counted for the life of this call, so a rename or a drop of this
    // namespace is refused while the insert is on its way (#326 review).
    let _write = crate::namespace_guard::begin_document_write(state, id, database, collection)?;
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

/// What a find projection returned, and therefore what may be hidden.
///
/// Two different questions have to be answered, and one predicate cannot do
/// both:
///
/// * *Was the value at this path returned whole?* `{"address": 1}` includes the
///   whole sub-document, so deleting `address` may remove the field; with
///   `{"address.city": 1}` only one leaf was loaded, so a removal must not touch
///   the siblings it hid. That is [`Self::is_partial_at`] — is any path named
///   *strictly below* this one — and it reads the same for inclusions,
///   exclusions (`{"address.zip": 0}` also yields a partial `address`) and
///   operators (`{"roles": {"$slice": 2}}` yields a truncated array).
///
/// * *Was this path returned at all?* Under `{"name": 1}` a stored `address` is
///   never shown, so a field the editor "adds" may already exist and be
///   overwritten. That is [`Self::may_hide`], and it needs the projection's
///   scope, not just its paths.
#[derive(Debug, Default, Clone)]
pub struct ProjectionShape {
    /// Every path the projection names, flattened to dotted form.
    paths: Vec<String>,
    /// Paths whose value the projection *computed*, so there is nothing in the
    /// stored document to write back to.
    computed: Vec<String>,
    /// Embedded documents whose other fields may not have come back, because a
    /// `$slice`/`$elemMatch` targeted something *inside* them.
    ///
    /// MongoDB's behaviour here has changed across releases: older servers return
    /// only the sliced field within the embedded document, dropping its siblings.
    /// MQLens targets servers that old (#232), and on newer ones the cost of
    /// assuming siblings may be hidden is a refusal with a clear message rather
    /// than a silent overwrite — so this is treated conservatively either way.
    locally_hidden: Vec<String>,
    scope: Scope,
}

/// Which fields a projection returned.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// Every field. No projection, or one made only of operators such as
    /// `$slice`, which truncate a value without restricting the field list.
    #[default]
    All,
    /// Only the named paths (plus `_id` unless excluded).
    Included,
    /// Everything except the named paths.
    Excluded,
    /// Unknowable: the rows came from an aggregation, the projection could not be
    /// parsed, or it mixes inclusion and exclusion (which MongoDB rejects).
    Unknown,
}

/// What a projection entry says about its path.
///
/// Two independent axes, which an earlier version conflated: whether the entry
/// *restricts the field list*, and whether the returned value *exists in the
/// stored document*. `$meta` is the case that separates them — it adds a
/// synthesized field without hiding anything else.
enum Leaf {
    /// `1` / `true`. Restricts the field list; the value is the stored one.
    Include,
    /// `0` / `false`. Excludes; other values are the stored ones.
    Exclude,
    /// `$slice`. Does not restrict the field list; the value is a truncated view
    /// of the stored array.
    Slice,
    /// `$elemMatch`. Unlike `$slice` this *is* an inclusion projection — only the
    /// named field comes back — and the array holds just the matching element.
    ElemMatch,
    /// An aggregation expression. Restricts the field list *and* synthesizes its
    /// value, so there is nothing to write back to.
    Computed,
    /// `$meta`. Does not restrict the field list, but synthesizes its value from
    /// result metadata.
    Meta,
}

impl Leaf {
    /// Whether the value came from the stored field, so a write can go back to it.
    fn is_writable(&self) -> bool {
        !matches!(self, Leaf::Computed | Leaf::Meta)
    }

    /// Whether the entry limits the result to the named fields.
    fn restricts_field_list(&self) -> bool {
        matches!(self, Leaf::Include | Leaf::Computed | Leaf::ElemMatch)
    }
}

/// Operators that return a view of the stored value rather than computing one.
/// `$meta` is deliberately absent: it does not restrict the field list either,
/// but its value is synthesized.
const SLICE_OPERATORS: [&str; 1] = ["$slice"];

impl ProjectionShape {
    /// Parse a find projection, or `None` when the shape cannot be known — the
    /// rows came from an aggregation, whose `$project`/`$replaceRoot`/`$unset`
    /// stages cannot be reduced to a field list.
    pub fn parse_optional(projection: Option<&str>) -> Self {
        match projection {
            Some(p) => Self::parse(p),
            None => Self {
                paths: Vec::new(),
                computed: Vec::new(),
                locally_hidden: Vec::new(),
                scope: Scope::Unknown,
            },
        }
    }

    /// Parse a find projection. An unparseable one is treated as unknowable, so
    /// nothing is assumed complete or absent.
    pub fn parse(projection: &str) -> Self {
        let trimmed = projection.trim();
        if trimmed.is_empty() || trimmed == "{}" {
            return Self::default();
        }
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str(trimmed) else {
            return Self {
                paths: Vec::new(),
                computed: Vec::new(),
                locally_hidden: Vec::new(),
                scope: Scope::Unknown,
            };
        };
        let mut entries = Vec::new();
        flatten_projection("", &map, &mut entries);

        let mut includes = false;
        let mut excludes = false;
        for (path, leaf) in &entries {
            // `_id: 0` is the idiom for dropping the id alongside an inclusion, and
            // must not read as an exclusion projection. But `_id: 1` is a real
            // inclusion — only `_id` comes back — so it may not be skipped, or an
            // added field would look new when the document already has one.
            if path == "_id" && matches!(leaf, Leaf::Exclude) {
                continue;
            }
            if leaf.restricts_field_list() {
                includes = true;
            } else if matches!(leaf, Leaf::Exclude) {
                excludes = true;
            }
        }
        let scope = match (includes, excludes) {
            (true, true) => Scope::Unknown,
            (true, false) => Scope::Included,
            (false, true) => Scope::Excluded,
            (false, false) => Scope::All,
        };
        let computed = entries
            .iter()
            .filter(|(_, leaf)| !leaf.is_writable())
            .map(|(path, _)| path.clone())
            .collect();
        // A `$slice`/`$elemMatch` inside an embedded document may have dropped
        // that document's other fields. The entry path is `<field>.<$op>`, so the
        // container is the field's parent.
        let locally_hidden = entries
            .iter()
            .filter(|(_, leaf)| matches!(leaf, Leaf::Slice | Leaf::ElemMatch))
            .filter_map(|(path, _)| {
                let field = path.rsplit_once('.').map(|(head, _)| head)?;
                field.rsplit_once('.').map(|(container, _)| container.to_string())
            })
            .collect();

        Self {
            paths: entries.into_iter().map(|(path, _)| path).collect(),
            computed,
            locally_hidden,
            scope,
        }
    }

    /// True when the value at `path` was computed by the projection, so there is
    /// no stored field it corresponds to.
    fn is_computed(&self, path: &str) -> bool {
        self.computed
            .iter()
            .any(|p| p == path || path.starts_with(&format!("{p}.")))
    }

    /// True when nothing was projected away, so the document is whole.
    pub fn is_whole_document(&self) -> bool {
        self.scope == Scope::All && self.paths.is_empty()
    }

    /// True when the value at `path` may hold parts that were not loaded.
    fn is_partial_at(&self, path: &str) -> bool {
        if self.scope == Scope::Unknown {
            return true;
        }
        let prefix = format!("{path}.");
        self.paths.iter().any(|p| p.starts_with(&prefix))
    }

    /// True when the stored document could hold a value at `path` that was never
    /// returned — so a field the editor appears to *add* might already exist.
    fn may_hide(&self, path: &str) -> bool {
        // Inside an embedded document a nested `$slice` may have withheld the
        // siblings, even when every top-level field came back.
        if self
            .locally_hidden
            .iter()
            .any(|container| path.starts_with(&format!("{container}.")))
        {
            return true;
        }
        match self.scope {
            Scope::All => false,
            Scope::Unknown => true,
            // Only the named paths came back, so anything outside them is unseen.
            Scope::Included => !self.names_self_or_ancestor(path),
            // Everything came back except the named paths.
            Scope::Excluded => self.names_self_or_ancestor(path),
        }
    }

    /// Whether the projection names `path` itself or a path it sits under.
    fn names_self_or_ancestor(&self, path: &str) -> bool {
        self.paths
            .iter()
            .any(|p| p == path || path.starts_with(&format!("{p}.")))
    }
}

fn flatten_projection(
    prefix: &str,
    map: &serde_json::Map<String, serde_json::Value>,
    out: &mut Vec<(String, Leaf)>,
) {
    for (key, value) in map {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        match value {
            serde_json::Value::Bool(true) => out.push((path, Leaf::Include)),
            serde_json::Value::Bool(false) => out.push((path, Leaf::Exclude)),
            serde_json::Value::Number(n) => {
                let leaf = if n.as_f64() == Some(0.0) {
                    Leaf::Exclude
                } else {
                    Leaf::Include
                };
                out.push((path, leaf));
            }
            serde_json::Value::Object(inner) if inner.is_empty() => {
                out.push((path, Leaf::Include));
            }
            // `{"roles": {"$slice": 2}}` returns a truncated view of the stored
            // array; the field list is untouched and the value is still the
            // document's own.
            serde_json::Value::Object(inner)
                if inner.keys().all(|k| SLICE_OPERATORS.contains(&k.as_str())) =>
            {
                for op in inner.keys() {
                    out.push((format!("{path}.{op}"), Leaf::Slice));
                }
            }
            // `{"roles": {"$elemMatch": {...}}}` returns only the matching element,
            // and unlike `$slice` it hides every unlisted field.
            serde_json::Value::Object(inner) if inner.keys().all(|k| k == "$elemMatch") => {
                out.push((format!("{path}.$elemMatch"), Leaf::ElemMatch));
            }
            // `{"score": {"$meta": "textScore"}}` adds a field from result
            // metadata: nothing is hidden, but nothing is stored there either.
            serde_json::Value::Object(inner) if inner.keys().all(|k| k == "$meta") => {
                out.push((path, Leaf::Meta));
            }
            // Any other `$`-keyed object is an aggregation expression, e.g.
            // `{"display": {"$concat": [...]}}`.
            serde_json::Value::Object(inner) if inner.keys().any(|k| k.starts_with('$')) => {
                out.push((path, Leaf::Computed));
            }
            // `{"address": {"city": 1}}` is the nested spelling of
            // `{"address.city": 1}`.
            serde_json::Value::Object(inner) => flatten_projection(&path, inner, out),
            // Anything else is an aggregation expression too: `{"display": "$name"}`
            // aliases a field, `{"tag": "fixed"}` is a literal, and an array is a
            // computed list. None of them read the stored field of that name.
            _ => out.push((path, Leaf::Computed)),
        }
    }
}

/// Why a field-level update could not be built.
///
/// The kind matters: an unaddressable field name is recoverable by replacing the
/// whole document (when the whole document is what was loaded), while a changed
/// `_id` is not — MongoDB's replacement semantics preserve an omitted `_id`, so
/// falling back would report a save that silently kept the old value.
#[derive(Debug)]
pub enum UpdateBuildError {
    /// The rows have no known source document, so nothing may be written.
    NoLineage(String),
    /// `_id` was changed or removed.
    ImmutableId(String),
    /// A changed field's name contains `.` or starts with `$`.
    UnaddressableNames(String),
    /// A value the projection loaded only partly would be overwritten whole.
    PartialWrite(String),
}

impl std::fmt::Display for UpdateBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            Self::NoLineage(m)
            | Self::ImmutableId(m)
            | Self::UnaddressableNames(m)
            | Self::PartialWrite(m) => m,
        };
        f.write_str(msg)
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
) -> Result<Document, UpdateBuildError> {
    // An unknown shape means the rows did not come from a find, so `_id` may be a
    // group key rather than a document id. Writing anything would target whichever
    // source document happens to share that value — or none at all. There is no
    // safe subset here, not even a scalar field.
    // A find projection can replace `_id` with an expression
    // (`{"_id": "$email"}`), in which case the row's id is not the document's and
    // any filter built from it targets whatever happens to match.
    if shape.is_computed("_id") {
        return Err(UpdateBuildError::NoLineage(
            "cannot save: the query replaced _id with a computed value, so MQLens cannot \
             tell which stored document this row came from. Re-run the query without \
             projecting _id to edit documents."
                .into(),
        ));
    }
    if shape.scope == Scope::Unknown {
        return Err(UpdateBuildError::NoLineage(
            "cannot save: these rows did not come from a plain query, so MQLens cannot tell \
             which stored document each one came from. Re-run as a find query to edit \
             documents."
                .into(),
        ));
    }
    // `_id` is immutable. The old replacement surfaced MongoDB's error; skipping
    // the change silently would report a save that did not happen.
    if let Some(original_id) = original.get("_id") {
        match edited.get("_id") {
            None => {
                return Err(UpdateBuildError::ImmutableId(
                    "cannot remove _id: a document's _id is immutable. Restore it and \
                     save again."
                        .into(),
                ))
            }
            Some(edited_id) if edited_id != original_id => {
                return Err(UpdateBuildError::ImmutableId(
                    "cannot change _id: a document's _id is immutable. Insert a new \
                     document instead."
                        .into(),
                ))
            }
            Some(_) => {}
        }
    }

    let mut set = Document::new();
    let mut unset = Document::new();
    let mut blocked: Vec<String> = Vec::new();
    let mut partial_writes: Vec<String> = Vec::new();
    let mut ambiguous_removals: Vec<String> = Vec::new();
    let mut hidden_additions: Vec<String> = Vec::new();
    let mut computed_writes: Vec<String> = Vec::new();
    diff_documents(
        "",
        original,
        edited,
        shape,
        &mut DiffSink {
            set: &mut set,
            unset: &mut unset,
            blocked: &mut blocked,
            partial_writes: &mut partial_writes,
            ambiguous_removals: &mut ambiguous_removals,
            hidden_additions: &mut hidden_additions,
            computed_writes: &mut computed_writes,
        },
    );

    if !blocked.is_empty() {
        blocked.sort();
        blocked.dedup();
        return Err(UpdateBuildError::UnaddressableNames(format!(
            "cannot update field name(s) {} in place: MongoDB reads \".\" as a path \
             separator and a leading \"$\" as an operator. Re-run the query without a \
             projection so the whole document can be saved.",
            blocked.join(", ")
        )));
    }
    if !computed_writes.is_empty() {
        computed_writes.sort();
        computed_writes.dedup();
        return Err(UpdateBuildError::PartialWrite(format!(
            "cannot save field(s) {}: the projection computed them, so there is no stored \
             field to write back to. Re-run the query without the projection to edit this \
             document.",
            computed_writes.join(", ")
        )));
    }
    if !hidden_additions.is_empty() {
        hidden_additions.sort();
        hidden_additions.dedup();
        return Err(UpdateBuildError::PartialWrite(format!(
            "cannot add field(s) {}: the projection did not return them, so a field that is \
             genuinely new cannot be told apart from one that already exists and would be \
             overwritten. Re-run the query without the projection to add these.",
            hidden_additions.join(", ")
        )));
    }
    if !ambiguous_removals.is_empty() {
        ambiguous_removals.sort();
        ambiguous_removals.dedup();
        return Err(UpdateBuildError::PartialWrite(format!(
            "cannot remove field(s) {}: the projection returned them empty, so an empty \
             stored object cannot be told apart from one whose fields it hid. Re-run the \
             query without the projection to remove these.",
            ambiguous_removals.join(", ")
        )));
    }
    if !partial_writes.is_empty() {
        partial_writes.sort();
        partial_writes.dedup();
        return Err(UpdateBuildError::PartialWrite(format!(
            "cannot save field(s) {}: the projection returned only part of their contents, \
             so writing them back would discard the rest. Re-run the query without the \
             projection to edit these.",
            partial_writes.join(", ")
        )));
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

/// Where a diff deposits what it works out. Grouped because the list kept
/// growing a parameter at a time as refusal cases were added.
struct DiffSink<'a> {
    set: &'a mut Document,
    unset: &'a mut Document,
    /// Field names an update operator cannot address.
    blocked: &'a mut Vec<String>,
    /// Values the projection loaded only partly, so writing them whole would
    /// discard the rest.
    partial_writes: &'a mut Vec<String>,
    /// Removals that cannot be expressed at all, because the projection returned
    /// the object empty.
    ambiguous_removals: &'a mut Vec<String>,
    /// Fields the editor appears to add, but which the projection may simply not
    /// have returned — so writing them could overwrite an existing value.
    hidden_additions: &'a mut Vec<String>,
    /// Fields the projection computed, which have no stored counterpart.
    computed_writes: &'a mut Vec<String>,
}

/// Compare loaded against edited, depositing operators and refusals in `sink`.
///
/// Three directions, each needing its own guards — a rule added to one does not
/// apply itself to the others, which is how several were missed:
///
/// | direction | guards |
/// |---|---|
/// | change  | computed value, unaddressable name, whole-value write to a partial |
/// | add     | computed value, unaddressable name, path the projection may hide   |
/// | remove  | computed value, unaddressable name, partial array, inexpressible   |
fn diff_documents(
    prefix: &str,
    original: &Document,
    edited: &Document,
    shape: &ProjectionShape,
    sink: &mut DiffSink<'_>,
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
        if changed && shape.is_computed(&path) {
            sink.computed_writes.push(path);
            continue;
        }
        if changed && path_is_unaddressable(key) {
            sink.blocked.push(path);
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
            sink.partial_writes.push(path);
            continue;
        }
        match old {
            None => {
                // Absent from the loaded row is not the same as absent from the
                // document: under `{"name": 1}` a stored `address` is never shown,
                // so `$set`ting it would replace whatever is really there.
                if shape.may_hide(&path) {
                    sink.hidden_additions.push(path);
                } else {
                    sink.set.insert(path, new_value.clone());
                }
            }
            Some(old_value) if old_value == new_value => {}
            Some(mongodb::bson::Bson::Document(old_doc)) => match new_value {
                // Both sides are sub-documents: recurse so only the fields that
                // actually differ are written.
                mongodb::bson::Bson::Document(new_doc) => {
                    diff_documents(&path, old_doc, new_doc, shape, sink);
                }
                _ => {
                    sink.set.insert(path, new_value.clone());
                }
            },
            Some(_) => {
                sink.set.insert(path, new_value.clone());
            }
        }
    }

    for (key, old_value) in original {
        if is_immutable_id(key) || edited.contains_key(key) {
            continue;
        }
        if path_is_unaddressable(key) {
            sink.blocked.push(path_of(key));
            continue;
        }
        plan_removal(&path_of(key), old_value, shape, sink);
    }
}

/// Plan the removal of the value at `path`, at any depth.
///
/// Deliberately one function for every removal, top level and nested alike. The
/// cases were previously split between the caller and a recursive helper, and
/// each guard added to one of them had to be remembered in the other — which is
/// how partial nested arrays kept slipping through.
fn plan_removal(
    path: &str,
    value: &mongodb::bson::Bson,
    shape: &ProjectionShape,
    sink: &mut DiffSink<'_>,
) {
    // The value on screen was synthesized, so `$unset` here would delete a stored
    // field of that name which the editor never showed.
    if shape.is_computed(path) {
        sink.computed_writes.push(path.to_string());
        return;
    }
    match value {
        mongodb::bson::Bson::Document(doc) => {
            if !shape.is_partial_at(path) {
                // Loaded whole — because nothing was projected, or because the
                // projection included it outright (`{"address": 1}`) — so remove
                // the field itself. Descending would leave an empty `{}` behind.
                sink.unset.insert(path.to_string(), "");
                return;
            }
            // Partial: only what was visible may go, or the projection's hidden
            // siblings go with it.
            let before = (
                sink.unset.len(),
                sink.blocked.len(),
                sink.partial_writes.len(),
                sink.ambiguous_removals.len(),
            );
            for (key, child) in doc {
                if path_is_unaddressable(key) {
                    sink.blocked.push(format!("{path}.{key}"));
                    continue;
                }
                plan_removal(&format!("{path}.{key}"), child, shape, sink);
            }
            let after = (
                sink.unset.len(),
                sink.blocked.len(),
                sink.partial_writes.len(),
                sink.ambiguous_removals.len(),
            );
            if before == after {
                // Nothing could be expressed: what was shown is an empty object
                // (or only empty objects), so an empty stored object cannot be
                // told apart from one whose fields the projection hid. Emitting
                // nothing would close the editor with a success message over a
                // document that did not change.
                sink.ambiguous_removals.push(path.to_string());
            }
        }
        // `$slice`/`$elemMatch` returned only part of the array, so unsetting it
        // would delete the elements that were never shown.
        mongodb::bson::Bson::Array(_) if shape.is_partial_at(path) => {
            sink.partial_writes.push(path.to_string());
        }
        _ => {
            sink.unset.insert(path.to_string(), "");
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
    projection: Option<&str>,
) -> Result<u64, String> {
    let _write = crate::namespace_guard::begin_document_write(state, id, database, collection)?;
    let started = std::time::Instant::now();
    let outcome = update_document_inner(
        state, id, database, collection, filter, original, edited, projection,
    )
    .await;
    let (summary, args) = audit_labels(&outcome, database, collection, filter, edited);

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
        &outcome.result,
    );
    outcome.result
}

/// Summary and payload for the audit record.
///
/// Three states, all derivable from [`WriteOutcome`]: a write was attempted and
/// went through, a write was attempted and the database rejected it, or no write
/// was ever planned — either because nothing changed or because it was refused
/// before reaching MongoDB. Naming an operation that never ran, or attaching an
/// update document MongoDB would itself reject, makes the trail describe
/// something that did not happen.
fn audit_labels(
    outcome: &WriteOutcome,
    database: &str,
    collection: &str,
    filter: &str,
    edited: &str,
) -> (String, String) {
    let submitted = format!("{{\"filter\":{filter},\"edited\":{edited}}}");
    match (&outcome.attempted, &outcome.result) {
        (Some(applied), result) => {
            let suffix = if result.is_err() { " (failed)" } else { "" };
            (
                format!("{} {database}.{collection}{suffix}", applied.op),
                format!(
                    "{{\"filter\":{filter},\"{}\":{}}}",
                    applied.op, applied.payload
                ),
            )
        }
        // Saved without editing anything: a real user action worth recording, but
        // no database operation to name.
        (None, Ok(_)) => (format!("no change {database}.{collection}"), submitted),
        // Rejected before a write was planned: a write guard, unparseable JSON,
        // or one of the refusals.
        (None, Err(_)) => (
            format!("update_document {database}.{collection} (rejected)"),
            submitted,
        ),
    }
}

/// The write that was attempted, plus how it went.
///
/// `attempted` survives a database error on purpose: a failed mutation is
/// exactly the one an audit trail needs to be reconstructable from.
struct WriteOutcome {
    attempted: Option<AppliedWrite>,
    result: Result<u64, String>,
}

/// What [`update_document_inner`] sent, for the audit record.
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
    projection: Option<&str>,
) -> WriteOutcome {
    macro_rules! rejected {
        ($e:expr) => {
            return WriteOutcome {
                attempted: None,
                result: Err($e),
            }
        };
    }
    // Still `ReplaceOne`: this is the single-document edit from the grid, and
    // that variant is deliberately outside the confirm-required set. Only the
    // Mongo operation underneath changed.
    if let Err(e) = guard_writable(state, id, WriteOp::ReplaceOne, false) {
        rejected!(e);
    }

    let filter_doc = match json_to_bson_document(filter) {
        Ok(d) => d,
        Err(e) => rejected!(e),
    };
    let original_doc = match json_to_bson_document(original) {
        Ok(d) => d,
        Err(e) => rejected!(e),
    };
    let edited_doc = match json_to_bson_document(edited) {
        Ok(d) => d,
        Err(e) => rejected!(e),
    };

    let shape = ProjectionShape::parse_optional(projection);
    let plan = match build_field_update(&original_doc, &edited_doc, &shape) {
        // Mongo rejects an empty update document, and there is nothing to do.
        Ok(update) if update.is_empty() => {
            // Nothing changed, so nothing is sent. `attempted: None` with an `Ok`
            // result is what distinguishes this from a rejection.
            return WriteOutcome {
                attempted: None,
                result: Ok(0),
            };
        }
        Ok(update) => WritePlan::Update(update),
        Err(err) => {
            // Only an unaddressable field name is recoverable by replacing, and
            // only when the whole document was loaded. An immutable-`_id` error
            // must never reach the fallback: replacement preserves an omitted
            // `_id`, so the request would succeed and report a save while the
            // old value quietly stayed.
            let recoverable = matches!(err, UpdateBuildError::UnaddressableNames(_))
                && shape.is_whole_document();
            if !recoverable {
                rejected!(err.to_string());
            }
            WritePlan::Replace
        }
    };

    let attempted = Some(match &plan {
        WritePlan::Update(update) => AppliedWrite {
            op: "updateOne",
            payload: serde_json::to_string(&mongodb::bson::Bson::Document(update.clone()))
                .unwrap_or_else(|_| "{}".into()),
        },
        WritePlan::Replace => AppliedWrite {
            op: "replaceOne",
            payload: edited.to_string(),
        },
    });

    match connection_is_mock(state, id) {
        Ok(true) => {
            return WriteOutcome {
                attempted,
                result: Ok(1),
            }
        }
        Ok(false) => {}
        Err(e) => {
            return WriteOutcome {
                attempted,
                result: Err(e),
            }
        }
    }

    let client = match require_real_client(state, id) {
        Ok(c) => c,
        Err(e) => {
            return WriteOutcome {
                attempted,
                result: Err(e),
            }
        }
    };
    let coll = client
        .database(database)
        .collection::<Document>(collection);
    // The plan is already decided, so a database rejection keeps `attempted` —
    // a failed mutation is exactly the one the audit trail must describe.
    let result = match plan {
        WritePlan::Update(update) => coll
            .update_one(filter_doc, update)
            .await
            .map(|r| r.modified_count)
            .map_err(|e| format!("Failed to update document: {}", e)),
        WritePlan::Replace => coll
            .replace_one(filter_doc, edited_doc)
            .await
            .map(|r| r.modified_count)
            .map_err(|e| format!("Failed to update document: {}", e)),
    };
    WriteOutcome { attempted, result }
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

    // ── #275: the audit record must describe what actually happened ──

    fn outcome(attempted: Option<&'static str>, result: Result<u64, String>) -> WriteOutcome {
        WriteOutcome {
            attempted: attempted.map(|op| AppliedWrite {
                op,
                payload: r#"{"$set":{"age":35}}"#.into(),
            }),
            result,
        }
    }

    #[test]
    fn an_unchanged_save_is_not_recorded_as_a_database_write() {
        // It used to log `updateOne` carrying `{}` — an update MongoDB would
        // itself reject, describing a write that never happened.
        let (summary, args) = audit_labels(
            &outcome(None, Ok(0)),
            "shop",
            "orders",
            r#"{"_id":1}"#,
            r#"{"_id":1}"#,
        );
        assert_eq!(summary, "no change shop.orders");
        assert!(!args.contains("$set"), "must not invent an update: {args}");
        assert!(args.contains("edited"), "should record what was submitted: {args}");
    }

    #[test]
    fn a_successful_write_records_its_operation_and_operators() {
        let (summary, args) = audit_labels(
            &outcome(Some("updateOne"), Ok(1)),
            "shop",
            "orders",
            r#"{"_id":1}"#,
            r#"{"_id":1,"age":35}"#,
        );
        assert_eq!(summary, "updateOne shop.orders");
        assert!(args.contains(r#""$set""#), "{args}");
    }

    #[test]
    fn a_failed_write_keeps_the_operation_it_attempted() {
        let (summary, args) = audit_labels(
            &outcome(Some("replaceOne"), Err("boom".into())),
            "shop",
            "orders",
            r#"{"_id":1}"#,
            r#"{"_id":1,"age":35}"#,
        );
        assert_eq!(summary, "replaceOne shop.orders (failed)");
        assert!(args.contains("replaceOne"), "must not be relabelled: {args}");
    }

    #[test]
    fn a_refusal_names_no_operation() {
        let (summary, _) = audit_labels(
            &outcome(None, Err("refused".into())),
            "shop",
            "orders",
            r#"{"_id":1}"#,
            r#"{"_id":1}"#,
        );
        assert_eq!(summary, "update_document shop.orders (rejected)");
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
        // Without a projection, absent from the row really does mean absent from
        // the document. The projected case is refused; see
        // `adding_a_field_the_projection_did_not_return_is_refused`.
        let original = doc_of(r#"{"_id":"66a1","age":34}"#);
        let edited = doc_of(r#"{"_id":"66a1","age":34,"city":"Pforzheim"}"#);
        let update = build_field_update(&original, &edited, &no_projection()).expect("addressable");
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
    fn removing_an_empty_projected_subdocument_is_refused_not_a_silent_no_op() {
        // Emitting nothing closed the editor with a success message over a
        // document that had not changed.
        let original = doc_of(r#"{"_id":"66a1","address":{}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let err = build_field_update(&original, &edited, &nested_projection())
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("address"), "{err}");
        assert!(err.contains("returned them empty"), "{err}");
    }

    #[test]
    fn removing_a_subdocument_of_only_empty_objects_is_also_refused() {
        // Nothing expressible any number of levels down, not just immediately.
        let shape = ProjectionShape::parse(r#"{"a.b.c":1}"#);
        let original = doc_of(r#"{"_id":"66a1","a":{"b":{}}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        assert!(build_field_update(&original, &edited, &shape).is_err());
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
    fn adding_a_field_the_projection_did_not_return_is_refused() {
        // Under `{"name": 1}` a stored `address` is never shown, so `$set`ting it
        // would replace whatever is really there — street and zip included.
        let shape = ProjectionShape::parse(r#"{"name":1}"#);
        let original = doc_of(r#"{"_id":"66a1","name":"Grace"}"#);
        let edited = doc_of(r#"{"_id":"66a1","name":"Grace","address":{"city":"Berlin"}}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("address"), "{err}");
        assert!(err.contains("did not return"), "{err}");
    }

    #[test]
    fn adding_a_field_the_projection_returned_is_allowed() {
        // `{"address": 1}` did return `address`, so its absence from the row is
        // real and adding it is safe.
        let shape = ProjectionShape::parse(r#"{"name":1,"address":1}"#);
        let original = doc_of(r#"{"_id":"66a1","name":"Grace"}"#);
        let edited = doc_of(r#"{"_id":"66a1","name":"Grace","address":{"city":"Berlin"}}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"address":{"city":"Berlin"}}}"#));
    }

    #[test]
    fn adding_an_excluded_field_is_refused() {
        // `{"address": 0}` withheld it, so it may already exist.
        let shape = ProjectionShape::parse(r#"{"address":0}"#);
        let original = doc_of(r#"{"_id":"66a1","name":"Grace"}"#);
        let edited = doc_of(r#"{"_id":"66a1","name":"Grace","address":{"city":"Berlin"}}"#);
        assert!(build_field_update(&original, &edited, &shape).is_err());
    }

    #[test]
    fn adding_a_field_under_an_exclusion_that_did_not_hide_it_is_allowed() {
        // Everything except `secret` came back, so `city` really is new.
        let shape = ProjectionShape::parse(r#"{"secret":0}"#);
        let original = doc_of(r#"{"_id":"66a1","name":"Grace"}"#);
        let edited = doc_of(r#"{"_id":"66a1","name":"Grace","city":"Berlin"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"city":"Berlin"}}"#));
    }

    #[test]
    fn adding_a_nested_field_the_projection_did_not_return_is_refused() {
        // `{"address.city": 1}` never showed `address.street`, so it may exist.
        let shape = ProjectionShape::parse(r#"{"address.city":1}"#);
        let original = doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim"}}"#);
        let edited =
            doc_of(r#"{"_id":"66a1","address":{"city":"Pforzheim","street":"Haupt 1"}}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("address.street"), "{err}");
    }

    #[test]
    fn a_slice_only_projection_still_returns_every_field() {
        // `{"roles": {"$slice": 2}}` truncates an array without restricting the
        // field list, so adding a field is safe even though `roles` is partial.
        let shape = ProjectionShape::parse(r#"{"roles":{"$slice":2}}"#);
        let original = doc_of(r#"{"_id":"66a1","roles":["a","b"]}"#);
        let edited = doc_of(r#"{"_id":"66a1","roles":["a","b"],"city":"Berlin"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"city":"Berlin"}}"#));
    }

    #[test]
    fn an_id_only_inclusion_hides_every_other_field() {
        // `{"_id": 1}` returns nothing but `_id`, so an added field may already
        // exist in the stored document.
        let shape = ProjectionShape::parse(r#"{"_id":1}"#);
        let original = doc_of(r#"{"_id":"66a1"}"#);
        let edited = doc_of(r#"{"_id":"66a1","address":{"city":"Berlin"}}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("address"), "{err}");
    }

    #[test]
    fn an_id_only_exclusion_still_returns_every_other_field() {
        // `{"_id": 0}` withholds only the id, so anything else absent from the row
        // really is absent.
        let shape = ProjectionShape::parse(r#"{"_id":0}"#);
        let original = doc_of(r#"{"name":"Grace"}"#);
        let edited = doc_of(r#"{"name":"Grace","city":"Berlin"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"city":"Berlin"}}"#));
    }

    #[test]
    fn an_id_only_exclusion_is_still_a_plain_inclusion() {
        // `{"name": 1, "_id": 0}` must not read as a mixed projection.
        let shape = ProjectionShape::parse(r#"{"name":1,"_id":0}"#);
        let original = doc_of(r#"{"name":"Grace"}"#);
        let edited = doc_of(r#"{"name":"Grace","city":"Berlin"}"#);
        assert!(
            build_field_update(&original, &edited, &shape).is_err(),
            "city was outside an inclusion projection, so it may already exist"
        );
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
        let err = build_field_update(&original, &edited, &shape).expect_err("must refuse").to_string();
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
        let err = build_field_update(&original, &edited, &shape).expect_err("must refuse").to_string();
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
        let err = build_field_update(&original, &edited, &shape).expect_err("must refuse").to_string();
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
            .expect_err("must refuse").to_string();
        assert!(err.contains("_id"), "{err}");
        assert!(err.contains("immutable"), "{err}");
    }

    #[test]
    fn removing_the_id_is_refused() {
        let original = doc_of(r#"{"_id":"66a1","age":34}"#);
        let edited = doc_of(r#"{"age":34}"#);
        let err = build_field_update(&original, &edited, &no_projection())
            .expect_err("must refuse").to_string();
        assert!(err.contains("_id"), "{err}");
    }

    #[test]
    fn removing_a_nested_partial_array_reached_by_recursion_is_refused() {
        // `{"profile.roles": {"$slice": 2}}` truncates a *nested* array. Removing
        // the visible `profile` descends into it, and the top-level array guard
        // never sees it.
        let shape = ProjectionShape::parse(r#"{"profile.roles":{"$slice":2}}"#);
        let original =
            doc_of(r#"{"_id":"66a1","profile":{"roles":["admin","devops"]}}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("profile.roles"), "{err}");
    }



    #[test]
    fn an_immutable_id_error_is_reported_as_such_not_as_an_addressing_problem() {
        // The caller may only fall back to a replacement for unaddressable names;
        // replacement would preserve an omitted `_id` and report a false save.
        let original = doc_of(r#"{"_id":"66a1","age":34}"#);
        let edited = doc_of(r#"{"age":34}"#);
        let err = build_field_update(&original, &edited, &no_projection())
            .expect_err("must refuse");
        assert!(
            matches!(err, UpdateBuildError::ImmutableId(_)),
            "expected ImmutableId, got {err:?}"
        );
    }

    #[test]
    fn an_unaddressable_name_error_is_typed_so_the_caller_can_recover() {
        let original = doc_of(r#"{"_id":"66a1","price.usd":10}"#);
        let edited = doc_of(r#"{"_id":"66a1","price.usd":11}"#);
        let err = build_field_update(&original, &edited, &no_projection())
            .expect_err("must refuse");
        assert!(matches!(err, UpdateBuildError::UnaddressableNames(_)), "{err:?}");
    }

    #[test]
    fn rows_without_known_lineage_cannot_be_saved_at_all() {
        // Aggregation rows may carry a group key as `_id`, so any write would
        // target whichever stored document happens to share that value — or none.
        // There is no safe subset, not even a scalar field.
        let shape = ProjectionShape::parse_optional(None);
        let original = doc_of(r#"{"_id":"active","count":3}"#);
        let edited = doc_of(r#"{"_id":"active","count":4}"#);
        let err = build_field_update(&original, &edited, &shape).expect_err("must refuse");
        assert!(matches!(err, UpdateBuildError::NoLineage(_)), "{err:?}");
        assert!(err.to_string().contains("find query"), "{err}");
    }

    #[test]
    fn a_computed_projection_field_cannot_be_written_back() {
        // `{"display": {"$concat": [...]}}` synthesizes a value; there is no
        // stored `display` to update.
        let shape = ProjectionShape::parse(r#"{"display":{"$concat":["$first"," ","$last"]}}"#);
        let original = doc_of(r#"{"_id":"66a1","display":"Ada L"}"#);
        let edited = doc_of(r#"{"_id":"66a1","display":"Ada Lovelace"}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("display"), "{err}");
        assert!(err.contains("computed"), "{err}");
    }

    #[test]
    fn a_computed_projection_establishes_inclusion_scope() {
        // It restricts the field list like any inclusion, so an unlisted field may
        // already exist and must not be added blindly.
        let shape = ProjectionShape::parse(r#"{"display":{"$concat":["$first"," ","$last"]}}"#);
        let original = doc_of(r#"{"_id":"66a1","display":"Ada L"}"#);
        let edited = doc_of(r#"{"_id":"66a1","display":"Ada L","address":{"city":"Berlin"}}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("address"), "{err}");
    }

    #[test]
    fn removing_a_computed_field_is_refused() {
        // `$unset: {display: ""}` would delete a stored `display` the editor never
        // showed — the synthesized value is not evidence one exists.
        let shape = ProjectionShape::parse(r#"{"display":{"$concat":["$first"," ","$last"]}}"#);
        let original = doc_of(r#"{"_id":"66a1","display":"Ada L"}"#);
        let edited = doc_of(r#"{"_id":"66a1"}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("display"), "{err}");
        assert!(err.contains("computed"), "{err}");
    }

    #[test]
    fn a_field_alias_projection_is_computed_not_an_inclusion() {
        // `{"display": "$name"}` reads `name`; there is no stored `display`.
        let shape = ProjectionShape::parse(r#"{"display":"$name"}"#);
        let original = doc_of(r#"{"_id":"66a1","display":"Ada"}"#);
        let edited = doc_of(r#"{"_id":"66a1","display":"Grace"}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("display"), "{err}");
    }

    #[test]
    fn a_literal_projection_value_is_computed_too() {
        let shape = ProjectionShape::parse(r#"{"tag":"fixed"}"#);
        let original = doc_of(r#"{"_id":"66a1","tag":"fixed"}"#);
        let edited = doc_of(r#"{"_id":"66a1","tag":"other"}"#);
        assert!(build_field_update(&original, &edited, &shape).is_err());
    }

    #[test]
    fn a_field_alias_projection_still_restricts_the_field_list() {
        let shape = ProjectionShape::parse(r#"{"display":"$name"}"#);
        let original = doc_of(r#"{"_id":"66a1","display":"Ada"}"#);
        let edited = doc_of(r#"{"_id":"66a1","display":"Ada","address":{"city":"Berlin"}}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("address"), "{err}");
    }

    #[test]
    fn a_nested_slice_may_have_hidden_its_containers_siblings() {
        // `{"details.colors": {"$slice": 1}}` — older servers return only `colors`
        // inside `details`, so `sizes` may exist unseen and must not be `$set`.
        let shape = ProjectionShape::parse(r#"{"details.colors":{"$slice":1}}"#);
        let original = doc_of(r#"{"_id":"66a1","details":{"colors":["red"]}}"#);
        let edited =
            doc_of(r#"{"_id":"66a1","details":{"colors":["red"],"sizes":["m"]}}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("details.sizes"), "{err}");
    }

    #[test]
    fn a_nested_slice_leaves_unrelated_top_level_fields_addable() {
        // Only the containing embedded document is suspect; the rest of the
        // document came back in full.
        let shape = ProjectionShape::parse(r#"{"details.colors":{"$slice":1}}"#);
        let original = doc_of(r#"{"_id":"66a1","details":{"colors":["red"]}}"#);
        let edited =
            doc_of(r#"{"_id":"66a1","details":{"colors":["red"]},"city":"Berlin"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"city":"Berlin"}}"#));
    }

    #[test]
    fn a_top_level_slice_hides_nothing() {
        // No containing embedded document, so every field still came back.
        let shape = ProjectionShape::parse(r#"{"roles":{"$slice":2}}"#);
        let original = doc_of(r#"{"_id":"66a1","roles":["a","b"]}"#);
        let edited = doc_of(r#"{"_id":"66a1","roles":["a","b"],"city":"Berlin"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"city":"Berlin"}}"#));
    }

    #[test]
    fn an_elem_match_projection_hides_unlisted_fields() {
        // Unlike `$slice`, `$elemMatch` returns only the named field, so an
        // apparently absent `address` may already exist.
        let shape = ProjectionShape::parse(r#"{"roles":{"$elemMatch":{"$eq":"admin"}}}"#);
        let original = doc_of(r#"{"_id":"66a1","roles":["admin"]}"#);
        let edited = doc_of(r#"{"_id":"66a1","roles":["admin"],"address":{"city":"Berlin"}}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("address"), "{err}");
    }

    #[test]
    fn an_elem_match_array_is_still_partial() {
        // Only the matching element came back, so writing the array whole would
        // discard the others.
        let shape = ProjectionShape::parse(r#"{"roles":{"$elemMatch":{"$eq":"admin"}}}"#);
        let original = doc_of(r#"{"_id":"66a1","roles":["admin"]}"#);
        let edited = doc_of(r#"{"_id":"66a1","roles":["admin","editor"]}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("roles"), "{err}");
    }

    #[test]
    fn a_computed_id_means_the_row_has_no_known_document() {
        // `{"_id": "$email"}` is a plain find, but the row's id is not the
        // document's — a filter built from it would hit whatever matches.
        let shape = ProjectionShape::parse(r#"{"_id":"$email","name":1}"#);
        let original = doc_of(r#"{"_id":"ada@example.com","name":"Ada"}"#);
        let edited = doc_of(r#"{"_id":"ada@example.com","name":"Grace"}"#);
        let err = build_field_update(&original, &edited, &shape).expect_err("must refuse");
        assert!(matches!(err, UpdateBuildError::NoLineage(_)), "{err:?}");
        assert!(err.to_string().contains("_id"), "{err}");
    }

    #[test]
    fn an_included_id_keeps_lineage() {
        let shape = ProjectionShape::parse(r#"{"_id":1,"name":1}"#);
        let original = doc_of(r#"{"_id":"66a1","name":"Ada"}"#);
        let edited = doc_of(r#"{"_id":"66a1","name":"Grace"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"name":"Grace"}}"#));
    }

    #[test]
    fn a_meta_projection_adds_a_field_without_hiding_any() {
        // `{"score": {"$meta": "textScore"}}` returns every field plus a
        // synthesized score, so it must not read as an inclusion...
        let shape = ProjectionShape::parse(r#"{"score":{"$meta":"textScore"}}"#);
        let original = doc_of(r#"{"_id":"66a1","name":"Ada","score":1.5}"#);
        let edited = doc_of(r#"{"_id":"66a1","name":"Ada","score":1.5,"city":"Berlin"}"#);
        let update = build_field_update(&original, &edited, &shape).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"city":"Berlin"}}"#));
    }

    #[test]
    fn a_meta_projection_value_cannot_be_written_back() {
        // ...but the score itself came from result metadata, not the document.
        let shape = ProjectionShape::parse(r#"{"score":{"$meta":"textScore"}}"#);
        let original = doc_of(r#"{"_id":"66a1","score":1.5}"#);
        let edited = doc_of(r#"{"_id":"66a1","score":9.9}"#);
        let err = build_field_update(&original, &edited, &shape)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains("score"), "{err}");
    }

    #[test]
    fn a_slice_is_still_treated_as_a_projection_operator_not_an_expression() {
        // Only $slice/$elemMatch/$meta truncate a value; they must keep leaving the
        // field list unrestricted.
        let shape = ProjectionShape::parse(r#"{"roles":{"$slice":2}}"#);
        assert!(shape.is_partial_at("roles"));
        assert!(!shape.is_computed("roles"));
        assert!(!shape.may_hide("city"), "a $slice-only projection returns every field");
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
        let err = build_field_update(&original, &edited, &nested_projection()).expect_err("must refuse").to_string();
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
        let update = build_field_update(&original, &edited, &no_projection()).expect("addressable");
        assert_eq!(update, doc_of(r#"{"$set":{"address":{"city":"Berlin"}}}"#));
    }
}
