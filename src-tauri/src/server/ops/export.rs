//! Export on a server connection: the documents an export reads, and how
//! many, for the same writers local mode uses.

use crate::server::channel::client;
use crate::server::ejson;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::data_service_client::DataServiceClient;
use crate::server::pb::mqlens::v1::{AggregateRequest, CountRequest, FindBatch, FindRequest};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::server::session::{next_message, Speaking};
use crate::AppState;
use mongodb::bson::{Bson, Document};
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use tonic::Streaming;

/// The documents a read yields, one at a time, decoded from raw BSON as stored.
pub(crate) type Documents = Pin<Box<dyn futures::Stream<Item = Result<Document, String>> + Send>>;

/// One collection on a server connection, held with its session so an export
/// running as a background task needs nothing else.
#[derive(Clone)]
pub(crate) struct ExportFrom {
    session: Speaking,
    conn: Arc<RemoteConn>,
    database: String,
    collection: String,
}

impl ExportFrom {
    /// For `command`, refused here if the connection cannot run it.
    pub(crate) async fn new(
        state: &AppState,
        conn: Arc<RemoteConn>,
        command: &str,
        database: &str,
        collection: &str,
    ) -> Result<Self, String> {
        routes::require(command, &conn)?;
        let session = session_for(state, &conn).await?;
        Ok(Self {
            session,
            conn,
            database: database.to_string(),
            collection: collection.to_string(),
        })
    }

    /// How many documents match `filter`, counted exactly, as local mode
    /// counts for an export's progress.
    pub(crate) async fn count(&self, filter: &Document) -> Result<u64, String> {
        let request = CountRequest {
            connection_id: self.conn.remote_id.clone(),
            database: self.database.clone(),
            collection: self.collection.clone(),
            filter_json: ejson::doc_to_wire(filter),
            estimate_if_unfiltered: false,
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

    pub(crate) async fn find(
        &self,
        filter: &Document,
        sort: Option<&Document>,
        projection: Option<&Document>,
        skip: Option<u64>,
        limit: Option<i64>,
    ) -> Result<Documents, String> {
        let request = FindRequest {
            connection_id: self.conn.remote_id.clone(),
            database: self.database.clone(),
            collection: self.collection.clone(),
            filter_json: ejson::doc_to_wire(filter),
            sort_json: sort.map(ejson::doc_to_wire).unwrap_or_default(),
            projection_json: projection.map(ejson::doc_to_wire).unwrap_or_default(),
            skip: skip.map_or(0, |n| i64::try_from(n).unwrap_or(i64::MAX)),
            limit: limit.unwrap_or(0),
            raw_bson: true,
        };
        let stream = self
            .session
            .open_stream(request, |channel, request| async move {
                client!(DataServiceClient, channel).find(request).await
            })
            .await?;
        Ok(documents(stream))
    }

    pub(crate) async fn aggregate(&self, stages: &[Document]) -> Result<Documents, String> {
        let request = AggregateRequest {
            connection_id: self.conn.remote_id.clone(),
            database: self.database.clone(),
            collection: self.collection.clone(),
            pipeline_json: Bson::Array(stages.iter().cloned().map(Bson::Document).collect())
                .into_canonical_extjson()
                .to_string(),
            raw_bson: true,
        };
        let stream = self
            .session
            .open_stream(request, |channel, request| async move {
                client!(DataServiceClient, channel).aggregate(request).await
            })
            .await?;
        Ok(documents(stream))
    }
}

/// Each document of each batch, in order, as the writers read a cursor.
fn documents(stream: Streaming<FindBatch>) -> Documents {
    Box::pin(futures::stream::unfold(
        (stream, VecDeque::<prost::bytes::Bytes>::new()),
        |(mut stream, mut pending)| async move {
            loop {
                if let Some(bytes) = pending.pop_front() {
                    let doc = ejson::doc_from_bson(&bytes);
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

#[cfg(test)]
mod tests {
    use crate::db::export::options::ExportOptions;
    use crate::db::export::{
        format_docs_to_string, preview_export_impl, sample_export_fields_impl,
        start_collection_export_impl, start_filtered_export_impl,
    };
    use crate::server::ejson;
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use crate::AppState;
    use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

    fn docs() -> Vec<Document> {
        vec![
            doc! { "_id": ObjectId::parse_str("64b7f0c2a1b2c3d4e5f60701").unwrap(), "name": "Ada", "n": 1, "at": DateTime::from_millis(1_749_427_200_000) },
            doc! { "_id": ObjectId::parse_str("64b7f0c2a1b2c3d4e5f60702").unwrap(), "name": "Bo, \"the\" second", "tags": ["a", "b"], "nested": { "x": 1.5 } },
            // A stored sub-document shaped like a type wrapper stays a sub-document.
            doc! { "_id": 3_i64, "money": { "$numberLong": "7" } },
        ]
    }

    async fn finished(state: &AppState, task_id: &str) -> crate::TaskInfo {
        for _ in 0..200 {
            let task = state.tasks.lock().unwrap().get(task_id).cloned().unwrap();
            if task.status != "running" {
                return task;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("export did not finish");
    }

    // A whole-collection export writes, in every text format and in BSON,
    // exactly the bytes local mode writes for the same documents.
    #[tokio::test]
    async fn a_collection_exports_exactly_as_local_mode_writes_it() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.documents = docs();
            s.count_result = 3;
            s.batch_size = 2;
        });
        let (state, id) = connected(&env).await;
        let dir = tempfile::tempdir().unwrap();
        let options = ExportOptions::default();

        for format in ["json", "ndjson", "csv", "bson"] {
            let path = dir.path().join(format!("out.{format}"));
            let task = start_collection_export_impl(
                &state,
                &id,
                "orders",
                "customers",
                format,
                path.to_str().unwrap(),
                None,
            )
            .await
            .unwrap();
            let task = finished(&state, &task.id).await;
            assert_eq!(task.status, "completed", "{format}: {:?}", task.error);
            assert_eq!(task.processed, 3, "{format}");
            let written = std::fs::read(&path).unwrap();
            let expected = match format {
                "bson" => docs()
                    .iter()
                    .flat_map(|d| mongodb::bson::to_vec(d).unwrap())
                    .collect(),
                _ => format_docs_to_string(&docs(), format, &options)
                    .unwrap()
                    .into_bytes(),
            };
            assert_eq!(
                String::from_utf8_lossy(&written),
                String::from_utf8_lossy(&expected),
                "{format}"
            );
            assert_eq!(written, expected, "{format}");
        }
    }

    // A filtered export reads with the filter, sort, projection, skip and
    // limit local mode would query with, and counts exactly for its progress.
    #[tokio::test]
    async fn a_filtered_export_reads_what_local_mode_would() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.documents = docs();
            s.count_result = 3;
        });
        let (state, id) = connected(&env).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.json");

        let task = start_filtered_export_impl(
            &state,
            &id,
            "orders",
            "customers",
            "json",
            path.to_str().unwrap(),
            r#"{"n": {"$gte": 1}}"#,
            r#"{"name": 1}"#,
            r#"{"name": 1}"#,
            "",
            Some(1),
            Some(2),
            None,
        )
        .await
        .unwrap();
        assert_eq!(finished(&state, &task.id).await.status, "completed");

        let find = env.fake.with(|s| s.last_find.clone()).unwrap();
        assert_eq!(
            ejson::doc_from_wire(&find.filter_json).unwrap(),
            doc! { "n": { "$gte": 1_i64 } }
        );
        assert_eq!(
            ejson::doc_from_wire(&find.sort_json).unwrap(),
            doc! { "name": 1_i64 }
        );
        assert_eq!(
            ejson::doc_from_wire(&find.projection_json).unwrap(),
            doc! { "name": 1_i64 }
        );
        assert_eq!((find.skip, find.limit, find.raw_bson), (1, 2, true));
        let count = env.fake.with(|s| s.last_count.clone()).unwrap();
        assert!(!count.estimate_if_unfiltered);
        assert_eq!(
            ejson::doc_from_wire(&count.filter_json).unwrap(),
            doc! { "n": { "$gte": 1_i64 } }
        );
    }

    // An aggregation export runs the user's pipeline as given.
    #[tokio::test]
    async fn an_aggregation_export_runs_the_pipeline() {
        let env = Env::new().await;
        env.fake.with(|s| s.documents = docs());
        let (state, id) = connected(&env).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.ndjson");

        let task = start_filtered_export_impl(
            &state,
            &id,
            "orders",
            "customers",
            "ndjson",
            path.to_str().unwrap(),
            "",
            "",
            "",
            r#"[{"$match": {"n": 1}}]"#,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let task = finished(&state, &task.id).await;

        assert_eq!(task.status, "completed", "{:?}", task.error);
        let options = ExportOptions::default();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format_docs_to_string(&docs(), "ndjson", &options).unwrap()
        );
        let sent: serde_json::Value = serde_json::from_str(
            &env.fake
                .with(|s| s.last_aggregate.clone())
                .unwrap()
                .pipeline_json,
        )
        .unwrap();
        assert_eq!(
            mongodb::bson::Bson::try_from(sent).unwrap(),
            mongodb::bson::Bson::Array(vec![mongodb::bson::Bson::Document(
                doc! { "$match": { "n": 1_i64 } }
            )])
        );
    }

    // The preview shows the first documents as local mode shows them, and the
    // field picker offers the fields local mode infers.
    #[tokio::test]
    async fn the_preview_and_field_picker_read_as_local_mode() {
        let env = Env::new().await;
        let many: Vec<Document> = (0..8).map(|i| doc! { "_id": i as i64, "a": i }).collect();
        env.fake.with(|s| s.documents = many.clone());
        let (state, id) = connected(&env).await;

        let preview = preview_export_impl(
            &state,
            &id,
            "orders",
            "customers",
            "json",
            "{}",
            "{}",
            "{}",
            "",
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            preview,
            format_docs_to_string(&many[..5], "json", &ExportOptions::default()).unwrap()
        );
        assert_eq!(env.fake.with(|s| s.last_find.clone()).unwrap().limit, 5);

        let fields = sample_export_fields_impl(&state, &id, "orders", "customers", "{}", "")
            .await
            .unwrap();
        assert_eq!(fields, ["_id", "a"]);
    }

    // What local mode refuses goes nowhere: a bad format or a pipeline that
    // writes.
    #[tokio::test]
    async fn refused_exports_send_nothing() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        assert!(start_collection_export_impl(
            &state,
            &id,
            "orders",
            "customers",
            "pdf",
            "/tmp/x",
            None
        )
        .await
        .is_err());
        assert!(start_filtered_export_impl(
            &state,
            &id,
            "orders",
            "customers",
            "json",
            "/tmp/x",
            "",
            "",
            "",
            r#"[{"$out": "copy"}]"#,
            None,
            None,
            None,
        )
        .await
        .is_err());
        assert_eq!(env.fake.with(|s| s.data_calls), 0);
    }
}
