//! Collection export jobs.
//!
//! Two entry points share one background-task core ([`start_export_task`]):
//! - [`start_collection_export_impl`] — the whole collection (find with an empty filter).
//! - [`start_filtered_export_impl`] — the documents matching an active find filter
//!   (filter + sort + projection) or an aggregation pipeline.

pub mod options;
pub mod json;

use crate::state::LockExt;
use options::JsonMode;
use crate::{mock_db, AppState, TaskInfo};
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

fn csv_escape(raw: &str) -> String {
    if raw.contains(',') || raw.contains('"') || raw.contains('\n') || raw.contains('\r') {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw.to_string()
    }
}

fn csv_cell(value: Option<&serde_json::Value>) -> String {
    match value {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => csv_escape(s),
        Some(serde_json::Value::Bool(v)) => csv_escape(&v.to_string()),
        Some(serde_json::Value::Number(v)) => csv_escape(&v.to_string()),
        Some(v) => csv_escape(&serde_json::to_string(v).unwrap_or_default()),
    }
}

fn top_level_fields(value: &serde_json::Value) -> Vec<String> {
    match value.as_object() {
        Some(obj) => obj.keys().cloned().collect(),
        None => Vec::new(),
    }
}

fn bson_doc_to_json_value(doc: &mongodb::bson::Document) -> Result<serde_json::Value, String> {
    serde_json::to_value(doc).map_err(|e| format!("BSON to JSON error: {}", e))
}

/// What a real-connection export reads from MongoDB. Filtered exports build a
/// [`ExportSource::Find`] (filter + optional sort/projection, no pagination) or a
/// [`ExportSource::Aggregate`] (the user's pipeline, run verbatim); a full-collection
/// export is just `Find` with an empty filter.
// One ExportSource is built per export job (not a hot path), so the size gap
// between the find and aggregate variants is irrelevant.
#[allow(clippy::large_enum_variant)]
#[derive(Clone)]
enum ExportSource {
    Find {
        filter: Document,
        sort: Option<Document>,
        projection: Option<Document>,
    },
    Aggregate {
        stages: Vec<Document>,
    },
}

/// Open a fresh cursor over the source. Called once for JSON, and twice for CSV
/// (field-scan pass + write pass) — so an aggregate CSV export runs the pipeline twice.
async fn open_export_cursor(
    coll: &mongodb::Collection<Document>,
    source: &ExportSource,
) -> Result<mongodb::Cursor<Document>, String> {
    match source {
        ExportSource::Find {
            filter,
            sort,
            projection,
        } => {
            let mut builder = coll.find(filter.clone());
            if let Some(sort) = sort {
                builder = builder.sort(sort.clone());
            }
            if let Some(projection) = projection {
                builder = builder.projection(projection.clone());
            }
            builder.await.map_err(|e| format!("Export query failed: {}", e))
        }
        ExportSource::Aggregate { stages } => coll
            .aggregate(stages.clone())
            .await
            .map_err(|e| format!("Aggregation failed: {}", e)),
    }
}

/// Best-effort total for the progress denominator. For find we count the filter; for
/// aggregate we append a `$count` stage (an extra full pipeline run).
async fn count_export_source(
    coll: &mongodb::Collection<Document>,
    source: &ExportSource,
) -> Result<u64, String> {
    use futures::stream::StreamExt;
    match source {
        ExportSource::Find { filter, .. } => coll
            .count_documents(filter.clone())
            .await
            .map_err(|e| format!("Count failed: {}", e)),
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
) -> Result<u64, String> {
    let docs = mock_db::execute_mock_query(&database, &collection, &filter, &sort, i64::MAX, 0)?;
    let total = docs.len() as u64;
    update_task(&tasks, &task_id, |task| {
        task.total = Some(total);
        task.message = format!("Writing {} document(s)", total);
    });

    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Failed to create export file: {}", e))?;

    if format == "json" {
        file.write_all(b"[\n")
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
        for (idx, doc) in docs.iter().enumerate() {
            if idx > 0 {
                file.write_all(b",\n")
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
            }
            file.write_all(doc.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            let processed = idx as u64 + 1;
            update_task(&tasks, &task_id, |task| {
                task.processed = processed;
            });
        }
        file.write_all(b"\n]\n")
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
    } else if format == "ndjson" {
        for (idx, doc) in docs.iter().enumerate() {
            file.write_all(doc.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            let processed = idx as u64 + 1;
            update_task(&tasks, &task_id, |task| {
                task.processed = processed;
            });
        }
    } else if format == "bson" {
        for (idx, doc) in docs.iter().enumerate() {
            let bytes = mongodb::bson::to_vec(&crate::json_to_bson_document(doc)?)
                .map_err(|e| format!("BSON serialization error: {}", e))?;
            file.write_all(&bytes)
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            let processed = idx as u64 + 1;
            update_task(&tasks, &task_id, |task| {
                task.processed = processed;
            });
        }
    } else {
        let values: Vec<serde_json::Value> = docs
            .iter()
            .map(|doc| {
                serde_json::from_str(doc).map_err(|e| format!("Mock export JSON error: {}", e))
            })
            .collect::<Result<_, _>>()?;
        let fields: Vec<String> = values
            .iter()
            .flat_map(top_level_fields)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if !fields.is_empty() {
            file.write_all(
                fields
                    .iter()
                    .map(|field| csv_escape(field))
                    .collect::<Vec<_>>()
                    .join(",")
                    .as_bytes(),
            )
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
        }
        for (idx, value) in values.iter().enumerate() {
            let obj = value.as_object();
            let row = fields
                .iter()
                .map(|field| csv_cell(obj.and_then(|o| o.get(field))))
                .collect::<Vec<_>>()
                .join(",");
            file.write_all(row.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            let processed = idx as u64 + 1;
            update_task(&tasks, &task_id, |task| {
                task.processed = processed;
            });
        }
    }

    Ok(total)
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
) -> Result<u64, String> {
    use futures::stream::StreamExt;

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

    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Failed to create export file: {}", e))?;

    if format == "json" {
        update_task(&tasks, &task_id, |task| {
            task.message = "Writing JSON".to_string();
        });
        file.write_all(b"[\n")
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
        let mut cursor = open_export_cursor(&coll, &source).await?;
        let mut processed = 0u64;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let json = json::doc_to_json_string(&doc, JsonMode::Relaxed)?;
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
                update_task(&tasks, &task_id, |task| {
                    task.processed = processed;
                });
            }
        }
        file.write_all(b"\n]\n")
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
        update_task(&tasks, &task_id, |task| {
            task.processed = processed;
        });
        Ok(processed)
    } else if format == "ndjson" {
        // One relaxed-EJSON document per line — the same per-doc value as the JSON
        // array path, so it round-trips identically.
        update_task(&tasks, &task_id, |task| {
            task.message = "Writing NDJSON".to_string();
        });
        let mut cursor = open_export_cursor(&coll, &source).await?;
        let mut processed = 0u64;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let json = json::doc_to_json_string(&doc, JsonMode::Relaxed)?;
            file.write_all(json.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            processed += 1;
            if processed == total || processed % 100 == 0 {
                update_task(&tasks, &task_id, |task| {
                    task.processed = processed;
                });
            }
        }
        update_task(&tasks, &task_id, |task| {
            task.processed = processed;
        });
        Ok(processed)
    } else if format == "bson" {
        // Concatenated raw BSON — mongoexport's binary format, fully type-preserving.
        update_task(&tasks, &task_id, |task| {
            task.message = "Writing BSON".to_string();
        });
        let mut cursor = open_export_cursor(&coll, &source).await?;
        let mut processed = 0u64;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let bytes = mongodb::bson::to_vec(&doc)
                .map_err(|e| format!("BSON serialization error: {}", e))?;
            file.write_all(&bytes)
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            processed += 1;
            if processed == total || processed % 100 == 0 {
                update_task(&tasks, &task_id, |task| {
                    task.processed = processed;
                });
            }
        }
        update_task(&tasks, &task_id, |task| {
            task.processed = processed;
        });
        Ok(processed)
    } else {
        update_task(&tasks, &task_id, |task| {
            task.message = "Scanning CSV fields".to_string();
        });
        let mut fields = BTreeSet::new();
        let mut scan_cursor = open_export_cursor(&coll, &source).await?;
        let mut scanned = 0u64;
        while let Some(result) = scan_cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let json_val = bson_doc_to_json_value(&doc)?;
            for field in top_level_fields(&json_val) {
                fields.insert(field);
            }
            scanned += 1;
            if scanned == total || scanned % 250 == 0 {
                update_task(&tasks, &task_id, |task| {
                    task.processed = scanned;
                });
            }
        }
        let fields: Vec<String> = fields.into_iter().collect();
        update_task(&tasks, &task_id, |task| {
            task.processed = 0;
            task.message = "Writing CSV".to_string();
        });

        if !fields.is_empty() {
            file.write_all(
                fields
                    .iter()
                    .map(|field| csv_escape(field))
                    .collect::<Vec<_>>()
                    .join(",")
                    .as_bytes(),
            )
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
        }

        let mut cursor = open_export_cursor(&coll, &source).await?;
        let mut processed = 0u64;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let json_val = bson_doc_to_json_value(&doc)?;
            let obj = json_val.as_object();
            let row = fields
                .iter()
                .map(|field| csv_cell(obj.and_then(|o| o.get(field))))
                .collect::<Vec<_>>()
                .join(",");
            file.write_all(row.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            processed += 1;
            if processed == total || processed % 100 == 0 {
                update_task(&tasks, &task_id, |task| {
                    task.processed = processed;
                });
            }
        }
        update_task(&tasks, &task_id, |task| {
            task.processed = processed;
        });
        Ok(processed)
    }
}

/// Normalize + validate the format and path shared by both export entry points.
fn validate_format_and_path(format: &str, path: &str) -> Result<String, String> {
    let format = format.trim().to_lowercase();
    if !matches!(format.as_str(), "json" | "csv" | "bson" | "ndjson") {
        return Err("Export format must be json, ndjson, bson, or csv".to_string());
    }
    if path.trim().is_empty() {
        return Err("Export path is required".to_string());
    }
    Ok(format)
}

/// Shared background-task core. `real_source` drives a live connection; `mock_find`
/// carries the `(filter, sort)` for the mock path (`None` ⇒ unsupported on mock, e.g.
/// aggregation pipelines).
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
    mock_find: Option<(String, String)>,
) -> Result<TaskInfo, String> {
    let format = validate_format_and_path(format, path)?;

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
            )
            .await
        } else {
            // mock_find is guaranteed Some here (checked above before spawning).
            let (filter, sort) = mock_find.unwrap_or_else(|| ("{}".to_string(), "{}".to_string()));
            export_mock_to_file(
                tasks.clone(),
                task_id.clone(),
                database,
                collection,
                format,
                path,
                filter,
                sort,
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
        },
        Some(("{}".to_string(), "{}".to_string())),
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

/// Export the documents matching an active find filter (filter + sort + projection,
/// no pagination) or an aggregation pipeline. A non-empty `pipeline` selects aggregate
/// mode and `filter`/`sort`/`projection` are ignored; otherwise it is a find export.
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
) -> Result<TaskInfo, String> {
    let format_label = format.trim().to_uppercase();
    let pipeline_trimmed = pipeline.trim();
    let is_aggregate = !pipeline_trimmed.is_empty() && pipeline_trimmed != "[]";

    let (real_source, mock_find) = if is_aggregate {
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
        (ExportSource::Aggregate { stages }, None)
    } else {
        let filter_doc = parse_optional_object(filter, "MQL filter")?.unwrap_or_default();
        let sort_doc = parse_optional_object(sort, "MQL sort")?;
        let projection_doc = parse_optional_object(projection, "MQL projection")?;
        (
            ExportSource::Find {
                filter: filter_doc,
                sort: sort_doc,
                projection: projection_doc,
            },
            Some((filter.to_string(), sort.to_string())),
        )
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
    )
    .await
}
