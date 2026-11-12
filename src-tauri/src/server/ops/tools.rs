//! Dump and restore on a server connection: the server runs mongodump and
//! mongorestore as tasks, and the desktop follows them as its own tasks,
//! fetching a finished dump into the chosen file or folder, or uploading the
//! dump a restore reads.

use crate::db::mongotools::{
    basename, build_dump_args, build_restore_args, dump_destination, dump_scope_desc,
    restore_source_path, DumpOptions, DumpScope, DumpTarget, RestoreOptions, RestoreSource,
};
use crate::db::tasks::{fail_task, finish_task, now_ms, prune_tasks, update_task};
use crate::server::channel::client;
use crate::server::errors;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::task_service_client::TaskServiceClient;
use crate::server::pb::mqlens::v1::{
    start_restore_request, ArtifactChunk, CancelTaskRequest, DeleteTaskRequest,
    DownloadArtifactRequest, RestoreNamespace, RestoreOptions as PbRestoreOptions,
    StartDumpRequest, StartRestoreRequest, Task as PbTask, WatchTaskRequest,
};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::server::session::{next_message, Speaking};
use crate::state::LockExt;
use crate::{AppState, TaskInfo};
use futures::StreamExt;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

type Tasks = Arc<Mutex<HashMap<String, TaskInfo>>>;

/// The most one upload message carries.
const UPLOAD_CHUNK: usize = 1 << 20;
/// How often a running task looks at its cancel flag.
const POLL: Duration = Duration::from_millis(250);

fn new_task(kind: &str, label: String, message: &str, path: &str) -> TaskInfo {
    TaskInfo {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        label,
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: message.to_string(),
        path: Some(path.to_string()),
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
        sub_label: None,
        items_processed: None,
        items_total: None,
        summary: None,
    }
}

fn register(state: &AppState, task: &TaskInfo) -> Result<Arc<AtomicBool>, String> {
    state
        .tasks
        .lock_safe()?
        .insert(task.id.clone(), task.clone());
    Ok(state.register_cancel(&task.id))
}

/// Starts a dump on the server and follows it as a desktop task; once the
/// server has finished it, the dump is fetched to the chosen file or folder
/// and the server's copy deleted.
pub(crate) async fn start_dump(
    state: &AppState,
    conn: Arc<RemoteConn>,
    options: DumpOptions,
) -> Result<TaskInfo, String> {
    routes::require("start_dump_task", &conn)?;
    // The options are refused as local mode refuses them.
    build_dump_args(&options)?;
    let session = session_for(state, &conn).await?;
    let (database, collection) = match &options.scope {
        DumpScope::Server => (String::new(), String::new()),
        DumpScope::Db { db } => (db.clone(), String::new()),
        DumpScope::Collection { db, coll } => (db.clone(), coll.clone()),
    };
    let request = StartDumpRequest {
        connection_id: conn.remote_id.clone(),
        database,
        collection,
        archive: matches!(options.target, DumpTarget::Archive { .. }),
        gzip: options.gzip,
        query: options.query.clone().unwrap_or_default(),
        force_table_scan: options.force_table_scan,
        dump_users_and_roles: options.dump_users_and_roles,
        oplog: options.oplog,
    };
    let server_task = session
        .call(request, |channel, request| async move {
            client!(TaskServiceClient, channel)
                .start_dump(request)
                .await
        })
        .await?;
    let dest = dump_destination(&options.target).to_string();
    let label = format!(
        "Dump {} \u{2192} {}",
        dump_scope_desc(&options.scope),
        basename(&dest)
    );
    let task = new_task(
        "dump",
        label,
        "mongodump is running on MQLens Server…",
        &dest,
    );
    let cancel = register(state, &task)?;
    let (tasks, cancels, id) = (state.tasks.clone(), state.cancels.clone(), task.id.clone());
    let target = options.target.clone();
    tokio::spawn(async move {
        let outcome = match follow(&session, &tasks, &id, &server_task.id, &cancel).await {
            Ok(done) if done.state == "completed" => {
                update_task(&tasks, &id, |t| {
                    t.message = "Fetching the dump…".to_string()
                });
                match fetch(&session, &server_task.id, &target, &cancel).await {
                    Ok(()) => Ok(done),
                    Err(_) if cancel.load(Ordering::SeqCst) => Ok(PbTask {
                        state: "cancelled".to_string(),
                        ..done
                    }),
                    Err(e) => Err(e),
                }
            }
            other => other,
        };
        conclude(
            &session,
            &tasks,
            &id,
            &server_task.id,
            outcome,
            "Dump complete",
        )
        .await;
        if let Ok(mut cancels) = cancels.lock() {
            cancels.remove(&id);
        }
    });
    Ok(task)
}

/// Uploads the dump a restore reads, then follows the server's restore as a
/// desktop task.
pub(crate) async fn start_restore(
    state: &AppState,
    conn: Arc<RemoteConn>,
    options: RestoreOptions,
) -> Result<TaskInfo, String> {
    routes::require("start_restore_task", &conn)?;
    build_restore_args(&options)?;
    let session = session_for(state, &conn).await?;
    let files = upload_files(&options)?;
    let source = restore_source_path(&options.source).to_string();
    // Audited as a local restore is: started here, once nothing can refuse it,
    // and ended below as the task ends.
    let audit = crate::audit::TaskAuditContext::capture(
        state,
        Some(&conn.desktop_id),
        None,
        None,
        "start_restore_task",
        &format!("restore from {}", basename(&source)),
    );
    let audit_started = std::time::Instant::now();
    let task = new_task(
        "restore",
        format!("Restore {}", basename(&source)),
        "Uploading the dump to MQLens Server…",
        &source,
    );
    let cancel = register(state, &task)?;
    let (events, failures) = mpsc::unbounded_channel();
    let total = files
        .iter()
        .map(|(_, path)| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
        .sum();
    let up = Upload {
        options: restore_options(&conn, &options),
        files: Arc::new(files),
        tasks: state.tasks.clone(),
        id: task.id.clone(),
        total,
        events,
    };
    let (tasks, cancels, id) = (state.tasks.clone(), state.cancels.clone(), task.id.clone());
    tokio::spawn(async move {
        match upload(&session, up, failures, &cancel).await {
            Ok(server_task) => {
                update_task(&tasks, &id, |t| {
                    t.message = "mongorestore is running on MQLens Server…".to_string()
                });
                let outcome = follow(&session, &tasks, &id, &server_task.id, &cancel).await;
                conclude(
                    &session,
                    &tasks,
                    &id,
                    &server_task.id,
                    outcome,
                    "Restore complete",
                )
                .await;
            }
            // Nothing started on the server: there is nothing there to end.
            Err(_) if cancel.load(Ordering::SeqCst) => cancelled(&tasks, &id),
            Err(e) => fail_task(&tasks, &id, e),
        }
        let (outcome, error) = crate::db::tasks::terminal_state(&tasks, &id, "failed");
        audit.record_terminal(
            &outcome,
            error.as_deref(),
            Some(audit_started.elapsed().as_millis() as i64),
        );
        if let Ok(mut cancels) = cancels.lock() {
            cancels.remove(&id);
        }
    });
    Ok(task)
}

fn restore_options(conn: &RemoteConn, o: &RestoreOptions) -> PbRestoreOptions {
    PbRestoreOptions {
        connection_id: conn.remote_id.clone(),
        archive: matches!(o.source, RestoreSource::Archive { .. }),
        gzip: o.gzip,
        selections: o
            .selections
            .iter()
            .map(|s| RestoreNamespace {
                db: s.db.clone(),
                coll: s.coll.clone(),
                rename_to: s.rename_to.clone().unwrap_or_default(),
            })
            .collect(),
        filter_db: o.filter_db.clone().unwrap_or_default(),
        filter_coll: o.filter_coll.clone().unwrap_or_default(),
        drop: o.drop,
        keep_index_version: o.keep_index_version,
        no_index_restore: o.no_index_restore,
        no_options_restore: o.no_options_restore,
        maintain_insertion_order: o.maintain_insertion_order,
        stop_on_error: o.stop_on_error,
        bypass_document_validation: o.bypass_document_validation,
        restore_db_users_and_roles: o.restore_db_users_and_roles,
        oplog_replay: o.oplog_replay,
    }
}

/// The files a restore uploads, by their path in the dump: an archive's one
/// file; or a folder's files: all of them when none are chosen, the chosen
/// database's when its users and roles are restored, else the chosen
/// collections' own.
fn upload_files(o: &RestoreOptions) -> Result<Vec<(String, PathBuf)>, String> {
    let dir = match &o.source {
        RestoreSource::Archive { file } => return Ok(vec![(basename(file), PathBuf::from(file))]),
        RestoreSource::Folder { dir } => PathBuf::from(dir),
    };
    let mut files = Vec::new();
    collect(&dir, &mut Vec::new(), &mut files)?;
    if o.selections.is_empty() {
        return Ok(files);
    }
    Ok(files
        .into_iter()
        .filter(|(rel, _)| match rel.split_once('/') {
            // Users and roles take the chosen database whole, users included.
            Some((db, _)) if o.restore_db_users_and_roles => {
                o.selections.iter().any(|s| s.db == db)
            }
            Some((db, name)) if !name.contains('/') => o
                .selections
                .iter()
                .any(|s| s.db == db && is_collection_file(name, &s.coll)),
            _ => false,
        })
        .collect())
}

/// The files mongodump writes for a collection. Matched whole, so a chosen
/// `orders` does not take `orders.private` with it.
const COLLECTION_FILES: &[&str] = &[".bson", ".bson.gz", ".metadata.json", ".metadata.json.gz"];

fn is_collection_file(name: &str, coll: &str) -> bool {
    name.strip_prefix(coll)
        .is_some_and(|suffix| COLLECTION_FILES.contains(&suffix))
}

fn collect(
    dir: &Path,
    rel: &mut Vec<String>,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("Failed to read {}: {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read {}: {}", dir.display(), e))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("Failed to read {}: {}", entry.path().display(), e))?;
        // What a link points to is not in the dump, as the restore tree
        // leaves links out too.
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        rel.push(entry.file_name().to_string_lossy().into_owned());
        if kind.is_dir() {
            collect(&path, rel, out)?;
        } else if kind.is_file() {
            out.push((rel.join("/"), path));
        }
        rel.pop();
    }
    Ok(())
}

/// Everything an upload attempt needs to send the dump again from the start.
#[derive(Clone)]
struct Upload {
    options: PbRestoreOptions,
    files: Arc<Vec<(String, PathBuf)>>,
    tasks: Tasks,
    id: String,
    total: u64,
    events: mpsc::UnboundedSender<String>,
}

fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

/// The restore's messages: its options, then each file in chunks; an empty
/// file is one empty chunk. A file that cannot be read stops the stream
/// without ending it, so the server never takes part of a dump for all of
/// it; the waiting upload hears why and abandons the call.
fn messages(up: Upload) -> impl futures::Stream<Item = StartRestoreRequest> + Send + 'static {
    let first = StartRestoreRequest {
        kind: Some(start_restore_request::Kind::Options(up.options.clone())),
    };
    let files = futures::stream::unfold(
        (up, 0usize, None::<tokio::fs::File>, true, 0u64),
        |(up, mut index, mut file, mut fresh, mut sent)| async move {
            let (rel, path) = up.files.get(index)?.clone();
            if file.is_none() {
                match tokio::fs::File::open(&path).await {
                    Ok(f) => {
                        file = Some(f);
                        fresh = true;
                    }
                    Err(e) => {
                        let _ = up
                            .events
                            .send(format!("Failed to open {}: {}", path.display(), e));
                        return futures::future::pending().await;
                    }
                }
            }
            loop {
                let mut buf = vec![0u8; UPLOAD_CHUNK];
                let n = match file.as_mut().unwrap().read(&mut buf).await {
                    Ok(n) => n,
                    Err(e) => {
                        let _ = up
                            .events
                            .send(format!("Failed to read {}: {}", path.display(), e));
                        return futures::future::pending().await;
                    }
                };
                if n == 0 && !fresh {
                    // This file is sent; the next call opens the next one.
                    return Some((None, (up, index + 1, None, true, sent)));
                }
                buf.truncate(n);
                sent += n as u64;
                update_task(&up.tasks, &up.id, |t| {
                    t.message = format!(
                        "Uploading the dump: {} of {}",
                        megabytes(sent),
                        megabytes(up.total)
                    )
                });
                let chunk = StartRestoreRequest {
                    kind: Some(start_restore_request::Kind::File(ArtifactChunk {
                        path: rel.clone(),
                        data: buf.into(),
                    })),
                };
                if n == 0 {
                    index += 1;
                    file = None;
                }
                return Some((Some(chunk), (up, index, file, false, sent)));
            }
        },
    )
    .filter_map(|message| async move { message });
    futures::stream::once(async move { first }).chain(files)
}

async fn upload(
    session: &Speaking,
    up: Upload,
    mut failures: mpsc::UnboundedReceiver<String>,
    cancel: &AtomicBool,
) -> Result<PbTask, String> {
    let call = session.call_unbounded(up, |channel, request| async move {
        client!(TaskServiceClient, channel)
            .start_restore(request.map(messages))
            .await
    });
    tokio::pin!(call);
    let mut poll = tokio::time::interval(POLL);
    loop {
        tokio::select! {
            result = &mut call => return result,
            Some(failure) = failures.recv() => return Err(failure),
            _ = poll.tick() => {
                if cancel.load(Ordering::SeqCst) {
                    return Err("Cancelled".to_string());
                }
            }
        }
    }
}

/// Follows the server's task until it finishes, showing its progress on the
/// desktop's, and cancels it on the server once the desktop's is cancelled.
async fn follow(
    session: &Speaking,
    tasks: &Tasks,
    id: &str,
    server_id: &str,
    cancel: &AtomicBool,
) -> Result<PbTask, String> {
    let request = WatchTaskRequest {
        id: server_id.to_string(),
    };
    let mut stream = session
        .open_stream(request, |channel, request| async move {
            client!(TaskServiceClient, channel)
                .watch_task(request)
                .await
        })
        .await?;
    let mut poll = tokio::time::interval(POLL);
    let mut cancelling = false;
    loop {
        tokio::select! {
            // A task can run long without news, so no idle limit here.
            message = stream.message() => match message {
                Ok(Some(t)) if t.state != "running" => return Ok(t),
                Ok(Some(t)) => update_task(tasks, id, |local| {
                    local.processed = t.processed.max(0) as u64;
                    if !t.message.is_empty() {
                        local.message = t.message.clone();
                    }
                }),
                Ok(None) => return Err("MQLens Server stopped reporting this task".to_string()),
                Err(status) => return Err(errors::describe(&status)),
            },
            _ = poll.tick(), if !cancelling => {
                if cancel.load(Ordering::SeqCst) {
                    cancelling = true;
                    let request = CancelTaskRequest { id: server_id.to_string() };
                    session
                        .call(request, |channel, request| async move {
                            client!(TaskServiceClient, channel).cancel_task(request).await
                        })
                        .await?;
                }
            }
        }
    }
}

/// Where a dump's file goes: the chosen archive file, or its path under the
/// chosen folder. A path that would leave the folder is refused, and so is
/// one through a link already in it, which could lead anywhere.
fn destination(target: &DumpTarget, path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(path);
    if path.is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!(
            "MQLens Server sent a file outside the dump: {path:?}"
        ));
    }
    let out = match target {
        DumpTarget::Archive { file } => return Ok(PathBuf::from(file)),
        DumpTarget::Folder { out } => out,
    };
    let mut at = PathBuf::from(out);
    for part in rel.components() {
        at.push(part);
        let linked = std::fs::symlink_metadata(&at)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if linked {
            return Err(format!(
                "{} is a link; a dump is not written through one",
                at.display()
            ));
        }
    }
    Ok(at)
}

async fn fetch(
    session: &Speaking,
    server_id: &str,
    target: &DumpTarget,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let request = DownloadArtifactRequest {
        id: server_id.to_string(),
    };
    let mut stream = session
        .open_stream(request, |channel, request| async move {
            client!(TaskServiceClient, channel)
                .download_artifact(request)
                .await
        })
        .await?;
    let mut current: Option<(String, tokio::fs::File)> = None;
    while let Some(chunk) = next_message(&mut stream).await? {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }
        if current
            .as_ref()
            .map(|(p, _)| *p != chunk.path)
            .unwrap_or(true)
        {
            if let Some((_, mut done)) = current.take() {
                done.flush()
                    .await
                    .map_err(|e| format!("Failed to write the dump: {e}"))?;
            }
            let path = destination(target, &chunk.path)?;
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
            }
            let file = tokio::fs::File::create(&path)
                .await
                .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
            current = Some((chunk.path.clone(), file));
        }
        let (_, file) = current.as_mut().expect("opened above");
        file.write_all(&chunk.data)
            .await
            .map_err(|e| format!("Failed to write the dump: {e}"))?;
    }
    if let Some((_, mut file)) = current {
        file.flush()
            .await
            .map_err(|e| format!("Failed to write the dump: {e}"))?;
    }
    Ok(())
}

fn cancelled(tasks: &Tasks, id: &str) {
    update_task(tasks, id, |t| {
        t.status = "cancelled".to_string();
        t.message = "Cancelled".to_string();
        t.finished_at_ms = Some(now_ms());
    });
    prune_tasks(tasks);
}

/// Deletes the server's task, whose files are fetched or no longer wanted,
/// then ends the desktop's as the server's ended: once the desktop's task
/// shows finished, nothing of it is left on the server.
async fn conclude(
    session: &Speaking,
    tasks: &Tasks,
    id: &str,
    server_id: &str,
    outcome: Result<PbTask, String>,
    done: &str,
) {
    // A task still running there (its stream broke) is refused; the server
    // prunes it a day after it ends.
    let request = DeleteTaskRequest {
        id: server_id.to_string(),
    };
    let _ = session
        .call(request, |channel, request| async move {
            client!(TaskServiceClient, channel)
                .delete_task(request)
                .await
        })
        .await;
    match outcome {
        Ok(t) if t.state == "completed" => {
            finish_task(tasks, id, t.processed.max(0) as u64, done.to_string())
        }
        Ok(t) if t.state == "cancelled" => cancelled(tasks, id),
        Ok(t) if !t.error.is_empty() => fail_task(tasks, id, t.error),
        Ok(t) => fail_task(tasks, id, format!("The task ended as {}", t.state)),
        Err(e) => fail_task(tasks, id, e),
    }
}

#[cfg(test)]
mod tests {
    use crate::db::mongotools::{
        start_dump_task_impl, start_restore_task_impl, DumpOptions, DumpScope, DumpTarget,
        NsSelection, RestoreOptions, RestoreSource,
    };
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use crate::server::pb::mqlens::v1::{ArtifactChunk, Task as PbTask};
    use crate::{AppState, TaskInfo};
    use std::path::Path;
    use std::time::Duration;

    /// Connected over API version 8 with `classes`.
    async fn on_server(env: &Env, classes: &[&str]) -> (AppState, String) {
        env.fake.with(|s| {
            s.max_api_version = 8;
            s.connections[0].op_classes = classes.iter().map(|c| c.to_string()).collect();
        });
        connected(env).await
    }

    fn task(state: &str, processed: i64, message: &str, error: &str) -> PbTask {
        PbTask {
            state: state.to_string(),
            processed,
            message: message.to_string(),
            error: error.to_string(),
            ..Default::default()
        }
    }

    fn chunk(path: &str, data: &[u8]) -> ArtifactChunk {
        ArtifactChunk {
            path: path.to_string(),
            data: data.to_vec().into(),
        }
    }

    async fn finished(state: &AppState, task: &TaskInfo) -> TaskInfo {
        for _ in 0..250 {
            let now = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
            if now.status != "running" {
                return now;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the task never finished");
    }

    fn dump_to(target: DumpTarget, scope: DumpScope) -> DumpOptions {
        DumpOptions {
            scope,
            target,
            gzip: true,
            ..Default::default()
        }
    }

    fn folder(path: &Path) -> DumpTarget {
        DumpTarget::Folder {
            out: path.to_string_lossy().into_owned(),
        }
    }

    fn shop() -> DumpScope {
        DumpScope::Db { db: "shop".into() }
    }

    fn calls(env: &Env) -> Vec<String> {
        env.fake.with(|s| s.task_calls.clone())
    }

    // The server dumps a collection to an archive; the desktop follows it,
    // fetches the archive to the chosen file, and deletes the server's copy.
    #[tokio::test]
    async fn a_collection_dumps_to_an_archive_through_the_server() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read"]).await;
        env.fake.with(|s| {
            s.task_updates = vec![
                task("running", 1, "shop.orders done (2 documents)", ""),
                task("completed", 1, "Dump complete", ""),
            ];
            s.artifact = vec![chunk("dump.archive", b"AB"), chunk("dump.archive", b"C")];
        });
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("orders.archive.gz");
        let target = DumpTarget::Archive {
            file: file.to_string_lossy().into_owned(),
        };
        let scope = DumpScope::Collection {
            db: "shop".into(),
            coll: "orders".into(),
        };

        let started = start_dump_task_impl(&state, &id, "", dump_to(target, scope))
            .await
            .unwrap();
        let done = finished(&state, &started).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        assert_eq!(done.processed, 1);
        assert_eq!(std::fs::read(&file).unwrap(), b"ABC");
        let sent = env.fake.with(|s| s.dumps.clone());
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].database, "shop");
        assert_eq!(sent[0].collection, "orders");
        assert!(sent[0].archive && sent[0].gzip);
        assert_eq!(
            calls(&env),
            vec!["download:server-dump", "delete:server-dump"]
        );
    }

    // A folder dump's files land in the chosen folder as mongodump --out
    // would write them there.
    #[tokio::test]
    async fn a_folder_dump_fills_the_chosen_folder() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read"]).await;
        env.fake.with(|s| {
            s.task_updates = vec![task("completed", 2, "Dump complete", "")];
            s.artifact = vec![
                chunk("shop/orders.bson", b"x"),
                chunk("shop/items.bson", b""),
            ];
        });
        let out = tempfile::tempdir().unwrap();

        let started = start_dump_task_impl(&state, &id, "", dump_to(folder(out.path()), shop()))
            .await
            .unwrap();
        let done = finished(&state, &started).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        assert_eq!(
            std::fs::read(out.path().join("shop/orders.bson")).unwrap(),
            b"x"
        );
        assert!(out.path().join("shop/items.bson").is_file());
        assert!(!env.fake.with(|s| s.dumps[0].archive));
    }

    // A dump the server fails says why, fetches nothing, and is deleted
    // before the desktop's task ends, however slow the server is to delete.
    #[tokio::test]
    async fn a_failed_dump_says_why() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read"]).await;
        env.fake.with(|s| {
            s.task_updates = vec![task("failed", 0, "", "could not connect")];
            s.delete_delay = Duration::from_millis(300);
        });
        let out = tempfile::tempdir().unwrap();

        let started = start_dump_task_impl(&state, &id, "", dump_to(folder(out.path()), shop()))
            .await
            .unwrap();
        let done = finished(&state, &started).await;

        assert_eq!(done.status, "failed");
        assert!(done.error.unwrap_or_default().contains("could not connect"));
        assert_eq!(calls(&env), vec!["delete:server-dump"]);
    }

    // Cancelling the desktop's task cancels the server's.
    #[tokio::test]
    async fn cancelling_a_dump_cancels_it_on_the_server() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read"]).await;
        env.fake
            .with(|s| s.task_updates = vec![task("running", 0, "writing shop.orders", "")]);
        let out = tempfile::tempdir().unwrap();
        let started = start_dump_task_impl(&state, &id, "", dump_to(folder(out.path()), shop()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert!(state.request_cancel(&started.id));
        let done = finished(&state, &started).await;

        assert_eq!(done.status, "cancelled");
        assert_eq!(
            calls(&env),
            vec!["cancel:server-dump", "delete:server-dump"]
        );
    }

    // A path that would leave the chosen folder is refused, and nothing is
    // written outside it.
    #[tokio::test]
    async fn an_artifact_cannot_write_outside_the_folder() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read"]).await;
        env.fake.with(|s| {
            s.task_updates = vec![task("completed", 1, "Dump complete", "")];
            s.artifact = vec![chunk("../escaped.bson", b"x")];
        });
        let root = tempfile::tempdir().unwrap();
        let out = root.path().join("out");
        std::fs::create_dir(&out).unwrap();

        let started = start_dump_task_impl(&state, &id, "", dump_to(folder(&out), shop()))
            .await
            .unwrap();
        let done = finished(&state, &started).await;

        assert_eq!(done.status, "failed");
        assert!(!root.path().join("escaped.bson").exists());
    }

    fn write(path: &Path, data: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, data).unwrap();
    }

    // A folder restore of chosen collections uploads only their files, with
    // the options as chosen, and follows the server's task to its end.
    #[tokio::test]
    async fn a_folder_restore_uploads_only_the_chosen_collections() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read", "write", "ddl"]).await;
        env.fake
            .with(|s| s.task_updates = vec![task("completed", 1, "Restore complete", "")]);
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("shop/orders.bson"), b"orders");
        write(&dir.path().join("shop/orders.metadata.json"), b"{}");
        write(&dir.path().join("shop/items.bson"), b"items");
        // Another collection whose name the chosen one begins: not chosen.
        write(&dir.path().join("shop/orders.private.bson"), b"private");
        write(&dir.path().join("shop/orders.private.metadata.json"), b"{}");
        write(&dir.path().join("other/x.bson"), b"x");

        let started = start_restore_task_impl(
            &state,
            &id,
            "",
            RestoreOptions {
                source: RestoreSource::Folder {
                    dir: dir.path().to_string_lossy().into_owned(),
                },
                selections: vec![NsSelection {
                    db: "shop".into(),
                    coll: "orders".into(),
                    rename_to: Some("o2".into()),
                }],
                drop: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let done = finished(&state, &started).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let (options, files) = env.fake.with(|s| s.restores[0].clone());
        assert!(!options.archive && options.drop);
        assert_eq!(options.selections.len(), 1);
        assert_eq!(options.selections[0].db, "shop");
        assert_eq!(options.selections[0].coll, "orders");
        assert_eq!(options.selections[0].rename_to, "o2");
        let mut names: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["shop/orders.bson", "shop/orders.metadata.json"]);
        assert_eq!(calls(&env), vec!["delete:server-restore"]);
    }

    // An archive restore uploads the one file, under its own name.
    #[tokio::test]
    async fn an_archive_restore_uploads_its_file() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read", "write", "ddl"]).await;
        env.fake
            .with(|s| s.task_updates = vec![task("completed", 1, "Restore complete", "")]);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("backup.archive.gz");
        write(&file, b"archive");

        let started = start_restore_task_impl(
            &state,
            &id,
            "",
            RestoreOptions {
                source: RestoreSource::Archive {
                    file: file.to_string_lossy().into_owned(),
                },
                gzip: true,
                filter_db: Some("shop".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let done = finished(&state, &started).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let (options, files) = env.fake.with(|s| s.restores[0].clone());
        assert!(options.archive && options.gzip);
        assert_eq!(options.filter_db, "shop");
        assert_eq!(
            files,
            vec![("backup.archive.gz".to_string(), b"archive".to_vec())]
        );
    }

    // Both need a server that speaks version 8, and the class each takes.
    #[tokio::test]
    async fn dump_and_restore_need_version_eight_and_their_class() {
        let env = Env::new().await;
        env.fake.with(|s| s.max_api_version = 7);
        let (state, id) = connected(&env).await;
        let out = tempfile::tempdir().unwrap();
        let err = start_dump_task_impl(&state, &id, "", dump_to(folder(out.path()), shop()))
            .await
            .unwrap_err();
        assert!(err.contains("API version 8"), "{err}");

        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read"]).await;
        let restore = RestoreOptions {
            source: RestoreSource::Folder {
                dir: out.path().to_string_lossy().into_owned(),
            },
            ..Default::default()
        };
        let err = start_restore_task_impl(&state, &id, "", restore)
            .await
            .unwrap_err();
        assert!(err.contains("does not allow ddl"), "{err}");
    }

    /// A directory link at `link` to `target`: a junction on Windows, which
    /// needs no privilege, and a symbolic link elsewhere.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    // A link in the chosen folder does not carry a download out of it.
    #[tokio::test]
    async fn a_download_does_not_follow_a_link_out_of_the_folder() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read"]).await;
        env.fake.with(|s| {
            s.task_updates = vec![task("completed", 1, "Dump complete", "")];
            s.artifact = vec![chunk("shop/orders.bson", b"x")];
        });
        let root = tempfile::tempdir().unwrap();
        let (out, elsewhere) = (root.path().join("out"), root.path().join("elsewhere"));
        std::fs::create_dir_all(&out).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        link_dir(&elsewhere, &out.join("shop"));

        let started = start_dump_task_impl(&state, &id, "", dump_to(folder(&out), shop()))
            .await
            .unwrap();
        let done = finished(&state, &started).await;

        assert_eq!(done.status, "failed");
        assert!(!elsewhere.join("orders.bson").exists());
    }

    // A restore uploads what is in the folder, not what a link in it points
    // to.
    #[tokio::test]
    async fn a_restore_does_not_upload_through_a_link() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read", "write", "ddl"]).await;
        env.fake
            .with(|s| s.task_updates = vec![task("completed", 1, "Restore complete", "")]);
        let root = tempfile::tempdir().unwrap();
        let (dir, elsewhere) = (root.path().join("dump"), root.path().join("elsewhere"));
        write(&dir.join("shop/orders.bson"), b"orders");
        write(&elsewhere.join("secret.bson"), b"secret");
        link_dir(&elsewhere, &dir.join("linked"));

        let restore = RestoreOptions {
            source: RestoreSource::Folder {
                dir: dir.to_string_lossy().into_owned(),
            },
            ..Default::default()
        };
        let started = start_restore_task_impl(&state, &id, "", restore)
            .await
            .unwrap();
        finished(&state, &started).await;

        let (_, files) = env.fake.with(|s| s.restores[0].clone());
        let names: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(names, vec!["shop/orders.bson"]);
    }

    // Restoring users and roles takes the selected database whole, and no
    // other database in the folder.
    #[tokio::test]
    async fn users_and_roles_upload_their_whole_database_only() {
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read", "write", "ddl", "admin"]).await;
        env.fake
            .with(|s| s.task_updates = vec![task("completed", 1, "Restore complete", "")]);
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("shop/orders.bson"), b"orders");
        write(&dir.path().join("shop/items.bson"), b"items");
        write(&dir.path().join("shop/$admin.system.users.bson"), b"users");
        write(&dir.path().join("other/x.bson"), b"x");

        let restore = RestoreOptions {
            source: RestoreSource::Folder {
                dir: dir.path().to_string_lossy().into_owned(),
            },
            selections: vec![NsSelection {
                db: "shop".into(),
                coll: "orders".into(),
                rename_to: None,
            }],
            restore_db_users_and_roles: true,
            ..Default::default()
        };
        let started = start_restore_task_impl(&state, &id, "", restore)
            .await
            .unwrap();
        finished(&state, &started).await;

        let (_, files) = env.fake.with(|s| s.restores[0].clone());
        let mut names: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "shop/$admin.system.users.bson",
                "shop/items.bson",
                "shop/orders.bson"
            ]
        );
    }

    // A restore through the server is audited on the desktop too, from its
    // start to how it ended, as a local restore is.
    #[tokio::test]
    async fn a_restore_through_the_server_is_audited() {
        use crate::audit::envelope::{AuditPolicy, AuditSession};
        use crate::audit::level::AuditLevel;
        use crate::audit::store::AuditFilter;
        let env = Env::new().await;
        let (state, id) = on_server(&env, &["read", "write", "ddl"]).await;
        let logs = tempfile::tempdir().unwrap();
        let session = AuditSession::new(logs.path().join("audit.log.enc"));
        session.open(rand::random::<[u8; 32]>()).unwrap();
        session.set_policy(AuditPolicy {
            enabled: true,
            level: AuditLevel::C,
            include_payloads: false,
            retention_days: 30,
        });
        *state.audit.lock().unwrap() = Some(session);
        env.fake
            .with(|s| s.task_updates = vec![task("failed", 0, "", "could not connect")]);
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("shop/orders.bson"), b"orders");

        let restore = RestoreOptions {
            source: RestoreSource::Folder {
                dir: dir.path().to_string_lossy().into_owned(),
            },
            ..Default::default()
        };
        let started = start_restore_task_impl(&state, &id, "", restore)
            .await
            .unwrap();
        finished(&state, &started).await;

        let rows = state
            .audit
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .query(&AuditFilter::default())
            .unwrap();
        let restores: Vec<_> = rows
            .iter()
            .filter(|r| r.op == "start_restore_task")
            .collect();
        assert_eq!(restores.len(), 1, "{rows:?}");
        assert!(!restores[0].ok);
        assert!(restores[0]
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("could not connect"));
    }
}
