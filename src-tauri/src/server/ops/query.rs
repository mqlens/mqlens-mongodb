//! Find and aggregate: documents read from a collection, decoded from the
//! raw BSON the server sends exactly as stored.

use crate::limits::MAX_AGGREGATE_RESULTS;
use crate::server::channel::client;
use crate::server::ejson;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::data_service_client::DataServiceClient;
use crate::server::pb::mqlens::v1::{
    AggregateRequest, CountRequest, ExplainRequest, FindBatch, FindRequest,
};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::server::session::next_message;
use crate::AppState;
use mongodb::bson::{Bson, Document};
use tonic::Streaming;

/// A find, as `execute_mql_query` parsed it.
pub(crate) struct Find<'a> {
    pub database: &'a str,
    pub collection: &'a str,
    pub filter: &'a Document,
    pub sort: Option<&'a Document>,
    pub projection: Option<&'a Document>,
    /// Already normalized as local mode normalizes it.
    pub limit: i64,
    pub skip: i64,
}

/// Each found document as local mode returns it.
pub(crate) async fn find(
    state: &AppState,
    conn: &RemoteConn,
    query: Find<'_>,
) -> Result<Vec<String>, String> {
    routes::require("execute_mql_query", conn)?;
    let request = FindRequest {
        connection_id: conn.remote_id.clone(),
        database: query.database.to_string(),
        collection: query.collection.to_string(),
        filter_json: ejson::doc_to_wire(query.filter),
        sort_json: query.sort.map(ejson::doc_to_wire).unwrap_or_default(),
        projection_json: query.projection.map(ejson::doc_to_wire).unwrap_or_default(),
        skip: query.skip.max(0),
        limit: query.limit,
        raw_bson: true,
    };
    let mut stream = session_for(state, conn)
        .await?
        .open_stream(request, |channel, request| async move {
            client!(DataServiceClient, channel).find(request).await
        })
        .await?;
    rows(collect(&mut stream, None).await?)
}

/// Each document the pipeline returns as local mode returns it, capped as
/// local mode caps it. `writes`: the pipeline has a $out or $merge stage,
/// which needs the write role as well.
pub(crate) async fn aggregate(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    stages: &[Document],
    writes: bool,
) -> Result<Vec<String>, String> {
    routes::require("execute_aggregate", conn)?;
    if writes {
        routes::require_class(conn, routes::OpClass::Write)?;
    }
    let documents = run_pipeline(
        state,
        conn,
        database,
        collection,
        stages,
        Some(MAX_AGGREGATE_RESULTS),
    );
    rows(documents.await?)
}

/// The documents `$sample` picks, as schema analysis samples in local mode.
pub(crate) async fn sample(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    size: i64,
) -> Result<Vec<Document>, String> {
    routes::require("analyze_schema", conn)?;
    let stages = [mongodb::bson::doc! { "$sample": { "size": size } }];
    run_pipeline(state, conn, database, collection, &stages, None).await
}

/// How many documents match `filter`, counted as local mode counts: the
/// server estimates from metadata when there is no filter.
pub(crate) async fn count(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    filter: &Document,
) -> Result<u64, String> {
    routes::require("count_documents", conn)?;
    let request = CountRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        filter_json: ejson::doc_to_wire(filter),
        estimate_if_unfiltered: true,
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DataServiceClient, channel).count(request).await
        })
        .await?;
    u64::try_from(response.count).map_err(|_| "MQLens Server reported a negative count".to_string())
}

/// What a query is, for an explain.
pub(crate) enum Explained<'a> {
    Find(&'a Document),
    Aggregate(&'a [Document]),
}

/// The query plan at the verbosity local mode explains at, printed as local
/// mode prints it.
pub(crate) async fn explain(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    query: Explained<'_>,
) -> Result<String, String> {
    let (command, kind, query_json) = match query {
        Explained::Find(filter) => ("explain_mql_query", "find", ejson::doc_to_wire(filter)),
        Explained::Aggregate(stages) => (
            "explain_aggregate_query",
            "aggregate",
            Bson::Array(stages.iter().cloned().map(Bson::Document).collect())
                .into_canonical_extjson()
                .to_string(),
        ),
    };
    routes::require(command, conn)?;
    let request = ExplainRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        kind: kind.to_string(),
        query_json,
        verbosity: "executionStats".to_string(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DataServiceClient, channel).explain(request).await
        })
        .await?;
    let plan = ejson::doc_from_wire(&response.plan_json)?;
    let json = serde_json::to_value(&plan).map_err(|e| format!("BSON to JSON error: {e}"))?;
    serde_json::to_string_pretty(&json).map_err(|e| format!("BSON to JSON error: {e}"))
}

async fn run_pipeline(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    stages: &[Document],
    cap: Option<usize>,
) -> Result<Vec<Document>, String> {
    let pipeline = Bson::Array(stages.iter().cloned().map(Bson::Document).collect());
    let request = AggregateRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        pipeline_json: pipeline.into_canonical_extjson().to_string(),
        raw_bson: true,
    };
    let mut stream = session_for(state, conn)
        .await?
        .open_stream(request, |channel, request| async move {
            client!(DataServiceClient, channel).aggregate(request).await
        })
        .await?;
    collect(&mut stream, cap).await
}

/// Each document as local mode writes one result row.
fn rows(documents: Vec<Document>) -> Result<Vec<String>, String> {
    documents.iter().map(ejson::ui_string).collect()
}

/// Reads every batch, decoding each document from its raw BSON. Past `cap`
/// documents it fails as local mode does, and dropping the stream ends the
/// server's cursor rather than reading it to the end.
async fn collect(
    stream: &mut Streaming<FindBatch>,
    cap: Option<usize>,
) -> Result<Vec<Document>, String> {
    let mut results = Vec::new();
    while let Some(batch) = next_message(stream).await? {
        for bytes in batch.documents_bson {
            if cap.is_some_and(|cap| results.len() >= cap) {
                return Err(format!(
                    "Aggregation result capped at {} documents — add a $limit stage for larger pipelines",
                    MAX_AGGREGATE_RESULTS
                ));
            }
            results.push(ejson::doc_from_bson(&bytes)?);
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use crate::db::aggregate::{execute_aggregate_impl, explain_aggregate_query_impl};
    use crate::db::query::{count_documents_impl, execute_mql_query_impl, explain_mql_query_impl};
    use crate::server::ejson;
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use crate::server::session::STREAM_IDLE_TIMEOUT;
    use mongodb::bson::{doc, Bson, Document};

    /// What local mode returns for one document: `serde_json::to_value` of
    /// the driver's document, then `to_string`.
    fn as_local_mode_shows(doc: &Document) -> String {
        serde_json::to_string(&serde_json::to_value(doc).unwrap()).unwrap()
    }

    fn many(n: usize) -> Vec<Document> {
        (0..n)
            .map(|i| doc! { "_id": i as i64, "i": i as i32 })
            .collect()
    }

    // Every document, across batches and in order, reads exactly as local
    // mode shows it, the wrapper-shaped sub-document included.
    #[tokio::test]
    async fn found_documents_read_as_local_mode_shows_them() {
        let env = Env::new().await;
        let mut docs = env.fake.with(|s| s.documents.clone());
        docs.extend(many(250));
        env.fake.with(|s| {
            s.documents = docs.clone();
            s.batch_size = 100;
        });
        let (state, id) = connected(&env).await;

        let found = execute_mql_query_impl(&state, &id, "orders", "customers", "{}", "", "", 0, 0)
            .await
            .unwrap();

        let expected: Vec<String> = docs.iter().map(as_local_mode_shows).collect();
        assert_eq!(found, expected);
        assert!(found[1].contains(r#""$numberLong":"7""#), "{}", found[1]);
    }

    // The query goes out as local mode parses it, so both modes ask for the
    // same documents.
    #[tokio::test]
    async fn the_query_reaches_the_server_as_local_mode_parses_it() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let filter = r#"{"status":"open","n":{"$gt":5}}"#;

        execute_mql_query_impl(
            &state,
            &id,
            "orders",
            "customers",
            filter,
            r#"{"n":-1}"#,
            r#"{"n":1}"#,
            0,
            10,
        )
        .await
        .unwrap();

        let sent = env.fake.with(|s| s.last_find.clone()).unwrap();
        let parsed = |json: &str| {
            let value: serde_json::Value = serde_json::from_str(json).unwrap();
            ejson::doc_to_wire(&mongodb::bson::to_document(&value).unwrap())
        };
        assert_eq!(sent.connection_id, "c1");
        assert_eq!(
            (sent.database.as_str(), sent.collection.as_str()),
            ("orders", "customers")
        );
        assert_eq!(sent.filter_json, parsed(filter));
        assert_eq!(sent.sort_json, parsed(r#"{"n":-1}"#));
        assert_eq!(sent.projection_json, parsed(r#"{"n":1}"#));
        assert_eq!(sent.limit, crate::limits::normalize_query_limit(0));
        assert_eq!(sent.skip, 10);
        assert!(sent.raw_bson);
    }

    #[tokio::test]
    async fn an_invalid_filter_fails_as_in_local_mode_without_a_call() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        let err = execute_mql_query_impl(&state, &id, "orders", "customers", "{oops", "", "", 0, 0)
            .await
            .unwrap_err();

        assert!(err.starts_with("Invalid MQL filter JSON:"), "{err}");
        assert_eq!(env.fake.with(|s| s.data_calls), 0);
    }

    // A long query is fine; a server that stops answering is not.
    #[tokio::test]
    async fn a_server_that_stalls_between_batches_is_given_up_on() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.batch_size = 1;
            s.batch_delay = STREAM_IDLE_TIMEOUT + std::time::Duration::from_secs(1);
        });
        let (state, id) = connected(&env).await;

        let started = std::time::Instant::now();
        let err = execute_mql_query_impl(&state, &id, "orders", "customers", "{}", "", "", 0, 0)
            .await
            .unwrap_err();

        assert!(err.contains("did not answer in time"), "{err}");
        assert!(
            started.elapsed() < STREAM_IDLE_TIMEOUT * 2,
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn aggregated_documents_read_as_local_mode_shows_them() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let pipeline = r#"[{"$match":{"a":1}},{"$sort":{"b":-1}}]"#;

        let rows = execute_aggregate_impl(&state, &id, "orders", "customers", pipeline, false)
            .await
            .unwrap();

        let docs = env.fake.with(|s| s.documents.clone());
        assert_eq!(
            rows,
            docs.iter().map(as_local_mode_shows).collect::<Vec<_>>()
        );
        // The stages as local mode parses them: through serde_json, so JSON
        // integers become Int64, exactly what the local driver would send.
        let sent = env.fake.with(|s| s.last_aggregate.clone()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(pipeline).unwrap();
        let stages: Vec<Bson> = parsed
            .as_array()
            .unwrap()
            .iter()
            .map(|stage| Bson::Document(mongodb::bson::to_document(stage).unwrap()))
            .collect();
        assert_eq!(
            sent.pipeline_json,
            Bson::Array(stages).into_canonical_extjson().to_string()
        );
        assert!(sent.raw_bson);
    }

    // The same cap as local mode, and the server stops: the stream is dropped
    // rather than read to the end.
    #[tokio::test]
    async fn aggregation_is_capped_as_in_local_mode_and_stops_the_server() {
        let env = Env::new().await;
        env.fake.with(|s| {
            // Far more past the cap than HTTP/2 buffers hold, so the fake must
            // see the stream dropped rather than finish sending first.
            s.documents = many(crate::limits::MAX_AGGREGATE_RESULTS + 20_000);
            s.batch_size = 100;
        });
        let (state, id) = connected(&env).await;

        let err = execute_aggregate_impl(&state, &id, "orders", "customers", "[]", false)
            .await
            .unwrap_err();

        assert_eq!(
            err,
            format!(
                "Aggregation result capped at {} documents — add a $limit stage for larger pipelines",
                crate::limits::MAX_AGGREGATE_RESULTS
            )
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while env.fake.with(|s| s.streams_abandoned) == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(
            env.fake.with(|s| s.streams_abandoned),
            1,
            "the stream was read to the end"
        );
    }

    // Schema analysis samples through the server, as local mode samples
    // through the driver, and infers from the documents exactly as stored.
    #[tokio::test]
    async fn schema_is_inferred_from_a_sample_taken_through_the_server() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        let report =
            crate::db::schema::analyze_schema_impl(&state, &id, "orders", "customers", 250)
                .await
                .unwrap();

        let docs = env.fake.with(|s| s.documents.clone());
        assert_eq!(
            report,
            serde_json::to_string(&crate::db::schema::infer_schema(&docs)).unwrap()
        );
        let size = crate::limits::normalize_schema_sample(250);
        let sent = env.fake.with(|s| s.last_aggregate.clone()).unwrap();
        assert_eq!(
            sent.pipeline_json,
            Bson::Array(vec![Bson::Document(doc! { "$sample": { "size": size } })])
                .into_canonical_extjson()
                .to_string()
        );
    }

    // A $out or $merge pipeline writes, so it needs the write role, as the
    // local guard treats it; nothing reaches the server without it.
    #[tokio::test]
    async fn a_pipeline_that_writes_needs_the_write_role() {
        let env = Env::new().await;
        env.fake
            .with(|s| s.connections[0].op_classes = vec!["read".to_string()]);
        let (state, id) = connected(&env).await;

        let err = execute_aggregate_impl(
            &state,
            &id,
            "orders",
            "customers",
            r#"[{"$out":"copy"}]"#,
            true,
        )
        .await
        .unwrap_err();

        assert!(err.contains("does not allow write operations"), "{err}");
        assert_eq!(env.fake.with(|s| s.data_calls), 0);
    }

    // A refused access token is refreshed once and the stream opened again.
    #[tokio::test]
    async fn a_stream_refreshes_a_refused_token_once() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        env.fake.revoke_access_tokens();

        let found = execute_mql_query_impl(&state, &id, "orders", "customers", "{}", "", "", 0, 0)
            .await
            .unwrap();

        assert_eq!(found.len(), 3);
        assert_eq!(env.fake.with(|s| s.refreshes), 1);
    }

    // A count asks the server with the filter as local mode parses it, and for
    // an estimate when there is no filter, as local mode estimates then.
    #[tokio::test]
    async fn counts_as_local_mode_counts() {
        let env = Env::new().await;
        env.fake.with(|s| s.count_result = 42);
        let (state, id) = connected(&env).await;

        let n = count_documents_impl(&state, &id, "orders", "customers", r#"{"n": 5}"#)
            .await
            .unwrap();

        assert_eq!(n, 42);
        let request = env.fake.with(|s| s.last_count.clone()).unwrap();
        assert_eq!(
            (request.database.as_str(), request.collection.as_str()),
            ("orders", "customers")
        );
        assert_eq!(
            ejson::doc_from_wire(&request.filter_json).unwrap(),
            doc! { "n": 5_i64 }
        );
        assert!(request.estimate_if_unfiltered);
    }

    fn plan() -> Document {
        doc! {
            "queryPlanner": { "winningPlan": { "stage": "COLLSCAN" } },
            "executionStats": { "nReturned": 3, "executionTimeMillis": 1_i64 },
        }
    }

    /// What local mode prints for an explain: the plan as relaxed JSON, pretty.
    fn as_local_mode_prints(plan: &Document) -> String {
        serde_json::to_string_pretty(&serde_json::to_value(plan).unwrap()).unwrap()
    }

    // A find explain runs at the verbosity local mode uses, and its plan reads
    // as local mode prints it, in the server's field order.
    #[tokio::test]
    async fn a_find_explain_reads_as_local_mode_prints_it() {
        let env = Env::new().await;
        env.fake.with(|s| s.explain_plan = plan());
        let (state, id) = connected(&env).await;

        let printed = explain_mql_query_impl(&state, &id, "orders", "customers", r#"{"n": 5}"#)
            .await
            .unwrap();

        assert_eq!(printed, as_local_mode_prints(&plan()));
        let request = env.fake.with(|s| s.last_explain.clone()).unwrap();
        assert_eq!(request.kind, "find");
        assert_eq!(request.verbosity, "executionStats");
        assert_eq!(
            ejson::doc_from_wire(&request.query_json).unwrap(),
            doc! { "n": 5_i64 }
        );
    }

    // An aggregate explain sends the whole pipeline.
    #[tokio::test]
    async fn an_aggregate_explain_sends_the_pipeline() {
        let env = Env::new().await;
        env.fake.with(|s| s.explain_plan = plan());
        let (state, id) = connected(&env).await;

        let printed = explain_aggregate_query_impl(
            &state,
            &id,
            "orders",
            "customers",
            r#"[{"$match": {"n": 5}}, {"$count": "n"}]"#,
        )
        .await
        .unwrap();

        assert_eq!(printed, as_local_mode_prints(&plan()));
        let request = env.fake.with(|s| s.last_explain.clone()).unwrap();
        assert_eq!(request.kind, "aggregate");
        assert_eq!(request.verbosity, "executionStats");
        let sent: serde_json::Value = serde_json::from_str(&request.query_json).unwrap();
        assert_eq!(
            Bson::try_from(sent).unwrap(),
            Bson::Array(vec![
                Bson::Document(doc! { "$match": { "n": 5_i64 } }),
                Bson::Document(doc! { "$count": "n" }),
            ])
        );
    }
}
