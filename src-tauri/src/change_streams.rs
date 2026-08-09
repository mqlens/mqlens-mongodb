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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Events kept per stream. Oldest are dropped first; the count of what was
/// dropped is reported so the UI can say so rather than silently skipping.
pub const BUFFER_CAP: usize = 1_000;

/// Bytes of document bodies kept per stream.
///
/// A count alone is not a memory bound: a MongoDB document can approach 16 MiB,
/// so a thousand large inserts is gigabytes held in a desktop process — and
/// polling clones them again on the way out. Whichever limit is reached first
/// evicts.
pub const BUFFER_BYTES: usize = 16 * 1024 * 1024;

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
    /// Where a rename sent the collection. Rename events carry no document, so
    /// without this the viewer can say what moved but never where to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_to: Option<String>,
    pub at_ms: u64,
    /// Rough size of the bodies this event carries, for the byte bound.
    ///
    /// Sent to the frontend as well: the view keeps its own bounded history,
    /// and a count alone is not a memory bound there either — a thousand
    /// multi-megabyte documents held in a WebView is the same problem in a
    /// worse place. Measuring once here beats every poll re-measuring.
    #[serde(default)]
    pub bytes: usize,
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
    /// The cursor finished by itself — invalidated, or the connection went
    /// away. Distinct from `Error`: nothing went wrong, there is just nothing
    /// left to read.
    Ended,
    Error,
}

#[derive(Default)]
pub struct StreamBuffer {
    pub events: VecDeque<ChangeEvent>,
    pub next_seq: u64,
    pub dropped: u64,
    /// Running total of `bytes` across `events`, so eviction does not have to
    /// re-measure the whole buffer on every push.
    pub buffered_bytes: usize,
}

/// Where a stream would restart, and who put it there.
///
/// The generation is what stops a straggler from dragging the point backwards:
/// a reader retired minutes ago can still be holding a cursor whose position
/// predates its replacement's, and writing that would replay changes the view
/// has already shown under fresh sequence numbers.
#[derive(Default, Debug)]
pub struct ResumePoint {
    pub generation: u64,
    pub token: Option<ResumeToken>,
}

pub struct LiveStream {
    pub buffer: Mutex<StreamBuffer>,
    pub status: Mutex<StreamStatus>,
    pub error: Mutex<Option<String>>,
    /// Which reader is the live one.
    ///
    /// A boolean "cancelled" flag cannot wake a task blocked in
    /// `next().await`, so pausing and resuming before the next event could
    /// leave TWO readers on the same resume point, each buffering the same
    /// changes. Every pause, resume and stop bumps this; a reader carries the
    /// value it started with and retires the moment it stops matching, so a
    /// straggler can neither push nor keep reading.
    pub generation: Arc<AtomicU64>,
    /// Wakes a reader parked in `next().await` so retirement is immediate.
    ///
    /// The generation alone retires a reader only in principle: a quiet or
    /// narrowly filtered stream can sit in that await for minutes, holding a
    /// server-side cursor and a clone of the client the whole time. Pause,
    /// resume, filter, pause again and those pile up.
    pub retired: Arc<tokio::sync::Notify>,
    /// Shared with whatever replaces this stream on the same target, so a
    /// reader retired by that replacement still writes its final cursor
    /// position somewhere the replacement can read it.
    pub resume_token: Arc<Mutex<ResumePoint>>,
    pub connection_id: String,
    /// `None` watches the whole deployment (`client.watch()`), which is how a
    /// cluster-level tail differs from a database one.
    pub database: Option<String>,
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
    push_event_bounded(buffer, &mut event, cap, BUFFER_BYTES);
}

/// The eviction itself, with both limits explicit so a test can use small ones.
pub fn push_event_bounded(
    buffer: &mut StreamBuffer,
    event: &mut ChangeEvent,
    cap: usize,
    max_bytes: usize,
) {
    event.seq = buffer.next_seq;
    buffer.next_seq += 1;
    buffer.buffered_bytes += event.bytes;
    buffer.events.push_back(event.clone());
    // Whichever limit bites first. The newest event always stays, even if it
    // alone is over the byte budget — dropping the thing just received would
    // make a large-document collection look idle.
    while buffer.events.len() > cap
        || (buffer.buffered_bytes > max_bytes && buffer.events.len() > 1)
    {
        if let Some(evicted) = buffer.events.pop_front() {
            buffer.buffered_bytes = buffer.buffered_bytes.saturating_sub(evicted.bytes);
            buffer.dropped += 1;
        }
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
    // The event's OWN wall time where the server sent one. `now_ms()` is when
    // this process happened to read it, which after a pause or a backlog
    // stamps every replayed change with the moment of resume.
    let at_ms = event
        .wall_time
        .map(|t| t.timestamp_millis().max(0) as u64)
        .unwrap_or_else(now_ms);
    let renamed_to = event.to.as_ref().map(|ns| match &ns.coll {
        Some(coll) => format!("{}.{}", ns.db, coll),
        None => ns.db.clone(),
    });
    let document_key = to_json(event.document_key);
    let full_document = event.full_document.and_then(|d| serde_json::to_value(d).ok());
    let mut flat = ChangeEvent {
        // Assigned by `push_event`, which owns the sequence.
        seq: 0,
        operation_type: format!("{:?}", event.operation_type).to_lowercase(),
        database: event
            .ns
            .as_ref()
            .map(|n| n.db.clone())
            .unwrap_or_else(|| database.to_string()),
        collection: event.ns.as_ref().and_then(|n| n.coll.clone()),
        document_key,
        full_document,
        updated_fields,
        removed_fields,
        renamed_to,
        at_ms,
        bytes: 0,
    };
    flat.bytes = measure_event(&flat);
    flat
}

/// Roughly how much memory one event's bodies occupy, for the byte bound.
///
/// Measured once, here, and carried on the event: both the backend buffer and
/// the view are bounded by it, and re-measuring a thousand documents on every
/// poll would cost more than the bound saves.
///
/// Removed fields count. An `$unset`-heavy update carries its whole change in
/// that list of names and nothing in the other bodies, so leaving them out
/// gave a byte bound that did not bound the one shape of event most likely to
/// pile up unnoticed.
pub fn measure_event(event: &ChangeEvent) -> usize {
    let json = |v: &Option<serde_json::Value>| v.as_ref().map(|j| j.to_string().len()).unwrap_or(0);
    let removed: usize = event
        .removed_fields
        .as_ref()
        .map(|fields| fields.iter().map(|name| name.len() + 3).sum())
        .unwrap_or(0);
    json(&event.full_document) + json(&event.updated_fields) + json(&event.document_key) + removed
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
async fn run_stream(state_streams: Arc<LiveStream>, client: mongodb::Client, my_generation: u64) {
    use futures::StreamExt;

    let pipeline = build_pipeline(&state_streams.operation_types);
    let resume = state_streams
        .resume_token
        .lock()
        .ok()
        .and_then(|p| p.token.clone());
    // Every reader records through this, so the rule about stragglers lives in
    // one place.
    let remember = |token: Option<ResumeToken>| {
        if let Ok(mut point) = state_streams.resume_token.lock() {
            record_resume_token(&mut point, my_generation, token);
        }
    };

    // Three levels, one cursor shape: a collection, a database, or the whole
    // deployment. The driver exposes `watch()` at each of those, so the only
    // difference here is which handle it is called on.
    //
    // Deliberately NOT boxed. All three are the same `ChangeStream` type, and
    // it is the type that carries `resume_token()` — the cursor's own position,
    // which is the only way to learn that it has advanced past batches holding
    // nothing this stream was watching for.
    let started = match (&state_streams.database, &state_streams.collection) {
        (Some(database), Some(collection)) => {
            let coll = client
                .database(database)
                .collection::<Document>(collection);
            let mut action = coll.watch().pipeline(pipeline);
            if let Some(token) = resume {
                action = action.resume_after(token);
            }
            action.await
        }
        (Some(database), None) => {
            let db = client.database(database);
            let mut action = db.watch().pipeline(pipeline);
            if let Some(token) = resume {
                action = action.resume_after(token);
            }
            action.await
        }
        // Deployment-wide. Every namespace the user can read, so the event's own
        // `ns` is the only thing that says where a change came from.
        (None, _) => {
            let mut action = client.watch().pipeline(pipeline);
            if let Some(token) = resume {
                action = action.resume_after(token);
            }
            action.await
        }
    };

    let mut stream = match started {
        Ok(stream) => stream,
        Err(err) => {
            // Only if this reader is still the live one. Opening a cursor is
            // not instant, and a pause-then-resume during it retires this task
            // while its `watch()` is still in flight — reporting that failure
            // would put the panel in Error over a cursor nobody is reading,
            // and the replacement can never clear it because it only promotes
            // a stream that is still `Starting`.
            if state_streams.generation.load(Ordering::SeqCst) == my_generation {
                let (status, message) = describe_stream_error(&err.to_string());
                if let Ok(mut s) = state_streams.status.lock() {
                    *s = status;
                }
                if let Ok(mut e) = state_streams.error.lock() {
                    *e = Some(message);
                }
            }
            return;
        }
    };

    // Only if this reader is still the live one AND nobody paused while the
    // cursor was opening — otherwise the panel shows a running stream whose
    // reader is about to retire, and its toggle offers Pause on something
    // already stopped.
    if state_streams.generation.load(Ordering::SeqCst) != my_generation {
        return;
    }
    // A resume point before the first event ever arrives. Without it a watch
    // paused while idle had nothing to come back to, so resuming opened at the
    // current time and skipped the entire pause.
    remember(stream.resume_token());
    if let Ok(mut s) = state_streams.status.lock() {
        if *s == StreamStatus::Starting {
            *s = StreamStatus::Running;
        }
    }

    loop {
        // Registered BEFORE the generation is checked, so a retirement landing
        // between the two still wakes this rather than leaving it parked until
        // the collection happens to change.
        let retired = state_streams.retired.notified();
        tokio::pin!(retired);
        retired.as_mut().enable();
        if state_streams.generation.load(Ordering::SeqCst) != my_generation {
            remember(stream.resume_token());
            return;
        }
        // Dropping the half-finished `next()` is safe here in a way it would
        // not be mid-stream: this reader is being abandoned along with its
        // cursor, and its replacement resumes from the point recorded above.
        let next = tokio::select! {
            biased;
            _ = &mut retired => {
                remember(stream.resume_token());
                return;
            }
            next = stream.next() => next,
        };
        match next {
            Some(Ok(event)) => {
                let token = event.id.clone();
                let flat = flatten_event(event, state_streams.database.as_deref().unwrap_or(""));
                // Re-checked after the await, and checked while HOLDING the
                // buffer lock that every retirement also takes. This task may
                // have been retired while it was blocked, and its event
                // belongs to a cursor nobody is watching any more — but a
                // check made before taking the lock could pass and then be
                // overtaken by a pause and a resume, letting a retired reader
                // append an event the replacement will read again from the
                // older token. Two copies, two sequence numbers, and nothing
                // downstream can tell they are the same change.
                let Ok(mut buffer) = state_streams.buffer.lock() else {
                    return;
                };
                if state_streams.generation.load(Ordering::SeqCst) != my_generation {
                    return;
                }
                if let Ok(mut point) = state_streams.resume_token.lock() {
                    record_resume_token(&mut point, my_generation, Some(token));
                }
                push_event(&mut buffer, flat, BUFFER_CAP);
            }
            Some(Err(err)) => {
                // Only if this reader is still the live one. A retired cursor
                // can fail long after its replacement is happily running, and
                // writing that into the shared stream would show an error for
                // a tail that is working.
                if state_streams.generation.load(Ordering::SeqCst) != my_generation {
                    return;
                }
                let (status, message) = describe_stream_error(&err.to_string());
                if let Ok(mut s) = state_streams.status.lock() {
                    *s = status;
                }
                if let Ok(mut e) = state_streams.error.lock() {
                    *e = Some(message);
                }
                return;
            }
            // The cursor ended on its own: an invalidate after the watched
            // collection was dropped or renamed, or a connection that went
            // away. Leaving the status at Running would have the panel poll
            // forever against a reader that no longer exists.
            None => {
                if state_streams.generation.load(Ordering::SeqCst) == my_generation {
                    if let Ok(mut s) = state_streams.status.lock() {
                        *s = StreamStatus::Ended;
                    }
                }
                return;
            }
        }
    }
}

/// Remember where a stream would restart.
///
/// Taken from the CURSOR rather than from the last event, and taken again
/// whenever a reader hands control back. A cursor advances through batches
/// that carry no matching event — a narrow operation filter on a busy
/// deployment does little else — and its post-batch token moves with them, so
/// a stream that only recorded event tokens kept a resume point that aged
/// further and further behind the oplog until resuming it failed outright.
///
/// Refused from a reader older than the one that wrote last: retirement does
/// not stop a straggler from surfacing later with a stale cursor position.
pub fn record_resume_token(point: &mut ResumePoint, generation: u64, token: Option<ResumeToken>) {
    if token.is_none() || generation < point.generation {
        return;
    }
    point.generation = generation;
    point.token = token;
}

/// What a replacement keeps from the stream it replaces.
pub struct CarriedOver {
    pub generation: Arc<AtomicU64>,
    pub retired: Arc<tokio::sync::Notify>,
    pub resume_token: Arc<Mutex<ResumePoint>>,
}

/// Shared when the replacement watches the same target, fresh otherwise.
///
/// Same target means the same connection and the same database: only the
/// operation filter is being rebuilt, so the old cursor's position is still a
/// place the new one can start from. A different target has nothing to inherit
/// — its resume point would be meaningless, and a shared generation counter
/// would retire readers that have nothing to do with each other.
pub fn carry_over(
    existing: Option<&Arc<LiveStream>>,
    connection_id: &str,
    database: &Option<String>,
) -> CarriedOver {
    let carried =
        existing.filter(|e| e.connection_id == connection_id && &e.database == database);
    CarriedOver {
        generation: carried
            .map(|e| Arc::clone(&e.generation))
            .unwrap_or_else(|| Arc::new(AtomicU64::new(0))),
        retired: carried.map(|e| Arc::clone(&e.retired)).unwrap_or_default(),
        resume_token: carried
            .map(|e| Arc::clone(&e.resume_token))
            .unwrap_or_default(),
    }
}

/// Retire whoever is reading and claim the next generation.
///
/// Bumped while holding the BUFFER lock, which is the same lock a reader holds
/// while it checks its generation and publishes. Without that shared point,
/// retirement is not atomic with buffering: a reader can pass its check, be
/// retired here, and still append an event that its replacement then reads
/// again from the older resume token.
pub fn retire_reader(stream: &LiveStream) -> u64 {
    let claimed = {
        let _publish = stream.buffer.lock();
        stream.generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    // Wake whoever is parked in `next().await` so it lets go of its cursor now
    // rather than whenever the collection next changes.
    stream.retired.notify_waiters();
    claimed
}

fn spawn_reader(state: &AppState, stream: Arc<LiveStream>) -> Result<(), String> {
    let client = state
        .connections
        .lock_safe()?
        .get(&stream.connection_id)
        .cloned()
        .ok_or_else(|| format!("connection {} is not open", stream.connection_id))?;
    let my_generation = retire_reader(&stream);
    tauri::async_runtime::spawn(run_stream(stream, client, my_generation));
    Ok(())
}

/// Begin watching. `collection` omitted watches the whole database.
#[tauri::command]
pub async fn start_change_stream(
    state: tauri::State<'_, AppState>,
    stream_id: String,
    connection_id: String,
    database: Option<String>,
    collection: Option<String>,
    operation_types: Vec<String>,
) -> Result<(), String> {
    let database = database.filter(|d| !d.trim().is_empty());
    let collection = collection.filter(|c| !c.trim().is_empty());

    // A remount is not a restart. An inactive tab is unmounted and mounts again
    // when the user returns, and replacing the stream then would throw away the
    // buffer and the resume token this whole design exists to keep. If an
    // identical stream is already running, leave it be.
    let existing = state.change_streams.lock_safe()?.get(&stream_id).cloned();
    if let Some(existing) = &existing {
        let same = existing.connection_id == connection_id
            && existing.database == database
            && existing.collection == collection
            && existing.operation_types == operation_types;
        if same {
            return Ok(());
        }
    }

    // Different filters, same namespace: the cursor has to be rebuilt because
    // the `$match` lives in the pipeline, but the old resume point is still a
    // valid place in the oplog. Carrying it over is what stops a filter change
    // from silently skipping everything that happened during a pause.
    //
    // The point itself is SHARED with the replacement rather than copied out of
    // the old stream. Retiring a reader does not stop it instantly — it wakes,
    // records where its cursor actually got to, and only then lets go — so a
    // copy taken here is the position before that final update, and on a
    // narrowly filtered stream that can be far behind. Sharing the slot means
    // the straggler's last word lands where the replacement will read it. The
    // generation counter travels with it for the same reason: it is what keeps
    // a late write from overtaking a newer one, and a counter that restarted at
    // zero would make every straggler look current.
    let CarriedOver {
        generation,
        retired,
        resume_token,
    } = carry_over(existing.as_ref(), &connection_id, &database);
    let inherited_status = existing
        .as_ref()
        .and_then(|e| e.status.lock().ok().map(|s| s.clone()));

    let _ = stop_change_stream_impl(&state, &stream_id);

    // A filter change on a paused tail stays paused. Rebuilding the cursor is
    // unavoidable — the `$match` is server-side — but it must not resume the
    // watch behind the user's back, and with the token inherited above nothing
    // buffered during the pause is lost when they do resume.
    let was_paused = inherited_status == Some(StreamStatus::Paused);

    let stream = Arc::new(LiveStream {
        buffer: Mutex::new(StreamBuffer::default()),
        status: Mutex::new(if was_paused {
            StreamStatus::Paused
        } else {
            StreamStatus::Starting
        }),
        error: Mutex::new(None),
        generation,
        retired,
        resume_token,
        connection_id,
        database,
        collection,
        operation_types,
    });
    state
        .change_streams
        .lock_safe()?
        .insert(stream_id, stream.clone());
    // No reader while paused: it starts when the user resumes, from the token
    // carried over above.
    if was_paused {
        return Ok(());
    }
    if let Err(err) = spawn_reader(&state, stream.clone()) {
        // The panel polls for status, so a failure to start has to land THERE
        // rather than only in a rejected promise the caller drops. A mock
        // connection has no client at all, and would otherwise show "starting"
        // for ever.
        if let Ok(mut s) = stream.status.lock() {
            *s = StreamStatus::Unsupported;
        }
        if let Ok(mut e) = stream.error.lock() {
            *e = Some(err.clone());
        }
        return Err(err);
    }
    Ok(())
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

/// What a stream is actually watching, for a panel that has just mounted.
///
/// A watch tab is unmounted while it is inactive, so its component state — the
/// operation filter above all — comes back empty when the user returns. Asking
/// what the stream is running lets the panel adopt it instead of starting what
/// looks like a different stream and throwing the buffer away.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub connection_id: String,
    pub database: Option<String>,
    pub collection: Option<String>,
    pub operation_types: Vec<String>,
    pub status: StreamStatus,
}

/// `None` when nothing is watching under that id — a first mount, or a tab
/// whose stream was stopped.
#[tauri::command]
pub async fn describe_change_stream(
    state: tauri::State<'_, AppState>,
    stream_id: String,
) -> Result<Option<StreamInfo>, String> {
    let Some(stream) = state.change_streams.lock_safe()?.get(&stream_id).cloned() else {
        return Ok(None);
    };
    Ok(Some(StreamInfo {
        connection_id: stream.connection_id.clone(),
        database: stream.database.clone(),
        collection: stream.collection.clone(),
        operation_types: stream.operation_types.clone(),
        status: stream
            .status
            .lock()
            .map(|s| s.clone())
            .unwrap_or(StreamStatus::Error),
    }))
}

/// Stop the cursor but keep the buffer and the resume token.
#[tauri::command]
pub async fn pause_change_stream(
    state: tauri::State<'_, AppState>,
    stream_id: String,
) -> Result<(), String> {
    let stream = get_stream(&state, &stream_id)?;
    // Retires the reader. It may be blocked in `next().await` and only notice
    // when the next event arrives — which is fine, because it checks the
    // generation before pushing anything.
    retire_reader(&stream);
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
        retire_reader(&stream);
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
