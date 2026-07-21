//! Shared application state and a poison-safe mutex helper.

use crate::{mcp, ssh_tunnel, workspace, IndexInfo, MongoshSession, TaskInfo};
use mongodb::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Metadata kept per live connection id for the `connections-changed`
/// broadcast (Phase 3 Task 3) — enough for another window to label a
/// connection in its own UI (profile it came from, display name).
/// Deliberately excludes the connection URI: event payloads go out via
/// `app_handle.emit`, and a connection string must never ride on that.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMeta {
    pub profile_id: String,
    pub name: String,
    /// True iff this connection was opened by the embedded MCP server's
    /// `connect` tool (#98 Task 4) rather than a human via the sidebar/
    /// Connection Manager. `#[serde(default)]` keeps this readable against
    /// nothing on-disk -- `ConnectionMeta` is in-memory only (never
    /// persisted), but the default matters for any caller that constructs
    /// one from a partial literal (`..Default::default()`-style).
    #[serde(default)]
    pub via_mcp: bool,
    /// Read-only / confirm-destructive production safeguard (#188),
    /// registered at connect time from the profile's `connection_mode`. The
    /// central write guard (`write_guard::guard_writable`) reads this to
    /// decide whether a mutating command may proceed — never re-derives it
    /// from the profile, so a live connection's guard behavior can't drift
    /// out of sync with what was true when it was connected. `#[serde(default)]`
    /// for the same reason as `via_mcp`: readable against nothing on-disk,
    /// and matters for any caller that constructs one from a partial literal.
    #[serde(default)]
    pub mode: crate::connections::ConnectionMode,
}

/// One entry of the `connections-changed` payload's `connections` list —
/// `ConnectionMeta` plus the id it's keyed by in `AppState.connection_meta`
/// (the id itself isn't part of `ConnectionMeta` since it's the map key,
/// but listeners need it to tell entries apart).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEntry {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    /// Mirrors `ConnectionMeta::via_mcp` -- surfaced to the frontend so the
    /// sidebar can badge agent-initiated connections (#98 Task 4).
    pub via_mcp: bool,
    /// Mirrors `ConnectionMeta::mode` -- surfaced to the frontend for the
    /// read-only/confirm-destructive banner and sidebar badge (#188).
    pub mode: crate::connections::ConnectionMode,
}

/// The `connections-changed` broadcast payload: the full current connection
/// list (not a diff) — simplest for a listener to reconcile against, and
/// matches `workspace-changed` carrying the full `Workspace` rather than a
/// delta.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsChangedPayload {
    pub connections: Vec<ConnectionEntry>,
}

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
    /// In-memory cache of the workspace.json document. `None` until the
    /// first `workspace_get`/`workspace_apply` call populates it (see
    /// `workspace::get_impl`/`workspace::apply_impl`).
    pub workspace: Mutex<Option<workspace::Workspace>>,
    /// Monotonic generation counter for debounced workspace saves —
    /// `workspace::apply_impl` mints a new generation per real change; a
    /// spawned save only writes if its captured generation is still current,
    /// collapsing bursts of changes into a single-flight write.
    pub workspace_write_gen: Arc<AtomicU64>,
    /// Metadata for currently-live connections, keyed by connection id —
    /// broadcast to every window via `connections-changed` whenever it
    /// changes (`set_connection_meta` on connect, removed on
    /// `disconnect_db`). See `ConnectionMeta`'s doc comment for why this
    /// deliberately never holds a URI.
    pub connection_meta: Mutex<HashMap<String, ConnectionMeta>>,
    /// Embedded MCP server lifecycle + settings (#98 Task 1): enablement,
    /// bound port, bearer token, rolling call log, and the live server
    /// task's handle (`None` when disabled). See `mcp::McpControl` for the
    /// enable/disable state machine and `mcp::stop_if_running` for the
    /// `vault_lock`/`vault_reset` teardown hook that guarantees a locked
    /// vault never leaves the server listening.
    ///
    /// `Arc`-wrapped (unlike this struct's other `Mutex` fields) so the
    /// spawned server task (#98 Task 2) can hold its own clone of the exact
    /// same lock `AppState` uses — reading the live bearer token at request
    /// time straight out of the one source of truth, rather than needing a
    /// full `Arc<AppState>` or a second copy of the token that could drift
    /// out of sync with a `mcp_regenerate_token` call.
    pub mcp: Arc<Mutex<mcp::McpControl>>,
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
            workspace: Mutex::new(None),
            workspace_write_gen: Arc::new(AtomicU64::new(0)),
            connection_meta: Mutex::new(HashMap::new()),
            mcp: Arc::new(Mutex::new(mcp::McpControl::new())),
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
