use mongodb::{options::ClientOptions, Client};
use serde::Serialize;
use serde_json;
use std::collections::{BTreeSet, HashMap};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use uuid::Uuid;

pub mod ai;
pub mod connections;
mod mock_db;
pub mod queries;
pub mod ssh_tunnel;
mod vault;
mod window;
pub use window::target_window_size;
#[cfg(test)]
mod tests;

/// Lock a std mutex, mapping a poisoned lock to an error instead of panicking.
trait LockExt<T> {
    fn lock_safe(&self) -> Result<std::sync::MutexGuard<'_, T>, String>;
}
impl<T> LockExt<T> for std::sync::Mutex<T> {
    fn lock_safe(&self) -> Result<std::sync::MutexGuard<'_, T>, String> {
        self.lock().map_err(|_| "internal state lock poisoned".to_string())
    }
}

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
            vault_key: Mutex::new(None),
        }
    }

    /// The in-memory vault key, or an error if the vault is locked.
    pub fn require_key(&self) -> Result<[u8; 32], String> {
        self.vault_key.lock_safe()?.ok_or_else(|| "vault is locked".to_string())
    }
}

/// Sample this process's CPU% and resident memory. CPU is a delta since the
/// previous sample, so the first call after startup typically reports 0.
pub fn resource_usage_impl(state: &AppState) -> ResourceUsage {
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
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    match sys.process(pid) {
        Some(proc_) => ResourceUsage {
            cpu_percent: proc_.cpu_usage(),
            memory_bytes: proc_.memory(),
        },
        None => ResourceUsage {
            cpu_percent: 0.0,
            memory_bytes: 0,
        },
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

#[derive(Serialize, Clone)]
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
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn update_task<F>(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, update: F)
where
    F: FnOnce(&mut TaskInfo),
{
    if let Some(task) = tasks.lock().unwrap_or_else(|p| p.into_inner()).get_mut(task_id) {
        update(task);
    }
}

fn fail_task(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, err: String) {
    update_task(tasks, task_id, |task| {
        task.status = "failed".to_string();
        task.message = "Export failed".to_string();
        task.error = Some(err);
        task.finished_at_ms = Some(now_ms());
    });
}

fn finish_task(tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>, task_id: &str, processed: u64) {
    update_task(tasks, task_id, |task| {
        task.status = "completed".to_string();
        task.processed = processed;
        task.message = "Export complete".to_string();
        task.finished_at_ms = Some(now_ms());
    });
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
                MongoshStream::Stdout => stdout.push(line.text),
                MongoshStream::Stderr => stderr.push(line.text),
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
                    MongoshStream::Stdout => stdout.push(line.text),
                    MongoshStream::Stderr => stderr.push(line.text),
                }
            }
            Ok(None) => return Err("mongosh session closed".to_string()),
            Err(_) => return Err("mongosh command timed out".to_string()),
        }
    }

    Ok(MongoshCommandOutput { stdout, stderr })
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
    if let Some(t) = tunnel {
        let mut tunnels = state.ssh_tunnels.lock_safe()?;
        tunnels.insert(connection_id.clone(), t);
    }

    Ok(connection_id)
}

pub async fn get_mongodb_version_impl(state: &AppState, id: &str) -> Result<String, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok("7.0.5".to_string());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let db = client.database("admin");
    let result = db
        .run_command(mongodb::bson::doc! { "buildInfo": 1 })
        .await
        .map_err(|e| format!("Failed to read MongoDB version: {}", e))?;

    result
        .get_str("version")
        .map(|version| version.to_string())
        .map_err(|e| format!("MongoDB version missing: {}", e))
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

pub async fn list_databases_impl(state: &AppState, id: &str) -> Result<Vec<String>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok(vec![
            "admin".to_string(),
            "config".to_string(),
            "local".to_string(),
            "sales_db".to_string(),
            "user_analytics".to_string(),
        ]);
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let dbs = client
        .list_database_names()
        .await
        .map_err(|e| format!("Failed to list databases: {}", e))?;

    Ok(dbs)
}

pub async fn list_collections_impl(
    state: &AppState,
    id: &str,
    db: &str,
) -> Result<Vec<CollectionInfo>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok(mock_db::get_mock_collections(db)
            .into_iter()
            .map(|name| CollectionInfo {
                name,
                collection_type: "collection".to_string(),
            })
            .collect());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let database = client.database(db);
    // Use list_collections (not list_collection_names) so we can read each
    // collection's type and let the UI separate Collections / Views / etc.
    let mut cursor = database
        .list_collections()
        .await
        .map_err(|e| format!("Failed to list collections: {}", e))?;

    let mut collections = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let spec = result.map_err(|e| format!("Collection read error: {}", e))?;
        let collection_type = match spec.collection_type {
            mongodb::results::CollectionType::View => "view",
            mongodb::results::CollectionType::Timeseries => "timeseries",
            _ => "collection",
        };
        collections.push(CollectionInfo {
            name: spec.name,
            collection_type: collection_type.to_string(),
        });
    }

    Ok(collections)
}

pub async fn list_indexes_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
) -> Result<Vec<IndexInfo>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        return Ok(mock_indexes.get(&key).unwrap().clone());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    let mut cursor = coll
        .list_indexes()
        .await
        .map_err(|e| format!("Failed to list indexes: {}", e))?;

    let mut indexes = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let index_model = result.map_err(|e| format!("Index read error: {}", e))?;
        // Serialize the real key pattern (preserves field order + direction/type).
        let keys = serde_json::to_string(&index_model.keys).unwrap_or_else(|_| "{}".to_string());
        let name = index_model
            .options
            .as_ref()
            .and_then(|o| o.name.clone())
            .unwrap_or_default();
        let unique = index_model
            .options
            .as_ref()
            .and_then(|o| o.unique)
            .unwrap_or(false);
        let sparse = index_model
            .options
            .as_ref()
            .and_then(|o| o.sparse)
            .unwrap_or(false);
        indexes.push(IndexInfo {
            name,
            keys,
            unique,
            sparse,
        });
    }

    Ok(indexes)
}

pub async fn execute_mql_query_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    sort: &str,
    projection: &str,
    limit: i64,
    skip: i64,
) -> Result<Vec<String>, String> {
    // Validate projection JSON up front (applies on the real path; mock ignores fields).
    let projection_doc: Option<mongodb::bson::Document> =
        if projection.trim().is_empty() || projection.trim() == "{}" {
            None
        } else {
            let val: serde_json::Value = serde_json::from_str(projection)
                .map_err(|e| format!("Invalid MQL projection JSON: {}", e))?;
            Some(
                mongodb::bson::to_document(&val)
                    .map_err(|e| format!("BSON conversion error: {}", e))?,
            )
        };

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return mock_db::execute_mock_query(database, collection, filter, sort, limit, skip);
    }

    let filter_val: serde_json::Value = if filter.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(filter).map_err(|e| format!("Invalid MQL filter JSON: {}", e))?
    };

    let sort_val: serde_json::Value = if sort.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(sort).map_err(|e| format!("Invalid MQL sort JSON: {}", e))?
    };

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let db = client.database(database);
    let coll = db.collection::<mongodb::bson::Document>(collection);

    // Convert filter serde_json::Value to BSON Document
    let filter_doc = mongodb::bson::to_document(&filter_val)
        .map_err(|e| format!("BSON conversion error: {}", e))?;

    // Convert sort serde_json::Value to BSON Document
    let sort_doc: Option<mongodb::bson::Document> =
        if sort_val.is_object() && !sort_val.as_object().unwrap().is_empty() {
            let doc = mongodb::bson::to_document(&sort_val)
                .map_err(|e| format!("BSON conversion error: {}", e))?;
            Some(doc)
        } else {
            None
        };

    let mut find_builder = coll.find(filter_doc);
    if let Some(sort) = sort_doc {
        find_builder = find_builder.sort(sort);
    }
    if let Some(projection) = projection_doc {
        find_builder = find_builder.projection(projection);
    }
    if limit > 0 {
        find_builder = find_builder.limit(limit);
    }
    if skip > 0 {
        find_builder = find_builder.skip(skip as u64);
    }

    let mut cursor = find_builder
        .await
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut results = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
        let json_val: serde_json::Value =
            serde_json::to_value(&doc).map_err(|e| format!("BSON to JSON error: {}", e))?;
        results.push(serde_json::to_string(&json_val).unwrap());
    }

    Ok(results)
}

pub async fn count_documents_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return mock_db::count_mock_documents(database, collection, filter);
    }

    let trimmed = filter.trim();
    let is_empty_filter = trimmed.is_empty() || trimmed == "{}";

    let filter_val: serde_json::Value = if is_empty_filter {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(filter).map_err(|e| format!("Invalid MQL filter JSON: {}", e))?
    };
    let filter_doc = mongodb::bson::to_document(&filter_val)
        .map_err(|e| format!("BSON conversion error: {}", e))?;

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);

    // Empty filter: use the fast metadata estimate instead of a full scan.
    let count = if is_empty_filter {
        coll.estimated_document_count()
            .await
            .map_err(|e| format!("Failed to estimate document count: {}", e))?
    } else {
        coll.count_documents(filter_doc)
            .await
            .map_err(|e| format!("Count failed: {}", e))?
    };
    Ok(count)
}

fn csv_escape(raw: &str) -> String {
    if raw.contains(',') || raw.contains('"') || raw.contains('\n') || raw.contains('\r') {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw.to_string()
    }
}

fn csv_cell(value: Option<&serde_json::Value>) -> String {
    match value {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => csv_escape(s),
        Some(serde_json::Value::Bool(v)) => csv_escape(&v.to_string()),
        Some(serde_json::Value::Number(v)) => csv_escape(&v.to_string()),
        Some(v) => csv_escape(&serde_json::to_string(v).unwrap_or_default()),
    }
}

fn top_level_fields(value: &serde_json::Value) -> Vec<String> {
    match value.as_object() {
        Some(obj) => obj.keys().cloned().collect(),
        None => Vec::new(),
    }
}

fn bson_doc_to_json_value(doc: &mongodb::bson::Document) -> Result<serde_json::Value, String> {
    serde_json::to_value(doc).map_err(|e| format!("BSON to JSON error: {}", e))
}

async fn export_mock_collection_to_file(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: String,
    database: String,
    collection: String,
    format: String,
    path: String,
) -> Result<u64, String> {
    let docs = mock_db::execute_mock_query(&database, &collection, "{}", "{}", i64::MAX, 0)?;
    let total = docs.len() as u64;
    update_task(&tasks, &task_id, |task| {
        task.total = Some(total);
        task.message = format!("Writing {} document(s)", total);
    });

    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Failed to create export file: {}", e))?;

    if format == "json" {
        file.write_all(b"[\n")
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
        for (idx, doc) in docs.iter().enumerate() {
            if idx > 0 {
                file.write_all(b",\n")
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
            }
            file.write_all(doc.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            let processed = idx as u64 + 1;
            update_task(&tasks, &task_id, |task| {
                task.processed = processed;
            });
        }
        file.write_all(b"\n]\n")
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
    } else {
        let values: Vec<serde_json::Value> = docs
            .iter()
            .map(|doc| {
                serde_json::from_str(doc).map_err(|e| format!("Mock export JSON error: {}", e))
            })
            .collect::<Result<_, _>>()?;
        let fields: Vec<String> = values
            .iter()
            .flat_map(top_level_fields)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if !fields.is_empty() {
            file.write_all(
                fields
                    .iter()
                    .map(|field| csv_escape(field))
                    .collect::<Vec<_>>()
                    .join(",")
                    .as_bytes(),
            )
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
        }
        for (idx, value) in values.iter().enumerate() {
            let obj = value.as_object();
            let row = fields
                .iter()
                .map(|field| csv_cell(obj.and_then(|o| o.get(field))))
                .collect::<Vec<_>>()
                .join(",");
            file.write_all(row.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            let processed = idx as u64 + 1;
            update_task(&tasks, &task_id, |task| {
                task.processed = processed;
            });
        }
    }

    Ok(total)
}

async fn export_real_collection_to_file(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: String,
    client: Client,
    database: String,
    collection: String,
    format: String,
    path: String,
) -> Result<u64, String> {
    use futures::stream::StreamExt;

    let coll = client
        .database(&database)
        .collection::<mongodb::bson::Document>(&collection);

    update_task(&tasks, &task_id, |task| {
        task.message = "Counting documents".to_string();
    });
    let total = coll
        .count_documents(mongodb::bson::Document::new())
        .await
        .map_err(|e| format!("Count failed: {}", e))?;
    update_task(&tasks, &task_id, |task| {
        task.total = Some(total);
    });

    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Failed to create export file: {}", e))?;

    if format == "json" {
        update_task(&tasks, &task_id, |task| {
            task.message = "Writing JSON".to_string();
        });
        file.write_all(b"[\n")
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
        let mut cursor = coll
            .find(mongodb::bson::Document::new())
            .await
            .map_err(|e| format!("Export query failed: {}", e))?;
        let mut processed = 0u64;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let json_val = bson_doc_to_json_value(&doc)?;
            let json = serde_json::to_string(&json_val)
                .map_err(|e| format!("JSON serialization error: {}", e))?;
            if processed > 0 {
                file.write_all(b",\n")
                    .await
                    .map_err(|e| format!("Failed to write export file: {}", e))?;
            }
            file.write_all(json.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            processed += 1;
            if processed == total || processed % 100 == 0 {
                update_task(&tasks, &task_id, |task| {
                    task.processed = processed;
                });
            }
        }
        file.write_all(b"\n]\n")
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
        update_task(&tasks, &task_id, |task| {
            task.processed = processed;
        });
        Ok(processed)
    } else {
        update_task(&tasks, &task_id, |task| {
            task.message = "Scanning CSV fields".to_string();
        });
        let mut fields = BTreeSet::new();
        let mut scan_cursor = coll
            .find(mongodb::bson::Document::new())
            .await
            .map_err(|e| format!("CSV field scan failed: {}", e))?;
        let mut scanned = 0u64;
        while let Some(result) = scan_cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let json_val = bson_doc_to_json_value(&doc)?;
            for field in top_level_fields(&json_val) {
                fields.insert(field);
            }
            scanned += 1;
            if scanned == total || scanned % 250 == 0 {
                update_task(&tasks, &task_id, |task| {
                    task.processed = scanned;
                });
            }
        }
        let fields: Vec<String> = fields.into_iter().collect();
        update_task(&tasks, &task_id, |task| {
            task.processed = 0;
            task.message = "Writing CSV".to_string();
        });

        if !fields.is_empty() {
            file.write_all(
                fields
                    .iter()
                    .map(|field| csv_escape(field))
                    .collect::<Vec<_>>()
                    .join(",")
                    .as_bytes(),
            )
            .await
            .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
        }

        let mut cursor = coll
            .find(mongodb::bson::Document::new())
            .await
            .map_err(|e| format!("Export query failed: {}", e))?;
        let mut processed = 0u64;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            let json_val = bson_doc_to_json_value(&doc)?;
            let obj = json_val.as_object();
            let row = fields
                .iter()
                .map(|field| csv_cell(obj.and_then(|o| o.get(field))))
                .collect::<Vec<_>>()
                .join(",");
            file.write_all(row.as_bytes())
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            file.write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write export file: {}", e))?;
            processed += 1;
            if processed == total || processed % 100 == 0 {
                update_task(&tasks, &task_id, |task| {
                    task.processed = processed;
                });
            }
        }
        update_task(&tasks, &task_id, |task| {
            task.processed = processed;
        });
        Ok(processed)
    }
}

pub async fn start_collection_export_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    format: &str,
    path: &str,
) -> Result<TaskInfo, String> {
    let format = format.trim().to_lowercase();
    if format != "json" && format != "csv" {
        return Err("Export format must be json or csv".to_string());
    }
    if path.trim().is_empty() {
        return Err("Export path is required".to_string());
    }

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };
    let client = if is_mock {
        None
    } else {
        Some({
            let connections = state.connections.lock_safe()?;
            connections
                .get(id)
                .cloned()
                .ok_or_else(|| "Connection client not found".to_string())?
        })
    };

    let task_id = Uuid::new_v4().to_string();
    let task = TaskInfo {
        id: task_id.clone(),
        kind: "collection_export".to_string(),
        label: format!(
            "Export {}.{} as {}",
            database,
            collection,
            format.to_uppercase()
        ),
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Queued".to_string(),
        path: Some(path.to_string()),
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
    };
    state
        .tasks
        .lock()
        .unwrap()
        .insert(task_id.clone(), task.clone());

    let tasks = state.tasks.clone();
    let database = database.to_string();
    let collection = collection.to_string();
    let path = path.to_string();
    tokio::spawn(async move {
        let result = if let Some(client) = client {
            export_real_collection_to_file(
                tasks.clone(),
                task_id.clone(),
                client,
                database,
                collection,
                format,
                path,
            )
            .await
        } else {
            export_mock_collection_to_file(
                tasks.clone(),
                task_id.clone(),
                database,
                collection,
                format,
                path,
            )
            .await
        };
        match result {
            Ok(processed) => finish_task(&tasks, &task_id, processed),
            Err(err) => fail_task(&tasks, &task_id, err),
        }
    });

    Ok(task)
}

pub async fn execute_aggregate_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    pipeline: &str,
) -> Result<Vec<String>, String> {
    // Parse and validate the pipeline (a JSON array of stage documents) up front so a
    // malformed pipeline fails clearly regardless of the connection type.
    let pipeline_val: serde_json::Value = if pipeline.trim().is_empty() {
        serde_json::Value::Array(Vec::new())
    } else {
        serde_json::from_str(pipeline)
            .map_err(|e| format!("Invalid aggregation pipeline JSON: {}", e))?
    };
    let stages_val = pipeline_val
        .as_array()
        .ok_or_else(|| "Aggregation pipeline must be a JSON array of stages".to_string())?;
    let mut stages: Vec<mongodb::bson::Document> = Vec::with_capacity(stages_val.len());
    for stage in stages_val {
        let doc = mongodb::bson::to_document(stage)
            .map_err(|e| format!("Invalid aggregation stage: {}", e))?;
        stages.push(doc);
    }

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Err("Aggregation pipelines are not supported on mock connections".to_string());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);

    let mut cursor = coll
        .aggregate(stages)
        .await
        .map_err(|e| format!("Aggregation failed: {}", e))?;

    let mut results = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
        let json_val: serde_json::Value =
            serde_json::to_value(&doc).map_err(|e| format!("BSON to JSON error: {}", e))?;
        results.push(serde_json::to_string(&json_val).unwrap());
    }

    Ok(results)
}

/// Explain an entire aggregation pipeline (M1), not just its `$match` stage.
/// Mirrors `execute_aggregate_impl`'s validation and is real-connection-only.
pub async fn explain_aggregate_query_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    pipeline: &str,
) -> Result<String, String> {
    // Parse and validate the pipeline (a JSON array of stage documents) up front.
    let pipeline_val: serde_json::Value = if pipeline.trim().is_empty() {
        serde_json::Value::Array(Vec::new())
    } else {
        serde_json::from_str(pipeline)
            .map_err(|e| format!("Invalid aggregation pipeline JSON: {}", e))?
    };
    let stages_val = pipeline_val
        .as_array()
        .ok_or_else(|| "Aggregation pipeline must be a JSON array of stages".to_string())?;
    let mut stages: Vec<mongodb::bson::Document> = Vec::with_capacity(stages_val.len());
    for stage in stages_val {
        let doc = mongodb::bson::to_document(stage)
            .map_err(|e| format!("Invalid aggregation stage: {}", e))?;
        stages.push(doc);
    }

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Err("Aggregation explain is not supported on mock connections".to_string());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let db = client.database(database);
    let command = mongodb::bson::doc! {
        "explain": {
            "aggregate": collection,
            "pipeline": stages,
            "cursor": {}
        },
        "verbosity": "executionStats"
    };

    let explain_result = db
        .run_command(command)
        .await
        .map_err(|e| format!("Explain failed: {}", e))?;

    let json_val: serde_json::Value =
        serde_json::to_value(&explain_result).map_err(|e| format!("BSON to JSON error: {}", e))?;

    Ok(serde_json::to_string_pretty(&json_val).unwrap())
}

// ---- M6: schema analysis ----

#[derive(Serialize)]
pub struct TypeCount {
    #[serde(rename = "type")]
    pub type_name: String,
    pub count: usize,
}

#[derive(Serialize)]
pub struct FieldStat {
    pub path: String,
    pub types: Vec<TypeCount>,
    pub presence: usize,
    pub coverage: f64,
}

#[derive(Serialize)]
pub struct SchemaReport {
    pub sampled: usize,
    pub fields: Vec<FieldStat>,
}

/// Map a BSON value to a short, MongoDB-flavored type label.
fn bson_type_label(b: &mongodb::bson::Bson) -> &'static str {
    use mongodb::bson::Bson;
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binary",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Decimal128(_) => "decimal",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Symbol(_) => "symbol",
        Bson::MinKey => "minKey",
        Bson::MaxKey => "maxKey",
        Bson::Undefined => "undefined",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// Infer a per-field schema (dotted nested paths, type counts, coverage) from a
/// sample of documents. Pure and deterministic (fields sorted by path).
pub fn infer_schema(docs: &[mongodb::bson::Document]) -> SchemaReport {
    use mongodb::bson::Bson;
    use std::collections::BTreeMap;

    // path -> documents containing it; path -> (type label -> count)
    let mut presence: BTreeMap<String, usize> = BTreeMap::new();
    let mut type_counts: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();

    fn walk(
        prefix: &str,
        doc: &mongodb::bson::Document,
        presence: &mut BTreeMap<String, usize>,
        type_counts: &mut BTreeMap<String, BTreeMap<String, usize>>,
    ) {
        for (k, v) in doc.iter() {
            let path = if prefix.is_empty() {
                k.clone()
            } else {
                format!("{}.{}", prefix, k)
            };
            *presence.entry(path.clone()).or_insert(0) += 1;
            *type_counts
                .entry(path.clone())
                .or_default()
                .entry(bson_type_label(v).to_string())
                .or_insert(0) += 1;
            // Recurse into embedded documents; arrays are not recursed (YAGNI).
            if let Bson::Document(sub) = v {
                walk(&path, sub, presence, type_counts);
            }
        }
    }

    for d in docs {
        walk("", d, &mut presence, &mut type_counts);
    }

    let sampled = docs.len();
    let fields = presence
        .into_iter()
        .map(|(path, pres)| {
            let types = type_counts
                .get(&path)
                .map(|m| {
                    m.iter()
                        .map(|(t, c)| TypeCount {
                            type_name: t.clone(),
                            count: *c,
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let coverage = if sampled == 0 {
                0.0
            } else {
                pres as f64 / sampled as f64
            };
            FieldStat {
                path,
                types,
                presence: pres,
                coverage,
            }
        })
        .collect();

    SchemaReport { sampled, fields }
}

pub async fn analyze_schema_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    sample_size: i64,
) -> Result<String, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    let docs: Vec<mongodb::bson::Document> = if is_mock {
        // Mock connections can't aggregate; sample the demo data via find.
        let rows = mock_db::execute_mock_query(database, collection, "", "", sample_size, 0)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let val: serde_json::Value =
                serde_json::from_str(&row).map_err(|e| format!("Mock doc parse error: {}", e))?;
            let doc = mongodb::bson::to_document(&val)
                .map_err(|e| format!("Mock doc conversion error: {}", e))?;
            out.push(doc);
        }
        out
    } else {
        let client = {
            let connections = state.connections.lock_safe()?;
            connections
                .get(id)
                .cloned()
                .ok_or_else(|| "Connection client not found".to_string())?
        };
        let coll = client
            .database(database)
            .collection::<mongodb::bson::Document>(collection);
        let pipeline = vec![mongodb::bson::doc! { "$sample": { "size": sample_size } }];
        let mut cursor = coll
            .aggregate(pipeline)
            .await
            .map_err(|e| format!("Sampling failed: {}", e))?;
        let mut out = Vec::new();
        use futures::stream::StreamExt;
        while let Some(result) = cursor.next().await {
            out.push(result.map_err(|e| format!("Cursor read error: {}", e))?);
        }
        out
    };

    let report = infer_schema(&docs);
    serde_json::to_string(&report).map_err(|e| format!("Serialization error: {}", e))
}

pub async fn explain_mql_query_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<String, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok(mock_db::get_mock_explain(database, collection, filter));
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let db = client.database(database);
    let filter_val: serde_json::Value = if filter.trim().is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(filter).map_err(|e| format!("Invalid MQL filter JSON: {}", e))?
    };

    let filter_doc = mongodb::bson::to_document(&filter_val)
        .map_err(|e| format!("BSON conversion error: {}", e))?;

    let command = mongodb::bson::doc! {
        "explain": {
            "find": collection,
            "filter": filter_doc
        },
        "verbosity": "executionStats"
    };

    let explain_result = db
        .run_command(command)
        .await
        .map_err(|e| format!("Explain failed: {}", e))?;

    let json_val: serde_json::Value =
        serde_json::to_value(&explain_result).map_err(|e| format!("BSON to JSON error: {}", e))?;

    Ok(serde_json::to_string_pretty(&json_val).unwrap())
}

pub async fn create_index_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    keys: &str,
    unique: bool,
    sparse: bool,
) -> Result<(), String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        let list = mock_indexes.get_mut(&key).unwrap();
        if !list.iter().any(|i| i.name == index_name) {
            list.push(IndexInfo {
                name: index_name.to_string(),
                keys: keys.to_string(),
                unique,
                sparse,
            });
        }
        return Ok(());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    let value: serde_json::Value =
        serde_json::from_str(keys).map_err(|e| format!("Invalid JSON keys: {}", e))?;
    let keys_doc = mongodb::bson::to_document(&value)
        .map_err(|e| format!("Failed to convert keys JSON to BSON: {}", e))?;

    let mut options = mongodb::options::IndexOptions::builder()
        .name(index_name.to_string())
        .build();

    if unique {
        options.unique = Some(true);
    }
    if sparse {
        options.sparse = Some(true);
    }

    let model = mongodb::IndexModel::builder()
        .keys(keys_doc)
        .options(options)
        .build();

    coll.create_index(model)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to create index: {}", e))
}

pub async fn delete_index_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
) -> Result<(), String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        let list = mock_indexes.get_mut(&key).unwrap();
        list.retain(|x| x.name != index_name);
        return Ok(());
    }

    let client = {
        let connections = state.connections.lock_safe()?;
        connections
            .get(id)
            .cloned()
            .ok_or_else(|| "Connection client not found".to_string())?
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    coll.drop_index(index_name)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to delete index: {}", e))
}

// Parse a JSON string into a BSON Document, interpreting MongoDB Extended JSON
// (e.g. {"$oid": "..."} -> ObjectId, {"$date": ...} -> DateTime) so that writes
// match documents by their real _id type rather than a literal sub-document.
pub fn json_to_bson_document(s: &str) -> Result<mongodb::bson::Document, String> {
    let value: serde_json::Value =
        serde_json::from_str(s).map_err(|e| format!("Invalid JSON: {}", e))?;
    let bson = mongodb::bson::Bson::try_from(value)
        .map_err(|e| format!("Invalid BSON/Extended JSON: {}", e))?;
    match bson {
        mongodb::bson::Bson::Document(doc) => Ok(doc),
        _ => Err("Expected a JSON object (e.g. { \"field\": value })".to_string()),
    }
}

fn require_real_client(state: &AppState, id: &str) -> Result<Client, String> {
    let connections = state.connections.lock_safe()?;
    connections
        .get(id)
        .cloned()
        .ok_or_else(|| "Connection client not found".to_string())
}

fn connection_is_mock(state: &AppState, id: &str) -> Result<bool, String> {
    let mocks = state.mocks.lock_safe()?;
    mocks
        .get(id)
        .copied()
        .ok_or_else(|| "Connection not found".to_string())
}

pub async fn delete_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    // Parse/validate up front so bad input fails the same way for mock & real.
    let filter_doc = json_to_bson_document(filter)?;

    if connection_is_mock(state, id)? {
        return Ok(1);
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .delete_one(filter_doc)
        .await
        .map_err(|e| format!("Failed to delete document: {}", e))?;
    Ok(res.deleted_count)
}

pub async fn delete_many_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    if connection_is_mock(state, id)? {
        return Ok(0); // mock connections don't persist deletes
    }
    let client = require_real_client(state, id)?;
    let res = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection)
        .delete_many(filter_doc)
        .await
        .map_err(|e| format!("Failed to delete documents: {}", e))?;
    Ok(res.deleted_count)
}

pub async fn update_many_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    update: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    let update_doc = json_to_bson_document(update)?;
    // Require an operator-keyed update ({ "$set": … }); reject bare replacements
    // / empty updates so a bulk op can't silently overwrite whole documents.
    if update_doc.is_empty() || !update_doc.keys().all(|k| k.starts_with('$')) {
        return Err("Update must use operators like $set (e.g. { \"$set\": { … } })".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(0); // mock connections don't persist updates
    }
    let client = require_real_client(state, id)?;
    let res = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection)
        .update_many(filter_doc, update_doc)
        .await
        .map_err(|e| format!("Failed to update documents: {}", e))?;
    Ok(res.modified_count)
}

// ---- M7: GridFS browsing ----

#[derive(Serialize)]
pub struct GridFsFileInfo {
    pub id: String, // Extended-JSON of the file's _id
    pub filename: String,
    pub length: u64,
    pub chunk_size_bytes: u32,
    pub upload_date: String,
    pub content_type: Option<String>,
}

pub async fn list_gridfs_files_impl(
    state: &AppState,
    id: &str,
    database: &str,
    bucket: &str,
) -> Result<String, String> {
    if connection_is_mock(state, id)? {
        return Err("GridFS is not supported on mock connections".to_string());
    }
    let client = require_real_client(state, id)?;
    let files_coll = format!("{}.files", bucket);
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(&files_coll);
    let mut cursor = coll
        .find(mongodb::bson::doc! {})
        .sort(mongodb::bson::doc! { "filename": 1 })
        .await
        .map_err(|e| format!("Failed to list GridFS files: {}", e))?;

    use futures::stream::StreamExt;
    let mut files = Vec::new();
    while let Some(res) = cursor.next().await {
        let doc = res.map_err(|e| format!("Cursor read error: {}", e))?;
        let id_extjson = doc
            .get("_id")
            .cloned()
            .unwrap_or(mongodb::bson::Bson::Null)
            .into_relaxed_extjson()
            .to_string();
        let filename = doc.get_str("filename").unwrap_or("").to_string();
        let length = doc
            .get_i64("length")
            .map(|v| v as u64)
            .or_else(|_| doc.get_i32("length").map(|v| v as u64))
            .unwrap_or(0);
        let chunk_size_bytes = doc.get_i32("chunkSize").map(|v| v as u32).unwrap_or(0);
        let upload_date = doc
            .get_datetime("uploadDate")
            .ok()
            .and_then(|d| d.try_to_rfc3339_string().ok())
            .unwrap_or_default();
        let content_type = doc.get_str("contentType").ok().map(|s| s.to_string());
        files.push(GridFsFileInfo {
            id: id_extjson,
            filename,
            length,
            chunk_size_bytes,
            upload_date,
            content_type,
        });
    }
    serde_json::to_string(&files).map_err(|e| format!("Serialization error: {}", e))
}

pub async fn download_gridfs_file_impl(
    state: &AppState,
    id: &str,
    database: &str,
    bucket: &str,
    file_id_json: &str,
    dest_path: &str,
) -> Result<u64, String> {
    if connection_is_mock(state, id)? {
        return Err("GridFS is not supported on mock connections".to_string());
    }
    // Parse the file _id from its Extended JSON (e.g. {"$oid": "..."}).
    let id_value: serde_json::Value =
        serde_json::from_str(file_id_json).map_err(|e| format!("Invalid file id JSON: {}", e))?;
    let file_id = mongodb::bson::Bson::try_from(id_value)
        .map_err(|e| format!("Invalid file id: {}", e))?;

    let client = require_real_client(state, id)?;
    let bucket_obj = client.database(database).gridfs_bucket(
        mongodb::options::GridFsBucketOptions::builder()
            .bucket_name(bucket.to_string())
            .build(),
    );
    let mut stream = bucket_obj
        .open_download_stream(file_id)
        .await
        .map_err(|e| format!("Failed to open GridFS download: {}", e))?;

    use futures::AsyncReadExt;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("GridFS read error: {}", e))?;
    std::fs::write(dest_path, &buf).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(buf.len() as u64)
}

pub async fn insert_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    document: &str,
) -> Result<String, String> {
    let doc = json_to_bson_document(document)?;

    if connection_is_mock(state, id)? {
        return Ok("mock-inserted-id".to_string());
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .insert_one(doc)
        .await
        .map_err(|e| format!("Failed to insert document: {}", e))?;
    // Return the inserted id as a JSON string (Extended JSON for ObjectId etc.).
    Ok(res.inserted_id.into_relaxed_extjson().to_string())
}

pub async fn update_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    replacement: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    let replacement_doc = json_to_bson_document(replacement)?;

    if connection_is_mock(state, id)? {
        return Ok(1);
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .replace_one(filter_doc, replacement_doc)
        .await
        .map_err(|e| format!("Failed to update document: {}", e))?;
    Ok(res.modified_count)
}

#[derive(serde::Serialize)]
pub struct ImportResult {
    pub inserted: u64,
    pub updated: u64,
    pub skipped: u64,
}

#[derive(serde::Serialize)]
pub struct DatabaseRenameResult {
    pub collections: u64,
    pub documents: u64,
}

// Bulk-import documents with a duplicate-handling mode:
//   "skip"   - insert_many(ordered:false); duplicate-key rows are counted as skipped.
//   "update" - per doc replace_one({_id}, doc, upsert:true); no _id -> insert.
//   "abort"  - if any incoming _id already exists, write nothing and error.
// Documents are already-validated JSON values from the frontend codec; each is
// converted to BSON here as a safety net.
pub async fn import_documents_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    docs: Vec<serde_json::Value>,
    mode: &str,
) -> Result<ImportResult, String> {
    // Convert all docs up front; a bad doc fails the whole import before writing.
    let mut bson_docs: Vec<mongodb::bson::Document> = Vec::with_capacity(docs.len());
    for value in &docs {
        let s = serde_json::to_string(value).map_err(|e| format!("Invalid document: {}", e))?;
        bson_docs.push(json_to_bson_document(&s)?);
    }

    if connection_is_mock(state, id)? {
        // Mock connections validate but do not persist.
        return Ok(match mode {
            "update" => ImportResult {
                inserted: 0,
                updated: bson_docs.len() as u64,
                skipped: 0,
            },
            _ => ImportResult {
                inserted: bson_docs.len() as u64,
                updated: 0,
                skipped: 0,
            },
        });
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);

    // Collect the set of incoming _ids that already exist in the collection,
    // keyed by their stringified BSON (same rendering on both sides). Used by
    // skip (partition) and abort (pre-check) so we never rely on bulk-write
    // error introspection, which varies across driver versions.
    async fn existing_ids(
        coll: &mongodb::Collection<mongodb::bson::Document>,
        docs: &[mongodb::bson::Document],
    ) -> Result<std::collections::HashSet<String>, String> {
        let ids: Vec<mongodb::bson::Bson> =
            docs.iter().filter_map(|d| d.get("_id").cloned()).collect();
        let mut found = std::collections::HashSet::new();
        if ids.is_empty() {
            return Ok(found);
        }
        let mut cursor = coll
            .find(mongodb::bson::doc! { "_id": { "$in": ids } })
            .await
            .map_err(|e| format!("Failed to check existing documents: {}", e))?;
        use futures::stream::StreamExt;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            if let Some(id_val) = doc.get("_id") {
                found.insert(id_val.to_string());
            }
        }
        Ok(found)
    }

    match mode {
        "update" => {
            // Existing _ids get replaced (counts as updated); everything else is
            // inserted. This is an upsert-by-_id without relying on the driver's
            // option setters, which vary across versions.
            let existing = existing_ids(&coll, &bson_docs).await?;
            let mut inserted = 0u64;
            let mut updated = 0u64;
            for doc in bson_docs {
                match doc.get("_id").cloned() {
                    Some(id_val) if existing.contains(&id_val.to_string()) => {
                        let filter = mongodb::bson::doc! { "_id": id_val };
                        let res = coll
                            .replace_one(filter, doc)
                            .await
                            .map_err(|e| format!("Failed to import (update): {}", e))?;
                        updated += res.modified_count;
                    }
                    _ => {
                        coll.insert_one(doc)
                            .await
                            .map_err(|e| format!("Failed to import (insert): {}", e))?;
                        inserted += 1;
                    }
                }
            }
            Ok(ImportResult {
                inserted,
                updated,
                skipped: 0,
            })
        }
        "abort" => {
            // Any incoming _id already present -> abort, write nothing.
            let existing = existing_ids(&coll, &bson_docs).await?;
            if !existing.is_empty() {
                return Err(format!(
                    "Import aborted: {} document(s) already exist",
                    existing.len()
                ));
            }
            let total = bson_docs.len() as u64;
            coll.insert_many(bson_docs)
                .await
                .map_err(|e| format!("Failed to import: {}", e))?;
            Ok(ImportResult {
                inserted: total,
                updated: 0,
                skipped: 0,
            })
        }
        _ => {
            // "skip" (default): insert only docs whose _id does not already exist;
            // count existing ones as skipped. Docs without an _id always insert.
            let existing = existing_ids(&coll, &bson_docs).await?;
            let total = bson_docs.len() as u64;
            let to_insert: Vec<mongodb::bson::Document> = bson_docs
                .into_iter()
                .filter(|d| match d.get("_id") {
                    Some(id_val) => !existing.contains(&id_val.to_string()),
                    None => true,
                })
                .collect();
            let inserted = to_insert.len() as u64;
            if !to_insert.is_empty() {
                coll.insert_many(to_insert)
                    .await
                    .map_err(|e| format!("Failed to import: {}", e))?;
            }
            Ok(ImportResult {
                inserted,
                updated: 0,
                skipped: total - inserted,
            })
        }
    }
}

pub async fn create_collection_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
) -> Result<(), String> {
    if collection.trim().is_empty() {
        return Err("Collection name is required".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .create_collection(collection)
        .await
        .map_err(|e| format!("Failed to create collection: {}", e))
}

pub async fn create_view_impl(
    state: &AppState,
    id: &str,
    database: &str,
    view_name: &str,
    source_collection: &str,
    pipeline: &str,
) -> Result<(), String> {
    if view_name.trim().is_empty() {
        return Err("View name is required".to_string());
    }
    if source_collection.trim().is_empty() {
        return Err("Source collection is required".to_string());
    }
    // Validate the pipeline (a JSON array of stage documents) up front.
    let pipeline_val: serde_json::Value = if pipeline.trim().is_empty() {
        serde_json::Value::Array(Vec::new())
    } else {
        serde_json::from_str(pipeline)
            .map_err(|e| format!("Invalid aggregation pipeline JSON: {}", e))?
    };
    let stages_val = pipeline_val
        .as_array()
        .ok_or_else(|| "Aggregation pipeline must be a JSON array of stages".to_string())?;
    let mut stages: Vec<mongodb::bson::Document> = Vec::with_capacity(stages_val.len());
    for stage in stages_val {
        let doc = mongodb::bson::to_document(stage)
            .map_err(|e| format!("Invalid aggregation stage: {}", e))?;
        stages.push(doc);
    }

    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .create_collection(view_name)
        .view_on(source_collection.to_string())
        .pipeline(stages)
        .await
        .map_err(|e| format!("Failed to create view: {}", e))
}

pub async fn drop_collection_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
) -> Result<(), String> {
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .collection::<mongodb::bson::Document>(collection)
        .drop()
        .await
        .map_err(|e| format!("Failed to drop collection: {}", e))
}

pub async fn rename_collection_impl(
    state: &AppState,
    id: &str,
    database: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err("Collection name is required".to_string());
    }
    if from == to {
        return Err("New collection name must be different".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database("admin")
        .run_command(mongodb::bson::doc! {
            "renameCollection": format!("{}.{}", database, from),
            "to": format!("{}.{}", database, to),
            "dropTarget": false,
        })
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to rename collection: {}", e))
}

pub async fn drop_database_impl(state: &AppState, id: &str, database: &str) -> Result<(), String> {
    if database.trim().is_empty() {
        return Err("Database name is required".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .drop()
        .await
        .map_err(|e| format!("Failed to drop database: {}", e))
}

pub async fn rename_database_impl(
    state: &AppState,
    id: &str,
    from: &str,
    to: &str,
    drop_source: bool,
) -> Result<DatabaseRenameResult, String> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err("Database name is required".to_string());
    }
    if from == to {
        return Err("New database name must be different".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(DatabaseRenameResult {
            collections: 0,
            documents: 0,
        });
    }

    let client = require_real_client(state, id)?;
    let db_names = client
        .list_database_names()
        .await
        .map_err(|e| format!("Failed to list databases: {}", e))?;
    if !db_names.iter().any(|name| name == from) {
        return Err(format!("Source database \"{}\" does not exist", from));
    }
    if db_names.iter().any(|name| name == to) {
        return Err(format!("Target database \"{}\" already exists", to));
    }

    let source_db = client.database(from);
    let target_db = client.database(to);
    let mut coll_cursor = source_db
        .list_collections()
        .await
        .map_err(|e| format!("Failed to list source collections: {}", e))?;

    let mut specs = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = coll_cursor.next().await {
        let spec = result.map_err(|e| format!("Collection read error: {}", e))?;
        match spec.collection_type {
            mongodb::results::CollectionType::Collection => specs.push(spec),
            mongodb::results::CollectionType::View => {
                return Err(format!(
                    "Cannot rename database: collection \"{}\" is a view",
                    spec.name
                ));
            }
            mongodb::results::CollectionType::Timeseries => {
                return Err(format!(
                    "Cannot rename database: collection \"{}\" is time-series",
                    spec.name
                ));
            }
            _ => {
                return Err(format!(
                    "Cannot rename database: collection \"{}\" has an unsupported type",
                    spec.name
                ));
            }
        }
    }
    if specs.is_empty() {
        return Err(format!(
            "Source database \"{}\" has no collections to copy",
            from
        ));
    }

    let copy_result = async {
        let mut copied_collections = 0u64;
        let mut copied_documents = 0u64;

        for spec in &specs {
            let source_coll = source_db.collection::<mongodb::bson::Document>(&spec.name);
            let target_coll = target_db.collection::<mongodb::bson::Document>(&spec.name);

            target_db
                .create_collection(&spec.name)
                .await
                .map_err(|e| format!("Failed to create target collection {}: {}", spec.name, e))?;

            let mut doc_cursor = source_coll
                .find(mongodb::bson::doc! {})
                .await
                .map_err(|e| format!("Failed to read source collection {}: {}", spec.name, e))?;
            let mut batch = Vec::with_capacity(500);
            while let Some(result) = doc_cursor.next().await {
                batch.push(result.map_err(|e| format!("Cursor read error: {}", e))?);
                if batch.len() >= 500 {
                    copied_documents += batch.len() as u64;
                    target_coll
                        .insert_many(std::mem::take(&mut batch))
                        .await
                        .map_err(|e| {
                            format!("Failed to copy documents for {}: {}", spec.name, e)
                        })?;
                }
            }
            if !batch.is_empty() {
                copied_documents += batch.len() as u64;
                target_coll
                    .insert_many(batch)
                    .await
                    .map_err(|e| format!("Failed to copy documents for {}: {}", spec.name, e))?;
            }

            let mut idx_cursor = source_coll
                .list_indexes()
                .await
                .map_err(|e| format!("Failed to list indexes for {}: {}", spec.name, e))?;
            while let Some(result) = idx_cursor.next().await {
                let index = result.map_err(|e| format!("Index read error: {}", e))?;
                let name = index
                    .options
                    .as_ref()
                    .and_then(|o| o.name.as_deref())
                    .unwrap_or("");
                if name != "_id_" {
                    target_coll
                        .create_index(index)
                        .await
                        .map_err(|e| format!("Failed to recreate index on {}: {}", spec.name, e))?;
                }
            }

            let source_count = source_coll
                .count_documents(mongodb::bson::doc! {})
                .await
                .map_err(|e| format!("Failed to count source collection {}: {}", spec.name, e))?;
            let target_count = target_coll
                .count_documents(mongodb::bson::doc! {})
                .await
                .map_err(|e| format!("Failed to count target collection {}: {}", spec.name, e))?;
            if source_count != target_count {
                return Err(format!(
                    "Copied collection {} failed verification: source has {}, target has {}",
                    spec.name, source_count, target_count
                ));
            }
            copied_collections += 1;
        }

        Ok(DatabaseRenameResult {
            collections: copied_collections,
            documents: copied_documents,
        })
    }
    .await;

    match copy_result {
        Ok(result) => {
            if drop_source {
                source_db.drop().await.map_err(|e| {
                    format!("Copied target, but failed to drop source database: {}", e)
                })?;
            }
            Ok(result)
        }
        Err(err) => {
            let _ = target_db.drop().await;
            Err(err)
        }
    }
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
    state: tauri::State<'_, AppState>,
    connection_id: String,
    uri: String,
    database: String,
    mongosh_path: String,
) -> Result<MongoshSessionInfo, String> {
    start_mongosh_session_impl(&state, &connection_id, &uri, &database, &mongosh_path).await
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
) -> Result<TaskInfo, String> {
    start_collection_export_impl(&state, &id, &database, &collection, &format, &path).await
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
    create_view_impl(&state, &id, &database, &view_name, &source_collection, &pipeline).await
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
) -> Result<u64, String> {
    download_gridfs_file_impl(&state, &id, &database, &bucket, &file_id, &dest_path).await
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
async fn import_documents(
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    docs: Vec<serde_json::Value>,
    mode: String,
) -> Result<ImportResult, String> {
    import_documents_impl(&state, &id, &database, &collection, docs, &mode).await
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
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            create_index,
            delete_index,
            delete_document,
            delete_many,
            update_many,
            list_gridfs_files,
            download_gridfs_file,
            insert_document,
            import_documents,
            update_document,
            execute_mql_query,
            execute_aggregate,
            count_documents,
            start_collection_export,
            list_export_tasks,
            clear_finished_export_tasks,
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
            queries::set_default_query
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
