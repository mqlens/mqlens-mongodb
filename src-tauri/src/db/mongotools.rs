//! mongodump/mongorestore integration: option structs, argv builders with
//! flag-legality validation, URI password redaction, a stderr progress-line
//! parser, and the cancellable background-task runner that actually spawns
//! the tools.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use uuid::Uuid;

use crate::db::tasks::{fail_task, finish_task, now_ms, update_task};
use crate::state::{AppState, LockExt};
use crate::TaskInfo;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DumpScope {
    Server,
    Db { db: String },
    Collection { db: String, coll: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DumpTarget {
    Folder { out: String },
    Archive { file: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DumpOptions {
    pub scope: DumpScope,
    pub target: DumpTarget,
    pub gzip: bool,
    pub query: Option<String>,
    pub force_table_scan: bool,
    pub dump_users_and_roles: bool,
    pub oplog: bool,
}

impl Default for DumpOptions {
    fn default() -> Self {
        Self {
            scope: DumpScope::Server,
            target: DumpTarget::Folder { out: String::new() },
            gzip: true,
            query: None,
            force_table_scan: false,
            dump_users_and_roles: false,
            oplog: false,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NsSelection {
    pub db: String,
    pub coll: String,
    pub rename_to: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RestoreSource {
    Folder { dir: String },
    Archive { file: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RestoreOptions {
    pub source: RestoreSource,
    pub gzip: bool,
    pub selections: Vec<NsSelection>,
    pub filter_db: Option<String>,
    pub filter_coll: Option<String>,
    pub drop: bool,
    pub keep_index_version: bool,
    pub no_index_restore: bool,
    pub no_options_restore: bool,
    pub maintain_insertion_order: bool,
    pub stop_on_error: bool,
    pub bypass_document_validation: bool,
    pub restore_db_users_and_roles: bool,
    pub oplog_replay: bool,
}

impl Default for RestoreOptions {
    fn default() -> Self {
        Self {
            source: RestoreSource::Folder { dir: String::new() },
            gzip: false,
            selections: Vec::new(),
            filter_db: None,
            filter_coll: None,
            drop: false,
            keep_index_version: false,
            no_index_restore: false,
            no_options_restore: false,
            maintain_insertion_order: false,
            stop_on_error: false,
            bypass_document_validation: false,
            restore_db_users_and_roles: false,
            oplog_replay: false,
        }
    }
}

/// Build the argv (excluding the URI, which the runner supplies via a
/// temp config file) for a `mongodump` invocation.
pub fn build_dump_args(o: &DumpOptions) -> Result<Vec<String>, String> {
    if o.oplog && !matches!(o.scope, DumpScope::Server) {
        return Err("oplog requires a whole-server dump".to_string());
    }
    if o.dump_users_and_roles && !matches!(o.scope, DumpScope::Db { .. }) {
        return Err("dumpDbUsersAndRoles requires database scope".to_string());
    }
    if o.query.is_some() && !matches!(o.scope, DumpScope::Collection { .. }) {
        return Err("query requires collection scope".to_string());
    }
    match &o.target {
        DumpTarget::Folder { out } if out.is_empty() => {
            return Err("destination is required".to_string());
        }
        DumpTarget::Archive { file } if file.is_empty() => {
            return Err("destination is required".to_string());
        }
        _ => {}
    }

    let mut args = Vec::new();

    // User/server-controlled values ride in single `--flag=value` tokens so a
    // value starting with '-' can't be parsed as a flag by go-flags.
    match &o.scope {
        DumpScope::Server => {}
        DumpScope::Db { db } => {
            args.push(format!("--db={}", db));
        }
        DumpScope::Collection { db, coll } => {
            args.push(format!("--db={}", db));
            args.push(format!("--collection={}", coll));
        }
    }

    match &o.target {
        DumpTarget::Folder { out } => {
            args.push(format!("--out={}", out));
        }
        DumpTarget::Archive { file } => {
            args.push(format!("--archive={}", file));
        }
    }

    if o.gzip {
        args.push("--gzip".to_string());
    }
    if let Some(query) = &o.query {
        args.push(format!("--query={}", query));
    }
    if o.force_table_scan {
        args.push("--forceTableScan".to_string());
    }
    if o.dump_users_and_roles {
        args.push("--dumpDbUsersAndRoles".to_string());
    }
    if o.oplog {
        args.push("--oplog".to_string());
    }

    Ok(args)
}

/// Build the argv (excluding the URI, which the runner supplies via a
/// temp config file) for a `mongorestore` invocation.
pub fn build_restore_args(o: &RestoreOptions) -> Result<Vec<String>, String> {
    if o.filter_coll.is_some() && o.filter_db.is_none() {
        return Err("archive filter collection requires a database".to_string());
    }
    if o.oplog_replay
        && (!o.selections.is_empty() || o.filter_db.is_some() || o.filter_coll.is_some())
    {
        return Err("oplogReplay cannot be combined with namespace filters".to_string());
    }
    if o.restore_db_users_and_roles {
        let single_db = match &o.source {
            RestoreSource::Folder { .. } => {
                let dbs: HashSet<&str> = o.selections.iter().map(|s| s.db.as_str()).collect();
                dbs.len() == 1
            }
            RestoreSource::Archive { .. } => o.filter_db.is_some() && o.filter_coll.is_none(),
        };
        if !single_db {
            return Err("restoreDbUsersAndRoles requires a single database selection".to_string());
        }
    }
    match &o.source {
        RestoreSource::Folder { dir } if dir.is_empty() => {
            return Err("destination is required".to_string());
        }
        RestoreSource::Archive { file } if file.is_empty() => {
            return Err("destination is required".to_string());
        }
        _ => {}
    }

    let mut args = Vec::new();

    if let RestoreSource::Archive { file } = &o.source {
        args.push(format!("--archive={}", file));
    }

    if o.gzip {
        args.push("--gzip".to_string());
    }
    if o.drop {
        args.push("--drop".to_string());
    }
    if o.keep_index_version {
        args.push("--keepIndexVersion".to_string());
    }
    if o.no_index_restore {
        args.push("--noIndexRestore".to_string());
    }
    if o.no_options_restore {
        args.push("--noOptionsRestore".to_string());
    }
    if o.maintain_insertion_order {
        args.push("--maintainInsertionOrder".to_string());
    }
    if o.stop_on_error {
        args.push("--stopOnError".to_string());
    }
    if o.bypass_document_validation {
        args.push("--bypassDocumentValidation".to_string());
    }
    if o.restore_db_users_and_roles {
        args.push("--restoreDbUsersAndRoles".to_string());
    }
    if o.oplog_replay {
        args.push("--oplogReplay".to_string());
    }

    // User/server-controlled values ride in single `--flag=value` tokens so a
    // value starting with '-' can't be parsed as a flag by go-flags.
    match &o.source {
        RestoreSource::Folder { .. } => {
            for sel in &o.selections {
                args.push(format!("--nsInclude={}.{}", sel.db, sel.coll));
                if let Some(rename_to) = &sel.rename_to {
                    args.push(format!("--nsFrom={}.{}", sel.db, sel.coll));
                    // --nsTo requires a full db.collection namespace; qualify
                    // a bare collection name with the selection's db.
                    if rename_to.contains('.') {
                        args.push(format!("--nsTo={}", rename_to));
                    } else {
                        args.push(format!("--nsTo={}.{}", sel.db, rename_to));
                    }
                }
            }
        }
        RestoreSource::Archive { .. } => {
            if let Some(db) = &o.filter_db {
                match &o.filter_coll {
                    Some(coll) => args.push(format!("--nsInclude={}.{}", db, coll)),
                    None => args.push(format!("--nsInclude={}.*", db)),
                }
            }
        }
    }

    if let RestoreSource::Folder { dir } = &o.source {
        args.push(format!("--dir={}", dir));
    }

    Ok(args)
}

/// Redact the password component of a MongoDB connection string, if any.
/// `mongodb://user:pass@host` -> `mongodb://user:***@host`. Leaves the URI
/// unchanged when there is no userinfo or no password.
pub fn redact_uri_password(uri: &str) -> String {
    let scheme_end = match uri.find("://") {
        Some(idx) => idx + 3,
        None => return uri.to_string(),
    };
    let rest = &uri[scheme_end..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let at_pos = match authority.rfind('@') {
        Some(idx) => idx,
        None => return uri.to_string(),
    };
    let userinfo = &authority[..at_pos];
    let colon_pos = match userinfo.find(':') {
        Some(idx) => idx,
        None => return uri.to_string(),
    };
    let user = &userinfo[..colon_pos];

    let mut result = String::with_capacity(uri.len());
    result.push_str(&uri[..scheme_end]);
    result.push_str(user);
    result.push_str(":***");
    result.push_str(&authority[at_pos..]);
    result.push_str(&rest[authority_end..]);
    result
}

/// Redact URI passwords in free-form text (raw tool stderr): every
/// whitespace-separated token containing "://" is run through
/// [`redact_uri_password`]; all other tokens — and the original whitespace —
/// pass through unchanged.
fn redact_uris_in_text(text: &str) -> String {
    if !text.contains("://") {
        return text.to_string();
    }
    text.split_inclusive(char::is_whitespace)
        .map(|token| {
            if token.contains("://") {
                redact_uri_password(token)
            } else {
                token.to_string()
            }
        })
        .collect()
}

/// Strip the path database from a MongoDB URI for tool invocations, then
/// append the query parameters mongodump/mongorestore need to avoid hanging
/// on unreachable topology members:
///
/// - `directConnection=true` when `direct_connection` is set (tunneled
///   connections only see one reachable host: the local tunnel endpoint;
///   without this, the driver discovers replica-set members' real IPs via
///   topology discovery and retries them indefinitely) — unless the URI
///   already has an explicit `directConnection=` param, which always wins.
/// - `serverSelectionTimeoutMS=30000` (all invocations) so an unreachable
///   topology fails fast with the tool's own error instead of hanging
///   forever, unless the URI already sets one.
///
/// Parameter names are matched ASCII-case-insensitively per the MongoDB URI
/// spec (connection-string option names are case-insensitive); the query
/// string is not percent-decoded.
pub fn prepare_tool_uri(uri: &str, direct_connection: bool) -> String {
    let stripped = strip_path_database(uri);
    append_tool_query_params(&stripped, direct_connection)
}

/// True when a query-string param's key (the part before '=') equals `name`
/// ASCII-case-insensitively — connection-string option names are
/// case-insensitive per the MongoDB URI spec, so `authsource=` must be
/// recognized as `authSource=` (the Go tools take last-one-wins on
/// duplicates, so a missed match would append a conflicting param).
fn query_param_has_key(param: &str, name: &str) -> bool {
    let key = param.split('=').next().unwrap_or("");
    key.eq_ignore_ascii_case(name)
}

/// Strip the path database from a MongoDB URI for tool invocations
/// (mongodump/mongorestore treat it as a db selector that conflicts with
/// --db/--nsInclude). MongoDB auth semantics: when no authSource query param
/// is present, the path database IS the auth database — so preserve it as
/// authSource=<pathdb> in that case.
fn strip_path_database(uri: &str) -> String {
    let scheme_end = match uri.find("://") {
        Some(idx) => idx + 3,
        None => return uri.to_string(),
    };
    let rest = &uri[scheme_end..];
    // Authority window: everything up to the first '/' after "://". Percent-
    // encoded credentials (e.g. `p%40ss%2Fx`) never contain a raw '/', so this
    // can't be confused by userinfo content — same technique as
    // `redact_uri_password`.
    let authority_end = match rest.find('/') {
        Some(idx) => idx,
        None => return uri.to_string(), // no path at all
    };
    let authority = &rest[..authority_end];
    let after_authority = &rest[authority_end..]; // starts with '/'
    let path_and_rest = &after_authority[1..];

    // The path database is everything up to the next '?' or '#' (or end).
    let path_end = path_and_rest.find(['?', '#']).unwrap_or(path_and_rest.len());
    let db = &path_and_rest[..path_end];
    if db.is_empty() {
        return uri.to_string();
    }
    let remainder = &path_and_rest[path_end..];

    let mut result = String::with_capacity(uri.len() + db.len());
    result.push_str(&uri[..scheme_end]);
    result.push_str(authority);
    result.push('/');

    if let Some(rest_after_q) = remainder.strip_prefix('?') {
        let frag_idx = rest_after_q.find('#').unwrap_or(rest_after_q.len());
        let query = &rest_after_q[..frag_idx];
        let fragment = &rest_after_q[frag_idx..];
        let has_authsource = query.split('&').any(|p| query_param_has_key(p, "authSource"));
        result.push('?');
        if has_authsource {
            result.push_str(query);
        } else if query.is_empty() {
            result.push_str("authSource=");
            result.push_str(db);
        } else {
            result.push_str(query);
            result.push_str("&authSource=");
            result.push_str(db);
        }
        result.push_str(fragment);
    } else {
        // No query string: `remainder` is either empty or a fragment.
        result.push_str("?authSource=");
        result.push_str(db);
        result.push_str(remainder);
    }

    result
}

/// Append `directConnection=true` (if requested and not already present) and
/// `serverSelectionTimeoutMS=30000` (if not already present) to a URI's query
/// string. Operates after [`strip_path_database`], whose output is always
/// either the original `uri` unchanged (no path / empty path segment) or
/// normalized to `scheme://authority/?query`, so the only shapes reaching
/// here are "no path at all", "bare trailing slash", and "slash with query".
fn append_tool_query_params(uri: &str, direct_connection: bool) -> String {
    let scheme_end = match uri.find("://") {
        Some(idx) => idx + 3,
        None => return uri.to_string(),
    };
    let rest = &uri[scheme_end..];
    let after_authority_idx = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..after_authority_idx];
    let after_authority = &rest[after_authority_idx..];

    let query_and_frag = match after_authority.find('?') {
        Some(q_idx) => &after_authority[q_idx + 1..],
        None => "",
    };
    let frag_idx = query_and_frag.find('#').unwrap_or(query_and_frag.len());
    let query = &query_and_frag[..frag_idx];
    let fragment = &query_and_frag[frag_idx..];

    let has_direct_connection =
        query.split('&').any(|p| query_param_has_key(p, "directConnection"));
    let has_timeout =
        query.split('&').any(|p| query_param_has_key(p, "serverSelectionTimeoutMS"));

    let mut extra: Vec<&str> = Vec::new();
    if direct_connection && !has_direct_connection {
        extra.push("directConnection=true");
    }
    if !has_timeout {
        extra.push("serverSelectionTimeoutMS=30000");
    }

    if extra.is_empty() {
        return uri.to_string();
    }

    let mut result = String::with_capacity(uri.len() + 64);
    result.push_str(&uri[..scheme_end]);
    result.push_str(authority);
    result.push('/');
    result.push('?');
    if query.is_empty() {
        result.push_str(&extra.join("&"));
    } else {
        result.push_str(query);
        result.push('&');
        result.push_str(&extra.join("&"));
    }
    result.push_str(fragment);
    result
}

/// Strip TLS-relaxation parameters the MongoDB Database Tools don't support
/// in connection strings and return the equivalent command-line flag.
///
/// The app's Rust driver honors `tlsAllowInvalidCertificates=true` in the
/// URI, but mongodump/mongorestore print "ignoring unsupported URI parameter"
/// and enforce full certificate validation — against a cluster with
/// self-signed certs every handshake then fails and server selection hangs
/// until timeout. `--tlsInsecure` disables certificate and hostname
/// validation, covering all three URI spellings. Option names are matched
/// case-insensitively per the connection-string spec.
pub fn extract_unsupported_tls_params(uri: &str) -> (String, Vec<String>) {
    let query_start = match uri.find('?') {
        Some(idx) => idx,
        None => return (uri.to_string(), Vec::new()),
    };
    let after_q = &uri[query_start + 1..];
    let frag_idx = after_q.find('#').unwrap_or(after_q.len());
    let query = &after_q[..frag_idx];
    let fragment = &after_q[frag_idx..];

    let mut insecure = false;
    let mut matched_any = false;
    let kept: Vec<&str> = query
        .split('&')
        .filter(|param| {
            let key = param.split('=').next().unwrap_or("");
            let is_tls_relax = key.eq_ignore_ascii_case("tlsInsecure")
                || key.eq_ignore_ascii_case("tlsAllowInvalidCertificates")
                || key.eq_ignore_ascii_case("tlsAllowInvalidHostnames");
            if is_tls_relax {
                matched_any = true;
                let value = param.split_once('=').map(|(_, v)| v).unwrap_or("");
                if value.eq_ignore_ascii_case("true") {
                    insecure = true;
                }
            }
            !is_tls_relax
        })
        .collect();

    if !matched_any {
        return (uri.to_string(), Vec::new());
    }

    let mut result = String::with_capacity(uri.len());
    result.push_str(&uri[..query_start]);
    if !kept.is_empty() {
        result.push('?');
        result.push_str(&kept.join("&"));
    }
    result.push_str(fragment);

    let flags = if insecure { vec!["--tlsInsecure".to_string()] } else { Vec::new() };
    (result, flags)
}

/// A single line of progress parsed from mongodump/mongorestore stderr.
#[derive(Clone, Debug)]
pub enum ToolProgress {
    NamespaceDone { ns: String, docs: u64 },
    Info(String),
}

fn parse_ns_docs(rest: &str) -> Option<ToolProgress> {
    let paren_idx = rest.find(" (")?;
    let ns = rest[..paren_idx].to_string();
    let after_paren = &rest[paren_idx + 2..];
    let digits_end = after_paren.find(' ')?;
    let docs: u64 = after_paren[..digits_end].parse().ok()?;
    Some(ToolProgress::NamespaceDone { ns, docs })
}

/// Parse one line of mongodump/mongorestore stderr output into a
/// [`ToolProgress`] event, or `None` if the line carries no progress
/// information we understand.
pub fn parse_tool_progress(line: &str) -> Option<ToolProgress> {
    let content = match line.find('\t') {
        Some(idx) => &line[idx + 1..],
        None => line,
    };

    if let Some(rest) = content.strip_prefix("done dumping ") {
        return parse_ns_docs(rest);
    }
    if let Some(rest) = content.strip_prefix("finished restoring ") {
        return parse_ns_docs(rest);
    }
    if let Some(rest) = content.strip_prefix("writing ") {
        let ns = rest.split(" to ").next()?;
        return Some(ToolProgress::Info(format!("writing {}", ns)));
    }
    if content.contains("document(s)") {
        return Some(ToolProgress::Info(content.to_string()));
    }
    // Periodic in-flight progress for one namespace, e.g.
    // "[########................]  sales.orders  12345/50000  (24.7%)"
    // (mongorestore reports bytes instead of documents; pass both through).
    if let Some(rest) = content.strip_prefix('[').and_then(|r| r.split_once(']')) {
        let progress = rest.1.split_whitespace().collect::<Vec<_>>().join(" ");
        if !progress.is_empty() {
            return Some(ToolProgress::Info(progress));
        }
    }

    None
}

/// Look up the normalized connection URI (post-SSH-tunnel rewrite) stashed by
/// `connect_db_impl` for a real connection. Mock connections are never
/// inserted into `conn_uris`, so they — and unknown ids — fail here.
pub fn resolve_conn_uri(state: &AppState, id: &str) -> Result<String, String> {
    let conn_uris = state.conn_uris.lock_safe()?;
    conn_uris
        .get(id)
        .cloned()
        .ok_or_else(|| "Connection not found".to_string())
}

/// Resolve the real connection URI for a dump/restore task, rejecting mock
/// connections with a friendlier message than the bare `resolve_conn_uri`
/// "Connection not found" (mocks are never in `conn_uris`, but we want a
/// specific error for "you picked a mock" vs. "that id doesn't exist").
fn require_real_conn_uri(state: &AppState, id: &str) -> Result<String, String> {
    let is_mock = state.mocks.lock_safe()?.get(id).copied().unwrap_or(false);
    if is_mock {
        return Err(
            "MongoDB Database Tools require a real connection, not a mock connection".to_string(),
        );
    }
    resolve_conn_uri(state, id)
}

fn basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn dump_destination(target: &DumpTarget) -> &str {
    match target {
        DumpTarget::Folder { out } => out,
        DumpTarget::Archive { file } => file,
    }
}

fn restore_source_path(source: &RestoreSource) -> &str {
    match source {
        RestoreSource::Folder { dir } => dir,
        RestoreSource::Archive { file } => file,
    }
}

fn dump_scope_desc(scope: &DumpScope) -> String {
    match scope {
        DumpScope::Server => "server".to_string(),
        DumpScope::Db { db } => db.clone(),
        DumpScope::Collection { db, coll } => format!("{}.{}", db, coll),
    }
}

/// Write the temp YAML config mongodump/mongorestore read the URI from
/// (`--uri` on the command line would leak the password via `ps`). 0600 on
/// unix; Windows' default per-user temp-dir ACLs are adequate as-is.
fn write_tool_config(uri: &str) -> Result<tempfile::NamedTempFile, String> {
    let mut file = tempfile::NamedTempFile::new()
        .map_err(|e| format!("Failed to create temp config file: {}", e))?;
    // Escape backslashes and double quotes so a URI containing either can't break out
    // of the YAML double-quoted scalar (or, worst case, inject extra YAML keys).
    let escaped_uri = uri.replace('\\', "\\\\").replace('"', "\\\"");
    writeln!(file, "uri: \"{}\"", escaped_uri)
        .map_err(|e| format!("Failed to write temp config file: {}", e))?;
    file.flush().map_err(|e| format!("Failed to write temp config file: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to set temp config file permissions: {}", e))?;
    }
    Ok(file)
}

const STDERR_TAIL_LINES: usize = 10;

enum ToolOutcome {
    Success(u64),
    Cancelled,
}

/// Spawn `tool_path` with `args` plus a `--config` pointing at a temp file
/// holding `uri`, streaming stderr for progress while polling `cancel` every
/// 250ms. The config file guard is kept alive for the whole process lifetime.
async fn run_tool_process(
    tasks: &Arc<Mutex<HashMap<String, TaskInfo>>>,
    task_id: &str,
    cancel: &Arc<AtomicBool>,
    tool_path: &str,
    args: &[String],
    uri: &str,
    direct_connection: bool,
) -> Result<ToolOutcome, String> {
    // mongodump/mongorestore treat a URI path database as a db selector that
    // conflicts with --db/--collection/--nsInclude; strip it (preserving auth
    // semantics via authSource) before it reaches the tool's config file.
    // Also append directConnection/serverSelectionTimeoutMS so a tunneled
    // connection doesn't chase replica-set members' unreachable real IPs
    // forever — see `prepare_tool_uri`.
    let prepared_uri = prepare_tool_uri(uri, direct_connection);
    // TLS-relaxation params must travel as flags — the tools ignore them in
    // the URI and then fail certificate validation (see the extractor's docs).
    let (prepared_uri, tls_flags) = extract_unsupported_tls_params(&prepared_uri);
    let cfg = write_tool_config(&prepared_uri)?;

    let mut child = tokio::process::Command::new(tool_path)
        .args(args)
        .args(&tls_flags)
        .arg("--config")
        .arg(cfg.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", tool_path, e))?;

    // The tool is alive from here on — say so immediately, and keep saying so
    // (with elapsed time) until it reports real progress. mongodump can sit
    // silent for its whole connect/server-selection phase; without this the
    // task looks stuck on its initial message even though the process runs.
    // The redacted URI goes on the sub label so a connection that hangs or
    // fails can be diagnosed against what the tool was actually given.
    let tool_name = basename(tool_path);
    let mut invocation = redact_uri_password(&prepared_uri);
    if !tls_flags.is_empty() {
        invocation.push(' ');
        invocation.push_str(&tls_flags.join(" "));
    }
    update_task(tasks, task_id, |t| {
        t.message = format!("{} started — connecting…", tool_name);
        t.sub_label = Some(invocation);
    });
    let started_at = std::time::Instant::now();
    let mut had_progress = false;
    let mut saw_line = false;

    let stderr = child.stderr.take().expect("stderr is piped");
    let mut reader = BufReader::new(stderr);
    let mut line_buf: Vec<u8> = Vec::new();
    let mut tail: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL_LINES);
    let mut processed: u64 = 0;
    let mut poll = tokio::time::interval(Duration::from_millis(250));
    // Set once the child has exited while the pipe is still open — a
    // grandchild that inherited the stderr write end would otherwise delay
    // EOF (and so task completion) until IT exits.
    let mut exited: Option<(std::process::ExitStatus, std::time::Instant)> = None;

    let cancelled = loop {
        tokio::select! {
            // Raw bytes + lossy decode rather than next_line(): the tools can
            // echo non-UTF-8 bytes (server errors, locale output), and
            // next_line() turns that into a stream error — breaking this loop
            // with the pipe undrained, which wedges the wait below.
            read = reader.read_until(b'\n', &mut line_buf) => {
                match read {
                    // EOF with nothing buffered (a final unterminated line
                    // still arrives as Ok(n > 0) and is processed below).
                    Ok(0) if line_buf.is_empty() => break false,
                    Ok(_) => {
                        let mut l = String::from_utf8_lossy(&line_buf).into_owned();
                        line_buf.clear();
                        while l.ends_with('\n') || l.ends_with('\r') {
                            l.pop();
                        }
                        saw_line = true;
                        if tail.len() == STDERR_TAIL_LINES {
                            tail.pop_front();
                        }
                        tail.push_back(l.clone());
                        match parse_tool_progress(&l) {
                            Some(ToolProgress::NamespaceDone { ns, docs }) => {
                                processed += 1;
                                had_progress = true;
                                update_task(tasks, task_id, |t| {
                                    t.processed = processed;
                                    t.message = format!("{} done ({} documents)", ns, docs);
                                });
                            }
                            Some(ToolProgress::Info(msg)) => {
                                had_progress = true;
                                update_task(tasks, task_id, |t| t.message = msg);
                            }
                            None => {
                                // Until real progress arrives, raw stderr (driver
                                // warnings, connection failures) is the only signal
                                // the user has — surface it (passwords redacted)
                                // rather than dropping it.
                                if !had_progress {
                                    let content =
                                        l.split_once('\t').map(|(_, c)| c).unwrap_or(l.as_str());
                                    let msg: String =
                                        redact_uris_in_text(content).chars().take(200).collect();
                                    if !msg.trim().is_empty() {
                                        update_task(tasks, task_id, |t| t.message = msg);
                                    }
                                }
                            }
                        }
                    }
                    Err(_) => break false,
                }
            }
            _ = poll.tick() => {
                if cancel.load(Ordering::SeqCst) {
                    let _ = child.kill().await;
                    break true;
                }
                if !had_progress && !saw_line {
                    let secs = started_at.elapsed().as_secs();
                    if secs >= 2 {
                        update_task(tasks, task_id, |t| {
                            t.message =
                                format!("{} running — waiting for server ({}s)", tool_name, secs);
                        });
                    }
                }
                // Detect the child exiting while the pipe stays open; after a
                // short grace for buffered output, stop reading — EOF may
                // never come if something else inherited the write end.
                match exited {
                    None => {
                        if let Ok(Some(status)) = child.try_wait() {
                            exited = Some((status, std::time::Instant::now()));
                        }
                    }
                    Some((_, at)) if at.elapsed() >= Duration::from_millis(500) => break false,
                    Some(_) => {}
                }
            }
        }
    };

    if cancelled {
        let _ = child.wait().await;
        return Ok(ToolOutcome::Cancelled);
    }

    // The tool can close stderr while still running; a bare wait() here would
    // leave the task uncancellable from that point on. Keep polling the
    // cancel flag (killing on cancel) until the process actually exits —
    // unless the exit was already observed above.
    let status = if let Some((status, _)) = exited {
        status
    } else {
        loop {
            tokio::select! {
                status = child.wait() => {
                    break status.map_err(|e| format!("Failed to wait for {}: {}", tool_path, e))?;
                }
                _ = poll.tick() => {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        return Ok(ToolOutcome::Cancelled);
                    }
                }
            }
        }
    };

    if status.success() {
        Ok(ToolOutcome::Success(processed))
    } else {
        let msg: Vec<String> = tail.into_iter().collect();
        if msg.is_empty() {
            Err(format!("{} exited with {}", tool_path, status))
        } else {
            // The tail is raw stderr — it can quote the connection string
            // (the redacted variant only goes on the sub label).
            Err(redact_uris_in_text(&msg.join("\n")))
        }
    }
}

/// Drive one dump/restore task to completion: run the tool, update task
/// status on every exit path (success/failure/cancel), and always clean up
/// the cancel-flag entry.
#[allow(clippy::too_many_arguments)]
async fn run_tool_task(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    task_id: String,
    cancel: Arc<AtomicBool>,
    tool_path: String,
    args: Vec<String>,
    uri: String,
    direct_connection: bool,
    verb: &'static str,
) {
    let outcome =
        run_tool_process(&tasks, &task_id, &cancel, &tool_path, &args, &uri, direct_connection)
            .await;
    match outcome {
        Ok(ToolOutcome::Success(processed)) => {
            finish_task(&tasks, &task_id, processed, format!("{} complete", verb));
        }
        Ok(ToolOutcome::Cancelled) => {
            update_task(&tasks, &task_id, |t| {
                t.status = "cancelled".to_string();
                t.message = "Cancelled".to_string();
                t.finished_at_ms = Some(now_ms());
            });
            crate::db::tasks::prune_tasks(&tasks);
        }
        Err(err) => fail_task(&tasks, &task_id, err),
    }
    if let Ok(mut guard) = cancels.lock() {
        guard.remove(&task_id);
    }
}

/// Start a `mongodump` background task for a real (non-mock) connection.
pub async fn start_dump_task_impl(
    state: &AppState,
    id: &str,
    tool_path: &str,
    options: DumpOptions,
) -> Result<TaskInfo, String> {
    let uri = require_real_conn_uri(state, id)?;
    let tunneled = state.ssh_tunnels.lock_safe()?.contains_key(id);
    let args = build_dump_args(&options)?;
    let dest = dump_destination(&options.target).to_string();
    let label = format!("Dump {} \u{2192} {}", dump_scope_desc(&options.scope), basename(&dest));

    let task_id = Uuid::new_v4().to_string();
    let task = TaskInfo {
        id: task_id.clone(),
        kind: "dump".to_string(),
        label,
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Starting mongodump…".to_string(),
        path: Some(dest),
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
        sub_label: None,
        items_processed: None,
        items_total: None,
        summary: None,
    };
    state.tasks.lock_safe()?.insert(task_id.clone(), task.clone());
    let cancel = state.register_cancel(&task_id);

    let tasks = state.tasks.clone();
    let cancels = state.cancels.clone();
    let tool_path = tool_path.to_string();
    let task_id2 = task_id.clone();
    tokio::spawn(async move {
        run_tool_task(tasks, cancels, task_id2, cancel, tool_path, args, uri, tunneled, "Dump")
            .await;
    });

    Ok(task)
}

/// Start a `mongorestore` background task for a real (non-mock) connection.
pub async fn start_restore_task_impl(
    state: &AppState,
    id: &str,
    tool_path: &str,
    options: RestoreOptions,
) -> Result<TaskInfo, String> {
    let uri = require_real_conn_uri(state, id)?;
    let tunneled = state.ssh_tunnels.lock_safe()?.contains_key(id);
    let args = build_restore_args(&options)?;
    let source = restore_source_path(&options.source).to_string();
    let label = format!("Restore {}", basename(&source));

    let task_id = Uuid::new_v4().to_string();
    let task = TaskInfo {
        id: task_id.clone(),
        kind: "restore".to_string(),
        label,
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Starting mongorestore…".to_string(),
        path: Some(source),
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
        sub_label: None,
        items_processed: None,
        items_total: None,
        summary: None,
    };
    state.tasks.lock_safe()?.insert(task_id.clone(), task.clone());
    let cancel = state.register_cancel(&task_id);

    let tasks = state.tasks.clone();
    let cancels = state.cancels.clone();
    let tool_path = tool_path.to_string();
    let task_id2 = task_id.clone();
    tokio::spawn(async move {
        run_tool_task(tasks, cancels, task_id2, cancel, tool_path, args, uri, tunneled, "Restore")
            .await;
    });

    Ok(task)
}

/// One collection discovered under `<dump-root>/<db>/`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpCollection {
    pub name: String,
    pub has_metadata: bool,
    pub gzip: bool,
}

/// One database directory discovered under a dump root.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpDb {
    pub name: String,
    pub collections: Vec<DumpCollection>,
}

/// The full tree of databases/collections found under a dump folder, for the
/// restore UI's namespace picker.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpTree {
    pub dbs: Vec<DumpDb>,
}

#[derive(Default)]
struct CollAccum {
    has_data: bool,
    gzip: bool,
    has_metadata: bool,
}

fn scan_dump_db_dir(dir: &std::path::Path) -> Result<Vec<DumpCollection>, String> {
    let mut acc: HashMap<String, CollAccum> = HashMap::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read dump folder: {}", e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(base) = name.strip_suffix(".metadata.json.gz") {
            acc.entry(base.to_string()).or_default().has_metadata = true;
        } else if let Some(base) = name.strip_suffix(".metadata.json") {
            acc.entry(base.to_string()).or_default().has_metadata = true;
        } else if let Some(base) = name.strip_suffix(".bson.gz") {
            let e = acc.entry(base.to_string()).or_default();
            e.has_data = true;
            e.gzip = true;
        } else if let Some(base) = name.strip_suffix(".bson") {
            acc.entry(base.to_string()).or_default().has_data = true;
        }
    }
    let mut collections: Vec<DumpCollection> = acc
        .into_iter()
        .filter(|(_, v)| v.has_data)
        .map(|(name, v)| DumpCollection { name, has_metadata: v.has_metadata, gzip: v.gzip })
        .collect();
    collections.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(collections)
}

/// Scan a mongodump output folder into a [`DumpTree`]: one entry per
/// `<db>/<coll>.bson[.gz]` pair found, `hasMetadata` set when the matching
/// `<coll>.metadata.json[.gz]` sidecar exists. Non-directories at the root
/// and files that don't match the `.bson`/`.metadata.json` shape are skipped.
pub async fn browse_dump_folder_impl(path: &str) -> Result<DumpTree, String> {
    let root = std::path::Path::new(path);
    let entries =
        std::fs::read_dir(root).map_err(|e| format!("Failed to read dump folder: {}", e))?;

    let mut dbs = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let collections = scan_dump_db_dir(&entry.path())?;
        dbs.push(DumpDb { name, collections });
    }
    dbs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(DumpTree { dbs })
}

/// Render the shell-ish command a preview panel shows the user (the real
/// runner never invokes a shell — this is display-only).
pub fn preview_tool_command(tool_path: &str, redacted_uri: &str, args: &[String]) -> String {
    format!("{} --uri={} {}", tool_path, redacted_uri, args.join(" "))
}

/// A discovered `mongodump`/`mongorestore` executable.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub path: String,
    pub version: String,
}

/// Discovery result for both MongoDB Database Tools binaries.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    pub mongodump: Option<ToolInfo>,
    pub mongorestore: Option<ToolInfo>,
}

/// Run `<candidate> --version` and, if it succeeds, return the first line of
/// stdout (trimmed) as the version string. Any spawn failure or non-zero-ish
/// output is treated as "not this candidate" rather than an error.
fn probe_tool(candidate: &std::path::Path) -> Option<ToolInfo> {
    let output = std::process::Command::new(candidate)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Some tool builds print `--version` output to stderr instead of stdout;
    // fall back deliberately rather than treating that as "not this candidate".
    let text = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout)
    } else {
        String::from_utf8_lossy(&output.stderr)
    };
    let version = text.lines().next()?.trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some(ToolInfo { path: candidate.to_string_lossy().to_string(), version })
}

fn binary_name(tool: &str) -> String {
    if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    }
}

/// Locate one tool: prefer `configured_dir` if given (and it works), then
/// `managed_dir` (the app-managed install's bin directory), else walk `PATH`.
fn locate_tool(tool: &str, configured_dir: Option<&str>, managed_dir: Option<&Path>) -> Option<ToolInfo> {
    let name = binary_name(tool);

    if let Some(dir) = configured_dir {
        let candidate = std::path::Path::new(dir).join(&name);
        if let Some(info) = probe_tool(&candidate) {
            return Some(info);
        }
    }

    if let Some(dir) = managed_dir {
        let candidate = dir.join(&name);
        if let Some(info) = probe_tool(&candidate) {
            return Some(info);
        }
    }

    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(&name);
        if let Some(info) = probe_tool(&candidate) {
            return Some(info);
        }
    }

    None
}

/// Detect `mongodump` and `mongorestore` on disk. Probe order: `configured_dir`
/// (used only if the tool actually runs there), then `managed_dir` (the
/// app-managed install's bin directory), then `PATH`.
pub fn detect_mongo_tools(configured_dir: Option<&str>, managed_dir: Option<&Path>) -> ToolsStatus {
    ToolsStatus {
        mongodump: locate_tool("mongodump", configured_dir, managed_dir),
        mongorestore: locate_tool("mongorestore", configured_dir, managed_dir),
    }
}

/// Test-only helper for spawning a throwaway shell script in place of a real
/// `mongodump`/`mongorestore` binary, exposed to `tests.rs` (outside this
/// module) via `pub mod test_support`.
#[cfg(test)]
pub mod test_support {
    #[cfg(unix)]
    pub fn write_fake_tool(script_body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!(
            "mqlens-fake-tool-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::write(&path, format!("#!/bin/sh\n{}", script_body)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump_defaults(scope: DumpScope) -> DumpOptions {
        DumpOptions {
            scope,
            target: DumpTarget::Folder { out: "/tmp/dump".into() },
            gzip: true,
            query: None,
            force_table_scan: false,
            dump_users_and_roles: false,
            oplog: false,
        }
    }

    #[test]
    fn dump_args_collection_scope_with_query() {
        let mut o = dump_defaults(DumpScope::Collection { db: "sales".into(), coll: "orders".into() });
        o.query = Some(r#"{"status":"open"}"#.into());
        o.force_table_scan = true;
        let args = build_dump_args(&o).unwrap();
        assert_eq!(
            args,
            [
                "--db=sales", "--collection=orders",
                "--out=/tmp/dump", "--gzip",
                r#"--query={"status":"open"}"#, "--forceTableScan",
            ].iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn dump_args_archive_server_with_oplog() {
        let mut o = dump_defaults(DumpScope::Server);
        o.target = DumpTarget::Archive { file: "/tmp/all.archive.gz".into() };
        o.oplog = true;
        let args = build_dump_args(&o).unwrap();
        assert_eq!(args, ["--archive=/tmp/all.archive.gz", "--gzip", "--oplog"]
            .iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn dump_args_legality() {
        let mut o = dump_defaults(DumpScope::Db { db: "sales".into() });
        o.oplog = true;
        assert!(build_dump_args(&o).unwrap_err().contains("whole-server"));
        let mut o = dump_defaults(DumpScope::Server);
        o.dump_users_and_roles = true;
        assert!(build_dump_args(&o).unwrap_err().contains("database scope"));
        let mut o = dump_defaults(DumpScope::Db { db: "sales".into() });
        o.query = Some("{}".into());
        assert!(build_dump_args(&o).unwrap_err().contains("collection scope"));
        let mut o = dump_defaults(DumpScope::Server);
        o.target = DumpTarget::Folder { out: "".into() };
        assert!(build_dump_args(&o).unwrap_err().contains("destination"));
    }

    fn restore_defaults(source: RestoreSource) -> RestoreOptions {
        RestoreOptions {
            source, gzip: false, selections: vec![], filter_db: None, filter_coll: None,
            drop: false, keep_index_version: false, no_index_restore: false,
            no_options_restore: false, maintain_insertion_order: false, stop_on_error: false,
            bypass_document_validation: false, restore_db_users_and_roles: false,
            oplog_replay: false,
        }
    }

    #[test]
    fn restore_args_folder_selection_and_rename() {
        let mut o = restore_defaults(RestoreSource::Folder { dir: "/tmp/dump".into() });
        o.gzip = true;
        o.drop = true;
        o.selections = vec![
            NsSelection { db: "sales".into(), coll: "orders".into(), rename_to: None },
            NsSelection { db: "sales".into(), coll: "users".into(), rename_to: Some("crm.people".into()) },
        ];
        let args = build_restore_args(&o).unwrap();
        assert_eq!(
            args,
            [
                "--gzip", "--drop",
                "--nsInclude=sales.orders",
                "--nsInclude=sales.users", "--nsFrom=sales.users", "--nsTo=crm.people",
                "--dir=/tmp/dump",
            ].iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn restore_args_bare_rename_is_qualified_with_source_db() {
        // --nsTo requires a full db.collection namespace; a bare collection
        // name from the UI must be qualified with the selection's db.
        let mut o = restore_defaults(RestoreSource::Folder { dir: "/tmp/dump".into() });
        o.selections = vec![
            NsSelection { db: "sales".into(), coll: "users".into(), rename_to: Some("people".into()) },
        ];
        let args = build_restore_args(&o).unwrap();
        assert_eq!(
            args,
            [
                "--nsInclude=sales.users", "--nsFrom=sales.users", "--nsTo=sales.people",
                "--dir=/tmp/dump",
            ].iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn restore_args_archive_filters_and_legality() {
        let mut o = restore_defaults(RestoreSource::Archive { file: "/tmp/a.archive".into() });
        o.filter_db = Some("sales".into());
        let args = build_restore_args(&o).unwrap();
        assert_eq!(args, ["--archive=/tmp/a.archive", "--nsInclude=sales.*"]
            .iter().map(|s| s.to_string()).collect::<Vec<_>>());

        let mut o = restore_defaults(RestoreSource::Archive { file: "/tmp/a.archive".into() });
        o.filter_coll = Some("orders".into());
        assert!(build_restore_args(&o).unwrap_err().contains("requires a database"));

        let mut o = restore_defaults(RestoreSource::Folder { dir: "/tmp/dump".into() });
        o.oplog_replay = true;
        o.selections = vec![NsSelection { db: "a".into(), coll: "b".into(), rename_to: None }];
        assert!(build_restore_args(&o).unwrap_err().contains("namespace filters"));

        let mut o = restore_defaults(RestoreSource::Folder { dir: "/tmp/dump".into() });
        o.restore_db_users_and_roles = true; // zero selections = all dbs → illegal
        assert!(build_restore_args(&o).unwrap_err().contains("single database"));
    }

    #[test]
    fn redacts_password_only_when_present() {
        assert_eq!(
            redact_uri_password("mongodb://alice:s3cr3t@host:27017/db?x=1"),
            "mongodb://alice:***@host:27017/db?x=1"
        );
        assert_eq!(redact_uri_password("mongodb://host:27017"), "mongodb://host:27017");
        assert_eq!(
            redact_uri_password("mongodb+srv://u:p%40ss@cluster.example.com"),
            "mongodb+srv://u:***@cluster.example.com"
        );
    }

    #[test]
    fn redacts_uris_in_free_text() {
        // Non-URI-ish text passes through untouched (whitespace preserved).
        assert_eq!(redact_uris_in_text("plain error  text"), "plain error  text");
        // Any token containing "://" gets its password redacted in place.
        assert_eq!(
            redact_uris_in_text("connect failed: mongodb://u:s3cr3t@h:27017/db timed out"),
            "connect failed: mongodb://u:***@h:27017/db timed out"
        );
        // Multi-line text (the joined stderr tail) is redacted across lines.
        assert_eq!(
            redact_uris_in_text("line one\nerror at mongodb+srv://a:pw@c.example.com\nline three"),
            "line one\nerror at mongodb+srv://a:***@c.example.com\nline three"
        );
    }

    #[test]
    fn prepare_tool_uri_no_path_adds_default_timeout_only() {
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017", false),
            "mongodb://h:27017/?serverSelectionTimeoutMS=30000"
        );
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017/", false),
            "mongodb://h:27017/?serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_strips_path_db_and_sets_authsource() {
        assert_eq!(
            prepare_tool_uri("mongodb://u:p@h:27017/admin", false),
            "mongodb://u:p@h:27017/?authSource=admin&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_strips_path_db_preserving_existing_query() {
        assert_eq!(
            prepare_tool_uri("mongodb://u:p@h:27017/admin?replicaSet=rs0", false),
            "mongodb://u:p@h:27017/?replicaSet=rs0&authSource=admin&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_does_not_duplicate_existing_authsource() {
        assert_eq!(
            prepare_tool_uri("mongodb://h/mydb?authSource=admin", false),
            "mongodb://h/?authSource=admin&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_matches_authsource_case_insensitively() {
        // Connection-string keys are case-insensitive per the spec; a
        // lowercase authsource must not gain a conflicting duplicate (the Go
        // tools take last-one-wins, which would flip the auth database).
        assert_eq!(
            prepare_tool_uri("mongodb://h/mydb?authsource=admin", false),
            "mongodb://h/?authsource=admin&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_matches_timeout_case_insensitively() {
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017/?serverselectiontimeoutms=5000", false),
            "mongodb://h:27017/?serverselectiontimeoutms=5000"
        );
    }

    #[test]
    fn prepare_tool_uri_matches_direct_connection_case_insensitively() {
        // The user's explicit (lowercase) directconnection=false must win
        // over the tunnel default, exactly like the canonical spelling.
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017/?directconnection=false", true),
            "mongodb://h:27017/?directconnection=false&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_handles_mongodb_srv_scheme() {
        assert_eq!(
            prepare_tool_uri("mongodb+srv://u:p@cluster.example.com/admin", false),
            "mongodb+srv://u:p@cluster.example.com/?authSource=admin&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_ignores_percent_encoded_credentials() {
        // Percent-encoded '@' and '/' inside userinfo must not confuse the
        // authority-window parse (same technique as redact_uri_password).
        assert_eq!(
            prepare_tool_uri("mongodb://user:p%40ss%2Fx@h:27017/admin", false),
            "mongodb://user:p%40ss%2Fx@h:27017/?authSource=admin&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_empty_path_segment_gets_default_timeout() {
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017/?x=1", false),
            "mongodb://h:27017/?x=1&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_tunneled_appends_direct_connection_and_timeout() {
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017", true),
            "mongodb://h:27017/?directConnection=true&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_tunneled_respects_explicit_direct_connection_false() {
        // The user's own config wins — never override an explicit setting.
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017/?directConnection=false", true),
            "mongodb://h:27017/?directConnection=false&serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_not_tunneled_omits_direct_connection() {
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017", false),
            "mongodb://h:27017/?serverSelectionTimeoutMS=30000"
        );
    }

    #[test]
    fn prepare_tool_uri_existing_timeout_is_untouched() {
        assert_eq!(
            prepare_tool_uri("mongodb://h:27017/?serverSelectionTimeoutMS=5000", false),
            "mongodb://h:27017/?serverSelectionTimeoutMS=5000"
        );
    }

    #[test]
    fn prepare_tool_uri_tunneled_combines_with_path_db_strip() {
        assert_eq!(
            prepare_tool_uri("mongodb://u:p@127.0.0.1:33445/admin", true),
            "mongodb://u:p@127.0.0.1:33445/?authSource=admin&directConnection=true&serverSelectionTimeoutMS=30000"
        );
    }

    #[cfg(unix)]
    #[test]
    fn detects_tool_from_configured_dir_before_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("mqlens-tools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tool = dir.join("mongodump");
        std::fs::write(&tool, "#!/bin/sh\necho 'mongodump version: 100.9.9'\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();

        let status = detect_mongo_tools(Some(dir.to_str().unwrap()), None);
        let info = status.mongodump.expect("configured dir should win");
        assert_eq!(info.path, tool.to_string_lossy());
        assert!(info.version.contains("100.9.9"));
        // mongorestore is absent from the dir; whatever PATH yields is acceptable — no assert.
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_tool_config_escapes_backslash_and_quote() {
        let uri = r#"mongodb://user:p"a\ss@host:27017/db"#;
        let file = write_tool_config(uri).unwrap();
        let contents = std::fs::read_to_string(file.path()).unwrap();
        assert_eq!(contents, "uri: \"mongodb://user:p\\\"a\\\\ss@host:27017/db\"\n");
    }

    #[cfg(unix)]
    #[test]
    fn probe_tool_rejects_failing_binary() {
        let tool = crate::db::mongotools::test_support::write_fake_tool(
            "echo 'mongodump version: 100.9.9'\nexit 1\n",
        );
        assert!(
            probe_tool(&tool).is_none(),
            "a binary that prints a version line but exits non-zero must not be detected"
        );
        let _ = std::fs::remove_file(&tool);
    }

    #[test]
    fn missing_tools_yield_none() {
        let status = detect_mongo_tools(Some("/definitely/not/a/dir"), None);
        // Tools may still be found on PATH in dev machines; only assert the configured-dir miss
        // falls back rather than erroring.
        let _ = status; // structural smoke: no panic; None-vs-Some depends on the machine
    }

    #[cfg(unix)]
    #[test]
    fn detect_prefers_configured_then_managed_then_path() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!(
            "mqlens-tools-order-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));

        // Stub mongodump printing "version: 1" in dirA (configured).
        let configured_dir = base.join("configured");
        std::fs::create_dir_all(&configured_dir).unwrap();
        let configured_tool = configured_dir.join("mongodump");
        std::fs::write(&configured_tool, "#!/bin/sh\necho 'mongodump version: 1'\n").unwrap();
        std::fs::set_permissions(&configured_tool, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Another stub printing "version: 2" in {tmp_app_data}/tools/database-tools-100.17.0/bin (managed).
        let managed_dir = base.join("tools/database-tools-100.17.0/bin");
        std::fs::create_dir_all(&managed_dir).unwrap();
        let managed_tool = managed_dir.join("mongodump");
        std::fs::write(&managed_tool, "#!/bin/sh\necho 'mongodump version: 2'\n").unwrap();
        std::fs::set_permissions(&managed_tool, std::fs::Permissions::from_mode(0o755)).unwrap();

        // configured=Some(dirA) -> version 1
        let status = detect_mongo_tools(Some(configured_dir.to_str().unwrap()), Some(managed_dir.as_path()));
        let info = status.mongodump.expect("configured dir should win");
        assert_eq!(info.path, configured_tool.to_string_lossy());
        assert!(info.version.contains("version: 1"), "{:?}", info.version);

        // configured=None, managed=Some -> version 2
        let status = detect_mongo_tools(None, Some(managed_dir.as_path()));
        let info = status.mongodump.expect("managed dir should be used when configured is absent");
        assert_eq!(info.path, managed_tool.to_string_lossy());
        assert!(info.version.contains("version: 2"), "{:?}", info.version);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parses_tool_progress_lines() {
        let l = "2026-07-03T12:00:00.000+0200\tdone dumping sales.orders (1234 documents)";
        match parse_tool_progress(l) {
            Some(ToolProgress::NamespaceDone { ns, docs }) => {
                assert_eq!(ns, "sales.orders");
                assert_eq!(docs, 1234);
            }
            other => panic!("unexpected: {:?}", other.is_some()),
        }
        let l = "2026-07-03T12:00:01.000+0200\tfinished restoring sales.orders (99 documents, 0 failures)";
        assert!(matches!(parse_tool_progress(l), Some(ToolProgress::NamespaceDone { docs: 99, .. })));
        let l = "2026-07-03T12:00:02.000+0200\twriting sales.orders to /tmp/x.bson";
        assert!(matches!(parse_tool_progress(l), Some(ToolProgress::Info(_))));
        assert!(parse_tool_progress("random noise").is_none());
    }

    #[test]
    fn tls_insecure_uri_params_become_tool_flags() {
        // The database tools reject tlsAllowInvalidCertificates & friends as
        // URI parameters ("ignoring unsupported URI parameter") and then fail
        // TLS validation; they must be stripped and passed as --tlsInsecure.
        let (uri, flags) = extract_unsupported_tls_params(
            "mongodb://u:p@h1:27017,h2:27017/?replicaSet=rs&tls=true&tlsAllowInvalidCertificates=true&authSource=admin",
        );
        assert_eq!(
            uri,
            "mongodb://u:p@h1:27017,h2:27017/?replicaSet=rs&tls=true&authSource=admin"
        );
        assert_eq!(flags, vec!["--tlsInsecure".to_string()]);

        // All three spellings map to the one flag, deduplicated, and option
        // names match case-insensitively per the connection-string spec.
        let (uri, flags) = extract_unsupported_tls_params(
            "mongodb://h/?tlsinsecure=true&tlsAllowInvalidCertificates=TRUE&tlsAllowInvalidHostnames=true&x=1",
        );
        assert_eq!(uri, "mongodb://h/?x=1");
        assert_eq!(flags, vec!["--tlsInsecure".to_string()]);

        // =false still strips the param (the tools would warn) but adds no flag.
        let (uri, flags) =
            extract_unsupported_tls_params("mongodb://h/?tlsAllowInvalidCertificates=false&tls=true");
        assert_eq!(uri, "mongodb://h/?tls=true");
        assert!(flags.is_empty());

        // Nothing to do → URI unchanged.
        let (uri, flags) = extract_unsupported_tls_params("mongodb://h/?tls=true");
        assert_eq!(uri, "mongodb://h/?tls=true");
        assert!(flags.is_empty());

        // Removing the only param must not leave a dangling '?'.
        let (uri, flags) = extract_unsupported_tls_params("mongodb://h/?tlsInsecure=true");
        assert_eq!(uri, "mongodb://h/");
        assert_eq!(flags, vec!["--tlsInsecure".to_string()]);
    }

    #[test]
    fn parses_bracket_progress_bar_lines() {
        // mongodump/mongorestore periodic in-flight progress for one namespace.
        let l = "2026-07-10T12:00:00.000+0200\t[########................]  sales.orders  12345/50000  (24.7%)";
        match parse_tool_progress(l) {
            Some(ToolProgress::Info(msg)) => assert_eq!(msg, "sales.orders 12345/50000 (24.7%)"),
            other => panic!("unexpected: {:?}", other),
        }
        // mongorestore reports byte-based progress for large namespaces.
        let l = "ts\t[#.......................]  logs.events  10.5MB/28.7MB  (36.6%)";
        assert!(matches!(parse_tool_progress(l), Some(ToolProgress::Info(_))));
        // A bare bracket with nothing after it carries no information.
        assert!(parse_tool_progress("ts\t[####]").is_none());
    }

    fn dump_server_folder_opts(out: &str) -> DumpOptions {
        DumpOptions {
            scope: DumpScope::Server,
            target: DumpTarget::Folder { out: out.to_string() },
            gzip: false,
            query: None,
            force_table_scan: false,
            dump_users_and_roles: false,
            oplog: false,
        }
    }

    async fn wait_for_task(state: &AppState, task_id: &str) {
        // Generous budget: under full-suite process-spawn load even a trivial
        // task can take a while end to end. Returns as soon as it settles.
        for _ in 0..500 {
            let status = state.tasks.lock().unwrap().get(task_id).map(|t| t.status.clone());
            if status.as_deref() != Some("running") {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// Start a dump task and wait for proof the tool actually launched,
    /// riding out the classic fork/exec ETXTBSY race (under parallel test
    /// load a concurrently forked child can briefly hold the just-written
    /// fake tool's fd, failing the spawn with "Failed to start").
    ///
    /// "Launched" is detected via the runner's own post-spawn signal — the
    /// task message flips to "<tool> started — connecting…" — or any terminal
    /// state. A "Failed to start" failure retries with a fresh task; every
    /// other outcome is the test's real behavior and is returned as-is.
    async fn start_dump_task_retrying(
        state: &AppState,
        tool: &std::path::Path,
        out: &str,
    ) -> TaskInfo {
        for attempt in 0..10 {
            let task = start_dump_task_impl(
                state,
                "c1",
                tool.to_str().unwrap(),
                dump_server_folder_opts(out),
            )
            .await
            .unwrap();
            for _ in 0..500 {
                let snap = state.tasks.lock().unwrap().get(&task.id).cloned();
                if let Some(t) = snap {
                    if t.status == "failed"
                        && t.error.as_deref().unwrap_or("").contains("Failed to start")
                    {
                        break; // transient spawn race — retry with a fresh task
                    }
                    // Any message past the initial "Starting <tool>…" means the
                    // runner got beyond spawn — matching specific phrases races
                    // against surfaced stderr overwriting the message.
                    let spawned = t.status != "running"
                        || t.processed > 0
                        || !t.message.starts_with("Starting");
                    if spawned {
                        return task;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            eprintln!("fake-tool spawn raced (attempt {attempt}); retrying");
        }
        panic!("fake tool could not be spawned after retries");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_dump_task_success_parses_progress_and_cleans_up() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        let tool = crate::db::mongotools::test_support::write_fake_tool(
            "echo 'ts\tdone dumping a.x (5 documents)' 1>&2\n\
             echo 'ts\tdone dumping a.y (7 documents)' 1>&2\n\
             exit 0\n",
        );
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out").await;
        assert_eq!(task.kind, "dump");
        wait_for_task(&state, &task.id).await;
        let t = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(t.status, "completed");
        assert_eq!(t.processed, 2);
        assert!(state.cancels.lock().unwrap().get(&task.id).is_none(), "flag cleaned up");
        let _ = std::fs::remove_file(&tool);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_dump_task_failure_captures_stderr_tail() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        let tool = crate::db::mongotools::test_support::write_fake_tool(
            "echo 'boom line' 1>&2\n\
             echo 'cannot connect to mongodb://u:sekrit@h:27017/db' 1>&2\n\
             exit 3\n",
        );
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out2").await;
        wait_for_task(&state, &task.id).await;
        let t = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(t.status, "failed");
        let error = t.error.as_deref().unwrap_or("");
        assert!(error.contains("boom line"), "{:?}", t.error);
        // Raw stderr can quote the connection string — never with the password.
        assert!(error.contains("mongodb://u:***@h:27017/db"), "{:?}", t.error);
        assert!(!error.contains("sekrit"), "password must be redacted, got {:?}", t.error);
        assert!(state.cancels.lock().unwrap().get(&task.id).is_none(), "flag cleaned up");
        let _ = std::fs::remove_file(&tool);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_cancel_kills_the_tool() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        let tool = crate::db::mongotools::test_support::write_fake_tool(
            "echo 'ts\tdone dumping a.x (1 documents)' 1>&2\nsleep 30\n",
        );
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out3").await;

        // Wait until the fake tool has reported at least one namespace done.
        for _ in 0..100 {
            let processed = state.tasks.lock().unwrap().get(&task.id).map(|t| t.processed).unwrap_or(0);
            if processed >= 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        let started = std::time::Instant::now();
        assert!(state.request_cancel(&task.id), "task should be known to the cancel registry");
        wait_for_task(&state, &task.id).await;
        let elapsed = started.elapsed();

        let t = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(t.status, "cancelled");
        assert_eq!(t.message, "Cancelled");
        assert!(elapsed.as_secs() < 5, "cancel should be fast, took {:?}", elapsed);
        let _ = std::fs::remove_file(&tool);
    }

    /// A tool that produces no stderr for a while (mongodump stuck in server
    /// selection) must still tell the user the process has started, and then
    /// surface elapsed time instead of sitting on the initial message forever.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_dump_task_reports_process_start_and_elapsed() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        let tool = crate::db::mongotools::test_support::write_fake_tool("sleep 30\n");
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out4").await;
        assert_ne!(task.message, "Queued", "initial message should say the tool is starting");

        // Shortly after spawn the message must reflect a live process.
        let mut message = String::new();
        for _ in 0..250 {
            message = state.tasks.lock().unwrap().get(&task.id).map(|t| t.message.clone()).unwrap_or_default();
            if message.contains("started") || message.contains("running") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            message.contains("started") || message.contains("running"),
            "message should reflect the spawned process, got {:?}",
            message
        );

        // With no tool output after a couple of seconds, elapsed time shows up.
        let mut message = String::new();
        for _ in 0..250 {
            message = state.tasks.lock().unwrap().get(&task.id).map(|t| t.message.clone()).unwrap_or_default();
            if message.contains("s)") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(message.contains("s)"), "elapsed time expected in message, got {:?}", message);

        assert!(state.request_cancel(&task.id), "task should be cancellable while running");
        wait_for_task(&state, &task.id).await;
        let _ = std::fs::remove_file(&tool);
    }

    /// A stderr line that isn't valid UTF-8 (tools can echo raw bytes from a
    /// server error) must not wedge the task: the stream keeps draining, later
    /// progress lines still parse, and the task completes.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_invalid_utf8_stderr_line_does_not_wedge_task() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        let tool = crate::db::mongotools::test_support::write_fake_tool(
            "printf 'warn \\377\\376 invalid bytes\\n' 1>&2\n\
             echo 'ts\tdone dumping a.x (5 documents)' 1>&2\n\
             exit 0\n",
        );
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out7").await;
        wait_for_task(&state, &task.id).await;
        let t = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(t.status, "completed");
        assert_eq!(t.processed, 1, "progress after the invalid-UTF-8 line must still parse");
        let _ = std::fs::remove_file(&tool);
    }

    /// A tool that closes stderr but keeps running must stay cancellable:
    /// after stream EOF the runner still polls the cancel flag while waiting
    /// for the process instead of blocking in a bare wait().
    #[cfg(unix)]
    #[tokio::test]
    async fn test_cancel_after_stderr_close_kills_the_tool() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        let tool = crate::db::mongotools::test_support::write_fake_tool(
            "echo 'ts\tdone dumping a.x (1 documents)' 1>&2\nexec 2>&-\nsleep 30\n",
        );
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out8").await;

        // Wait until the stderr line was consumed, then a beat for the EOF.
        for _ in 0..100 {
            let processed = state.tasks.lock().unwrap().get(&task.id).map(|t| t.processed).unwrap_or(0);
            if processed >= 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let started = std::time::Instant::now();
        assert!(state.request_cancel(&task.id), "task should be known to the cancel registry");
        wait_for_task(&state, &task.id).await;
        let elapsed = started.elapsed();

        let t = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(t.status, "cancelled");
        assert!(elapsed.as_secs() < 5, "cancel should be fast, took {:?}", elapsed);
        let _ = std::fs::remove_file(&tool);
    }

    /// A grandchild that inherits the tool's stderr write end must not wedge
    /// the task after the tool itself exits: without exit detection the read
    /// loop waits for a pipe EOF that only arrives when the grandchild dies.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_lingering_grandchild_does_not_wedge_task_completion() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        // The backgrounded sleep inherits stderr and holds the pipe open for
        // 20s; the tool itself exits immediately.
        let tool = crate::db::mongotools::test_support::write_fake_tool(
            "echo 'ts\tdone dumping a.x (3 documents)' 1>&2\nsleep 20 &\nexit 0\n",
        );
        let started = std::time::Instant::now();
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out9").await;
        wait_for_task(&state, &task.id).await;
        let elapsed = started.elapsed();

        let t = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(t.status, "completed", "task: {t:?}");
        assert_eq!(t.processed, 1);
        assert!(
            elapsed.as_secs() < 5,
            "task must complete shortly after the tool exits, took {elapsed:?}"
        );
        let _ = std::fs::remove_file(&tool);
    }

    /// Before the first parsable progress event, raw stderr lines (driver
    /// warnings, connection errors) must reach the task message instead of
    /// being dropped — they're the only clue when a tool can't connect. The
    /// redacted URI handed to the tool is surfaced as the sub label.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_unparsed_stderr_and_uri_surface_before_first_progress() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        let tool = crate::db::mongotools::test_support::write_fake_tool(
            "echo 'ts\tconnection warning: cluster unreachable' 1>&2\nsleep 30\n",
        );
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out6").await;

        let mut snapshot: Option<TaskInfo> = None;
        for _ in 0..250 {
            snapshot = state.tasks.lock().unwrap().get(&task.id).cloned();
            if snapshot.as_ref().is_some_and(|t| t.message.contains("connection warning")) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let t = snapshot.expect("task exists");
        assert!(
            t.message.contains("connection warning: cluster unreachable"),
            "raw stderr should surface, got {:?}",
            t.message
        );
        let sub = t.sub_label.unwrap_or_default();
        assert!(sub.contains("***") && !sub.contains("pw"), "URI must be redacted, got {:?}", sub);
        assert!(sub.contains("serverSelectionTimeoutMS"), "prepared URI expected, got {:?}", sub);

        assert!(state.request_cancel(&task.id));
        wait_for_task(&state, &task.id).await;
        let _ = std::fs::remove_file(&tool);
    }

    /// Cancelling a task that has already finished is a no-op, not an error —
    /// the flag is gone, but yelling "cannot be cancelled" at the user for a
    /// race they can't see is wrong. Unknown ids still error.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_cancel_after_finish_is_acknowledged() {
        use crate::db::mongotools::*;
        let state = AppState::new();
        state.conn_uris.lock().unwrap().insert("c1".into(), "mongodb://u:pw@localhost:27017".into());
        let tool = crate::db::mongotools::test_support::write_fake_tool("exit 0\n");
        let task = start_dump_task_retrying(&state, &tool, "/tmp/mqlens-dump-test-out5").await;
        // Wait until the task has finished AND its cancel flag is gone (the
        // flag is removed just after the status flips; poll both). Generous
        // budget — under full-suite load process spawns can be slow.
        for _ in 0..750 {
            let finished = state.tasks.lock().unwrap().get(&task.id).map(|t| t.status != "running").unwrap_or(false);
            let flag_gone = state.cancels.lock().unwrap().get(&task.id).is_none();
            if finished && flag_gone {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let snapshot = state.tasks.lock().unwrap().get(&task.id).cloned();
        assert!(
            state.cancels.lock().unwrap().get(&task.id).is_none(),
            "flag cleaned up (task snapshot: {snapshot:?})"
        );

        assert!(state.cancel_or_ack(&task.id).is_ok(), "cancel after finish should be a quiet no-op");
        assert!(state.cancel_or_ack("no-such-task").is_err(), "unknown task ids still error");
        let _ = std::fs::remove_file(&tool);
    }
}
