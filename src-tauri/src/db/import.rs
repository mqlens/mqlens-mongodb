//! File/paste import pipeline: a pull-based document reader shared by the
//! preview command (first N docs) and the background import task (Task 4).

use crate::db::documents::{
    csv_record_to_doc, generated_headers, parse_json_array_docs, validate_csv_import_options,
    CsvImportOptions,
};
use mongodb::bson::Document;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportSourceArg {
    pub path: Option<String>,
    pub text: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub docs: Vec<String>,
    pub columns: Vec<String>,
    pub total_hint: Option<u64>,
    pub error: Option<String>,
}

/// Boxed byte source: an open file or the pasted text.
type ByteSource = Box<dyn Read + Send>;

fn open_bytes(source: &ImportSourceArg) -> Result<ByteSource, String> {
    match (&source.path, &source.text) {
        (Some(path), None) => {
            let file = std::fs::File::open(path)
                .map_err(|e| format!("Failed to read import file: {}", e))?;
            Ok(Box::new(file))
        }
        (None, Some(text)) => Ok(Box::new(std::io::Cursor::new(text.clone().into_bytes()))),
        _ => Err("Import source must be exactly one of a file path or pasted text".to_string()),
    }
}

impl std::fmt::Debug for ImportReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let variant = match self {
            ImportReader::JsonArray { .. } => "JsonArray",
            ImportReader::Ndjson { .. } => "Ndjson",
            ImportReader::Csv { .. } => "Csv",
            ImportReader::Bson { .. } => "Bson",
        };
        f.debug_struct("ImportReader").field("variant", &variant).finish()
    }
}

pub(crate) enum ImportReader {
    JsonArray {
        docs: std::vec::IntoIter<Document>,
        total: u64,
    },
    Ndjson {
        lines: std::io::Lines<BufReader<ByteSource>>,
        line_no: usize,
    },
    Csv {
        records: csv::StringRecordsIntoIter<BufReader<ByteSource>>,
        headers: Vec<String>,
        options: CsvImportOptions,
        row: usize,
    },
    Bson {
        reader: BufReader<ByteSource>,
        eof: bool,
    },
}

impl ImportReader {
    pub fn open(
        source: &ImportSourceArg,
        format: &str,
        csv: &CsvImportOptions,
    ) -> Result<ImportReader, String> {
        let format = format.trim().to_lowercase();
        match format.as_str() {
            "json" => {
                let mut text = String::new();
                open_bytes(source)?
                    .read_to_string(&mut text)
                    .map_err(|e| format!("Failed to read import file: {}", e))?;
                let docs = parse_json_array_docs(&text)?;
                Ok(ImportReader::JsonArray {
                    total: docs.len() as u64,
                    docs: docs.into_iter(),
                })
            }
            "ndjson" | "jsonl" => Ok(ImportReader::Ndjson {
                lines: BufReader::new(open_bytes(source)?).lines(),
                line_no: 0,
            }),
            "csv" => {
                validate_csv_import_options(csv)?;
                // skip_lines + headers need text-mode preprocessing; for the
                // header row we read it via the csv Reader itself.
                let mut buf = BufReader::new(open_bytes(source)?);
                let mut skipped = String::new();
                for _ in 0..csv.skip_lines {
                    skipped.clear();
                    if buf
                        .read_line(&mut skipped)
                        .map_err(|e| format!("Failed to read import file: {}", e))?
                        == 0
                    {
                        break;
                    }
                }
                let mut reader = csv::ReaderBuilder::new()
                    .has_headers(csv.has_headers)
                    .delimiter(csv.delimiter.as_bytes()[0])
                    .quote(csv.quote.as_bytes()[0])
                    .flexible(true)
                    .from_reader(buf);
                let headers: Vec<String> = if csv.has_headers {
                    reader
                        .headers()
                        .map_err(|e| format!("Invalid CSV header: {}", e))?
                        .iter()
                        .map(|h| h.to_string())
                        .collect()
                } else {
                    Vec::new() // resolved lazily from the first record's width
                };
                Ok(ImportReader::Csv {
                    records: reader.into_records(),
                    headers,
                    options: csv.clone(),
                    row: 0,
                })
            }
            "bson" => {
                if source.text.is_some() {
                    return Err("BSON import requires a file source".to_string());
                }
                Ok(ImportReader::Bson {
                    reader: BufReader::new(open_bytes(source)?),
                    eof: false,
                })
            }
            other => Err(format!("Unsupported import format: {}", other)),
        }
    }

    pub fn columns(&self) -> &[String] {
        match self {
            ImportReader::Csv { headers, .. } => headers,
            _ => &[],
        }
    }

    pub fn total_hint(&self) -> Option<u64> {
        match self {
            ImportReader::JsonArray { total, .. } => Some(*total),
            _ => None,
        }
    }

    pub fn next_doc(&mut self) -> Result<Option<Document>, String> {
        match self {
            ImportReader::JsonArray { docs, .. } => Ok(docs.next()),
            ImportReader::Ndjson { lines, line_no } => {
                for line in lines.by_ref() {
                    *line_no += 1;
                    let line = line.map_err(|e| format!("Failed to read import file: {}", e))?;
                    if line.trim().is_empty() {
                        continue;
                    }
                    return crate::json_to_bson_document(&line)
                        .map(Some)
                        .map_err(|e| format!("NDJSON line {}: {}", line_no, e));
                }
                Ok(None)
            }
            ImportReader::Csv { records, headers, options, row } => {
                match records.next() {
                    None => Ok(None),
                    Some(record) => {
                        *row += 1;
                        let record =
                            record.map_err(|e| format!("Invalid CSV row {}: {}", row, e))?;
                        if headers.is_empty() {
                            *headers = generated_headers(record.len());
                        }
                        csv_record_to_doc(headers, &record, options, *row).map(Some)
                    }
                }
            }
            ImportReader::Bson { reader, eof } => {
                if *eof {
                    return Ok(None);
                }
                // Peek one byte to detect clean EOF before from_reader errors.
                let mut peek = [0u8; 1];
                match reader.read(&mut peek) {
                    Ok(0) => {
                        *eof = true;
                        return Ok(None);
                    }
                    Ok(_) => {}
                    Err(e) => return Err(format!("Failed to read import file: {}", e)),
                }
                let chained = std::io::Cursor::new(peek).chain(reader.by_ref());
                Document::from_reader(chained)
                    .map(Some)
                    .map_err(|e| format!("Invalid BSON: {}", e))
            }
        }
    }
}

/// Preview: parse up to `limit` docs; parse errors come back inline so the
/// UI can render them next to the rows that did parse.
pub async fn preview_import_impl(
    source: ImportSourceArg,
    format: &str,
    csv_options: Option<CsvImportOptions>,
    limit: usize,
) -> Result<ImportPreview, String> {
    let csv = csv_options.unwrap_or_default();
    let format = format.to_string();
    // Parsing is synchronous file I/O — run it off the async thread.
    tokio::task::spawn_blocking(move || {
        let mut reader = ImportReader::open(&source, &format, &csv)?;
        let total_hint = reader.total_hint();
        let mut docs = Vec::new();
        let mut error = None;
        while docs.len() < limit {
            match reader.next_doc() {
                Ok(Some(doc)) => docs.push(
                    serde_json::to_string(
                        &mongodb::bson::Bson::Document(doc).into_relaxed_extjson(),
                    )
                    .unwrap_or_default(),
                ),
                Ok(None) => break,
                Err(e) => {
                    error = Some(e);
                    break;
                }
            }
        }
        Ok(ImportPreview {
            columns: reader.columns().to_vec(),
            total_hint,
            docs,
            error,
        })
    })
    .await
    .map_err(|e| format!("Preview task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::documents::CsvImportOptions;

    fn text_source(s: &str) -> ImportSourceArg {
        ImportSourceArg { path: None, text: Some(s.to_string()) }
    }

    #[test]
    fn reader_streams_ndjson_and_stops_at_error_line() {
        let mut r = ImportReader::open(
            &text_source("{\"a\":1}\n\n{\"a\":2}\nnot json\n"),
            "ndjson",
            &CsvImportOptions::default(),
        )
        .unwrap();
        // Small JSON integers round-trip as Bson::Int32 (see
        // Bson::try_from<serde_json::Value> in the bson crate), not Int64.
        assert_eq!(r.next_doc().unwrap().unwrap().get_i32("a").ok(), Some(1));
        assert_eq!(r.next_doc().unwrap().unwrap().get_i32("a").ok(), Some(2));
        let err = r.next_doc().unwrap_err();
        assert!(err.contains("line 4"), "{err}");
    }

    #[test]
    fn reader_csv_exposes_columns() {
        let mut r = ImportReader::open(
            &text_source("a,b\n1,2\n"),
            "csv",
            &CsvImportOptions::default(),
        )
        .unwrap();
        assert_eq!(r.columns(), &["a".to_string(), "b".to_string()]);
        assert!(r.next_doc().unwrap().is_some());
        assert!(r.next_doc().unwrap().is_none());
    }

    #[test]
    fn reader_json_array_has_total_hint() {
        let mut r = ImportReader::open(
            &text_source("[{\"a\":1},{\"a\":2}]"),
            "json",
            &CsvImportOptions::default(),
        )
        .unwrap();
        assert_eq!(r.total_hint(), Some(2));
        assert!(r.next_doc().unwrap().is_some());
    }

    #[test]
    fn source_arg_validation() {
        let both = ImportSourceArg { path: Some("x".into()), text: Some("y".into()) };
        assert!(ImportReader::open(&both, "json", &CsvImportOptions::default()).is_err());
        let neither = ImportSourceArg { path: None, text: None };
        assert!(ImportReader::open(&neither, "json", &CsvImportOptions::default()).is_err());
        let bson_text = ImportSourceArg { path: None, text: Some("x".into()) };
        assert!(ImportReader::open(&bson_text, "bson", &CsvImportOptions::default())
            .unwrap_err()
            .contains("file"));
    }
}
