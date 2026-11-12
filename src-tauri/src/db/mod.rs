//! Database-operation modules (split out of lib.rs).

pub mod aggregate;
pub mod copy;
pub mod ddl;
pub mod documents;
pub mod export;
pub mod generate;
pub mod gridfs;
pub mod import;
pub mod metadata;
pub mod mongotools;
pub mod query;
pub mod schema;
pub mod stats;
pub mod tasks;
pub mod users;
pub mod version;

/// A document as stored. `Collection<Document>` decodes with the driver's
/// serde decoder, which takes a sub-document such as `{"$numberLong": "7"}`
/// for the type its keys imitate: it drops any sibling keys, or fails the
/// whole read when the value does not parse as that type. Reading
/// `RawDocumentBuf` and converting here keeps every document as it is.
pub(crate) fn stored(
    raw: mongodb::bson::RawDocumentBuf,
) -> Result<mongodb::bson::Document, String> {
    mongodb::bson::Document::try_from(raw.as_ref())
        .map_err(|e| format!("Cursor read error: {e}"))
}

/// The JSON the UI gets for a document: bson's `Serialize` output, except that
/// binary is always `$binary`. `Serialize` writes subtype 0 as bare bytes, which
/// JSON can hold only as an array of numbers, indistinguishable from a real
/// array to the viewer and to a save of what it shows.
pub(crate) fn ui_json(doc: &mongodb::bson::Document) -> Result<serde_json::Value, String> {
    doc.iter()
        .map(|(key, value)| ui_value(value).map(|value| (key.clone(), value)))
        .collect()
}

fn ui_value(value: &mongodb::bson::Bson) -> Result<serde_json::Value, String> {
    use mongodb::bson::Bson;
    match value {
        Bson::Binary(_) => Ok(value.clone().into_relaxed_extjson()),
        Bson::Document(doc) => ui_json(doc),
        Bson::Array(items) => items.iter().map(ui_value).collect(),
        other => serde_json::to_value(other).map_err(|e| format!("BSON to JSON error: {}", e)),
    }
}

/// The string the UI gets for one result row.
pub(crate) fn ui_string(doc: &mongodb::bson::Document) -> Result<String, String> {
    serde_json::to_string(&ui_json(doc)?).map_err(|e| format!("BSON to JSON error: {}", e))
}
