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
