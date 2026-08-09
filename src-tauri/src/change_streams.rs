//! Live collection tail: a `watch()` cursor per stream, buffered for polling.
//!
//! Events are BUFFERED here and polled by the frontend rather than emitted.
//! Two reasons: a busy collection can produce events far faster than a renderer
//! can paint them, and the feature's own rolling-buffer requirement is exactly
//! what a bounded buffer here gives — an emit-per-event design would need the
//! same cap plus backpressure on top. It also matches how the export/copy tasks
//! already report progress in this codebase.
//!
//! Pause is a real stop of the cursor, not a UI flag: the resume token from the
//! last event is kept and handed to `resume_after` when the stream restarts, so
//! nothing that happened while paused is lost. Change streams require a replica
//! set or a sharded cluster, and a standalone server reports that as an ordinary
//! command error — {@link describe_stream_error} turns it into something a user
//! can act on.

use crate::state::LockExt;
use crate::AppState;
use mongodb::bson::{doc, Document};
use mongodb::change_stream::event::{ChangeStreamEvent, ResumeToken};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Events kept per stream. Oldest are dropped first; the count of what was
/// dropped is reported so the UI can say so rather than silently skipping.
pub const BUFFER_CAP: usize = 1_000;

/// One change, flattened to what the viewer needs. The bodies stay as raw JSON
/// — this module never interprets a document.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    /// Monotonic per stream; the frontend polls for everything after the last
    /// sequence it saw, which makes a dropped or duplicated poll harmless.
    pub seq: u64,
    pub operation_type: String,
    pub database: String,
    pub collection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_key: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_document: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_fields: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_fields: Option<Vec<String>>,
    pub at_ms: u64,
}

/// What a stream is doing, as the UI needs to render it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamStatus {
    Starting,
    Running,
    Paused,
    /// The target cannot do change streams at all (standalone server). Distinct
    /// from `Error` because it is a fact about the deployment, not a failure to
    /// retry.
    Unsupported,
    Error,
}

#[derive(Default)]
pub struct StreamBuffer {
    pub events: VecDeque<ChangeEvent>,
    pub next_seq: u64,
    pub dropped: u64,
}

pub struct LiveStream {
    pub buffer: Mutex<StreamBuffer>,
    pub status: Mutex<StreamStatus>,
    pub error: Mutex<Option<String>>,
    /// Set to stop the reader task — pause and stop both use it; the difference
    /// is whether the resume token is kept.
    pub cancel: Arc<AtomicBool>,
    pub resume_token: Mutex<Option<ResumeToken>>,
    pub connection_id: String,
    pub database: String,
    pub collection: Option<String>,
    pub operation_types: Vec<String>,
}

/// What a poll returns. `dropped` is cumulative, so a UI that has already
/// reported a gap can tell whether more were lost since.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamPoll {
    pub events: Vec<ChangeEvent>,
    pub status: StreamStatus,
    pub error: Option<String>,
    pub dropped: u64,
    /// The highest sequence in the buffer, so a caller that receives no events
    /// still knows where it stands.
    pub last_seq: u64,
}

/// Append one event, evicting the oldest past the cap.
///
/// Pure so the eviction is testable: a tail viewer's whole job is to stay
/// bounded under load, and getting this wrong is invisible until a collection
/// is busy enough to matter.
pub fn push_event(buffer: &mut StreamBuffer, mut event: ChangeEvent, cap: usize) {
    event.seq = buffer.next_seq;
    buffer.next_seq += 1;
    buffer.events.push_back(event);
    while buffer.events.len() > cap {
        buffer.events.pop_front();
        buffer.dropped += 1;
    }
}

/// Everything newer than `after_seq`. A caller that has fallen behind the
/// buffer gets what is left rather than an error — the gap is reported through
/// `dropped`.
pub fn events_after(buffer: &StreamBuffer, after_seq: Option<u64>) -> Vec<ChangeEvent> {
    match after_seq {
        None => buffer.events.iter().cloned().collect(),
        Some(seq) => buffer
            .events
            .iter()
            .filter(|e| e.seq > seq)
            .cloned()
            .collect(),
    }
}

/// The `$match` that narrows a stream to the operations the user asked for.
///
/// An empty selection means "everything", which is not the same as matching
/// nothing — a filter that silently returned no events would look exactly like
/// an idle collection.
pub fn build_pipeline(operation_types: &[String]) -> Vec<Document> {
    let wanted: Vec<&String> = operation_types
        .iter()
        .filter(|t| !t.trim().is_empty())
        .collect();
    if wanted.is_empty() {
        return vec![];
    }
    vec![doc! { "$match": { "operationType": { "$in": wanted } } }]
}

/// Turn a driver error into something a user can act on.
///
/// The one that matters is a standalone server: change streams need a replica
/// set or a sharded cluster, and the server reports that as an ordinary command
/// failure whose text is the only clue.
pub fn describe_stream_error(raw: &str) -> (StreamStatus, String) {
    let lowered = raw.to_lowercase();
    let unsupported = lowered.contains("only supported on replica sets")
        || lowered.contains("replica sets")
        || lowered.contains("$changestream stage is only supported")
        || lowered.contains("not supported on standalone");
    if unsupported {
        return (
            StreamStatus::Unsupported,
            "This server is a standalone. Change streams need a replica set or a sharded cluster."
                .to_string(),
        );
    }
    (StreamStatus::Error, raw.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn to_json(doc: Option<Document>) -> Option<serde_json::Value> {
    doc.and_then(|d| serde_json::to_value(d).ok())
}

/// Flatten a driver event into the shape the viewer renders.
pub fn flatten_event(event: ChangeStreamEvent<Document>, database: &str) -> ChangeEvent {
    let (updated_fields, removed_fields) = match event.update_description {
        Some(desc) => (
            serde_json::to_value(desc.updated_fields).ok(),
            Some(desc.removed_fields),
        ),
        None => (None, None),
    };
    ChangeEvent {
        // Assigned by `push_event`, which owns the sequence.
        seq: 0,
        operation_type: format!("{:?}", event.operation_type).to_lowercase(),
        database: event
            .ns
            .as_ref()
            .map(|n| n.db.clone())
            .unwrap_or_else(|| database.to_string()),
        collection: event.ns.as_ref().and_then(|n| n.coll.clone()),
        document_key: to_json(event.document_key),
        full_document: event.full_document.and_then(|d| serde_json::to_value(d).ok()),
        updated_fields,
        removed_fields,
        at_ms: now_ms(),
    }
}

fn get_stream(state: &AppState, stream_id: &str) -> Result<Arc<LiveStream>, String> {
    state
        .change_streams
        .lock_safe()?
        .get(stream_id)
        .cloned()
        .ok_or_else(|| format!("no change stream {stream_id}"))
}

/// Read the cursor until cancelled, buffering as it goes.
///
/// Spawned per stream. It owns the resume token: every event updates it, so a
/// pause can restart exactly where this left off.
async fn run_stream(state_streams: Arc<LiveStream>, client: mongodb::Client) {
    use futures::StreamExt;

    let pipeline = build_pipeline(&state_streams.operation_types);
    let resume = state_streams
        .resume_token
        .lock()
        .ok()
        .and_then(|t| t.clone());

    let db = client.database(&state_streams.database);
    let started = match &state_streams.collection {
        Some(collection) => {
            let coll = db.collection::<Document>(collection);
            let mut action = coll.watch().pipeline(pipeline);
            if let Some(token) = resume {
                action = action.resume_after(token);
            }
            action.await.map(|s| s.boxed())
        }
        None => {
            let mut action = db.watch().pipeline(pipeline);
            if let Some(token) = resume {
                action = action.resume_after(token);
            }
            action.await.map(|s| s.boxed())
        }
    };

    let mut stream = match started {
        Ok(stream) => stream,
        Err(err) => {
            let (status, message) = describe_stream_error(&err.to_string());
            if let Ok(mut s) = state_streams.status.lock() {
                *s = status;
            }
            if let Ok(mut e) = state_streams.error.lock() {
                *e = Some(message);
            }
            return;
        }
    };

    if let Ok(mut s) = state_streams.status.lock() {
        *s = StreamStatus::Running;
    }

    while !state_streams.cancel.load(Ordering::SeqCst) {
        match stream.next().await {
            Some(Ok(event)) => {
                if let Ok(mut token) = state_streams.resume_token.lock() {
                    *token = Some(event.id.clone());
                }
                let flat = flatten_event(event, &state_streams.database);
                if let Ok(mut buffer) = state_streams.buffer.lock() {
                    push_event(&mut buffer, flat, BUFFER_CAP);
                }
            }
            Some(Err(err)) => {
                let (status, message) = describe_stream_error(&err.to_string());
                if let Ok(mut s) = state_streams.status.lock() {
                    *s = status;
                }
                if let Ok(mut e) = state_streams.error.lock() {
                    *e = Some(message);
                }
                return;
            }
            // The cursor closed on its own — treat it as a stop rather than an
            // error, since that is what a dropped connection looks like too.
            None => break,
        }
    }
}

fn spawn_reader(state: &AppState, stream: Arc<LiveStream>) -> Result<(), String> {
    let client = state
        .connections
        .lock_safe()?
        .get(&stream.connection_id)
        .cloned()
        .ok_or_else(|| format!("connection {} is not open", stream.connection_id))?;
    stream.cancel.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn(run_stream(stream, client));
    Ok(())
}

/// Begin watching. `collection` omitted watches the whole database.
#[tauri::command]
pub async fn start_change_stream(
    state: tauri::State<'_, AppState>,
    stream_id: String,
    connection_id: String,
    database: String,
    collection: Option<String>,
    operation_types: Vec<String>,
) -> Result<(), String> {
    // Starting over an existing id replaces it, so a component that remounts
    // cannot end up with two cursors feeding one buffer.
    let _ = stop_change_stream_impl(&state, &stream_id);

    let stream = Arc::new(LiveStream {
        buffer: Mutex::new(StreamBuffer::default()),
        status: Mutex::new(StreamStatus::Starting),
        error: Mutex::new(None),
        cancel: Arc::new(AtomicBool::new(false)),
        resume_token: Mutex::new(None),
        connection_id,
        database,
        collection,
        operation_types,
    });
    state
        .change_streams
        .lock_safe()?
        .insert(stream_id, stream.clone());
    spawn_reader(&state, stream)
}

#[tauri::command]
pub async fn poll_change_stream(
    state: tauri::State<'_, AppState>,
    stream_id: String,
    after_seq: Option<u64>,
) -> Result<StreamPoll, String> {
    let stream = get_stream(&state, &stream_id)?;
    let (events, dropped, last_seq) = {
        let buffer = stream.buffer.lock().map_err(|_| "buffer lock poisoned")?;
        (
            events_after(&buffer, after_seq),
            buffer.dropped,
            buffer.next_seq.saturating_sub(1),
        )
    };
    Ok(StreamPoll {
        events,
        status: stream
            .status
            .lock()
            .map(|s| s.clone())
            .unwrap_or(StreamStatus::Error),
        error: stream.error.lock().ok().and_then(|e| e.clone()),
        dropped,
        last_seq,
    })
}

/// Stop the cursor but keep the buffer and the resume token.
#[tauri::command]
pub async fn pause_change_stream(
    state: tauri::State<'_, AppState>,
    stream_id: String,
) -> Result<(), String> {
    let stream = get_stream(&state, &stream_id)?;
    stream.cancel.store(true, Ordering::SeqCst);
    if let Ok(mut s) = stream.status.lock() {
        *s = StreamStatus::Paused;
    }
    Ok(())
}

/// Start reading again from the last event seen, so nothing that happened while
/// paused is missed.
#[tauri::command]
pub async fn resume_change_stream(
    state: tauri::State<'_, AppState>,
    stream_id: String,
) -> Result<(), String> {
    let stream = get_stream(&state, &stream_id)?;
    if let Ok(mut s) = stream.status.lock() {
        *s = StreamStatus::Starting;
    }
    if let Ok(mut e) = stream.error.lock() {
        *e = None;
    }
    spawn_reader(&state, stream)
}

pub fn stop_change_stream_impl(state: &AppState, stream_id: &str) -> Result<(), String> {
    let removed = state.change_streams.lock_safe()?.remove(stream_id);
    if let Some(stream) = removed {
        stream.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_change_stream(
    state: tauri::State<'_, AppState>,
    stream_id: String,
) -> Result<(), String> {
    stop_change_stream_impl(&state, &stream_id)
}
