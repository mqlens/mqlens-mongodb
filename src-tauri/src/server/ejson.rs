//! Extended JSON between the desktop and MQLens Server.
//!
//! The server sends documents as canonical Extended JSON and expects filters,
//! pipelines and documents in the same form. Local mode never sees Extended
//! JSON: it decodes BSON off the wire into a `Document` and shows
//! `serde_json::to_value(&doc)` (`db/query.rs`, `db/aggregate.rs`). Server mode
//! decodes the server's Extended JSON back into a `Document` and renders it the
//! same way, so both modes show exactly the same JSON for the same data. The
//! golden test below holds that against documents covering every BSON type,
//! produced by the server's own driver.

use mongodb::bson::{Bson, Document};

/// Decodes one document the server sent as canonical Extended JSON.
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

/// Encodes a document as the canonical Extended JSON the server expects.
pub(crate) fn doc_to_wire(doc: &Document) -> String {
    Bson::Document(doc.clone())
        .into_canonical_extjson()
        .to_string()
}

/// The JSON local mode shows for a document.
pub(crate) fn ui_json(doc: &Document) -> Result<serde_json::Value, String> {
    serde_json::to_value(doc).map_err(|e| format!("BSON to JSON error: {}", e))
}

/// A server document rendered as the string local mode returns for one result
/// row.
pub(crate) fn ui_string_from_wire(json: &str) -> Result<String, String> {
    let value = ui_json(&doc_from_wire(json)?)?;
    serde_json::to_string(&value).map_err(|e| format!("BSON to JSON error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    /// Written by the server's `TestWriteEJSONFixture`: one line per document,
    /// `{"bson": <base64 BSON bytes>, "canonical": <canonical Extended JSON>}`.
    const FIXTURE: &str = include_str!("testdata/server_ejson_fixture.jsonl");

    struct Case {
        line: usize,
        /// What local mode decodes off the wire.
        local: Document,
        /// What the server sends for the same document.
        canonical: String,
    }

    fn fixture() -> Vec<Case> {
        let cases: Vec<Case> = FIXTURE
            .lines()
            .filter(|l| !l.trim().is_empty())
            .enumerate()
            .map(|(i, line)| {
                let entry: serde_json::Value = serde_json::from_str(line).unwrap();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(entry["bson"].as_str().unwrap())
                    .unwrap();
                Case {
                    line: i + 1,
                    local: mongodb::bson::from_slice(&bytes).unwrap(),
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

    // Server mode shows exactly what local mode shows. Compared as strings too:
    // `serde_json::Value` equality treats -0.0 and 0.0 as equal.
    #[test]
    fn server_documents_render_exactly_as_local_mode_renders_them() {
        for case in fixture() {
            let want = ui_json(&case.local).unwrap();
            let got = ui_json(&doc_from_wire(&case.canonical).unwrap()).unwrap();
            assert_eq!(got, want, "fixture line {}", case.line);
            assert_eq!(
                ui_string_from_wire(&case.canonical).unwrap(),
                serde_json::to_string(&want).unwrap(),
                "fixture line {}",
                case.line
            );
        }
    }

    // Decoding keeps every value's type and every key's position.
    #[test]
    fn server_documents_decode_to_the_documents_local_mode_decodes() {
        for case in fixture() {
            let got = doc_from_wire(&case.canonical).unwrap();
            assert_eq!(
                format!("{got:?}"),
                format!("{:?}", case.local),
                "fixture line {}",
                case.line
            );
        }
    }

    // What the desktop sends is what the server's driver would send back.
    #[test]
    fn documents_encode_to_the_servers_canonical_form() {
        for case in fixture() {
            let sent: serde_json::Value = serde_json::from_str(&doc_to_wire(&case.local)).unwrap();
            let expected: serde_json::Value = serde_json::from_str(&case.canonical).unwrap();
            assert_eq!(sent, expected, "fixture line {}", case.line);
            assert_eq!(
                format!("{:?}", doc_from_wire(&doc_to_wire(&case.local)).unwrap()),
                format!("{:?}", case.local),
                "fixture line {}",
                case.line
            );
        }
    }

    #[test]
    fn malformed_server_documents_are_errors() {
        let err = doc_from_wire("{not json").unwrap_err();
        assert!(err.contains("not JSON"), "{err}");

        let err = doc_from_wire("[1, 2]").unwrap_err();
        assert!(err.contains("where a document was expected"), "{err}");

        let err = doc_from_wire(r#"{"n": {"$numberLong": "twelve"}}"#).unwrap_err();
        assert!(err.contains("not valid Extended JSON"), "{err}");
    }
}
