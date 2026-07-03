//! Export option structs (deserialized from the frontend) and field-selection
//! helpers shared by all format writers.

use mongodb::bson::{doc, Bson, Document};
use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    /// Dot-notation paths to export; `None` = all fields (current behavior).
    pub fields: Option<Vec<String>>,
    pub json_mode: JsonMode,
    pub csv: CsvOptions,
    pub xlsx: XlsxOptions,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum JsonMode {
    #[default]
    Relaxed,
    Canonical,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvOptions {
    pub delimiter: String,
    pub quote: String,
    pub record_separator: String,
    pub include_headers: bool,
    pub null_as_empty: bool,
}

impl Default for CsvOptions {
    fn default() -> Self {
        Self {
            delimiter: ",".into(),
            quote: "\"".into(),
            record_separator: "\n".into(),
            include_headers: true,
            null_as_empty: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct XlsxOptions {
    pub include_headers: bool,
    pub bold_headers: bool,
    pub auto_size: bool,
    pub alignment: XlsxAlign,
}

impl Default for XlsxOptions {
    fn default() -> Self {
        Self {
            include_headers: true,
            bold_headers: false,
            auto_size: false,
            alignment: XlsxAlign::Left,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum XlsxAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// Validate option combinations for the chosen format. CSV separators must be
/// single ASCII characters (the `csv` crate requires `u8`); a `Some` field list
/// must not be empty; record separator must be `\n` or `\r\n`.
pub fn validate_options(format: &str, options: &ExportOptions) -> Result<(), String> {
    if let Some(fields) = &options.fields {
        if fields.is_empty() {
            return Err("Select at least one field to export".to_string());
        }
    }
    if format == "csv" {
        if options.csv.delimiter.len() != 1 || !options.csv.delimiter.is_ascii() {
            return Err("CSV delimiter must be a single ASCII character".to_string());
        }
        if options.csv.quote.len() != 1 || !options.csv.quote.is_ascii() {
            return Err("CSV quote must be a single ASCII character".to_string());
        }
        if options.csv.record_separator != "\n" && options.csv.record_separator != "\r\n" {
            return Err("CSV record separator must be \\n or \\r\\n".to_string());
        }
    }
    Ok(())
}

/// Resolve a dot-notation path inside a document. Arrays are leaves: a path
/// segment never indexes into an array (matching the schema analyzer).
pub fn lookup_path<'a>(doc: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut current = doc;
    let mut segments = path.split('.').peekable();
    while let Some(seg) = segments.next() {
        let value = current.get(seg)?;
        if segments.peek().is_none() {
            return Some(value);
        }
        match value {
            Bson::Document(sub) => current = sub,
            _ => return None,
        }
    }
    None
}

/// Build a find projection from selected dot paths. MongoDB includes `_id`
/// unless explicitly excluded, so deselecting it adds `_id: 0`.
pub fn build_projection(fields: &[String]) -> Document {
    let mut projection = Document::new();
    for field in fields {
        projection.insert(field.clone(), 1);
    }
    if !fields.iter().any(|f| f == "_id") {
        projection.insert("_id", 0);
    }
    projection
}

/// Client-side equivalent of `build_projection` for documents that never went
/// through a server (mock connections, current-results exports).
pub fn project_document(doc: &Document, fields: &[String]) -> Document {
    let mut out = Document::new();
    for field in fields {
        let Some(value) = lookup_path(doc, field) else { continue };
        // Rebuild the nested structure segment by segment.
        let segments: Vec<&str> = field.split('.').collect();
        let mut target = &mut out;
        for seg in &segments[..segments.len() - 1] {
            if !matches!(target.get(*seg), Some(Bson::Document(_))) {
                target.insert(seg.to_string(), Document::new());
            }
            target = match target.get_mut(*seg) {
                Some(Bson::Document(d)) => d,
                _ => unreachable!("just inserted a document"),
            };
        }
        target.insert(segments[segments.len() - 1].to_string(), value.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    #[test]
    fn default_options_match_current_behavior() {
        let o = ExportOptions::default();
        assert!(o.fields.is_none());
        assert!(matches!(o.json_mode, JsonMode::Relaxed));
        assert_eq!(o.csv.delimiter, ",");
        assert_eq!(o.csv.quote, "\"");
        assert_eq!(o.csv.record_separator, "\n");
        assert!(o.csv.include_headers);
        assert!(o.csv.null_as_empty);
        assert!(o.xlsx.include_headers);
        assert!(!o.xlsx.bold_headers);
    }

    #[test]
    fn options_deserialize_from_camel_case_partial_json() {
        let o: ExportOptions = serde_json::from_str(
            r#"{"jsonMode":"canonical","csv":{"delimiter":";","includeHeaders":false}}"#,
        )
        .unwrap();
        assert!(matches!(o.json_mode, JsonMode::Canonical));
        assert_eq!(o.csv.delimiter, ";");
        assert!(!o.csv.include_headers);
        assert_eq!(o.csv.quote, "\""); // unspecified fields keep defaults
    }

    #[test]
    fn validate_rejects_bad_delimiter_and_empty_fields() {
        let mut o = ExportOptions::default();
        o.csv.delimiter = "ab".into();
        assert!(validate_options("csv", &o).is_err());
        o.csv.delimiter = "€".into(); // non-ASCII
        assert!(validate_options("csv", &o).is_err());
        let mut o = ExportOptions::default();
        o.fields = Some(vec![]);
        assert!(validate_options("json", &o).is_err());
        // delimiter irrelevant for non-csv formats
        let mut o = ExportOptions::default();
        o.csv.delimiter = "ab".into();
        assert!(validate_options("json", &o).is_ok());
    }

    #[test]
    fn lookup_path_resolves_nested_and_missing() {
        let d = doc! {"a": {"b": {"c": 5}}, "x": 1};
        assert_eq!(lookup_path(&d, "a.b.c").unwrap().as_i32(), Some(5));
        assert_eq!(lookup_path(&d, "x").unwrap().as_i32(), Some(1));
        assert!(lookup_path(&d, "a.b.z").is_none());
        assert!(lookup_path(&d, "x.y").is_none()); // scalar mid-path
    }

    #[test]
    fn build_projection_includes_fields_and_excludes_unselected_id() {
        let p = build_projection(&["name".into(), "addr.city".into()]);
        assert_eq!(p, doc! {"name": 1, "addr.city": 1, "_id": 0});
        let p = build_projection(&["_id".into(), "name".into()]);
        assert_eq!(p, doc! {"_id": 1, "name": 1});
    }

    #[test]
    fn project_document_keeps_only_selected_paths() {
        let d = doc! {"_id": 1, "name": "a", "addr": {"city": "x", "zip": "y"}, "extra": true};
        let out = project_document(&d, &["name".into(), "addr.city".into()]);
        assert_eq!(out, doc! {"name": "a", "addr": {"city": "x"}});
    }
}
