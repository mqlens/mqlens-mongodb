//! JSON / NDJSON serialization: one compact Extended-JSON string per document,
//! in relaxed (human-readable) or canonical (mongoexport-compatible) mode.

use super::options::JsonMode;
use mongodb::bson::{Bson, Document};

pub fn doc_to_json_string(doc: &Document, mode: JsonMode) -> Result<String, String> {
    let value = match mode {
        JsonMode::Relaxed => Bson::Document(doc.clone()).into_relaxed_extjson(),
        JsonMode::Canonical => Bson::Document(doc.clone()).into_canonical_extjson(),
    };
    serde_json::to_string(&value).map_err(|e| format!("JSON serialization error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::export::options::JsonMode;
    use mongodb::bson::{doc, oid::ObjectId, DateTime};

    #[test]
    fn relaxed_mode_keeps_human_readable_scalars() {
        let d = doc! {"n": 5i64, "s": "x"};
        let s = doc_to_json_string(&d, JsonMode::Relaxed).unwrap();
        assert_eq!(s, r#"{"n":5,"s":"x"}"#);
    }

    #[test]
    fn canonical_mode_wraps_types_mongoexport_style() {
        let oid = ObjectId::new();
        let d = doc! {"_id": oid, "n": 5i64, "when": DateTime::from_millis(0)};
        let s = doc_to_json_string(&d, JsonMode::Canonical).unwrap();
        assert!(s.contains(&format!(r#"{{"$oid":"{}"}}"#, oid.to_hex())));
        assert!(s.contains(r#"{"$numberLong":"5"}"#));
        assert!(s.contains(r#"$date"#));
    }
}
