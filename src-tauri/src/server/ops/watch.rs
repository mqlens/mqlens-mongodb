//! Change streams on a server connection: `ChangeStreamService.Watch` as a
//! cursor the live tail in `crate::change_streams` reads like a local one.

use crate::change_streams::Source;
use crate::server::channel::client;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::change_stream_service_client::ChangeStreamServiceClient;
use crate::server::pb::mqlens::v1::{watch_response, WatchRequest, WatchResponse};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::server::session::{next_message, Speaking};
use crate::AppState;
use mongodb::bson::{Bson, RawDocumentBuf};
use mongodb::change_stream::event::ResumeToken;
use std::sync::Arc;
use tonic::Streaming;

/// What a tail on `conn` reads from, once the connection may watch.
pub(crate) async fn source(state: &AppState, conn: Arc<RemoteConn>) -> Result<Source, String> {
    routes::require("start_change_stream", &conn)?;
    let session = session_for(state, &conn).await?;
    Ok(Source::Remote(conn, session))
}

/// An open `Watch`. Like a driver cursor it yields raw events and knows its
/// own resume token, which the server also sends when the cursor moves
/// without an event.
pub(crate) struct RemoteCursor {
    stream: Streaming<WatchResponse>,
    token: Option<ResumeToken>,
}

/// Opens a watch, returning once the server says its cursor is open.
pub(crate) async fn open(
    conn: &RemoteConn,
    session: &Speaking,
    database: Option<&str>,
    collection: Option<&str>,
    operation_types: &[String],
    resume: Option<ResumeToken>,
) -> Result<RemoteCursor, String> {
    let request = WatchRequest {
        connection_id: conn.remote_id.clone(),
        database: database.unwrap_or_default().to_string(),
        collection: collection.unwrap_or_default().to_string(),
        operation_types: operation_types.to_vec(),
        resume_after: match resume {
            Some(token) => token_bytes(&token)?.into(),
            None => Default::default(),
        },
    };
    let stream = session
        .open_stream(request, |channel, request| async move {
            client!(ChangeStreamServiceClient, channel)
                .watch(request)
                .await
        })
        .await?;
    let mut cursor = RemoteCursor {
        stream,
        token: None,
    };
    // Bounded: a server can answer and then never say the cursor is open.
    match next_message(&mut cursor.stream).await? {
        Some(WatchResponse {
            kind: Some(watch_response::Kind::ResumeToken(token)),
        }) => {
            cursor.token = token_from(&token)?;
            Ok(cursor)
        }
        _ => Err("MQLens Server ended the change stream before it opened".to_string()),
    }
}

impl RemoteCursor {
    /// The next event, `None` once the server ends the stream. Cancel-safe:
    /// the token is only written between awaits.
    pub(crate) async fn next(&mut self) -> Option<Result<RawDocumentBuf, String>> {
        loop {
            // Bounded: the server sends at least a moving resume token while
            // nothing changes, so a long silence is a stall.
            let kind = match next_message(&mut self.stream).await {
                Ok(Some(message)) => message.kind,
                Ok(None) => return None,
                Err(err) => return Some(Err(err)),
            };
            match kind {
                Some(watch_response::Kind::Event(bytes)) => {
                    return Some(self.event(bytes.to_vec()));
                }
                Some(watch_response::Kind::ResumeToken(bytes)) => match token_from(&bytes) {
                    Ok(Some(token)) => self.token = Some(token),
                    Ok(None) => {}
                    Err(err) => return Some(Err(err)),
                },
                None => {}
            }
        }
    }

    /// An event's `_id` is its resume token, as on a local cursor.
    fn event(&mut self, bytes: Vec<u8>) -> Result<RawDocumentBuf, String> {
        let raw = RawDocumentBuf::from_bytes(bytes).map_err(|e| e.to_string())?;
        if let Some(id) = crate::db::stored(raw.clone())?.get("_id").cloned() {
            self.token = mongodb::bson::from_bson(id).ok();
        }
        Ok(raw)
    }

    pub(crate) fn resume_token(&self) -> Option<ResumeToken> {
        self.token.clone()
    }
}

/// A resume token from its BSON; empty is none.
fn token_from(bytes: &[u8]) -> Result<Option<ResumeToken>, String> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let raw = RawDocumentBuf::from_bytes(bytes.to_vec()).map_err(|e| e.to_string())?;
    let doc = crate::db::stored(raw)?;
    mongodb::bson::from_bson(Bson::Document(doc))
        .map(Some)
        .map_err(|e| e.to_string())
}

fn token_bytes(token: &ResumeToken) -> Result<Vec<u8>, String> {
    match mongodb::bson::to_bson(token).map_err(|e| e.to_string())? {
        Bson::Document(doc) => mongodb::bson::to_vec(&doc).map_err(|e| e.to_string()),
        other => Err(format!("a resume token is a document, not {other}")),
    }
}

#[cfg(test)]
mod tests {
    use crate::change_streams::{
        pause_change_stream_impl, poll_change_stream_impl, resume_change_stream_impl,
        start_change_stream_impl, stop_server_streams, StreamPoll, StreamStatus,
    };
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use crate::server::pb::mqlens::v1::{watch_response, WatchResponse};
    use crate::AppState;
    use mongodb::bson::{doc, Document};
    use std::time::Duration;

    fn token(tag: &str) -> Document {
        doc! { "_data": tag }
    }

    fn bytes(doc: &Document) -> Vec<u8> {
        mongodb::bson::to_vec(doc).unwrap()
    }

    fn event(tag: &str, id: i32) -> WatchResponse {
        let event = doc! {
            "_id": token(tag),
            "operationType": "insert",
            "ns": { "db": "orders", "coll": "items" },
            "documentKey": { "_id": id },
            // Keys that look like a type wrapper arrive as stored.
            "fullDocument": { "_id": id, "v": { "$numberLong": "7", "other": 1 } },
        };
        WatchResponse {
            kind: Some(watch_response::Kind::Event(bytes(&event).into())),
        }
    }

    fn moved(tag: &str) -> WatchResponse {
        WatchResponse {
            kind: Some(watch_response::Kind::ResumeToken(bytes(&token(tag)).into())),
        }
    }

    /// Connected over API version 4, which serves change streams.
    async fn watching(env: &Env) -> (AppState, String) {
        env.fake.with(|s| s.max_api_version = 4);
        connected(env).await
    }

    async fn start(state: &AppState, id: &str) -> Result<(), String> {
        start_change_stream_impl(
            state,
            "main",
            "s1".to_string(),
            id.to_string(),
            Some("orders".to_string()),
            Some("items".to_string()),
            vec!["insert".to_string()],
        )
        .await
    }

    async fn poll_until(state: &AppState, done: impl Fn(&StreamPoll) -> bool) -> StreamPoll {
        for _ in 0..250 {
            if let Some(poll) = poll_change_stream_impl(state, "main", "s1", None).unwrap() {
                if done(&poll) {
                    return poll;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("{:?}", poll_change_stream_impl(state, "main", "s1", None));
    }

    async fn eventually(check: impl Fn() -> bool) {
        for _ in 0..250 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("never happened");
    }

    fn resume_point(state: &AppState) -> Option<Document> {
        let streams = state.change_streams.lock().unwrap();
        let point = streams.get("s1")?.resume_token.lock().unwrap();
        let token = point.token.clone()?;
        mongodb::bson::to_bson(&token).ok()?.as_document().cloned()
    }

    // A watch on a server connection runs on the server, and its events read
    // as local mode reads them.
    #[tokio::test]
    async fn a_server_connection_tails_changes_on_the_server() {
        let env = Env::new().await;
        env.fake.with(|s| s.watch_messages = vec![event("e1", 1)]);
        let (state, id) = watching(&env).await;

        start(&state, &id).await.unwrap();
        let poll = poll_until(&state, |p| !p.events.is_empty()).await;

        assert_eq!(poll.status, StreamStatus::Running);
        let got = &poll.events[0];
        assert_eq!(got.operation_type, "insert");
        assert_eq!(
            (got.database.as_str(), got.collection.as_deref()),
            ("orders", Some("items"))
        );
        assert_eq!(
            got.full_document,
            Some(serde_json::json!({ "_id": 1, "v": { "$numberLong": "7", "other": 1 } }))
        );
        let sent = env.fake.with(|s| s.watches[0].clone());
        assert_eq!(sent.connection_id, "c1");
        assert_eq!(
            (sent.database.as_str(), sent.collection.as_str()),
            ("orders", "items")
        );
        assert_eq!(sent.operation_types, vec!["insert".to_string()]);
        assert!(sent.resume_after.is_empty());
    }

    // Pausing lets go of the server cursor; resuming opens a new one where the
    // cursor really was, even past the last event.
    #[tokio::test]
    async fn pausing_ends_the_watch_and_resuming_continues_from_the_cursor() {
        let env = Env::new().await;
        env.fake
            .with(|s| s.watch_messages = vec![event("e1", 1), moved("past-e1")]);
        let (state, id) = watching(&env).await;
        start(&state, &id).await.unwrap();
        poll_until(&state, |p| !p.events.is_empty()).await;
        // Time for the reader to take the token sent after the event; the
        // cursor's position is written down when its reader is retired.
        tokio::time::sleep(Duration::from_millis(100)).await;

        pause_change_stream_impl(&state, "s1").unwrap();
        eventually(|| env.fake.with(|s| s.watches_ended) == 1).await;
        eventually(|| resume_point(&state) == Some(token("past-e1"))).await;

        env.fake.with(|s| s.watch_messages.clear());
        resume_change_stream_impl(&state, "s1").await.unwrap();
        eventually(|| env.fake.with(|s| s.watches.len()) == 2).await;
        let resumed = env.fake.with(|s| s.watches[1].clone());
        assert_eq!(resumed.resume_after.to_vec(), bytes(&token("past-e1")));
    }

    // A standalone refuses change streams, and the panel says so as it does
    // for a local standalone.
    #[tokio::test]
    async fn a_standalone_behind_the_server_says_why() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.watch_failure = Some(tonic::Status::internal(
                "The $changeStream stage is only supported on replica sets",
            ))
        });
        let (state, id) = watching(&env).await;

        start(&state, &id).await.unwrap();
        let poll = poll_until(&state, |p| p.status != StreamStatus::Starting).await;

        assert_eq!(poll.status, StreamStatus::Unsupported);
        assert!(poll.error.unwrap().contains("standalone"));
    }

    // A server that predates change streams says what to update.
    #[tokio::test]
    async fn an_older_server_cannot_watch() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        let err = start(&state, &id).await.unwrap_err();

        assert!(err.contains("API version 4"), "{err}");
        assert!(env.fake.with(|s| s.watches.is_empty()));
    }

    // Disconnecting ends the server watch: nothing may keep streaming from a
    // connection that is gone.
    #[tokio::test]
    async fn a_watch_ends_with_its_connection() {
        let env = Env::new().await;
        let (state, id) = watching(&env).await;
        start(&state, &id).await.unwrap();
        poll_until(&state, |p| p.status == StreamStatus::Running).await;

        crate::disconnect_db_impl(&state, &id).await.unwrap();

        eventually(|| env.fake.with(|s| s.watches_ended) == 1).await;
        assert!(poll_change_stream_impl(&state, "main", "s1", None)
            .unwrap()
            .is_none());
    }

    // Nor from a locked vault, whose key the session needs.
    #[tokio::test]
    async fn locking_the_vault_ends_every_server_watch() {
        let env = Env::new().await;
        let (state, id) = watching(&env).await;
        start(&state, &id).await.unwrap();
        poll_until(&state, |p| p.status == StreamStatus::Running).await;

        stop_server_streams(&state).unwrap();

        eventually(|| env.fake.with(|s| s.watches_ended) == 1).await;
        assert!(poll_change_stream_impl(&state, "main", "s1", None)
            .unwrap()
            .is_none());
    }
    // A vault reset ends every server watch too: the account and its session
    // are gone, but an open watch would go on streaming.
    #[tokio::test]
    async fn resetting_the_vault_ends_every_server_watch() {
        let env = Env::new().await;
        let (state, id) = watching(&env).await;
        start(&state, &id).await.unwrap();
        poll_until(&state, |p| p.status == StreamStatus::Running).await;

        crate::server::commands::reset_accounts_with_policy(
            &state,
            &env.path,
            Some(crate::server::fake::KEY),
            Vec::new(),
            true,
        )
        .await
        .unwrap()
        .finish()
        .await
        .unwrap();

        eventually(|| env.fake.with(|s| s.watches_ended) == 1).await;
        assert!(poll_change_stream_impl(&state, "main", "s1", None)
            .unwrap()
            .is_none());
    }

    // Resuming a server watch waits for its session, and the tab can close in
    // the meantime: a stream stopped by then gets no reader nobody could stop.
    #[tokio::test]
    async fn a_stream_stopped_while_resuming_is_not_restarted() {
        let env = Env::new().await;
        let (state, id) = watching(&env).await;
        start(&state, &id).await.unwrap();
        poll_until(&state, |p| p.status == StreamStatus::Running).await;
        pause_change_stream_impl(&state, "s1").unwrap();
        eventually(|| env.fake.with(|s| s.watches_ended) == 1).await;

        // What resuming holds once its source is found...
        let stream = state
            .change_streams
            .lock()
            .unwrap()
            .get("s1")
            .cloned()
            .unwrap();
        let conn = state.server.remote(&id).unwrap().unwrap();
        let source = super::source(&state, conn).await.unwrap();
        // ...after the tab closed.
        crate::change_streams::stop_change_stream_impl(&state, "s1").unwrap();
        crate::change_streams::spawn_if_installed(&state, "s1", stream, source).unwrap();

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(env.fake.with(|s| s.watches.len()), 1);
    }

    // Each connection speaks the API version it agreed, even when another
    // connection on the same account agreed another: one made before the
    // server was upgraded, one after.
    #[tokio::test]
    async fn each_connection_speaks_its_own_api_version() {
        use crate::server::channel::client;
        use crate::server::pb::mqlens::v1::metadata_service_client::MetadataServiceClient;
        use crate::server::pb::mqlens::v1::MongoVersionRequest;
        let env = Env::new().await;
        let (state, older) = connected(&env).await;
        env.fake.with(|s| {
            s.max_api_version = 4;
            let mut second = s.connections[0].clone();
            second.id = "c2".to_string();
            s.connections.push(second);
        });
        let newer =
            crate::server::commands::server_connect_impl(&state, &env.path, &env.account.id, "c2")
                .await
                .unwrap()
                .id;
        let newer = state.server.remote(&newer).unwrap().unwrap();
        let older = state.server.remote(&older).unwrap().unwrap();
        assert_eq!((older.api_version, newer.api_version), (2, 4));

        let speaking = crate::server::ops::session_for(&state, &newer)
            .await
            .unwrap();
        crate::server::ops::session_for(&state, &older)
            .await
            .unwrap();
        env.fake.with(|s| s.api_versions_seen.borrow_mut().clear());
        speaking
            .call(
                MongoVersionRequest {
                    connection_id: "c2".to_string(),
                },
                |channel, request| async move {
                    client!(MetadataServiceClient, channel)
                        .mongo_version(request)
                        .await
                },
            )
            .await
            .unwrap();

        assert_eq!(
            env.fake.with(|s| s.api_versions_seen.borrow().clone()),
            vec![4]
        );
    }
    /// Starts with a source found before `teardown` ran, as a start whose
    /// source lookup overlapped it would.
    async fn start_after(
        state: &AppState,
        id: &str,
        teardown: impl std::future::Future<Output = ()>,
    ) -> Result<(), String> {
        let conn = state.server.remote(id).unwrap().unwrap();
        let found = super::source(state, conn).await.unwrap();
        teardown.await;
        crate::change_streams::start_change_stream_from(
            state,
            "main",
            "s1".to_string(),
            id.to_string(),
            Some("orders".to_string()),
            Some("items".to_string()),
            Vec::new(),
            async { Ok(found) },
        )
        .await
    }

    // A start that found its server connection just before it was closed
    // opens no watch on it: nothing would be left to stop it.
    #[tokio::test]
    async fn a_start_overlapping_a_disconnect_opens_no_watch() {
        let env = Env::new().await;
        let (state, id) = watching(&env).await;

        let started = start_after(&state, &id, async {
            crate::disconnect_db_impl(&state, &id).await.unwrap();
        })
        .await;

        assert!(started.is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(env.fake.with(|s| s.watches.is_empty()));
    }

    // Nor one that overlapped the vault locking.
    #[tokio::test]
    async fn a_start_overlapping_a_vault_lock_opens_no_watch() {
        let env = Env::new().await;
        let (state, id) = watching(&env).await;

        let started = start_after(&state, &id, async {
            *state.vault_key.lock().unwrap() = None;
            state.server.clear().await;
            stop_server_streams(&state).unwrap();
        })
        .await;

        assert!(started.is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(env.fake.with(|s| s.watches.is_empty()));
    }

    // A server that answers a watch but never says its cursor is open does
    // not leave the tab starting for ever.
    #[tokio::test]
    async fn a_watch_that_never_opens_gives_up() {
        let env = Env::new().await;
        env.fake.with(|s| s.watch_stall_opening = true);
        let (state, id) = watching(&env).await;

        start(&state, &id).await.unwrap();
        let poll = poll_until(&state, |p| p.status != StreamStatus::Starting).await;

        assert_eq!(poll.status, StreamStatus::Error);
    }
    // An open watch that stops hearing from the server says so: a server
    // watch hears at least a moving resume token while nothing changes.
    #[tokio::test]
    async fn a_watch_that_falls_silent_gives_up() {
        let env = Env::new().await;
        let (state, id) = watching(&env).await;

        start(&state, &id).await.unwrap();
        poll_until(&state, |p| p.status == StreamStatus::Running).await;
        let poll = poll_until(&state, |p| p.status != StreamStatus::Running).await;

        assert_eq!(poll.status, StreamStatus::Error);
    }

    // A resume that cannot find its server source says why on the stream:
    // the panel polls for status, not for the rejected resume.
    #[tokio::test]
    async fn a_resume_that_cannot_reach_its_account_says_why() {
        let env = Env::new().await;
        let (state, id) = watching(&env).await;
        start(&state, &id).await.unwrap();
        poll_until(&state, |p| p.status == StreamStatus::Running).await;
        pause_change_stream_impl(&state, "s1").unwrap();

        *state.vault_key.lock().unwrap() = None;
        assert!(resume_change_stream_impl(&state, "s1").await.is_err());

        let poll = poll_change_stream_impl(&state, "main", "s1", None)
            .unwrap()
            .unwrap();
        assert_ne!(poll.status, StreamStatus::Starting);
        assert!(poll.error.is_some());
    }
}
