//! Collection export jobs.

use crate::state::LockExt;
use crate::{mock_db, AppState, TaskInfo};
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
}

fn finish_task(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, processed: u64) {
    update_task(tasks, task_id, |task| {
        task.status = "completed".to_string();
        task.processed = processed;
        task.message = "Export complete".to_string();
        task.finished_at_ms = Some(now_ms());
    });
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

async fn export_mock_collection_to_file(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: String,
    database: String,
    collection: String,
    format: String,
    path: String,
) -> Result<u64, String> {
    let docs = mock_db::execute_mock_query(&database, &collection, "{}", "{}", i64::MAX, 0)?;
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

async fn export_real_collection_to_file(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: String,
    client: Client,
    database: String,
    collection: String,
    format: String,
    path: String,
) -> Result<u64, String> {
    use futures::stream::StreamExt;

    let coll = client
        .database(&database)
        .collection::<mongodb::bson::Document>(&collection);

    update_task(&tasks, &task_id, |task| {
        task.message = "Counting documents".to_string();
    });
    let total = coll
        .count_documents(mongodb::bson::Document::new())
        .await
        .map_err(|e| format!("Count failed: {}", e))?;
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
        let mut cursor = coll
            .find(mongodb::bson::Document::new())
            .await
            .map_err(|e| format!("Export query failed: {}", e))?;
        let mut processed = 0u64;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let json_val = bson_doc_to_json_value(&doc)?;
            let json = serde_json::to_string(&json_val)
                .map_err(|e| format!("JSON serialization error: {}", e))?;
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
    } else {
        update_task(&tasks, &task_id, |task| {
            task.message = "Scanning CSV fields".to_string();
        });
        let mut fields = BTreeSet::new();
        let mut scan_cursor = coll
            .find(mongodb::bson::Document::new())
            .await
            .map_err(|e| format!("CSV field scan failed: {}", e))?;
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

        let mut cursor = coll
            .find(mongodb::bson::Document::new())
            .await
            .map_err(|e| format!("Export query failed: {}", e))?;
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

pub async fn start_collection_export_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    format: &str,
    path: &str,
) -> Result<TaskInfo, String> {
    let format = format.trim().to_lowercase();
    if format != "json" && format != "csv" {
        return Err("Export format must be json or csv".to_string());
    }
    if path.trim().is_empty() {
        return Err("Export path is required".to_string());
    }

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };
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
        kind: "collection_export".to_string(),
        label: format!(
            "Export {}.{} as {}",
            database,
            collection,
            format.to_uppercase()
        ),
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Queued".to_string(),
        path: Some(path.to_string()),
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
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
            export_real_collection_to_file(
                tasks.clone(),
                task_id.clone(),
                client,
                database,
                collection,
                format,
                path,
            )
            .await
        } else {
            export_mock_collection_to_file(
                tasks.clone(),
                task_id.clone(),
                database,
                collection,
                format,
                path,
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
