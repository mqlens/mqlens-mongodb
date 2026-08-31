//! Embedded MCP (Model Context Protocol) server lifecycle + protocol (#98).
//!
//! Task 1 built the state shape and enable/disable/regenerate-token
//! commands around a *stub* server task that only proved the lifecycle
//! plumbing (bind the port, idle until told to stop). Task 2 replaces that
//! stub with the real thing: an `rmcp` streamable-HTTP service — currently
//! exposing a single `ping` tool — served over the already-bound
//! `TcpListener` via `axum::serve`, behind a bearer-auth check on every
//! request.
//!
//! **Why axum:** `rmcp`'s streamable-HTTP server transport
//! (`StreamableHttpService`) is a bare `tower_service::Service` — it has no
//! opinion on how you accept TCP connections or run an HTTP/1.1 loop. Rather
//! than hand-roll that with raw `hyper`, we serve it via `axum::serve`
//! (`Router::nest_service("/mcp", service)`), the exact pattern `rmcp`'s own
//! test suite uses to drive this transport (see
//! `rmcp-2.2.0/tests/test_streamable_http_*.rs`, all of which spin up an
//! `axum::Router` around `StreamableHttpService`). This also gives us
//! `axum::serve(..).with_graceful_shutdown(..)` for free, which is exactly
//! the "stop accepting, let in-flight requests finish, then exit" semantics
//! Task 1's review called for — see `stop_if_running` below.
//!
//! **Auth:** a manual header check in an `axum::middleware::from_fn` layer
//! wrapping the `/mcp` route (not a `tower::Layer`, since we're already in
//! axum's world and `from_fn` is the idiomatic equivalent) — see
//! `bearer_token_matches`. It re-reads the token out of `McpControl` on
//! *every* request (never captures it at server-start time), so
//! `mcp_regenerate_token` invalidates the old token starting with the very
//! next request.
//!
//! Mutex discipline: every function here that touches `AppState.mcp` does
//! its mutation inside a small sync block and drops the guard *before* any
//! `.await` (a `std::sync::MutexGuard` is `!Send` and cannot cross an await
//! point anyway — see `workspace::apply_impl`'s doc comment for the same
//! rule applied to `AppState.workspace`). The per-request auth check follows
//! the same rule: lock, read `token`, drop, then proceed — never held across
//! the `next.run(req).await` that actually serves the request.

use crate::state::{AppState, LockExt};
use base64::Engine as _;
use rand::Rng;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Bound when `mcp_set_enabled` is called without an explicit `port`.
pub const DEFAULT_PORT: u16 = 8765;

/// HTTP path the streamable-HTTP service is nested under.
const MCP_PATH: &str = "/mcp";
/// Where MQLens's own agent connects. A separate path rather than a flag on the
/// request, because `rmcp` builds its server per session with no view of it.
const MCP_HELPER_PATH: &str = "/helper/mcp";

/// How long `stop_if_running` waits for the server task's graceful shutdown
/// (in-flight requests finishing, then `axum::serve` returning) before
/// falling back to `abort()`. 3s is generous for a loopback-only server
/// whose tools are all bounded MongoDB calls, not a real-world timeout
/// tuned against anything more scientific than "shouldn't make a user
/// toggling the setting off wait noticeably, but shouldn't cut off an
/// in-flight `find` either."
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

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
/// `stop_if_running` sends on `shutdown` first, which triggers
/// `axum::serve`'s graceful shutdown (stop accepting new connections, let
/// in-flight ones finish) — `join` is then awaited (with a timeout) so the
/// caller knows the `TcpListener` has actually been dropped and the port is
/// free again, not just "asked to free up".
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
    /// Connection ids opened by *this* MCP server session's `connect` tool
    /// (#98 Task 4) — cleared only by `disconnect` (never by disable/re-
    /// enable, since a live connection outlives a settings toggle). The
    /// `disconnect` tool only ever accepts an id in this set: an agent may
    /// disconnect what it connected, never a connection a human opened by
    /// hand, even if that connection's profile happens to be opted in.
    pub session_connections: std::collections::HashSet<String>,
    /// A second token, for MQLens's own query-generation agent.
    ///
    /// It reaches the same tools on a separate path, so the server can tell the
    /// two apart without threading per-request state through `rmcp`: an external
    /// client keeps exactly today's behaviour, while a write asked for by the
    /// helper has to be confirmed by the user in the app first. The agent is
    /// handed this one and never the token an external client uses.
    pub helper_token: String,
}

impl McpControl {
    pub fn new() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            token: String::new(),
            log: VecDeque::new(),
            server: None,
            session_connections: std::collections::HashSet::new(),
            helper_token: String::new(),
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
/// room for one that never came up. `port: Some(0)` asks the OS for any
/// free ephemeral port; the actual bound port (read back from the
/// listener) is what ends up in `McpControl::port`/the returned status,
/// not the literal `0` — real callers never pass `0`, but tests use it to
/// get a genuinely race-free port instead of probing for a "likely free"
/// one ahead of time.
///
/// Disabling (and successfully re-enabling on a new port) stops any
/// previously running task via `stop_if_running`, which signals and then
/// *awaits* the task — so by the time this returns, the old port is
/// guaranteed free again, not just "asked to free up".
///
/// `app_handle` is threaded through to the spawned server task (and from
/// there into each session's `McpServer`) even though no Task 2 tool reads
/// it yet — Task 4's agent-initiated `connect` tool needs an `AppHandle` to
/// emit `connections-changed` so every window's sidebar picks up a
/// server-initiated connection, and plumbing it in now means that task
/// doesn't have to reshape `set_enabled_impl`'s signature or the
/// service-factory closure. Real callers (the `mcp_set_enabled` command)
/// pass `Some(app_handle)`; tests pass `None`.
pub async fn set_enabled_impl(
    state: &AppState,
    enabled: bool,
    port: Option<u16>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<McpStatusUi, String> {
    if !enabled {
        stop_if_running(state).await?;
        return get_status_impl(state);
    }

    state.require_key()?;
    let port = port.unwrap_or(DEFAULT_PORT);

    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("failed to bind MCP server to port {port}: {e}"))?;
    // Read the actual bound port back from the listener rather than trusting
    // the requested `port` verbatim: identical to `port` for any real,
    // explicit port (the only thing production callers ever pass), but also
    // makes `port: Some(0)` — "let the OS assign any free ephemeral port" —
    // correctly reported instead of silently stored as `0`. Tests lean on
    // this to get a real, race-free port straight from the OS instead of
    // probing for a "likely free" one and hoping nothing else grabs it
    // before the real bind.
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(port);

    // Bind succeeded — now it's safe to replace any previously running
    // server (a port-change re-enable, or a stale task from a prior call).
    // Stopped BEFORE the new token is minted/stored and BEFORE the new
    // server task is spawned: `stop_if_running` also clears `control.token`
    // (see its doc comment), so there's no window where a request could
    // still authenticate with a token belonging to a server generation that
    // no longer exists.
    stop_if_running(state).await?;

    // Mint and store the fresh token BEFORE spawning the server task (final
    // whole-branch review fix wave) — previously this happened AFTER
    // `tauri::async_runtime::spawn`, which starts running (and can start
    // accepting/authenticating requests) as soon as the async runtime
    // schedules it, not when this function gets around to storing the
    // token. That left a real, if narrow, window where a request could
    // arrive at the newly-bound listener while `control.token` still held
    // the previous generation's (just-cleared-to-empty, or — pre this fix —
    // stale) value. Storing the token first means the very first request
    // the new task can possibly serve already sees the right one.
    let token = new_token();
    let helper_token = new_token();
    {
        let mut control = state.mcp.lock_safe()?;
        control.enabled = true;
        control.port = port;
        control.token = token;
        // Minted with it and, like it, distinct every time the server starts.
        control.helper_token = helper_token;
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let mcp_shared = Arc::clone(&state.mcp);
    let join = tauri::async_runtime::spawn(run_server(listener, mcp_shared, app_handle, shutdown_rx));

    {
        let mut control = state.mcp.lock_safe()?;
        control.server = Some(ServerHandle { join, shutdown: shutdown_tx });
    }

    get_status_impl(state)
}

/// Stop the running server task if there is one; a no-op otherwise. Used by
/// `set_enabled_impl`'s disable path and, per the spec's vault-unlocked
/// precondition, by `vault_lock`/`vault_reset` — a locked (or reset) vault
/// must never leave the server listening.
///
/// Signals `shutdown` (which drives `axum::serve`'s graceful shutdown: stop
/// accepting new connections, let in-flight requests finish, then return)
/// and awaits the task with a `GRACEFUL_SHUTDOWN_TIMEOUT` bound. `abort()`
/// is only reached if that window elapses — a backstop for a pathologically
/// stuck task, not the normal path (unlike Task 1's stub, where every stop
/// was an abort because there was no in-flight-request concept to protect).
pub async fn stop_if_running(state: &AppState) -> Result<(), String> {
    let server = {
        let mut control = state.mcp.lock_safe()?;
        control.enabled = false;
        // Clear the token whenever the server stops, not just leave it
        // sitting around (final whole-branch review fix wave) — closes the
        // stale-token re-enable window: without this, a disabled server's
        // `McpControl.token` field kept holding its last-minted value, so
        // anything that briefly observed it (or a re-enable that raced
        // `set_enabled_impl`'s own token mint) could momentarily line up
        // with a token that no longer corresponds to any running server. A
        // disabled server should never have ANY value in this field that
        // could ever successfully authenticate (`bearer_token_matches`
        // already fails closed on an empty token either way, so this is
        // defense in depth, not the only thing preventing a stale-token
        // auth bypass).
        control.token = String::new();
        // Fail-closed alongside it: a helper token surviving a disable would be a
        // way back in to a server the user has switched off.
        control.helper_token = String::new();
        control.server.take()
    }; // guard dropped here, before the await below.

    if let Some(mut handle) = server {
        // Ignore a closed receiver — the task may already be gone.
        let _ = handle.shutdown.send(());
        if tokio::time::timeout(GRACEFUL_SHUTDOWN_TIMEOUT, &mut handle.join).await.is_err() {
            handle.join.abort();
            let _ = handle.join.await;
        }
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
    // Both, or "regenerate" would leave the older of the two still working.
    control.helper_token = new_token();
    Ok(status_from(&control))
}

/// Per-session MCP protocol handler. `rmcp`'s streamable-HTTP service calls
/// `service_factory` (see `run_server`) to build one of these per client
/// session, so it's kept cheap — `ToolRouter` construction is just building
/// a static dispatch table, no I/O.
#[derive(Clone)]
struct McpServer {
    /// Read by the `#[tool_handler]`-generated `list_tools`/`call_tool`
    /// below, not by any hand-written code here — `rustc`'s dead-code
    /// analysis doesn't see through that macro expansion (the same false
    /// positive `rmcp`'s own test suite silences the same way; see
    /// `rmcp-2.2.0/tests/test_progress_subscriber.rs`).
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
    /// True for MQLens's own query-generation agent. See `MCP_HELPER_PATH`.
    helper: bool,
    /// `Some` for every server actually spawned by `set_enabled_impl` (see
    /// its doc comment); `None` only for the bare `McpServer` values the
    /// golden-snapshot test below builds to introspect `tool_router()`
    /// without a running server. Every Task 4 tool method resolves both the
    /// live `AppState` and the encrypted profiles path from this via
    /// `resolve()` — see its doc comment for the `AppHandle` -> `AppState`
    /// pattern.
    app_handle: Option<tauri::AppHandle>,
}

impl McpServer {
    fn new(app_handle: Option<tauri::AppHandle>) -> Self {
        Self { tool_router: Self::tool_router(), app_handle, helper: false }
    }

    /// A server for MQLens's own agent: same tools, but a write must be confirmed
    /// by the user in the app rather than by the agent asserting it asked.
    fn new_helper(app_handle: Option<tauri::AppHandle>) -> Self {
        Self { tool_router: Self::tool_router(), app_handle, helper: true }
    }

    /// Resolves `self.app_handle` into `(AppHandle, encrypted-profiles-path)`
    /// for the tool methods below, or a clean error when there is none (the
    /// golden-snapshot test's bare `McpServer`s only — every server actually
    /// serving requests always has `Some`, since `set_enabled_impl` always
    /// passes one through). `tauri::Manager::state` then gets the live
    /// `AppState` back out of `app_handle` without needing a
    /// `#[tauri::command]`'s `tauri::State` extractor — the same pattern
    /// `windows.rs`'s `apply_window_closed_and_broadcast` uses.
    fn resolve(&self) -> Result<(tauri::AppHandle, std::path::PathBuf), String> {
        let app_handle = self.app_handle.clone().ok_or_else(|| "MCP server misconfigured: no application handle".to_string())?;
        let path = crate::connections::get_profiles_enc_path(&app_handle);
        Ok((app_handle, path))
    }
}

/// Serialize a successful tool result to JSON text; either way, append a
/// `log_call` entry (spec: "last 200: timestamp, tool, connection, args
/// summary ≤200 chars, ok/error") — the shared tail of every read-only data
/// tool below whose underlying `mcp_tools::*_impl` returns a typed value
/// that still needs encoding to text content.
fn finish_json<T: Serialize>(state: &AppState, tool: &str, connection_id: Option<String>, summary: &str, result: Result<T, String>) -> Result<String, String> {
    let logged_summary = crate::mcp_tools::truncate_summary(summary, 200);
    match result {
        Ok(value) => {
            let json = serde_json::to_string(&value).map_err(|e| format!("serialize result: {e}"))?;
            let _ = log_call(state, tool, connection_id, logged_summary, true);
            Ok(json)
        }
        Err(e) => {
            let _ = log_call(state, tool, connection_id, logged_summary, false);
            Err(e)
        }
    }
}

/// Same as `finish_json`, for the handful of tools whose underlying
/// `mcp_tools::*_impl` already returns a JSON *string* (`explain`,
/// `schema_analysis`) — passed straight through as tool text rather than
/// re-encoded (re-serializing an already-JSON string would double-quote it).
fn finish_text(state: &AppState, tool: &str, connection_id: Option<String>, summary: &str, result: Result<String, String>) -> Result<String, String> {
    let logged_summary = crate::mcp_tools::truncate_summary(summary, 200);
    let _ = log_call(state, tool, connection_id, logged_summary, result.is_ok());
    result
}

#[tool_router]
impl McpServer {
    /// The only tool Task 2 exposes: proves the server is reachable,
    /// authenticated, and talking to the build a client expects.
    #[tool(
        description = "Health check for the MQLens MCP server. Returns \"pong <version>\" — call this first to confirm the server is reachable and the bearer token is valid."
    )]
    async fn ping(&self) -> String {
        format!("pong {}", env!("CARGO_PKG_VERSION"))
    }

    // ---- Task 4: read tools -------------------------------------------

    #[tool(
        description = "List MongoDB connection profiles opted in to MCP access (Settings → Connection Manager → \"Expose to MCP agents\"). Returns id/name/colorTag only — never a connection string. Call this before `connect`."
    )]
    async fn list_profiles(&self) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let result = crate::mcp_tools::list_profiles_impl(&state, &path);
        finish_json(&state, "list_profiles", None, "", result)
    }

    #[tool(
        description = "List currently live MongoDB connections whose profile is opted in to MCP access. Use a returned id with `find`/`aggregate`/etc, or `connect` a not-yet-connected opted-in profile first."
    )]
    async fn list_connections(&self) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let result = crate::mcp_tools::list_connections_impl(&state, &path);
        finish_json(&state, "list_connections", None, "", result)
    }

    #[tool(
        description = "Open a live connection to an MCP-opted-in profile (by id, from `list_profiles`). Returns {\"connectionId\": \"...\"} for use with every other data tool. Every window's sidebar shows this connection with a \"via MCP\" badge."
    )]
    async fn connect(&self, Parameters(args): Parameters<crate::mcp_tools::ConnectArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let summary = crate::mcp_tools::truncate_summary(&format!("profileId={}", args.profile_id), 200);
        match crate::mcp_tools::connect_impl(&state, &path, &args.profile_id).await {
            Ok(connection_id) => {
                // Broadcast the new connection to every window's sidebar —
                // same `connections-changed` payload the `disconnect_db`/
                // `set_connection_meta` command wrappers build (lib.rs).
                if let Ok(connections) = crate::connection_list_impl(&state) {
                    use tauri::Emitter;
                    let _ = app_handle.emit("connections-changed", crate::ConnectionsChangedPayload { connections });
                }
                let _ = log_call(&state, "connect", Some(connection_id.clone()), summary, true);
                serde_json::to_string(&serde_json::json!({ "connectionId": connection_id })).map_err(|e| format!("serialize result: {e}"))
            }
            Err(e) => {
                let _ = log_call(&state, "connect", None, summary, false);
                Err(e)
            }
        }
    }

    #[tool(
        description = "Close a connection previously opened by this MCP session's `connect` call. Cannot disconnect a connection a human opened via the app UI, even if its profile is opted in."
    )]
    async fn disconnect(&self, Parameters(args): Parameters<crate::mcp_tools::ConnectionIdArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let _ = &path; // disconnect needs no profile lookup; kept for a uniform `resolve()` call site.
        let state = app_handle.state::<AppState>();
        let summary = crate::mcp_tools::truncate_summary(&format!("connectionId={}", args.connection_id), 200);
        // Not for MQLens's own agent. `disconnect_impl` authorises against the
        // app-wide set of connections opened over MCP, not against this session, so
        // the agent could close one another client opened and is doing so outside
        // the write-confirmation path. It has no business managing connection
        // lifecycle either way: it is here to read a schema, not to tidy up.
        if self.helper {
            let refusal = "disconnect is not available to MQLens's query assistant. Leave \
                           connections alone; the user manages them."
                .to_string();
            return finish_json::<()>(&state, "disconnect", Some(args.connection_id), &summary, Err(refusal));
        }
        match crate::mcp_tools::disconnect_impl(&state, &args.connection_id).await {
            Ok(()) => {
                if let Ok(connections) = crate::connection_list_impl(&state) {
                    use tauri::Emitter;
                    let _ = app_handle.emit("connections-changed", crate::ConnectionsChangedPayload { connections });
                }
                let _ = log_call(&state, "disconnect", Some(args.connection_id.clone()), summary, true);
                Ok(serde_json::json!({ "disconnected": args.connection_id }).to_string())
            }
            Err(e) => {
                let _ = log_call(&state, "disconnect", Some(args.connection_id.clone()), summary, false);
                Err(e)
            }
        }
    }

    #[tool(description = "List database names visible on a connection.")]
    async fn list_databases(&self, Parameters(args): Parameters<crate::mcp_tools::ConnectionIdArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let summary = crate::mcp_tools::truncate_summary(&format!("connectionId={}", args.connection_id), 200);
        let result = crate::audit::with_source("mcp", crate::mcp_tools::list_databases_tool_impl(&state, &path, &args.connection_id)).await;
        finish_json(&state, "list_databases", Some(args.connection_id), &summary, result)
    }

    #[tool(description = "List collections (and their type: collection/view/timeseries) in a database.")]
    async fn list_collections(&self, Parameters(args): Parameters<crate::mcp_tools::DatabaseArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let summary = crate::mcp_tools::truncate_summary(&format!("connectionId={} database={}", args.connection_id, args.database), 200);
        let result = crate::audit::with_source("mcp", crate::mcp_tools::list_collections_tool_impl(&state, &path, &args.connection_id, &args.database)).await;
        finish_json(&state, "list_collections", Some(args.connection_id), &summary, result)
    }

    #[tool(
        description = "Run a MongoDB find query. Returns {\"documents\": [...relaxed EJSON...], \"count\"?, \"truncated\"?}. Results are capped (default 50 docs / 1MB; `limit` also caps at 200) — a non-null `truncated` means narrow the filter or lower `limit`."
    )]
    async fn find(&self, Parameters(args): Parameters<crate::mcp_tools::FindArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let connection_id = args.connection_id.clone();
        // `find_summary` (byte size only, no filter contents — see its doc
        // comment) rather than interpolating `args.filter` directly: the
        // call log is visible in the Settings MCP panel, and a raw filter
        // can carry the same kind of sensitive values the write tools'
        // summaries are careful never to log (final whole-branch review fix
        // wave).
        let summary = crate::mcp_tools::truncate_summary(
            &format!(
                "connectionId={connection_id} {}",
                crate::mcp_tools::find_summary(&args.database, &args.collection, args.filter.as_deref())
            ),
            200,
        );
        let result = crate::audit::with_source("mcp", crate::mcp_tools::find_impl(&state, &path, args)).await;
        finish_json(&state, "find", Some(connection_id), &summary, result)
    }

    #[tool(
        description = "Run a MongoDB aggregation pipeline. Returns {\"documents\": [...relaxed EJSON...], \"truncated\"?}. Real connections only (not the demo/mock data). Stages whose sole key is $out or $merge are rejected — MCP is read-only for aggregation."
    )]
    async fn aggregate(&self, Parameters(args): Parameters<crate::mcp_tools::AggregateArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let connection_id = args.connection_id.clone();
        let summary = crate::mcp_tools::truncate_summary(
            &format!("connectionId={connection_id} {}.{} stages={}", args.database, args.collection, args.pipeline.len()),
            200,
        );
        let result = crate::audit::with_source("mcp", crate::mcp_tools::aggregate_impl(&state, &path, args)).await;
        finish_json(&state, "aggregate", Some(connection_id), &summary, result)
    }

    #[tool(
        description = "Explain a find filter or an aggregation pipeline (executionStats verbosity). Pass `pipeline` for an aggregate-style explain (real connections only) or `find_filter` for a find-style explain."
    )]
    async fn explain(&self, Parameters(args): Parameters<crate::mcp_tools::ExplainArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let connection_id = args.connection_id.clone();
        let summary = crate::mcp_tools::truncate_summary(&format!("connectionId={connection_id} {}.{}", args.database, args.collection), 200);
        let result = crate::audit::with_source("mcp", crate::mcp_tools::explain_impl(&state, &path, args)).await;
        finish_text(&state, "explain", Some(connection_id), &summary, result)
    }

    #[tool(
        description = "Infer a collection's schema by sampling documents: per-field types, presence/coverage, and low-cardinality enum values. `sampleSize` defaults to 100, hard cap 1000."
    )]
    async fn schema_analysis(&self, Parameters(args): Parameters<crate::mcp_tools::SchemaAnalysisArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let connection_id = args.connection_id.clone();
        let summary = crate::mcp_tools::truncate_summary(&format!("connectionId={connection_id} {}.{}", args.database, args.collection), 200);
        let result = crate::audit::with_source("mcp", crate::mcp_tools::schema_analysis_impl(&state, &path, args)).await;
        finish_text(&state, "schema_analysis", Some(connection_id), &summary, result)
    }

    #[tool(
        description = "List a collection's indexes merged with usage stats (size, ops since last restart) where available. Mock/demo connections report indexes with no stats."
    )]
    async fn list_indexes(&self, Parameters(args): Parameters<crate::mcp_tools::CollectionArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let summary =
            crate::mcp_tools::truncate_summary(&format!("connectionId={} {}.{}", args.connection_id, args.database, args.collection), 200);
        let result = crate::audit::with_source("mcp", crate::mcp_tools::list_indexes_tool_impl(&state, &path, &args.connection_id, &args.database, &args.collection)).await;
        finish_json(&state, "list_indexes", Some(args.connection_id.clone()), &summary, result)
    }

    // ---- Task 5: write tools, gated on _confirm ------------------------

    #[tool(
        description = "Insert one document. DESTRUCTIVE — requires `_confirm: true`. Before calling with `_confirm: true`, restate to the user exactly what will be inserted (the namespace and a summary of the document) and get their go-ahead. Without `_confirm: true` the call is rejected with an error telling you to do that; call again with `_confirm: true` once you have."
    )]
    async fn insert_one(&self, Parameters(args): Parameters<crate::mcp_tools::InsertOneArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let connection_id = args.connection_id.clone();
        let summary =
            crate::mcp_tools::truncate_summary(&crate::mcp_tools::insert_one_summary(&args.database, &args.collection, &args.document, args._confirm), 200);
        // Every route, not only the helper's. `_confirm` is a boolean the caller
        // supplies, so it was never a gate — and a CLI that found the external
        // route through its own global config reached these tools with no prompt
        // at all, which is the hole the helper path alone could not close.
        //
        // Gated on `_confirm` only so the *documented first pass* never reaches
        // the user: `_confirm: false` is rejected by `require_confirm` in the impl
        // below without touching the collection, so prompting for it asked someone
        // to approve an operation that could not run, and the agent's retry with
        // `true` then asked them a second time. This gives up nothing — an
        // unconfirmed call never writes, and every call that does write still
        // passes through the prompt, on every route.
        if args._confirm {
            match confirm_write(&app_handle, "insert_one", serde_json::json!({
                "connectionId": args.connection_id,
                "namespace": format!("{}.{}", args.database, args.collection),
                "document": args.document,
            }), self.helper).await
            {
                // Through the finishing path, not `?`: that is the only place a
                // call is logged, so a refused delete would otherwise vanish from
                // the MCP log entirely rather than appear as a failed call.
                Err(e) => return finish_json::<()>(&state, "insert_one", Some(connection_id), &summary, Err(e)),
                Ok(()) => {}
            }
        }
        let result = crate::audit::with_source("mcp", crate::mcp_tools::insert_one_impl(&state, &path, args)).await;
        finish_json(&state, "insert_one", Some(connection_id), &summary, result)
    }

    #[tool(
        description = "Update every document matching `filter` using operators (e.g. {\"$set\": {...}}) — bare replacement documents are rejected. DESTRUCTIVE — requires `_confirm: true`. Before calling with `_confirm: true`, restate to the user exactly what will be modified (the namespace, the filter, and the update) and get their go-ahead. Without `_confirm: true` the call is rejected with an error telling you to do that; call again with `_confirm: true` once you have."
    )]
    async fn update_many(&self, Parameters(args): Parameters<crate::mcp_tools::UpdateManyArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let connection_id = args.connection_id.clone();
        let summary = crate::mcp_tools::truncate_summary(
            &crate::mcp_tools::update_many_summary(&args.database, &args.collection, &args.filter, &args.update, args._confirm),
            200,
        );
        // Every route, not only the helper's. `_confirm` is a boolean the caller
        // supplies, so it was never a gate — and a CLI that found the external
        // route through its own global config reached these tools with no prompt
        // at all, which is the hole the helper path alone could not close.
        //
        // Gated on `_confirm` only so the *documented first pass* never reaches
        // the user: `_confirm: false` is rejected by `require_confirm` in the impl
        // below without touching the collection, so prompting for it asked someone
        // to approve an operation that could not run, and the agent's retry with
        // `true` then asked them a second time. This gives up nothing — an
        // unconfirmed call never writes, and every call that does write still
        // passes through the prompt, on every route.
        if args._confirm {
            match confirm_write(&app_handle, "update_many", serde_json::json!({
                "connectionId": args.connection_id,
                "namespace": format!("{}.{}", args.database, args.collection),
                "filter": args.filter,
                "update": args.update,
            }), self.helper).await
            {
                // Through the finishing path, not `?`: that is the only place a
                // call is logged, so a refused delete would otherwise vanish from
                // the MCP log entirely rather than appear as a failed call.
                Err(e) => return finish_json::<()>(&state, "update_many", Some(connection_id), &summary, Err(e)),
                Ok(()) => {}
            }
        }
        let result = crate::audit::with_source("mcp", crate::mcp_tools::update_many_tool_impl(&state, &path, args)).await;
        finish_json(&state, "update_many", Some(connection_id), &summary, result)
    }

    #[tool(
        description = "Delete every document matching `filter`. DESTRUCTIVE — requires `_confirm: true`. Before calling with `_confirm: true`, restate to the user exactly what will be deleted (the namespace and the filter) and get their go-ahead. Without `_confirm: true` the call is rejected with an error telling you to do that; call again with `_confirm: true` once you have."
    )]
    async fn delete_many(&self, Parameters(args): Parameters<crate::mcp_tools::DeleteManyArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let connection_id = args.connection_id.clone();
        let summary = crate::mcp_tools::truncate_summary(&crate::mcp_tools::delete_many_summary(&args.database, &args.collection, &args.filter, args._confirm), 200);
        // Every route, not only the helper's. `_confirm` is a boolean the caller
        // supplies, so it was never a gate — and a CLI that found the external
        // route through its own global config reached these tools with no prompt
        // at all, which is the hole the helper path alone could not close.
        //
        // Gated on `_confirm` only so the *documented first pass* never reaches
        // the user: `_confirm: false` is rejected by `require_confirm` in the impl
        // below without touching the collection, so prompting for it asked someone
        // to approve an operation that could not run, and the agent's retry with
        // `true` then asked them a second time. This gives up nothing — an
        // unconfirmed call never writes, and every call that does write still
        // passes through the prompt, on every route.
        if args._confirm {
            match confirm_write(&app_handle, "delete_many", serde_json::json!({
                "connectionId": args.connection_id,
                "namespace": format!("{}.{}", args.database, args.collection),
                "filter": args.filter,
            }), self.helper).await
            {
                // Through the finishing path, not `?`: that is the only place a
                // call is logged, so a refused delete would otherwise vanish from
                // the MCP log entirely rather than appear as a failed call.
                Err(e) => return finish_json::<()>(&state, "delete_many", Some(connection_id), &summary, Err(e)),
                Ok(()) => {}
            }
        }
        let result = crate::audit::with_source("mcp", crate::mcp_tools::delete_many_tool_impl(&state, &path, args)).await;
        finish_json(&state, "delete_many", Some(connection_id), &summary, result)
    }

    #[tool(
        description = "Create an index. `name` defaults to MongoDB's own naming convention (each key's field_direction joined by `_`, e.g. `email_1`) when omitted. DESTRUCTIVE — requires `_confirm: true`. Before calling with `_confirm: true`, restate to the user exactly what will be created (the namespace and the key spec) and get their go-ahead. Without `_confirm: true` the call is rejected with an error telling you to do that; call again with `_confirm: true` once you have."
    )]
    async fn create_index(&self, Parameters(args): Parameters<crate::mcp_tools::CreateIndexArgs>) -> Result<String, String> {
        let (app_handle, path) = self.resolve()?;
        let state = app_handle.state::<AppState>();
        let connection_id = args.connection_id.clone();
        let summary = crate::mcp_tools::truncate_summary(
            &crate::mcp_tools::create_index_summary(
                &args.database,
                &args.collection,
                &args.keys,
                args.name.as_deref(),
                args.unique.unwrap_or(false),
                args.sparse.unwrap_or(false),
                args._confirm,
            ),
            200,
        );
        // Every route, not only the helper's. `_confirm` is a boolean the caller
        // supplies, so it was never a gate — and a CLI that found the external
        // route through its own global config reached these tools with no prompt
        // at all, which is the hole the helper path alone could not close.
        //
        // Gated on `_confirm` only so the *documented first pass* never reaches
        // the user: `_confirm: false` is rejected by `require_confirm` in the impl
        // below without touching the collection, so prompting for it asked someone
        // to approve an operation that could not run, and the agent's retry with
        // `true` then asked them a second time. This gives up nothing — an
        // unconfirmed call never writes, and every call that does write still
        // passes through the prompt, on every route.
        if args._confirm {
            match confirm_write(&app_handle, "create_index", serde_json::json!({
                "connectionId": args.connection_id,
                "namespace": format!("{}.{}", args.database, args.collection),
                "keys": args.keys,
                "name": args.name,
                "unique": args.unique,
                // Shown because it changes which documents are indexed at all, and
                // with `unique` it changes what uniqueness is enforced over.
                "sparse": args.sparse,
            }), self.helper).await
            {
                // Through the finishing path, not `?`: that is the only place a
                // call is logged, so a refused delete would otherwise vanish from
                // the MCP log entirely rather than appear as a failed call.
                Err(e) => return finish_json::<()>(&state, "create_index", Some(connection_id), &summary, Err(e)),
                Ok(()) => {}
            }
        }
        let result = crate::audit::with_source("mcp", crate::mcp_tools::create_index_tool_impl(&state, &path, args)).await;
        finish_json(&state, "create_index", Some(connection_id), &summary, result)
    }
}

/// What the server tells a client about how to work with it.
///
/// Each tool already documents itself; what a per-tool description cannot say is
/// the *order*. Agents that skip discovery invent field names, filter on paths
/// that do not exist, and get an empty result they then explain away — so this
/// spells out that the schema and the indexes are readable, and that reading them
/// first is cheaper than guessing.
///
/// Kept factual and short: it is prepended to the client's context on every
/// session, so it earns its tokens by covering the things a model gets wrong
/// unprompted — the opt-in connection model, the result caps, relaxed EJSON, and
/// the confirmation protocol on writes.
pub const AGENT_INSTRUCTIONS: &str = concat!(
    "MQLens embedded MCP server: read and query the MongoDB connections the user has explicitly ",
    "shared with agents.\n\n",

    "WORK IN THIS ORDER. Skipping to a query means guessing field names, and a filter on a field ",
    "that does not exist returns an empty result rather than an error.\n\n",

    "1. `ping` — confirms the server is reachable and your token is valid.\n",
    "2. `list_connections` for connections already live; `list_profiles` for profiles you may open. ",
    "Only profiles the user opted in (Connection Manager -> \"Expose to MCP agents\") appear, and ",
    "connection strings are never returned. If the profile you need is not listed, say so and ask ",
    "the user to opt it in — do not look for another route.\n",
    "3. `connect` with `profile_id` if it is not live yet. It returns {\"connectionId\": ...}; pass that ",
    "value as `connection_id` to every other tool. Tool arguments are snake_case; only the response ",
    "key is camelCase.\n",
    "4. `list_databases`, then `list_collections` — note the type, since a view and a timeseries ",
    "collection do not accept the same operations.\n",
    "5. `schema_analysis` before writing any filter. It samples documents and reports per-field ",
    "types, how many documents actually carry each field, and enum values for low-cardinality ",
    "fields. Use the field names and types it returns; do not assume `_id`, `createdAt` or ",
    "`userId` exist because they usually do.\n",
    "6. `list_indexes` before a query you expect to be large. It reports usage stats, so it also ",
    "tells you which indexes the workload already relies on.\n",
    "7. `find` or `aggregate` to run it.\n",
    "8. `explain` when the result is slow, large, or you are proposing a query the user will keep. ",
    "It reports executionStats: check whether an index was used rather than asserting that one was.\n\n",

    "RESULTS. Documents come back as relaxed EJSON, so an ObjectId reads as {\"$oid\": \"...\"} and ",
    "a date as {\"$date\": \"...\"}; filters you send may use the same form. `find` returns at most ",
    "50 documents or 1MB by default and `limit` itself caps at 200. A non-null `truncated` means ",
    "you are seeing part of the result: narrow the filter or aggregate server-side instead of ",
    "paging through it. Never present a truncated sample as a complete answer, and never compute ",
    "a total by counting the documents you received.\n\n",

    "WRITES. `insert_one`, `update_many`, `delete_many` and `create_index` require ",
    "`_confirm: true`, and before you send it you must tell the user the exact namespace and what ",
    "will change, then get their agreement. A connection the user marked read-only rejects writes ",
    "regardless. `aggregate` refuses $out and $merge. What reaches the user's activity ",
    "log depends on their settings: writes and shell always, reads only at the higher verbosity ",
    "levels, and nothing at all when logging is off. Do not tell the user an operation is recorded — ",
    "you cannot see their settings.\n\n",

    "WHEN SOMETHING IS MISSING. Report what you could not reach and what you would need. Do not ",
    "substitute a different collection, widen a filter to produce output, or describe a query you ",
    "did not run as though you had run it."
);

#[tool_handler]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(AGENT_INSTRUCTIONS)
    }
}

/// `true` iff `a` and `b` are equal, in time depending only on their length
/// — every byte pair is compared regardless of earlier mismatches, unlike
/// `PartialEq` on slices/`str` (which is free to — and in practice does —
/// return as soon as it finds a differing byte). Used to compare SHA-256
/// digests of the presented vs. expected bearer token so a network timing
/// side-channel can't help an attacker recover the token byte-by-byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// `true` iff `headers` carries `Authorization: Bearer <token>` matching the
/// *current* token in `control` — read fresh on every call (never captured
/// at server-start time), so a `mcp_regenerate_token` call invalidates the
/// old token starting with the very next request.
///
/// Compares SHA-256 digests of both sides via `constant_time_eq` rather than
/// the presented/expected token strings directly (final whole-branch review
/// fix wave) — a bearer token is a bare-metal capability (Global
/// Constraints: "possession IS authorization"), so a naive `==` comparison
/// leaks how many leading bytes an attacker's guess got right through
/// response-timing variance. Hashing first also means the compared buffers
/// are always the same fixed length (32 bytes), so `constant_time_eq`'s own
/// length check never itself becomes a side channel on the real token's
/// length.
/// Where MQLens's own agent should connect, when the server is running.
///
/// Deliberately not part of `McpStatusUi`: that goes to the frontend for display,
/// and the helper token has no business there. Only the backend, handing it to an
/// agent it is about to run, ever needs it.
pub fn helper_access(state: &AppState) -> Option<(u16, String)> {
    let control = state.mcp.lock().ok()?;
    if !control.enabled || control.helper_token.is_empty() {
        return None;
    }
    Some((control.port, control.helper_token.clone()))
}

/// The path MQLens's own agent connects on. See `MCP_HELPER_PATH`.
pub fn helper_path() -> &'static str {
    MCP_HELPER_PATH
}

/// The user's answer to one of those requests, from the panel.
///
/// Unknown ids are accepted quietly: the request may have already timed out, and
/// a late click is not an error worth showing anyone.
pub fn resolve_write_impl(state: &AppState, id: &str, approved: bool) -> Result<(), String> {
    let sender = state.mcp_write_confirms.lock_safe()?.remove(id);
    if let Some(sender) = sender {
        let _ = sender.send(approved);
    }
    Ok(())
}

/// Owns one pending confirmation: its entry in `mcp_write_confirms`, and the
/// `mcp-write-settled` broadcast that retires the prompt in every webview.
///
/// Both belong here for the same reason. Doing either after the `await` covers an
/// answer and a timeout but not *cancellation*: `rmcp` drops the handler future
/// when the client goes away, and `stop_if_running` aborts the server task once
/// `GRACEFUL_SHUTDOWN_TIMEOUT` is up. A dropped future never runs the line after
/// its await — which first left the sender in app-wide state for the life of the
/// process, and then, once that was fixed here, left every webview holding a
/// prompt for a request that no longer existed until its local TTL ran out. One
/// owner for both means there is no fourth outcome to forget.
struct ConfirmEntry<'a> {
    state: &'a AppState,
    /// Retires the prompt in every webview.
    ///
    /// Injected rather than reached through a stored `AppHandle` so that the
    /// cancellation path can be tested for what it actually does. Holding a handle
    /// would have made this guard unconstructible without a running app, leaving
    /// the one outcome nothing else covers pinned by a source guard alone.
    settled: Box<dyn Fn(&str) + Send + 'static>,
    /// Taken on release, so `Drop` cannot settle the same id twice.
    id: Option<String>,
}

impl<'a> ConfirmEntry<'a> {
    fn register(
        state: &'a AppState,
        id: String,
        tx: oneshot::Sender<bool>,
        settled: Box<dyn Fn(&str) + Send + 'static>,
    ) -> Result<Self, String> {
        state.mcp_write_confirms.lock_safe()?.insert(id.clone(), tx);
        Ok(Self {
            state,
            settled,
            id: Some(id),
        })
    }

    /// Retire it now, on the ordinary path, before the audit write.
    fn release(mut self) {
        self.settle();
    }

    fn settle(&mut self) {
        let Some(id) = self.id.take() else { return };
        // No `lock_safe` here: this runs from `Drop`, where there is nothing to
        // return an error to, and a poisoned lock must not panic a second time.
        if let Ok(mut live) = self.state.mcp_write_confirms.lock() {
            live.remove(&id);
        }
        (self.settled)(&id);
    }
}

impl Drop for ConfirmEntry<'_> {
    fn drop(&mut self) {
        self.settle();
    }
}

/// How long a write waits for the user before it is refused.
///
/// Generous, because the user may be reading what the agent proposes; finite and
/// fail-closed, because an unanswered prompt must not become an approval — an
/// abandoned window would otherwise hold a write open indefinitely.
const WRITE_CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Ask the user, in the app, before MQLens's own agent writes.
///
/// The write tools are gated on a `_confirm` boolean the caller supplies, which
/// for an external client is a reasonable contract — the operator chose to connect
/// it. For MQLens's own agent it is not: the agent supplies that boolean itself,
/// so "delete inactive users" typed into the chat, or a prompt injected through a
/// document the agent sampled, is one hop from a live connection. This asks the
/// person instead, and refuses on silence.
async fn confirm_write(
    app_handle: &tauri::AppHandle,
    tool: &str,
    details: serde_json::Value,
    from_helper: bool,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let state = app_handle.state::<AppState>();
    let id = new_token();
    // The operation itself, not the call-log summary. That summary reports a
    // filter as a byte count — enough for a log line, useless for a decision:
    // `{"state":"OLD"}` and `{}` are both "34 bytes", and one of them empties the
    // collection. Whoever is approving has to see what will actually run.
    let shown = serde_json::to_string_pretty(&details).unwrap_or_else(|_| details.to_string());

    // Addressed to the panel whose agent asked. The event reaches every webview —
    // that is what `emit` does — so the address is carried *in* the payload and
    // the panels filter on it, which is deterministic in a way that guessing at
    // the right `EventTarget` variant is not, and works for two panes of one
    // window where a window label cannot tell them apart.
    // Exactly one run, or nobody is asked. `rmcp` gives this handler no view of
    // the request, so with two agents running the write cannot be attributed —
    // and putting one panel's delete in front of whoever else is looking is worse
    // than making the agent ask in its reply.
    // One live run means the write belongs to it, so the prompt goes to that
    // panel. With none — an external client — or with several, which `rmcp` gives
    // no way to tell apart, it is addressed to nobody in particular and any window
    // may answer: still a person deciding, just not a known conversation.
    // The route is the only identity available: `rmcp` builds its server per
    // session and hands the tool no view of the request, so the session itself
    // cannot be carried through. What that rules out is *guessing*: a write from
    // an external client is never attributed to a conversation, however many chats
    // happen to be generating — inferring one from app-wide activity presented
    // somebody else's operation as belonging to a chat that never asked for it.
    // The *conversation*, not the run: a tab can be moved or detached to another
    // window mid-run, and a run id means nothing to the webview it moves to — the
    // destination filtered the prompt out and the source no longer mounted the
    // tab, so nobody could answer. The conversation travels with the tab.
    let requester = if from_helper {
        let live = state.mcp_helper_requesters.lock_safe()?;
        match live.as_slice() {
            [only] => Some(only.conversation.clone()),
            // Two runs, and no way to tell which asked.
            _ => None,
        }
    } else {
        None
    };
    // Registered only once there is somebody to ask and something to ask about.
    // Inserting earlier left an unreachable sender behind on every failure above,
    // and repeated attempts grew the map without bound.
    let (tx, rx) = oneshot::channel::<bool>();
    // The entry is owned by this guard from here on, so it goes whichever way the
    // handler ends. Removing it after the `await` is not enough on its own: the
    // request can be *cancelled* while the prompt is up — the client disconnects,
    // or `stop_if_running` aborts the task once `GRACEFUL_SHUTDOWN_TIMEOUT` is up
    // — and a dropped future never reaches the line after the await, so every
    // cancelled write left its sender in app-wide state for the life of the app.
    let emitter = app_handle.clone();
    let entry = ConfirmEntry::register(
        &state,
        id.clone(),
        tx,
        Box::new(move |settled| {
            let _ = emitter.emit("mcp-write-settled", serde_json::json!({ "id": settled }));
        }),
    )?;

    let emitted = app_handle.emit(
        "mcp-write-request",
        serde_json::json!({ "id": id, "tool": tool, "summary": shown, "requester": requester }),
    );
    if emitted.is_err() {
        // Nobody can be asked, so nobody has agreed. The guard takes the entry.
        return Err(format!(
            "{tool} needs the user's confirmation and MQLens could not ask for it."
        ));
    }

    let answer = tokio::time::timeout(WRITE_CONFIRM_TIMEOUT, rx).await;
    // Retired either way: a decision that arrives later has nothing to resolve,
    // and the prompt must leave every webview. Explicit rather than left to the
    // end of the function so both happen before the audit write below — but the
    // guard is what makes them unconditional, cancellation included.
    entry.release();

    let (approved, refusal) = match answer {
        Ok(Ok(true)) => (true, None),
        Ok(Ok(false)) => (
            false,
            Some(format!(
                "{tool} was refused by the user. Do not retry it; explain what you were \
                 going to change and let them decide."
            )),
        ),
        // The sender was dropped, or nobody answered in time.
        _ => (
            false,
            Some(format!(
                "{tool} was not confirmed by the user in time, so nothing was changed. \
                 Ask again in your reply rather than retrying the tool."
            )),
        ),
    };

    // Recorded whichever way it went. The write's own audit entry only exists if
    // it ran, so a refusal would otherwise leave no trace — and "the agent asked
    // to delete and was told no" is exactly what a trail is for.
    // Metadata only. `summary` is stored verbatim; only `args` passes the payload
    // gate and the redactor, so putting the document or filter here would keep and
    // export production values from a user who switched payloads off.
    let namespace = details
        .get("namespace")
        .and_then(|n| n.as_str())
        .unwrap_or("an unknown namespace");
    let asked = format!("{tool} on {namespace}");
    let payload = details.to_string();
    // Split out for the audit's own fields. For a refused or timed-out write this
    // is the *only* record — the operation never ran — so leaving the scope empty
    // meant it could not be found by filtering on the connection or namespace it
    // was aimed at, which is precisely what a refusal trail is for.
    let scope_connection = details.get("connectionId").and_then(|c| c.as_str());
    let (scope_db, scope_collection) = match namespace.split_once('.') {
        Some((db, coll)) if !db.is_empty() && !coll.is_empty() => (Some(db), Some(coll)),
        _ => (None, None),
    };
    crate::audit::maybe_record(
        &state,
        crate::audit::RecordInput {
            event_id: None,
            ts: None,
            connection_id: scope_connection,
            database: scope_db,
            collection: scope_collection,
            op: "agent_write_request",
            class: None,
            source: Some("mcp"),
            ok: approved,
            error: refusal.as_deref(),
            duration_ms: None,
            summary: &asked,
            // Through the gate, so it is kept only if the user asked for payloads.
            args: Some(&payload),
        },
    );

    match refusal {
        None => Ok(()),
        Some(reason) => Err(reason),
    }
}

fn bearer_token_matches(
    control: &StdMutex<McpControl>,
    headers: &axum::http::HeaderMap,
    helper_path: bool,
) -> bool {
    let Some(header_value) = headers.get(axum::http::header::AUTHORIZATION) else {
        return false;
    };
    let Ok(header_str) = header_value.to_str() else {
        return false;
    };
    let Some(presented) = header_str.strip_prefix("Bearer ") else {
        return false;
    };
    let Ok(guard) = control.lock() else {
        return false;
    };
    // Fail-closed: an empty stored token (server never enabled, or between
    // `stop_if_running` clearing it and a future re-enable minting a fresh
    // one) must never match anything, no matter what's presented.
    // The token for *this* path, and only this one.
    let expected = if helper_path { &guard.helper_token } else { &guard.token };
    if expected.is_empty() {
        return false;
    }

    let mut presented_hasher = Sha256::new();
    presented_hasher.update(presented.as_bytes());
    let presented_digest = presented_hasher.finalize();

    let mut expected_hasher = Sha256::new();
    expected_hasher.update(expected.as_bytes());
    let expected_digest = expected_hasher.finalize();

    constant_time_eq(&presented_digest, &expected_digest)
}

/// 401 response with a small JSON error body (spec: "401 with a JSON error
/// body otherwise").
fn unauthorized_response() -> axum::response::Response {
    let body = serde_json::json!({ "error": "missing or invalid bearer token" }).to_string();
    axum::response::Response::builder()
        .status(axum::http::StatusCode::UNAUTHORIZED)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body))
        .expect("building a static 401 response cannot fail")
}

/// Builds the `rmcp` streamable-HTTP service (currently one `ping` tool)
/// behind a bearer-auth layer and serves it on `listener` at `/mcp` until
/// `shutdown_rx` fires. `axum::serve(..).with_graceful_shutdown(..)` then
/// stops accepting new connections, lets in-flight requests finish, and
/// this function returns — see `stop_if_running` for the timeout that
/// bounds how long a caller waits for that.
async fn run_server(listener: TcpListener, mcp: Arc<StdMutex<McpControl>>, app_handle: Option<tauri::AppHandle>, shutdown_rx: oneshot::Receiver<()>) {
    let session_manager: Arc<LocalSessionManager> = Default::default();
    let helper_handle = app_handle.clone();
    let http_service: StreamableHttpService<McpServer, LocalSessionManager> =
        StreamableHttpService::new(move || Ok(McpServer::new(app_handle.clone())), session_manager, StreamableHttpServerConfig::default());
    // MQLens's own agent, on its own path with its own token and its own rules
    // for writes. Same tools; `rmcp` builds a server per session with no view of
    // the request, so the path is what tells them apart.
    let helper_service: StreamableHttpService<McpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(McpServer::new_helper(helper_handle.clone())),
            Default::default(),
            StreamableHttpServerConfig::default(),
        );

    let auth_mcp = Arc::clone(&mcp);
    let router = axum::Router::new()
        .nest_service(MCP_HELPER_PATH, helper_service)
        .nest_service(MCP_PATH, http_service)
        .layer(axum::middleware::from_fn(
            move |req: axum::extract::Request, next: axum::middleware::Next| {
                let mcp = Arc::clone(&auth_mcp);
                async move {
                    // Each token is accepted only on its own path. Accepting
                    // either on both would make the split cosmetic: an external
                    // client could take the helper's route and its write rules,
                    // or the agent could take the external one and escape them.
                    let helper_path = req.uri().path().starts_with(MCP_HELPER_PATH);
                    if bearer_token_matches(&mcp, req.headers(), helper_path) {
                        next.run(req).await
                    } else {
                        unauthorized_response()
                    }
                }
            },
        ));

    if let Err(e) = axum::serve(listener, router.into_make_service())
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await
    {
        eprintln!("mcp::run_server: axum::serve exited with an error: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn headers_with(token: &str) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        h.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        h
    }

    #[test]
    fn the_audit_summary_carries_no_write_payload() {
        // `summary` is stored verbatim; only `args` passes the payload gate and the
        // redactor. Putting the document or filter in the summary kept and exported
        // production values from a user who had switched payloads off.
        let src = include_str!("mcp.rs");
        let body = &src[..src.find("\n#[cfg(test)]").unwrap_or(src.len())];
        let confirm = body
            .split("async fn confirm_write")
            .nth(1)
            .expect("confirm_write");
        // The summary is built from the namespace, not from the details.
        assert!(
            confirm.contains(r#"format!("{tool} on {namespace}")"#),
            "the summary must be metadata only"
        );
        assert!(
            !confirm.contains(r#"format!("{tool}: {}", details)"#),
            "the details must not be interpolated into the summary"
        );
        // ...and the details go through the gated field.
        assert!(confirm.contains("args: Some(&payload)"), "details belong in args");
    }

    #[test]
    fn a_refused_write_is_still_logged_as_a_call() {
        // `finish_json` is the only path that logs, so `confirm_write(..).await?`
        // made a refused delete vanish from the MCP log rather than appear as a
        // failed call. Exercising it needs a live AppHandle, so this holds the
        // shape: no write handler may take the early return again.
        // Only the code, not this module: `include_str!` pulls in the test file
        // too, and the assertions below mention the very strings they count.
        let whole = include_str!("mcp.rs");
        let src = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let confirmations = src.matches("confirm_write(&app_handle").count();
        assert_eq!(confirmations, 4, "one per write tool");
        assert_eq!(
            src.matches("finish_json::<()>").count(),
            5,
            "four write refusals plus the helper's disconnect refusal, all logged"
        );
        // The `?` form is what dropped them.
        for line in src.lines() {
            assert!(
                !(line.contains("confirm_write(") && line.trim_end().ends_with(".await?;")),
                "a refusal must not skip the log: {line}"
            );
        }
    }

    #[test]
    fn the_documented_first_pass_is_not_put_in_front_of_the_user() {
        // `_confirm: false` is the pass the tool descriptions tell the agent to
        // make first, and `require_confirm` rejects it without touching the
        // collection. Prompting before that check asked someone to approve an
        // operation that then could not run, and the agent's retry with `true`
        // asked them again. Needs a live AppHandle to exercise, so this pins the
        // order instead.
        let whole = include_str!("mcp.rs");
        let src = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        for tool in ["insert_one", "update_many", "delete_many", "create_index"] {
            let fn_at = src
                .find(&format!("async fn {tool}(&self"))
                .unwrap_or_else(|| panic!("{tool} handler"));
            let call = src[fn_at..]
                .find(&format!("confirm_write(&app_handle, \"{tool}\""))
                .unwrap_or_else(|| panic!("{tool} must confirm"));
            let preamble = &src[fn_at..fn_at + call];
            assert!(
                preamble.contains("if args._confirm {"),
                "{tool} must not prompt for a call it is about to reject: {preamble}"
            );
        }
        // The fall-through this relies on: the impls still reject an unconfirmed
        // call, so skipping the prompt cannot become skipping the check.
        let tools = include_str!("mcp_tools.rs");
        let body = &tools[..tools.find("\n#[cfg(test)]").unwrap_or(tools.len())];
        assert_eq!(
            body.matches("require_confirm(args._confirm").count(),
            4,
            "one per write impl"
        );
    }

    /// A `ConfirmEntry` plus the ids it settled, so a test can watch both halves.
    fn recording_entry<'a>(
        state: &'a AppState,
        id: &str,
    ) -> (ConfirmEntry<'a>, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let (tx, _rx) = oneshot::channel::<bool>();
        let entry = ConfirmEntry::register(
            state,
            id.to_string(),
            tx,
            Box::new(move |settled| sink.lock().unwrap().push(settled.to_string())),
        )
        .expect("register");
        (entry, seen)
    }

    #[test]
    fn a_cancelled_confirmation_is_both_removed_and_settled() {
        // Nothing after the `await` runs if the handler future is dropped instead
        // of polled to completion — the client disconnects, or `stop_if_running`
        // aborts the task after `GRACEFUL_SHUTDOWN_TIMEOUT`. That first stranded
        // the sender in app-wide state, and then, once the map was cleaned up,
        // left every webview holding a prompt for a request that no longer existed
        // until its local TTL ran out. Both have to happen on this path.
        let state = AppState::new();
        let settled;
        {
            let (_entry, seen) = recording_entry(&state, "w1");
            settled = seen;
            assert_eq!(
                state.mcp_write_confirms.lock_safe().unwrap().len(),
                1,
                "registered while the prompt is up"
            );
            assert!(
                settled.lock().unwrap().is_empty(),
                "not settled while the user can still answer"
            );
            // Scope end stands in for the dropped future: nothing here awaits or
            // releases, exactly as a cancelled handler does not.
        }
        assert!(
            state.mcp_write_confirms.lock_safe().unwrap().is_empty(),
            "a cancelled confirmation must not leave its sender behind"
        );
        assert_eq!(
            settled.lock().unwrap().as_slice(),
            ["w1"],
            "a cancelled confirmation must retire its prompt in every webview"
        );
    }

    #[test]
    fn an_answered_confirmation_settles_once() {
        // The ordinary path retires the entry at the same point it always did, and
        // the id is taken so the guard's own `Drop` cannot settle it a second time.
        let state = AppState::new();
        let (entry, settled) = recording_entry(&state, "w2");
        entry.release();
        assert!(
            state.mcp_write_confirms.lock_safe().unwrap().is_empty(),
            "release must remove the entry"
        );
        assert_eq!(
            settled.lock().unwrap().as_slice(),
            ["w2"],
            "released, then dropped — settled exactly once"
        );
    }

    #[test]
    fn the_prompt_is_addressed_by_conversation_not_by_run() {
        // A run id is minted in one webview and means nothing in another, so a tab
        // moved to a second window took its pending write out of reach of every
        // panel. The conversation travels with the tab.
        let src = include_str!("mcp.rs");
        let body = &src[..src.find("\n#[cfg(test)]").unwrap_or(src.len())];
        let confirm = body
            .split("async fn confirm_write")
            .nth(1)
            .expect("confirm_write");
        let decision = &confirm[..confirm.find("let emitted").unwrap_or(confirm.len())];
        assert!(
            decision.contains("only.conversation.clone()"),
            "the address must be the conversation: {decision}"
        );
        assert!(
            !decision.contains("only.run"),
            "the run id is not an address any other webview can resolve"
        );
    }

    #[test]
    fn the_confirmation_is_owned_by_the_guard() {
        // The bare insert, the bare removal, and a settle emitted outside the
        // guard are each what made a cancelled write go unnoticed. None may return.
        let whole = include_str!("mcp.rs");
        let src = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let confirm = src
            .split("async fn confirm_write")
            .nth(1)
            .expect("confirm_write");
        assert!(
            confirm.contains("ConfirmEntry::register("),
            "the entry must be registered through the guard"
        );
        assert!(
            !confirm.contains("mcp_write_confirms.lock_safe()?.insert"),
            "a bare insert is not owned by anything"
        );
        assert!(
            !confirm.contains("mcp_write_confirms.lock_safe()?.remove"),
            "a bare removal is skipped when the future is dropped"
        );
        // The one emit confirm_write still makes is the request itself; settling is
        // the guard's, so it cannot be skipped by cancellation.
        assert!(
            !confirm.contains(r#"app_handle.emit("mcp-write-settled""#),
            "settling must belong to the guard, not to the happy path"
        );
        let guard = src
            .split("impl<'a> ConfirmEntry<'a>")
            .nth(1)
            .expect("ConfirmEntry impl");
        assert!(
            guard.contains("(self.settled)(&id);"),
            "settle must run wherever the entry is retired"
        );
    }

    #[test]
    fn an_external_write_is_never_attributed_to_a_conversation() {
        // The route is the only identity available — `rmcp` hands the tool no view
        // of the request — and what that rules out is guessing. Inferring the
        // requester from app-wide activity presented an external client's write as
        // belonging to whichever chat happened to be generating.
        let src = include_str!("mcp.rs");
        let body = &src[..src.find("\n#[cfg(test)]").unwrap_or(src.len())];
        let confirm = body.split("async fn confirm_write").nth(1).expect("confirm_write");
        let decision = &confirm[..confirm.find("let emitted").unwrap_or(confirm.len())];
        // The helper route may address a single live run; nothing else may.
        assert!(decision.contains("if from_helper"), "the route decides: {decision}");
        assert!(
            decision.contains("} else {\n        None\n    };"),
            "an external write is addressed to nobody"
        );
        // Every call site passes its route rather than assuming one.
        assert_eq!(body.matches("self.helper).await").count(), 4, "one per write tool");
    }

    #[test]
    fn the_approval_prompt_shows_what_would_actually_run() {
        // The call-log summary reports a filter as a byte count. `{"state":"OLD"}`
        // and `{}` are both "34 bytes", and one of them empties the collection —
        // so approving from that summary is approving blind.
        let details = serde_json::json!({
            "connectionId": "conn-1",
            "namespace": "shop.orders",
            "filter": { "state": "OLD" },
        });
        let shown = serde_json::to_string_pretty(&details).unwrap();
        assert!(shown.contains("\"state\""), "{shown}");
        assert!(shown.contains("OLD"), "{shown}");
        assert!(shown.contains("shop.orders"), "{shown}");
        // The connection is named too: two profiles can share a display name.
        assert!(shown.contains("conn-1"), "{shown}");
        // And nothing is reduced to a size.
        assert!(!shown.contains("filter_bytes"), "{shown}");
    }

    #[tokio::test]
    async fn a_users_decision_reaches_the_parked_write() {
        let state = AppState::new();
        let (tx, rx) = oneshot::channel::<bool>();
        state.mcp_write_confirms.lock().unwrap().insert("req-1".into(), tx);

        resolve_write_impl(&state, "req-1", true).unwrap();
        assert_eq!(rx.await, Ok(true), "the approval reaches the waiting tool");
        // Taken out on the way, so a second click has nothing to resolve.
        assert!(state.mcp_write_confirms.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_refusal_is_carried_as_a_refusal() {
        let state = AppState::new();
        let (tx, rx) = oneshot::channel::<bool>();
        state.mcp_write_confirms.lock().unwrap().insert("req-2".into(), tx);
        resolve_write_impl(&state, "req-2", false).unwrap();
        assert_eq!(rx.await, Ok(false));
    }

    #[test]
    fn a_late_or_unknown_decision_is_not_an_error() {
        // The request may have already timed out; a late click is not worth
        // showing anyone an error for.
        let state = AppState::new();
        resolve_write_impl(&state, "never-existed", true).unwrap();
    }

    #[tokio::test]
    async fn a_dropped_request_reads_as_refusal_not_approval() {
        // Fail-closed: whatever goes wrong — a closed window, a cleared map — the
        // waiting write must not take silence for a yes.
        let state = AppState::new();
        let (tx, rx) = oneshot::channel::<bool>();
        state.mcp_write_confirms.lock().unwrap().insert("req-3".into(), tx);
        state.mcp_write_confirms.lock().unwrap().clear(); // sender dropped
        assert!(rx.await.is_err(), "a dropped sender must not resolve to true");
    }

    #[test]
    fn the_agent_is_never_handed_the_external_token() {
        // The whole point: MQLens's own agent gets credentials that route through
        // the confirmation, and never the ones an external client uses — which
        // would take it straight back to the `_confirm` honour system.
        let state = AppState::new();
        {
            let mut control = state.mcp.lock().unwrap();
            control.enabled = true;
            control.port = 8765;
            control.token = "external".into();
            control.helper_token = "helper".into();
        }
        let (port, token) = helper_access(&state).expect("running server");
        assert_eq!(port, 8765);
        assert_eq!(token, "helper");
        assert_ne!(token, "external");
        assert_eq!(helper_path(), "/helper/mcp");
    }

    #[test]
    fn a_disabled_server_offers_the_agent_nothing() {
        // No credentials at all rather than stale ones: `generate_local` then
        // refuses a command asking for {mcp_config} instead of quietly running
        // without the tools.
        let state = AppState::new();
        assert!(helper_access(&state).is_none(), "disabled");

        let mut control = state.mcp.lock().unwrap();
        control.enabled = true;
        control.helper_token = String::new();
        drop(control);
        assert!(helper_access(&state).is_none(), "enabled but no token minted yet");
    }

    #[test]
    fn each_token_works_only_on_its_own_path() {
        // The split is the whole basis of the helper's stricter write rules. If
        // either token were accepted on both paths it would be cosmetic: an
        // external client could take the helper's route, or the agent could take
        // the external one and escape the confirmation.
        let control = StdMutex::new(McpControl {
            token: "outside".into(),
            helper_token: "inside".into(),
            ..McpControl::new()
        });

        assert!(bearer_token_matches(&control, &headers_with("outside"), false));
        assert!(!bearer_token_matches(&control, &headers_with("outside"), true));
        assert!(bearer_token_matches(&control, &headers_with("inside"), true));
        assert!(!bearer_token_matches(&control, &headers_with("inside"), false));
        assert!(!bearer_token_matches(&control, &headers_with("neither"), true));
    }

    #[test]
    fn a_stopped_server_accepts_neither_token() {
        // Fail-closed on both, or a stale helper token would be a way back in to
        // a server the user has switched off.
        let control = StdMutex::new(McpControl::new());
        assert!(!bearer_token_matches(&control, &headers_with(""), false));
        assert!(!bearer_token_matches(&control, &headers_with(""), true));
        assert!(!bearer_token_matches(&control, &headers_with("anything"), true));
    }

    /// Binds a *real, currently-occupied* ephemeral port and returns both
    /// the listener (keep it alive — dropping it frees the port) and its
    /// number, for tests that need an "already occupied" fixture to hand to
    /// `set_enabled_impl` and observe the bind failure.
    ///
    /// Deliberately never does a probe-then-release-then-reuse dance (bind
    /// port 0, read the number, drop the listener, bind that number again
    /// later): that pattern has a TOCTOU gap between the drop and the
    /// second bind that a concurrently-running test can slip into and grab
    /// the same number first. Returning the still-held listener instead
    /// closes the gap entirely — the port is never observably free between
    /// "we asked the OS for one" and "we're holding it". Tests that don't
    /// need to pre-occupy a specific number should ask `set_enabled_impl`
    /// for `Some(0)` directly instead (see the `unlock` call sites above)
    /// and read the real port back from the returned status, for the same
    /// reason. An earlier version of this helper *did* do the
    /// probe/release/reuse dance for every test's port, including ones
    /// that then `.await`ed other work before the real bind — under
    /// default-parallel `cargo test`, with many `mcp` tests binding
    /// servers concurrently, that gap was routinely wide enough for two
    /// tests to be handed the same "free" port and collide, flaking
    /// whichever one bound second.
    fn occupy_a_free_port() -> (std::net::TcpListener, u16) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    /// Asserts `port` becomes bindable again, retrying briefly instead of
    /// checking once. `stop_if_running`/graceful-shutdown already awaits
    /// the server task to completion before returning, so the port is
    /// genuinely free at the OS level immediately after — the retry isn't
    /// covering for our own server lingering. It's covering for the same
    /// structural gap as above, just unavoidable this time: the *check*
    /// itself is a fresh bind on a specific, already-known number, and
    /// nothing stops some unrelated concurrently-running test's own
    /// `Some(0)`/`occupy_a_free_port` bind from being handed that exact
    /// number an instant earlier. That's a real, if rare, race — confirmed
    /// by reproducing it under heavy parallel load — but it's about
    /// unrelated system-wide port traffic, not about whether *this* test's
    /// graceful-drain freed its own port, so a few short retries resolve
    /// it without masking an actual regression: a real drain bug leaves
    /// the port held for the full `GRACEFUL_SHUTDOWN_TIMEOUT`, far longer
    /// than this retries for.
    fn assert_port_becomes_free(port: u16, context: &str) {
        for attempt in 0..10 {
            if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return;
            }
            if attempt < 9 {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        panic!("{context}: port {port} did not become free after retrying");
    }

    fn unlock(state: &AppState) {
        *state.vault_key.lock().unwrap() = Some([7u8; 32]);
    }

    /// Extracts the JSON-RPC payload from a streamable-HTTP POST response
    /// body. In stateful mode (the default, and what production uses to
    /// interoperate with real MCP clients like Claude Code/Cursor) `rmcp`
    /// always answers POSTs with an SSE-framed stream — even for a single
    /// request/response pair — so a raw-reqwest test client has to unwrap
    /// that framing itself: find the `data: ` line and parse it as JSON.
    fn parse_sse_json(body: &str) -> Value {
        // Stateful-mode responses are SSE-framed even for a single
        // request/response pair; when `sse_retry` is configured (the
        // default) the stream is prefixed with an empty "priming" event
        // (`data: \nid: 0\nretry: 3000`) purely to establish the SSE
        // connection for reconnect purposes — skip empty `data:` lines and
        // take the first real payload.
        for line in body.lines() {
            if let Some(data) = line.strip_prefix("data: ") {
                if data.is_empty() {
                    continue;
                }
                return serde_json::from_str(data).unwrap_or_else(|e| panic!("bad SSE JSON payload {data:?}: {e}"));
            }
        }
        panic!("no non-empty `data: ` line in SSE body: {body:?}");
    }

    /// Minimal streamable-HTTP client over `reqwest` (already a project
    /// dependency) — this is the same "raw JSON-RPC POST calls" approach
    /// `rmcp`'s own test suite uses to drive `StreamableHttpService`, and it
    /// avoids pulling in `rmcp`'s client-transport features as a
    /// dev-dependency just to exercise our own server in tests.
    struct TestClient {
        client: reqwest::Client,
        url: String,
        token: String,
        session_id: Option<String>,
    }

    impl TestClient {
        fn new(port: u16, token: &str) -> Self {
            Self { client: reqwest::Client::new(), url: format!("http://127.0.0.1:{port}{MCP_PATH}"), token: token.to_string(), session_id: None }
        }

        /// POST a JSON-RPC request/notification body; returns the raw
        /// `reqwest::Response` so callers can assert on status codes (401
        /// tests) before trying to parse a body.
        async fn post_raw(&self, body: Value) -> reqwest::Response {
            let mut req = self
                .client
                .post(&self.url)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .header("Authorization", format!("Bearer {}", self.token))
                .json(&body);
            if let Some(session_id) = &self.session_id {
                req = req.header("Mcp-Session-Id", session_id.clone());
            }
            req.send().await.expect("request should reach the server")
        }

        /// `initialize` handshake; captures the `Mcp-Session-Id` response
        /// header for subsequent calls. Panics (via `expect`/`unwrap`) on
        /// anything unexpected — test-only convenience, not production code.
        async fn initialize(&mut self) -> Value {
            let response = self
                .post_raw(json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "mcp-test-client", "version": "0.0.0"}
                    }
                }))
                .await;
            assert_eq!(response.status(), 200, "initialize should succeed");
            self.session_id = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            assert!(self.session_id.is_some(), "stateful server must return Mcp-Session-Id");
            let body = response.text().await.unwrap();
            let result = parse_sse_json(&body);
            // Spec-compliant clients send this notification before any other
            // call; the SDK doesn't appear to require it (only session
            // existence), but sending it keeps this test client honest about
            // what a real client does.
            let notified = self
                .post_raw(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
                .await;
            assert_eq!(notified.status(), 202, "initialized notification should be accepted");
            result
        }

        async fn call(&self, id: i64, method: &str, params: Value) -> Value {
            let response = self.post_raw(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await;
            assert_eq!(response.status(), 200, "{method} should succeed");
            let body = response.text().await.unwrap();
            parse_sse_json(&body)
        }
    }

    #[tokio::test]
    async fn enable_while_vault_locked_fails() {
        let state = AppState::new();
        let err = set_enabled_impl(&state, true, Some(0), None).await.unwrap_err();
        assert!(err.contains("vault is locked"), "unexpected error: {err}");

        let status = get_status_impl(&state).unwrap();
        assert!(!status.enabled, "a failed enable must not flip the enabled flag");
    }

    #[tokio::test]
    async fn enable_binds_the_port_and_status_reflects_it() {
        let state = AppState::new();
        unlock(&state);

        // `Some(0)` — let the OS assign a free ephemeral port through the
        // one real bind `set_enabled_impl` performs, rather than probing
        // for a "likely free" port ahead of time and racing every other
        // parallel test doing the same probe (see `occupy_a_free_port`'s
        // doc comment).
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();
        assert!(status.enabled);
        assert_ne!(status.port, 0, "the real bound port must be reported back, not the `0` wildcard");
        assert!(!status.token.is_empty());

        // The server holds the listener open — a second bind on the same
        // port must fail while the server is "enabled".
        let second_bind = std::net::TcpListener::bind(("127.0.0.1", status.port));
        assert!(second_bind.is_err(), "port must be occupied while the MCP server is enabled");

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn disable_frees_the_port_and_status_reflects_it() {
        let state = AppState::new();
        unlock(&state);

        let enabled = set_enabled_impl(&state, true, Some(0), None).await.unwrap();
        let status = set_enabled_impl(&state, false, None, None).await.unwrap();
        assert!(!status.enabled);

        // stop_if_running awaits the task's completion, so our own server's
        // hold on the port is gone immediately — no retry needed to prove
        // *that*. `assert_port_becomes_free` still retries briefly, but only
        // to absorb an unrelated concurrently-running test being handed
        // this exact just-freed number for an instant (see its doc
        // comment), not to paper over a slow drain.
        assert_port_becomes_free(enabled.port, "port must be free again once disabled");
    }

    #[tokio::test]
    async fn vault_lock_hook_stops_the_server() {
        let state = AppState::new();
        unlock(&state);

        let enabled = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        // Mirrors the `vault_lock` command: clear the key, then stop.
        *state.vault_key.lock().unwrap() = None;
        stop_if_running(&state).await.unwrap();

        let status = get_status_impl(&state).unwrap();
        assert!(!status.enabled);
        assert_port_becomes_free(enabled.port, "the vault-lock hook must free the port");
    }

    #[tokio::test]
    async fn regenerate_token_changes_the_token() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();
        let original = status.token;

        let regenerated = regenerate_token_impl(&state).unwrap();
        assert_ne!(regenerated.token, original);
        assert!(regenerated.enabled, "regenerating must not touch enablement");

        // status reflects the new token too, not just the regenerate call's return value.
        assert_eq!(get_status_impl(&state).unwrap().token, regenerated.token);

        stop_if_running(&state).await.unwrap();
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
        // Occupy a real port ourselves first so the bind inside
        // set_enabled_impl fails.
        let (_occupier, port) = occupy_a_free_port();

        let err = set_enabled_impl(&state, true, Some(port), None).await.unwrap_err();
        assert!(err.contains(&port.to_string()), "error should mention the port: {err}");

        let status = get_status_impl(&state).unwrap();
        assert!(!status.enabled);
        assert!(status.token.is_empty(), "a failed enable must not mint a token either");
    }

    #[tokio::test]
    async fn enable_on_occupied_port_leaves_a_previously_running_server_untouched() {
        let state = AppState::new();
        unlock(&state);
        let good = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        // This one *does* need a real, currently-occupied port to hand to
        // `set_enabled_impl` and observe the bind failure.
        let (_occupier, occupied_port) = occupy_a_free_port();
        let err = set_enabled_impl(&state, true, Some(occupied_port), None).await.unwrap_err();
        assert!(err.contains(&occupied_port.to_string()));

        // The original server on good.port must still be running.
        let status = get_status_impl(&state).unwrap();
        assert!(status.enabled);
        assert_eq!(status.port, good.port);
        let rebind_good = std::net::TcpListener::bind(("127.0.0.1", good.port));
        assert!(rebind_good.is_err(), "the previously-running server must still hold its port");

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn disable_when_never_enabled_is_a_harmless_noop() {
        let state = AppState::new();
        let status = set_enabled_impl(&state, false, None, None).await.unwrap();
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

    // ---- Task 2: protocol + auth tests --------------------------------

    #[tokio::test]
    async fn initialize_handshake_succeeds_with_token() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        let mut client = TestClient::new(status.port, &status.token);
        let init = client.initialize().await;
        assert!(init["result"]["serverInfo"]["name"].as_str().is_some_and(|n| !n.is_empty()), "expected a non-empty serverInfo.name, got: {init:?}");
        assert!(init["result"]["capabilities"]["tools"].is_object(), "server must advertise tools capability");

        stop_if_running(&state).await.unwrap();
    }

    /// Task 2 originally asserted `ping` was the *only* tool served; Task 4
    /// grew the registry to twelve (see `tool_router_exposes_all_eleven_tools`
    /// and the golden-fixture test below for the full-surface assertions),
    /// so this now just proves `ping` itself is still served correctly —
    /// name, description, and a no-args schema — over the real HTTP
    /// transport, independent of how many other tools sit alongside it.
    #[tokio::test]
    async fn tools_list_contains_ping() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        let mut client = TestClient::new(status.port, &status.token);
        client.initialize().await;
        let list = client.call(2, "tools/list", json!({})).await;
        let tools = list["result"]["tools"].as_array().expect("tools/list must return an array");
        let ping = tools.iter().find(|t| t["name"] == "ping").unwrap_or_else(|| panic!("no `ping` tool in tools/list: {tools:?}"));
        assert!(ping["description"].as_str().unwrap_or_default().contains("pong"));
        // No-args tool: an empty (or property-less) object input schema.
        let schema = &ping["inputSchema"];
        assert_eq!(schema["type"], "object");
        let no_required_props = schema.get("required").map(|r| r.as_array().map(|a| a.is_empty()).unwrap_or(true)).unwrap_or(true);
        assert!(no_required_props, "ping takes no args, schema was: {schema:?}");

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn ping_call_returns_pong_and_version() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        let mut client = TestClient::new(status.port, &status.token);
        client.initialize().await;
        let result = client.call(2, "tools/call", json!({"name": "ping", "arguments": {}})).await;
        let text = result["result"]["content"][0]["text"].as_str().expect("ping must return text content");
        assert_eq!(text, format!("pong {}", env!("CARGO_PKG_VERSION")));

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn request_without_token_is_401() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://127.0.0.1:{}{MCP_PATH}", status.port))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "x", "version": "0"}}}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
        let body: Value = response.json().await.unwrap();
        assert!(body.get("error").is_some(), "401 body should be a JSON error object: {body:?}");

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn request_with_wrong_token_is_401() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        let client = TestClient::new(status.port, "not-the-real-token");
        let response = client
            .post_raw(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "x", "version": "0"}}}))
            .await;
        assert_eq!(response.status(), 401);

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn regenerating_the_token_401s_the_old_token_on_the_next_request() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();
        let old_token = status.token.clone();

        let mut client = TestClient::new(status.port, &old_token);
        client.initialize().await; // works with the original token

        let regenerated = regenerate_token_impl(&state).unwrap();
        assert_ne!(regenerated.token, old_token);

        // Same client, same (now-stale) captured token: the *next* request must 401.
        let response = client.call_raw_status(3, "tools/list", json!({})).await;
        assert_eq!(response, 401, "the old token must stop working immediately after regenerate");

        stop_if_running(&state).await.unwrap();
    }

    impl TestClient {
        async fn call_raw_status(&self, id: i64, method: &str, params: Value) -> u16 {
            self.post_raw(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await.status().as_u16()
        }
    }

    #[tokio::test]
    async fn graceful_stop_lets_an_in_flight_request_finish_and_still_frees_the_port() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        let mut client = TestClient::new(status.port, &status.token);
        client.initialize().await;

        // Fire a real request on its own task and give it a small head start
        // to actually get *accepted* (axum's graceful shutdown only waits for
        // connections already accepted at the moment the signal fires — a
        // connection still mid-handshake when shutdown is signalled is fair
        // game to be refused, so racing the two with zero head start would
        // make this test flaky on scheduling order rather than proving
        // anything about graceful shutdown). The mandate under test is: once
        // accepted, an in-flight request finishes instead of being hard-cut.
        let ping_task = tokio::spawn(async move { client.call(9, "tools/call", json!({"name": "ping", "arguments": {}})).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        stop_if_running(&state).await.unwrap();

        let ping_result = ping_task.await.expect("ping task must not panic");
        let text = ping_result["result"]["content"][0]["text"].as_str().expect("in-flight ping must still complete");
        assert_eq!(text, format!("pong {}", env!("CARGO_PKG_VERSION")));

        // And per Task 1's original assertion: the port must be free again.
        assert_port_becomes_free(status.port, "port must be free again once the graceful stop completes");
    }

    // ---- Task 4: read-tool registry ------------------------------------

    /// Golden snapshot of `tools/list` (name/description/inputSchema, sorted
    /// by name) — the documented-tool-list acceptance criterion's source of
    /// truth (Global Constraints). Derived straight from
    /// `McpServer::tool_router()` (the same `#[tool_router]`-generated table
    /// the running server serves — no separate hand-maintained registry to
    /// drift from it), so this needs no live server/port at all, unlike the
    /// protocol tests above.
    ///
    /// `Tool` already `#[serde(rename_all = "camelCase")]`s with
    /// `skip_serializing_if = "Option::is_none"` on every field this
    /// registry never sets (title/outputSchema/annotations/execution/icons/
    /// meta), so serializing the whole `Tool` list reduces to exactly
    /// name/description/inputSchema today — and would visibly grow the
    /// fixture (an intentional, reviewable diff) the day a tool gains one of
    /// those.
    #[test]
    fn tools_list_matches_golden_fixture() {
        let mut tools = McpServer::tool_router().list_all();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        let actual = serde_json::to_string_pretty(&tools).expect("Tool list must serialize") + "\n";

        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/mcp-tools-golden.json");
        if std::env::var("MCP_GOLDEN_UPDATE").is_ok() {
            std::fs::write(path, &actual).expect("failed to write golden fixture");
            return;
        }
        let expected = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("failed to read golden fixture at {path}: {e} — run with MCP_GOLDEN_UPDATE=1 to create it"));
        assert_eq!(
            actual, expected,
            "tools/list drifted from fixtures/mcp-tools-golden.json (names/descriptions/schemas) — \
             if this is an intentional tool-surface change, review the diff and regenerate with: \
             `MCP_GOLDEN_UPDATE=1 cargo test -p tauri-app --lib mcp::tests::tools_list_matches_golden_fixture -- --exact`"
        );
    }

    #[test]
    fn tool_router_exposes_all_sixteen_tools() {
        let names: std::collections::HashSet<String> = McpServer::tool_router().list_all().into_iter().map(|t| t.name.to_string()).collect();
        for expected in [
            "ping",
            "list_profiles",
            "list_connections",
            "connect",
            "disconnect",
            "list_databases",
            "list_collections",
            "find",
            "aggregate",
            "explain",
            "schema_analysis",
            "list_indexes",
            "insert_one",
            "update_many",
            "delete_many",
            "create_index",
        ] {
            assert!(names.contains(expected), "tool_router is missing `{expected}`; got {names:?}");
        }
        assert_eq!(names.len(), 16, "unexpected tool count — update this list (and the golden fixture) alongside any registry change");
    }

    /// Drift lock for `docs/mcp-tools.md`: every tool name in the golden
    /// fixture (the same source of truth `tools_list_matches_golden_fixture`
    /// checks the live registry against) must appear in the hand-authored
    /// docs page as a `### `name`` heading. This doesn't catch every kind of
    /// doc staleness (a changed description/schema won't fail this), but it
    /// guarantees the doc can never silently drop or forget to add a tool
    /// when the fixture changes — regenerate the golden fixture, add the
    /// tool's section to the doc, this test goes green again.
    #[test]
    fn mcp_tools_doc_lists_every_tool_from_the_golden_fixture() {
        let fixture_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/mcp-tools-golden.json");
        let fixture = std::fs::read_to_string(fixture_path)
            .unwrap_or_else(|e| panic!("failed to read golden fixture at {fixture_path}: {e}"));
        let tools: Vec<Value> = serde_json::from_str(&fixture).expect("golden fixture must be valid JSON");

        let doc_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/mcp-tools.md");
        let doc = std::fs::read_to_string(doc_path)
            .unwrap_or_else(|e| panic!("failed to read {doc_path}: {e}"));

        for tool in &tools {
            let name = tool["name"].as_str().expect("fixture tool must have a string name");
            let heading = format!("### `{name}`");
            assert!(
                doc.contains(&heading),
                "docs/mcp-tools.md is missing a `{heading}` section for tool `{name}` — \
                 the tool registry (fixtures/mcp-tools-golden.json) has drifted from the doc; \
                 add/update its section in docs/mcp-tools.md"
            );
        }
    }

    // ---- Task 5: write-tool round trip ------------------------------------

    /// One end-to-end pass over the real HTTP transport proving a Task 5
    /// write tool round-trips through the whole stack — auth, JSON-RPC,
    /// `Parameters<T>` deserialization of a `_confirm: bool` field alongside
    /// a `filter` JSON-object field, and back — mirroring
    /// `find_tool_round_trips_over_http_against_a_mock_connection` above.
    /// This `McpServer` has no `AppHandle` (same as that test), so every
    /// tool call fails the same clean "no application handle" way rather
    /// than panicking the server task — this is what actually gets proven
    /// here; the exhaustive `_confirm`-gate ordering and per-tool mock-path
    /// coverage lives in `mcp_tools.rs`'s own tests, which call the `_impl`
    /// functions directly with a real `AppState`.
    #[tokio::test]
    async fn delete_many_tool_round_trips_over_http() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        let mut client = TestClient::new(status.port, &status.token);
        client.initialize().await;

        let result = client
            .call(
                2,
                "tools/call",
                json!({
                    "name": "delete_many",
                    "arguments": {
                        "connection_id": "whatever",
                        "database": "d",
                        "collection": "c",
                        "filter": {},
                        "_confirm": false
                    }
                }),
            )
            .await;
        let content = &result["result"]["content"][0]["text"];
        assert!(
            content.as_str().unwrap_or_default().contains("no application handle"),
            "expected the AppHandle-less error, got: {result:?}"
        );
        assert_eq!(result["result"]["isError"], true);

        stop_if_running(&state).await.unwrap();
    }

    /// One end-to-end pass over the real HTTP transport (mirrors
    /// `ping_call_returns_pong_and_version` above) proving a Task 4 tool
    /// round-trips through the whole stack — auth, JSON-RPC, `Parameters<T>`
    /// deserialization, and back — over a mock connection (no real MongoDB
    /// needed; see `mcp_tools.rs`'s own tests for exhaustive per-tool
    /// coverage at the impl layer, which is where the bulk of Task 4's
    /// behavior is actually proven).
    #[tokio::test]
    async fn find_tool_round_trips_over_http_against_a_mock_connection() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(0), None).await.unwrap();

        let mut client = TestClient::new(status.port, &status.token);
        client.initialize().await;

        // `McpServer` has no `AppHandle` in this test (see `TestClient`'s
        // `set_enabled_impl(..., None)` above) — every Task 4 tool needs one
        // to resolve `AppState`/the profiles path, so every call must fail
        // the same clean way rather than panicking the server task.
        let result = client
            .call(2, "tools/call", json!({"name": "list_profiles", "arguments": {}}))
            .await;
        let content = &result["result"]["content"][0]["text"];
        assert!(
            content.as_str().unwrap_or_default().contains("no application handle"),
            "expected the AppHandle-less error, got: {result:?}"
        );
        assert_eq!(result["result"]["isError"], true);

        stop_if_running(&state).await.unwrap();
    }
}

#[cfg(test)]
mod agent_instruction_tests {
    use super::AGENT_INSTRUCTIONS;

    /// Tool names the instructions walk the agent through. Kept as data so the
    /// test below can check both directions: the prose must not name a tool that
    /// no longer exists, and it must not silently stop covering one.
    const NAMED_TOOLS: &[&str] = &[
        "ping",
        "list_connections",
        "list_profiles",
        "connect",
        "list_databases",
        "list_collections",
        "schema_analysis",
        "list_indexes",
        "find",
        "aggregate",
        "explain",
        "insert_one",
        "update_many",
        "delete_many",
        "create_index",
    ];

    #[test]
    fn every_named_tool_is_a_real_tool() {
        // The tool set is declared with `#[tool(...)]` attributes in this file,
        // so the file itself is the source of truth. Reading it keeps the
        // instructions honest without a second list to maintain.
        let src = include_str!("mcp.rs");
        for tool in NAMED_TOOLS {
            let declared = format!("async fn {tool}(");
            assert!(
                src.contains(&declared),
                "the instructions tell agents to call `{tool}`, but no such tool is declared"
            );
            assert!(
                AGENT_INSTRUCTIONS.contains(tool),
                "`{tool}` is listed here but missing from the instructions"
            );
        }
    }

    #[test]
    fn every_destructive_tool_is_covered_by_the_confirmation_paragraph() {
        // A write tool the instructions forget to mention is the dangerous
        // direction: the agent meets `_confirm` only as a rejection, having
        // already told the user it was about to write.
        let tools_src = include_str!("mcp_tools.rs");
        for args in [
            "InsertOneArgs",
            "UpdateManyArgs",
            "DeleteManyArgs",
            "CreateIndexArgs",
        ] {
            let start = tools_src
                .find(&format!("pub struct {args} {{"))
                .unwrap_or_else(|| panic!("{args} not found"));
            let body = &tools_src[start..];
            let end = body.find("\n}").expect("struct end");
            assert!(
                body[..end].contains("_confirm"),
                "{args} no longer gates on _confirm — the instructions say it does"
            );
        }
        assert!(AGENT_INSTRUCTIONS.contains("_confirm: true"));
        for tool in ["insert_one", "update_many", "delete_many", "create_index"] {
            assert!(
                AGENT_INSTRUCTIONS.contains(tool),
                "destructive tool `{tool}` is not named in the instructions"
            );
        }
    }

    #[test]
    fn read_tools_are_not_described_as_needing_confirmation() {
        let tools_src = include_str!("mcp_tools.rs");
        for args in ["FindArgs", "AggregateArgs"] {
            let start = tools_src.find(&format!("pub struct {args} {{")).unwrap();
            let body = &tools_src[start..];
            let end = body.find("\n}").unwrap();
            assert!(
                !body[..end].contains("_confirm"),
                "{args} now gates on _confirm — the instructions imply reads do not"
            );
        }
    }

    #[test]
    fn argument_names_in_the_prose_are_the_schema_names() {
        let tools = include_str!("mcp_tools.rs");
        assert!(tools.contains("pub profile_id: String"), "ConnectArgs renamed?");
        assert!(tools.contains("pub connection_id: String"), "connection_id renamed?");
        assert!(AGENT_INSTRUCTIONS.contains("`profile_id`"));
        assert!(AGENT_INSTRUCTIONS.contains("`connection_id`"));
        assert!(!AGENT_INSTRUCTIONS.contains("with a profileId"), "old camelCase phrasing");
    }

    #[test]
    fn the_logging_claim_does_not_promise_more_than_the_gates_allow() {
        // Level A is the default and `should_record` rejects ReadHigh there, and
        // logging can be switched off entirely — so "every call is recorded" was
        // false. The prose must not restate a guarantee the settings can revoke.
        use crate::audit::level::{should_record, AuditLevel, OpClass};
        assert!(!should_record(AuditLevel::A, OpClass::ReadHigh), "level A now logs reads?");
        assert!(!AGENT_INSTRUCTIONS.contains("Every call is recorded"));
        assert!(!AGENT_INSTRUCTIONS.contains("everything except `ping`"));
        assert!(AGENT_INSTRUCTIONS.contains("depends on their settings"));
    }

    #[test]
    fn the_logging_claim_matches_what_ping_does() {
        let src = include_str!("mcp.rs");
        let start = src.find("async fn ping(&self)").unwrap();
        let ping = &src[start..start + 200];
        assert!(!ping.contains("log_call"), "ping now logs; tighten the prose instead");
        // `ping` remains unlogged; the prose no longer claims otherwise for anything.
        assert!(!AGENT_INSTRUCTIONS.contains("Every call is recorded"));
    }

    #[test]
    fn the_result_caps_match_the_find_tool() {
        // Numbers in prose rot quietly. These are the ones an agent acts on.
        let src = include_str!("mcp.rs");
        assert!(
            src.contains("default 50 docs / 1MB") && src.contains("caps at 200"),
            "find's documented caps changed; the instructions still say 50 / 1MB / 200"
        );
        assert!(AGENT_INSTRUCTIONS.contains("50 documents or 1MB"));
        assert!(AGENT_INSTRUCTIONS.contains("caps at 200"));
    }
}
