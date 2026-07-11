//! Shared application state and a poison-safe mutex helper.

use crate::{ssh_tunnel, IndexInfo, MongoshSession, TaskInfo};
use mongodb::Client;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Lock a std mutex, mapping a poisoned lock to an error instead of panicking.
pub trait LockExt<T> {
    fn lock_safe(&self) -> Result<std::sync::MutexGuard<'_, T>, String>;
}
impl<T> LockExt<T> for std::sync::Mutex<T> {
    fn lock_safe(&self) -> Result<std::sync::MutexGuard<'_, T>, String> {
        self.lock().map_err(|_| "internal state lock poisoned".to_string())
    }
}

pub struct AppState {
    pub connections: Mutex<HashMap<String, Client>>,
    pub mocks: Mutex<HashMap<String, bool>>,
    pub mock_indexes: Mutex<HashMap<String, Vec<IndexInfo>>>,
    pub mongosh_sessions: Mutex<HashMap<String, Arc<MongoshSession>>>,
    pub tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    /// Per-task cancel flags for cancellable copy tasks (copy-only).
    pub cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    // Live SSH tunnels keyed by connection id; dropped on disconnect to tear down.
    pub ssh_tunnels: Mutex<HashMap<String, ssh_tunnel::SshTunnel>>,
    // Persisted across polls so CPU usage can be sampled as a delta.
    pub sys: Mutex<sysinfo::System>,
    /// PIDs in this app process tree — refreshed periodically, not every poll.
    pub resource_pids: Mutex<Vec<sysinfo::Pid>>,
    pub resource_tree_at: Mutex<Instant>,
    // In-memory vault key; None when locked or uninitialized.
    pub vault_key: Mutex<Option<[u8; 32]>>,
    /// Normalized connection URI (post-SSH-tunnel rewrite) retained per real
    /// connection id, for tools that need to hand a URI to an external
    /// process (mongodump/mongorestore). Never populated for mock connections.
    pub conn_uris: Mutex<HashMap<String, String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            mocks: Mutex::new(HashMap::new()),
            mock_indexes: Mutex::new(HashMap::new()),
            mongosh_sessions: Mutex::new(HashMap::new()),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            ssh_tunnels: Mutex::new(HashMap::new()),
            sys: Mutex::new(sysinfo::System::new()),
            resource_pids: Mutex::new(Vec::new()),
            resource_tree_at: Mutex::new(Instant::now()),
            vault_key: Mutex::new(None),
            conn_uris: Mutex::new(HashMap::new()),
        }
    }

    /// The in-memory vault key, or an error if the vault is locked.
    pub fn require_key(&self) -> Result<[u8; 32], String> {
        self.vault_key.lock_safe()?.ok_or_else(|| "vault is locked".to_string())
    }

    /// Create (or reset) a cancel flag for a task and return a clone to poll.
    pub fn register_cancel(&self, task_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.cancels.lock() {
            guard.insert(task_id.to_string(), flag.clone());
        }
        flag
    }

    /// Request cancellation of a task. Returns true if the task was known.
    pub fn request_cancel(&self, task_id: &str) -> bool {
        match self.cancels.lock() {
            Ok(guard) => match guard.get(task_id) {
                Some(flag) => {
                    flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    /// Request cancellation, treating "already finished" as success: the
    /// cancel flag is removed the moment a task completes, so a Cancel click
    /// that races the task's natural end (or a double-click) must not surface
    /// an error for a task that is genuinely done. Unknown ids and running
    /// tasks that were never registered for cancellation still error.
    pub fn cancel_or_ack(&self, task_id: &str) -> Result<(), String> {
        if self.request_cancel(task_id) {
            return Ok(());
        }
        let already_finished = self
            .tasks
            .lock_safe()?
            .get(task_id)
            .map(|t| t.status != "running")
            .unwrap_or(false);
        if already_finished {
            Ok(())
        } else {
            Err("Task is not running or cannot be cancelled".to_string())
        }
    }

    /// Drop a finished task's cancel flag.
    pub fn clear_cancel(&self, task_id: &str) {
        if let Ok(mut guard) = self.cancels.lock() {
            guard.remove(task_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_request_cancel_flips_the_flag() {
        let state = AppState::new();
        let flag = state.register_cancel("task-1");
        assert!(!flag.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.request_cancel("task-1")); // known task -> true
        assert!(flag.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.request_cancel("missing")); // unknown task -> false
    }
}
