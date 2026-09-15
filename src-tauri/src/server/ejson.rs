//! Documents and Extended JSON between the desktop and MQLens Server.
//!
//! A document read from a collection arrives from the server as raw BSON and is
//! decoded by `doc_from_bson`, then rendered with `ui_json`, the rendering local
//! mode uses (`serde_json::to_value(&doc)` in `db/query.rs`, `db/aggregate.rs`).
//!
//! `doc_from_bson` converts bson's raw document directly instead of using
//! `bson::from_slice`, which is what the MongoDB driver, and so local mode,
//! decodes cursor results with. That serde path treats a stored sub-document
//! whose keys look like a type wrapper as the type: `{"$numberLong": "7"}`
//! becomes the number 7, and `{"$numberLong": "7", "other": 1}` becomes 7 with
//! `other` silently dropped. The raw conversion keeps both as stored. For every
//! other document the two decoders agree, so server mode shows what local mode
//! shows; `wrapper_shaped_documents_survive_only_the_faithful_decoder` pins the
//! difference, and local mode is to move onto this decoder separately.
//!
//! Extended JSON cannot stand in for the BSON bytes either: in it those same
//! sub-documents are indistinguishable from the types they resemble. It is
//! used only where the server takes or gives nothing else: filters, pipelines
//! and documents in requests (`doc_to_wire`), and values such as explain plans
//! (`doc_from_wire`), which are shown and never written back.

use mongodb::bson::{Bson, Document, RawDocument};

/// Decodes a document the server sent as raw BSON, keeping every key and value
/// exactly as stored, including sub-documents whose keys look like Extended
/// JSON type wrappers.
pub(crate) fn doc_from_bson(bytes: &[u8]) -> Result<Document, String> {
    let raw = RawDocument::from_bytes(bytes)
        .map_err(|e| format!("MQLens Server sent a document that is not valid BSON: {e}"))?;
    Document::try_from(raw)
        .map_err(|e| format!("MQLens Server sent a document that is not valid BSON: {e}"))
}

/// Decodes a value the server sends only as canonical Extended JSON, such as
/// an explain plan. Not for documents read from a collection, which can hold
/// keys Extended JSON mistakes for types; those come from `doc_from_bson`.
pub(crate) fn doc_from_wire(json: &str) -> Result<Document, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("MQLens Server sent a document that is not JSON: {e}"))?;
    match Bson::try_from(value) {
        Ok(Bson::Document(doc)) => Ok(doc),
        Ok(other) => Err(format!(
            "MQLens Server sent a {:?} where a document was expected",
            other.element_type()
        )),
        Err(e) => Err(format!(
            "MQLens Server sent a document that is not valid Extended JSON: {e}"
        )),
    }
}

/// Encodes a filter, pipeline stage or document as the canonical Extended
/// JSON the server's requests take.
pub(crate) fn doc_to_wire(doc: &Document) -> String {
    Bson::Document(doc.clone())
        .into_canonical_extjson()
        .to_string()
}

/// The JSON local mode shows for a document.
pub(crate) fn ui_json(doc: &Document) -> Result<serde_json::Value, String> {
    serde_json::to_value(doc).map_err(|e| format!("BSON to JSON error: {}", e))
}

/// The string local mode returns for one result row.
pub(crate) fn ui_string(doc: &Document) -> Result<String, String> {
    serde_json::to_string(&ui_json(doc)?).map_err(|e| format!("BSON to JSON error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use mongodb::bson::doc;

    /// Written by the server's `TestWriteEJSONFixture`: one line per document,
    /// `{"bson": <base64 BSON bytes>, "canonical": <canonical Extended JSON>}`.
    const FIXTURE: &str = include_str!("testdata/server_ejson_fixture.jsonl");

    struct Case {
        line: usize,
        /// The document's BSON bytes, as the server's driver encoded them.
        bson: Vec<u8>,
        /// What local mode decodes from those bytes, using the driver's decoder.
        local: Document,
        /// The server's canonical Extended JSON for the same document.
        canonical: String,
    }

    fn fixture() -> Vec<Case> {
        let cases: Vec<Case> = FIXTURE
            .lines()
            .filter(|l| !l.trim().is_empty())
            .enumerate()
            .map(|(i, line)| {
                let entry: serde_json::Value = serde_json::from_str(line).unwrap();
                let bson = base64::engine::general_purpose::STANDARD
                    .decode(entry["bson"].as_str().unwrap())
                    .unwrap();
                Case {
                    line: i + 1,
                    local: mongodb::bson::from_slice(&bson).unwrap(),
                    bson,
                    canonical: entry["canonical"].to_string(),
                }
            })
            .collect();
        assert!(
            cases.len() >= 4,
            "fixture has only {} documents",
            cases.len()
        );
        cases
    }

    fn to_bson(doc: &Document) -> Vec<u8> {
        let mut bytes = Vec::new();
        doc.to_writer(&mut bytes).unwrap();
        bytes
    }

    // For documents without wrapper-shaped keys, the faithful decoder and the
    // driver's agree, so server mode renders exactly what local mode renders,
    // for every BSON type. Compared as strings too: `serde_json::Value`
    // equality treats -0.0 and 0.0 as equal.
    #[test]
    fn raw_bson_documents_render_exactly_as_local_mode_renders_them() {
        for case in fixture() {
            let got = doc_from_bson(&case.bson).unwrap();
            assert_eq!(
                format!("{got:?}"),
                format!("{:?}", case.local),
                "fixture line {}",
                case.line
            );
            assert_eq!(
                ui_string(&got).unwrap(),
                ui_string(&case.local).unwrap(),
                "fixture line {}",
                case.line
            );
        }
    }

    // Extended JSON values, such as explain plans, keep every BSON type, every
    // key's position and local mode's rendering.
    #[test]
    fn extended_json_values_render_as_local_mode_renders_them() {
        for case in fixture() {
            let got = doc_from_wire(&case.canonical).unwrap();
            assert_eq!(
                format!("{got:?}"),
                format!("{:?}", case.local),
                "fixture line {}",
                case.line
            );
            assert_eq!(
                ui_json(&got).unwrap(),
                ui_json(&case.local).unwrap(),
                "fixture line {}",
                case.line
            );
            assert_eq!(
                ui_string(&got).unwrap(),
                ui_string(&case.local).unwrap(),
                "fixture line {}",
                case.line
            );
        }
    }

    // What the desktop sends is what the server's driver would produce.
    #[test]
    fn documents_encode_to_the_servers_canonical_form() {
        for case in fixture() {
            let sent: serde_json::Value = serde_json::from_str(&doc_to_wire(&case.local)).unwrap();
            let expected: serde_json::Value = serde_json::from_str(&case.canonical).unwrap();
            assert_eq!(sent, expected, "fixture line {}", case.line);
        }
    }

    // A stored sub-document with wrapper-shaped keys comes back unchanged only
    // from the faithful decoder. The driver's decoder, which local mode uses,
    // and Extended JSON both turn it into the type it resembles or lose fields.
    #[test]
    fn wrapper_shaped_documents_survive_only_the_faithful_decoder() {
        let looks_like_int64 = doc! { "payload": { "$numberLong": "7" } };
        let looks_like_date = doc! { "payload": { "$date": "2024-01-01T00:00:00Z" } };
        let looks_like_object_id = doc! { "payload": { "$oid": "64b7f0c2a1e4d93f5c6b7a81" } };
        let has_a_sibling_field = doc! { "payload": { "$numberLong": "7", "other": 1 } };

        for stored in [
            &looks_like_int64,
            &looks_like_date,
            &looks_like_object_id,
            &has_a_sibling_field,
        ] {
            let bytes = to_bson(stored);
            assert_eq!(&doc_from_bson(&bytes).unwrap(), stored);

            let drivers: Result<Document, _> = mongodb::bson::from_slice(&bytes);
            assert!(
                drivers.as_ref().ok() != Some(stored),
                "the driver's decoder kept {stored:?}; if bson now decodes these faithfully, local mode no longer needs its own fix"
            );

            let through_extended_json = doc_from_wire(&doc_to_wire(stored));
            assert!(
                through_extended_json.as_ref() != Ok(stored),
                "{stored:?} unexpectedly survived Extended JSON"
            );
        }

        assert_eq!(
            ui_string(&doc_from_bson(&to_bson(&has_a_sibling_field)).unwrap()).unwrap(),
            r#"{"payload":{"$numberLong":"7","other":1}}"#
        );
        let drivers: Document = mongodb::bson::from_slice(&to_bson(&has_a_sibling_field)).unwrap();
        assert_eq!(ui_string(&drivers).unwrap(), r#"{"payload":7}"#);
        assert!(doc_from_wire(&doc_to_wire(&has_a_sibling_field)).is_err());
    }

    #[test]
    fn malformed_server_documents_are_errors() {
        let err = doc_from_bson(&[5, 0, 0, 0]).unwrap_err();
        assert!(err.contains("not valid BSON"), "{err}");

        let mut truncated = to_bson(&doc! { "a": "text" });
        truncated.truncate(truncated.len() - 3);
        let err = doc_from_bson(&truncated).unwrap_err();
        assert!(err.contains("not valid BSON"), "{err}");

        let err = doc_from_wire("{not json").unwrap_err();
        assert!(err.contains("not JSON"), "{err}");

        let err = doc_from_wire("[1, 2]").unwrap_err();
        assert!(err.contains("where a document was expected"), "{err}");

        let err = doc_from_wire(r#"{"n": {"$numberLong": "twelve"}}"#).unwrap_err();
        assert!(err.contains("not valid Extended JSON"), "{err}");
    }
}
