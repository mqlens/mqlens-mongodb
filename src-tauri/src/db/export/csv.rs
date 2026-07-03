//! CSV encoding via the `csv` crate with configurable delimiter, quote, and
//! record separator. Cells resolve dot-notation paths; sub-documents and
//! arrays render as JSON strings.

use super::json::doc_to_json_string;
use super::options::{lookup_path, CsvOptions, JsonMode};
use mongodb::bson::{Bson, Document};

/// Encode one record (including the trailing record separator). A fresh
/// writer per record is negligible next to cursor/disk I/O and avoids
/// buffer-ownership gymnastics with the `csv` crate.
pub fn csv_record(cells: &[String], opts: &CsvOptions) -> Result<Vec<u8>, String> {
    let terminator = if opts.record_separator == "\r\n" {
        ::csv::Terminator::CRLF
    } else {
        ::csv::Terminator::Any(b'\n')
    };
    let mut writer = ::csv::WriterBuilder::new()
        .delimiter(opts.delimiter.as_bytes()[0])
        .quote(opts.quote.as_bytes()[0])
        .terminator(terminator)
        .from_writer(Vec::new());
    writer
        .write_record(cells)
        .map_err(|e| format!("CSV encoding error: {}", e))?;
    writer
        .into_inner()
        .map_err(|e| format!("CSV encoding error: {}", e))
}

/// Render one cell: scalars human-readable, sub-documents/arrays as relaxed
/// JSON strings, null/missing per `null_as_empty`.
pub fn csv_cell_value(doc: &Document, path: &str, opts: &CsvOptions) -> String {
    let null_value = || if opts.null_as_empty { String::new() } else { "null".to_string() };
    match lookup_path(doc, path) {
        None => null_value(),
        Some(Bson::Null) => null_value(),
        Some(Bson::String(s)) => s.clone(),
        Some(Bson::Int32(n)) => n.to_string(),
        Some(Bson::Int64(n)) => n.to_string(),
        Some(Bson::Double(n)) => n.to_string(),
        Some(Bson::Boolean(b)) => b.to_string(),
        Some(Bson::ObjectId(oid)) => oid.to_hex(),
        Some(Bson::DateTime(dt)) => dt
            .try_to_rfc3339_string()
            .unwrap_or_else(|_| dt.timestamp_millis().to_string()),
        Some(Bson::Document(sub)) => {
            doc_to_json_string(sub, JsonMode::Relaxed).unwrap_or_default()
        }
        Some(other) => {
            // Arrays, Decimal128, Binary, regex, … — relaxed EJSON value.
            let value = other.clone().into_relaxed_extjson();
            serde_json::to_string(&value).unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::export::options::CsvOptions;
    use mongodb::bson::{doc, DateTime};

    fn opts() -> CsvOptions {
        CsvOptions::default()
    }

    #[test]
    fn record_quotes_and_joins_with_default_options() {
        let out = csv_record(&["a,b".into(), "plain".into(), "q\"q".into()], &opts()).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "\"a,b\",plain,\"q\"\"q\"\n");
    }

    #[test]
    fn record_honors_delimiter_and_crlf() {
        let mut o = opts();
        o.delimiter = ";".into();
        o.record_separator = "\r\n".into();
        let out = csv_record(&["a".into(), "b;c".into()], &o).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "a;\"b;c\"\r\n");
    }

    #[test]
    fn cell_value_renders_scalars_nested_paths_and_null_modes() {
        let d = doc! {"s": "x", "n": 2i32, "b": true, "z": null,
                      "addr": {"city": "Pune"}, "tags": ["a", "b"],
                      "when": DateTime::from_millis(0)};
        let o = opts();
        assert_eq!(csv_cell_value(&d, "s", &o), "x");
        assert_eq!(csv_cell_value(&d, "n", &o), "2");
        assert_eq!(csv_cell_value(&d, "b", &o), "true");
        assert_eq!(csv_cell_value(&d, "z", &o), ""); // null_as_empty default
        assert_eq!(csv_cell_value(&d, "addr.city", &o), "Pune");
        assert_eq!(csv_cell_value(&d, "missing", &o), "");
        assert_eq!(csv_cell_value(&d, "tags", &o), r#"["a","b"]"#); // arrays as JSON
        assert!(csv_cell_value(&d, "when", &o).starts_with("1970-01-01T00:00:00"));
        let mut o2 = opts();
        o2.null_as_empty = false;
        assert_eq!(csv_cell_value(&d, "z", &o2), "null");
    }
}
