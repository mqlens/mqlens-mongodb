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
use rmcp::model::{ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Bound when `mcp_set_enabled` is called without an explicit `port`.
pub const DEFAULT_PORT: u16 = 8765;

/// HTTP path the streamable-HTTP service is nested under.
const MCP_PATH: &str = "/mcp";

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

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let mcp_shared = Arc::clone(&state.mcp);
    let join = tauri::async_runtime::spawn(run_server(listener, mcp_shared, app_handle, shutdown_rx));

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
    /// Not read by the `ping`-only Task 2 tool surface. Carried now (see
    /// `set_enabled_impl`'s doc comment) so Task 4's tools can start using
    /// it without any lifecycle plumbing changes.
    #[allow(dead_code)]
    app_handle: Option<tauri::AppHandle>,
}

impl McpServer {
    fn new(app_handle: Option<tauri::AppHandle>) -> Self {
        Self { tool_router: Self::tool_router(), app_handle }
    }
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
}

#[tool_handler]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("MQLens embedded MCP server. Call `ping` to verify connectivity.")
    }
}

/// `true` iff `headers` carries `Authorization: Bearer <token>` matching the
/// *current* token in `control` — read fresh on every call (never captured
/// at server-start time), so a `mcp_regenerate_token` call invalidates the
/// old token starting with the very next request.
fn bearer_token_matches(control: &StdMutex<McpControl>, headers: &axum::http::HeaderMap) -> bool {
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
    !guard.token.is_empty() && presented == guard.token
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
    let http_service: StreamableHttpService<McpServer, LocalSessionManager> =
        StreamableHttpService::new(move || Ok(McpServer::new(app_handle.clone())), session_manager, StreamableHttpServerConfig::default());

    let auth_mcp = Arc::clone(&mcp);
    let router = axum::Router::new().nest_service(MCP_PATH, http_service).layer(axum::middleware::from_fn(
        move |req: axum::extract::Request, next: axum::middleware::Next| {
            let mcp = Arc::clone(&auth_mcp);
            async move {
                if bearer_token_matches(&mcp, req.headers()) {
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

    /// Binds an ephemeral OS-assigned port and returns it, for tests that
    /// need a real free port without risking collisions between test runs.
    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
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
        let err = set_enabled_impl(&state, true, Some(free_port()), None).await.unwrap_err();
        assert!(err.contains("vault is locked"), "unexpected error: {err}");

        let status = get_status_impl(&state).unwrap();
        assert!(!status.enabled, "a failed enable must not flip the enabled flag");
    }

    #[tokio::test]
    async fn enable_binds_the_port_and_status_reflects_it() {
        let state = AppState::new();
        unlock(&state);
        let port = free_port();

        let status = set_enabled_impl(&state, true, Some(port), None).await.unwrap();
        assert!(status.enabled);
        assert_eq!(status.port, port);
        assert!(!status.token.is_empty());

        // The server holds the listener open — a second bind on the same
        // port must fail while the server is "enabled".
        let second_bind = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(second_bind.is_err(), "port must be occupied while the MCP server is enabled");

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn disable_frees_the_port_and_status_reflects_it() {
        let state = AppState::new();
        unlock(&state);
        let port = free_port();

        set_enabled_impl(&state, true, Some(port), None).await.unwrap();
        let status = set_enabled_impl(&state, false, None, None).await.unwrap();
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

        set_enabled_impl(&state, true, Some(port), None).await.unwrap();

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
        let status = set_enabled_impl(&state, true, Some(free_port()), None).await.unwrap();
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
        let port = free_port();
        // Occupy the port ourselves first so the bind inside set_enabled_impl fails.
        let _occupier = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();

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
        let good_port = free_port();
        set_enabled_impl(&state, true, Some(good_port), None).await.unwrap();

        let occupied_port = free_port();
        let _occupier = std::net::TcpListener::bind(("127.0.0.1", occupied_port)).unwrap();
        let err = set_enabled_impl(&state, true, Some(occupied_port), None).await.unwrap_err();
        assert!(err.contains(&occupied_port.to_string()));

        // The original server on good_port must still be running.
        let status = get_status_impl(&state).unwrap();
        assert!(status.enabled);
        assert_eq!(status.port, good_port);
        let rebind_good = std::net::TcpListener::bind(("127.0.0.1", good_port));
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
        let status = set_enabled_impl(&state, true, Some(free_port()), None).await.unwrap();

        let mut client = TestClient::new(status.port, &status.token);
        let init = client.initialize().await;
        assert!(init["result"]["serverInfo"]["name"].as_str().is_some_and(|n| !n.is_empty()), "expected a non-empty serverInfo.name, got: {init:?}");
        assert!(init["result"]["capabilities"]["tools"].is_object(), "server must advertise tools capability");

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn tools_list_contains_exactly_ping() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(free_port()), None).await.unwrap();

        let mut client = TestClient::new(status.port, &status.token);
        client.initialize().await;
        let list = client.call(2, "tools/list", json!({})).await;
        let tools = list["result"]["tools"].as_array().expect("tools/list must return an array");
        assert_eq!(tools.len(), 1, "expected exactly one tool, got: {tools:?}");
        assert_eq!(tools[0]["name"], "ping");
        assert!(tools[0]["description"].as_str().unwrap_or_default().contains("pong"));
        // No-args tool: an empty (or property-less) object input schema.
        let schema = &tools[0]["inputSchema"];
        assert_eq!(schema["type"], "object");
        let no_required_props = schema.get("required").map(|r| r.as_array().map(|a| a.is_empty()).unwrap_or(true)).unwrap_or(true);
        assert!(no_required_props, "ping takes no args, schema was: {schema:?}");

        stop_if_running(&state).await.unwrap();
    }

    #[tokio::test]
    async fn ping_call_returns_pong_and_version() {
        let state = AppState::new();
        unlock(&state);
        let status = set_enabled_impl(&state, true, Some(free_port()), None).await.unwrap();

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
        let status = set_enabled_impl(&state, true, Some(free_port()), None).await.unwrap();

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
        let status = set_enabled_impl(&state, true, Some(free_port()), None).await.unwrap();

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
        let status = set_enabled_impl(&state, true, Some(free_port()), None).await.unwrap();
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
        let port = free_port();
        let status = set_enabled_impl(&state, true, Some(port), None).await.unwrap();

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
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(rebound.is_ok(), "port must be free again once the graceful stop completes");
    }
}
