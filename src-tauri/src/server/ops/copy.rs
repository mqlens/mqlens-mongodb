//! Copying through MQLens Server: a server connection as either side of a
//! copy, read with Find and written with InsertMany, as a desktop task.

use crate::server::channel::client;
use crate::server::ops::export::ExportFrom;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::data_service_client::DataServiceClient;
use crate::server::pb::mqlens::v1::ddl_service_client::DdlServiceClient;
use crate::server::pb::mqlens::v1::metadata_service_client::MetadataServiceClient;
use crate::server::pb::mqlens::v1::write_service_client::WriteServiceClient;
use crate::server::pb::mqlens::v1::{
    CountRequest, CreateIndexRequest, CreateViewRequest, DropCollectionRequest, FindBatch,
    FindRequest, GetCollectionOptionsRequest, InsertManyRequest, InsertManyResponse,
    ListCollectionsRequest, ListIndexesRequest, ReplaceDocumentRequest,
};
use crate::server::remote::RemoteConn;
use crate::server::routes::{self, OpClass};
use crate::server::session::{next_message, Speaking};
use crate::AppState;
use mongodb::bson::{Bson, Document, RawDocumentBuf};
use std::sync::Arc;

/// MongoDB's code for a duplicate key, which a copy counts as skipped.
const DUPLICATE_KEY: i32 = 11000;

/// The most document bytes one InsertMany carries, as the server's own Find
/// batches are bounded: a batch of large documents goes in several requests.
const MAX_REQUEST_BYTES: usize = 4 << 20;

/// `batch` in runs of at most `MAX_REQUEST_BYTES`; a document larger than
/// that goes alone.
fn by_size(batch: &[RawDocumentBuf]) -> Vec<&[RawDocumentBuf]> {
    let mut runs = Vec::new();
    let (mut start, mut bytes) = (0, 0);
    for (i, doc) in batch.iter().enumerate() {
        let n = doc.as_bytes().len();
        if i > start && bytes + n > MAX_REQUEST_BYTES {
            runs.push(&batch[start..i]);
            (start, bytes) = (i, 0);
        }
        bytes += n;
    }
    if start < batch.len() {
        runs.push(&batch[start..]);
    }
    runs
}

/// Each document a Find streams, as the BSON the server sent, so what is
/// copied is exactly what is stored, even BSON a Document cannot hold.
pub(crate) type RawDocuments =
    std::pin::Pin<Box<dyn futures::Stream<Item = Result<RawDocumentBuf, String>> + Send>>;

fn raw_documents(stream: tonic::Streaming<FindBatch>) -> RawDocuments {
    Box::pin(futures::stream::unfold(
        (
            stream,
            std::collections::VecDeque::<prost::bytes::Bytes>::new(),
        ),
        |(mut stream, mut pending)| async move {
            loop {
                if let Some(bytes) = pending.pop_front() {
                    let doc = RawDocumentBuf::from_bytes(bytes.to_vec()).map_err(|e| e.to_string());
                    return Some((doc, (stream, pending)));
                }
                match next_message(&mut stream).await {
                    Ok(Some(batch)) => pending.extend(batch.documents_bson),
                    Ok(None) => return None,
                    Err(e) => return Some((Err(e), (stream, pending))),
                }
            }
        },
    ))
}

/// A server connection as one side of a copy, with its session.
#[derive(Clone)]
pub(crate) struct RemoteSide {
    conn: Arc<RemoteConn>,
    session: Speaking,
}

impl RemoteSide {
    /// For `command`. A target is written to, so it also needs the write
    /// class, and the ddl class when the copy drops, indexes or makes views.
    pub(crate) async fn new(
        state: &AppState,
        conn: Arc<RemoteConn>,
        command: &str,
        target: Option<bool>,
    ) -> Result<Self, String> {
        routes::require(command, &conn)?;
        if let Some(ddl) = target {
            routes::require_class(&conn, OpClass::Write)?;
            if ddl {
                routes::require_class(&conn, OpClass::Ddl)?;
            }
        }
        let session = session_for(state, &conn).await?;
        Ok(Self { conn, session })
    }

    /// Whether two sides reach the same server connection, and so the same
    /// deployment, through whichever accounts or desktop connections.
    pub(crate) fn same_connection(&self, other: &RemoteSide) -> bool {
        self.conn.identity.url == other.conn.identity.url
            && self.conn.identity.tenant == other.conn.identity.tenant
            && self.conn.remote_id == other.conn.remote_id
    }

    fn reader(&self, database: &str, collection: &str) -> ExportFrom {
        ExportFrom::with(
            self.session.clone(),
            self.conn.clone(),
            database,
            collection,
        )
    }

    pub(crate) async fn collection_names(&self, database: &str) -> Result<Vec<String>, String> {
        let request = ListCollectionsRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
        };
        let response = self
            .session
            .call(request, |channel, request| async move {
                client!(MetadataServiceClient, channel)
                    .list_collections(request)
                    .await
            })
            .await
            .map_err(|e| format!("Failed to inspect target: {e}"))?;
        Ok(response.collections.into_iter().map(|c| c.name).collect())
    }

    pub(crate) async fn drop(&self, database: &str, collection: &str) -> Result<(), String> {
        let request = DropCollectionRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            collection: collection.to_string(),
        };
        self.session
            .call(request, |channel, request| async move {
                client!(DdlServiceClient, channel)
                    .drop_collection(request)
                    .await
            })
            .await
            .map(|_| ())
            .map_err(|e| format!("Failed to drop target: {e}"))
    }

    pub(crate) async fn count(
        &self,
        database: &str,
        collection: &str,
        filter: &Document,
    ) -> Result<u64, String> {
        self.reader(database, collection).count(filter).await
    }

    pub(crate) async fn documents(
        &self,
        database: &str,
        collection: &str,
        filter: &Document,
    ) -> Result<RawDocuments, String> {
        let request = FindRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            collection: collection.to_string(),
            filter_json: crate::server::ejson::doc_to_wire(filter),
            raw_bson: true,
            ..Default::default()
        };
        let stream = self
            .session
            .open_stream(request, |channel, request| async move {
                client!(DataServiceClient, channel).find(request).await
            })
            .await?;
        Ok(raw_documents(stream))
    }

    /// How many documents a collection holds, estimated where MongoDB can,
    /// as local mode estimates a database copy's total.
    pub(crate) async fn estimated_count(
        &self,
        database: &str,
        collection: &str,
    ) -> Result<u64, String> {
        let request = CountRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            collection: collection.to_string(),
            filter_json: "{}".to_string(),
            estimate_if_unfiltered: true,
        };
        let response = self
            .session
            .call(request, |channel, request| async move {
                client!(DataServiceClient, channel).count(request).await
            })
            .await?;
        u64::try_from(response.count)
            .map_err(|_| "MQLens Server reported a negative count".to_string())
    }

    async fn insert_many(
        &self,
        database: &str,
        collection: &str,
        batch: &[RawDocumentBuf],
    ) -> Result<InsertManyResponse, String> {
        let request = InsertManyRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            collection: collection.to_string(),
            documents_bson: batch.iter().map(|d| d.as_bytes().to_vec().into()).collect(),
        };
        self.session
            .call(request, |channel, request| async move {
                client!(WriteServiceClient, channel)
                    .insert_many(request)
                    .await
            })
            .await
    }

    /// Stores a batch, unordered: `(copied, skipped)`, a duplicate key
    /// skipped and any other refusal failing the copy, as local mode does.
    pub(crate) async fn insert(
        &self,
        database: &str,
        collection: &str,
        batch: &[RawDocumentBuf],
    ) -> Result<(u64, u64), String> {
        let (mut copied, mut skipped) = (0, 0);
        for run in by_size(batch) {
            let response = self
                .insert_many(database, collection, run)
                .await
                .map_err(|e| format!("Insert into target failed: {e}"))?;
            if let Some(refused) = response.refused.iter().find(|r| r.code != DUPLICATE_KEY) {
                return Err(format!("Insert into target failed: {}", refused.message));
            }
            copied += u64::try_from(response.inserted_count).unwrap_or(0);
            skipped += response.refused.len() as u64;
        }
        Ok((copied, skipped))
    }

    /// Stores every document, in batches as local mode does: any refusal, a
    /// duplicate key included, fails the write with `Failed to {label}`.
    pub(crate) async fn insert_all(
        &self,
        database: &str,
        collection: &str,
        docs: Vec<Document>,
        label: &str,
    ) -> Result<(), String> {
        for chunk in docs.chunks(crate::limits::IMPORT_BATCH_SIZE) {
            let batch = chunk
                .iter()
                .map(RawDocumentBuf::from_document)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to {label}: {e}"))?;
            for run in by_size(&batch) {
                let response = self
                    .insert_many(database, collection, run)
                    .await
                    .map_err(|e| format!("Failed to {label}: {e}"))?;
                if let Some(refused) = response.refused.first() {
                    return Err(format!("Failed to {label}: {}", refused.message));
                }
            }
        }
        Ok(())
    }

    /// Which of these documents' `_id`s the collection already holds, each
    /// rendered as local mode renders it.
    pub(crate) async fn existing_ids(
        &self,
        database: &str,
        collection: &str,
        docs: &[Document],
    ) -> Result<std::collections::HashSet<String>, String> {
        use futures::stream::StreamExt;
        let ids: Vec<Bson> = docs.iter().filter_map(|d| d.get("_id").cloned()).collect();
        let mut found = std::collections::HashSet::new();
        for chunk in ids.chunks(crate::limits::IMPORT_BATCH_SIZE) {
            let filter = mongodb::bson::doc! { "_id": { "$in": chunk } };
            let projection = mongodb::bson::doc! { "_id": 1 };
            let mut stream = self
                .reader(database, collection)
                .find(&filter, None, Some(&projection), None, None)
                .await
                .map_err(|e| format!("Failed to check existing documents: {e}"))?;
            while let Some(doc) = stream.next().await {
                let doc = doc.map_err(|e| format!("Cursor read error: {e}"))?;
                if let Some(id) = doc.get("_id") {
                    found.insert(id.to_string());
                }
            }
        }
        Ok(found)
    }

    /// Replaces the document with this `_id`; returns how many changed.
    pub(crate) async fn replace(
        &self,
        database: &str,
        collection: &str,
        id: &Bson,
        replacement: &Document,
    ) -> Result<u64, String> {
        let request = ReplaceDocumentRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            collection: collection.to_string(),
            filter_json: crate::server::ejson::doc_to_wire(
                &mongodb::bson::doc! { "_id": id.clone() },
            ),
            replacement_json: crate::server::ejson::doc_to_wire(replacement),
        };
        let result = self
            .session
            .call(request, |channel, request| async move {
                client!(WriteServiceClient, channel)
                    .replace_document(request)
                    .await
            })
            .await?;
        Ok(u64::try_from(result.modified_count).unwrap_or(0))
    }

    /// Each index with every option it has, as MongoDB lists it.
    pub(crate) async fn index_specs(
        &self,
        database: &str,
        collection: &str,
    ) -> Result<Vec<Document>, String> {
        let request = ListIndexesRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            collection: collection.to_string(),
        };
        let response = self
            .session
            .call(request, |channel, request| async move {
                client!(MetadataServiceClient, channel)
                    .list_indexes(request)
                    .await
            })
            .await
            .map_err(|e| format!("Failed to list source indexes: {e}"))?;
        response
            .indexes
            .into_iter()
            .map(|i| spec_document(&i.spec_bson))
            .collect()
    }

    pub(crate) async fn create_index(
        &self,
        database: &str,
        collection: &str,
        spec: &Document,
    ) -> Result<(), String> {
        let request = CreateIndexRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            collection: collection.to_string(),
            spec_bson: mongodb::bson::to_vec(spec)
                .map_err(|e| e.to_string())?
                .into(),
            ..Default::default()
        };
        self.session
            .call(request, |channel, request| async move {
                client!(MetadataServiceClient, channel)
                    .create_index(request)
                    .await
            })
            .await
            .map(|_| ())
    }

    /// What a view is a view on, and through which pipeline.
    pub(crate) async fn view_definition(
        &self,
        database: &str,
        view: &str,
    ) -> Result<(String, Vec<Document>), String> {
        let request = GetCollectionOptionsRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            collection: view.to_string(),
        };
        let response = self
            .session
            .call(request, |channel, request| async move {
                client!(DdlServiceClient, channel)
                    .get_collection_options(request)
                    .await
            })
            .await
            .map_err(|e| format!("Failed to read view definition: {e}"))?;
        let options = spec_document(&response.options_bson)?;
        let view_on = options
            .get_str("viewOn")
            .map_err(|_| "View has no viewOn".to_string())?
            .to_string();
        let pipeline = options
            .get_array("pipeline")
            .map(|stages| {
                stages
                    .iter()
                    .filter_map(|s| match s {
                        Bson::Document(d) => Some(d.clone()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok((view_on, pipeline))
    }

    pub(crate) async fn create_view(
        &self,
        database: &str,
        view: &str,
        view_on: &str,
        pipeline: &[Document],
    ) -> Result<(), String> {
        let request = CreateViewRequest {
            connection_id: self.conn.remote_id.clone(),
            database: database.to_string(),
            view: view.to_string(),
            view_on: view_on.to_string(),
            pipeline_json: Bson::Array(pipeline.iter().cloned().map(Bson::Document).collect())
                .into_canonical_extjson()
                .to_string(),
        };
        self.session
            .call(request, |channel, request| async move {
                client!(DdlServiceClient, channel)
                    .create_view(request)
                    .await
            })
            .await
            .map(|_| ())
            .map_err(|e| format!("Failed to create view on target: {e}"))
    }
}

/// A BSON document the server sent, read as stored.
fn spec_document(bytes: &[u8]) -> Result<Document, String> {
    let raw = RawDocumentBuf::from_bytes(bytes.to_vec()).map_err(|e| e.to_string())?;
    crate::db::stored(raw)
}

#[cfg(test)]
mod tests {
    use crate::db::copy::{
        preflight_copy_impl, start_collection_copy_impl, start_database_copy_impl, CopyTargetRef,
    };
    use crate::server::fake::{Env, FakeWrite};
    use crate::server::ops::connected;
    use crate::server::pb::mqlens::v1::{CollectionInfo, InsertRefusal};
    use crate::{AppState, TaskInfo};
    use mongodb::bson::{doc, Document};
    use std::time::Duration;

    /// Connected over API version 5 with every op class.
    async fn copying(env: &Env) -> (AppState, String) {
        env.fake.with(|s| {
            s.max_api_version = 5;
            s.connections[0].op_classes = ["read", "write", "ddl"].map(String::from).to_vec();
        });
        connected(env).await
    }

    async fn finished(state: &AppState, task: &TaskInfo) -> TaskInfo {
        for _ in 0..250 {
            let now = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
            if now.status != "running" {
                return now;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the copy never finished");
    }

    async fn copy(
        state: &AppState,
        id: &str,
        mode: &str,
        indexes: bool,
    ) -> Result<TaskInfo, String> {
        start_collection_copy_impl(
            state,
            id,
            "orders",
            "items",
            id,
            "orders",
            "items_copy",
            None,
            indexes,
            mode.to_string(),
        )
        .await
    }

    fn writes(env: &Env) -> Vec<FakeWrite> {
        env.fake.with(|s| s.writes.clone())
    }

    fn inserted(env: &Env) -> Vec<Vec<u8>> {
        writes(env)
            .into_iter()
            .filter_map(|w| match w {
                FakeWrite::InsertMany(r) => Some(r.documents_bson.into_iter().map(|d| d.to_vec())),
                _ => None,
            })
            .flatten()
            .collect()
    }

    // A collection on a server connection copies through the server: every
    // document written as stored, and its indexes with every option.
    #[tokio::test]
    async fn a_collection_copies_through_the_server() {
        let env = Env::new().await;
        let (state, id) = copying(&env).await;
        let stored: Vec<Document> = env.fake.with(|s| s.documents.clone());

        let task = copy(&state, &id, "merge", true).await.unwrap();
        let done = finished(&state, &task).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let summary = done.summary.unwrap();
        assert_eq!(summary.documents_copied, stored.len() as u64);
        assert_eq!(
            inserted(&env),
            stored
                .iter()
                .map(|d| mongodb::bson::to_vec(d).unwrap())
                .collect::<Vec<_>>()
        );
        let specs: Vec<Document> = writes(&env)
            .into_iter()
            .filter_map(|w| match w {
                FakeWrite::CreateIndex(r) => Some(mongodb::bson::from_slice(&r.spec_bson).unwrap()),
                _ => None,
            })
            .collect();
        // Every index but _id_, with its options.
        assert_eq!(specs.len(), 2, "{specs:?}");
        assert_eq!(summary.indexes_created, 2);
        assert!(specs
            .iter()
            .any(|s| s.get_bool("unique") == Ok(true) && s.get_bool("sparse") == Ok(true)));
    }

    // A duplicate key on the target is skipped, as local mode skips it.
    #[tokio::test]
    async fn a_duplicate_on_the_target_is_skipped() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.insert_refusals = vec![InsertRefusal {
                index: 0,
                code: 11000,
                message: "E11000 duplicate key".into(),
            }]
        });
        let (state, id) = copying(&env).await;
        let stored = env.fake.with(|s| s.documents.len()) as u64;

        let done = finished(&state, &copy(&state, &id, "merge", false).await.unwrap()).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let summary = done.summary.unwrap();
        assert_eq!(
            (summary.documents_copied, summary.documents_skipped),
            (stored - 1, 1)
        );
    }

    // Any other refusal fails the copy with the server's reason.
    #[tokio::test]
    async fn a_refused_document_fails_the_copy() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.insert_refusals = vec![InsertRefusal {
                index: 0,
                code: 121,
                message: "Document failed validation".into(),
            }]
        });
        let (state, id) = copying(&env).await;

        let done = finished(&state, &copy(&state, &id, "merge", false).await.unwrap()).await;

        assert_eq!(done.status, "failed");
        assert!(done.error.unwrap().contains("Document failed validation"));
    }

    // Overwriting drops the existing target first.
    #[tokio::test]
    async fn overwrite_drops_an_existing_target_first() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.collections.push(CollectionInfo {
                name: "items_copy".into(),
                r#type: "collection".into(),
            })
        });
        let (state, id) = copying(&env).await;

        let done = finished(
            &state,
            &copy(&state, &id, "overwrite", false).await.unwrap(),
        )
        .await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let order: Vec<&str> = writes(&env)
            .iter()
            .map(|w| match w {
                FakeWrite::DropCollection(r) if r.collection == "items_copy" => "drop",
                FakeWrite::InsertMany(_) => "insert",
                _ => "other",
            })
            .filter(|w| *w != "other")
            .collect();
        assert_eq!(order.first(), Some(&"drop"), "{order:?}");
    }

    // A target the role cannot write to is refused before anything runs.
    #[tokio::test]
    async fn a_target_the_role_cannot_write_is_refused() {
        let env = Env::new().await;
        let (state, id) = copying(&env).await;
        env.fake
            .with(|s| s.connections[0].op_classes = vec!["read".into()]);
        let (state, id) = {
            drop((state, id));
            connected(&env).await
        };

        let err = copy(&state, &id, "merge", false).await.unwrap_err();

        assert!(err.contains("does not allow write"), "{err}");
        assert!(inserted(&env).is_empty());
    }

    // A server before bulk inserts cannot be copied through.
    #[tokio::test]
    async fn an_older_server_cannot_copy() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        let err = copy(&state, &id, "merge", false).await.unwrap_err();

        assert!(err.contains("API version 5"), "{err}");
    }

    // Preflight sees what is already on a server target.
    #[tokio::test]
    async fn preflight_reports_a_server_target() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.collections.push(CollectionInfo {
                name: "items_copy".into(),
                r#type: "collection".into(),
            });
            s.count_result = 7;
        });
        let (state, id) = copying(&env).await;

        let result = preflight_copy_impl(
            &state,
            &id,
            "orders",
            vec!["items".into()],
            vec![CopyTargetRef {
                connection_id: id.clone(),
                db: "orders".into(),
                collection: "items_copy".into(),
            }],
        )
        .await
        .unwrap();

        let conflict = &result.conflicts[0];
        assert!(conflict.target_exists);
        assert_eq!(conflict.target_doc_count, 7);
    }

    // A database copy recreates views from their definition.
    #[tokio::test]
    async fn a_database_copy_recreates_views() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.collections = vec![
                CollectionInfo {
                    name: "items".into(),
                    r#type: "collection".into(),
                },
                CollectionInfo {
                    name: "recent".into(),
                    r#type: "view".into(),
                },
            ];
            s.collection_options.options_bson = mongodb::bson::to_vec(&doc! {
                "viewOn": "items", "pipeline": [{ "$limit": 5 }],
            })
            .unwrap()
            .into();
        });
        let (state, id) = copying(&env).await;

        let task = start_database_copy_impl(
            &state,
            &id,
            "orders",
            &id,
            "backup",
            None,
            false,
            true,
            "merge".to_string(),
        )
        .await
        .unwrap();
        let done = finished(&state, &task).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let view = writes(&env)
            .into_iter()
            .find_map(|w| match w {
                FakeWrite::CreateView(r) => Some(r),
                _ => None,
            })
            .expect("the view was not recreated");
        assert_eq!(
            (
                view.database.as_str(),
                view.view.as_str(),
                view.view_on.as_str()
            ),
            ("backup", "recent", "items")
        );
        assert!(
            view.pipeline_json.contains("$limit"),
            "{}",
            view.pipeline_json
        );
    }

    // A copy of large documents goes to the server in requests of bounded
    // size, not one request per 500 documents however large they are.
    #[tokio::test]
    async fn large_documents_are_sent_in_bounded_requests() {
        let env = Env::new().await;
        let big = "x".repeat(1_500_000);
        env.fake.with(|s| {
            s.documents = (0..6)
                .map(|i| doc! { "_id": i, "pad": big.clone() })
                .collect();
        });
        let (state, id) = copying(&env).await;

        let done = finished(&state, &copy(&state, &id, "merge", false).await.unwrap()).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let sizes: Vec<usize> = writes(&env)
            .into_iter()
            .filter_map(|w| match w {
                FakeWrite::InsertMany(r) => Some(r.documents_bson.iter().map(|d| d.len()).sum()),
                _ => None,
            })
            .collect();
        assert!(sizes.len() > 1, "{sizes:?}");
        assert!(sizes.iter().all(|n| *n <= 4 << 20), "{sizes:?}");
        assert_eq!(inserted(&env).len(), 6);
    }

    // A database copy's progress total is estimated, as local mode estimates
    // it, not counted collection by collection before anything is copied.
    #[tokio::test]
    async fn a_database_copy_estimates_its_total() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.collections = vec![CollectionInfo {
                name: "items".into(),
                r#type: "collection".into(),
            }];
        });
        let (state, id) = copying(&env).await;

        let task = start_database_copy_impl(
            &state,
            &id,
            "orders",
            &id,
            "backup",
            None,
            false,
            false,
            "merge".to_string(),
        )
        .await
        .unwrap();
        finished(&state, &task).await;

        let count = env
            .fake
            .with(|s| s.last_count.clone())
            .expect("no count was asked for");
        assert!(count.estimate_if_unfiltered);
    }

    // What a server source holds is copied byte for byte, even BSON a
    // Document cannot hold, such as a key that repeats.
    #[tokio::test]
    async fn a_server_source_is_copied_byte_for_byte() {
        let env = Env::new().await;
        // { _id: 1, a: 1, a: 2 }
        let mut repeated: Vec<u8> = Vec::new();
        let body: Vec<u8> = [
            &[0x10][..],
            b"_id\0",
            &1i32.to_le_bytes(),
            &[0x10][..],
            b"a\0",
            &1i32.to_le_bytes(),
            &[0x10][..],
            b"a\0",
            &2i32.to_le_bytes(),
        ]
        .concat();
        repeated.extend_from_slice(&((body.len() + 5) as i32).to_le_bytes());
        repeated.extend_from_slice(&body);
        repeated.push(0);
        env.fake.with(|s| s.raw_documents = vec![repeated.clone()]);
        let (state, id) = copying(&env).await;

        let done = finished(&state, &copy(&state, &id, "merge", false).await.unwrap()).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let sent: Vec<Vec<u8>> = writes(&env)
            .into_iter()
            .filter_map(|w| match w {
                FakeWrite::InsertMany(r) => Some(r.documents_bson.into_iter().map(|d| d.to_vec())),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(sent, vec![repeated]);
    }

    // Two desktop connections to the same server connection are one
    // deployment: copying a collection onto itself through them, which
    // overwrite would drop before reading, is refused like any self-copy.
    #[tokio::test]
    async fn a_copy_onto_itself_through_two_connections_is_refused() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.collections = vec![CollectionInfo {
                name: "items".into(),
                r#type: "collection".into(),
            }]
        });
        let (state, first) = copying(&env).await;
        let second =
            crate::server::commands::server_connect_impl(&state, &env.path, &env.account.id, "c1")
                .await
                .unwrap()
                .id;

        let collection = start_collection_copy_impl(
            &state,
            &first,
            "orders",
            "items",
            &second,
            "orders",
            "items",
            None,
            false,
            "overwrite".to_string(),
        )
        .await
        .unwrap_err();
        let database = start_database_copy_impl(
            &state,
            &first,
            "orders",
            &second,
            "orders",
            None,
            false,
            false,
            "overwrite".to_string(),
        )
        .await
        .unwrap_err();

        assert!(collection.contains("same collection"), "{collection}");
        assert!(database.contains("same"), "{database}");
        assert!(!writes(&env)
            .iter()
            .any(|w| matches!(w, FakeWrite::DropCollection(_))));
    }
}
