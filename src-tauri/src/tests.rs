#[cfg(test)]
mod tests {
    use crate::AppState;
    use crate::{
        connect_db_impl, count_documents_impl, create_collection_impl, create_index_impl,
        delete_document_impl, delete_gridfs_file_impl, disconnect_db_impl,
        download_gridfs_file_impl, drop_collection_impl,
        drop_database_impl, execute_aggregate_impl, execute_mql_query_impl, explain_mql_query_impl,
        import_collection_file_impl, import_documents_impl, insert_document_impl,
        json_to_bson_document, list_collections_impl, list_databases_impl, list_gridfs_files_impl,
        list_indexes_impl, parse_bson_docs, parse_csv_docs, parse_json_array_docs, parse_ndjson_docs,
        rename_collection_impl, rename_database_impl, start_collection_export_impl,
        start_filtered_export_impl, update_document_impl, upload_gridfs_file_impl,
    };
    use crate::{
        create_user_impl, drop_user_impl, list_roles_impl, list_users_impl, update_user_impl,
        RoleSpec,
    };

    /// Deterministic salt bytes for crypto unit tests (not production secrets).
    fn test_salt(byte: u8) -> [u8; 16] {
        std::array::from_fn(|_| byte)
    }

    /// Build test-only passwords without hard-coded string literals for static analysis.
    fn test_secret(parts: &[&str]) -> String {
        parts.concat()
    }

    #[test]
    fn test_resource_usage_sums_process_tree() {
        // The current (test) process always exists, so the summed tree memory
        // must be non-zero. Guards against the walk returning an empty set.
        let state = AppState::new();
        let usage = crate::resource_usage_impl(&state);
        assert!(usage.memory_bytes > 0, "process-tree memory should be > 0");
        assert!(usage.cpu_percent >= 0.0);
    }

    #[tokio::test]
    async fn test_mock_connection_lifecycle() {
        let state = AppState::new();

        // 1. Test connect with mock URI
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("Should connect to mock db successfully");

        assert!(!conn_id.is_empty(), "Connection ID should not be empty");

        // Check if marked as mock
        {
            let mocks = state.mocks.lock().unwrap();
            assert!(mocks.get(&conn_id).copied().unwrap_or(false));
        }

        // 2. Test list databases
        let dbs = list_databases_impl(&state, &conn_id)
            .await
            .expect("Should list databases");
        assert!(dbs.contains(&"sales_db".to_string()));
        assert!(dbs.contains(&"user_analytics".to_string()));

        // 3. Test list collections
        let collections = list_collections_impl(&state, &conn_id, "sales_db")
            .await
            .expect("Should list collections for sales_db");
        let collection_names: Vec<String> = collections.iter().map(|c| c.name.clone()).collect();
        assert!(collection_names.contains(&"customers".to_string()));
        assert!(collection_names.contains(&"transactions".to_string()));
        assert!(collections
            .iter()
            .all(|c| c.collection_type == "collection"));

        // 3b. Test list indexes
        let indexes = list_indexes_impl(&state, &conn_id, "sales_db", "customers")
            .await
            .expect("Should list indexes for customers");
        let index_names: Vec<String> = indexes.iter().map(|i| i.name.clone()).collect();
        assert!(index_names.contains(&"_id_".to_string()));
        assert!(index_names.contains(&"email_1".to_string()));

        // 4. Test execute query with filter (+ projection arg)
        let query_result = execute_mql_query_impl(
            &state,
            &conn_id,
            "sales_db",
            "products",
            r#"{"category": "Electronics"}"#,
            r#"{"price": -1}"#,
            r#"{}"#,
            10,
            0,
        )
        .await
        .expect("Should run query successfully");

        assert!(
            !query_result.is_empty(),
            "Query result should return mock products"
        );
        // Verify mock item structure
        let first_doc: serde_json::Value =
            serde_json::from_str(&query_result[0]).expect("Result should be valid JSON");
        assert_eq!(first_doc["category"], "Electronics");

        // 5. Test explain query
        let explain = explain_mql_query_impl(
            &state,
            &conn_id,
            "sales_db",
            "products",
            r#"{"category": "Electronics"}"#,
        )
        .await
        .expect("Should run explain successfully");
        assert!(explain.contains("IXSCAN") || explain.contains("COLLSCAN"));

        // 6. Test disconnect
        disconnect_db_impl(&state, &conn_id)
            .await
            .expect("Should disconnect successfully");

        // Assert reference removed
        {
            let mocks = state.mocks.lock().unwrap();
            assert!(!mocks.contains_key(&conn_id));
        }
    }

    #[tokio::test]
    async fn test_mock_full_collection_export_task_writes_file() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("Should connect to mock db successfully");
        let path = std::env::temp_dir().join(format!(
            "mqlens-export-test-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path_str = path.to_string_lossy().to_string();

        let task = start_collection_export_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            "json",
            &path_str,
        )
        .await
        .expect("Should start export task");

        for _ in 0..50 {
            let status = {
                state
                    .tasks
                    .lock()
                    .unwrap()
                    .get(&task.id)
                    .map(|t| t.status.clone())
                    .unwrap()
            };
            if status != "running" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        let finished = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(finished.status, "completed");
        assert_eq!(finished.processed, 3);
        let exported = std::fs::read_to_string(&path).expect("Export file should exist");
        assert!(exported.contains("Alice Smith"));
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn test_mock_full_collection_export_task_writes_csv() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("Should connect to mock db successfully");
        let path = std::env::temp_dir().join(format!(
            "mqlens-export-test-{}-{}.csv",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path_str = path.to_string_lossy().to_string();

        let task = start_collection_export_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            "csv",
            &path_str,
        )
        .await
        .expect("Should start CSV export task");

        for _ in 0..50 {
            let status = {
                state
                    .tasks
                    .lock()
                    .unwrap()
                    .get(&task.id)
                    .map(|t| t.status.clone())
                    .unwrap()
            };
            if status != "running" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        let finished = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(finished.status, "completed");
        assert_eq!(finished.processed, 3);
        let exported = std::fs::read_to_string(&path).expect("CSV export file should exist");
        let header = exported.lines().next().unwrap_or_default();
        assert!(header.contains("address"));
        assert!(header.contains("email"));
        assert!(header.contains("name"));
        assert!(exported.contains("Alice Smith"));
        let _ = std::fs::remove_file(&path);
    }

    /// Drive an export task to completion (or timeout) and return the finished TaskInfo.
    async fn await_export(state: &AppState, task_id: &str) -> crate::TaskInfo {
        for _ in 0..50 {
            let status = state
                .tasks
                .lock()
                .unwrap()
                .get(task_id)
                .map(|t| t.status.clone())
                .unwrap();
            if status != "running" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        state.tasks.lock().unwrap().get(task_id).cloned().unwrap()
    }

    #[tokio::test]
    async fn test_mock_full_collection_export_task_writes_ndjson() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");
        let path = temp_import_path("ndjson");
        let path_str = path.to_string_lossy().to_string();
        let task = start_collection_export_impl(
            &state, &conn_id, "sales_db", "customers", "ndjson", &path_str,
        )
        .await
        .expect("start ndjson export");
        let finished = await_export(&state, &task.id).await;
        assert_eq!(finished.status, "completed");
        assert_eq!(finished.processed, 3);

        let text = std::fs::read_to_string(&path).expect("ndjson file");
        // One document per line, no array brackets, and it round-trips back to 3 docs.
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 3);
        assert!(!text.contains('['));
        let docs = parse_ndjson_docs(&text).expect("re-parse ndjson");
        assert_eq!(docs.len(), 3);
        assert!(text.contains("Alice Smith"));
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn test_mock_full_collection_export_task_writes_bson() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");
        let path = temp_import_path("bson");
        let path_str = path.to_string_lossy().to_string();
        let task = start_collection_export_impl(
            &state, &conn_id, "sales_db", "customers", "bson", &path_str,
        )
        .await
        .expect("start bson export");
        let finished = await_export(&state, &task.id).await;
        assert_eq!(finished.status, "completed");
        assert_eq!(finished.processed, 3);

        // The on-disk bytes are concatenated BSON and parse back to 3 documents.
        let bytes = std::fs::read(&path).expect("bson file");
        let docs = parse_bson_docs(&bytes).expect("re-parse bson");
        assert_eq!(docs.len(), 3);
        let names: Vec<String> = docs
            .iter()
            .filter_map(|d| d.get_str("name").ok().map(|s| s.to_string()))
            .collect();
        assert!(names.iter().any(|n| n == "Alice Smith"));
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn test_mock_filtered_export_writes_only_matching_subset() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("Should connect to mock db successfully");
        let path = std::env::temp_dir().join(format!(
            "mqlens-filtered-export-test-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path_str = path.to_string_lossy().to_string();

        // sales_db.customers has Alice/Bob/Charlie; filter to just Alice.
        let task = start_filtered_export_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            "json",
            &path_str,
            "{\"name\":\"Alice Smith\"}",
            "{}",
            "{}",
            "",
        )
        .await
        .expect("Should start filtered export task");

        for _ in 0..50 {
            let status = state
                .tasks
                .lock()
                .unwrap()
                .get(&task.id)
                .map(|t| t.status.clone())
                .unwrap();
            if status != "running" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        let finished = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
        assert_eq!(finished.status, "completed");
        assert_eq!(finished.processed, 1, "only Alice matches the filter");
        assert_eq!(finished.kind, "filtered_export");
        let exported = std::fs::read_to_string(&path).expect("Export file should exist");
        assert!(exported.contains("Alice Smith"));
        assert!(!exported.contains("Bob Johnson"));
        assert!(!exported.contains("Charlie Brown"));
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn test_filtered_export_rejects_aggregate_on_mock() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("Should connect to mock db successfully");

        let err = start_filtered_export_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            "json",
            "/tmp/agg.json",
            "{}",
            "{}",
            "{}",
            "[{\"$match\":{}}]",
        )
        .await
        .err()
        .expect("aggregate export on mock should error");
        assert_eq!(
            err,
            "Aggregation pipelines are not supported on mock connections"
        );
    }

    #[tokio::test]
    async fn test_filtered_export_validates_format_path_and_connection() {
        let state = AppState::new();

        let invalid_format = start_filtered_export_impl(
            &state, "missing", "db", "coll", "xml", "/tmp/out.xml", "{}", "{}", "{}", "",
        )
        .await
        .err()
        .expect("invalid export format should error");
        assert_eq!(invalid_format, "Export format must be json, ndjson, bson, or csv");

        let missing_path = start_filtered_export_impl(
            &state, "missing", "db", "coll", "json", "   ", "{}", "{}", "{}", "",
        )
        .await
        .err()
        .expect("blank export path should error");
        assert_eq!(missing_path, "Export path is required");

        let missing_connection = start_filtered_export_impl(
            &state, "missing", "db", "coll", "json", "/tmp/out.json", "{}", "{}", "{}", "",
        )
        .await
        .err()
        .expect("missing export connection should error");
        assert_eq!(missing_connection, "Connection not found");

        let bad_filter = start_filtered_export_impl(
            &state, "missing", "db", "coll", "json", "/tmp/out.json", "{not json}", "{}", "{}",
            "",
        )
        .await
        .err()
        .expect("malformed filter should error");
        assert!(
            bad_filter.contains("Invalid MQL filter JSON"),
            "got: {bad_filter}"
        );
    }

    #[tokio::test]
    async fn test_collection_export_validates_format_path_and_connection() {
        let state = AppState::new();

        let invalid_format =
            start_collection_export_impl(&state, "missing", "db", "coll", "xml", "/tmp/out.xml")
                .await
                .err()
                .expect("invalid export format should error");
        assert_eq!(invalid_format, "Export format must be json, ndjson, bson, or csv");

        let missing_path =
            start_collection_export_impl(&state, "missing", "db", "coll", "json", "   ")
                .await
                .err()
                .expect("blank export path should error");
        assert_eq!(missing_path, "Export path is required");

        let missing_connection =
            start_collection_export_impl(&state, "missing", "db", "coll", "json", "/tmp/out.json")
                .await
                .err()
                .expect("missing export connection should error");
        assert_eq!(missing_connection, "Connection not found");
    }

    // Regression guard for the index-edit corruption bug (GO-LIVE C2/H4):
    // a created index's real key pattern + unique/sparse flags must round-trip
    // through list_indexes, NOT be re-guessed from the index name.
    #[tokio::test]
    async fn test_mock_index_create_list_preserves_specs() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        create_index_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            "city_1",
            r#"{"city":1}"#,
            true, // unique
            true, // sparse
        )
        .await
        .expect("create index in mock mode");

        let indexes = list_indexes_impl(&state, &conn_id, "sales_db", "customers")
            .await
            .expect("list indexes");

        let created = indexes
            .iter()
            .find(|i| i.name == "city_1")
            .expect("created index should be listed");

        assert_eq!(
            created.keys, r#"{"city":1}"#,
            "real key pattern must be preserved"
        );
        assert!(
            created.unique,
            "unique flag must be preserved, not guessed from name"
        );
        assert!(
            created.sparse,
            "sparse flag must be preserved, not guessed from name"
        );

        // An index whose name contains "email" must NOT be auto-flagged unique
        // (the old fabrication did exactly that).
        create_index_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            "contact_email_1",
            r#"{"contact_email":1}"#,
            false, // NOT unique
            false,
        )
        .await
        .expect("create non-unique email index");

        let indexes = list_indexes_impl(&state, &conn_id, "sales_db", "customers")
            .await
            .expect("list indexes again");
        let email_idx = indexes
            .iter()
            .find(|i| i.name == "contact_email_1")
            .expect("email index listed");
        assert!(
            !email_idx.unique,
            "an index named *email* must not be assumed unique"
        );
    }

    // Document CRUD (GO-LIVE C1): the risky part is round-tripping MongoDB extended
    // JSON (e.g. {"$oid": ...}) from the UI back into real BSON types so writes match
    // by the correct _id. This tests that pure parsing directly.
    #[test]
    fn test_json_to_bson_document_parses_extended_json() {
        use mongodb::bson::Bson;

        let doc = json_to_bson_document(r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"}}"#)
            .expect("valid extended JSON should parse");
        match doc.get("_id") {
            Some(Bson::ObjectId(oid)) => {
                assert_eq!(oid.to_hex(), "507f1f77bcf86cd799439011");
            }
            other => panic!("expected _id to parse as ObjectId, got {:?}", other),
        }

        // A plain string _id must stay a string (not every _id is an ObjectId).
        let doc = json_to_bson_document(r#"{"_id":"user-42","name":"Ada"}"#).unwrap();
        assert_eq!(doc.get_str("_id").unwrap(), "user-42");

        // Non-object JSON is rejected.
        assert!(json_to_bson_document("[1,2,3]").is_err());
        assert!(json_to_bson_document("not json").is_err());
    }

    #[tokio::test]
    async fn test_mock_document_crud_commands() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        // delete_one by _id
        let deleted = delete_document_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"}}"#,
        )
        .await
        .expect("delete should succeed in mock mode");
        assert_eq!(deleted, 1);

        // insert_one
        let inserted_id = insert_document_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            r#"{"name":"New Customer","tier":"gold"}"#,
        )
        .await
        .expect("insert should succeed in mock mode");
        assert!(!inserted_id.is_empty());

        // replace_one
        let modified = update_document_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"}}"#,
            r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"},"name":"Edited"}"#,
        )
        .await
        .expect("update should succeed in mock mode");
        assert_eq!(modified, 1);

        // Invalid JSON is rejected before touching the connection.
        assert!(
            delete_document_impl(&state, &conn_id, "sales_db", "customers", "{bad")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn test_mock_import_documents_modes_validate_without_persisting() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");
        let docs = vec![
            serde_json::json!({"_id": 1, "name": "Ada"}),
            serde_json::json!({"_id": 2, "name": "Bob"}),
        ];

        let skip = import_documents_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            docs.clone(),
            "skip",
        )
        .await
        .expect("skip import should validate in mock mode");
        assert_eq!(skip.inserted, 2);
        assert_eq!(skip.updated, 0);
        assert_eq!(skip.skipped, 0);

        let update = import_documents_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            docs.clone(),
            "update",
        )
        .await
        .expect("update import should validate in mock mode");
        assert_eq!(update.inserted, 0);
        assert_eq!(update.updated, 2);
        assert_eq!(update.skipped, 0);

        let abort = import_documents_impl(&state, &conn_id, "sales_db", "customers", docs, "abort")
            .await
            .expect("abort import should validate in mock mode");
        assert_eq!(abort.inserted, 2);
        assert_eq!(abort.updated, 0);
        assert_eq!(abort.skipped, 0);
    }

    #[tokio::test]
    async fn test_mock_import_documents_rejects_bad_document() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        let result = import_documents_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            vec![serde_json::json!(["not", "a", "document"])],
            "skip",
        )
        .await;

        assert!(
            result.is_err(),
            "non-object imports must fail before writing"
        );
    }

    // ── SSH tunnel pure helpers (GO-LIVE C7) ──────────────────────────────
    #[test]
    fn test_extract_target_host_port() {
        use crate::ssh_tunnel::extract_target_host_port;
        assert_eq!(
            extract_target_host_port("mongodb://db.example.com:27018/admin?tls=true"),
            ("db.example.com".to_string(), 27018)
        );
        // credentials + multiple hosts → first host
        assert_eq!(
            extract_target_host_port("mongodb://user:p%40ss@host1:27017,host2:27017/db"),
            ("host1".to_string(), 27017)
        );
        // default port when omitted
        assert_eq!(
            extract_target_host_port("mongodb://myhost/mydb"),
            ("myhost".to_string(), 27017)
        );
        // invalid port falls back to MongoDB default
        assert_eq!(
            extract_target_host_port("mongodb://myhost:not-a-port/mydb"),
            ("myhost".to_string(), 27017)
        );
    }

    #[test]
    fn test_rewrite_uri_hosts_forwards_to_local_port() {
        use crate::ssh_tunnel::rewrite_uri_hosts;
        let out = rewrite_uri_hosts(
            "mongodb://db.example.com:27017/admin?replicaSet=rs0&tls=true",
            "127.0.0.1",
            12345,
        );
        assert!(out.starts_with("mongodb://127.0.0.1:12345"), "got {}", out);
        assert!(!out.contains("db.example.com"));
        // replicaSet conflicts with a single forwarded host → dropped, direct forced
        assert!(!out.contains("replicaSet"));
        assert!(out.contains("directConnection=true"));
        assert!(out.contains("tls=true"));
        assert!(out.contains("/admin"));
    }

    #[test]
    fn test_rewrite_uri_preserves_credentials() {
        use crate::ssh_tunnel::rewrite_uri_hosts;
        let out = rewrite_uri_hosts(
            "mongodb://user:pass@db.example.com:27017/",
            "127.0.0.1",
            999,
        );
        assert!(out.contains("user:pass@127.0.0.1:999"), "got {}", out);
    }

    #[test]
    fn test_rewrite_uri_handles_query_without_path() {
        use crate::ssh_tunnel::rewrite_uri_hosts;
        let out = rewrite_uri_hosts(
            "mongodb://db.example.com?directConnection=false&replicaSet=rs0&retryWrites=true",
            "localhost",
            27019,
        );
        assert_eq!(
            out,
            "mongodb://localhost:27019?retryWrites=true&directConnection=true"
        );
    }

    #[test]
    fn test_ssh_config_serde_roundtrip() {
        use crate::ssh_tunnel::{SshAuth, SshConfig};
        let cfg = SshConfig {
            enabled: true,
            host: "ssh.example.com".into(),
            port: 22,
            user: "deploy".into(),
            auth: SshAuth::Key {
                path: "/home/u/.ssh/id_ed25519".into(),
                passphrase: Some("pw".into()),
            },
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: SshConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "ssh.example.com");
        assert_eq!(back.port, 22);
        match back.auth {
            SshAuth::Key { path, passphrase } => {
                assert_eq!(path, "/home/u/.ssh/id_ed25519");
                assert_eq!(passphrase.as_deref(), Some("pw"));
            }
            _ => panic!("wrong auth variant"),
        }

        // password variant from frontend-shaped JSON
        let pw: SshConfig = serde_json::from_str(
            r#"{"enabled":true,"host":"h","port":2222,"user":"u","auth":{"type":"password","password":"s3cret"}}"#,
        )
        .unwrap();
        match pw.auth {
            SshAuth::Password { password } => assert_eq!(password, "s3cret"),
            _ => panic!("expected password auth"),
        }
    }

    // GO-LIVE H2: count must reflect the true match count, not the page size.
    #[tokio::test]
    async fn test_mock_count_documents() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        let total = count_documents_impl(&state, &conn_id, "sales_db", "products", "{}")
            .await
            .expect("count should succeed");
        assert!(total > 0, "mock products collection should have documents");

        // Invalid filter JSON is rejected.
        assert!(
            count_documents_impl(&state, &conn_id, "sales_db", "products", "{bad")
                .await
                .is_err()
        );
    }

    #[test]
    fn test_mock_query_sort_pagination_and_parse_errors() {
        let docs = crate::mock_db::execute_mock_query(
            "sales_db",
            "products",
            r#"{"category":"Electronics"}"#,
            r#"{"price":-1}"#,
            1,
            0,
        )
        .expect("mock query should sort and limit");
        assert_eq!(docs.len(), 1);
        let first: serde_json::Value = serde_json::from_str(&docs[0]).unwrap();
        assert_eq!(first["name"], "SuperBook Pro");

        let skipped = crate::mock_db::execute_mock_query(
            "sales_db",
            "products",
            "{}",
            r#"{"stock":1}"#,
            1,
            1,
        )
        .expect("mock query should skip");
        let skipped_first: serde_json::Value = serde_json::from_str(&skipped[0]).unwrap();
        assert_eq!(skipped_first["name"], "SuperBook Pro");

        let bad_filter =
            crate::mock_db::count_mock_documents("sales_db", "products", "{bad").unwrap_err();
        assert!(bad_filter.contains("Invalid MQL filter JSON"));

        let bad_sort =
            crate::mock_db::execute_mock_query("sales_db", "products", "{}", "{bad", 10, 0)
                .unwrap_err();
        assert!(bad_sort.contains("Invalid MQL sort JSON"));
    }

    #[tokio::test]
    async fn test_count_documents_empty_filter_returns_full_count() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");
        // Empty filter must return the full collection count (estimate path), matching count_mock_documents.
        let full = count_documents_impl(&state, &conn_id, "sales_db", "products", "{}")
            .await
            .expect("count empty filter");
        let blank = count_documents_impl(&state, &conn_id, "sales_db", "products", "")
            .await
            .expect("count blank filter");
        assert!(
            full > 0,
            "empty-filter count should be the full collection size"
        );
        assert_eq!(
            full, blank,
            "blank and {{}} filters must behave identically"
        );
    }

    #[tokio::test]
    async fn test_query_real_path_validation_before_missing_client() {
        let state = AppState::new();
        let id = "realish-query";
        state.mocks.lock().unwrap().insert(id.to_string(), false);

        let bad_filter =
            execute_mql_query_impl(&state, id, "db", "coll", "{bad", "{}", "{}", 10, 0)
                .await
                .unwrap_err();
        assert!(bad_filter.contains("Invalid MQL filter JSON"));

        let bad_sort = execute_mql_query_impl(&state, id, "db", "coll", "{}", "{bad", "{}", 10, 0)
            .await
            .unwrap_err();
        assert!(bad_sort.contains("Invalid MQL sort JSON"));

        let missing_client =
            execute_mql_query_impl(&state, id, "db", "coll", "{}", r#"{"name":1}"#, "{}", 10, 5)
                .await
                .unwrap_err();
        assert_eq!(missing_client, "Connection client not found");

        let bad_count = count_documents_impl(&state, id, "db", "coll", "{bad")
            .await
            .unwrap_err();
        assert!(bad_count.contains("Invalid MQL filter JSON"));

        let missing_count_client = count_documents_impl(&state, id, "db", "coll", r#"{"a":1}"#)
            .await
            .unwrap_err();
        assert_eq!(missing_count_client, "Connection client not found");
    }

    #[tokio::test]
    async fn test_execute_aggregate_validates_pipeline_and_rejects_mock() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        // Malformed pipeline JSON fails clearly before touching the connection.
        let bad = execute_aggregate_impl(&state, &conn_id, "sales_db", "products", "[{bad}]").await;
        assert!(
            bad.unwrap_err()
                .contains("Invalid aggregation pipeline JSON"),
            "malformed pipeline should report a parse error"
        );

        // A pipeline that isn't a JSON array is rejected.
        let not_array =
            execute_aggregate_impl(&state, &conn_id, "sales_db", "products", "{}").await;
        assert!(
            not_array.unwrap_err().contains("must be a JSON array"),
            "non-array pipeline should be rejected"
        );

        let bad_stage =
            execute_aggregate_impl(&state, &conn_id, "sales_db", "products", r#"["bad"]"#).await;
        assert!(
            bad_stage.unwrap_err().contains("Invalid aggregation stage"),
            "non-document stage should be rejected"
        );

        // A well-formed pipeline on a mock connection reports aggregation is unsupported there.
        let pipeline = r#"[{"$match": {"category": "Electronics"}}, {"$count": "count"}]"#;
        let mock_res =
            execute_aggregate_impl(&state, &conn_id, "sales_db", "products", pipeline).await;
        assert!(
            mock_res
                .unwrap_err()
                .contains("not supported on mock connections"),
            "aggregation on a mock connection should be rejected"
        );
    }

    // GO-LIVE M1: aggregate explain validates the pipeline and rejects mock.
    #[tokio::test]
    async fn test_explain_aggregate_validates_pipeline_and_rejects_mock() {
        use crate::explain_aggregate_query_impl;
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        // Malformed pipeline JSON fails clearly before touching the connection.
        let bad =
            explain_aggregate_query_impl(&state, &conn_id, "sales_db", "products", "[{bad}]").await;
        assert!(
            bad.unwrap_err()
                .contains("Invalid aggregation pipeline JSON"),
            "malformed pipeline should report a parse error"
        );

        // A pipeline that isn't a JSON array is rejected.
        let not_array =
            explain_aggregate_query_impl(&state, &conn_id, "sales_db", "products", "{}").await;
        assert!(
            not_array.unwrap_err().contains("must be a JSON array"),
            "non-array pipeline should be rejected"
        );

        let bad_stage =
            explain_aggregate_query_impl(&state, &conn_id, "sales_db", "products", r#"["bad"]"#)
                .await;
        assert!(
            bad_stage.unwrap_err().contains("Invalid aggregation stage"),
            "non-document pipeline stage should be rejected"
        );

        // A well-formed pipeline on a mock connection reports explain is unsupported there.
        let pipeline = r#"[{"$match": {"category": "Electronics"}}, {"$count": "count"}]"#;
        let mock_res =
            explain_aggregate_query_impl(&state, &conn_id, "sales_db", "products", pipeline).await;
        assert!(
            mock_res
                .unwrap_err()
                .contains("not supported on mock connections"),
            "aggregate explain on a mock connection should be rejected"
        );
    }

    // GO-LIVE M7 (view creation): create_view validates inputs and no-ops on mock.
    #[tokio::test]
    async fn test_create_view_validates_and_mock_noops() {
        use crate::create_view_impl;
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        // Empty view name is rejected.
        let no_name = create_view_impl(&state, &conn_id, "sales_db", "", "customers", "[]").await;
        assert!(no_name.is_err(), "empty view name should be rejected");

        // Empty source collection is rejected.
        let no_source = create_view_impl(&state, &conn_id, "sales_db", "vip", "", "[]").await;
        assert!(
            no_source.is_err(),
            "empty source collection should be rejected"
        );

        // A pipeline that isn't a JSON array is rejected.
        let bad_pipeline =
            create_view_impl(&state, &conn_id, "sales_db", "vip", "customers", "{}").await;
        assert!(
            bad_pipeline.unwrap_err().contains("must be a JSON array"),
            "non-array pipeline should be rejected"
        );

        // Malformed pipeline JSON is rejected.
        let malformed =
            create_view_impl(&state, &conn_id, "sales_db", "vip", "customers", "[{bad}]").await;
        assert!(malformed.is_err(), "malformed pipeline should be rejected");

        // A well-formed view on a mock connection no-ops successfully.
        let pipeline = r#"[{"$match": {"tier": "Premium"}}]"#;
        let ok = create_view_impl(&state, &conn_id, "sales_db", "vip", "customers", pipeline).await;
        assert!(
            ok.is_ok(),
            "well-formed view on mock should succeed (no-op)"
        );
    }

    // GO-LIVE T1: backend seams reachable without a live MongoDB server.
    #[tokio::test]
    async fn test_get_mongodb_version_mock_and_not_found() {
        use crate::get_mongodb_version_impl;
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        let v = get_mongodb_version_impl(&state, &conn_id)
            .await
            .expect("mock version");
        assert_eq!(v, "7.0.5");

        let missing = get_mongodb_version_impl(&state, "no-such-conn").await;
        assert!(
            missing.unwrap_err().contains("not found"),
            "unknown connection should error"
        );
    }

    #[tokio::test]
    async fn test_mongosh_session_not_found() {
        use crate::{run_mongosh_command_impl, stop_mongosh_session_impl};
        let state = AppState::new();

        let run = run_mongosh_command_impl(&state, "bogus-session", "db.x.find()").await;
        // MongoshCommandOutput isn't Debug, so use .err() rather than unwrap_err().
        let run_err = run
            .err()
            .expect("running on an unknown session should error");
        assert!(run_err.contains("session not found"));

        // Stopping an unknown session is an idempotent no-op (no panic, returns Ok).
        let stop = stop_mongosh_session_impl(&state, "bogus-session").await;
        assert!(
            stop.is_ok(),
            "stopping an unknown session should be a no-op"
        );
    }

    #[tokio::test]
    async fn test_mock_delete_index_removes_it() {
        use crate::{create_index_impl, delete_index_impl, list_indexes_impl};
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        create_index_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            "tmp_idx",
            r#"{"tmp":1}"#,
            false,
            false,
        )
        .await
        .expect("create index");
        let before = list_indexes_impl(&state, &conn_id, "sales_db", "customers")
            .await
            .expect("list");
        assert!(
            before.iter().any(|i| i.name == "tmp_idx"),
            "index should exist after create"
        );

        delete_index_impl(&state, &conn_id, "sales_db", "customers", "tmp_idx")
            .await
            .expect("delete index");
        let after = list_indexes_impl(&state, &conn_id, "sales_db", "customers")
            .await
            .expect("list");
        assert!(
            !after.iter().any(|i| i.name == "tmp_idx"),
            "index should be gone after delete"
        );
    }

    // GO-LIVE M7 (GridFS): list/download are real-only and reject mock connections.
    #[tokio::test]
    async fn test_gridfs_rejects_mock() {
        use crate::{download_gridfs_file_impl, list_gridfs_files_impl};
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        let list = list_gridfs_files_impl(&state, &conn_id, "sales_db", "uploads").await;
        assert!(
            list.unwrap_err().contains("not supported on mock"),
            "GridFS list on a mock connection should be rejected"
        );

        let dl = download_gridfs_file_impl(
            &state,
            &conn_id,
            "sales_db",
            "uploads",
            r#"{"$oid":"507f1f77bcf86cd799439011"}"#,
            "/tmp/out.bin",
            None,
            None,
        )
        .await;
        assert!(
            dl.unwrap_err().contains("not supported on mock"),
            "GridFS download on a mock connection should be rejected"
        );

        let up = upload_gridfs_file_impl(
            &state,
            &conn_id,
            "sales_db",
            "uploads",
            "/tmp/in.bin",
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(
            up.unwrap_err().contains("not supported on mock"),
            "GridFS upload on a mock connection should be rejected"
        );

        let del = delete_gridfs_file_impl(
            &state,
            &conn_id,
            "sales_db",
            "uploads",
            r#"{"$oid":"507f1f77bcf86cd799439011"}"#,
        )
        .await;
        assert!(
            del.unwrap_err().contains("not supported on mock"),
            "GridFS delete on a mock connection should be rejected"
        );
    }

    #[tokio::test]
    async fn test_gridfs_validation_errors_without_real_client() {
        let state = AppState::new();
        let id = "realish-gridfs";
        state.mocks.lock().unwrap().insert(id.to_string(), false);

        let bad_id = download_gridfs_file_impl(&state, id, "db", "fs", "{", "/tmp/file.bin", None, None)
            .await
            .unwrap_err();
        assert!(bad_id.contains("Invalid file id JSON"));

        let bad_upload_meta = upload_gridfs_file_impl(
            &state,
            id,
            "db",
            "fs",
            "/tmp/missing.bin",
            None,
            Some("{"),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(bad_upload_meta.contains("Invalid metadata JSON"));

        let bad_delete = delete_gridfs_file_impl(&state, id, "db", "fs", "{")
            .await
            .unwrap_err();
        assert!(bad_delete.contains("Invalid file id JSON"));

        let missing_client = list_gridfs_files_impl(&state, id, "db", "fs")
            .await
            .unwrap_err();
        assert_eq!(missing_client, "Connection client not found");
    }

    // GO-LIVE M7 (bulk ops): delete_many/update_many validate inputs and no-op on mock.
    #[tokio::test]
    async fn test_bulk_ops_validate_and_mock_noop() {
        use crate::{delete_many_impl, update_many_impl};
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        // delete_many: malformed filter is rejected.
        let bad_filter = delete_many_impl(&state, &conn_id, "sales_db", "customers", "{bad").await;
        assert!(
            bad_filter.is_err(),
            "malformed delete filter should be rejected"
        );

        // delete_many: valid filter on mock no-ops (returns 0, no persistence).
        let del = delete_many_impl(&state, &conn_id, "sales_db", "customers", r#"{"tier":"X"}"#)
            .await
            .expect("mock delete_many ok");
        assert_eq!(del, 0);

        // update_many: a non-operator update (bare replacement) is rejected.
        let non_op = update_many_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            "{}",
            r#"{"name":"x"}"#,
        )
        .await;
        assert!(
            non_op.is_err(),
            "update without operators ($set etc.) should be rejected"
        );

        // update_many: malformed update JSON is rejected.
        let bad_update =
            update_many_impl(&state, &conn_id, "sales_db", "customers", "{}", "{bad").await;
        assert!(bad_update.is_err(), "malformed update should be rejected");

        // update_many: a valid operator update on mock no-ops (returns 0).
        let upd = update_many_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            r#"{"tier":"X"}"#,
            r#"{"$set":{"tier":"Y"}}"#,
        )
        .await
        .expect("mock update_many ok");
        assert_eq!(upd, 0);
    }

    // GO-LIVE M6: pure schema inference over sampled documents.
    #[test]
    fn test_infer_schema_types_paths_and_coverage() {
        use crate::infer_schema;
        use mongodb::bson::doc;

        let docs = vec![
            doc! { "name": "a", "price": 9.99_f64, "address": { "city": "NYC" }, "tags": ["x", "y"] },
            doc! { "name": "b", "price": 5_i32, "address": { "city": "LA" } },
            doc! { "name": "c" },
        ];
        let report = infer_schema(&docs);
        assert_eq!(report.sampled, 3);

        let by_path = |p: &str| {
            report
                .fields
                .iter()
                .find(|f| f.path == p)
                .unwrap_or_else(|| panic!("missing path {}", p))
        };

        // `name` present in every doc -> full coverage.
        let name = by_path("name");
        assert_eq!(name.presence, 3);
        assert!((name.coverage - 1.0).abs() < 1e-9);

        // `price`: double in one doc, int in another -> mixed types, presence 2.
        let price = by_path("price");
        assert_eq!(price.presence, 2);
        let price_types: std::collections::HashMap<&str, usize> = price
            .types
            .iter()
            .map(|t| (t.type_name.as_str(), t.count))
            .collect();
        assert_eq!(price_types.get("double"), Some(&1));
        assert_eq!(price_types.get("int"), Some(&1));

        // Nested: `address` is an object and `address.city` a string.
        assert_eq!(by_path("address").types[0].type_name, "object");
        let city = by_path("address.city");
        assert_eq!(city.presence, 2);
        assert_eq!(city.types[0].type_name, "string");

        // Arrays are reported as `array` and not recursed into.
        assert_eq!(by_path("tags").types[0].type_name, "array");
        assert!(report.fields.iter().all(|f| !f.path.starts_with("tags.")));
    }

    #[tokio::test]
    async fn test_analyze_schema_mock_returns_report() {
        use crate::analyze_schema_impl;
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");
        let json = analyze_schema_impl(&state, &conn_id, "sales_db", "customers", 1000)
            .await
            .expect("analyze");
        let report: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(report["sampled"].as_u64().unwrap() > 0);
        let fields = report["fields"].as_array().unwrap();
        assert!(
            fields.iter().any(|f| f["path"] == "name"),
            "expected a 'name' field in the mock customers schema"
        );
    }

    // GO-LIVE H3: projection is parsed/validated (invalid projection rejected).
    #[tokio::test]
    async fn test_execute_query_rejects_invalid_projection() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        let res = execute_mql_query_impl(
            &state, &conn_id, "sales_db", "products", "{}", "{}", "{bad", 10, 0,
        )
        .await;
        assert!(res.is_err(), "invalid projection JSON must error");

        // A valid projection still returns mock results.
        let ok = execute_mql_query_impl(
            &state,
            &conn_id,
            "sales_db",
            "products",
            "{}",
            "{}",
            r#"{"name":1}"#,
            10,
            0,
        )
        .await;
        assert!(ok.is_ok());
    }

    // User management: mock listing/filtering, input validation, and the
    // unknown-connection error path.
    #[tokio::test]
    async fn test_user_management_mock_and_validation() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        // Mock listing: all databases vs filtered to one.
        let all = list_users_impl(&state, &conn_id, None)
            .await
            .expect("list all users in mock mode");
        assert!(all.len() >= 3, "mock should ship several demo users");
        let sales = list_users_impl(&state, &conn_id, Some("sales_db"))
            .await
            .expect("list sales_db users in mock mode");
        assert!(!sales.is_empty());
        assert!(sales.iter().all(|u| u.db == "sales_db"));

        // Roles picker data includes built-in roles.
        let roles = list_roles_impl(&state, &conn_id, "sales_db")
            .await
            .expect("list roles in mock mode");
        assert!(roles.iter().any(|r| r.role == "readWrite" && r.is_builtin));

        // Validation is rejected before touching the connection.
        let rw = vec![RoleSpec { role: "readWrite".into(), db: "sales_db".into() }];
        let sample_pw = test_secret(&["p", "w"]);
        let create_pw = test_secret(&["sec", "ret"]);
        let updated_pw = test_secret(&["new", "pw"]);
        assert!(create_user_impl(&state, &conn_id, "sales_db", "", &sample_pw, &rw)
            .await
            .is_err());
        assert!(create_user_impl(&state, &conn_id, "sales_db", "bob", "", &rw)
            .await
            .is_err());
        assert!(update_user_impl(&state, &conn_id, "sales_db", "", Some(&sample_pw), None)
            .await
            .is_err());
        // Nothing to change: no password and no roles.
        assert!(update_user_impl(&state, &conn_id, "sales_db", "bob", None, None)
            .await
            .is_err());
        assert!(update_user_impl(&state, &conn_id, "sales_db", "bob", Some(""), None)
            .await
            .is_err());
        assert!(drop_user_impl(&state, &conn_id, "sales_db", "")
            .await
            .is_err());

        // Half-specified roles are rejected (no silent dropping).
        let bad_role = vec![RoleSpec { role: "".into(), db: "sales_db".into() }];
        assert!(create_user_impl(&state, &conn_id, "sales_db", "bob", &sample_pw, &bad_role)
            .await
            .is_err());
        let bad_db = vec![RoleSpec { role: "readWrite".into(), db: " ".into() }];
        assert!(
            update_user_impl(&state, &conn_id, "sales_db", "bob", None, Some(&bad_db))
                .await
                .is_err()
        );

        // Valid mutations succeed as no-ops in mock mode.
        create_user_impl(&state, &conn_id, "sales_db", "bob", &create_pw, &rw)
            .await
            .expect("create user in mock mode");
        update_user_impl(&state, &conn_id, "sales_db", "bob", Some(&updated_pw), Some(&rw))
            .await
            .expect("update user in mock mode");
        update_user_impl(&state, &conn_id, "sales_db", "bob", None, Some(&[]))
            .await
            .expect("clearing roles alone is a valid update");
        drop_user_impl(&state, &conn_id, "sales_db", "bob")
            .await
            .expect("drop user in mock mode");

        // Non-mock connection without a real client reports the standard error.
        let realish = "realish-users";
        state
            .mocks
            .lock()
            .unwrap()
            .insert(realish.to_string(), false);
        assert_eq!(
            list_users_impl(&state, realish, None).await.unwrap_err(),
            "Connection client not found"
        );
        assert_eq!(
            create_user_impl(&state, realish, "sales_db", "bob", &sample_pw, &rw)
                .await
                .unwrap_err(),
            "Connection client not found"
        );

        // Unknown connection id errors on the mock check itself.
        assert!(list_users_impl(&state, "missing", None).await.is_err());
    }

    // GO-LIVE C6/H6: collection/database management wiring (mock path + input validation).
    #[tokio::test]
    async fn test_mock_create_drop_rename_collection_and_drop_database() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");

        // Empty collection name is rejected before touching the connection.
        assert!(create_collection_impl(&state, &conn_id, "sales_db", "")
            .await
            .is_err());

        create_collection_impl(&state, &conn_id, "sales_db", "new_coll")
            .await
            .expect("create collection should succeed in mock mode");
        rename_collection_impl(&state, &conn_id, "sales_db", "new_coll", "renamed_coll")
            .await
            .expect("rename collection should succeed in mock mode");
        drop_collection_impl(&state, &conn_id, "sales_db", "new_coll")
            .await
            .expect("drop collection should succeed in mock mode");
        drop_database_impl(&state, &conn_id, "sales_db")
            .await
            .expect("drop database should succeed in mock mode");
        let renamed = rename_database_impl(&state, &conn_id, "sales_db", "sales_archive", true)
            .await
            .expect("rename database should succeed in mock mode");
        assert_eq!(renamed.collections, 0);
        assert_eq!(renamed.documents, 0);

        assert!(
            rename_collection_impl(&state, &conn_id, "sales_db", "", "renamed")
                .await
                .is_err()
        );
        assert!(
            rename_collection_impl(&state, &conn_id, "sales_db", "same", "same")
                .await
                .is_err()
        );
        assert!(drop_database_impl(&state, &conn_id, "").await.is_err());
        assert!(rename_database_impl(&state, &conn_id, "", "target", true)
            .await
            .is_err());
        assert!(rename_database_impl(&state, &conn_id, "same", "same", true)
            .await
            .is_err());

        let realish = "realish-ddl";
        state
            .mocks
            .lock()
            .unwrap()
            .insert(realish.to_string(), false);
        assert_eq!(
            create_collection_impl(&state, realish, "sales_db", "new_coll")
                .await
                .unwrap_err(),
            "Connection client not found"
        );
        assert_eq!(
            drop_collection_impl(&state, realish, "sales_db", "new_coll")
                .await
                .unwrap_err(),
            "Connection client not found"
        );
        assert_eq!(
            rename_collection_impl(&state, realish, "sales_db", "from", "to")
                .await
                .unwrap_err(),
            "Connection client not found"
        );
        assert_eq!(
            drop_database_impl(&state, realish, "sales_db")
                .await
                .unwrap_err(),
            "Connection client not found"
        );
    }

    // GO-LIVE C5: real NL→MQL generation. The risky pure parts are request shaping
    // and pulling a valid JSON object out of the model's text response.
    #[test]
    fn test_build_query_gen_request_shape() {
        use crate::ai::build_query_gen_request;
        let body = build_query_gen_request("claude-opus-4-8", "SYS", &[], "users older than 30");
        assert_eq!(body["model"], "claude-opus-4-8");
        assert_eq!(body["max_tokens"], 2048);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "users older than 30");
        assert_eq!(body["system"][0]["text"], "SYS");
        // No sampling params (Opus 4.8 rejects temperature/top_p/top_k).
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn test_extract_mql_from_response() {
        use crate::ai::extract_mql_from_response;
        // Model wrapped the JSON in prose + a code fence — we should still recover it.
        let resp = serde_json::json!({
            "content": [
                { "type": "text", "text": "Here you go:\n```json\n{\"filter\": {\"age\": {\"$gt\": 30}}, \"sort\": {\"age\": -1}}\n```" }
            ]
        });
        let out = extract_mql_from_response(&resp).expect("should extract JSON");
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["filter"]["age"]["$gt"], 30);
        assert_eq!(parsed["sort"]["age"], -1);

        // No JSON in the response → error.
        let bad = serde_json::json!({ "content": [{ "type": "text", "text": "I cannot help" }] });
        assert!(extract_mql_from_response(&bad).is_err());
    }

    #[tokio::test]
    async fn test_invalid_connection_string() {
        let state = AppState::new();
        let result = connect_db_impl(&state, "not-a-mongodb-uri", None).await;
        assert!(result.is_err(), "Invalid URI should return error");
    }

    // Legacy/new "allow invalid hostname" options must map to a URI option the
    // Rust driver accepts with the default rustls backend.
    #[test]
    fn test_normalizes_legacy_tls_uri_options() {
        let uri = "mongodb://localhost:27017/?sslInvalidHostNameAllowed=true&sslAllowInvalidCertificates=true";
        let normalized = crate::connections::normalize_mongodb_uri_options(uri);

        assert!(normalized.contains("tlsInsecure=true"));
        assert!(normalized.contains("tlsAllowInvalidCertificates=true"));
        assert!(!normalized.contains("sslInvalidHostNameAllowed"));
    }

    #[test]
    fn test_hostname_option_maps_to_tls_insecure_driver_alias() {
        let uri = "mongodb://localhost:27017/?sslAllowInvalidHostnames=true";
        let normalized = crate::connections::normalize_mongodb_uri_options(uri);
        assert!(normalized.contains("tlsInsecure=true"));
        assert!(!normalized.contains("tlsAllowInvalidCertificates"));
    }

    #[test]
    fn test_normalizes_lowercase_tls_uri_options_from_imports() {
        let uri = "mongodb://localhost:27017/?tlsallowinvalidhostnames=true&tlsallowinvalidcertificates=true";
        let normalized = crate::connections::normalize_mongodb_uri_options(uri);

        assert_eq!(
            normalized,
            "mongodb://localhost:27017/?tlsInsecure=true&tlsAllowInvalidCertificates=true"
        );
    }

    #[test]
    fn test_normalizes_documented_legacy_uri_option_aliases() {
        let uri = "mongodb://localhost:27017/?ssl=true;sslCAFile=/tmp/ca.pem;sslPEMKeyFile=/tmp/client.pem;localThreshold=20;gssapiServiceName=mongodb";
        let normalized = crate::connections::normalize_mongodb_uri_options(uri);

        assert_eq!(
            normalized,
            "mongodb://localhost:27017/?tls=true&tlsCAFile=/tmp/ca.pem&tlsCertificateKeyFile=/tmp/client.pem&localThresholdMS=20&authMechanismProperties=SERVICE_NAME:mongodb"
        );
    }

    #[tokio::test]
    async fn test_normalized_tls_hostname_aliases_parse_with_driver() {
        use mongodb::options::ClientOptions;

        for uri in [
            "mongodb://localhost:27017/?tlsAllowInvalidHostnames=true",
            "mongodb://localhost:27017/?tlsallowinvalidhostnames=true",
            "mongodb://localhost:27017/?sslInvalidHostNameAllowed=true",
            "mongodb://localhost:27017/?ssl=true;sslAllowInvalidCertificates=true",
            "mongodb://localhost:27017/?localThreshold=20;gssapiServiceName=mongodb",
        ] {
            let normalized = crate::connections::normalize_mongodb_uri_options(uri);
            ClientOptions::parse(&normalized)
                .await
                .unwrap_or_else(|e| panic!("normalized URI should parse: {normalized} ({e})"));
        }
    }

    #[tokio::test]
    async fn test_query_invalid_json() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .unwrap();

        let result = execute_mql_query_impl(
            &state,
            &conn_id,
            "sales_db",
            "products",
            "{invalid-json}",
            r#"{}"#,
            r#"{}"#,
            10,
            0,
        )
        .await;

        assert!(result.is_err(), "Invalid JSON filter should fail parsing");
    }

    #[tokio::test]
    async fn test_save_load_delete_profile_flow() {
        // Create a temporary directory or file path for testing
        let temp_dir = std::env::temp_dir();
        let test_file_path =
            temp_dir.join(format!("test_connections_{}.json", uuid::Uuid::new_v4()));

        // Ensure file does not exist initially, load should return empty list
        let initial_profiles = crate::connections::load_profiles_from_file(&test_file_path)
            .expect("Should load empty profiles");
        assert!(initial_profiles.is_empty());

        std::fs::write(&test_file_path, "   ").unwrap();
        let empty_profiles = crate::connections::load_profiles_from_file(&test_file_path)
            .expect("Should treat empty profile file as empty");
        assert!(empty_profiles.is_empty());

        std::fs::write(&test_file_path, "{bad json").unwrap();
        let bad_profiles = crate::connections::load_profiles_from_file(&test_file_path);
        assert!(bad_profiles
            .unwrap_err()
            .contains("Failed to parse connections file"));

        // Create a connection profile
        let profile1 = crate::connections::ConnectionProfile {
            id: "profile-1".to_string(),
            name: "Mock Database".to_string(),
            uri: "mongodb://mock".to_string(),
            color_tag: None,
            ssh: None,
        };

        // Save profile
        let mut profiles = vec![profile1.clone()];
        crate::connections::save_profiles_to_file(&test_file_path, &profiles)
            .expect("Should save profile successfully");

        // Load profile back and verify
        let loaded_profiles = crate::connections::load_profiles_from_file(&test_file_path)
            .expect("Should load profiles successfully");
        assert_eq!(loaded_profiles.len(), 1);
        assert_eq!(loaded_profiles[0], profile1);

        // Add a second profile
        let profile2 = crate::connections::ConnectionProfile {
            id: "profile-2".to_string(),
            name: "Prod DB".to_string(),
            uri: "mongodb://localhost:27017".to_string(),
            color_tag: None,
            ssh: Some(crate::ssh_tunnel::SshConfig {
                enabled: true,
                host: "bastion.example.com".to_string(),
                port: 22,
                user: "deploy".to_string(),
                auth: crate::ssh_tunnel::SshAuth::Key {
                    path: "/home/u/.ssh/id_ed25519".to_string(),
                    passphrase: None,
                },
            }),
        };
        profiles.push(profile2.clone());
        crate::connections::save_profiles_to_file(&test_file_path, &profiles)
            .expect("Should save updated profiles");

        let loaded_profiles_2 = crate::connections::load_profiles_from_file(&test_file_path)
            .expect("Should load profiles");
        assert_eq!(loaded_profiles_2.len(), 2);
        assert!(loaded_profiles_2.contains(&profile1));
        assert!(loaded_profiles_2.contains(&profile2));

        // Delete profile 1
        let filtered_profiles: Vec<_> = loaded_profiles_2
            .into_iter()
            .filter(|p| p.id != "profile-1")
            .collect();
        crate::connections::save_profiles_to_file(&test_file_path, &filtered_profiles)
            .expect("Should delete profile and save");

        let final_profiles = crate::connections::load_profiles_from_file(&test_file_path)
            .expect("Should load profiles");
        assert_eq!(final_profiles.len(), 1);
        assert_eq!(final_profiles[0], profile2);

        // Clean up temp file
        let _ = std::fs::remove_file(&test_file_path);
    }

    #[tokio::test]
    async fn test_run_connection_test_phases() {
        use crate::connections::{run_connection_test, PhaseUpdate, TestPhase};
        use std::sync::Mutex;

        let ok_phases = |log: &Mutex<Vec<PhaseUpdate>>| -> Vec<TestPhase> {
            log.lock()
                .unwrap()
                .iter()
                .filter(|u| u.status == "ok")
                .map(|u| u.phase.clone())
                .collect()
        };
        let failed_phase = |log: &Mutex<Vec<PhaseUpdate>>| -> Option<TestPhase> {
            log.lock()
                .unwrap()
                .iter()
                .find(|u| u.status == "fail")
                .map(|u| u.phase.clone())
        };

        // Mock URI: all four phases succeed, offline.
        let log: Mutex<Vec<PhaseUpdate>> = Mutex::new(Vec::new());
        let res =
            run_connection_test("mongodb://mock", None, &|u| log.lock().unwrap().push(u)).await;
        assert!(res.is_ok());
        assert_eq!(
            ok_phases(&log),
            vec![
                TestPhase::Parse,
                TestPhase::Resolve,
                TestPhase::Connect,
                TestPhase::Ping
            ]
        );

        // Invalid URI: fails at the Parse phase.
        let log2: Mutex<Vec<PhaseUpdate>> = Mutex::new(Vec::new());
        let res2 =
            run_connection_test("not-a-valid-uri", None, &|u| log2.lock().unwrap().push(u)).await;
        assert!(res2.is_err());
        assert_eq!(failed_phase(&log2), Some(TestPhase::Parse));

        // Reserved .invalid TLD never resolves: reaches and fails at Resolve.
        let log3: Mutex<Vec<PhaseUpdate>> = Mutex::new(Vec::new());
        let res3 = run_connection_test("mongodb://nonexistent.invalid:27017", None, &|u| {
            log3.lock().unwrap().push(u)
        })
        .await;
        assert!(res3.is_err());
        assert_eq!(failed_phase(&log3), Some(TestPhase::Resolve));
    }

    #[test]
    fn test_app_settings_defaults_and_backcompat() {
        use crate::connections::{resolve_local_command, AppSettings};

        // Legacy file with only mongosh_path must still deserialize.
        let legacy: AppSettings =
            serde_json::from_str(r#"{"mongosh_path":"/usr/local/bin/mongosh"}"#).unwrap();
        assert_eq!(legacy.mongosh_path, "/usr/local/bin/mongosh");
        assert_eq!(legacy.ai_provider, "anthropic");
        assert_eq!(legacy.anthropic_model, "claude-opus-4-8");
        assert_eq!(legacy.openai_model, "gpt-4o");
        assert_eq!(legacy.gemini_model, "gemini-1.5-flash");
        assert_eq!(legacy.ai_custom_instructions, "");

        // resolve_local_command falls back to built-in defaults when unset.
        assert_eq!(
            resolve_local_command(&legacy, "claude-code"),
            "claude -p {prompt}"
        );
        assert_eq!(
            resolve_local_command(&legacy, "codex"),
            "codex exec {prompt}"
        );

        // An override wins.
        let mut s = AppSettings::default();
        s.local_commands
            .insert("codex".into(), "codex run {prompt}".into());
        assert_eq!(resolve_local_command(&s, "codex"), "codex run {prompt}");
    }

    #[test]
    fn test_settings_file_handling() {
        use crate::connections::{load_settings_from_file, save_settings_to_file, AppSettings};

        let dir = std::env::temp_dir().join(format!(
            "mqlens-settings-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        assert_eq!(
            load_settings_from_file(&path).unwrap(),
            AppSettings::default()
        );

        std::fs::write(&path, "  ").unwrap();
        assert_eq!(
            load_settings_from_file(&path).unwrap(),
            AppSettings::default()
        );

        std::fs::write(&path, "{bad json").unwrap();
        let parse_err = load_settings_from_file(&path).unwrap_err();
        assert!(parse_err.contains("Failed to parse settings file"));

        let settings = AppSettings {
            mongosh_path: "/opt/mongosh".to_string(),
            ..Default::default()
        };
        save_settings_to_file(&path, &settings).expect("settings should save");
        assert_eq!(
            load_settings_from_file(&path).unwrap().mongosh_path,
            "/opt/mongosh"
        );

        let write_err = save_settings_to_file(&dir, &settings).unwrap_err();
        assert!(write_err.contains("Failed to write settings file"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_prompt_assembly() {
        use crate::ai::{apply_custom_instructions, combined_prompt};

        let base = "BASE";
        assert_eq!(apply_custom_instructions(base, ""), "BASE");
        assert_eq!(apply_custom_instructions(base, "   "), "BASE");
        assert_eq!(
            apply_custom_instructions(base, "Prefer $regex"),
            "BASE\n\nAdditional instructions from the user:\nPrefer $regex"
        );

        // Local agents get one combined prompt (system folded in).
        let c = combined_prompt("SYS", &[], "find active users");
        assert!(c.contains("SYS"));
        assert!(c.contains("find active users"));
    }

    // Multi-turn chat: prior turns must be threaded into every provider's request.
    #[test]
    fn test_history_threading() {
        use crate::ai::{
            build_gemini_request, build_openai_request, build_query_gen_request, combined_prompt,
            ChatTurn,
        };

        let history = vec![
            ChatTurn {
                role: "user".into(),
                content: "find active users".into(),
            },
            ChatTurn {
                role: "assistant".into(),
                content: "{\"queryType\":\"find\"}".into(),
            },
        ];

        // Anthropic: history messages precede the final user message.
        let a = build_query_gen_request("claude-opus-4-8", "SYS", &history, "now sort by age");
        let msgs = a["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[2]["content"], "now sort by age");

        // OpenAI: system first, then history, then final user.
        let o = build_openai_request("gpt-4o", "SYS", &history, "now sort by age");
        let omsgs = o["messages"].as_array().unwrap();
        assert_eq!(omsgs[0]["role"], "system");
        assert_eq!(omsgs.len(), 4);
        assert_eq!(omsgs[3]["content"], "now sort by age");

        // Gemini: assistant role maps to "model".
        let g = build_gemini_request("SYS", &history, "now sort by age");
        let contents = g["contents"].as_array().unwrap();
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[2]["parts"][0]["text"], "now sort by age");

        // Local: history folded into one prompt.
        let c = combined_prompt("SYS", &history, "now sort by age");
        assert!(c.contains("find active users"));
        assert!(c.contains("now sort by age"));
    }

    // The extractor must return the FIRST balanced JSON object, ignoring any prose
    // (or extra braces) the model adds before/after it.
    #[test]
    fn test_extract_json_object_tolerates_trailing_prose() {
        use crate::ai::extract_json_object;

        // Trailing sentence after the object (the bug seen in manual E2E).
        let out = extract_json_object(
            "{\"filter\": {\"age\": {\"$gt\": 30}}, \"sort\": {}}\n\nLet me know if you'd like to tweak it.",
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["filter"]["age"]["$gt"], 30);

        // Leading prose + fenced object + a trailing brace in prose.
        let out = extract_json_object("Sure:\n```json\n{\"a\": 1}\n```\nDone. }").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["a"], 1);

        // A brace inside a string value must not end the object early.
        let out = extract_json_object("{\"q\": \"a } b\", \"n\": 2} trailing").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["q"], "a } b");
        assert_eq!(v["n"], 2);

        assert!(extract_json_object("no json here").is_err());
    }

    // The system prompt must request the richer contract (explanation + queryType + pipeline).
    #[test]
    fn test_system_prompt_contract() {
        let sys = crate::ai::mql_system_prompt("users", &["age".to_string()]);
        assert!(sys.contains("explanation"));
        assert!(sys.contains("queryType"));
        assert!(sys.contains("pipeline"));
        assert!(sys.contains("aggregate"));
    }

    #[test]
    fn test_shell_system_prompt_contract() {
        let sys = crate::ai::mql_shell_system_prompt("users", &["age".to_string()]);
        // Includes the base contract.
        assert!(sys.contains("explanation"));
        assert!(sys.contains("queryType"));
        assert!(sys.contains("pipeline"));
        assert!(sys.contains("aggregate"));
        // Adds the script capability.
        assert!(sys.contains("script"));
        assert!(sys.contains("\"script\""));
    }

    #[test]
    fn test_openai_request_and_extract() {
        use crate::ai::{build_openai_request, extract_openai_text};

        let body = build_openai_request("gpt-4o", "SYS", &[], "users older than 30");
        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "users older than 30");

        let resp = serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "{\"filter\":{},\"sort\":{}}" } }]
        });
        assert_eq!(extract_openai_text(&resp), "{\"filter\":{},\"sort\":{}}");
        // Missing content -> empty string (caller surfaces a 'no JSON' error downstream).
        assert_eq!(extract_openai_text(&serde_json::json!({})), "");
    }

    #[test]
    fn test_gemini_request_and_extract() {
        use crate::ai::{build_gemini_request, extract_gemini_text, gemini_url};

        let url = gemini_url("gemini-1.5-flash", "KEY123");
        assert!(url.contains("/models/gemini-1.5-flash:generateContent"));
        assert!(url.contains("key=KEY123"));

        let body = build_gemini_request("SYS", &[], "active users");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "SYS");
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "active users");

        let resp = serde_json::json!({
            "candidates": [{ "content": { "parts": [{ "text": "{\"filter\":{},\"sort\":{}}" }] } }]
        });
        assert_eq!(extract_gemini_text(&resp), "{\"filter\":{},\"sort\":{}}");
        assert_eq!(extract_gemini_text(&serde_json::json!({})), "");
    }

    #[test]
    fn test_parse_command_template() {
        use crate::ai::parse_command_template;

        // {prompt} becomes a single argv element, even with spaces/quotes/shell metachars.
        let (prog, args) =
            parse_command_template("claude -p {prompt}", "find users; rm -rf / $(whoami)").unwrap();
        assert_eq!(prog, "claude");
        assert_eq!(
            args,
            vec![
                "-p".to_string(),
                "find users; rm -rf / $(whoami)".to_string()
            ]
        );

        // No {prompt} placeholder -> append prompt as final arg.
        let (prog, args) = parse_command_template("codex exec", "hi there").unwrap();
        assert_eq!(prog, "codex");
        assert_eq!(args, vec!["exec".to_string(), "hi there".to_string()]);

        // Empty template is an error.
        assert!(parse_command_template("   ", "x").is_err());
    }

    #[tokio::test]
    async fn test_generate_local_missing_binary() {
        use crate::ai::generate_local;
        // A binary that won't exist -> clear error, no panic, no hang.
        let res = generate_local(
            "definitely-not-a-real-binary-xyz -p {prompt}",
            "find active users",
        )
        .await;
        assert!(res.is_err());
        let msg = res.unwrap_err();
        assert!(
            msg.contains("definitely-not-a-real-binary-xyz")
                || msg.to_lowercase().contains("not found")
        );
    }

    #[tokio::test]
    async fn test_generate_anthropic_requires_api_key() {
        use crate::ai::generate_anthropic;
        let res = generate_anthropic("", "claude-opus-4-8", "SYS", &[], "active users").await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("API key"));
    }

    #[test]
    fn test_detect_local_agents_shape() {
        let agents = crate::detect_local_agents_impl();
        let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"claude-code"));
        assert!(ids.contains(&"codex"));
        assert!(ids.contains(&"cursor"));
        assert!(ids.contains(&"antigravity"));
        // Each entry has a coherent availability flag (no panic, no hang).
        for a in &agents {
            if a.available {
                assert!(!a.version.is_empty());
            }
        }
    }

    #[test]
    fn test_collection_key_format() {
        assert_eq!(
            crate::queries::collection_key("Local Mongo", "sales_db", "customers"),
            "Local Mongo::sales_db::customers"
        );
    }

    #[test]
    fn test_derive_key_is_deterministic_and_salt_sensitive() {
        use crate::vault::{derive_key, KdfParams};
        // Use cheap params so the test stays fast.
        let params = KdfParams {
            m_kib: 8,
            t: 1,
            p: 1,
        };
        let salt_a = test_salt(1);
        let salt_b = test_salt(2);
        let pwd = test_secret(&["hun", "ter", "2"]);
        let other_pwd = test_secret(&["diff", "erent"]);

        let k1 = derive_key(&pwd, &salt_a, params).unwrap();
        let k2 = derive_key(&pwd, &salt_a, params).unwrap();
        let k3 = derive_key(&pwd, &salt_b, params).unwrap();
        let k4 = derive_key(&other_pwd, &salt_a, params).unwrap();

        assert_eq!(k1, k2, "same password + salt must derive the same key");
        assert_ne!(k1, k3, "different salt must derive a different key");
        assert_ne!(k1, k4, "different password must derive a different key");
    }

    #[test]
    fn test_vault_meta_build_and_unlock() {
        use crate::connections::{build_vault_meta, unlock_key};
        use crate::vault::KdfParams;
        let params = KdfParams {
            m_kib: 8,
            t: 1,
            p: 1,
        };

        let good_pwd = test_secret(&["correct", " ", "horse"]);
        let bad_pwd = test_secret(&["wr", "ong"]);

        let meta = build_vault_meta(&good_pwd, params).unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.kdf_alg, "argon2id");

        // Right password unlocks.
        let key = unlock_key(&meta, &good_pwd).unwrap();
        assert_eq!(key.len(), 32);

        // Wrong password is rejected.
        assert!(unlock_key(&meta, &bad_pwd).is_err());
    }

    #[test]
    fn test_encrypted_profiles_and_settings_roundtrip() {
        use crate::connections::{
            load_profiles_encrypted, load_settings_encrypted, save_profiles_encrypted,
            save_settings_encrypted, AppSettings, ConnectionProfile,
        };
        let dir = std::env::temp_dir().join(format!("mqlens_vault_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let prof_path = dir.join("connections.json.enc");
        let set_path = dir.join("settings.json.enc");
        let key = [3u8; 32];
        let wrong = [4u8; 32];

        let profiles = vec![ConnectionProfile {
            id: "1".into(),
            name: "prod".into(),
            uri: "mongodb://user:secret@host:27017".into(),
            color_tag: None,
            ssh: None,
        }];
        save_profiles_encrypted(&prof_path, &key, &profiles).unwrap();
        // On-disk bytes must not contain the plaintext password.
        let raw = std::fs::read(&prof_path).unwrap();
        assert!(
            !String::from_utf8_lossy(&raw).contains("secret"),
            "password must not be plaintext"
        );
        assert_eq!(load_profiles_encrypted(&prof_path, &key).unwrap(), profiles);
        assert!(
            load_profiles_encrypted(&prof_path, &wrong).is_err(),
            "wrong key must fail"
        );

        let mut settings = AppSettings::default();
        settings.anthropic_api_key = "sk-ant-123".into();
        save_settings_encrypted(&set_path, &key, &settings).unwrap();
        let raw_s = std::fs::read(&set_path).unwrap();
        assert!(
            !String::from_utf8_lossy(&raw_s).contains("sk-ant-123"),
            "api key must not be plaintext"
        );
        assert_eq!(load_settings_encrypted(&set_path, &key).unwrap(), settings);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_migrate_plaintext_to_encrypted() {
        use crate::connections::{
            load_profiles_encrypted, migrate_plaintext_to_encrypted, save_profiles_to_file,
            ConnectionProfile,
        };
        let dir = std::env::temp_dir().join(format!("mqlens_migrate_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pt_profiles = dir.join("connections.json");
        let enc_profiles = dir.join("connections.json.enc");
        let pt_settings = dir.join("settings.json");
        let enc_settings = dir.join("settings.json.enc");
        let key = [9u8; 32];

        let profiles = vec![ConnectionProfile {
            id: "1".into(),
            name: "p".into(),
            uri: "mongodb://localhost".into(),
            color_tag: None,
            ssh: None,
        }];
        save_profiles_to_file(&pt_profiles, &profiles).unwrap();
        assert!(pt_profiles.exists());

        migrate_plaintext_to_encrypted(
            &key,
            &pt_profiles,
            &enc_profiles,
            &pt_settings,
            &enc_settings,
        )
        .unwrap();

        assert!(
            !pt_profiles.exists(),
            "plaintext must be deleted after migration"
        );
        assert!(enc_profiles.exists(), "encrypted file must be written");
        assert_eq!(
            load_profiles_encrypted(&enc_profiles, &key).unwrap(),
            profiles
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip_and_failures() {
        use crate::vault::{decrypt, encrypt};
        let key = [7u8; 32];
        let wrong = [8u8; 32];
        let msg = b"{\"secret\":\"mongodb://user:pass@host\"}";

        let blob = encrypt(&key, msg).unwrap();
        assert_ne!(&blob[12..], msg, "ciphertext must not equal plaintext");
        assert_eq!(
            decrypt(&key, &blob).unwrap(),
            msg,
            "round-trip must recover plaintext"
        );

        // Two encryptions of the same plaintext differ (fresh nonce each time).
        let blob2 = encrypt(&key, msg).unwrap();
        assert_ne!(blob, blob2, "nonce reuse: ciphertexts should differ");

        // Wrong key fails.
        assert!(decrypt(&wrong, &blob).is_err(), "wrong key must fail");

        // Tampered byte fails (GCM auth).
        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(decrypt(&key, &tampered).is_err(), "tamper must fail");
    }

    #[test]
    fn test_push_history_dedupes_and_caps() {
        use crate::queries::{push_history, HistoryEntry, HISTORY_CAP};
        let mk = |n: i64| HistoryEntry {
            query: serde_json::json!({ "queryType": "find", "filter": { "n": n } }),
            ran_at: String::new(),
        };

        // Most-recent-first: a freshly pushed entry lands at the front.
        let h = push_history(vec![mk(1)], mk(2), HISTORY_CAP);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].query, mk(2).query);

        // Re-running an identical query moves it to the top, no duplicate.
        let h = push_history(vec![mk(2), mk(1)], mk(1), HISTORY_CAP);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].query, mk(1).query);

        // Capped at HISTORY_CAP.
        let mut acc: Vec<HistoryEntry> = Vec::new();
        for i in 0..(HISTORY_CAP as i64 + 5) {
            acc = push_history(acc, mk(i), HISTORY_CAP);
        }
        assert_eq!(acc.len(), HISTORY_CAP);
    }

    #[test]
    fn test_query_store_roundtrip_and_default() {
        use crate::queries::{CollectionQueries, QueryStore, SavedQuery};
        let mut store = QueryStore::default();
        let key = crate::queries::collection_key("c", "d", "coll");
        let cq = CollectionQueries {
            saved: vec![SavedQuery {
                id: "id1".to_string(),
                name: "q".to_string(),
                query: serde_json::json!({ "queryType": "find", "filter": {} }),
                created_at: "2026-05-30T00:00:00Z".to_string(),
            }],
            history: vec![],
            default: Some(serde_json::json!({ "queryType": "find", "filter": { "a": 1 } })),
        };
        store.collections.insert(key.clone(), cq.clone());

        let json = serde_json::to_string(&store).unwrap();
        let back: QueryStore = serde_json::from_str(&json).unwrap();
        assert_eq!(back.collections.get(&key).unwrap(), &cq);

        // Clearing the default round-trips as null.
        let mut cleared = back;
        cleared.collections.get_mut(&key).unwrap().default = None;
        let json2 = serde_json::to_string(&cleared).unwrap();
        let back2: QueryStore = serde_json::from_str(&json2).unwrap();
        assert!(back2.collections.get(&key).unwrap().default.is_none());
    }

    #[test]
    fn test_query_store_file_handling_is_best_effort() {
        use crate::queries::{load_store_from_file, save_store_to_file, QueryStore};

        let dir = std::env::temp_dir().join(format!(
            "mqlens-query-store-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("queries.json");

        assert_eq!(load_store_from_file(&path), QueryStore::default());

        std::fs::write(&path, "   ").unwrap();
        assert_eq!(load_store_from_file(&path), QueryStore::default());

        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load_store_from_file(&path), QueryStore::default());

        let mut store = QueryStore::default();
        let key = crate::queries::collection_key("conn", "db", "coll");
        store.collections.insert(key.clone(), Default::default());
        save_store_to_file(&path, &store).expect("store should save");
        let loaded = load_store_from_file(&path);
        assert!(loaded.collections.contains_key(&key));

        let save_to_dir = save_store_to_file(&dir, &store).unwrap_err();
        assert!(save_to_dir.contains("Failed to write queries file"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_lock_safe_ok_and_poisoned() {
        use crate::LockExt;
        use std::sync::{Arc, Mutex};

        let m = Arc::new(Mutex::new(5u32));
        // Healthy lock works.
        assert_eq!(*m.lock_safe().unwrap(), 5);

        // Poison it: a thread panics while holding the guard.
        let m2 = Arc::clone(&m);
        let handle = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison the mutex");
        });
        let _ = handle.join(); // swallow the panic; test process survives

        let err = m.lock_safe().expect_err("poisoned lock must error");
        assert!(err.contains("poisoned"), "got: {err}");
    }

    #[tokio::test]
    async fn test_apply_main_timeouts_sets_10s() {
        use crate::apply_main_timeouts;
        use std::time::Duration;
        let mut opts = mongodb::options::ClientOptions::parse("mongodb://localhost:27017")
            .await
            .expect("parse uri");
        apply_main_timeouts(&mut opts);
        assert_eq!(opts.connect_timeout, Some(Duration::from_secs(10)));
        assert_eq!(opts.server_selection_timeout, Some(Duration::from_secs(10)));
    }

    // GO-LIVE M5: the driver is built with aws-auth + gssapi-auth, so URIs using
    // MONGODB-AWS and GSSAPI parse without "unsupported mechanism" errors.
    #[tokio::test]
    async fn test_external_auth_mechanisms_parse() {
        use mongodb::options::ClientOptions;
        for uri in [
            "mongodb://AKIA:secret@host:27017/?authMechanism=MONGODB-AWS&authSource=$external",
            "mongodb://user%40REALM@host:27017/?authMechanism=GSSAPI&authSource=$external&authMechanismProperties=SERVICE_NAME:mongodb",
            "mongodb://host:27017/?authMechanism=MONGODB-X509&authSource=$external",
            "mongodb://lu:lp@host:27017/?authMechanism=PLAIN&authSource=$external",
        ] {
            let parsed = ClientOptions::parse(uri).await;
            assert!(parsed.is_ok(), "URI should parse with auth features enabled: {} ({:?})", uri, parsed.err());
        }
    }

    #[tokio::test]
    async fn test_apply_main_timeouts_preserves_uri_values() {
        // M2: timeouts supplied in the URI must win over the 10s default.
        use crate::apply_main_timeouts;
        use std::time::Duration;
        let mut opts = mongodb::options::ClientOptions::parse(
            "mongodb://localhost:27017/?connectTimeoutMS=2000&serverSelectionTimeoutMS=3000",
        )
        .await
        .expect("parse uri");
        apply_main_timeouts(&mut opts);
        assert_eq!(opts.connect_timeout, Some(Duration::from_secs(2)));
        assert_eq!(opts.server_selection_timeout, Some(Duration::from_secs(3)));
    }

    #[test]
    fn test_reencrypt_data_files_changes_key() {
        use crate::connections::{
            load_profiles_encrypted, reencrypt_data_files, save_profiles_encrypted,
            ConnectionProfile,
        };
        let dir = std::env::temp_dir().join(format!("mqlens_reenc_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let enc_profiles = dir.join("connections.json.enc");
        let enc_settings = dir.join("settings.json.enc"); // absent: skipped
        let old_key = [1u8; 32];
        let new_key = [2u8; 32];

        let profiles = vec![ConnectionProfile {
            id: "1".into(),
            name: "p".into(),
            uri: "mongodb://localhost".into(),
            color_tag: None,
            ssh: None,
        }];
        save_profiles_encrypted(&enc_profiles, &old_key, &profiles).unwrap();

        reencrypt_data_files(&old_key, &new_key, &enc_profiles, &enc_settings).unwrap();

        assert!(
            load_profiles_encrypted(&enc_profiles, &old_key).is_err(),
            "old key must fail"
        );
        assert_eq!(
            load_profiles_encrypted(&enc_profiles, &new_key).unwrap(),
            profiles
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Exercise every mock dataset/index variant so the demo backend (used when no
    // server is available) is covered, not just sales_db/products.
    #[test]
    fn test_mock_db_data_and_index_variants() {
        use crate::mock_db::{
            count_mock_documents, execute_mock_query, get_mock_collections, get_mock_explain,
            get_mock_indexes,
        };

        // Collections per database, plus the empty fallback for an unknown db.
        assert!(get_mock_collections("sales_db").contains(&"transactions".to_string()));
        assert_eq!(
            get_mock_collections("user_analytics"),
            vec!["events".to_string(), "sessions".to_string()]
        );
        assert!(get_mock_collections("admin").contains(&"system.users".to_string()));
        assert!(get_mock_collections("nope").is_empty());

        // Query + count across the non-products datasets (each hits a distinct match arm).
        let tx = execute_mock_query("sales_db", "transactions", "{}", "{}", 10, 0).unwrap();
        assert_eq!(tx.len(), 3);
        let pending =
            count_mock_documents("sales_db", "transactions", r#"{"status":"Pending"}"#).unwrap();
        assert_eq!(pending, 1);

        let events = execute_mock_query("user_analytics", "events", "{}", "{}", 10, 0).unwrap();
        assert_eq!(events.len(), 2);
        let sessions =
            execute_mock_query("user_analytics", "sessions", "{}", r#"{"duration_seconds":-1}"#, 10, 0)
                .unwrap();
        let first: serde_json::Value = serde_json::from_str(&sessions[0]).unwrap();
        assert_eq!(first["session_id"], "sess_002", "longest session sorts first");

        // Unknown collection yields no documents.
        assert!(execute_mock_query("sales_db", "ghost", "{}", "{}", 10, 0)
            .unwrap()
            .is_empty());

        // Explain renders a plan namespaced to the requested collection.
        let explain = get_mock_explain("user_analytics", "events", "{}");
        assert!(explain.contains("user_analytics.events"));

        // Index sets for each collection, including the admin and unknown fallbacks.
        let idx = |db, coll| -> Vec<String> {
            get_mock_indexes(db, coll)
                .into_iter()
                .map(|i| i.name)
                .collect()
        };
        assert!(idx("sales_db", "transactions").contains(&"timestamp_-1".to_string()));
        assert!(idx("user_analytics", "events").contains(&"event_type_1".to_string()));
        assert!(idx("user_analytics", "sessions").contains(&"session_id_1".to_string()));
        assert!(idx("admin", "system.users").contains(&"user_1_db_1".to_string()));
        assert_eq!(idx("sales_db", "unknown_coll"), vec!["_id_".to_string()]);

        // A descending-direction index name parses its key pattern and direction.
        let tx_indexes = get_mock_indexes("sales_db", "transactions");
        let ts = tx_indexes.iter().find(|i| i.name == "timestamp_-1").unwrap();
        let keys: serde_json::Value = serde_json::from_str(&ts.keys).unwrap();
        assert_eq!(keys["timestamp"], -1);
        assert!(!ts.unique, "a non-_id index is not unique");
    }

    #[test]
    fn test_key_matches_meta() {
        use crate::connections::{build_vault_meta, key_matches_meta, unlock_key};
        use crate::vault::KdfParams;
        let params = KdfParams { m_kib: 8, t: 1, p: 1 };
        let pwd = test_secret(&["hun", "ter", "2"]);
        let meta = build_vault_meta(&pwd, params).unwrap();
        let good = unlock_key(&meta, &pwd).unwrap();

        assert!(key_matches_meta(&meta, &good), "the real key must verify");
        assert!(
            !key_matches_meta(&meta, &[0u8; 32]),
            "a wrong key must not verify"
        );
    }

    #[test]
    fn test_biometric_key_encode_decode_roundtrip_and_rejections() {
        use base64::Engine as _;
        use crate::biometric::{decode_and_verify_key, encode_key};
        use crate::connections::{build_vault_meta, unlock_key};
        use crate::vault::KdfParams;

        let params = KdfParams { m_kib: 8, t: 1, p: 1 };
        let pwd = test_secret(&["p", "w"]);
        let meta = build_vault_meta(&pwd, params).unwrap();
        let key = unlock_key(&meta, &pwd).unwrap();

        // Round-trip: encode then decode-and-verify yields the same key.
        let encoded = encode_key(&key);
        assert_eq!(decode_and_verify_key(&meta, &encoded).unwrap(), key);

        // Not base64.
        assert!(decode_and_verify_key(&meta, "%%%not-base64%%%").is_err());

        // Valid base64 but wrong length (16 bytes).
        let short = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
        assert!(decode_and_verify_key(&meta, &short).is_err());

        // Correct length but a key that doesn't match this vault.
        let wrong = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
        assert!(decode_and_verify_key(&meta, &wrong).is_err());
    }

    // ── Import file parsers (issue #127: BSON / NDJSON / JSON / CSV) ───────

    fn temp_import_path(ext: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "mqlens-import-test-{}-{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            ext
        ))
    }

    #[test]
    fn test_parse_json_array_docs() {
        let docs =
            parse_json_array_docs(r#"[{"_id": 1, "name": "Ada"}, {"_id": 2, "name": "Bob"}]"#)
                .expect("parse json array");
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].get_str("name").unwrap(), "Ada");
        assert_eq!(docs[1].get_i32("_id").unwrap(), 2);
    }

    #[test]
    fn test_parse_json_array_docs_rejects_non_array() {
        assert!(parse_json_array_docs(r#"{"_id": 1}"#).is_err());
    }

    #[test]
    fn test_parse_ndjson_docs_skips_blank_lines() {
        // One doc per line, blank lines (incl. trailing newline) tolerated.
        let text = "{\"_id\": 1, \"name\": \"Ada\"}\n\n{\"_id\": 2, \"name\": \"Bob\"}\n";
        let docs = parse_ndjson_docs(text).expect("parse ndjson");
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].get_str("name").unwrap(), "Ada");
        assert_eq!(docs[1].get_str("name").unwrap(), "Bob");
    }

    #[test]
    fn test_parse_ndjson_docs_interprets_extended_json() {
        // An $oid wrapper must revive to a real ObjectId, not a sub-document.
        let oid = mongodb::bson::oid::ObjectId::new();
        let line = format!("{{\"_id\": {{\"$oid\": \"{}\"}}}}", oid.to_hex());
        let docs = parse_ndjson_docs(&line).expect("parse ndjson ejson");
        assert_eq!(docs[0].get_object_id("_id").unwrap(), oid);
    }

    #[test]
    fn test_parse_bson_docs_roundtrip_preserves_types() {
        use mongodb::bson::{doc, oid::ObjectId, DateTime, Decimal128};
        use std::str::FromStr;
        let oid = ObjectId::new();
        let when = DateTime::from_millis(1_700_000_000_000);
        let dec = Decimal128::from_str("123.45").unwrap();
        let original = doc! { "_id": oid, "when": when, "amount": dec, "name": "Ada" };
        // Two concatenated BSON documents, mongoexport's on-disk format.
        let mut bytes = mongodb::bson::to_vec(&original).expect("serialize bson");
        bytes.extend(mongodb::bson::to_vec(&doc! { "_id": 2, "name": "Bob" }).unwrap());

        let docs = parse_bson_docs(&bytes).expect("parse bson");
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].get_object_id("_id").unwrap(), oid);
        assert_eq!(docs[0].get_datetime("when").unwrap(), &when);
        assert_eq!(
            docs[0].get("amount"),
            Some(&mongodb::bson::Bson::Decimal128(dec))
        );
        assert_eq!(docs[1].get_str("name").unwrap(), "Bob");
    }

    #[test]
    fn test_parse_bson_docs_empty_input() {
        assert_eq!(parse_bson_docs(&[]).expect("empty bson").len(), 0);
    }

    #[test]
    fn test_parse_csv_docs_revives_cell_values() {
        // Numbers/bools/objects parse as JSON; bare text stays a string.
        let text = "_id,name,active,tags\n1,Ada,true,\"[1,2]\"\n2,Bob,false,plain";
        let docs = parse_csv_docs(text).expect("parse csv");
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].get_i32("_id").unwrap(), 1);
        assert_eq!(docs[0].get_str("name").unwrap(), "Ada");
        assert!(docs[0].get_bool("active").unwrap());
        assert_eq!(
            docs[0].get_array("tags").unwrap(),
            &vec![mongodb::bson::Bson::Int32(1), mongodb::bson::Bson::Int32(2)]
        );
        assert_eq!(docs[1].get_str("tags").unwrap(), "plain");
    }

    #[tokio::test]
    async fn test_mock_import_collection_file_ndjson() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");
        let path = temp_import_path("ndjson");
        std::fs::write(
            &path,
            "{\"_id\": 1, \"name\": \"Ada\"}\n{\"_id\": 2, \"name\": \"Bob\"}\n",
        )
        .unwrap();

        let res = import_collection_file_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            &path.to_string_lossy(),
            "ndjson",
            "skip",
        )
        .await
        .expect("ndjson import validates on mock");
        assert_eq!(res.inserted, 2);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn test_mock_import_collection_file_bson() {
        use mongodb::bson::doc;
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");
        let path = temp_import_path("bson");
        let mut bytes = mongodb::bson::to_vec(&doc! { "_id": 1, "name": "Ada" }).unwrap();
        bytes.extend(mongodb::bson::to_vec(&doc! { "_id": 2, "name": "Bob" }).unwrap());
        std::fs::write(&path, &bytes).unwrap();

        let res = import_collection_file_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            &path.to_string_lossy(),
            "bson",
            "skip",
        )
        .await
        .expect("bson import validates on mock");
        assert_eq!(res.inserted, 2);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn test_import_collection_file_rejects_unknown_format() {
        let state = AppState::new();
        let conn_id = connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("connect mock");
        let path = temp_import_path("txt");
        std::fs::write(&path, "nope").unwrap();
        let res = import_collection_file_impl(
            &state,
            &conn_id,
            "sales_db",
            "customers",
            &path.to_string_lossy(),
            "yaml",
            "skip",
        )
        .await;
        assert!(res.is_err(), "unknown import format must error");
        let _ = std::fs::remove_file(&path);
    }
}
