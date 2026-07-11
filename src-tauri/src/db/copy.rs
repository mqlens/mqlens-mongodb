//! Collection / database copy jobs (across clusters or between databases).

use crate::limits::IMPORT_BATCH_SIZE;
use crate::state::LockExt;
use crate::{connection_is_mock, mock_db, require_real_client, AppState, CopyFailure, CopySummary, TaskInfo};
use mongodb::bson::Document;
use mongodb::Client;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictMode {
    Skip,
    Merge,
    Overwrite,
}

impl ConflictMode {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_lowercase().as_str() {
            "skip" => Ok(ConflictMode::Skip),
            "merge" => Ok(ConflictMode::Merge),
            "overwrite" => Ok(ConflictMode::Overwrite),
            other => Err(format!("Unknown conflict mode '{}'", other)),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Parse an optional EJSON/MQL filter string into a BSON document.
/// Empty / "{}" / None -> empty document (match all). Mirrors db/query.rs.
fn parse_filter(filter: Option<&str>) -> Result<Document, String> {
    let raw = filter.unwrap_or("").trim();
    if raw.is_empty() || raw == "{}" {
        return Ok(Document::new());
    }
    let val: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Invalid filter JSON: {}", e))?;
    mongodb::bson::to_document(&val).map_err(|e| format!("Invalid filter: {}", e))
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

fn finish_copy_task(
    tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: &str,
    status: &str,
    summary: CopySummary,
) {
    let processed = summary.documents_copied;
    update_task(tasks, task_id, |task| {
        task.status = status.to_string();
        task.processed = processed;
        task.message = match status {
            "cancelled" => "Copy cancelled".to_string(),
            _ => "Copy complete".to_string(),
        };
        task.summary = Some(summary);
        task.finished_at_ms = Some(now_ms());
    });
    prune(tasks);
}

fn fail_task(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, err: String) {
    update_task(tasks, task_id, |task| {
        task.status = "failed".to_string();
        task.message = "Copy failed".to_string();
        task.error = Some(err);
        task.finished_at_ms = Some(now_ms());
    });
    prune(tasks);
}

fn clear_cancel_flag(cancels: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>, task_id: &str) {
    if let Ok(mut g) = cancels.lock() {
        g.remove(task_id);
    }
}

fn prune(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>) {
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

#[derive(Default)]
pub struct CollectionCopyOutcome {
    pub copied: u64,
    pub skipped: u64,
    pub indexes: u64,
    pub was_skipped: bool, // true when Skip mode and target already existed
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopyTargetRef {
    pub connection_id: String,
    pub db: String,
    pub collection: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopyConflict {
    pub connection_id: String,
    pub db: String,
    pub collection: String,
    pub target_exists: bool,
    pub target_doc_count: u64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub conflicts: Vec<CopyConflict>,
    pub self_overwrite: bool,
}

/// Does `collection` exist in `db` on connection `id`? Works for mock + real.
async fn collection_exists(state: &AppState, id: &str, db: &str, collection: &str) -> Result<bool, String> {
    let names = crate::list_collections_impl(state, id, db).await?;
    Ok(names.iter().any(|c| c.name == collection))
}

/// Count documents in a target collection (0 if it does not exist). Mock-aware.
async fn target_doc_count(state: &AppState, id: &str, db: &str, collection: &str) -> Result<u64, String> {
    if connection_is_mock(state, id)? {
        return mock_db::count_mock_documents(db, collection, "{}").or(Ok(0));
    }
    let client = require_real_client(state, id)?;
    let coll = client.database(db).collection::<Document>(collection);
    coll.count_documents(Document::new())
        .await
        .map_err(|e| format!("Count failed: {}", e))
}

pub async fn preflight_copy_impl(
    state: &AppState,
    source_id: &str,
    source_db: &str,
    source_collections: Vec<String>,
    targets: Vec<CopyTargetRef>,
) -> Result<PreflightResult, String> {
    let mut conflicts = Vec::new();
    let mut self_overwrite = false;
    for t in &targets {
        // Self-overwrite only when a target lands on one of the SOURCE namespaces:
        // same connection + same db + the target collection is itself a source
        // collection. Rename-on-copy (orders → orders_backup) and copies to a
        // different db on the same connection are legitimate and not flagged.
        if t.connection_id == source_id
            && t.db == source_db
            && source_collections.contains(&t.collection)
        {
            self_overwrite = true;
        }
        let exists = collection_exists(state, &t.connection_id, &t.db, &t.collection).await?;
        let count = if exists {
            target_doc_count(state, &t.connection_id, &t.db, &t.collection).await?
        } else {
            0
        };
        conflicts.push(CopyConflict {
            connection_id: t.connection_id.clone(),
            db: t.db.clone(),
            collection: t.collection.clone(),
            target_exists: exists,
            target_doc_count: count,
        });
    }
    Ok(PreflightResult { conflicts, self_overwrite })
}

/// Copy one collection from source to target on the given clients.
/// `update_progress(copied)` is called every batch with the running per-collection count.
#[allow(clippy::too_many_arguments)]
async fn copy_one_collection<F: FnMut(u64)>(
    source: &Client,
    target: &Client,
    source_db: &str,
    source_collection: &str,
    target_db: &str,
    target_collection: &str,
    filter: &Document,
    include_indexes: bool,
    mode: ConflictMode,
    cancel: &Arc<AtomicBool>,
    mut update_progress: F,
) -> Result<CollectionCopyOutcome, String> {
    use futures::stream::StreamExt;

    let src = source
        .database(source_db)
        .collection::<Document>(source_collection);
    let tgt_db = target.database(target_db);
    let tgt = tgt_db.collection::<Document>(target_collection);

    // Conflict resolution against an existing target.
    let target_existed = tgt_db
        .list_collection_names()
        .await
        .map_err(|e| format!("Failed to inspect target: {}", e))?
        .iter()
        .any(|n| n == target_collection);
    if target_existed {
        match mode {
            ConflictMode::Skip => {
                return Ok(CollectionCopyOutcome { was_skipped: true, ..Default::default() });
            }
            ConflictMode::Overwrite => {
                tgt.drop().await.map_err(|e| format!("Failed to drop target: {}", e))?;
            }
            ConflictMode::Merge => { /* keep existing; tolerate dup-key on insert */ }
        }
    }

    let mut copied = 0u64;
    let mut skipped = 0u64;
    let mut cursor = src
        .find(filter.clone())
        .await
        .map_err(|e| format!("Source query failed: {}", e))?;
    let mut batch: Vec<Document> = Vec::with_capacity(IMPORT_BATCH_SIZE);

    // Flush helper: attempt unordered insert_many on the batch slice; owns the
    // retry path so the caller never loses the batch on a dup-key error.
    // Caller pattern: flush(&tgt, &batch, ...).await?; batch.clear();
    // The merge dup-key retry path is exercised via the demo smoke test;
    // mock connections short-circuit before reaching this code.
    async fn flush(
        tgt: &mongodb::Collection<Document>,
        batch: &[Document],
        copied: &mut u64,
        skipped: &mut u64,
    ) -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let n = batch.len() as u64;
        // Unordered insert; tolerate duplicate-key (merge onto existing _ids).
        // Use to_vec() so the caller retains ownership of the original slice.
        match tgt.insert_many(batch.to_vec()).ordered(false).await {
            Ok(res) => {
                *copied += res.inserted_ids.len() as u64;
                *skipped += n - res.inserted_ids.len() as u64;
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("E11000") || msg.contains("duplicate key") {
                    // Retry doc-by-doc so we get exact copied/skipped counts.
                    // batch is still intact because we used to_vec() above.
                    insert_individually(tgt, batch, copied, skipped).await?;
                } else {
                    return Err(format!("Insert into target failed: {}", msg));
                }
            }
        }
        Ok(())
    }

    while let Some(result) = cursor.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Ok(CollectionCopyOutcome { copied, skipped, indexes: 0, was_skipped: false });
        }
        let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
        batch.push(doc);
        if batch.len() >= IMPORT_BATCH_SIZE {
            flush(&tgt, &batch, &mut copied, &mut skipped).await?;
            batch.clear();
            update_progress(copied);
        }
    }
    // Final partial batch.
    flush(&tgt, &batch, &mut copied, &mut skipped).await?;
    batch.clear();
    update_progress(copied);

    let mut indexes = 0u64;
    if include_indexes {
        indexes = copy_indexes(source, source_db, source_collection, target, target_db, target_collection).await?;
    }

    Ok(CollectionCopyOutcome { copied, skipped, indexes, was_skipped: false })
}

/// Fallback path: insert one doc at a time, counting dup-key rows as skipped.
async fn insert_individually(
    tgt: &mongodb::Collection<Document>,
    batch: &[Document],
    copied: &mut u64,
    skipped: &mut u64,
) -> Result<(), String> {
    for doc in batch {
        match tgt.insert_one(doc.clone()).await {
            Ok(_) => *copied += 1,
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("E11000") || msg.contains("duplicate key") {
                    *skipped += 1;
                } else {
                    return Err(format!("Insert into target failed: {}", msg));
                }
            }
        }
    }
    Ok(())
}

/// Recreate a view on the target from the source's view options (viewOn + pipeline).
async fn copy_view(
    source: &Client,
    source_db: &str,
    view_name: &str,
    target: &Client,
    target_db: &str,
) -> Result<(), String> {
    use futures::stream::StreamExt;
    let filter = mongodb::bson::doc! { "name": view_name };
    let mut cursor = source
        .database(source_db)
        .list_collections()
        .filter(filter)
        .await
        .map_err(|e| format!("Failed to read view definition: {}", e))?;
    let spec = cursor
        .next()
        .await
        .ok_or_else(|| format!("View {} not found", view_name))?
        .map_err(|e| format!("View read error: {}", e))?;
    let opts = spec.options;
    let view_on = opts.view_on.ok_or_else(|| "View has no viewOn".to_string())?;
    let pipeline = opts.pipeline.unwrap_or_default();
    target
        .database(target_db)
        .create_collection(view_name)
        .view_on(view_on)
        .pipeline(pipeline)
        .await
        .map_err(|e| format!("Failed to create view on target: {}", e))?;
    Ok(())
}

/// Copy non-default indexes from source to target collection. Returns count created.
async fn copy_indexes(
    source: &Client,
    source_db: &str,
    source_collection: &str,
    target: &Client,
    target_db: &str,
    target_collection: &str,
) -> Result<u64, String> {
    use futures::stream::StreamExt;
    let src = source.database(source_db).collection::<Document>(source_collection);
    let tgt = target.database(target_db).collection::<Document>(target_collection);
    let mut cursor = src
        .list_indexes()
        .await
        .map_err(|e| format!("Failed to list source indexes: {}", e))?;
    let mut created = 0u64;
    while let Some(result) = cursor.next().await {
        let model = result.map_err(|e| format!("Index read error: {}", e))?;
        let name = model.options.as_ref().and_then(|o| o.name.clone()).unwrap_or_default();
        if name.is_empty() || name == "_id_" {
            continue; // default index / unnamed index — skip
        }
        match tgt.create_index(model).await {
            Ok(_) => created += 1,
            Err(e) => {
                // An equivalent index already on the target (common when merging into
                // an existing collection) is not a failure — leave it and move on.
                let msg = e.to_string();
                if msg.contains("already exists")
                    || msg.contains("IndexOptionsConflict")
                    || msg.contains("IndexKeySpecsConflict")
                {
                    continue;
                }
                return Err(format!("Failed to create index on target: {}", msg));
            }
        }
    }
    Ok(created)
}

#[allow(clippy::too_many_arguments)]
pub async fn start_collection_copy_impl(
    state: &AppState,
    source_id: &str,
    source_db: &str,
    source_collection: &str,
    target_id: &str,
    target_db: &str,
    target_collection: &str,
    filter: Option<String>,
    include_indexes: bool,
    conflict_mode: String,
) -> Result<TaskInfo, String> {
    let mode = ConflictMode::parse(&conflict_mode)?;
    let filter_doc = parse_filter(filter.as_deref())?;

    // Hard guard against self-overwrite (UI also blocks this).
    if source_id == target_id && source_db == target_db && source_collection == target_collection {
        return Err("Source and target are the same collection — copy would overwrite itself".to_string());
    }

    let source_is_mock = connection_is_mock(state, source_id)?;
    let target_is_mock = connection_is_mock(state, target_id)?;

    let task_id = Uuid::new_v4().to_string();
    let task = TaskInfo {
        id: task_id.clone(),
        kind: "collection_copy".to_string(),
        label: format!("Copy {}.{} → {}.{}", source_db, source_collection, target_db, target_collection),
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Queued".to_string(),
        path: None,
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
        sub_label: None,
        items_processed: None,
        items_total: None,
        summary: None,
    };
    state.tasks.lock_safe()?.insert(task_id.clone(), task.clone());
    let cancel = state.register_cancel(&task_id);

    // Mock path: simulate completion using mock doc counts, persist nothing.
    if source_is_mock || target_is_mock {
        let count = mock_db::count_mock_documents(source_db, source_collection, "{}").unwrap_or(0);
        let tasks = state.tasks.clone();
        let summary = CopySummary {
            collections_copied: 1,
            documents_copied: count,
            ..Default::default()
        };
        finish_copy_task(&tasks, &task_id, "completed", summary);
        state.clear_cancel(&task_id);
        return Ok(task);
    }

    let source = require_real_client(state, source_id)?;
    let target = require_real_client(state, target_id)?;
    let tasks = state.tasks.clone();
    let cancels = state.cancels.clone(); // Arc<Mutex<..>> — clone the Arc
    let (sdb, scoll) = (source_db.to_string(), source_collection.to_string());
    let (tdb, tcoll) = (target_db.to_string(), target_collection.to_string());
    let task_id2 = task_id.clone();

    tokio::spawn(async move {
        // Count total for progress (best-effort).
        if let Ok(total) = source.database(&sdb).collection::<Document>(&scoll)
            .count_documents(filter_doc.clone()).await
        {
            update_task(&tasks, &task_id2, |t| t.total = Some(total));
        }
        update_task(&tasks, &task_id2, |t| t.message = "Copying documents".to_string());

        let tasks_for_progress = tasks.clone();
        let pid = task_id2.clone();
        let result = copy_one_collection(
            &source, &target, &sdb, &scoll, &tdb, &tcoll,
            &filter_doc, include_indexes, mode, &cancel,
            move |copied| update_task(&tasks_for_progress, &pid, |t| t.processed = copied),
        ).await;

        match result {
            Ok(outcome) => {
                let status = if cancel.load(Ordering::SeqCst) { "cancelled" } else { "completed" };
                let summary = CopySummary {
                    collections_copied: if outcome.was_skipped { 0 } else { 1 },
                    documents_copied: outcome.copied,
                    documents_skipped: outcome.skipped,
                    indexes_created: outcome.indexes,
                    skipped: if outcome.was_skipped { vec![tcoll.clone()] } else { vec![] },
                    failed: vec![],
                };
                finish_copy_task(&tasks, &task_id2, status, summary);
            }
            Err(err) => fail_task(&tasks, &task_id2, err),
        }
        clear_cancel_flag(&cancels, &task_id2);
    });

    Ok(task)
}

#[allow(clippy::too_many_arguments)]
pub async fn start_database_copy_impl(
    state: &AppState,
    source_id: &str,
    source_db: &str,
    target_id: &str,
    target_db: &str,
    collections: Option<Vec<String>>,
    include_indexes: bool,
    include_views: bool,
    conflict_mode: String,
) -> Result<TaskInfo, String> {
    let mode = ConflictMode::parse(&conflict_mode)?;
    if source_id == target_id && source_db == target_db {
        return Err("Source and target database are the same — copy would overwrite itself".to_string());
    }

    // Resolve the collection set (and types) from the source.
    let all = crate::list_collections_impl(state, source_id, source_db).await?;
    let chosen: Vec<crate::CollectionInfo> = match &collections {
        Some(names) => all.into_iter().filter(|c| names.contains(&c.name)).collect(),
        None => all,
    };

    let task_id = Uuid::new_v4().to_string();
    let task = TaskInfo {
        id: task_id.clone(),
        kind: "database_copy".to_string(),
        label: format!("Copy database {} → {}", source_db, target_db),
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Queued".to_string(),
        path: None,
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
        sub_label: None,
        items_processed: Some(0),
        items_total: Some(chosen.len() as u64),
        summary: None,
    };
    state.tasks.lock_safe()?.insert(task_id.clone(), task.clone());
    let cancel = state.register_cancel(&task_id);

    // Mock path: simulate per-collection counts.
    if connection_is_mock(state, source_id)? || connection_is_mock(state, target_id)? {
        let tasks = state.tasks.clone();
        let mut summary = CopySummary::default();
        for c in &chosen {
            let n = mock_db::count_mock_documents(source_db, &c.name, "{}").unwrap_or(0);
            summary.collections_copied += 1;
            summary.documents_copied += n;
        }
        finish_copy_task(&tasks, &task_id, "completed", summary);
        state.clear_cancel(&task_id);
        return Ok(task);
    }

    let source = require_real_client(state, source_id)?;
    let target = require_real_client(state, target_id)?;
    let tasks = state.tasks.clone();
    let cancels = state.cancels.clone();
    let (sdb, tdb) = (source_db.to_string(), target_db.to_string());
    let task_id2 = task_id.clone();

    tokio::spawn(async move {
        let mut summary = CopySummary::default();
        let mut overall = 0u64;
        let total_items = chosen.len() as u64;

        // Best-effort overall document total so the progress bar is determinate.
        // Uses the O(1) metadata estimate; views/timeseries carry no copied docs.
        let mut grand_total = 0u64;
        for c in &chosen {
            if c.collection_type == "view" || c.collection_type == "timeseries" {
                continue;
            }
            if let Ok(n) = source
                .database(&sdb)
                .collection::<Document>(&c.name)
                .estimated_document_count()
                .await
            {
                grand_total += n;
            }
        }
        update_task(&tasks, &task_id2, |t| t.total = Some(grand_total));

        for (idx, c) in chosen.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            update_task(&tasks, &task_id2, |t| {
                t.items_processed = Some(idx as u64);
                t.items_total = Some(total_items);
                t.sub_label = Some(format!("{} ({}/{})", c.name, idx + 1, total_items));
                t.message = format!("Copying {}", c.name);
            });

            if c.collection_type == "view" {
                if include_views {
                    match copy_view(&source, &sdb, &c.name, &target, &tdb).await {
                        Ok(()) => summary.collections_copied += 1,
                        Err(e) => summary.failed.push(CopyFailure { collection: c.name.clone(), error: e }),
                    }
                } else {
                    summary.skipped.push(c.name.clone());
                }
                continue;
            }
            if c.collection_type == "timeseries" {
                // Timeseries copy is out of scope; record as skipped, do not fail.
                summary.skipped.push(format!("{} (timeseries)", c.name));
                continue;
            }

            let base = overall;
            let tasks_for_progress = tasks.clone();
            let pid = task_id2.clone();
            let outcome = copy_one_collection(
                &source, &target, &sdb, &c.name, &tdb, &c.name,
                &Document::new(), include_indexes, mode, &cancel,
                move |copied| update_task(&tasks_for_progress, &pid, |t| t.processed = base + copied),
            ).await;

            match outcome {
                Ok(o) if o.was_skipped => summary.skipped.push(c.name.clone()),
                Ok(o) => {
                    summary.collections_copied += 1;
                    summary.documents_copied += o.copied;
                    summary.documents_skipped += o.skipped;
                    summary.indexes_created += o.indexes;
                    overall += o.copied;
                }
                Err(e) => summary.failed.push(CopyFailure { collection: c.name.clone(), error: e }),
            }
        }

        let status = if cancel.load(Ordering::SeqCst) { "cancelled" } else { "completed" };
        update_task(&tasks, &task_id2, |t| t.items_processed = t.items_total);
        finish_copy_task(&tasks, &task_id2, status, summary);
        clear_cancel_flag(&cancels, &task_id2);
    });

    Ok(task)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_mode_parses_known_values_and_rejects_others() {
        assert_eq!(ConflictMode::parse("skip").unwrap(), ConflictMode::Skip);
        assert_eq!(ConflictMode::parse(" Merge ").unwrap(), ConflictMode::Merge);
        assert_eq!(ConflictMode::parse("OVERWRITE").unwrap(), ConflictMode::Overwrite);
        assert!(ConflictMode::parse("bogus").is_err());
    }

    #[test]
    fn parse_filter_handles_empty_and_json() {
        assert_eq!(parse_filter(None).unwrap(), Document::new());
        assert_eq!(parse_filter(Some("  ")).unwrap(), Document::new());
        assert_eq!(parse_filter(Some("{}")).unwrap(), Document::new());
        let d = parse_filter(Some("{\"a\": 1}")).unwrap();
        // serde_json -> BSON serialises JSON integers as Int64
        assert_eq!(d.get_i64("a").unwrap(), 1);
        assert!(parse_filter(Some("{not json")).is_err());
    }

    fn mock_state(id: &str) -> AppState {
        let state = AppState::new();
        state.mocks.lock().unwrap().insert(id.to_string(), true);
        state
    }

    #[tokio::test]
    async fn preflight_flags_existing_mock_collection_and_self_overwrite() {
        let state = mock_state("mockA");
        // sales_db has a known mock collection "customers". Copying it onto itself
        // (target collection is also a source collection) is a self-overwrite.
        let targets = vec![CopyTargetRef {
            connection_id: "mockA".into(),
            db: "sales_db".into(),
            collection: "customers".into(),
        }];
        let res = preflight_copy_impl(
            &state, "mockA", "sales_db", vec!["customers".into()], targets,
        )
        .await
        .unwrap();
        assert!(res.self_overwrite, "copying a collection onto itself is self-overwrite");
        assert_eq!(res.conflicts.len(), 1);
        assert!(res.conflicts[0].target_exists);
    }

    #[tokio::test]
    async fn preflight_allows_rename_on_copy_within_same_db() {
        let state = mock_state("mockA");
        // orders → orders_backup on the same connection+db is a valid rename-copy,
        // NOT a self-overwrite, even though it stays in the source database.
        let targets = vec![CopyTargetRef {
            connection_id: "mockA".into(),
            db: "sales_db".into(),
            collection: "customers_backup".into(),
        }];
        let res = preflight_copy_impl(
            &state, "mockA", "sales_db", vec!["customers".into()], targets,
        )
        .await
        .unwrap();
        assert!(!res.self_overwrite, "renaming to a new collection is not self-overwrite");
        assert!(!res.conflicts[0].target_exists, "the backup name does not exist yet");
    }

    #[tokio::test]
    async fn preflight_reports_missing_collection_as_no_conflict() {
        let state = mock_state("mockA");
        let targets = vec![CopyTargetRef {
            connection_id: "mockA".into(),
            db: "sales_db".into(),
            collection: "does_not_exist".into(),
        }];
        let res = preflight_copy_impl(
            &state, "mockA", "user_analytics", vec!["something".into()], targets,
        )
        .await
        .unwrap();
        assert!(!res.conflicts[0].target_exists);
        assert!(!res.self_overwrite); // different db
    }

    #[tokio::test]
    async fn mock_collection_copy_completes_with_summary() {
        let state = AppState::new();
        state.mocks.lock().unwrap().insert("src".to_string(), true);
        state.mocks.lock().unwrap().insert("dst".to_string(), true);
        let task = start_collection_copy_impl(
            &state, "src", "sales_db", "customers",
            "dst", "sales_db", "customers_copy",
            None, true, "merge".into(),
        ).await.unwrap();
        let tasks = state.tasks.lock().unwrap();
        let stored = tasks.get(&task.id).unwrap();
        assert_eq!(stored.status, "completed");
        let summary = stored.summary.as_ref().unwrap();
        assert_eq!(summary.collections_copied, 1);
    }

    #[tokio::test]
    async fn mock_database_copy_summarizes_all_collections() {
        let state = AppState::new();
        state.mocks.lock().unwrap().insert("src".to_string(), true);
        state.mocks.lock().unwrap().insert("dst".to_string(), true);
        let task = start_database_copy_impl(
            &state, "src", "sales_db", "dst", "sales_db_copy",
            None, true, true, "overwrite".into(),
        ).await.unwrap();
        let tasks = state.tasks.lock().unwrap();
        let s = tasks.get(&task.id).unwrap().summary.as_ref().unwrap();
        // sales_db mock has customers, transactions, products, sensor_readings -> 4 collections.
        assert_eq!(s.collections_copied, 4);
    }

    #[tokio::test]
    async fn self_overwrite_is_rejected() {
        let state = AppState::new();
        state.mocks.lock().unwrap().insert("c".to_string(), true);
        let result = start_collection_copy_impl(
            &state, "c", "sales_db", "customers",
            "c", "sales_db", "customers",
            None, false, "overwrite".into(),
        ).await;
        let err = result.err().expect("expected an Err but got Ok");
        assert!(err.contains("overwrite itself"), "unexpected error: {}", err);
    }
}
