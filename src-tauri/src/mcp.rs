//! Embedded MCP (Model Context Protocol) server lifecycle + settings (#98).
//!
//! Task 1 scope: state shape, enable/disable/regenerate-token commands, and
//! a *stub* server task that proves the lifecycle plumbing without any
//! protocol code — it binds the requested `127.0.0.1:<port>` (so
//! "enabled" really means "something is listening there") and then idles
//! until told to stop via a `tokio::sync::oneshot` channel. Task 2 replaces
//! the task body with the real `rmcp` service; `ServerHandle`'s
//! join-handle + shutdown-sender shape is deliberately protocol-agnostic so
//! that swap doesn't touch `McpControl`, the commands, or the vault hooks
//! below.
//!
//! Mutex discipline: every function here that touches `AppState.mcp` does
//! its mutation inside a small sync block and drops the guard *before* any
//! `.await` (a `std::sync::MutexGuard` is `!Send` and cannot cross an await
//! point anyway — see `workspace::apply_impl`'s doc comment for the same
//! rule applied to `AppState.workspace`).

use crate::state::{AppState, LockExt};
use base64::Engine as _;
use rand::Rng;
use serde::Serialize;
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Bound when `mcp_set_enabled` is called without an explicit `port`.
pub const DEFAULT_PORT: u16 = 8765;

/// Rolling call-log cap (spec: "last 200"); Task 4/5 push entries via
/// `log_call`, Task 1 only needs the field to exist and round-trip.
const MAX_LOG_ENTRIES: usize = 200;

/// One rolling call-log row surfaced to the Settings panel (Task 6).
/// `ts_ms` is `SystemTime`-derived (no `chrono` dependency — plan
/// constraint) millis since the Unix epoch.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpLogEntry {
    pub ts_ms: u64,
    pub tool: String,
    pub connection_id: Option<String>,
    pub summary: String,
    pub ok: bool,
}

/// Join handle + shutdown sender for the currently-running server task.
/// Dropping/aborting without sending on `shutdown` would also stop the
/// task, but `stop_if_running` always signals first so the task can (in
/// Task 2) run any graceful-shutdown logic the real `rmcp` service needs
/// instead of being cut off mid-request.
pub struct ServerHandle {
    join: tauri::async_runtime::JoinHandle<()>,
    shutdown: oneshot::Sender<()>,
}

/// Embedded MCP server state, owned by `AppState.mcp`. `server` is `Some`
/// exactly when a task is bound and listening; `enabled` mirrors that but
/// is kept as a separate bool (rather than `server.is_some()`) so
/// `McpStatusUi` — and every caller of `get_status_impl` — never needs to
/// reach into `ServerHandle` (which is intentionally not `Serialize`: a
/// join handle and a oneshot sender have no meaningful wire form).
pub struct McpControl {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub log: VecDeque<McpLogEntry>,
    pub server: Option<ServerHandle>,
}

impl McpControl {
    pub fn new() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            token: String::new(),
            log: VecDeque::new(),
            server: None,
        }
    }
}

impl Default for McpControl {
    fn default() -> Self {
        Self::new()
    }
}

/// The serializable projection of `McpControl` sent to the frontend —
/// everything in `McpControl` except `server` (not `Serialize`, and not
/// the frontend's business anyway).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatusUi {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub log: Vec<McpLogEntry>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Fresh 32-byte bearer token, base64url-encoded without padding (spec:
/// "fresh 32-byte base64url bearer token minted on every enable").
fn new_token() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn status_from(control: &McpControl) -> McpStatusUi {
    McpStatusUi {
        enabled: control.enabled,
        port: control.port,
        token: control.token.clone(),
        log: control.log.iter().cloned().collect(),
    }
}

/// Append a call-log entry, trimming the front once past `MAX_LOG_ENTRIES`
/// (oldest-first `VecDeque`, so `pop_front` drops the oldest). Unused until
/// Task 4/5 wire real tool calls through it; present now so `McpControl`'s
/// `log` field has an established, tested write path.
#[allow(dead_code)]
pub fn log_call(state: &AppState, tool: &str, connection_id: Option<String>, summary: String, ok: bool) -> Result<(), String> {
    let mut control = state.mcp.lock_safe()?;
    if control.log.len() >= MAX_LOG_ENTRIES {
        control.log.pop_front();
    }
    control.log.push_back(McpLogEntry { ts_ms: now_ms(), tool: tool.to_string(), connection_id, summary, ok });
    Ok(())
}

/// Current status — cheap, synchronous, no vault precondition (reading
/// status must work even while locked so the Settings panel can render an
/// accurate "disabled" view).
pub fn get_status_impl(state: &AppState) -> Result<McpStatusUi, String> {
    let control = state.mcp.lock_safe()?;
    Ok(status_from(&control))
}

/// Enable or disable the embedded server.
///
/// Enabling requires the vault to be unlocked (`state.require_key()` — its
/// "vault is locked" error passes straight through) and binds
/// `127.0.0.1:<port>` (default `DEFAULT_PORT`) *before* touching any
/// existing server: if the bind fails (e.g. the port is already in use),
/// this returns `Err` and leaves whatever was running (or not running)
/// completely untouched, rather than tearing down a working server to make
/// room for one that never came up.
///
/// Disabling (and successfully re-enabling on a new port) stops any
/// previously running task via `stop_if_running`, which signals and then
/// *awaits* the task — so by the time this returns, the old port is
/// guaranteed free again, not just "asked to free up".
pub async fn set_enabled_impl(state: &AppState, enabled: bool, port: Option<u16>) -> Result<McpStatusUi, String> {
    if !enabled {
        stop_if_running(state).await?;
        return get_status_impl(state);
    }

    state.require_key()?;
    let port = port.unwrap_or(DEFAULT_PORT);

    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("failed to bind MCP server to port {port}: {e}"))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tauri::async_runtime::spawn(async move {
        // Stub task (Task 1): hold the listener open — proving the port is
        // actually bound — and idle until told to stop. Task 2 replaces
        // this body with the real rmcp streamable-HTTP service, accepting
        // from `listener` instead of just parking it.
        let _listener = listener;
        let _ = shutdown_rx.await;
    });

    // Bind succeeded — now it's safe to replace any previously running
    // server (a port-change re-enable, or a stale task from a prior call).
    stop_if_running(state).await?;

    let token = new_token();
    {
        let mut control = state.mcp.lock_safe()?;
        control.enabled = true;
        control.port = port;
        control.token = token;
        control.server = Some(ServerHandle { join, shutdown: shutdown_tx });
    }

    get_status_impl(state)
}

/// Stop the running server task if there is one; a no-op otherwise. Used by
/// `set_enabled_impl`'s disable path and, per the spec's vault-unlocked
/// precondition, by `vault_lock`/`vault_reset` — a locked (or reset) vault
/// must never leave the server listening.
pub async fn stop_if_running(state: &AppState) -> Result<(), String> {
    let server = {
        let mut control = state.mcp.lock_safe()?;
        control.enabled = false;
        control.server.take()
    }; // guard dropped here, before the await below.

    if let Some(handle) = server {
        // Ignore a closed receiver — the task may already be gone.
        let _ = handle.shutdown.send(());
        // Wait for the task to actually finish so its TcpListener is
        // dropped (and the port freed) before this returns. `abort()` as a
        // backstop covers the pathological case where the task somehow
        // never observes the shutdown signal.
        handle.join.abort();
        let _ = handle.join.await;
    }
    Ok(())
}

/// Mint and store a fresh token, independent of whether the server is
/// currently enabled (works either way, per the plan's Task 1 note) — a
/// disabled server can still have a stale token sitting in state from a
/// previous session, and regenerating it before the next enable is a
/// reasonable thing for a user to want.
pub fn regenerate_token_impl(state: &AppState) -> Result<McpStatusUi, String> {
    let mut control = state.mcp.lock_safe()?;
    control.token = new_token();
    Ok(status_from(&control))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Binds an ephemeral OS-assigned port and returns it, for tests that
    /// need a real free port without risking collisions between test runs.
    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn unlock(state: &AppState) {
        *state.vault_key.lock().unwrap() = Some([7u8; 32]);
    }

    #[tokio::test]
    async fn enable_while_vault_locked_fails() {
        let state = AppState::new();
        let err = set_enabled_impl(&state, true, Some(free_port())).await.unwrap_err();
        assert!(err.contains("vault is locked"), "unexpected error: {err}");

        let status = get_status_impl(&state).unwrap();
        assert!(!status.enabled, "a failed enable must not flip the enabled flag");
    }

    #[tokio::test]
    async fn enable_binds_the_port_and_status_reflects_it() {
        let state = AppState::new();
        unlock(&state);
        let port = free_port();

        let status = set_enabled_impl(&state, true, Some(port)).await.unwrap();
        assert!(status.enabled);
        assert_eq!(status.port, port);
        assert!(!status.token.is_empty());

        // The stub task holds the listener open — a second bind on the same
        // port must fail while the server is "enabled".
        let second_bind = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(second_bind.is_err(), "port must be occupied while the MCP server is enabled");
    }

    #[tokio::test]
    async fn disable_frees_the_port_and_status_reflects_it() {
        let state = AppState::new();
        unlock(&state);
        let port = free_port();

        set_enabled_impl(&state, true, Some(port)).await.unwrap();
        let status = set_enabled_impl(&state, false, None).await.unwrap();
        assert!(!status.enabled);

        // stop_if_running awaits the task's completion, so the port must be
        // bindable again immediately — no retry/sleep needed.
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(rebound.is_ok(), "port must be free again once disabled");
    }

    #[tokio::test]
    async fn vault_lock_hook_stops_the_server() {
        let state = AppState::new();
        unlock(&state);
        let port = free_port();

        set_enabled_impl(&state, true, Some(port)).await.unwrap();

        // Mirrors the `vault_lock` command: clear the key, then stop.
        *state.vault_key.lock().unwrap() = None;
        stop_if_running(&state).await.unwrap();

        let status = get_status_impl(&state).unwrap();
        assert!(!status.enabled);
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(rebound.is_ok(), "the vault-lock hook must free the port");
    }

    #[tokio::test]
    async fn regenerate_token_changes_the_token() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(free_port())).await.unwrap();
        let original = status.token;

        let regenerated = regenerate_token_impl(&state).unwrap();
        assert_ne!(regenerated.token, original);
        assert!(regenerated.enabled, "regenerating must not touch enablement");

        // status reflects the new token too, not just the regenerate call's return value.
        assert_eq!(get_status_impl(&state).unwrap().token, regenerated.token);
    }

    #[tokio::test]
    async fn regenerate_token_works_while_disabled() {
        let state = AppState::new();
        let first = regenerate_token_impl(&state).unwrap();
        assert!(!first.token.is_empty());
        let second = regenerate_token_impl(&state).unwrap();
        assert_ne!(first.token, second.token);
        assert!(!second.enabled);
    }

    #[tokio::test]
    async fn enable_on_occupied_port_fails_and_leaves_state_disabled() {
        let state = AppState::new();
        unlock(&state);
        let port = free_port();
        // Occupy the port ourselves first so the bind inside set_enabled_impl fails.
        let _occupier = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();

        let err = set_enabled_impl(&state, true, Some(port)).await.unwrap_err();
        assert!(err.contains(&port.to_string()), "error should mention the port: {err}");

        let status = get_status_impl(&state).unwrap();
        assert!(!status.enabled);
        assert!(status.token.is_empty(), "a failed enable must not mint a token either");
    }

    #[tokio::test]
    async fn enable_on_occupied_port_leaves_a_previously_running_server_untouched() {
        let state = AppState::new();
        unlock(&state);
        let good_port = free_port();
        set_enabled_impl(&state, true, Some(good_port)).await.unwrap();

        let occupied_port = free_port();
        let _occupier = std::net::TcpListener::bind(("127.0.0.1", occupied_port)).unwrap();
        let err = set_enabled_impl(&state, true, Some(occupied_port)).await.unwrap_err();
        assert!(err.contains(&occupied_port.to_string()));

        // The original server on good_port must still be running.
        let status = get_status_impl(&state).unwrap();
        assert!(status.enabled);
        assert_eq!(status.port, good_port);
        let rebind_good = std::net::TcpListener::bind(("127.0.0.1", good_port));
        assert!(rebind_good.is_err(), "the previously-running server must still hold its port");
    }

    #[tokio::test]
    async fn disable_when_never_enabled_is_a_harmless_noop() {
        let state = AppState::new();
        let status = set_enabled_impl(&state, false, None).await.unwrap();
        assert!(!status.enabled);
    }

    #[test]
    fn log_call_caps_at_max_entries() {
        let state = AppState::new();
        for i in 0..(MAX_LOG_ENTRIES + 5) {
            log_call(&state, "ping", None, format!("call {i}"), true).unwrap();
        }
        let status = get_status_impl(&state).unwrap();
        assert_eq!(status.log.len(), MAX_LOG_ENTRIES);
        // Oldest entries were evicted; the newest survives.
        assert_eq!(status.log.last().unwrap().summary, format!("call {}", MAX_LOG_ENTRIES + 4));
    }
}
