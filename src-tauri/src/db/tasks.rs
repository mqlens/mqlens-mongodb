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
    // Never evict a running task: its background job would keep updating a
    // ghost entry (update_task silently no-ops on a missing id) and the task
    // would vanish from the UI while the process keeps running. Keep all
    // running tasks plus the newest finished ones up to the cap.
    let (running, mut finished): (Vec<(String, TaskInfo)>, Vec<(String, TaskInfo)>) =
        guard.drain().partition(|(_, task)| task.status == "running");
    finished.sort_by(|a, b| b.1.created_at_ms.cmp(&a.1.created_at_ms));
    let finished_budget = MAX_TASK_HISTORY.saturating_sub(running.len());
    for (id, task) in running.into_iter().chain(finished.into_iter().take(finished_budget)) {
        guard.insert(id, task);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::MAX_TASK_HISTORY;

    fn task(id: &str, status: &str, created_at_ms: u64) -> TaskInfo {
        TaskInfo {
            id: id.to_string(),
            kind: "dump".to_string(),
            label: String::new(),
            status: status.to_string(),
            processed: 0,
            total: None,
            message: String::new(),
            path: None,
            error: None,
            created_at_ms,
            finished_at_ms: None,
            sub_label: None,
            items_processed: None,
            items_total: None,
            summary: None,
        }
    }

    /// A still-RUNNING task must never be pruned, even when it is the oldest
    /// entry: its background job keeps calling update_task (which would
    /// silently no-op) while the task vanishes from the UI with the process
    /// still alive. Finished tasks absorb the eviction instead.
    #[test]
    fn prune_never_evicts_running_tasks() {
        let tasks: Arc<Mutex<HashMap<String, TaskInfo>>> = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut guard = tasks.lock().unwrap();
            guard.insert("running-old".into(), task("running-old", "running", 0));
            for i in 0..MAX_TASK_HISTORY as u64 {
                let id = format!("done-{}", i);
                guard.insert(id.clone(), task(&id, "completed", 1 + i));
            }
        }
        prune_tasks(&tasks);
        let guard = tasks.lock().unwrap();
        assert_eq!(guard.len(), MAX_TASK_HISTORY);
        assert!(guard.contains_key("running-old"), "running task must survive pruning");
        assert!(!guard.contains_key("done-0"), "oldest finished task is evicted instead");
    }
}
