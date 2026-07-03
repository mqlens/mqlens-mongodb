//! Collection export jobs.
//!
//! Two entry points share one background-task core ([`start_export_task`]):
//! - [`start_collection_export_impl`] — the whole collection (find with an empty filter).
//! - [`start_filtered_export_impl`] — the documents matching an active find filter
//!   (filter + sort + projection, optionally skip/limit) or an aggregation pipeline.
//!
//! Both real (live MongoDB) and mock connections funnel through the same per-format
//! writer ([`write_docs`]) once their documents are adapted into a
//! `Stream<Item = Result<Document, String>>`.

pub mod options;
pub mod json;
pub mod csv;
pub mod xlsx;

use options::ExportOptions;

use crate::state::LockExt;
use crate::{mock_db, AppState, TaskInfo};
use futures::stream::{Stream, StreamExt};
use mongodb::bson::{doc, Document};
use mongodb::Client;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn update_task<F>(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, update: F)
where
    F: FnOnce(&mut TaskInfo),
{
    if let Some(task) = tasks
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(task_id)
    {
        update(task);
    }
}

fn fail_task(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, err: String) {
    update_task(tasks, task_id, |task| {
        task.status = "failed".to_string();
        task.message = "Export failed".to_string();
        task.error = Some(err);
        task.finished_at_ms = Some(now_ms());
    });
    prune_export_tasks(tasks);
}

fn finish_task(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, processed: u64) {
    update_task(tasks, task_id, |task| {
        task.status = "completed".to_string();
        task.processed = processed;
        task.message = "Export complete".to_string();
        task.finished_at_ms = Some(now_ms());
    });
    prune_export_tasks(tasks);
}

fn prune_export_tasks(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>) {
    use crate::limits::MAX_TASK_HISTORY;
    let mut guard = tasks.lock().unwrap_or_else(|p| p.into_inner());
    if guard.len() <= MAX_TASK_HISTORY {
        return;
    }
    let mut entries: Vec<(String, TaskInfo)> = guard.drain().collect();
    entries.sort_by(|a, b| b.1.created_at_ms.cmp(&a.1.created_at_ms));
    for (id, task) in entries.into_iter().take(MAX_TASK_HISTORY) {
        guard.insert(id, task);
    }
}

/// What a real-connection export reads from MongoDB. Filtered exports build a
/// [`ExportSource::Find`] (filter + optional sort/projection/skip/limit) or a
/// [`ExportSource::Aggregate`] (the user's pipeline, run verbatim); a full-collection
/// export is just `Find` with an empty filter and no pagination.
// One ExportSource is built per export job (not a hot path), so the size gap
// between the find and aggregate variants is irrelevant.
#[allow(clippy::large_enum_variant)]
#[derive(Clone)]
enum ExportSource {
    Find {
        filter: Document,
        sort: Option<Document>,
        projection: Option<Document>,
        skip: Option<u64>,
        limit: Option<i64>,
    },
    Aggregate {
        stages: Vec<Document>,
    },
}

/// Open a fresh cursor over the source. Called once for JSON/NDJSON/BSON/XLSX, and
/// twice for CSV/XLSX when the column set must be scanned (field-scan pass + write
/// pass) — so an aggregate export with no field selection runs the pipeline twice.
async fn open_export_cursor(
    coll: &mongodb::Collection<Document>,
    source: &ExportSource,
) -> Result<mongodb::Cursor<Document>, String> {
    match source {
        ExportSource::Find {
            filter,
            sort,
            projection,
            skip,
            limit,
        } => {
            let mut builder = coll.find(filter.clone());
            if let Some(sort) = sort {
                builder = builder.sort(sort.clone());
            }
            if let Some(projection) = projection {
                builder = builder.projection(projection.clone());
            }
            if let Some(skip) = skip {
                builder = builder.skip(*skip);
            }
            if let Some(limit) = limit {
                builder = builder.limit(*limit);
            }
            builder.await.map_err(|e| format!("Export query failed: {}", e))
        }
        ExportSource::Aggregate { stages } => coll
            .aggregate(stages.clone())
            .await
            .map_err(|e| format!("Aggregation failed: {}", e)),
    }
}

/// Best-effort total for the progress denominator. For find we count the filter (then
/// clamp for skip/limit); for aggregate we append a `$count` stage (an extra full
/// pipeline run).
async fn count_export_source(
    coll: &mongodb::Collection<Document>,
    source: &ExportSource,
) -> Result<u64, String> {
    match source {
        ExportSource::Find {
            filter,
            skip,
            limit,
            ..
        } => {
            let n = coll
                .count_documents(filter.clone())
                .await
                .map_err(|e| format!("Count failed: {}", e))?;
            let n = n.saturating_sub(skip.unwrap_or(0));
            Ok(match limit {
                Some(l) if (*l as u64) < n => *l as u64,
                _ => n,
            })
        }
        ExportSource::Aggregate { stages } => {
            let mut counting = stages.clone();
            counting.push(doc! { "$count": "n" });
            let mut cursor = coll
                .aggregate(counting)
                .await
                .map_err(|e| format!("Count failed: {}", e))?;
            match cursor.next().await {
                Some(result) => {
                    let doc = result.map_err(|e| format!("Count failed: {}", e))?;
                    // $count emits an Int32; tolerate Int64 too.
                    Ok(doc
                        .get("n")
                        .and_then(|v| v.as_i64().or_else(|| v.as_i32().map(i64::from)))
                        .unwrap_or(0)
                        .max(0) as u64)
                }
                // Empty pipeline output (no matches) yields no $count document.
                None => Ok(0),
            }
        }
    }
}

/// Write one already-opened stream of BSON documents in the requested format.
/// `total` is the progress denominator; returns the processed count. `csv_columns`
/// is the pre-resolved column set for csv/xlsx (empty for the other formats).
#[allow(clippy::too_many_arguments)]
async fn write_docs<S>(
    tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: &str,
    mut docs: S,
    total: u64,
    format: &str,
    path: &str,
    options: &ExportOptions,
    csv_columns: Vec<String>,
) -> Result<u64, String>
where
    S: Stream<Item = Result<Document, String>> + Unpin,
{
    match format {
        "json" => {
            update_task(tasks, task_id, |task| {
                task.message = "Writing JSON".to_string();
            });
            let mut file = tokio::fs::File::create(path)
                .await
                .map_err(|e| format!("Failed to create export file: {}", e))?;
            file.write_all(b"[\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            let mut processed = 0u64;
            while let Some(result) = docs.next().await {
                let doc = result?;
                let json = json::doc_to_json_string(&doc, options.json_mode)?;
                if processed > 0 {
                    file.write_all(b",\n")
                        .await
                        .map_err(|e| format!("Failed to write export file: {}", e))?;
                }
                file.write_all(json.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
                processed += 1;
                if processed == total || processed % 100 == 0 {
                    update_task(tasks, task_id, |task| {
                        task.processed = processed;
                    });
                }
            }
            file.write_all(b"\n]\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            update_task(tasks, task_id, |task| {
                task.processed = processed;
            });
            Ok(processed)
        }
        "ndjson" => {
            update_task(tasks, task_id, |task| {
                task.message = "Writing NDJSON".to_string();
            });
            let mut file = tokio::fs::File::create(path)
                .await
                .map_err(|e| format!("Failed to create export file: {}", e))?;
            let mut processed = 0u64;
            while let Some(result) = docs.next().await {
                let doc = result?;
                let json = json::doc_to_json_string(&doc, options.json_mode)?;
                file.write_all(json.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
                file.write_all(b"\n")
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
                processed += 1;
                if processed == total || processed % 100 == 0 {
                    update_task(tasks, task_id, |task| {
                        task.processed = processed;
                    });
                }
            }
            update_task(tasks, task_id, |task| {
                task.processed = processed;
            });
            Ok(processed)
        }
        "bson" => {
            update_task(tasks, task_id, |task| {
                task.message = "Writing BSON".to_string();
            });
            let mut file = tokio::fs::File::create(path)
                .await
                .map_err(|e| format!("Failed to create export file: {}", e))?;
            let mut processed = 0u64;
            while let Some(result) = docs.next().await {
                let doc = result?;
                let bytes = mongodb::bson::to_vec(&doc)
                    .map_err(|e| format!("BSON serialization error: {}", e))?;
                file.write_all(&bytes)
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
                processed += 1;
                if processed == total || processed % 100 == 0 {
                    update_task(tasks, task_id, |task| {
                        task.processed = processed;
                    });
                }
            }
            update_task(tasks, task_id, |task| {
                task.processed = processed;
            });
            Ok(processed)
        }
        "csv" => {
            update_task(tasks, task_id, |task| {
                task.message = "Writing CSV".to_string();
            });
            let mut file = tokio::fs::File::create(path)
                .await
                .map_err(|e| format!("Failed to create export file: {}", e))?;
            if options.csv.include_headers && !csv_columns.is_empty() {
                file.write_all(&csv::csv_record(&csv_columns, &options.csv)?)
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
            }
            let mut processed = 0u64;
            while let Some(result) = docs.next().await {
                let doc = result?;
                let cells: Vec<String> = csv_columns
                    .iter()
                    .map(|field| csv::csv_cell_value(&doc, field, &options.csv))
                    .collect();
                file.write_all(&csv::csv_record(&cells, &options.csv)?)
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
                processed += 1;
                if processed == total || processed % 100 == 0 {
                    update_task(tasks, task_id, |task| {
                        task.processed = processed;
                    });
                }
            }
            update_task(tasks, task_id, |task| {
                task.processed = processed;
            });
            Ok(processed)
        }
        "xlsx" => {
            update_task(tasks, task_id, |task| {
                task.message = "Writing Excel".to_string();
            });
            let mut sink = xlsx::XlsxSink::new(path, csv_columns, options.xlsx.clone())?;
            let mut processed = 0u64;
            while let Some(result) = docs.next().await {
                let doc = result?;
                sink.write_row(&doc)?;
                processed += 1;
                if processed == total || processed % 100 == 0 {
                    update_task(tasks, task_id, |task| {
                        task.processed = processed;
                    });
                }
            }
            // Workbook::save is a blocking (sync) file write, but this closure runs
            // on a tokio::spawn-ed task, not the async executor's shared reactor.
            sink.finish()?;
            update_task(tasks, task_id, |task| {
                task.processed = processed;
            });
            Ok(processed)
        }
        other => Err(format!("Unsupported export format: {}", other)),
    }
}

#[allow(clippy::too_many_arguments)]
async fn export_mock_to_file(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: String,
    database: String,
    collection: String,
    format: String,
    path: String,
    filter: String,
    sort: String,
    skip: Option<u64>,
    limit: Option<i64>,
    options: ExportOptions,
) -> Result<u64, String> {
    let raw_docs = mock_db::execute_mock_query(
        &database,
        &collection,
        &filter,
        &sort,
        limit.unwrap_or(i64::MAX),
        skip.unwrap_or(0) as i64,
    )?;
    let mut docs: Vec<Document> = raw_docs
        .iter()
        .map(|s| crate::json_to_bson_document(s))
        .collect::<Result<_, _>>()?;
    // Mock connections never touch a server, so field selection is applied here —
    // the client-side equivalent of the `$project`/find-projection the real path uses.
    if let Some(fields) = &options.fields {
        docs = docs
            .iter()
            .map(|doc| options::project_document(doc, fields))
            .collect();
    }

    let total = docs.len() as u64;
    update_task(&tasks, &task_id, |task| {
        task.total = Some(total);
        task.message = format!("Writing {} document(s)", total);
    });

    let csv_columns: Vec<String> = if matches!(format.as_str(), "csv" | "xlsx") {
        match &options.fields {
            Some(fields) => fields.clone(),
            None => docs
                .iter()
                .flat_map(|doc| doc.keys().cloned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        }
    } else {
        Vec::new()
    };

    let stream = futures::stream::iter(docs.into_iter().map(Ok));
    write_docs(
        &tasks,
        &task_id,
        stream,
        total,
        &format,
        &path,
        &options,
        csv_columns,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn export_real_to_file(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: String,
    client: Client,
    database: String,
    collection: String,
    format: String,
    path: String,
    source: ExportSource,
    options: ExportOptions,
) -> Result<u64, String> {
    let coll = client
        .database(&database)
        .collection::<Document>(&collection);

    update_task(&tasks, &task_id, |task| {
        task.message = "Counting documents".to_string();
    });
    let total = count_export_source(&coll, &source).await?;
    update_task(&tasks, &task_id, |task| {
        task.total = Some(total);
    });

    // Selected fields become a server-side projection: overrides any user-supplied
    // find projection, and is appended as a `$project` stage for aggregations.
    let source = match &options.fields {
        Some(fields) => match source {
            ExportSource::Find {
                filter,
                sort,
                skip,
                limit,
                ..
            } => ExportSource::Find {
                filter,
                sort,
                skip,
                limit,
                projection: Some(options::build_projection(fields)),
            },
            ExportSource::Aggregate { mut stages } => {
                stages.push(doc! { "$project": options::build_projection(fields) });
                ExportSource::Aggregate { stages }
            }
        },
        None => source,
    };

    let csv_columns: Vec<String> = if matches!(format.as_str(), "csv" | "xlsx") {
        match &options.fields {
            Some(fields) => fields.clone(),
            None => {
                update_task(&tasks, &task_id, |task| {
                    task.message = "Scanning columns".to_string();
                });
                let mut fields_set = BTreeSet::new();
                let mut scan_cursor = open_export_cursor(&coll, &source).await?;
                let mut scanned = 0u64;
                while let Some(result) = scan_cursor.next().await {
                    let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
                    for field in doc.keys().cloned() {
                        fields_set.insert(field);
                    }
                    scanned += 1;
                    if scanned == total || scanned % 250 == 0 {
                        update_task(&tasks, &task_id, |task| {
                            task.processed = scanned;
                        });
                    }
                }
                update_task(&tasks, &task_id, |task| {
                    task.processed = 0;
                });
                fields_set.into_iter().collect()
            }
        }
    } else {
        Vec::new()
    };

    let cursor = open_export_cursor(&coll, &source).await?;
    let doc_stream = cursor.map(|r| r.map_err(|e| format!("Cursor read error: {}", e)));
    write_docs(
        &tasks,
        &task_id,
        doc_stream,
        total,
        &format,
        &path,
        &options,
        csv_columns,
    )
    .await
}

/// Normalize + validate the format and path shared by both export entry points.
fn validate_format_and_path(format: &str, path: &str) -> Result<String, String> {
    let format = format.trim().to_lowercase();
    if !matches!(format.as_str(), "json" | "csv" | "bson" | "ndjson" | "xlsx") {
        return Err("Export format must be json, ndjson, bson, csv, or xlsx".to_string());
    }
    if path.trim().is_empty() {
        return Err("Export path is required".to_string());
    }
    Ok(format)
}

/// Shared background-task core. `real_source` drives a live connection; `mock_find`
/// carries the `(filter, sort, skip, limit)` for the mock path (`None` ⇒ unsupported
/// on mock, e.g. aggregation pipelines).
#[allow(clippy::too_many_arguments)]
async fn start_export_task(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    format: &str,
    path: &str,
    kind: &str,
    label: String,
    real_source: ExportSource,
    mock_find: Option<(String, String, Option<u64>, Option<i64>)>,
    options: ExportOptions,
) -> Result<TaskInfo, String> {
    let format = validate_format_and_path(format, path)?;
    options::validate_options(&format, &options)?;

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock && mock_find.is_none() {
        return Err("Aggregation pipelines are not supported on mock connections".to_string());
    }

    let client = if is_mock {
        None
    } else {
        Some({
            let connections = state.connections.lock_safe()?;
            connections
                .get(id)
                .cloned()
                .ok_or_else(|| "Connection client not found".to_string())?
        })
    };

    let task_id = Uuid::new_v4().to_string();
    let task = TaskInfo {
        id: task_id.clone(),
        kind: kind.to_string(),
        label,
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Queued".to_string(),
        path: Some(path.to_string()),
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
        sub_label: None,
        items_processed: None,
        items_total: None,
        summary: None,
    };
    state
        .tasks
        .lock()
        .unwrap()
        .insert(task_id.clone(), task.clone());

    let tasks = state.tasks.clone();
    let database = database.to_string();
    let collection = collection.to_string();
    let path = path.to_string();
    tokio::spawn(async move {
        let result = if let Some(client) = client {
            export_real_to_file(
                tasks.clone(),
                task_id.clone(),
                client,
                database,
                collection,
                format,
                path,
                real_source,
                options,
            )
            .await
        } else {
            // mock_find is guaranteed Some here (checked above before spawning).
            let (filter, sort, skip, limit) =
                mock_find.unwrap_or_else(|| ("{}".to_string(), "{}".to_string(), None, None));
            export_mock_to_file(
                tasks.clone(),
                task_id.clone(),
                database,
                collection,
                format,
                path,
                filter,
                sort,
                skip,
                limit,
                options,
            )
            .await
        };
        match result {
            Ok(processed) => finish_task(&tasks, &task_id, processed),
            Err(err) => fail_task(&tasks, &task_id, err),
        }
    });

    Ok(task)
}

pub async fn start_collection_export_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    format: &str,
    path: &str,
    options: Option<ExportOptions>,
) -> Result<TaskInfo, String> {
    let format_label = format.trim().to_uppercase();
    let label = format!("Export {}.{} as {}", database, collection, format_label);
    start_export_task(
        state,
        id,
        database,
        collection,
        format,
        path,
        "collection_export",
        label,
        ExportSource::Find {
            filter: Document::new(),
            sort: None,
            projection: None,
            skip: None,
            limit: None,
        },
        Some(("{}".to_string(), "{}".to_string(), None, None)),
        options.unwrap_or_default(),
    )
    .await
}

/// Parse a non-empty JSON object string into a BSON document, mapping errors with `what`.
fn parse_optional_object(raw: &str, what: &str) -> Result<Option<Document>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Ok(None);
    }
    let val: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("Invalid {} JSON: {}", what, e))?;
    let doc =
        mongodb::bson::to_document(&val).map_err(|e| format!("Invalid {}: {}", what, e))?;
    Ok(Some(doc))
}

/// Build an [`ExportSource`] from a find filter/sort/projection or an aggregation
/// pipeline. A non-empty, non-`"[]"` `pipeline` selects aggregate mode (`filter`/
/// `sort`/`projection` are ignored); otherwise it is a find source with no
/// skip/limit set (callers that need pagination fill it in on the returned value).
fn build_source(
    filter: &str,
    sort: &str,
    projection: &str,
    pipeline: &str,
) -> Result<ExportSource, String> {
    let pipeline_trimmed = pipeline.trim();
    let is_aggregate = !pipeline_trimmed.is_empty() && pipeline_trimmed != "[]";

    if is_aggregate {
        let pipeline_val: serde_json::Value = serde_json::from_str(pipeline_trimmed)
            .map_err(|e| format!("Invalid aggregation pipeline JSON: {}", e))?;
        let stages_val = pipeline_val
            .as_array()
            .ok_or_else(|| "Aggregation pipeline must be a JSON array of stages".to_string())?;
        let mut stages: Vec<Document> = Vec::with_capacity(stages_val.len());
        for stage in stages_val {
            let stage_doc = mongodb::bson::to_document(stage)
                .map_err(|e| format!("Invalid aggregation stage: {}", e))?;
            stages.push(stage_doc);
        }
        Ok(ExportSource::Aggregate { stages })
    } else {
        let filter_doc = parse_optional_object(filter, "MQL filter")?.unwrap_or_default();
        let sort_doc = parse_optional_object(sort, "MQL sort")?;
        let projection_doc = parse_optional_object(projection, "MQL projection")?;
        Ok(ExportSource::Find {
            filter: filter_doc,
            sort: sort_doc,
            projection: projection_doc,
            skip: None,
            limit: None,
        })
    }
}

/// Export the documents matching an active find filter (filter + sort + projection,
/// optionally skip/limit) or an aggregation pipeline. A non-empty `pipeline` selects
/// aggregate mode and `filter`/`sort`/`projection`/`skip`/`limit` are ignored;
/// otherwise it is a find export.
#[allow(clippy::too_many_arguments)]
pub async fn start_filtered_export_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    format: &str,
    path: &str,
    filter: &str,
    sort: &str,
    projection: &str,
    pipeline: &str,
    skip: Option<u64>,
    limit: Option<i64>,
    options: Option<ExportOptions>,
) -> Result<TaskInfo, String> {
    let format_label = format.trim().to_uppercase();
    let pipeline_trimmed = pipeline.trim();
    let is_aggregate = !pipeline_trimmed.is_empty() && pipeline_trimmed != "[]";

    let source = build_source(filter, sort, projection, pipeline)?;
    let (real_source, mock_find) = match source {
        ExportSource::Aggregate { stages } => (ExportSource::Aggregate { stages }, None),
        ExportSource::Find {
            filter: filter_doc,
            sort: sort_doc,
            projection: projection_doc,
            ..
        } => (
            ExportSource::Find {
                filter: filter_doc,
                sort: sort_doc,
                projection: projection_doc,
                skip,
                limit,
            },
            Some((filter.to_string(), sort.to_string(), skip, limit)),
        ),
    };

    let scope = if is_aggregate { "aggregate" } else { "filtered" };
    let label = format!(
        "Export {} {}.{} as {}",
        scope, database, collection, format_label
    );

    start_export_task(
        state,
        id,
        database,
        collection,
        format,
        path,
        "filtered_export",
        label,
        real_source,
        mock_find,
        options.unwrap_or_default(),
    )
    .await
}

/// Dot-notation field paths from the first docs of an export source, for the
/// export view's field picker. A non-empty `pipeline` selects aggregate mode.
const FIELD_SAMPLE_SIZE: usize = 100;

pub async fn sample_export_fields_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    pipeline: &str,
) -> Result<Vec<String>, String> {
    let docs = collect_source_docs(
        state,
        id,
        database,
        collection,
        filter,
        "{}",
        "{}",
        pipeline,
        FIELD_SAMPLE_SIZE as i64,
    )
    .await?;

    let report = crate::db::schema::infer_schema(&docs);
    Ok(report.fields.into_iter().map(|f| f.path).collect())
}

/// Collect up to `limit` documents from a find filter/sort/projection or an
/// aggregation pipeline, on either a mock or real connection. Shared by the
/// field-sampling and preview code paths, which differ only in `limit` and
/// whether `sort`/`projection` are honored.
#[allow(clippy::too_many_arguments)]
async fn collect_source_docs(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    sort: &str,
    projection: &str,
    pipeline: &str,
    limit: i64,
) -> Result<Vec<Document>, String> {
    use futures::stream::StreamExt;

    let docs: Vec<Document> = if crate::connection_is_mock(state, id)? {
        let pipeline_trimmed = pipeline.trim();
        if !pipeline_trimmed.is_empty() && pipeline_trimmed != "[]" {
            return Err("Aggregation pipelines are not supported on mock connections".to_string());
        }
        mock_db::execute_mock_query(database, collection, filter, sort, limit, 0)?
            .iter()
            .map(|s| crate::json_to_bson_document(s))
            .collect::<Result<_, _>>()?
    } else {
        let client = crate::require_real_client(state, id)?;
        let coll = client.database(database).collection::<Document>(collection);
        let source = build_source(filter, sort, projection, pipeline)?;
        let source = match source {
            ExportSource::Find {
                filter,
                sort,
                projection,
                ..
            } => ExportSource::Find {
                filter,
                sort,
                projection,
                skip: None,
                limit: Some(limit),
            },
            ExportSource::Aggregate { mut stages } => {
                stages.push(doc! {"$limit": limit});
                ExportSource::Aggregate { stages }
            }
        };
        let mut cursor = open_export_cursor(&coll, &source).await?;
        let mut docs = Vec::new();
        while let Some(result) = cursor.next().await {
            docs.push(result.map_err(|e| format!("Cursor read error: {}", e))?);
        }
        docs
    };

    Ok(docs)
}

/// Format docs as one text blob (preview + clipboard). Text formats only.
pub fn format_docs_to_string(
    docs: &[Document],
    format: &str,
    options: &options::ExportOptions,
) -> Result<String, String> {
    options::validate_options(format, options)?;
    match format {
        "json" => {
            let lines = docs
                .iter()
                .map(|d| json::doc_to_json_string(d, options.json_mode))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[\n{}\n]\n", lines.join(",\n")))
        }
        "ndjson" => {
            let lines = docs
                .iter()
                .map(|d| json::doc_to_json_string(d, options.json_mode))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(lines.join("\n") + "\n")
        }
        "csv" => {
            let columns: Vec<String> = match &options.fields {
                Some(f) => f.clone(),
                None => {
                    let mut set = BTreeSet::new();
                    for d in docs {
                        set.extend(d.keys().cloned());
                    }
                    set.into_iter().collect()
                }
            };
            let mut out = Vec::new();
            if options.csv.include_headers && !columns.is_empty() {
                out.extend(csv::csv_record(&columns, &options.csv)?);
            }
            for d in docs {
                let cells: Vec<String> = columns
                    .iter()
                    .map(|c| csv::csv_cell_value(d, c, &options.csv))
                    .collect();
                out.extend(csv::csv_record(&cells, &options.csv)?);
            }
            String::from_utf8(out).map_err(|e| format!("CSV encoding error: {}", e))
        }
        other => Err(format!("No text preview for binary format: {}", other)),
    }
}

const PREVIEW_DOCS: i64 = 5;

/// First `PREVIEW_DOCS` documents of a find filter/sort/projection or an
/// aggregation pipeline, formatted as text for the export preview pane.
#[allow(clippy::too_many_arguments)]
pub async fn preview_export_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    format: &str,
    filter: &str,
    sort: &str,
    projection: &str,
    pipeline: &str,
    options: Option<options::ExportOptions>,
) -> Result<String, String> {
    let docs = collect_source_docs(
        state,
        id,
        database,
        collection,
        filter,
        sort,
        projection,
        pipeline,
        PREVIEW_DOCS,
    )
    .await?;
    let options = options.unwrap_or_default();
    format_docs_to_string(&docs, &format.trim().to_lowercase(), &options)
}

/// Format already-fetched (relaxed-EJSON) documents from the results grid,
/// either as a text string (clipboard/preview, `path` is `None`) or written
/// directly to a file (any format including bson/xlsx, `path` is `Some`).
pub async fn format_current_docs_impl(
    docs: Vec<serde_json::Value>,
    format: &str,
    options: Option<options::ExportOptions>,
    path: Option<String>,
) -> Result<Option<String>, String> {
    let options = options.unwrap_or_default();
    let format = format.trim().to_lowercase();
    options::validate_options(&format, &options)?;
    // Grid docs are relaxed EJSON — Bson::try_from revives real types.
    let mut bson_docs = Vec::with_capacity(docs.len());
    for value in docs {
        let doc = match mongodb::bson::Bson::try_from(value)
            .map_err(|e| format!("Invalid document: {}", e))?
        {
            mongodb::bson::Bson::Document(d) => d,
            _ => return Err("Each document must be a JSON object".to_string()),
        };
        bson_docs.push(match &options.fields {
            Some(fields) => options::project_document(&doc, fields),
            None => doc,
        });
    }
    // Keep options.fields set: docs are already projected (project_document is
    // idempotent w.r.t. lookups), and the CSV/XLSX writers use it as the
    // ordered column list — stripping it would lose the picker's order.

    let Some(path) = path else {
        return format_docs_to_string(&bson_docs, &format, &options).map(Some);
    };
    match format.as_str() {
        "bson" => {
            let mut bytes = Vec::new();
            for d in &bson_docs {
                bytes.extend(
                    mongodb::bson::to_vec(d)
                        .map_err(|e| format!("BSON serialization error: {}", e))?,
                );
            }
            tokio::fs::write(&path, bytes)
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
        }
        "xlsx" => {
            let columns: Vec<String> = match &options.fields {
                Some(f) => f.clone(),
                None => {
                    let mut set = BTreeSet::new();
                    for d in &bson_docs {
                        set.extend(d.keys().cloned());
                    }
                    set.into_iter().collect()
                }
            };
            let mut sink = xlsx::XlsxSink::new(&path, columns, options.xlsx.clone())?;
            for d in &bson_docs {
                sink.write_row(d)?;
            }
            sink.finish()?;
        }
        _ => {
            let text = format_docs_to_string(&bson_docs, &format, &options)?;
            tokio::fs::write(&path, text)
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
        }
    }
    Ok(None)
}
