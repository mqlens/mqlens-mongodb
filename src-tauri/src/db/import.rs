//! File/paste import pipeline: a pull-based document reader shared by the
//! preview command (first N docs) and the background import task (Task 4).

use crate::db::documents::{
    csv_record_to_doc, generated_headers, parse_json_array_docs, validate_csv_import_options,
    CsvImportOptions,
};
use crate::db::tasks::{fail_task, finish_task, now_ms, update_task};
use crate::{AppState, LockExt, TaskInfo};
use mongodb::bson::Document;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

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

// One ImportReader is built per import/preview job (not a hot path), so the
// size gap between the Bson variant (a BufReader) and the others is irrelevant.
#[allow(clippy::large_enum_variant)]
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
                match Document::from_reader(chained) {
                    Ok(doc) => Ok(Some(doc)),
                    Err(e) => {
                        // A parse error leaves the reader's position undefined for a
                        // retry, so stop pulling further docs from this reader.
                        *eof = true;
                        Err(format!("Invalid BSON: {}", e))
                    }
                }
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
                Ok(Some(doc)) => {
                    match serde_json::to_string(
                        &mongodb::bson::Bson::Document(doc).into_relaxed_extjson(),
                    ) {
                        Ok(s) => docs.push(s),
                        Err(e) => {
                            error = Some(format!("Failed to serialize document for preview: {}", e));
                            break;
                        }
                    }
                }
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

/// Read → batch → write loop for the background import task. Returns the
/// processed count plus the insert/update/skip totals across all batches.
#[allow(clippy::too_many_arguments)]
async fn run_import(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: String,
    client: Option<mongodb::Client>,
    database: String,
    collection: String,
    source: ImportSourceArg,
    format: String,
    csv: CsvImportOptions,
    mode: String,
) -> Result<(u64, crate::db::documents::ImportResult), String> {
    use crate::db::documents::ImportResult;
    use crate::limits::IMPORT_BATCH_SIZE;

    // The reader is synchronous file I/O — open and read batches on
    // spawn_blocking, threading the reader through each hop.
    let mut reader = tokio::task::spawn_blocking({
        let source = source.clone();
        let format = format.clone();
        let csv = csv.clone();
        move || ImportReader::open(&source, &format, &csv)
    })
    .await
    .map_err(|e| format!("Import task failed: {}", e))??;
    if let Some(total) = reader.total_hint() {
        update_task(&tasks, &task_id, |t| t.total = Some(total));
    }

    let mut totals = ImportResult { inserted: 0, updated: 0, skipped: 0 };
    let mut processed = 0u64;
    loop {
        // Pull one batch synchronously (cheap CPU; reads are buffered).
        let (next_reader, batch) = tokio::task::spawn_blocking(move || {
            let mut r = reader;
            let mut batch = Vec::with_capacity(IMPORT_BATCH_SIZE);
            let result: Result<(), String> = loop {
                if batch.len() >= IMPORT_BATCH_SIZE {
                    break Ok(());
                }
                match r.next_doc() {
                    Ok(Some(doc)) => batch.push(doc),
                    Ok(None) => break Ok(()),
                    Err(e) => break Err(e),
                }
            };
            (r, result.map(|_| batch))
        })
        .await
        .map_err(|e| format!("Import task failed: {}", e))?;
        reader = next_reader;
        let batch = batch?;
        if batch.is_empty() {
            break;
        }
        let n = batch.len() as u64;

        match &client {
            None => {
                // Mock: validate-only semantics, mirroring the parse-and-count
                // behavior of the non-task import path.
                if mode == "update" {
                    totals.updated += n;
                } else {
                    totals.inserted += n;
                }
            }
            Some(client) => {
                let coll = client
                    .database(&database)
                    .collection::<Document>(&collection);
                let res = crate::db::documents::write_imported_docs(&coll, batch, &mode).await?;
                totals.inserted += res.inserted;
                totals.updated += res.updated;
                totals.skipped += res.skipped;
            }
        }
        processed += n;
        update_task(&tasks, &task_id, |t| {
            t.processed = processed;
            t.message = format!("Importing ({} written)", processed);
        });
    }
    Ok((processed, totals))
}

#[allow(clippy::too_many_arguments)]
pub async fn start_import_task_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    source: ImportSourceArg,
    format: &str,
    csv_options: Option<CsvImportOptions>,
    mode: &str,
) -> Result<TaskInfo, String> {
    if !matches!(mode, "skip" | "update" | "abort") {
        return Err("Import mode must be skip, update, or abort".to_string());
    }
    let csv = csv_options.unwrap_or_default();
    if format.trim().eq_ignore_ascii_case("csv") {
        validate_csv_import_options(&csv)?;
    }
    // Validate the source shape up front (open errors surface on the task).
    if source.path.is_some() == source.text.is_some() {
        return Err("Import source must be exactly one of a file path or pasted text".to_string());
    }

    let is_mock = crate::connection_is_mock(state, id)?;
    let client = if is_mock {
        None
    } else {
        Some(crate::require_real_client(state, id)?)
    };

    let source_label = source
        .path
        .as_deref()
        .and_then(|p| {
            std::path::Path::new(p)
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "pasted text".to_string());
    let task_id = Uuid::new_v4().to_string();
    let task = TaskInfo {
        id: task_id.clone(),
        kind: "import".to_string(),
        label: format!("Import {}.{} from {}", database, collection, source_label),
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Queued".to_string(),
        path: source.path.clone(),
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
        sub_label: None,
        items_processed: None,
        items_total: None,
        summary: None,
    };
    state.tasks.lock_safe()?.insert(task_id.clone(), task.clone());

    let tasks = state.tasks.clone();
    let database = database.to_string();
    let collection = collection.to_string();
    let format = format.to_string();
    let mode = mode.to_string();
    tokio::spawn(async move {
        let result = run_import(
            tasks.clone(),
            task_id.clone(),
            client,
            database,
            collection,
            source,
            format,
            csv,
            mode,
        )
        .await;
        match result {
            Ok((processed, totals)) => {
                // TaskInfo.summary is typed for copy tasks (CopySummary), so
                // the import counts ride on the completion message.
                let message = format!(
                    "Import complete: {} inserted, {} updated, {} skipped",
                    totals.inserted, totals.updated, totals.skipped
                );
                finish_task(&tasks, &task_id, processed, message);
            }
            Err(err) => fail_task(&tasks, &task_id, err),
        }
    });
    Ok(task)
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::db::documents::{CsvColumnType, CsvImportOptions};

    fn text_source(s: &str) -> ImportSourceArg {
        ImportSourceArg { path: None, text: Some(s.to_string()) }
    }

    /// Drain an ImportReader into a Vec<Document>, mirroring the old
    /// parse_csv_docs return shape for these ported option-matrix tests.
    fn drain(r: &mut ImportReader) -> Result<Vec<Document>, String> {
        let mut docs = Vec::new();
        while let Some(doc) = r.next_doc()? {
            docs.push(doc);
        }
        Ok(docs)
    }

    // The following csv_* tests port the option-matrix coverage that used to
    // exercise documents::parse_csv_docs directly (now deleted — it had no
    // production callers) onto ImportReader, the path the app actually ships.

    #[test]
    fn csv_default_options_match_previous_behavior() {
        let mut r =
            ImportReader::open(&text_source("a,b\n1,x\n"), "csv", &CsvImportOptions::default())
                .unwrap();
        let docs = drain(&mut r).unwrap();
        assert_eq!(
            docs[0].get_i64("a").ok().or(docs[0].get_i32("a").map(i64::from).ok()),
            Some(1)
        );
        assert_eq!(docs[0].get_str("b").unwrap(), "x");
    }

    #[test]
    fn csv_delimiter_qualifier_skip_and_headerless() {
        let text = "junk line\nA;\"x;y\"\n2;z\n";
        let mut o = CsvImportOptions::default();
        o.delimiter = ";".into();
        o.skip_lines = 1;
        o.has_headers = false;
        let mut r = ImportReader::open(&text_source(text), "csv", &o).unwrap();
        let docs = drain(&mut r).unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].get_str("col1").unwrap(), "A");
        assert_eq!(docs[0].get_str("col2").unwrap(), "x;y");
        assert_eq!(docs[1].get_str("col2").unwrap(), "z");
    }

    #[test]
    fn csv_explicit_column_types_convert_and_error_with_context() {
        let mut o = CsvImportOptions::default();
        o.column_types.insert("n".into(), CsvColumnType::Number);
        o.column_types.insert("ok".into(), CsvColumnType::Boolean);
        o.column_types.insert("when".into(), CsvColumnType::Date);
        o.column_types.insert("meta".into(), CsvColumnType::Json);
        o.column_types.insert("s".into(), CsvColumnType::String);
        let mut r = ImportReader::open(
            &text_source("n,ok,when,meta,s\n4.5,TRUE,2024-01-02T03:04:05Z,{\"a\":1},42\n"),
            "csv",
            &o,
        )
        .unwrap();
        let docs = drain(&mut r).unwrap();
        let d = &docs[0];
        assert_eq!(d.get_f64("n").unwrap(), 4.5);
        assert!(d.get_bool("ok").unwrap());
        assert!(matches!(d.get("when"), Some(mongodb::bson::Bson::DateTime(_))));
        assert_eq!(
            d.get_document("meta")
                .unwrap()
                .get_i64("a")
                .ok()
                .or(d.get_document("meta").unwrap().get_i32("a").map(i64::from).ok()),
            Some(1)
        );
        assert_eq!(d.get_str("s").unwrap(), "42"); // String type keeps digits as text

        let mut err_reader =
            ImportReader::open(&text_source("n\nnot-a-number\n"), "csv", &o).unwrap();
        let err = drain(&mut err_reader).unwrap_err();
        assert!(err.contains("row 1") && err.contains("\"n\"") && err.contains("number"), "{err}");
    }

    #[test]
    fn csv_date_accepts_epoch_millis_and_number_is_i64_when_integral() {
        let mut o = CsvImportOptions::default();
        o.column_types.insert("when".into(), CsvColumnType::Date);
        o.column_types.insert("n".into(), CsvColumnType::Number);
        let mut r =
            ImportReader::open(&text_source("when,n\n1700000000000,7\n"), "csv", &o).unwrap();
        let docs = drain(&mut r).unwrap();
        assert!(matches!(docs[0].get("when"), Some(mongodb::bson::Bson::DateTime(_))));
        assert_eq!(docs[0].get_i64("n").unwrap(), 7);
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
    fn reader_bson_reads_docs_from_file_and_reports_eof() {
        use mongodb::bson::doc;
        let path = std::env::temp_dir().join(format!(
            "mqlens-import-reader-bson-test-{}-{}.bson",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut bytes = mongodb::bson::to_vec(&doc! { "_id": 1, "name": "Ada" }).unwrap();
        bytes.extend(mongodb::bson::to_vec(&doc! { "_id": 2, "name": "Bob" }).unwrap());
        std::fs::write(&path, &bytes).unwrap();

        let mut r = ImportReader::open(
            &ImportSourceArg { path: Some(path.to_string_lossy().to_string()), text: None },
            "bson",
            &CsvImportOptions::default(),
        )
        .unwrap();
        assert_eq!(r.next_doc().unwrap().unwrap().get_i32("_id").ok(), Some(1));
        assert_eq!(r.next_doc().unwrap().unwrap().get_i32("_id").ok(), Some(2));
        assert!(r.next_doc().unwrap().is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn bson_reader_sets_eof_after_a_parse_error_so_it_does_not_retry() {
        use mongodb::bson::doc;
        // A valid document, then a malformed 12-byte "document" (declared
        // length but not null-terminated, so it fails validation without
        // consuming trailing bytes), then trailing bytes that would
        // otherwise look like more input to (unsuccessfully) parse.
        let mut bytes = mongodb::bson::to_vec(&doc! { "a": 1 }).unwrap();
        bytes.extend_from_slice(&12i32.to_le_bytes());
        bytes.extend_from_slice(&[0xFFu8; 8]);
        bytes.extend_from_slice(b"TRAILING");

        let path = std::env::temp_dir().join(format!(
            "mqlens-import-reader-bson-badeof-{}-{}.bson",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, &bytes).unwrap();

        let mut r = ImportReader::open(
            &ImportSourceArg { path: Some(path.to_string_lossy().to_string()), text: None },
            "bson",
            &CsvImportOptions::default(),
        )
        .unwrap();
        assert!(r.next_doc().unwrap().is_some());
        let err = r.next_doc().unwrap_err();
        assert!(err.contains("Invalid BSON"), "{err}");
        // The reader must report EOF rather than attempt to parse the
        // trailing bytes as another document.
        assert!(r.next_doc().unwrap().is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn open_rejects_unknown_format() {
        let err = ImportReader::open(&text_source("nope"), "yaml", &CsvImportOptions::default())
            .unwrap_err();
        assert!(err.contains("Unsupported import format"), "{err}");
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
