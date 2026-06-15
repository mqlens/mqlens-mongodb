//! Shared application state and a poison-safe mutex helper.

use crate::{ssh_tunnel, IndexInfo, MongoshSession, TaskInfo};
use mongodb::Client;
use std::collections::HashMap;
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
    // Live SSH tunnels keyed by connection id; dropped on disconnect to tear down.
    pub ssh_tunnels: Mutex<HashMap<String, ssh_tunnel::SshTunnel>>,
    // Persisted across polls so CPU usage can be sampled as a delta.
    pub sys: Mutex<sysinfo::System>,
    /// PIDs in this app process tree — refreshed periodically, not every poll.
    pub resource_pids: Mutex<Vec<sysinfo::Pid>>,
    pub resource_tree_at: Mutex<Instant>,
    // In-memory vault key; None when locked or uninitialized.
    pub vault_key: Mutex<Option<[u8; 32]>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            mocks: Mutex::new(HashMap::new()),
            mock_indexes: Mutex::new(HashMap::new()),
            mongosh_sessions: Mutex::new(HashMap::new()),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            ssh_tunnels: Mutex::new(HashMap::new()),
            sys: Mutex::new(sysinfo::System::new()),
            resource_pids: Mutex::new(Vec::new()),
            resource_tree_at: Mutex::new(Instant::now()),
            vault_key: Mutex::new(None),
        }
    }

    /// The in-memory vault key, or an error if the vault is locked.
    pub fn require_key(&self) -> Result<[u8; 32], String> {
        self.vault_key.lock_safe()?.ok_or_else(|| "vault is locked".to_string())
    }
}
