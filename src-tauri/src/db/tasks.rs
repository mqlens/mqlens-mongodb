//! Shared background-task bookkeeping for export and import jobs.

use crate::TaskInfo;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn update_task<F>(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, update: F)
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

pub fn fail_task(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, err: String) {
    update_task(tasks, task_id, |task| {
        task.status = "failed".to_string();
        task.message = "Task failed".to_string();
        task.error = Some(err);
        task.finished_at_ms = Some(now_ms());
    });
    prune_tasks(tasks);
}

pub fn finish_task(
    tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: &str,
    processed: u64,
    message: String,
) {
    update_task(tasks, task_id, |task| {
        task.status = "completed".to_string();
        task.processed = processed;
        task.message = message;
        task.finished_at_ms = Some(now_ms());
    });
    prune_tasks(tasks);
}

pub fn prune_tasks(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>) {
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
