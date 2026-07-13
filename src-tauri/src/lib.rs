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
pub mod connections;
mod db;
pub(crate) mod mock_db;
pub mod monitoring;
pub mod path_env;
pub mod queries;
pub mod ssh_tunnel;
mod state;
pub mod toolsetup;
pub mod updater;
mod vault;
mod window;
pub mod biometric;
pub use db::aggregate::{execute_aggregate_impl, explain_aggregate_query_impl};
pub use db::ddl::{
    create_collection_impl, create_view_impl, drop_collection_impl, drop_database_impl,
    rename_collection_impl, rename_database_impl, DatabaseRenameResult,
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
pub use state::{AppState, LockExt};
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

    Ok(())
}

pub async fn start_mongosh_session_impl(
    state: &AppState,
    connection_id: &str,
    uri: &str,
    database: &str,
    mongosh_path: &str,
) -> Result<MongoshSessionInfo, String> {
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

    let startup = drain_mongosh_output(&session).await;
    if !database.trim().is_empty() {
        let _ = run_mongosh_command_on_session(&session, &format!("use {}", database.trim())).await;
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
    let session = get_mongosh_session(state, session_id)?;
    run_mongosh_command_on_session(&session, command).await
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

#[tauri::command]
async fn generate_mql_query(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    prompt: String,
    collection: String,
    fields: Vec<String>,
    #[allow(non_snake_case)] history: Option<Vec<ai::ChatTurn>>,
    target: Option<String>,
) -> Result<String, String> {
    let settings = {
        let key = state.require_key()?;
        connections::load_settings_encrypted(
            &connections::get_settings_enc_path(&app_handle),
            &key,
        )?
    };

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

    match settings.ai_provider.as_str() {
        "anthropic" => {
            let model = if settings.anthropic_model.trim().is_empty() {
                "claude-opus-4-8".to_string()
            } else {
                settings.anthropic_model.clone()
            };
            ai::generate_anthropic(
                &settings.anthropic_api_key,
                &model,
                &system,
                &history,
                &prompt,
            )
            .await
        }
        "openai" => {
            let model = if settings.openai_model.trim().is_empty() {
                "gpt-4o".to_string()
            } else {
                settings.openai_model.clone()
            };
            ai::generate_openai(&settings.openai_api_key, &model, &system, &history, &prompt).await
        }
        "gemini" => {
            let model = if settings.gemini_model.trim().is_empty() {
                "gemini-1.5-flash".to_string()
            } else {
                settings.gemini_model.clone()
            };
            ai::generate_gemini(&settings.gemini_api_key, &model, &system, &history, &prompt).await
        }
        agent @ ("claude-code" | "codex" | "cursor" | "antigravity") => {
            let template = connections::resolve_local_command(&settings, agent);
            let one_prompt = ai::combined_prompt(&system, &history, &prompt);
            ai::generate_local(&template, &one_prompt).await
        }
        other => Err(format!("Unknown AI provider: {}", other)),
    }
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
) -> Result<MongoshSessionInfo, String> {
    use tauri::Manager;
    let app_data_dir = app_handle.path().app_data_dir().ok();
    let resolved_path = toolsetup::resolve_mongosh_executable(&mongosh_path, app_data_dir.as_deref());
    start_mongosh_session_impl(&state, &connection_id, &uri, &database, &resolved_path).await
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
async fn stop_mongosh_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    stop_mongosh_session_impl(&state, &session_id).await
}

#[tauri::command]
async fn disconnect_db(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    disconnect_db_impl(&state, &id).await
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
) -> Result<Vec<String>, String> {
    execute_aggregate_impl(&state, &id, &database, &collection, &pipeline).await
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
) -> Result<(), String> {
    drop_collection_impl(&state, &id, &database, &collection).await
}

#[tauri::command]
async fn rename_collection(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    from: String,
    to: String,
) -> Result<(), String> {
    rename_collection_impl(&state, &id, &database, &from, &to).await
}

#[tauri::command]
async fn drop_database(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
) -> Result<(), String> {
    drop_database_impl(&state, &id, &database).await
}

#[tauri::command]
async fn rename_database(
    state: tauri::State<'_, AppState>,
    id: String,
    from: String,
    to: String,
    drop_source: bool,
) -> Result<DatabaseRenameResult, String> {
    rename_database_impl(&state, &id, &from, &to, drop_source).await
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
) -> Result<u64, String> {
    delete_many_impl(&state, &id, &database, &collection, &filter).await
}

#[tauri::command]
async fn update_many(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    update: String,
) -> Result<u64, String> {
    update_many_impl(&state, &id, &database, &collection, &filter, &update).await
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
async fn update_document(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    replacement: String,
) -> Result<u64, String> {
    update_document_impl(&state, &id, &database, &collection, &filter, &replacement).await
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
    let key = state.require_key()?;
    let path = connections::get_profiles_enc_path(&app_handle);
    let mut profiles = connections::load_profiles_encrypted(&path, &key)?;
    profile.uri = connections::normalize_mongodb_uri_options(&profile.uri);
    if let Some(pos) = profiles.iter().position(|p| p.id == profile.id) {
        profiles[pos] = profile;
    } else {
        profiles.push(profile);
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

#[tauri::command]
async fn save_app_settings(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings: connections::AppSettings,
) -> Result<(), String> {
    let key = state.require_key()?;
    connections::save_settings_encrypted(
        &connections::get_settings_enc_path(&app_handle),
        &key,
        &settings,
    )
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
    Ok(connections::VaultStatus::Unlocked)
}

#[tauri::command]
async fn vault_lock(state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.vault_key.lock_safe()? = None;
    Ok(())
}

#[tauri::command]
async fn vault_reset(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
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

    connections::reencrypt_data_files(
        &old_key,
        &new_key,
        &connections::get_profiles_enc_path(&app_handle),
        &connections::get_settings_enc_path(&app_handle),
    )?;
    connections::write_vault_meta(&meta_path, &new_meta)?;
    *state.vault_key.lock_safe()? = Some(new_key);
    // Approach A: a password change derives a new key; keep biometrics working transparently.
    biometric::restore_key_if_enrolled(&app_handle, &new_key);
    Ok(())
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
            detect_local_agents,
            get_mongodb_version,
            start_mongosh_session,
            run_mongosh_command,
            stop_mongosh_session,
            disconnect_db,
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
            drop_database,
            rename_database,
            explain_mql_query,
            explain_aggregate_query,
            analyze_schema,
            vault_status,
            vault_initialize,
            vault_unlock,
            vault_lock,
            vault_reset,
            vault_change_password,
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
            connections::test_mongosh_path,
            queries::load_collection_queries,
            queries::save_query,
            queries::delete_saved_query,
            queries::record_history,
            queries::set_default_query,
            queries::list_all_saved_queries,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
