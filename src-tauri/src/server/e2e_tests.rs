//! End-to-end checks of server mode against a real MQLens Server: every op
//! class runs once through the server and once locally against the same
//! MongoDB, and the two must answer alike.
//!
//! Opt-in, like `integration_tests`: they no-op unless `MQLENS_TEST_SERVER_URL`
//! is set. Once it is, the variables below must be set too, or the run fails
//! naming the missing one.
//!
//! - `MQLENS_TEST_SERVER_URL`, `MQLENS_TEST_SERVER_TENANT`,
//!   `MQLENS_TEST_SERVER_EMAIL`, `MQLENS_TEST_SERVER_PASSWORD`: an owner
//!   account on the server (its `MQLENS_BOOTSTRAP_*` account will do).
//! - `MQLENS_TEST_MONGO_URI`: the MongoDB this app connects to locally.
//! - `MQLENS_TEST_SERVER_MONGO_URI`: the same MongoDB as the server reaches
//!   it, when that differs (a server in a container); defaults to the above.
//! - `MQLENS_TEST_SERVER_SHELL=1`: also run the shell check, which needs
//!   mongosh on the server's host.
//!
//! Each test makes its own server connection and database, and removes both.

#[cfg(test)]
mod e2e {
    use crate::server::accounts::{self, ServerAccountInput};
    use crate::server::channel::client;
    use crate::server::commands::{server_connect_impl, sign_in_impl, token_store};
    use crate::server::fake::{write_vault_meta, KEY};
    use crate::server::pb::mqlens::v1::admin_service_client::AdminServiceClient;
    use crate::server::pb::mqlens::v1::{
        CreateConnectionRequest, DeleteConnectionRequest, GrantConnectionRequest,
    };
    use crate::server::session::AccountSession;
    use crate::{
        analyze_schema_impl, connect_db_impl, count_documents_impl, create_collection_impl,
        delete_gridfs_file_impl, delete_many_impl, download_gridfs_file_impl, drop_collection_impl,
        execute_aggregate_impl, execute_mql_query_impl, insert_document_impl,
        list_collections_impl, list_databases_impl, list_gridfs_files_impl, list_indexes_impl,
        run_mongosh_command_impl, start_collection_export_impl, start_mongosh_session_impl,
        stop_mongosh_session_impl, update_document_impl, upload_gridfs_file_impl, AppState,
    };
    use mongodb::bson::{doc, Document};
    use std::sync::Arc;

    fn var(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.trim().is_empty())
    }

    /// A variable the run needs once `MQLENS_TEST_SERVER_URL` has opted in: a
    /// missing one fails the run instead of skipping it unseen.
    fn required(name: &str) -> String {
        var(name).unwrap_or_else(|| panic!("MQLENS_TEST_SERVER_URL is set, so {name} must be too"))
    }

    /// One test's world: a local connection and a server connection to the
    /// same MongoDB, and a database of its own on it.
    struct World {
        state: AppState,
        local: String,
        remote: String,
        db: String,
        session: Arc<AccountSession>,
        remote_id: String,
        _dir: tempfile::TempDir,
    }

    impl World {
        async fn new() -> Option<World> {
            let url = var("MQLENS_TEST_SERVER_URL")?;
            let mongo = required("MQLENS_TEST_MONGO_URI");
            let server_mongo = var("MQLENS_TEST_SERVER_MONGO_URI").unwrap_or_else(|| mongo.clone());
            let state = AppState::new();
            *state.vault_key.lock().unwrap() = Some(KEY);
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(accounts::ACCOUNTS_FILE_NAME);
            write_vault_meta(&path, &KEY);
            let (account, _) = accounts::save_account(
                &path,
                &KEY,
                ServerAccountInput {
                    id: None,
                    name: "E2E".to_string(),
                    url,
                    tenant: required("MQLENS_TEST_SERVER_TENANT"),
                    email: required("MQLENS_TEST_SERVER_EMAIL"),
                    allow_insecure_http: false,
                    extra_ca_pem: None,
                },
            )
            .unwrap();
            sign_in_impl(
                &state,
                &path,
                &account.id,
                required("MQLENS_TEST_SERVER_PASSWORD"),
            )
            .await
            .expect("sign in to MQLENS_TEST_SERVER_URL");
            let account = accounts::find(&path, &KEY, &account.id).unwrap();
            let session = state
                .server
                .session(&account, token_store(&state, &path))
                .await
                .unwrap();

            // A connection of the test's own, granted to owners, as an admin
            // would set one up for a team.
            let remote_id = session
                .call(
                    CreateConnectionRequest {
                        name: format!("e2e-{}", uuid::Uuid::new_v4().simple()),
                        deployment_kind: "standalone".to_string(),
                        tags: Vec::new(),
                        uri: server_mongo,
                    },
                    |channel, request| async move {
                        client!(AdminServiceClient, channel)
                            .create_connection(request)
                            .await
                    },
                )
                .await
                .expect("create the server connection")
                .id;
            session
                .call(
                    GrantConnectionRequest {
                        connection_id: remote_id.clone(),
                        principal_type: "role".to_string(),
                        principal_id: "owner".to_string(),
                    },
                    |channel, request| async move {
                        client!(AdminServiceClient, channel)
                            .grant_connection(request)
                            .await
                    },
                )
                .await
                .expect("grant the server connection");

            let remote = server_connect_impl(&state, &path, &account.id, &remote_id)
                .await
                .expect("connect through the server")
                .id;
            let local = connect_db_impl(&state, &mongo, None)
                .await
                .expect("connect to MQLENS_TEST_MONGO_URI");
            Some(World {
                state,
                local,
                remote,
                db: format!("mqlens_e2e_{}", uuid::Uuid::new_v4().simple()),
                session,
                remote_id,
                _dir: dir,
            })
        }

        fn client(&self) -> mongodb::Client {
            self.state
                .connections
                .lock()
                .unwrap()
                .get(&self.local)
                .cloned()
                .unwrap()
        }

        async fn seed(&self, collection: &str, docs: Vec<Document>) {
            self.client()
                .database(&self.db)
                .collection::<Document>(collection)
                .insert_many(docs)
                .await
                .unwrap();
        }

        /// Runs `f` on the local connection, then on the server one.
        async fn both<T, F, Fut>(&self, f: F) -> (T, T)
        where
            F: Fn(String) -> Fut,
            Fut: std::future::Future<Output = T>,
        {
            (f(self.local.clone()).await, f(self.remote.clone()).await)
        }

        async fn finish(self) {
            let _ = self.client().database(&self.db).drop().await;
            let id = self.remote_id.clone();
            let _ = self
                .session
                .call(
                    DeleteConnectionRequest { id },
                    |channel, request| async move {
                        client!(AdminServiceClient, channel)
                            .delete_connection(request)
                            .await
                    },
                )
                .await;
        }
    }

    fn people() -> Vec<Document> {
        vec![
            doc! { "_id": 1, "name": "Ada", "tier": "gold", "score": 9.5, "tags": ["a", "b"] },
            doc! { "_id": 2, "name": "Bo", "tier": "silver", "nested": { "x": 1_i64 } },
            doc! { "_id": 3, "name": "Cy", "tier": "gold", "at": mongodb::bson::DateTime::from_millis(1_700_000_000_000) },
        ]
    }

    async fn finished(state: &AppState, task_id: &str) -> crate::TaskInfo {
        for _ in 0..1200 {
            let task = state.tasks.lock().unwrap().get(task_id).cloned().unwrap();
            if task.status != "running" {
                return task;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("task {task_id} did not finish");
    }

    // Reads: listing, find, count, aggregate, indexes and schema read alike.
    #[tokio::test]
    async fn reads_match_local_mode() {
        let Some(w) = World::new().await else { return };
        w.seed("people", people()).await;
        let db = w.db.as_str();
        let st = &w.state;

        let (_, remote_dbs) = w
            .both(|id| async move { list_databases_impl(st, &id).await })
            .await;
        assert!(remote_dbs.unwrap().iter().any(|d| d == db));
        let (local, remote) = w
            .both(|id| async move { list_collections_impl(st, &id, &db).await })
            .await;
        let names = |r: Result<Vec<crate::CollectionInfo>, String>| {
            r.unwrap().into_iter().map(|c| c.name).collect::<Vec<_>>()
        };
        assert_eq!(names(local), names(remote));
        let (local, remote) = w
            .both(|id| async move {
                execute_mql_query_impl(
                    st,
                    &id,
                    &db,
                    "people",
                    r#"{"tier":"gold"}"#,
                    r#"{"_id":1}"#,
                    "",
                    100,
                    0,
                )
                .await
            })
            .await;
        assert_eq!(local.unwrap(), remote.unwrap());
        let (local, remote) = w
            .both(|id| async move {
                count_documents_impl(st, &id, &db, "people", r#"{"tier":"gold"}"#).await
            })
            .await;
        assert_eq!(local.unwrap(), remote.unwrap());
        let pipeline = r#"[{"$group":{"_id":"$tier","n":{"$sum":1}}},{"$sort":{"_id":1}}]"#;
        let (local, remote) = w
            .both(|id| async move {
                execute_aggregate_impl(st, &id, &db, "people", pipeline, false).await
            })
            .await;
        assert_eq!(local.unwrap(), remote.unwrap());
        let (local, remote) = w
            .both(|id| async move { list_indexes_impl(st, &id, &db, "people").await })
            .await;
        assert_eq!(
            serde_json::to_value(local.unwrap()).unwrap(),
            serde_json::to_value(remote.unwrap()).unwrap()
        );
        let (local, remote) = w
            .both(|id| async move { analyze_schema_impl(st, &id, &db, "people", 100).await })
            .await;
        assert_eq!(local.unwrap(), remote.unwrap());

        w.finish().await;
    }

    // A stored sub-document whose keys look like a type wrapper reads back as
    // stored, sibling fields and all: documents travel as raw BSON.
    #[tokio::test]
    async fn a_wrapper_shaped_document_reads_back_as_stored() {
        let Some(w) = World::new().await else { return };
        w.seed(
            "odd",
            vec![doc! { "_id": 1, "money": { "$numberLong": "7", "other": 1 } }],
        )
        .await;

        let found = execute_mql_query_impl(&w.state, &w.remote, &w.db, "odd", "{}", "", "", 10, 0)
            .await
            .unwrap();

        assert_eq!(
            found,
            [r#"{"_id":1,"money":{"$numberLong":"7","other":1}}"#]
        );
        w.finish().await;
    }

    // Writes through the server land where local mode reads them.
    #[tokio::test]
    async fn writes_through_the_server_are_what_local_mode_reads() {
        let Some(w) = World::new().await else { return };
        w.seed("people", people()).await;
        let (st, db) = (&w.state, w.db.as_str());

        insert_document_impl(
            st,
            &w.remote,
            db,
            "people",
            r#"{"_id":4,"name":"Di","tier":"bronze"}"#,
        )
        .await
        .unwrap();
        let modified = update_document_impl(
            st,
            &w.remote,
            db,
            "people",
            r#"{"_id":4}"#,
            r#"{"_id":4,"name":"Di","tier":"bronze"}"#,
            r#"{"_id":4,"name":"Di","tier":"gold"}"#,
            Some("{}"),
        )
        .await
        .unwrap();
        assert_eq!(modified, 1);
        let read = |id: String| async move {
            execute_mql_query_impl(st, &id, db, "people", "{}", r#"{"_id":1}"#, "", 100, 0).await
        };
        let (local, remote) = w.both(read).await;
        let local = local.unwrap();
        assert_eq!(local, remote.unwrap());
        assert!(local.iter().any(|d| d.contains("Di") && d.contains("gold")));

        delete_many_impl(st, &w.remote, db, "people", r#"{"tier":"gold"}"#, true)
            .await
            .unwrap();
        let (local, remote) = w
            .both(|id| async move { count_documents_impl(st, &id, db, "people", "{}").await })
            .await;
        assert_eq!((local.unwrap(), remote.unwrap()), (1, 1));

        w.finish().await;
    }

    // DDL through the server shows in local mode's listing, and goes again.
    #[tokio::test]
    async fn ddl_through_the_server_is_what_local_mode_lists() {
        let Some(w) = World::new().await else { return };
        let (st, db) = (&w.state, w.db.as_str());

        create_collection_impl(st, &w.remote, db, "made_remotely")
            .await
            .unwrap();
        let listed = list_collections_impl(st, &w.local, db).await.unwrap();
        assert!(listed.iter().any(|c| c.name == "made_remotely"));
        drop_collection_impl(st, &w.remote, db, "made_remotely", true)
            .await
            .unwrap();
        let listed = list_collections_impl(st, &w.local, db).await.unwrap();
        assert!(!listed.iter().any(|c| c.name == "made_remotely"));

        w.finish().await;
    }

    // A file stored through the server lists as local mode lists it and comes
    // back byte for byte.
    #[tokio::test]
    async fn gridfs_through_the_server_matches_local_mode() {
        let Some(w) = World::new().await else { return };
        let (st, db) = (&w.state, w.db.as_str());
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("report.txt");
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&source, &bytes).unwrap();

        upload_gridfs_file_impl(
            st,
            &w.remote,
            db,
            "fs",
            source.to_str().unwrap(),
            None,
            Some(r#"{"owner":"e2e"}"#),
            None,
            None,
        )
        .await
        .unwrap();
        let (local, remote) = w
            .both(|id| async move { list_gridfs_files_impl(st, &id, db, "fs").await })
            .await;
        let local = local.unwrap();
        assert_eq!(local, remote.unwrap());
        let files: serde_json::Value = serde_json::from_str(&local).unwrap();
        let file_id = files[0]["id"].as_str().unwrap().to_string();

        let target = dir.path().join("back.txt");
        download_gridfs_file_impl(
            st,
            &w.remote,
            db,
            "fs",
            &file_id,
            target.to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        delete_gridfs_file_impl(st, &w.remote, db, "fs", &file_id)
            .await
            .unwrap();
        assert_eq!(
            list_gridfs_files_impl(st, &w.local, db, "fs")
                .await
                .unwrap(),
            "[]"
        );

        w.finish().await;
    }

    // An export through the server writes the very file local mode writes.
    #[tokio::test]
    async fn exports_through_the_server_are_byte_identical() {
        let Some(w) = World::new().await else { return };
        w.seed("people", people()).await;
        let (st, db) = (&w.state, w.db.as_str());
        let dir = tempfile::tempdir().unwrap();

        for format in ["json", "ndjson", "csv", "bson"] {
            let mut written = Vec::new();
            for (side, id) in [("local", &w.local), ("remote", &w.remote)] {
                let path = dir.path().join(format!("{side}.{format}"));
                let task = start_collection_export_impl(
                    st,
                    id,
                    db,
                    "people",
                    format,
                    path.to_str().unwrap(),
                    None,
                )
                .await
                .unwrap();
                let task = finished(st, &task.id).await;
                assert_eq!(
                    task.status, "completed",
                    "{side} {format}: {:?}",
                    task.error
                );
                written.push(std::fs::read(&path).unwrap());
            }
            assert_eq!(written[0], written[1], "{format}");
        }

        w.finish().await;
    }

    // Admin-class reads, which need no mongosh: deployment users list as local
    // mode lists them, and current operations come back.
    #[tokio::test]
    async fn admin_operations_match_local_mode() {
        let Some(w) = World::new().await else { return };
        let (st, db) = (&w.state, w.db.as_str());
        let mongo_db = w.client().database(db);
        mongo_db
            .run_command(doc! { "createUser": "e2e_user", "pwd": "e2e-test-only", "roles": [] })
            .await
            .unwrap();

        let (local, remote) = w
            .both(|id| async move { crate::list_users_impl(st, &id, Some(db)).await })
            .await;
        let local = local.unwrap();
        assert_eq!(local, remote.unwrap());
        assert!(local.iter().any(|u| u.user == "e2e_user"), "{local:?}");
        crate::monitoring::current_ops_impl(st, &w.remote)
            .await
            .unwrap();

        let _ = mongo_db
            .run_command(doc! { "dropAllUsersFromDatabase": 1 })
            .await;
        w.finish().await;
    }

    // The shell runs on the server's mongosh, in the tab's database.
    #[tokio::test]
    async fn the_shell_runs_on_the_server() {
        if var("MQLENS_TEST_SERVER_SHELL").as_deref() != Some("1") {
            return;
        }
        let Some(w) = World::new().await else { return };
        let st = &w.state;

        let info = start_mongosh_session_impl(st, &w.remote, "", &w.db, "", "")
            .await
            .map_err(|e| e.to_string())
            .unwrap_or_else(|e| panic!("start the server shell: {e}"));
        let out = run_mongosh_command_impl(st, &info.session_id, "db.getName()")
            .await
            .map_err(|e| e.to_string())
            .unwrap_or_else(|e| panic!("run on the server shell: {e}"));
        assert!(
            out.stdout
                .iter()
                .any(|line| line.trim_end().ends_with(&w.db)),
            "{:?}",
            out.stdout
        );
        stop_mongosh_session_impl(st, &info.session_id)
            .await
            .unwrap();

        w.finish().await;
    }
}
