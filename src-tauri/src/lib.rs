use mongodb::{options::ClientOptions, Client};
use serde::Serialize;
use serde_json;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use uuid::Uuid;

pub mod limits;
pub mod ai;
pub mod ai_providers;
pub mod audit;
#[cfg(test)]
mod command_coverage;
pub mod change_streams;
pub mod chats;
pub mod connections;
mod db;
pub mod durable;
pub mod mcp;
pub mod mcp_tools;
pub(crate) mod mock_db;
pub mod monitoring;
pub mod path_env;
pub mod queries;
pub mod ssh_tunnel;
mod namespace_guard;
mod state;
pub mod toolsetup;
pub mod updater;
mod vault;
mod window;
mod windows;
mod workspace;
mod write_guard;
pub mod biometric;
pub use db::aggregate::{execute_aggregate_impl, explain_aggregate_query_impl};
pub use db::ddl::{
    create_collection_impl, create_view_impl, drop_collection_impl, drop_database_impl,
    rename_collection_impl, rename_database_impl, DatabaseRenameResult, CollectionValidation,
    get_collection_options_impl, set_validator_impl,
};
pub use db::documents::{
    delete_document_impl, delete_many_impl, import_documents_impl, insert_document_impl,
    json_to_bson_document, parse_json_array_docs, update_document_impl, update_many_impl,
    ImportResult,
};
pub use db::export::{
    format_current_docs_impl, preview_export_impl, sample_export_fields_impl,
    start_collection_export_impl, start_filtered_export_impl,
};
pub use db::gridfs::{
    delete_gridfs_file_impl, download_gridfs_file_impl, list_gridfs_files_impl,
    upload_gridfs_file_impl, GridFsFileInfo, GridFsTransferProgress,
};
pub use db::import::{preview_import_impl, start_import_task_impl};
pub use db::mongotools::{
    browse_dump_folder_impl, resolve_conn_uri, start_dump_task_impl, start_restore_task_impl,
    DumpTree, ToolInfo, ToolsStatus,
};
pub use db::metadata::{
    create_index_impl, delete_index_impl, list_collections_impl, list_databases_impl,
    list_indexes_impl,
};
pub use db::stats::{db_stats_impl, coll_stats_impl, index_stats_impl};
pub use db::query::{count_documents_impl, execute_mql_query_impl, explain_mql_query_impl};
pub use db::schema::{analyze_schema_impl, infer_schema, FieldStat, SchemaReport, TypeCount};
pub use db::users::{
    create_user_impl, drop_user_impl, list_roles_impl, list_users_impl, update_user_impl,
    MongoUser, RoleInfo, RoleSpec,
};
pub use db::version::get_mongodb_version_impl;
pub use db::copy::{preflight_copy_impl, start_collection_copy_impl, start_database_copy_impl, CopyTargetRef};
pub use biometric::{decode_and_verify_key, encode_key, BiometricStatus};
pub use state::{AppState, ConnectionEntry, ConnectionMeta, ConnectionsChangedPayload, LockExt};
pub use window::target_window_size;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod integration_tests;

/// Connect + server-selection timeout for the main (non-test) connection path.
const MAIN_CONNECT_TIMEOUT_SECS: u64 = 10;

/// Apply the main-path connect/server-selection timeouts to client options,
/// filling in the 10s default only where the URI did not already specify one
/// (so user-supplied `connectTimeoutMS`/`serverSelectionTimeoutMS` win).
pub fn apply_main_timeouts(opts: &mut mongodb::options::ClientOptions) {
    if opts.connect_timeout.is_none() {
        opts.connect_timeout = Some(std::time::Duration::from_secs(MAIN_CONNECT_TIMEOUT_SECS));
    }
    if opts.server_selection_timeout.is_none() {
        opts.server_selection_timeout =
            Some(std::time::Duration::from_secs(MAIN_CONNECT_TIMEOUT_SECS));
    }
}

/// Sample this app's CPU% and resident memory — the main process plus descendant
/// processes (WebView/renderer helpers). CPU is a delta since the previous sample.
pub fn resource_usage_impl(state: &AppState) -> ResourceUsage {
    use crate::limits::RESOURCE_TREE_REFRESH_SECS;
    use std::collections::HashSet;

    let pid = match sysinfo::get_current_pid() {
        Ok(pid) => pid,
        Err(_) => {
            return ResourceUsage {
                cpu_percent: 0.0,
                memory_bytes: 0,
            }
        }
    };
    let mut sys = state.sys.lock().unwrap_or_else(|p| p.into_inner());

    let rebuild_tree = {
        let pids = state.resource_pids.lock().unwrap_or_else(|p| p.into_inner());
        let tree_at = state.resource_tree_at.lock().unwrap_or_else(|p| p.into_inner());
        pids.is_empty() || tree_at.elapsed().as_secs() >= RESOURCE_TREE_REFRESH_SECS
    };

    // Only memory + CPU are read below. The default refresh kind would also
    // collect disk usage, exe paths, and (Linux) one entry per THREAD via
    // with_tasks — and with remove_dead_processes=false the retained System
    // kept every process/thread that ever existed, growing RSS without bound
    // on busy hosts (issue #165). Refresh minimally and always purge the dead.
    let refresh_kind = sysinfo::ProcessRefreshKind::nothing().with_memory().with_cpu();

    if rebuild_tree {
        sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, refresh_kind);
        let mut tree: HashSet<sysinfo::Pid> = HashSet::new();
        tree.insert(pid);
        loop {
            let mut added = false;
            for (cpid, proc_) in sys.processes() {
                if !tree.contains(cpid) {
                    if let Some(parent) = proc_.parent() {
                        if tree.contains(&parent) {
                            tree.insert(*cpid);
                            added = true;
                        }
                    }
                }
            }
            if !added {
                break;
            }
        }
        *state.resource_pids.lock().unwrap_or_else(|p| p.into_inner()) =
            tree.iter().copied().collect();
        *state
            .resource_tree_at
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Instant::now();
    } else {
        let pids = state.resource_pids.lock().unwrap_or_else(|p| p.into_inner());
        if !pids.is_empty() {
            sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&pids), true, refresh_kind);
        }
    }

    let pids = state.resource_pids.lock().unwrap_or_else(|p| p.into_inner());
    let mut memory_bytes: u64 = 0;
    let mut cpu_percent: f32 = 0.0;
    for p in pids.iter() {
        if let Some(proc_) = sys.process(*p) {
            memory_bytes += proc_.memory();
            cpu_percent += proc_.cpu_usage();
        }
    }
    ResourceUsage {
        cpu_percent,
        memory_bytes,
    }
}

#[derive(Clone)]
enum MongoshStream {
    Stdout,
    Stderr,
}

struct MongoshLine {
    stream: MongoshStream,
    text: String,
}

pub struct MongoshSession {
    pub connection_id: String,
    stdin: AsyncMutex<ChildStdin>,
    output: AsyncMutex<mpsc::UnboundedReceiver<MongoshLine>>,
    child: AsyncMutex<Child>,
    command_lock: AsyncMutex<()>,
}

#[derive(Serialize, Clone)]
pub struct ResourceUsage {
    // Process CPU usage as reported by the OS (can exceed 100% across cores).
    pub cpu_percent: f32,
    // Resident set size of this process, in bytes.
    pub memory_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct AgentDetection {
    pub id: String,
    pub binary: String,
    pub available: bool,
    pub version: String,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CopyFailure {
    pub collection: String,
    pub error: String,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CopySummary {
    pub collections_copied: u64,
    pub documents_copied: u64,
    pub documents_skipped: u64,
    pub indexes_created: u64,
    pub skipped: Vec<String>,
    pub failed: Vec<CopyFailure>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub status: String,
    pub processed: u64,
    pub total: Option<u64>,
    pub message: String,
    pub path: Option<String>,
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items_processed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<CopySummary>,
}

/// Probe each local agent's binary with `--version` (short, blocking). NotFound -> not available.
pub fn detect_local_agents_impl() -> Vec<AgentDetection> {
    let agents = [
        ("claude-code", "claude"),
        ("codex", "codex"),
        ("cursor", "cursor-agent"),
        ("antigravity", "antigravity"),
    ];
    agents
        .iter()
        .map(|(id, binary)| {
            let result = std::process::Command::new(binary).arg("--version").output();
            match result {
                Ok(out) => {
                    let text = if !out.stdout.is_empty() {
                        String::from_utf8_lossy(&out.stdout)
                    } else {
                        String::from_utf8_lossy(&out.stderr)
                    };
                    let version = text.lines().next().unwrap_or("").trim().to_string();
                    AgentDetection {
                        id: id.to_string(),
                        binary: binary.to_string(),
                        available: true,
                        version,
                    }
                }
                Err(_) => AgentDetection {
                    id: id.to_string(),
                    binary: binary.to_string(),
                    available: false,
                    version: String::new(),
                },
            }
        })
        .collect()
}

#[tauri::command]
async fn detect_local_agents() -> Result<Vec<AgentDetection>, String> {
    Ok(detect_local_agents_impl())
}

#[derive(Serialize, Clone)]
pub struct CollectionInfo {
    pub name: String,
    // "collection" | "view" | "timeseries" — lets the UI separate views/buckets/system.
    #[serde(rename = "type")]
    pub collection_type: String,
}

#[derive(Serialize, Clone)]
pub struct IndexInfo {
    pub name: String,
    // The real key pattern serialized as a JSON string, preserving field order and
    // direction/type values (1, -1, "2dsphere", "text", "hashed", ...).
    pub keys: String,
    pub unique: bool,
    pub sparse: bool,
}

#[derive(Serialize)]
pub struct MongoshCommandOutput {
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

#[derive(Serialize)]
pub struct MongoshSessionInfo {
    pub session_id: String,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

fn spawn_mongosh_reader<R>(
    reader: R,
    stream: MongoshStream,
    sender: mpsc::UnboundedSender<MongoshLine>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = sender.send(MongoshLine {
                stream: stream.clone(),
                text: line,
            });
        }
    });
}

async fn drain_mongosh_output(session: &MongoshSession) -> MongoshCommandOutput {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut output = session.output.lock().await;

    loop {
        match tokio::time::timeout(Duration::from_millis(25), output.recv()).await {
            Ok(Some(line)) => match line.stream {
                MongoshStream::Stdout => push_mongosh_line(&mut stdout, line.text),
                MongoshStream::Stderr => push_mongosh_line(&mut stderr, line.text),
            },
            _ => break,
        }
    }

    MongoshCommandOutput { stdout, stderr }
}

async fn run_mongosh_command_on_session(
    session: &MongoshSession,
    command: &str,
) -> Result<MongoshCommandOutput, String> {
    let _command_guard = session.command_lock.lock().await;
    let marker = format!("__MQLENS_DONE_{}__", Uuid::new_v4().simple());

    let _ = drain_mongosh_output(session).await;

    {
        let mut stdin = session.stdin.lock().await;
        stdin
            .write_all(command.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to mongosh: {}", e))?;
        if !command.ends_with('\n') {
            stdin
                .write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write to mongosh: {}", e))?;
        }
        stdin
            .write_all(format!("print('{}')\n", marker).as_bytes())
            .await
            .map_err(|e| format!("Failed to write command marker to mongosh: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush mongosh stdin: {}", e))?;
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut output = session.output.lock().await;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("mongosh command timed out".to_string());
        }

        match tokio::time::timeout(remaining, output.recv()).await {
            Ok(Some(line)) => {
                if line.text.contains(&marker) {
                    break;
                }
                match line.stream {
                    MongoshStream::Stdout => push_mongosh_line(&mut stdout, line.text),
                    MongoshStream::Stderr => push_mongosh_line(&mut stderr, line.text),
                }
            }
            Ok(None) => return Err("mongosh session closed".to_string()),
            Err(_) => return Err("mongosh command timed out".to_string()),
        }
    }

    Ok(MongoshCommandOutput { stdout, stderr })
}

fn push_mongosh_line(lines: &mut Vec<String>, text: String) {
    use crate::limits::{MAX_MONGOSH_LINE_CHARS, MAX_MONGOSH_LINES, MAX_MONGOSH_TOTAL_CHARS};
    if lines.len() >= MAX_MONGOSH_LINES {
        return;
    }
    let trimmed: String = text.chars().take(MAX_MONGOSH_LINE_CHARS).collect();
    let total: usize = lines.iter().map(|l| l.len()).sum::<usize>() + trimmed.len();
    if total > MAX_MONGOSH_TOTAL_CHARS {
        return;
    }
    lines.push(trimmed);
}

fn get_mongosh_session(state: &AppState, session_id: &str) -> Result<Arc<MongoshSession>, String> {
    let sessions = state.mongosh_sessions.lock_safe()?;
    sessions
        .get(session_id)
        .cloned()
        .ok_or_else(|| "mongosh session not found".to_string())
}

pub async fn connect_db_impl(
    state: &AppState,
    uri: &str,
    ssh: Option<&ssh_tunnel::SshConfig>,
) -> Result<String, String> {
    let connection_id = Uuid::new_v4().to_string();
    if uri.starts_with("mongodb://mock") {
        let mut mocks = state.mocks.lock_safe()?;
        mocks.insert(connection_id.clone(), true);
        return Ok(connection_id);
    }

    // If an SSH tunnel is configured, open it and rewrite the URI to the local
    // forwarded port before the driver connects.
    let mut effective_uri = uri.to_string();
    let mut tunnel: Option<ssh_tunnel::SshTunnel> = None;
    if let Some(cfg) = ssh {
        if cfg.enabled {
            let (target_host, target_port) = ssh_tunnel::extract_target_host_port(uri);
            let t = ssh_tunnel::open_tunnel(cfg, target_host, target_port).await?;
            effective_uri = ssh_tunnel::rewrite_uri_hosts(uri, "127.0.0.1", t.local_port);
            tunnel = Some(t);
        }
    }

    let normalized_uri = connections::normalize_mongodb_uri_options(&effective_uri);
    let mut client_options = ClientOptions::parse(&normalized_uri)
        .await
        .map_err(|e| format!("Failed to parse connection URI: {}", e))?;

    client_options.app_name = Some("MQLens-Engine".to_string());
    apply_main_timeouts(&mut client_options);

    let client = Client::with_options(client_options)
        .map_err(|e| format!("Failed to create client: {}", e))?;

    // Verify connection by running a ping command
    let db = client.database("admin");
    db.run_command(mongodb::bson::doc! { "ping": 1 })
        .await
        .map_err(|e| format!("Database ping failed: {}", e))?;

    {
        let mut connections = state.connections.lock_safe()?;
        connections.insert(connection_id.clone(), client);
    }
    {
        let mut mocks = state.mocks.lock_safe()?;
        mocks.insert(connection_id.clone(), false);
    }
    {
        let mut conn_uris = state.conn_uris.lock_safe()?;
        conn_uris.insert(connection_id.clone(), normalized_uri.clone());
    }
    if let Some(t) = tunnel {
        let mut tunnels = state.ssh_tunnels.lock_safe()?;
        tunnels.insert(connection_id.clone(), t);
    }

    Ok(connection_id)
}

pub async fn disconnect_db_impl(state: &AppState, id: &str) -> Result<(), String> {
    let sessions_to_stop: Vec<String> = {
        let sessions = state.mongosh_sessions.lock_safe()?;
        sessions
            .iter()
            .filter_map(|(session_id, session)| {
                if session.connection_id == id {
                    Some(session_id.clone())
                } else {
                    None
                }
            })
            .collect()
    };
    for session_id in sessions_to_stop {
        let _ = stop_mongosh_session_impl(state, &session_id).await;
    }

    {
        let mut connections = state.connections.lock_safe()?;
        connections.remove(id);
    }
    {
        let mut mocks = state.mocks.lock_safe()?;
        mocks.remove(id);
    }
    {
        let mut conn_uris = state.conn_uris.lock_safe()?;
        conn_uris.remove(id);
    }
    // Tear down the SSH tunnel (if any) — dropping SshTunnel aborts its accept loop.
    {
        let mut tunnels = state.ssh_tunnels.lock_safe()?;
        if let Some(tunnel) = tunnels.remove(id) {
            tunnel.close();
        }
    }
    {
        let mut meta = state.connection_meta.lock_safe()?;
        meta.remove(id);
    }
    // A human disconnecting (Sidebar's onDisconnect -> this command) an
    // agent-opened connection must also drop it from the MCP server's own
    // `session_connections` bookkeeping (final whole-branch review fix
    // wave) — otherwise a stale id lingers there forever, and a later MCP
    // `disconnect` call for that id would pass `mcp_tools::disconnect_impl`'s
    // session-owned check and try to tear down a connection that's already
    // gone (`crate::disconnect_db_impl` above is idempotent per-map-removal,
    // so that itself wouldn't error, but the stale bookkeeping is exactly
    // the kind of drift Task 4's `session_connections` doc comment says this
    // set should never carry). `mcp_tools::disconnect_impl`'s own path
    // already prunes this set itself, so this is only reached for a
    // human-initiated disconnect of an id that happens to also be
    // session-owned; harmless (and a no-op `remove`) otherwise.
    {
        let mut control = state.mcp.lock_safe()?;
        control.session_connections.remove(id);
    }

    Ok(())
}

/// Insert/replace `id`'s connection metadata (the profile it came from plus
/// a display name) — called by the frontend once a connection succeeds.
/// `AppHandle`-free like `connect_db_impl`/`disconnect_db_impl`: the
/// `connections-changed` broadcast is the `set_connection_meta` command
/// wrapper's job, mirroring `workspace::apply_impl`/`workspace_apply`'s
/// pure-mutation/emit split.
pub fn set_connection_meta_impl(
    state: &AppState,
    id: &str,
    profile_id: &str,
    name: &str,
    via_mcp: bool,
    mode: connections::ConnectionMode,
) -> Result<(), String> {
    let mut meta = state.connection_meta.lock_safe()?;
    meta.insert(id.to_string(), ConnectionMeta { profile_id: profile_id.to_string(), name: name.to_string(), via_mcp, mode });
    Ok(())
}

/// The full current connection list for a `connections-changed` broadcast,
/// sorted by connection id — a `HashMap`'s iteration order is otherwise
/// unspecified, which would make every emitted payload's element order
/// nondeterministic between calls.
pub fn connection_list_impl(state: &AppState) -> Result<Vec<ConnectionEntry>, String> {
    let meta = state.connection_meta.lock_safe()?;
    let mut list: Vec<ConnectionEntry> = meta
        .iter()
        .map(|(id, m)| ConnectionEntry { id: id.clone(), profile_id: m.profile_id.clone(), name: m.name.clone(), via_mcp: m.via_mcp, mode: m.mode })
        .collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(list)
}

/// #188 security review Fix 2 (CRITICAL): mongosh pipes arbitrary free-form
/// commands (`db.dropDatabase()`, `db.coll.deleteMany({})`, …) straight to
/// the driver — there is no per-command `WriteOp` to gate like every other
/// mutating `_impl`, so the only place a `read_only` connection can be kept
/// safe is here, before a shell is ever spawned. `ConfirmDestructive`
/// deliberately falls through unblocked: the shell is a deliberate
/// free-form power-user tool (the mode banner already warns the user), and
/// per-command typed confirmation is impossible for arbitrary shell input —
/// this is a documented v1 limitation, not an oversight. See
/// `write_guard::connection_mode`'s doc comment for why this reads the mode
/// directly instead of going through `guard_writable`.
pub async fn start_mongosh_session_impl(
    state: &AppState,
    connection_id: &str,
    uri: &str,
    database: &str,
    mongosh_path: &str,
    // The window asking for the session, so a start still in flight when that
    // window closes can stop the child it spawned. Empty opts out.
    window_id: &str,
) -> Result<MongoshSessionInfo, String> {
    if write_guard::connection_mode(state, connection_id)? == connections::ConnectionMode::ReadOnly
    {
        return Err(write_guard::READ_ONLY_MSG.to_string());
    }

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(connection_id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock || uri.starts_with("mongodb://mock") {
        return Err("External mongosh sessions require a real MongoDB URI".to_string());
    }

    let executable = if mongosh_path.trim().is_empty() {
        "mongosh"
    } else {
        mongosh_path.trim()
    };

    let mut child = TokioCommand::new(executable)
        .arg("--quiet")
        .arg(connections::normalize_mongodb_uri_options(uri))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start mongosh: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open mongosh stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open mongosh stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open mongosh stderr".to_string())?;
    let (sender, receiver) = mpsc::unbounded_channel();

    spawn_mongosh_reader(stdout, MongoshStream::Stdout, sender.clone());
    spawn_mongosh_reader(stderr, MongoshStream::Stderr, sender);

    let session_id = Uuid::new_v4().to_string();
    let session = Arc::new(MongoshSession {
        connection_id: connection_id.to_string(),
        stdin: AsyncMutex::new(stdin),
        output: AsyncMutex::new(receiver),
        child: AsyncMutex::new(child),
        command_lock: AsyncMutex::new(()),
    });

    {
        let mut sessions = state.mongosh_sessions.lock_safe()?;
        sessions.insert(session_id.clone(), session.clone());
    }

    // The window that asked for this may have closed while mongosh was
    // starting. Its renderer is gone, so nothing is left to cancel the start or
    // to record the id, and the tab-state cleanup that ran on close had no id
    // to stop — this child would simply survive until the app exits.
    if window_is_closed(state, window_id)? {
        let _ = stop_mongosh_session_impl(state, &session_id).await;
        return Err(format!("window {window_id} closed while mongosh was starting"));
    }

    let startup = drain_mongosh_output(&session).await;
    if !database.trim().is_empty() {
        let _ = run_mongosh_command_on_session(&session, &format!("use {}", database.trim())).await;
    }

    // Rechecked, because the two awaits above can take seconds (the `use` alone
    // has a 20s ceiling) and the window can close during them. Until this
    // function returns, the id exists nowhere the close sweep can see it, and
    // the renderer that would have handled the result is gone.
    if window_is_closed(state, window_id)? {
        let _ = stop_mongosh_session_impl(state, &session_id).await;
        return Err(format!("window {window_id} closed while mongosh was starting"));
    }

    Ok(MongoshSessionInfo {
        session_id,
        stdout: startup.stdout,
        stderr: startup.stderr,
    })
}

pub async fn run_mongosh_command_impl(
    state: &AppState,
    session_id: &str,
    command: &str,
) -> Result<MongoshCommandOutput, String> {
    let started = std::time::Instant::now();
    let session = get_mongosh_session(state, session_id)?;
    let connection_id = session.connection_id.clone();
    let result = run_mongosh_command_on_session(&session, command).await;
    crate::audit::maybe_record_result(
        state,
        Some(&connection_id),
        None,
        None,
        "run_mongosh_command",
        crate::audit::OpClass::Shell,
        Some("shell"),
        started,
        "mongosh",
        Some(command),
        &result,
    );
    result
}

/// Per-tab shell state, held backend-side so a frontend hot reload or window
/// refresh cannot lose the mapping from a tab to its running mongosh process.
///
/// Module state in the renderer did not survive either: the map came back
/// empty, the tab concluded it had no session and started a second one, and the
/// original mongosh child was orphaned with no id left to stop it. The backend
/// already owns those children, so it is the honest owner of the mapping too.
/// The payload stays opaque JSON — its shape is a frontend concern.
pub fn get_shell_tab_state_impl(
    state: &AppState,
    tab_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    Ok(state.shell_tab_state.lock_safe()?.get(tab_id).cloned())
}

/// Applies a tab-state write, returning a session id the CALLER must stop when
/// the write came from a window that has already closed — see below.
pub fn set_shell_tab_state_impl(
    state: &AppState,
    tab_id: &str,
    value: serde_json::Value,
) -> Result<Option<String>, String> {
    // The shell-state lock is taken FIRST and held across the closed-window
    // check, the ownership check and the insert. Checking whether the window
    // was closed and then inserting as two steps let a write begin just before
    // `CloseRequested`, see the window as open, and land after the sweep had
    // already run — recreating an entry for a window nothing will ever clean up
    // again. The close path marks the window closed under this same lock, so
    // the two orderings are now the only ones possible: either the write lands
    // first and the sweep collects it, or the mark lands first and the write is
    // refused here. (Lock order is shell state, then closed windows —
    // everywhere, so the pair cannot deadlock.)
    let mut map = state.shell_tab_state.lock_safe()?;
    let submitted_session = value
        .get("sessionId")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    if let Some(writer) = value.get("windowId").and_then(|w| w.as_str()) {
        if state.closed_windows.lock_safe()?.contains(writer) {
            // Refuse it — and hand back the session it names unless the stored
            // entry already accounts for that exact id. A tab commonly holds a
            // placeholder with a null or older id, so "an entry exists" is not
            // evidence that anyone is tracking the child this write describes.
            let accounted_for = map
                .get(tab_id)
                .and_then(|v| v.get("sessionId"))
                .and_then(|s| s.as_str())
                .map(|s| Some(s.to_string()) == submitted_session)
                .unwrap_or(false);
            return Ok(if accounted_for { None } else { submitted_session });
        }
    }
    let recorded_owner = map
        .get(tab_id)
        .and_then(|v| v.get("windowId"))
        .and_then(|w| w.as_str())
        .map(|w| w.to_string());
    let writer = value
        .get("windowId")
        .and_then(|w| w.as_str())
        .map(|w| w.to_string());

    // A write from a renderer that no longer owns this tab is DROPPED, not
    // merged. The mirror is fire-and-forget, so a window whose tab has moved
    // can still have one in flight; it carries a whole snapshot taken before
    // the move, and applying it would put back that window as owner and
    // overwrite whatever the new owner has since recorded — its transcript, its
    // database, even a session id that is no longer live.
    //
    // A write that names no window at all is trusted and keeps the recorded
    // owner: that is how a caller with nothing to say about ownership behaves,
    // and it must not be able to lose its own data.
    if let (Some(owner), Some(writer)) = (recorded_owner.as_deref(), writer.as_deref()) {
        if writer != owner {
            return Ok(None);
        }
    }
    let mut value = value;
    if let (Some(owner), None) = (recorded_owner, writer) {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("windowId".to_string(), serde_json::Value::String(owner));
        }
    }
    map.insert(tab_id.to_string(), value);
    Ok(None)
}

/// Forget a tab's state. Deliberately does NOT stop its mongosh session: the
/// frontend stops that explicitly, which keeps "this tab closed" and "restart
/// this session" distinguishable.
pub fn clear_shell_tab_state_impl(state: &AppState, tab_id: &str) -> Result<(), String> {
    state.shell_tab_state.lock_safe()?.remove(tab_id);
    Ok(())
}

/// Remove a tab's state and return whatever it held, under one lock.
///
/// Closing a tab has to read the session id and forget the state, and doing
/// that as two commands is a race the frontend cannot win: an inactive tab's id
/// exists only here, so a clear that overtakes the read leaves the mongosh
/// child running with nothing left pointing at it.
pub fn take_shell_tab_state_impl(
    state: &AppState,
    tab_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    Ok(state.shell_tab_state.lock_safe()?.remove(tab_id))
}

/// Take a tab's state only while `window_id` still owns it.
///
/// The close sweep enumerates a window's tabs and then takes them one by one;
/// a destination can claim a moved tab in between, and an unconditional take
/// would remove state that now belongs to the other window and stop its child.
/// Checking the owner and removing has to be the same locked operation — making
/// only the take atomic leaves the enumeration-to-take gap open.
pub fn take_shell_tab_state_if_owned(
    state: &AppState,
    tab_id: &str,
    window_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let mut map = state.shell_tab_state.lock_safe()?;
    let owned = map
        .get(tab_id)
        .and_then(|v| v.get("windowId"))
        .and_then(|w| w.as_str())
        .is_some_and(|owner| owner == window_id);
    Ok(if owned { map.remove(tab_id) } else { None })
}

/// Stamp `window_id` as the owner of a tab's state and return the CURRENT
/// value, under one lock.
///
/// The renderer that hydrates a session is the one about to display it, so it
/// has to take ownership — otherwise a moved tab's entry still names the window
/// it left, hiding the child from the new owner's close sweep. Doing that as a
/// read followed by a write would race the old renderer's final write and
/// replay a stale snapshot over it, because `set_shell_tab_state` replaces the
/// whole value. Only the owner field is touched here, and the caller caches
/// what is actually stored rather than what it fetched.
pub fn claim_shell_tab_state_impl(
    state: &AppState,
    tab_id: &str,
    window_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let mut map = state.shell_tab_state.lock_safe()?;
    let Some(value) = map.get_mut(tab_id) else {
        return Ok(None);
    };
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "windowId".to_string(),
            serde_json::Value::String(window_id.to_string()),
        );
    }
    Ok(Some(value.clone()))
}

/// Move a tab's state to a new id, for the rebind that renames a restored tab.
pub fn rename_shell_tab_state_impl(
    state: &AppState,
    old_id: &str,
    new_id: &str,
) -> Result<(), String> {
    let mut map = state.shell_tab_state.lock_safe()?;
    if let Some(value) = map.remove(old_id) {
        map.insert(new_id.to_string(), value);
    }
    Ok(())
}

/// Whether `window_id` has been closed, so work still in flight for it should
/// be abandoned rather than completed. An empty id means "no owning window
/// recorded" and is never treated as closed.
///
/// Split out from `start_mongosh_session_impl` so the decision is testable on
/// its own: the surrounding path spawns a real mongosh binary, which the mock
/// connections the suite uses cannot reach.
pub fn window_is_closed(state: &AppState, window_id: &str) -> Result<bool, String> {
    if window_id.is_empty() {
        return Ok(false);
    }
    Ok(state.closed_windows.lock_safe()?.contains(window_id))
}

/// Give up ownership of a tab, but only if `window_id` still holds it.
///
/// A renderer can start hydrating a tab and learn only afterwards that the tab
/// has moved away from it — its claim is then in flight and lands after the
/// destination's, stamping the wrong window back. It disowns itself when it
/// finds out; the tab is left with no owner, and whoever actually has it takes
/// it again on its next write. Conditional so a renderer cannot disown a tab
/// that has since been claimed by someone else.
pub fn disown_shell_tab_state_impl(
    state: &AppState,
    tab_id: &str,
    window_id: &str,
) -> Result<(), String> {
    let mut map = state.shell_tab_state.lock_safe()?;
    let Some(value) = map.get_mut(tab_id) else {
        return Ok(());
    };
    let is_ours = value
        .get("windowId")
        .and_then(|w| w.as_str())
        .is_some_and(|owner| owner == window_id);
    if is_ours {
        if let Some(obj) = value.as_object_mut() {
            obj.remove("windowId");
        }
    }
    Ok(())
}

/// The tab ids whose stored shell state was written by `window_id`.
///
/// Ownership is read from the state the renderer stamped, not from the
/// workspace's tab list: the workspace stores PROFILE-space ids while these
/// keys are LIVE-space, so a shell tab that has been rebound to a connection is
/// filed under an id the workspace never mentions.
pub fn shell_tab_ids_for_window(state: &AppState, window_id: &str) -> Result<Vec<String>, String> {
    Ok(state
        .shell_tab_state
        .lock_safe()?
        .iter()
        .filter(|(_, value)| value.get("windowId").and_then(|w| w.as_str()) == Some(window_id))
        .map(|(tab_id, _)| tab_id.clone())
        .collect())
}

pub async fn stop_mongosh_session_impl(state: &AppState, session_id: &str) -> Result<(), String> {
    let session = {
        let mut sessions = state.mongosh_sessions.lock_safe()?;
        sessions.remove(session_id)
    };

    if let Some(session) = session {
        let mut child = session.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    Ok(())
}

pub(crate) fn require_real_client(state: &AppState, id: &str) -> Result<Client, String> {
    let connections = state.connections.lock_safe()?;
    connections
        .get(id)
        .cloned()
        .ok_or_else(|| "Connection client not found".to_string())
}

pub(crate) fn connection_is_mock(state: &AppState, id: &str) -> Result<bool, String> {
    let mocks = state.mocks.lock_safe()?;
    mocks
        .get(id)
        .copied()
        .ok_or_else(|| "Connection not found".to_string())
}

// Tauri Command wrappers (kept private to module to avoid reimport collisions)
#[tauri::command]
async fn connect_db(
    state: tauri::State<'_, AppState>,
    uri: String,
    ssh: Option<ssh_tunnel::SshConfig>,
) -> Result<String, String> {
    connect_db_impl(&state, &uri, ssh.as_ref()).await
}

#[tauri::command]
async fn detect_mongo_tools(
    app_handle: tauri::AppHandle,
    configured_dir: Option<String>,
) -> Result<ToolsStatus, String> {
    use tauri::Manager;
    // app_data_dir() can fail in headless/test environments; treat that as
    // "no managed dir" rather than failing detection outright.
    let app_data_dir = app_handle.path().app_data_dir().ok();
    let managed_dir = app_data_dir
        .as_deref()
        .and_then(|dir| toolsetup::find_pinned_tool("database-tools").ok().map(|tool| toolsetup::managed_bin_dir(dir, tool)));
    Ok(db::mongotools::detect_mongo_tools(configured_dir.as_deref(), managed_dir.as_deref()))
}

/// Find a working mongosh for the shell's guided-setup card: configured path,
/// managed install, PATH, then well-known install locations. Probing spawns
/// several `--version` children, so it runs off the async runtime.
#[tauri::command]
async fn detect_mongosh_binary(
    app_handle: tauri::AppHandle,
    configured: String,
) -> Result<Option<toolsetup::MongoshDetection>, String> {
    use tauri::Manager;
    let app_data_dir = app_handle.path().app_data_dir().ok();
    tokio::task::spawn_blocking(move || {
        toolsetup::detect_mongosh(&configured, app_data_dir.as_deref(), &[])
    })
    .await
    .map_err(|e| format!("mongosh detection failed: {}", e))
}

#[tauri::command]
async fn start_dump_task(
    state: tauri::State<'_, AppState>,
    id: String,
    tool_path: String,
    options: db::mongotools::DumpOptions,
) -> Result<TaskInfo, String> {
    start_dump_task_impl(&state, &id, &tool_path, options).await
}

#[tauri::command]
async fn start_restore_task(
    state: tauri::State<'_, AppState>,
    id: String,
    tool_path: String,
    options: db::mongotools::RestoreOptions,
) -> Result<TaskInfo, String> {
    start_restore_task_impl(&state, &id, &tool_path, options).await
}

#[tauri::command]
async fn start_tool_install_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    tools: Vec<String>,
    force: bool,
) -> Result<TaskInfo, String> {
    use tauri::Manager;
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    toolsetup::start_tool_install_task_impl(&state, app_data_dir, tools, force, None).await
}

#[tauri::command]
async fn managed_tools_status(app_handle: tauri::AppHandle) -> Result<Vec<toolsetup::ManagedToolStatus>, String> {
    use tauri::Manager;
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    Ok(toolsetup::managed_tools_status(&app_data_dir))
}

#[tauri::command]
async fn browse_dump_folder(path: String) -> Result<DumpTree, String> {
    browse_dump_folder_impl(&path).await
}

#[tauri::command]
async fn preview_dump_command(
    state: tauri::State<'_, AppState>,
    id: String,
    tool_path: String,
    options: db::mongotools::DumpOptions,
) -> Result<String, String> {
    let uri = resolve_conn_uri(&state, &id)?;
    let tunneled = state.ssh_tunnels.lock_safe()?.contains_key(&id);
    let mut args = db::mongotools::build_dump_args(&options)?;
    let prepared_uri = db::mongotools::prepare_tool_uri(&uri, tunneled);
    let (prepared_uri, tls_flags) = db::mongotools::extract_unsupported_tls_params(&prepared_uri);
    args.extend(tls_flags);
    Ok(db::mongotools::preview_tool_command(
        &tool_path,
        &db::mongotools::redact_uri_password(&prepared_uri),
        &args,
    ))
}

#[tauri::command]
async fn preview_restore_command(
    state: tauri::State<'_, AppState>,
    id: String,
    tool_path: String,
    options: db::mongotools::RestoreOptions,
) -> Result<String, String> {
    let uri = resolve_conn_uri(&state, &id)?;
    let tunneled = state.ssh_tunnels.lock_safe()?.contains_key(&id);
    let mut args = db::mongotools::build_restore_args(&options)?;
    let prepared_uri = db::mongotools::prepare_tool_uri(&uri, tunneled);
    let (prepared_uri, tls_flags) = db::mongotools::extract_unsupported_tls_params(&prepared_uri);
    args.extend(tls_flags);
    Ok(db::mongotools::preview_tool_command(
        &tool_path,
        &db::mongotools::redact_uri_password(&prepared_uri),
        &args,
    ))
}

#[tauri::command]
async fn get_resource_usage(state: tauri::State<'_, AppState>) -> Result<ResourceUsage, String> {
    Ok(resource_usage_impl(&state))
}

/// The provider presets the settings form can prefill from.
///
/// Served from Rust rather than duplicated in TypeScript: the endpoints are also
/// what the request adapters build URLs from, and two copies of a base URL is one
/// copy too many.
#[tauri::command]
fn ai_provider_presets() -> Vec<serde_json::Value> {
    ai_providers::PRESETS
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "kind": p.kind,
                "baseUrl": p.base_url,
                "model": p.model,
                "command": p.command,
                "modelsCommand": p.models_command,
                "needsKey": p.needs_key,
            })
        })
        .collect()
}

/// The instructions MQLens's MCP server gives an agent.
///
/// Exposed so Settings can show and copy them: a user pointing an external client
/// (opencode, Claude Desktop, a local CLI) at MQLens gets the same guidance the
/// embedded server sends, instead of having to write a system prompt themselves.
#[tauri::command]
fn mcp_agent_instructions() -> &'static str {
    mcp::AGENT_INSTRUCTIONS
}

/// List a provider's models, refusing first to put its key on the wire in clear
/// text.
///
/// Shared by both listing commands. The check lived in one of them and not the
/// other, which is how a provider saved with a key and a non-loopback `http://`
/// endpoint still reached the network — automatically, from the chat panel, before
/// the user sent anything. A test pins the number of callers so a third cannot be
/// added without coming through here.
async fn list_models_for_provider(
    provider: &ai_providers::AiProvider,
) -> Result<Vec<String>, String> {
    match provider.kind {
        ai_providers::ProviderKind::LocalCli => ai::list_models_cli(&provider.models_command).await,
        kind => {
            // Before the request, not at Save: listing runs on its own 600 ms after
            // a key is typed, and for a saved provider on merely opening the panel,
            // so Save is far too late to be the first check.
            provider.check_transport()?;
            ai::list_models_http(
                kind,
                &provider.models_endpoint()?,
                &provider.api_key,
                &provider.name,
            )
            .await
        }
    }
}

/// The models a provider offers, for the settings form to pick from.
///
/// HTTP kinds are asked over `GET .../models` with the configured key; a CLI is
/// asked by running its `models_command`. Either way a failure is reported with
/// the provider named, and the form keeps the model field typeable, so this can
/// only ever help.
#[tauri::command]
async fn list_ai_models(provider: ai_providers::AiProvider) -> Result<Vec<String>, String> {
    list_models_for_provider(&provider).await
}

/// Check a provider's configuration without sending a prompt to it.
#[tauri::command]
fn validate_ai_provider(provider: ai_providers::AiProvider) -> Result<String, String> {
    provider.validate()?;
    match provider.kind {
        ai_providers::ProviderKind::LocalCli => Ok(provider.command.clone()),
        _ => provider.endpoint(),
    }
}

/// Marks which conversation's agent is running, and clears it however the run
/// ends.
struct RequesterGuard<'a> {
    state: &'a AppState,
    entry: Option<String>,
}

impl<'a> RequesterGuard<'a> {
    /// Records the run under the conversation that started it.
    ///
    /// Both or neither: with no conversation there is no address to put a write
    /// to, and recording the run alone would make it the single live requester
    /// while giving `confirm_write` nothing to emit. Leaving the list empty
    /// instead falls through to the unaddressed case, where any window may
    /// answer — the same place two concurrent runs land, and safe for the same
    /// reason. In practice only the panel calls this and it sends both; a
    /// frontend that sends neither simply gets unaddressed prompts.
    fn set(
        state: &'a AppState,
        requester: Option<String>,
        conversation: Option<String>,
    ) -> Self {
        let run = requester.filter(|r| !r.is_empty());
        let conversation = conversation.filter(|c| !c.is_empty());
        let entry = match (run, conversation) {
            (Some(run), Some(conversation)) => {
                if let Ok(mut live) = state.mcp_helper_requesters.lock() {
                    live.push(crate::state::HelperRun {
                        run: run.clone(),
                        conversation,
                    });
                }
                Some(run)
            }
            _ => None,
        };
        Self { state, entry }
    }
}

impl Drop for RequesterGuard<'_> {
    fn drop(&mut self) {
        // Only this run's entry. Clearing the list would strand a panel whose run
        // is still going, unable to confirm anything for the rest of its life.
        let Some(id) = self.entry.as_ref() else { return };
        // By run, not by conversation: two runs in one conversation would
        // otherwise let the first to finish retire the other's entry.
        if let Ok(mut live) = self.state.mcp_helper_requesters.lock() {
            if let Some(pos) = live.iter().position(|r| &r.run == id) {
                live.remove(pos);
            }
        }
    }
}

#[tauri::command]
async fn generate_mql_query(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    prompt: String,
    collection: String,
    fields: Vec<String>,
    // The tab's own namespace. An agent told to inspect the collection has to
    // know *which* one: two connections can hold same-named collections, and
    // sampling the wrong environment produces a query that looks right and was
    // built from someone else's data.
    database: Option<String>,
    #[allow(non_snake_case)] connectionName: Option<String>,
    // The id as well as the name: two profiles may share a display name, and the
    // MCP tools take an id, so the agent can use this one directly.
    #[allow(non_snake_case)] connectionId: Option<String>,
    // Identifies this run, so its own entry can be retired when it ends.
    #[allow(non_snake_case)] requesterId: Option<String>,
    // The conversation that asked, which is what a write its agent requests is
    // addressed to. Not the run: a tab can move to another window mid-run, and a
    // run id means nothing to the webview it moves to.
    #[allow(non_snake_case)] conversationId: Option<String>,
    #[allow(non_snake_case)] history: Option<Vec<ai::ChatTurn>>,
    target: Option<String>,
    images: Option<Vec<ai::ImageAttachment>>,
    // Per-conversation override from the panel's picker; `None` uses the
    // settings default. Only the id crosses from the frontend — the key is
    // looked up here.
    #[allow(non_snake_case)] providerId: Option<String>,
    model: Option<String>,
) -> Result<ai::AiReply, String> {
    let mut settings = {
        let key = state.require_key()?;
        connections::load_settings_encrypted(
            &connections::get_settings_enc_path(&app_handle),
            &key,
        )?
    };
    if let Some(id) = providerId.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        settings.ai_provider = id.to_string();
    }
    let model_override = model.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let images = images.unwrap_or_default();
    ai::validate_images(&images)?;

    if prompt.trim().is_empty() {
        return Err("Describe the query you want in plain language.".to_string());
    }

    let history = history.unwrap_or_default();

    // Build the system prompt once, with any user custom instructions appended.
    // The shell assistant can emit JS scripts; the editor assistant cannot.
    let base_system = if target.as_deref() == Some("shell") {
        ai::mql_shell_system_prompt(&collection, &fields)
    } else {
        ai::mql_system_prompt(&collection, &fields)
    };
    let system = ai::apply_custom_instructions(&base_system, &settings.ai_custom_instructions);

    // Gemini keeps a dedicated arm: its request and response shapes are neither
    // OpenAI's nor Anthropic's, so it is the one provider that cannot be
    // described as "an endpoint speaking a known format".
    if settings.ai_provider.trim() == "gemini" {
        let model = model_override
            .map(str::to_string)
            .unwrap_or_else(|| {
                if settings.gemini_model.trim().is_empty() {
                    "gemini-1.5-flash".to_string()
                } else {
                    settings.gemini_model.clone()
                }
            });
        return ai::generate_gemini(&settings.gemini_api_key, &model, &system, &history, &prompt, &images)
            .await;
    }

    // Everything else — the built-ins and anything the user added — is resolved
    // to one shape and dispatched on its wire format.
    let mut provider = connections::resolve_ai_provider(&settings)?;
    if let Some(m) = model_override {
        provider.model = m.to_string();
    }
    provider.validate()?;
    match provider.kind {
        ai_providers::ProviderKind::OpenAiCompatible => {
            ai::generate_openai_compatible(
                &provider.endpoint()?,
                &provider.api_key,
                &provider.model,
                &provider.name,
                &system,
                &history,
                &prompt,
                &images,
            )
            .await
        }
        ai_providers::ProviderKind::AnthropicCompatible => {
            ai::generate_anthropic_compatible(
                &provider.endpoint()?,
                &provider.api_key,
                &provider.model,
                &provider.name,
                &system,
                &history,
                &prompt,
                &images,
            )
            .await
        }
        ai_providers::ProviderKind::LocalCli => {
            if !images.is_empty() {
                // There is no standard way to hand an image to a command-line
                // agent, and silently dropping it would answer a question the
                // user did not ask.
                return Err(format!(
                    "{} is a local command and cannot receive images. Pick an HTTP provider for this question.",
                    provider.name
                ));
            }
            // Only a local agent can reach MQLens's own MCP server; an HTTP
            // provider is asked for one completion and calls nothing.
            // The helper token and path, never the ones an external client uses:
            // a write asked for on this route has to be confirmed by the user.
            let mcp = mcp::helper_access(&state).map(|(port, token)| ai::McpEndpoint {
                port,
                token,
                path: mcp::helper_path().to_string(),
            });
            // Available means *reachable by this command*, not merely running. A
            // command without {mcp_config} is handed no config, so telling its
            // agent the tools are there invites it to imply it checked something
            // it never could — which is the failure this note exists to prevent.
            // Three states. "The server is off" and "I did not hand this command a
            // config" are different facts, and a user who followed the
            // `claude mcp add` flow in Settings has an agent that reaches `mqlens`
            // without `{mcp_config}` — telling it the server is off would talk it
            // out of an inspection it could actually do.
            let reach = if mcp.is_none() {
                ai::McpReach::Off
            } else if provider.command.contains("{mcp_config}") {
                ai::McpReach::Injected
            } else {
                ai::McpReach::Unknown
            };
            let system = format!(
                "{}{}",
                system,
                ai::mcp_availability_note(
                    reach,
                    connectionName.as_deref(),
                    connectionId.as_deref(),
                    database.as_deref(),
                    &collection,
                )
            );
            let one_prompt = ai::combined_prompt(&system, &history, &prompt);
            // Set for the length of the run and cleared after, so a write arriving
            // between runs is refused rather than offered to whoever is looking.
            // A guard, not a plain assignment: an early return would otherwise
            // leave a stale panel owning confirmations it never asked for.
            let _requester =
                RequesterGuard::set(&state, requesterId.clone(), conversationId.clone());
            ai::generate_local(
                &provider.command,
                &one_prompt,
                &provider.model,
                mcp.as_ref(),
            )
            .await
        }
    }
}

/// The providers the chat panel can pick from, keys withheld.
///
/// Built-ins and user-added providers in one list, each with its kind so the
/// panel can disable image paste for a local command, and with the settings
/// default flagged so the picker starts on it.
#[tauri::command]
async fn ai_provider_options(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let settings = {
        let key = state.require_key()?;
        connections::load_settings_encrypted(&connections::get_settings_enc_path(&app_handle), &key)?
    };
    let default_id = settings.ai_provider.trim().to_string();
    // `usesModel` tells the panel whether a model choice reaches the request: an
    // HTTP provider always sends one, a local command only if its template slots
    // `{model}` in. Without it the panel would offer a model field that does
    // nothing for the built-in agents.
    // `canListModels` tells the panel whether asking for a model list can work at
    // all. Without it the composer offered a "Load models" button for a CLI with
    // no listing command — every built-in agent, whose `models_command` is always
    // empty, and any custom CLI that left the documented-optional field blank. The
    // click ran an empty command, failed, and said nothing.
    let entry = |id: &str,
                 name: &str,
                 kind: &str,
                 model: &str,
                 uses_model: bool,
                 can_list_models: bool| {
        serde_json::json!({
            "id": id, "name": name, "kind": kind, "model": model,
            "isDefault": id == default_id, "usesModel": uses_model,
            "canListModels": can_list_models
        })
    };
    let agent_uses_model = |agent: &str| {
        connections::resolve_local_command(&settings, agent).contains("{model}")
    };
    let mut out = vec![
        entry("anthropic", "Anthropic (Claude)", "anthropic-compatible", &settings.anthropic_model, true, true),
        entry("openai", "OpenAI (ChatGPT)", "openai-compatible", &settings.openai_model, true, true),
        // Gemini is listed here for selection only: `list_ai_models_for` refuses it
        // outright, so claiming otherwise would offer a button that cannot work.
        entry("gemini", "Google Gemini", "gemini", &settings.gemini_model, true, false),
    ];
    for agent in ["claude-code", "codex", "cursor", "antigravity"] {
        let label = match agent {
            "claude-code" => "Claude Code (local)",
            "codex" => "Codex (local)",
            "cursor" => "Cursor (local)",
            _ => "Antigravity (local)",
        };
        // A built-in agent's `models_command` is always empty (see
        // `resolve_ai_provider`), so listing can never work for one.
        out.push(entry(agent, label, "local-cli", "", agent_uses_model(agent), false));
    }
    for p in &settings.ai_providers {
        let kind = serde_json::to_value(p.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let uses_model = p.kind != ai_providers::ProviderKind::LocalCli || p.command.contains("{model}");
        let can_list_models = if p.kind == ai_providers::ProviderKind::LocalCli {
            !p.models_command.trim().is_empty()
        } else {
            true
        };
        out.push(entry(&p.id, &p.name, &kind, &p.model, uses_model, can_list_models));
    }
    Ok(out)
}

/// Models for a provider named by id, resolved here so the key never leaves Rust.
#[tauri::command]
async fn list_ai_models_for(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    #[allow(non_snake_case)] providerId: String,
) -> Result<Vec<String>, String> {
    let mut settings = {
        let key = state.require_key()?;
        connections::load_settings_encrypted(&connections::get_settings_enc_path(&app_handle), &key)?
    };
    if providerId.trim() == "gemini" {
        return Err("Gemini's model list is not fetched here; type a model name.".to_string());
    }
    settings.ai_provider = providerId;
    let provider = connections::resolve_ai_provider(&settings)?;
    list_models_for_provider(&provider).await
}

#[tauri::command]
async fn get_mongodb_version(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    get_mongodb_version_impl(&state, &id).await
}

#[tauri::command]
async fn start_mongosh_session(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    uri: String,
    database: String,
    mongosh_path: String,
    window_id: Option<String>,
) -> Result<MongoshSessionInfo, String> {
    use tauri::Manager;
    let app_data_dir = app_handle.path().app_data_dir().ok();
    let resolved_path = toolsetup::resolve_mongosh_executable(&mongosh_path, app_data_dir.as_deref());
    start_mongosh_session_impl(
        &state,
        &connection_id,
        &uri,
        &database,
        &resolved_path,
        window_id.as_deref().unwrap_or_default(),
    )
    .await
}

#[tauri::command]
async fn run_mongosh_command(
    state: tauri::State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<MongoshCommandOutput, String> {
    run_mongosh_command_impl(&state, &session_id, &command).await
}

#[tauri::command]
fn get_shell_tab_state(
    state: tauri::State<'_, AppState>,
    tab_id: String,
) -> Result<Option<serde_json::Value>, String> {
    get_shell_tab_state_impl(&state, &tab_id)
}

#[tauri::command]
async fn set_shell_tab_state(
    state: tauri::State<'_, AppState>,
    tab_id: String,
    value: serde_json::Value,
) -> Result<(), String> {
    if let Some(orphan) = set_shell_tab_state_impl(&state, &tab_id, value)? {
        let _ = stop_mongosh_session_impl(&state, &orphan).await;
    }
    Ok(())
}

#[tauri::command]
fn clear_shell_tab_state(state: tauri::State<'_, AppState>, tab_id: String) -> Result<(), String> {
    clear_shell_tab_state_impl(&state, &tab_id)
}

#[tauri::command]
fn claim_shell_tab_state(
    state: tauri::State<'_, AppState>,
    tab_id: String,
    window_id: String,
) -> Result<Option<serde_json::Value>, String> {
    claim_shell_tab_state_impl(&state, &tab_id, &window_id)
}

#[tauri::command]
fn disown_shell_tab_state(
    state: tauri::State<'_, AppState>,
    tab_id: String,
    window_id: String,
) -> Result<(), String> {
    disown_shell_tab_state_impl(&state, &tab_id, &window_id)
}

/// Close a tab's shell for good: take its state and stop the child it named,
/// so the read and the removal cannot be reordered against each other.
#[tauri::command]
async fn close_shell_tab_session(
    state: tauri::State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let session_id = take_shell_tab_state_impl(&state, &tab_id)?.and_then(|v| {
        v.get("sessionId")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
    });
    if let Some(session_id) = session_id {
        let _ = stop_mongosh_session_impl(&state, &session_id).await;
    }
    Ok(())
}

#[tauri::command]
fn rename_shell_tab_state(
    state: tauri::State<'_, AppState>,
    old_id: String,
    new_id: String,
) -> Result<(), String> {
    rename_shell_tab_state_impl(&state, &old_id, &new_id)
}

#[tauri::command]
async fn stop_mongosh_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    stop_mongosh_session_impl(&state, &session_id).await
}

#[tauri::command]
async fn disconnect_db(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    disconnect_db_impl(&state, &id).await?;
    let connections = connection_list_impl(&state)?;
    // Broadcast is best-effort: a window that misses this event picks up
    // current connection metadata the next time it connects or calls
    // `set_connection_meta` itself.
    let _ = app_handle.emit("connections-changed", ConnectionsChangedPayload { connections });
    Ok(())
}

/// `connection_list` command: thin wrapper over `connection_list_impl`
/// (final whole-branch review, Fix 2). Unlike `disconnect_db`/
/// `set_connection_meta`, this never broadcasts — it's a plain read, called
/// once by App.tsx's boot effect (after `workspace_get` resolves) so a
/// freshly spawned window sees every connection already live in the session
/// immediately, instead of rendering a `ReconnectBanner` for a
/// restored-but-actually-live profile and inviting a duplicate `connect_db`.
#[tauri::command]
async fn connection_list(state: tauri::State<'_, AppState>) -> Result<Vec<ConnectionEntry>, String> {
    connection_list_impl(&state)
}

#[tauri::command]
async fn set_connection_meta(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    profile_id: String,
    name: String,
    mode: connections::ConnectionMode,
) -> Result<(), String> {
    use tauri::Emitter;
    // Frontend-initiated (sidebar/Connection Manager/quick-connect) -- never
    // an MCP agent connection, which flows through `mcp_tools::connect_impl`
    // instead and passes `via_mcp: true` directly. `mode` is the profile's
    // `connection_mode` at the moment it was connected (#188) -- the
    // frontend has the profile it just connected with, so it supplies this
    // rather than the backend re-reading the (encrypted) profile store.
    // #188 security review Fix 5: this command is renderer-callable with an
    // ARBITRARY `mode` -- a hostile/compromised renderer could call it
    // directly and claim `Normal` for a connection it knows is production.
    // That's a trust edge consistent with this feature's accepted model
    // (see write_guard.rs's module doc: "an opt-in production safeguard,
    // not a security boundary against a hostile local user"), not a gap
    // introduced by this fix wave.
    set_connection_meta_impl(&state, &id, &profile_id, &name, false, mode)?;
    let connections = connection_list_impl(&state)?;
    // Broadcast is best-effort: a window that misses this event picks up
    // current connection metadata the next time it connects or calls
    // `set_connection_meta` itself.
    let _ = app_handle.emit("connections-changed", ConnectionsChangedPayload { connections });
    Ok(())
}

#[tauri::command]
async fn list_databases(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<String>, String> {
    list_databases_impl(&state, &id).await
}

#[tauri::command]
async fn list_collections(
    state: tauri::State<'_, AppState>,
    id: String,
    db: String,
) -> Result<Vec<CollectionInfo>, String> {
    list_collections_impl(&state, &id, &db).await
}

#[tauri::command]
async fn list_indexes(
    state: tauri::State<'_, AppState>,
    id: String,
    db: String,
    collection: String,
) -> Result<Vec<IndexInfo>, String> {
    list_indexes_impl(&state, &id, &db, &collection).await
}

#[tauri::command]
async fn db_stats(
    state: tauri::State<'_, AppState>,
    id: String,
    db: String,
) -> Result<db::stats::DbStatsUi, String> {
    db::stats::db_stats_impl(&state, &id, &db).await
}

#[tauri::command]
async fn coll_stats(
    state: tauri::State<'_, AppState>,
    id: String,
    db: String,
    collection: String,
) -> Result<db::stats::CollStatsUi, String> {
    db::stats::coll_stats_impl(&state, &id, &db, &collection).await
}

#[tauri::command]
async fn index_stats(
    state: tauri::State<'_, AppState>,
    id: String,
    db: String,
    collection: String,
) -> Result<Vec<db::stats::IndexStatUi>, String> {
    db::stats::index_stats_impl(&state, &id, &db, &collection).await
}

// ── Cluster monitoring ────────────────────────────────────────────────────────

#[tauri::command]
async fn server_status(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<monitoring::ServerStatus, String> {
    monitoring::server_status_impl(&state, &id).await
}

#[tauri::command]
async fn current_ops(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<monitoring::CurrentOp>, String> {
    monitoring::current_ops_impl(&state, &id).await
}

#[tauri::command]
async fn repl_set_status(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<monitoring::ReplSetStatus, String> {
    monitoring::repl_set_status_impl(&state, &id).await
}

#[tauri::command]
async fn kill_op(state: tauri::State<'_, AppState>, id: String, opid: i64) -> Result<(), String> {
    monitoring::kill_op_impl(&state, &id, opid).await
}

#[tauri::command]
async fn get_profiling_status(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
) -> Result<monitoring::ProfilingStatus, String> {
    monitoring::profiling_status_impl(&state, &id, &database).await
}

#[tauri::command]
async fn set_profiling_level(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    level: i32,
    slow_ms: i32,
) -> Result<monitoring::ProfilingStatus, String> {
    monitoring::set_profiling_level_impl(&state, &id, &database, level, slow_ms).await
}

#[tauri::command]
async fn read_profile(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    limit: i64,
) -> Result<Vec<monitoring::ProfileEntry>, String> {
    monitoring::read_profile_impl(&state, &id, &database, limit).await
}

// ── User & role management ────────────────────────────────────────────────────

#[tauri::command]
async fn list_users(
    state: tauri::State<'_, AppState>,
    id: String,
    database: Option<String>,
) -> Result<Vec<MongoUser>, String> {
    list_users_impl(&state, &id, database.as_deref()).await
}

#[tauri::command]
async fn create_user(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    username: String,
    password: String,
    roles: Vec<RoleSpec>,
) -> Result<(), String> {
    create_user_impl(&state, &id, &database, &username, &password, &roles).await
}

#[tauri::command]
async fn update_user(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    username: String,
    password: Option<String>,
    roles: Option<Vec<RoleSpec>>,
) -> Result<(), String> {
    update_user_impl(&state, &id, &database, &username, password.as_deref(), roles.as_deref()).await
}

#[tauri::command]
async fn drop_user(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    username: String,
) -> Result<(), String> {
    drop_user_impl(&state, &id, &database, &username).await
}

#[tauri::command]
async fn list_roles(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
) -> Result<Vec<RoleInfo>, String> {
    list_roles_impl(&state, &id, &database).await
}

#[tauri::command]
async fn execute_mql_query(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    sort: String,
    projection: Option<String>,
    limit: i64,
    skip: i64,
) -> Result<Vec<String>, String> {
    execute_mql_query_impl(
        &state,
        &id,
        &database,
        &collection,
        &filter,
        &sort,
        projection.as_deref().unwrap_or("{}"),
        limit,
        skip,
    )
    .await
}

#[tauri::command]
async fn count_documents(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
) -> Result<u64, String> {
    count_documents_impl(&state, &id, &database, &collection, &filter).await
}

#[tauri::command]
async fn start_collection_export(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    format: String,
    path: String,
    options: Option<crate::db::export::options::ExportOptions>,
) -> Result<TaskInfo, String> {
    start_collection_export_impl(&state, &id, &database, &collection, &format, &path, options)
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_filtered_export(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    format: String,
    path: String,
    filter: String,
    sort: String,
    projection: String,
    pipeline: String,
    skip: Option<u64>,
    limit: Option<i64>,
    options: Option<crate::db::export::options::ExportOptions>,
) -> Result<TaskInfo, String> {
    start_filtered_export_impl(
        &state,
        &id,
        &database,
        &collection,
        &format,
        &path,
        &filter,
        &sort,
        &projection,
        &pipeline,
        skip,
        limit,
        options,
    )
    .await
}

#[tauri::command]
async fn sample_export_fields(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    pipeline: String,
) -> Result<Vec<String>, String> {
    sample_export_fields_impl(&state, &id, &database, &collection, &filter, &pipeline).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn preview_export(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    format: String,
    filter: String,
    sort: String,
    projection: String,
    pipeline: String,
    options: Option<crate::db::export::options::ExportOptions>,
) -> Result<String, String> {
    preview_export_impl(
        &state,
        &id,
        &database,
        &collection,
        &format,
        &filter,
        &sort,
        &projection,
        &pipeline,
        options,
    )
    .await
}

#[tauri::command]
async fn format_current_docs(
    docs: Vec<serde_json::Value>,
    format: String,
    options: Option<crate::db::export::options::ExportOptions>,
    path: Option<String>,
) -> Result<Option<String>, String> {
    format_current_docs_impl(docs, &format, options, path).await
}

#[tauri::command]
async fn list_export_tasks(state: tauri::State<'_, AppState>) -> Result<Vec<TaskInfo>, String> {
    let mut tasks: Vec<TaskInfo> = state.tasks.lock_safe()?.values().cloned().collect();
    tasks.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(tasks)
}

#[tauri::command]
async fn clear_finished_export_tasks(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TaskInfo>, String> {
    state
        .tasks
        .lock()
        .unwrap()
        .retain(|_, task| task.status == "running");
    let mut tasks: Vec<TaskInfo> = state.tasks.lock_safe()?.values().cloned().collect();
    tasks.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(tasks)
}

#[tauri::command]
async fn cancel_task(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.cancel_or_ack(&id)
}

#[tauri::command]
async fn preflight_copy(
    state: tauri::State<'_, AppState>,
    source_id: String,
    source_db: String,
    source_collections: Vec<String>,
    targets: Vec<CopyTargetRef>,
) -> Result<db::copy::PreflightResult, String> {
    preflight_copy_impl(&state, &source_id, &source_db, source_collections, targets).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_collection_copy(
    state: tauri::State<'_, AppState>,
    source_id: String,
    source_db: String,
    source_collection: String,
    target_id: String,
    target_db: String,
    target_collection: String,
    filter: Option<String>,
    include_indexes: bool,
    conflict_mode: String,
) -> Result<TaskInfo, String> {
    start_collection_copy_impl(
        &state, &source_id, &source_db, &source_collection,
        &target_id, &target_db, &target_collection,
        filter, include_indexes, conflict_mode,
    ).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_database_copy(
    state: tauri::State<'_, AppState>,
    source_id: String,
    source_db: String,
    target_id: String,
    target_db: String,
    collections: Option<Vec<String>>,
    include_indexes: bool,
    include_views: bool,
    conflict_mode: String,
) -> Result<TaskInfo, String> {
    start_database_copy_impl(
        &state, &source_id, &source_db, &target_id, &target_db,
        collections, include_indexes, include_views, conflict_mode,
    ).await
}

#[tauri::command]
async fn execute_aggregate(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    pipeline: String,
    // `Option<bool>` (see `delete_many`'s comment): missing key -> `false`.
    // #188 review Fix 1: only matters when `pipeline` carries a $out/$merge
    // stage — see `execute_aggregate_impl`'s doc comment.
    confirmed: Option<bool>,
) -> Result<Vec<String>, String> {
    execute_aggregate_impl(&state, &id, &database, &collection, &pipeline, confirmed.unwrap_or(false)).await
}

#[tauri::command]
async fn create_collection(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
) -> Result<(), String> {
    create_collection_impl(&state, &id, &database, &collection).await
}

#[tauri::command]
async fn create_view(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    view_name: String,
    source_collection: String,
    pipeline: String,
) -> Result<(), String> {
    create_view_impl(
        &state,
        &id,
        &database,
        &view_name,
        &source_collection,
        &pipeline,
    )
    .await
}

#[tauri::command]
async fn drop_collection(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    // `Option<bool>` (see `delete_many`'s comment): missing key -> `false`.
    confirmed: Option<bool>,
) -> Result<(), String> {
    drop_collection_impl(&state, &id, &database, &collection, confirmed.unwrap_or(false)).await
}

#[tauri::command]
async fn rename_collection(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    from: String,
    to: String,
    confirmed: Option<bool>,
) -> Result<(), String> {
    rename_collection_impl(&state, &id, &database, &from, &to, confirmed.unwrap_or(false)).await
}

#[tauri::command]
async fn get_collection_options(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
) -> Result<CollectionValidation, String> {
    get_collection_options_impl(&state, &id, &database, &collection).await
}

#[tauri::command]
async fn set_validator(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    validator: String,
    validation_level: String,
    validation_action: String,
) -> Result<(), String> {
    set_validator_impl(
        &state,
        &id,
        &database,
        &collection,
        &validator,
        &validation_level,
        &validation_action,
    )
    .await
}

#[tauri::command]
async fn drop_database(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    confirmed: Option<bool>,
) -> Result<(), String> {
    drop_database_impl(&state, &id, &database, confirmed.unwrap_or(false)).await
}

#[tauri::command]
async fn rename_database(
    state: tauri::State<'_, AppState>,
    id: String,
    from: String,
    to: String,
    drop_source: bool,
    confirmed: Option<bool>,
) -> Result<DatabaseRenameResult, String> {
    rename_database_impl(&state, &id, &from, &to, drop_source, confirmed.unwrap_or(false)).await
}

#[tauri::command]
async fn explain_mql_query(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
) -> Result<String, String> {
    explain_mql_query_impl(&state, &id, &database, &collection, &filter).await
}

#[tauri::command]
async fn explain_aggregate_query(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    pipeline: String,
) -> Result<String, String> {
    explain_aggregate_query_impl(&state, &id, &database, &collection, &pipeline).await
}

#[tauri::command]
async fn analyze_schema(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    sample_size: i64,
) -> Result<String, String> {
    analyze_schema_impl(&state, &id, &database, &collection, sample_size).await
}

/// No `state` param: preview only exercises the pure template engine
/// (`parse_template` + `generate_doc`), never a connection.
#[tauri::command]
async fn preview_generated_documents(
    template: String,
    count: Option<u8>,
    seed: Option<u64>,
) -> Result<Vec<String>, String> {
    db::generate::preview_generated_documents_impl(&template, count, seed)
}

#[tauri::command]
async fn infer_generate_template(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    sample_size: Option<i64>,
) -> Result<String, String> {
    db::generate::infer_generate_template_impl(&state, &id, &database, &collection, sample_size)
        .await
}

#[tauri::command]
async fn create_index(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    index_name: String,
    keys: String,
    unique: bool,
    sparse: bool,
) -> Result<(), String> {
    create_index_impl(
        &state,
        &id,
        &database,
        &collection,
        &index_name,
        &keys,
        unique,
        sparse,
    )
    .await
}

#[tauri::command]
async fn delete_index(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    index_name: String,
) -> Result<(), String> {
    delete_index_impl(&state, &id, &database, &collection, &index_name).await
}

#[tauri::command]
async fn delete_document(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
) -> Result<u64, String> {
    delete_document_impl(&state, &id, &database, &collection, &filter).await
}

#[tauri::command]
async fn delete_many(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    // `Option<bool>` (not a raw `#[serde(default)]` attribute — Tauri's
    // per-parameter command args don't support serde field attributes,
    // only `Deserialize`-derived struct fields do; see mcp_tools.rs's
    // `_confirm` for that pattern) so an omitted key defaults to `false`
    // rather than the IPC layer rejecting the call outright.
    confirmed: Option<bool>,
) -> Result<u64, String> {
    delete_many_impl(&state, &id, &database, &collection, &filter, confirmed.unwrap_or(false)).await
}

#[tauri::command]
async fn update_many(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    update: String,
    confirmed: Option<bool>,
) -> Result<u64, String> {
    update_many_impl(&state, &id, &database, &collection, &filter, &update, confirmed.unwrap_or(false)).await
}

#[tauri::command]
async fn list_gridfs_files(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    bucket: String,
) -> Result<String, String> {
    list_gridfs_files_impl(&state, &id, &database, &bucket).await
}

#[tauri::command]
async fn download_gridfs_file(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    bucket: String,
    file_id: String,
    dest_path: String,
    total_bytes: Option<u64>,
    on_progress: tauri::ipc::Channel<GridFsTransferProgress>,
) -> Result<u64, String> {
    let emit = |update: GridFsTransferProgress| {
        let _ = on_progress.send(update);
    };
    download_gridfs_file_impl(
        &state,
        &id,
        &database,
        &bucket,
        &file_id,
        &dest_path,
        total_bytes,
        Some(&emit),
    )
    .await
}

#[tauri::command]
async fn upload_gridfs_file(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    bucket: String,
    source_path: String,
    filename: Option<String>,
    metadata_json: Option<String>,
    content_type: Option<String>,
    on_progress: tauri::ipc::Channel<GridFsTransferProgress>,
) -> Result<String, String> {
    let emit = |update: GridFsTransferProgress| {
        let _ = on_progress.send(update);
    };
    upload_gridfs_file_impl(
        &state,
        &id,
        &database,
        &bucket,
        &source_path,
        filename.as_deref(),
        metadata_json.as_deref(),
        content_type.as_deref(),
        Some(&emit),
    )
    .await
}

#[tauri::command]
async fn delete_gridfs_file(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    bucket: String,
    file_id: String,
) -> Result<(), String> {
    delete_gridfs_file_impl(&state, &id, &database, &bucket, &file_id).await
}

#[tauri::command]
async fn insert_document(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    document: String,
) -> Result<String, String> {
    insert_document_impl(&state, &id, &database, &collection, &document).await
}

#[tauri::command]
async fn preview_import(
    source: crate::db::import::ImportSourceArg,
    format: String,
    csv_options: Option<crate::db::documents::CsvImportOptions>,
    limit: Option<usize>,
) -> Result<crate::db::import::ImportPreview, String> {
    preview_import_impl(source, &format, csv_options, limit.unwrap_or(20)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_import_task(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    source: crate::db::import::ImportSourceArg,
    format: String,
    csv_options: Option<crate::db::documents::CsvImportOptions>,
    mode: String,
) -> Result<TaskInfo, String> {
    start_import_task_impl(
        &state,
        &id,
        &database,
        &collection,
        source,
        &format,
        csv_options,
        &mode,
    )
    .await
}

#[tauri::command]
async fn start_generate_task(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    template: String,
    count: u32,
    seed: Option<u64>,
) -> Result<TaskInfo, String> {
    db::generate::start_generate_task_impl(
        &state,
        &id,
        &database,
        &collection,
        &template,
        count,
        seed,
    )
    .await
}

#[tauri::command]
/// Save an edited document as a field-level update (#275).
///
/// Takes the document as it was loaded *and* as it was edited, rather than one
/// replacement: the grid may be showing a projection, and replacing the stored
/// document with a partial view deleted every field the projection left out.
#[allow(clippy::too_many_arguments)]
async fn update_document(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    original: String,
    edited: String,
    // The find projection the row came back under, so the backend knows which
    // parts of `original` are complete: `{"address": 1}` includes the whole
    // sub-document while `{"address.city": 1}` does not, and a removal has to
    // tell those apart. `None` means the shape cannot be known — the rows came
    // from an aggregation — and nothing is then assumed complete.
    projection: Option<String>,
) -> Result<u64, String> {
    update_document_impl(
        &state,
        &id,
        &database,
        &collection,
        &filter,
        &original,
        &edited,
        projection.as_deref(),
    )
    .await
}

#[tauri::command]
async fn load_connection_profiles(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<connections::ConnectionProfile>, String> {
    let key = state.require_key()?;
    connections::load_profiles_encrypted(&connections::get_profiles_enc_path(&app_handle), &key)
}

#[tauri::command]
async fn save_connection_profile(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut profile: connections::ConnectionProfile,
) -> Result<(), String> {
    let started = Instant::now();
    let profile_id = profile.id.clone();
    let profile_name = profile.name.clone();
    let result = save_connection_profile_inner(&app_handle, &state, &mut profile).await;
    audit::maybe_record_result(
        &state,
        Some(&profile_id),
        None,
        None,
        "save_connection_profile",
        audit::OpClass::Write,
        Some("ui"),
        started,
        &format!("save connection profile {profile_name}"),
        None,
        &result,
    );
    result
}

async fn save_connection_profile_inner(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    profile: &mut connections::ConnectionProfile,
) -> Result<(), String> {
    let key = state.require_key()?;
    let path = connections::get_profiles_enc_path(app_handle);
    let mut profiles = connections::load_profiles_encrypted(&path, &key)?;
    profile.uri = connections::normalize_mongodb_uri_options(&profile.uri);
    if let Some(pos) = profiles.iter().position(|p| p.id == profile.id) {
        profiles[pos] = profile.clone();
    } else {
        profiles.push(profile.clone());
    }
    connections::save_profiles_encrypted(&path, &key, &profiles)
}

#[tauri::command]
async fn delete_connection_profile(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let key = state.require_key()?;
    let path = connections::get_profiles_enc_path(&app_handle);
    let mut profiles = connections::load_profiles_encrypted(&path, &key)?;
    profiles.retain(|p| p.id != id);
    connections::save_profiles_encrypted(&path, &key, &profiles)
}

#[tauri::command]
async fn load_app_settings(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<connections::AppSettings, String> {
    let key = state.require_key()?;
    connections::load_settings_encrypted(&connections::get_settings_enc_path(&app_handle), &key)
}

/// Whether a settings change is one a chat panel's provider picker would show.
///
/// Every successful patch used to broadcast, so changing the interface language or
/// the theme made every open panel re-read its options — and the model-list effect
/// that follows sends a *credentialed* request to the selected provider. An
/// unrelated preference should not cause network traffic.
///
/// The fields `ai_provider_options` is built from, plus the built-in credentials.
///
/// The keys are not *in* the options payload, but they decide whether a picker can
/// load its model list at all: a panel whose first listing failed for want of a
/// key stayed stuck on an empty list until it remounted, however many times the
/// key was corrected. A key change is an AI-settings change, which is the line
/// this predicate is drawing — not "does the payload differ byte for byte".
fn ai_options_changed(
    before: &connections::AppSettings,
    after: &connections::AppSettings,
) -> bool {
    before.ai_provider != after.ai_provider
        || before.ai_providers != after.ai_providers
        || before.anthropic_model != after.anthropic_model
        || before.openai_model != after.openai_model
        || before.gemini_model != after.gemini_model
        || before.local_commands != after.local_commands
        || before.anthropic_api_key != after.anthropic_api_key
        || before.openai_api_key != after.openai_api_key
        || before.gemini_api_key != after.gemini_api_key
}

/// Change only the named fields, under the settings write lock.
///
/// The load → merge → save happens here, on one side of the IPC boundary and
/// inside one lock, so concurrent callers — the provider list, the locale, the
/// theme, the shell path — serialize and each sees the other's write.
#[tauri::command]
async fn patch_app_settings(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<connections::AppSettings, String> {
    let key = state.require_key()?;
    let path = connections::get_settings_enc_path(&app_handle);
    let _guard = state.settings_write.lock().map_err(|e| e.to_string())?;
    // The in-process mutex above orders this window's writers; this orders them
    // against a second MQLens, which would otherwise merge into the same image
    // and have one patch discarded by the other's rename.
    let _file_lock = connections::lock_settings_for_write(&path)?;
    let current = connections::load_settings_encrypted(&path, &key)?;
    let merged = connections::merge_settings_patch(&current, &patch)?;
    connections::save_settings_encrypted(&path, &key, &merged)?;
    audit::refresh_policy_from_settings(&state, &merged);
    // Every window keeps its own copy of the provider list; without this, a panel
    // in another pane or window holds a stale one, and deleting the provider it
    // has selected leaves that id selectable until the panel remounts.
    // Best-effort, like `connections-changed`: a window that misses it re-reads
    // the list on its next mount. Only when the picker would actually differ —
    // see `ai_options_changed`.
    if ai_options_changed(&current, &merged) {
        use tauri::Emitter;
        let _ = app_handle.emit("ai-providers-changed", ());
    }
    Ok(merged)
}

#[tauri::command]
async fn save_app_settings(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings: connections::AppSettings,
) -> Result<(), String> {
    let key = state.require_key()?;
    // Same locks as `patch_app_settings`, so a whole-object save cannot
    // interleave with a field patch — in this process or another one.
    let _guard = state.settings_write.lock().map_err(|e| e.to_string())?;
    let settings_path = connections::get_settings_enc_path(&app_handle);
    let _file_lock = connections::lock_settings_for_write(&settings_path)?;
    // Read first, under the same locks, only to answer "would the pickers differ".
    let before = connections::load_settings_encrypted(&settings_path, &key).ok();
    connections::save_settings_encrypted(
        &settings_path,
        &key,
        &settings,
    )?;
    audit::refresh_policy_from_settings(&state, &settings);
    // Best-effort, like `connections-changed`: a window that misses it re-reads
    // the list on its next mount. Only when the picker would actually differ —
    // and when the previous image could not be read, assume it would, since a
    // stale picker is worse than one needless refresh.
    if before.as_ref().is_none_or(|b| ai_options_changed(b, &settings)) {
        use tauri::Emitter;
        let _ = app_handle.emit("ai-providers-changed", ());
    }

    Ok(())
}

#[tauri::command]
async fn vault_status(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<connections::VaultStatus, String> {
    let unlocked = state.vault_key.lock_safe()?.is_some();
    if unlocked {
        return Ok(connections::VaultStatus::Unlocked);
    }
    let meta_path = connections::get_vault_meta_path(&app_handle);
    match connections::read_vault_meta(&meta_path)? {
        Some(_) => Ok(connections::VaultStatus::Locked),
        None => Ok(connections::VaultStatus::Uninitialized),
    }
}

#[tauri::command]
async fn vault_initialize(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    password: String,
) -> Result<(), String> {
    let meta_path = connections::get_vault_meta_path(&app_handle);
    if connections::read_vault_meta(&meta_path)?.is_some() {
        return Err("vault already initialized".to_string());
    }
    if password.is_empty() {
        return Err("master password must not be empty".to_string());
    }
    let params = crate::vault::KdfParams::default();
    let meta = connections::build_vault_meta(&password, params)?;
    let key = connections::unlock_key(&meta, &password)?;
    connections::write_vault_meta(&meta_path, &meta)?;

    // Migrate any legacy plaintext files into the new encrypted vault.
    connections::migrate_plaintext_to_encrypted(
        &key,
        &connections::get_config_path(&app_handle),
        &connections::get_profiles_enc_path(&app_handle),
        &connections::get_settings_path(&app_handle),
        &connections::get_settings_enc_path(&app_handle),
    )?;

    *state.vault_key.lock_safe()? = Some(key);
    let _ = audit::open_on_unlock(&app_handle, &state, key);
    Ok(())
}

#[tauri::command]
async fn vault_unlock(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    password: String,
) -> Result<connections::VaultStatus, String> {
    let meta_path = connections::get_vault_meta_path(&app_handle);
    let meta = connections::read_vault_meta(&meta_path)?
        .ok_or_else(|| "vault is not initialized".to_string())?;
    let key = connections::unlock_key(&meta, &password)?;
    *state.vault_key.lock_safe()? = Some(key);
    let _ = audit::open_on_unlock(&app_handle, &state, key);
    Ok(connections::VaultStatus::Unlocked)
}

#[tauri::command]
async fn vault_lock(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _ = audit::close_on_lock(&state);
    *state.vault_key.lock_safe()? = None;
    // A locked vault must never leave the embedded MCP server listening —
    // it reads through `require_key`-gated seams, same precondition as
    // enabling it in the first place.
    mcp::stop_if_running(&state).await?;
    Ok(())
}

#[tauri::command]
async fn vault_reset(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Before any core vault file is removed: if the audit log cannot be deleted,
    // a replacement vault would start with a log its new key cannot authenticate,
    // so auditing would be sealed from the first unlock. Abort instead.
    audit::reset_store(&app_handle, &state)?;
    for p in [
        connections::get_vault_meta_path(&app_handle),
        connections::get_profiles_enc_path(&app_handle),
        connections::get_settings_enc_path(&app_handle),
    ] {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("remove {}: {e}", p.display()))?;
        }
    }
    *state.vault_key.lock_safe()? = None;
    // Same precondition as `vault_lock`: no key means no MCP server.
    mcp::stop_if_running(&state).await?;
    // A reset invalidates the old key; forget any biometric copy too.
    let _ = biometric::remove_stored_key(&app_handle);
    Ok(())
}

#[tauri::command]
async fn vault_change_password(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.is_empty() {
        return Err("new master password must not be empty".to_string());
    }
    let meta_path = connections::get_vault_meta_path(&app_handle);
    let meta = connections::read_vault_meta(&meta_path)?
        .ok_or_else(|| "vault is not initialized".to_string())?;
    let old_key = connections::unlock_key(&meta, &old_password)?;

    let params = crate::vault::KdfParams::default();
    let new_meta = connections::build_vault_meta(&new_password, params)?;
    let new_key = connections::unlock_key(&new_meta, &new_password)?;

    let profiles_path = connections::get_profiles_enc_path(&app_handle);
    let settings_path = connections::get_settings_enc_path(&app_handle);
    let audit_log_path = connections::get_audit_log_path(&app_handle);

    // Close the audit session so the log is not being appended to while it is
    // re-encrypted, but keep its cross-process lock: releasing it would let a
    // second instance take the log and append under the old key mid-rotation.
    // Everything fallible after this point runs inside `rotate`, so a failure
    // can reopen the session instead of leaving the app running unaudited.
    //
    // Taken even when there is no session to suspend. `rotate` rewrites the log
    // and its state sidecar either way, and without the lock an instance that
    // *does* own the log keeps appending under the old key while its next state
    // write lands on top of the rotated sidecar — leaving history that
    // authenticates against neither password. If the lock cannot be taken the
    // whole change aborts here, before any vault file is touched.
    let audit_guard = audit::hold_for_rotation(&app_handle, &state)?;

    let rotate = || -> Result<(), String> {
        // Prepare every re-encrypted payload before overwriting any vault file:
        // a failure here must not leave the files and the metadata disagreeing.
        let new_profiles =
            connections::prepare_reencrypt_file(&old_key, &new_key, &profiles_path)?;
        let new_settings =
            connections::prepare_reencrypt_file(&old_key, &new_key, &settings_path)?;
        // Returns the log *and* its state sidecar; both are keyed and must land
        // together or the new-key log would be checked against an old-key count.
        let new_audit_files =
            connections::prepare_reencrypt_audit_log(&old_key, &new_key, &audit_log_path)?;

        // Commit all four files together: a partial rotation leaves data under
        // the new key while the metadata still derives the old one, which no
        // password can then open.
        let mut files = vec![
            (profiles_path.clone(), new_profiles),
            (settings_path.clone(), new_settings),
        ];
        files.extend(new_audit_files.into_iter().map(|(p, b)| (p, Some(b))));
        connections::commit_vault_rotation(files, &meta_path, &new_meta)
    };

    let rotated = rotate();
    // Reopen with the retained lock either way — on failure under `old_key`,
    // which is still the live vault key because it is only swapped below.
    let reopen_key = if rotated.is_ok() { new_key } else { old_key };
    match audit_guard {
        // There was a session: hand the same lock back so it never leaves this
        // instance's hands.
        audit::AuditRotationGuard::Session(lock) => {
            let _ = audit::resume_after_rotation(&app_handle, &state, reopen_key, lock);
        }
        // There was none: release the lock first, then let the settings decide
        // whether auditing opens — the same path as any other unlock.
        audit::AuditRotationGuard::LockOnly(lock) => {
            drop(lock);
            let _ = audit::open_on_unlock(&app_handle, &state, reopen_key);
        }
    }
    rotated?;

    *state.vault_key.lock_safe()? = Some(new_key);
    // Approach A: a password change derives a new key; keep biometrics working transparently.
    biometric::restore_key_if_enrolled(&app_handle, &new_key);
    Ok(())
}

#[tauri::command]
async fn audit_list(
    state: tauri::State<'_, AppState>,
    filter: audit::AuditFilter,
) -> Result<Vec<audit::AuditEvent>, String> {
    let guard = state.audit.lock_safe()?;
    match guard.as_ref() {
        Some(session) => session.query(&filter),
        None => Err("vault is locked".into()),
    }
}

#[tauri::command]
async fn audit_export(
    state: tauri::State<'_, AppState>,
    filter: audit::AuditFilter,
    path: String,
) -> Result<u64, String> {
    use std::io::Write;
    let events = {
        let guard = state.audit.lock_safe()?;
        match guard.as_ref() {
            Some(session) => session.query(&filter)?,
            None => return Err("vault is locked".into()),
        }
    };
    let mut file = std::fs::File::create(&path).map_err(|e| format!("create {path}: {e}"))?;
    for ev in &events {
        let line = serde_json::to_string(ev).map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| format!("write {path}: {e}"))?;
    }
    Ok(events.len() as u64)
}

#[tauri::command]
async fn audit_open_folder(app_handle: tauri::AppHandle) -> Result<(), String> {
    let path = connections::get_audit_log_path(&app_handle);
    let dir = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| path.clone());
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())?;
    Ok(())
}

/// Discard a log that failed verification, so recording can resume (#272).
///
/// There is deliberately no command to clear an intact log: retention is the
/// only thing that removes events. See `AuditSession::discard_damaged_log`.
#[tauri::command]
async fn audit_discard_damaged_log(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    let guard = state.audit.lock_safe()?;
    match guard.as_ref() {
        Some(session) => session.discard_damaged_log(),
        None => Err("vault is locked".into()),
    }
}

#[tauri::command]
async fn audit_reset(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let key = state.require_key()?;
    audit::reset_store(&app_handle, &state)?;
    audit::open_on_unlock(&app_handle, &state, key)?;
    Ok(())
}

#[tauri::command]
async fn audit_dropped_count(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    let guard = state.audit.lock_safe()?;
    Ok(guard.as_ref().map(|s| s.dropped_count()).unwrap_or(0))
}

/// Whether auditing is actually recording, and why not when it isn't (#272).
///
/// A corrupt or unreadable `audit.log.enc` leaves the vault unlocked and the app
/// fully usable but unaudited; the UI needs to say so rather than let the user
/// assume destructive operations are being logged.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditStatusUi {
    active: bool,
    degraded_reason: Option<String>,
    /// Set when the on-disk log failed verification: recording has stopped and
    /// the file is being preserved as evidence.
    integrity_error: Option<String>,
    dropped_count: u64,
}

#[tauri::command]
async fn audit_status(state: tauri::State<'_, AppState>) -> Result<AuditStatusUi, String> {
    let guard = state.audit.lock_safe()?;
    let session = guard.as_ref();
    let integrity_error = session.and_then(|s| s.integrity_error());
    Ok(AuditStatusUi {
        // A sealed log is open for reading but no longer recording, so it must
        // not report itself as active auditing.
        active: session.is_some_and(|s| s.is_open()) && integrity_error.is_none(),
        degraded_reason: audit::degraded_reason(&state),
        integrity_error,
        dropped_count: session.map(|s| s.dropped_count()).unwrap_or(0),
    })
}

/// Thin wrappers over `mcp.rs`'s testable impl fns (the established
/// impl/wrapper split — see `set_connection_meta_impl`'s doc comment above)
/// so the lifecycle logic itself never touches a `tauri::State` and can be
/// unit-tested with a plain `AppState`.
#[tauri::command]
async fn mcp_get_status(state: tauri::State<'_, AppState>) -> Result<mcp::McpStatusUi, String> {
    mcp::get_status_impl(&state)
}

#[tauri::command]
async fn mcp_set_enabled(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
    port: Option<u16>,
) -> Result<mcp::McpStatusUi, String> {
    mcp::set_enabled_impl(&state, enabled, port, Some(app_handle)).await
}

/// The user's answer to a write MQLens's own agent asked to make.
#[tauri::command]
async fn mcp_resolve_write(
    state: tauri::State<'_, AppState>,
    id: String,
    approved: bool,
) -> Result<(), String> {
    mcp::resolve_write_impl(&state, &id, approved)
}

#[tauri::command]
async fn mcp_regenerate_token(state: tauri::State<'_, AppState>) -> Result<mcp::McpStatusUi, String> {
    mcp::regenerate_token_impl(&state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Resolve the user's real shell PATH before anything spawns child processes,
    // so the packaged app finds CLI tools (claude, codex, mongosh, …) like the
    // terminal does. Must run here on the main thread before worker threads start.
    path_env::ensure_user_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_biometry::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                // First launch (before the window-state plugin has saved anything):
                // size the window to ~85% of the current monitor and center it.
                let first_run = app
                    .path()
                    .app_config_dir()
                    .map(|d| !d.join(".window-state.json").exists())
                    .unwrap_or(true);
                if first_run {
                    if let Ok(Some(monitor)) = win.current_monitor() {
                        let (w, h) = target_window_size(
                            monitor.size().width,
                            monitor.size().height,
                            monitor.scale_factor(),
                        );
                        let _ = win.set_size(tauri::LogicalSize::new(w, h));
                        let _ = win.center();
                    }
                }
            }
            // Final whole-branch review, Fix 1 (CRITICAL): closing "main"
            // must quit the app even with a secondary `win-*` window open —
            // see `windows::wire_main_window_exit`'s doc comment for why the
            // runtime's default `ExitRequested`-on-last-window-close
            // behavior is no longer sufficient once multi-window exists.
            windows::wire_main_window_exit(app.handle());
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connect_db,
            detect_mongo_tools,
            detect_mongosh_binary,
            start_dump_task,
            start_restore_task,
            start_tool_install_task,
            managed_tools_status,
            browse_dump_folder,
            preview_dump_command,
            preview_restore_command,
            get_resource_usage,
            generate_mql_query,
            ai_provider_presets,
            mcp_agent_instructions,
            validate_ai_provider,
            list_ai_models,
            ai_provider_options,
            list_ai_models_for,
            detect_local_agents,
            get_mongodb_version,
            start_mongosh_session,
            run_mongosh_command,
            stop_mongosh_session,
            get_shell_tab_state,
            set_shell_tab_state,
            clear_shell_tab_state,
            claim_shell_tab_state,
            disown_shell_tab_state,
            close_shell_tab_session,
            rename_shell_tab_state,
            disconnect_db,
            set_connection_meta,
            connection_list,
            list_databases,
            list_collections,
            list_indexes,
            db_stats,
            coll_stats,
            index_stats,
            create_index,
            delete_index,
            delete_document,
            delete_many,
            update_many,
            list_gridfs_files,
            download_gridfs_file,
            upload_gridfs_file,
            delete_gridfs_file,
            insert_document,
            preview_import,
            start_import_task,
            update_document,
            execute_mql_query,
            execute_aggregate,
            count_documents,
            start_collection_export,
            start_filtered_export,
            sample_export_fields,
            preview_export,
            format_current_docs,
            list_export_tasks,
            clear_finished_export_tasks,
            cancel_task,
            preflight_copy,
            start_collection_copy,
            start_database_copy,
            create_collection,
            create_view,
            drop_collection,
            rename_collection,
            get_collection_options,
            set_validator,
            drop_database,
            rename_database,
            explain_mql_query,
            explain_aggregate_query,
            analyze_schema,
            preview_generated_documents,
            infer_generate_template,
            start_generate_task,
            vault_status,
            vault_initialize,
            vault_unlock,
            vault_lock,
            vault_reset,
            vault_change_password,
            mcp_get_status,
            mcp_set_enabled,
            mcp_regenerate_token,
            mcp_resolve_write,
            biometric::biometric_status,
            biometric::biometric_enable,
            biometric::biometric_unlock,
            biometric::biometric_disable,
            load_connection_profiles,
            save_connection_profile,
            delete_connection_profile,
            connections::test_connection_uri,
            load_app_settings,
            save_app_settings,
            patch_app_settings,
            audit_list,
            audit_export,
            audit_open_folder,
            audit_discard_damaged_log,
            audit_reset,
            audit_dropped_count,
            audit_status,
            connections::test_mongosh_path,
            change_streams::start_change_stream,
            change_streams::poll_change_stream,
            change_streams::describe_change_stream,
            change_streams::pause_change_stream,
            change_streams::resume_change_stream,
            change_streams::stop_change_stream,
            chats::list_chats,
            chats::claim_chat,
            chats::release_chat,
            chats::release_owner_chats,
            chats::load_chat,
            chats::save_chat,
            chats::append_chat_message,
            chats::retarget_chat_scope,
            chats::delete_chat,
            chats::clear_chats,
            queries::load_collection_queries,
            queries::save_query,
            queries::delete_saved_query,
            queries::record_history,
            queries::set_default_query,
            queries::list_all_saved_queries,
            workspace::workspace_get,
            workspace::workspace_apply,
            windows::workspace_detach_tab,
            windows::spawn_saved_windows,
            windows::focus_window,
            windows::close_workspace_window,
            server_status,
            current_ops,
            repl_set_status,
            kill_op,
            list_users,
            create_user,
            update_user,
            drop_user,
            list_roles,
            get_profiling_status,
            set_profiling_level,
            read_profile,
            updater::update_check,
            updater::update_install
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            use tauri::Manager;
            // `AppHandle::exit` ends in process teardown that may skip Drop.
            // Seal on both exit events so the in-memory store reaches disk.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let _ = audit::close_on_lock(&state);
                }
            }
        });
}
