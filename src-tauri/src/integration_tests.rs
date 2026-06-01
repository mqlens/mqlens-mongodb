//! Integration tests that exercise the real-MongoDB code paths (find/count/explain,
//! aggregate, DDL, document CRUD + import, export, GridFS, schema, version, the live
//! connection test). These are the seams that the mock connection can't reach.
//!
//! They run ONLY when `MQLENS_TEST_MONGO_URI` points at a reachable MongoDB; otherwise
//! every test no-ops (returns early) so `cargo test` stays green without a server. CI
//! sets the variable against a service container. Each test uses a uniquely-named
//! database and drops it on the way out, so runs are isolated and self-cleaning.

#[cfg(test)]
mod integration {
    use crate::{
        analyze_schema_impl, connect_db_impl, count_documents_impl, create_collection_impl,
        create_index_impl, create_view_impl, delete_document_impl, delete_index_impl,
        delete_many_impl, disconnect_db_impl, download_gridfs_file_impl, drop_collection_impl,
        drop_database_impl, execute_aggregate_impl, execute_mql_query_impl,
        explain_aggregate_query_impl, explain_mql_query_impl, get_mongodb_version_impl,
        import_documents_impl, insert_document_impl, list_collections_impl, list_databases_impl,
        list_gridfs_files_impl, list_indexes_impl, rename_collection_impl, rename_database_impl,
        start_collection_export_impl, update_document_impl, update_many_impl, AppState,
    };
    use mongodb::bson::{doc, Document};

    fn test_mongo_uri() -> Option<String> {
        std::env::var("MQLENS_TEST_MONGO_URI")
            .ok()
            .filter(|s| !s.trim().is_empty())
    }

    /// Connect to the test MongoDB and hand back a unique database name, or None to skip.
    async fn connect() -> Option<(AppState, String, String)> {
        let uri = test_mongo_uri()?;
        let state = AppState::new();
        let id = connect_db_impl(&state, &uri, None)
            .await
            .expect("should connect to MQLENS_TEST_MONGO_URI");
        let db = format!("mqlens_it_{}", uuid::Uuid::new_v4().simple());
        Some((state, id, db))
    }

    fn client_of(state: &AppState, id: &str) -> mongodb::Client {
        state.connections.lock().unwrap().get(id).cloned().unwrap()
    }

    async fn seed(state: &AppState, id: &str, db: &str, coll: &str, docs: Vec<Document>) {
        client_of(state, id)
            .database(db)
            .collection::<Document>(coll)
            .insert_many(docs)
            .await
            .expect("seed insert_many");
    }

    async fn cleanup(state: &AppState, id: &str, db: &str) {
        let _ = client_of(state, id).database(db).drop().await;
        let _ = disconnect_db_impl(state, id).await;
    }

    async fn wait_for_task(state: &AppState, task_id: &str) -> crate::TaskInfo {
        for _ in 0..200 {
            let info = state.tasks.lock().unwrap().get(task_id).cloned();
            if let Some(info) = info {
                if info.status != "running" {
                    return info;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        state
            .tasks
            .lock()
            .unwrap()
            .get(task_id)
            .cloned()
            .expect("task should exist")
    }

    #[tokio::test]
    async fn it_connect_ping_and_version() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        // The real version path runs buildInfo against admin.
        let version = get_mongodb_version_impl(&state, &id)
            .await
            .expect("real version");
        assert!(
            version.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false),
            "version should look like a number, got {version}"
        );
        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_query_find_count_explain() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        seed(
            &state,
            &id,
            &db,
            "products",
            vec![
                doc! { "name": "A", "category": "Electronics", "price": 100, "stock": 5 },
                doc! { "name": "B", "category": "Electronics", "price": 200, "stock": 1 },
                doc! { "name": "C", "category": "Books", "price": 20, "stock": 9 },
            ],
        )
        .await;

        // Find with filter + sort + projection + limit + skip (all real builder branches).
        let results = execute_mql_query_impl(
            &state,
            &id,
            &db,
            "products",
            r#"{"category":"Electronics"}"#,
            r#"{"price":-1}"#,
            r#"{"name":1,"_id":0}"#,
            1,
            0,
        )
        .await
        .expect("real find");
        assert_eq!(results.len(), 1);
        let first: serde_json::Value = serde_json::from_str(&results[0]).unwrap();
        assert_eq!(first["name"], "B", "highest price first");

        // Skip path.
        let skipped = execute_mql_query_impl(
            &state, &id, &db, "products", r#"{"category":"Electronics"}"#, r#"{"price":1}"#, "{}",
            10, 1,
        )
        .await
        .expect("real find with skip");
        assert_eq!(skipped.len(), 1);

        // Count: empty filter (estimated_document_count) and a real filter (count_documents).
        let total = count_documents_impl(&state, &id, &db, "products", "{}")
            .await
            .expect("estimated count");
        assert_eq!(total, 3);
        let electronics = count_documents_impl(
            &state,
            &id,
            &db,
            "products",
            r#"{"category":"Electronics"}"#,
        )
        .await
        .expect("filtered count");
        assert_eq!(electronics, 2);

        // Explain runs the real explain command.
        let explain = explain_mql_query_impl(
            &state,
            &id,
            &db,
            "products",
            r#"{"category":"Electronics"}"#,
        )
        .await
        .expect("real explain");
        assert!(
            explain.contains("queryPlanner") || explain.contains("winningPlan"),
            "explain output should include a query plan"
        );

        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_aggregate_execute_and_explain() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        seed(
            &state,
            &id,
            &db,
            "sales",
            vec![
                doc! { "region": "us", "amount": 10 },
                doc! { "region": "us", "amount": 30 },
                doc! { "region": "eu", "amount": 5 },
            ],
        )
        .await;

        let pipeline =
            r#"[{"$group":{"_id":"$region","total":{"$sum":"$amount"}}},{"$sort":{"_id":1}}]"#;
        let rows = execute_aggregate_impl(&state, &id, &db, "sales", pipeline)
            .await
            .expect("real aggregate");
        assert_eq!(rows.len(), 2);
        let eu: serde_json::Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(eu["_id"], "eu");
        assert_eq!(eu["total"], 5);

        let explain = explain_aggregate_query_impl(&state, &id, &db, "sales", pipeline)
            .await
            .expect("real aggregate explain");
        assert!(
            explain.contains("stages") || explain.contains("queryPlanner") || explain.contains("ok"),
            "aggregate explain should return a plan document"
        );

        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_metadata_collections_views_and_indexes() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        // create_collection real path.
        create_collection_impl(&state, &id, &db, "customers")
            .await
            .expect("create collection");
        seed(
            &state,
            &id,
            &db,
            "customers",
            vec![doc! { "name": "Ada", "city": "NYC" }],
        )
        .await;

        // create_view real path (view over customers).
        create_view_impl(
            &state,
            &id,
            &db,
            "ny_customers",
            "customers",
            r#"[{"$match":{"city":"NYC"}}]"#,
        )
        .await
        .expect("create view");

        let collections = list_collections_impl(&state, &id, &db)
            .await
            .expect("list collections");
        let view = collections
            .iter()
            .find(|c| c.name == "ny_customers")
            .expect("view should be listed");
        assert_eq!(view.collection_type, "view");
        let coll = collections
            .iter()
            .find(|c| c.name == "customers")
            .expect("collection listed");
        assert_eq!(coll.collection_type, "collection");

        // list_databases should include our test db.
        let dbs = list_databases_impl(&state, &id).await.expect("list dbs");
        assert!(dbs.contains(&db));

        // Index create / list (with real key-pattern + flags) / delete.
        create_index_impl(
            &state,
            &id,
            &db,
            "customers",
            "city_unique",
            r#"{"city":1}"#,
            true,
            true,
        )
        .await
        .expect("create index");
        let indexes = list_indexes_impl(&state, &id, &db, "customers")
            .await
            .expect("list indexes");
        let created = indexes
            .iter()
            .find(|i| i.name == "city_unique")
            .expect("created index listed");
        assert!(created.unique, "unique flag round-trips from the server");
        assert!(created.sparse, "sparse flag round-trips from the server");
        let keys: serde_json::Value = serde_json::from_str(&created.keys).unwrap();
        assert_eq!(keys["city"], 1);

        delete_index_impl(&state, &id, &db, "customers", "city_unique")
            .await
            .expect("delete index");
        let after = list_indexes_impl(&state, &id, &db, "customers")
            .await
            .expect("list indexes after delete");
        assert!(!after.iter().any(|i| i.name == "city_unique"));

        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_document_crud_real() {
        let Some((state, id, db)) = connect().await else {
            return;
        };

        // insert_document_impl returns the inserted id as extended JSON.
        let inserted = insert_document_impl(
            &state,
            &id,
            &db,
            "people",
            r#"{"_id":"u1","name":"Ada","tier":"gold"}"#,
        )
        .await
        .expect("insert");
        assert!(inserted.contains("u1"));

        // replace_one via update_document_impl.
        let modified = update_document_impl(
            &state,
            &id,
            &db,
            "people",
            r#"{"_id":"u1"}"#,
            r#"{"_id":"u1","name":"Ada Lovelace","tier":"platinum"}"#,
        )
        .await
        .expect("replace");
        assert_eq!(modified, 1);

        // update_many with an operator.
        seed(
            &state,
            &id,
            &db,
            "people",
            vec![
                doc! { "_id": "u2", "name": "Bob", "tier": "silver" },
                doc! { "_id": "u3", "name": "Cy", "tier": "silver" },
            ],
        )
        .await;
        let upd = update_many_impl(
            &state,
            &id,
            &db,
            "people",
            r#"{"tier":"silver"}"#,
            r#"{"$set":{"tier":"bronze"}}"#,
        )
        .await
        .expect("update_many");
        assert_eq!(upd, 2);

        // delete_one then delete_many.
        let del_one = delete_document_impl(&state, &id, &db, "people", r#"{"_id":"u1"}"#)
            .await
            .expect("delete_one");
        assert_eq!(del_one, 1);
        let del_many = delete_many_impl(&state, &id, &db, "people", r#"{"tier":"bronze"}"#)
            .await
            .expect("delete_many");
        assert_eq!(del_many, 2);

        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_import_documents_all_modes_real() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        // Pre-existing doc with _id=1 so skip/update/abort all have a conflict to handle.
        seed(&state, &id, &db, "imp", vec![doc! { "_id": 1, "name": "old" }]).await;

        let docs = || {
            vec![
                serde_json::json!({"_id": 1, "name": "new"}),
                serde_json::json!({"_id": 2, "name": "two"}),
                serde_json::json!({"name": "no-id"}),
            ]
        };

        // skip: _id=1 exists → skipped; _id=2 and the id-less doc insert.
        let skip = import_documents_impl(&state, &id, &db, "imp", docs(), "skip")
            .await
            .expect("import skip");
        assert_eq!(skip.inserted, 2);
        assert_eq!(skip.skipped, 1);

        // update: _id=1 (and now _id=2) are replaced; id-less inserts.
        let update = import_documents_impl(&state, &id, &db, "imp", docs(), "update")
            .await
            .expect("import update");
        assert!(update.updated >= 1, "existing _id should be updated");

        // abort: a conflicting _id makes the whole import fail and write nothing.
        let abort = import_documents_impl(&state, &id, &db, "imp", docs(), "abort").await;
        assert!(
            abort
                .err()
                .expect("abort should error on conflict")
                .contains("already exist"),
            "abort should refuse when an _id already exists"
        );

        // abort on a fresh collection succeeds and inserts all.
        let clean = import_documents_impl(
            &state,
            &id,
            &db,
            "imp_fresh",
            vec![serde_json::json!({"name": "x"}), serde_json::json!({"name": "y"})],
            "abort",
        )
        .await
        .expect("import abort clean");
        assert_eq!(clean.inserted, 2);

        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_rename_collection_and_database_real() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        seed(
            &state,
            &id,
            &db,
            "old_name",
            vec![doc! { "a": 1 }, doc! { "a": 2 }],
        )
        .await;
        create_index_impl(&state, &id, &db, "old_name", "a_1", r#"{"a":1}"#, false, false)
            .await
            .expect("index for rename");

        // rename_collection real path (admin renameCollection).
        rename_collection_impl(&state, &id, &db, "old_name", "new_name")
            .await
            .expect("rename collection");
        let cols = list_collections_impl(&state, &id, &db).await.unwrap();
        assert!(cols.iter().any(|c| c.name == "new_name"));
        assert!(!cols.iter().any(|c| c.name == "old_name"));

        // rename_database: copy all collections + indexes + docs to a new db, drop source.
        let target = format!("{}_renamed", db);
        let result = rename_database_impl(&state, &id, &db, &target, true)
            .await
            .expect("rename database");
        assert_eq!(result.collections, 1);
        assert_eq!(result.documents, 2);

        // Target has the data + recreated index; source is gone.
        let target_count = count_documents_impl(&state, &id, &target, "new_name", "{}")
            .await
            .expect("count in renamed db");
        assert_eq!(target_count, 2);
        let target_indexes = list_indexes_impl(&state, &id, &target, "new_name")
            .await
            .expect("indexes in renamed db");
        assert!(
            target_indexes.iter().any(|i| i.name == "a_1"),
            "non-_id index should be recreated on the target"
        );
        let dbs = list_databases_impl(&state, &id).await.unwrap();
        assert!(!dbs.contains(&db), "source db should be dropped");

        // Error: target already exists.
        let dup_target = format!("{}_dup", db);
        seed(&state, &id, &dup_target, "c", vec![doc! { "z": 1 }]).await;
        let exists_err = rename_database_impl(&state, &id, &target, &dup_target, false)
            .await
            .err()
            .expect("rename to existing target should error");
        assert!(exists_err.contains("already exists"));

        // Error: source does not exist.
        let missing_err =
            rename_database_impl(&state, &id, "definitely_missing_db_xyz", "whatever", false)
                .await
                .err()
                .expect("rename of missing source should error");
        assert!(missing_err.contains("does not exist"));

        // Cleanup the extra databases this test created.
        let _ = client_of(&state, &id).database(&target).drop().await;
        let _ = client_of(&state, &id).database(&dup_target).drop().await;
        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_rename_database_rejects_views() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        seed(&state, &id, &db, "base", vec![doc! { "a": 1 }]).await;
        create_view_impl(&state, &id, &db, "v", "base", "[]")
            .await
            .expect("create view");
        let target = format!("{}_vrenamed", db);
        let err = rename_database_impl(&state, &id, &db, &target, false)
            .await
            .err()
            .expect("rename of db with a view should error");
        assert!(err.contains("is a view"), "rename must refuse databases with views");
        let _ = client_of(&state, &id).database(&target).drop().await;
        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_drop_collection_and_database_real() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        seed(&state, &id, &db, "tmp", vec![doc! { "a": 1 }]).await;
        drop_collection_impl(&state, &id, &db, "tmp")
            .await
            .expect("drop collection");
        let cols = list_collections_impl(&state, &id, &db).await.unwrap();
        assert!(!cols.iter().any(|c| c.name == "tmp"));

        // drop_database real path.
        seed(&state, &id, &db, "again", vec![doc! { "a": 1 }]).await;
        drop_database_impl(&state, &id, &db)
            .await
            .expect("drop database");
        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_export_json_and_csv_real() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        seed(
            &state,
            &id,
            &db,
            "export_me",
            vec![
                doc! { "name": "Alice", "city": "NYC", "note": "has,comma" },
                doc! { "name": "Bob", "city": "LA" },
            ],
        )
        .await;

        for format in ["json", "csv"] {
            let path = std::env::temp_dir().join(format!(
                "mqlens-it-export-{}.{}",
                uuid::Uuid::new_v4().simple(),
                format
            ));
            let path_str = path.to_string_lossy().to_string();
            let task = start_collection_export_impl(&state, &id, &db, "export_me", format, &path_str)
                .await
                .expect("start real export");
            let finished = wait_for_task(&state, &task.id).await;
            assert_eq!(finished.status, "completed", "export ({format}) should finish");
            assert_eq!(finished.processed, 2);
            let body = std::fs::read_to_string(&path).expect("export file written");
            assert!(body.contains("Alice"));
            if format == "csv" {
                // The comma-containing cell must be quote-escaped.
                assert!(body.contains("\"has,comma\""));
            }
            let _ = std::fs::remove_file(&path);
        }

        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_gridfs_list_and_download_real() {
        use futures::AsyncWriteExt;
        let Some((state, id, db)) = connect().await else {
            return;
        };

        // Upload a file into the "uploads" GridFS bucket via the driver.
        let bucket = client_of(&state, &id).database(&db).gridfs_bucket(
            mongodb::options::GridFsBucketOptions::builder()
                .bucket_name("uploads".to_string())
                .build(),
        );
        let payload = b"hello gridfs integration".to_vec();
        let mut upload = bucket.open_upload_stream("greeting.txt").await.unwrap();
        upload.write_all(&payload).await.unwrap();
        upload.close().await.unwrap();

        // list_gridfs_files_impl returns JSON of files; find ours.
        let listed = list_gridfs_files_impl(&state, &id, &db, "uploads")
            .await
            .expect("list gridfs");
        let files: serde_json::Value = serde_json::from_str(&listed).unwrap();
        let arr = files.as_array().expect("files array");
        let entry = arr
            .iter()
            .find(|f| f["filename"] == "greeting.txt")
            .expect("uploaded file listed");
        assert_eq!(entry["length"].as_u64().unwrap(), payload.len() as u64);
        // `id` is already the file _id rendered as extended JSON (e.g. {"$oid":"..."}),
        // which is exactly what download_gridfs_file_impl expects — pass it through as-is.
        let file_id_json = entry["id"].as_str().expect("gridfs id is a json string").to_string();

        // Download it back to disk and verify the bytes.
        let dest = std::env::temp_dir().join(format!("mqlens-it-gridfs-{}.bin", uuid::Uuid::new_v4().simple()));
        let dest_str = dest.to_string_lossy().to_string();
        let written = download_gridfs_file_impl(
            &state,
            &id,
            &db,
            "uploads",
            &file_id_json,
            &dest_str,
        )
        .await
        .unwrap_or_else(|e| panic!("download gridfs (id={file_id_json}): {e}"));
        assert_eq!(written, payload.len() as u64);
        let got = std::fs::read(&dest).expect("downloaded file");
        assert_eq!(got, payload);
        let _ = std::fs::remove_file(&dest);

        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_analyze_schema_real() {
        let Some((state, id, db)) = connect().await else {
            return;
        };
        seed(
            &state,
            &id,
            &db,
            "events",
            vec![
                doc! { "type": "click", "meta": { "x": 1 }, "tags": ["a", "b"] },
                doc! { "type": "view", "count": 3_i64 },
                doc! { "type": "click" },
            ],
        )
        .await;

        let json = analyze_schema_impl(&state, &id, &db, "events", 1000)
            .await
            .expect("real schema analyze");
        let report: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(report["sampled"].as_u64().unwrap() >= 1);
        let fields = report["fields"].as_array().unwrap();
        assert!(
            fields.iter().any(|f| f["path"] == "type"),
            "expected a 'type' field in the inferred schema"
        );
        assert!(
            fields.iter().any(|f| f["path"] == "meta.x"),
            "nested fields should be reported with dotted paths"
        );

        cleanup(&state, &id, &db).await;
    }

    #[tokio::test]
    async fn it_run_connection_test_real_success() {
        use crate::connections::{run_connection_test, PhaseUpdate, TestPhase};
        use std::sync::Mutex;
        let Some(uri) = test_mongo_uri() else {
            return;
        };
        let log: Mutex<Vec<PhaseUpdate>> = Mutex::new(Vec::new());
        let res = run_connection_test(&uri, None, &|u| log.lock().unwrap().push(u)).await;
        assert!(res.is_ok(), "connection test against the real server should pass");
        let ok_phases: Vec<TestPhase> = log
            .lock()
            .unwrap()
            .iter()
            .filter(|u| u.status == "ok")
            .map(|u| u.phase.clone())
            .collect();
        // All four phases (parse, resolve, connect, ping) must report ok.
        assert!(ok_phases.contains(&TestPhase::Parse));
        assert!(ok_phases.contains(&TestPhase::Resolve));
        assert!(ok_phases.contains(&TestPhase::Connect));
        assert!(ok_phases.contains(&TestPhase::Ping));
    }
}
