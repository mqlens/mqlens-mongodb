//! Collection and database structure: options and validation rules,
//! collections and views, and whole databases.

use crate::db::ddl::{CollectionValidation, DatabaseRenameResult};
use crate::server::channel::client;
use crate::server::ejson;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::ddl_service_client::DdlServiceClient;
use crate::server::pb::mqlens::v1::{
    CreateCollectionRequest, CreateViewRequest, DropCollectionRequest, DropDatabaseRequest,
    GetCollectionOptionsRequest, RenameCollectionRequest, RenameDatabaseDetailedRequest,
    SetValidatorRequest,
};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::AppState;
use mongodb::bson::{Bson, Document};

pub(crate) async fn get_collection_options(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
) -> Result<CollectionValidation, String> {
    routes::require("get_collection_options", conn)?;
    let request = GetCollectionOptionsRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
    };
    let options = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DdlServiceClient, channel)
                .get_collection_options(request)
                .await
        })
        .await?;
    // Printed as local mode prints the validator document; none is "{}" in
    // both.
    let validator = ejson::doc_from_wire(&options.validator)?;
    Ok(CollectionValidation {
        validator: serde_json::to_string_pretty(&validator)
            .map_err(|e| format!("Failed to serialize validator: {}", e))?,
        validation_level: options.validation_level,
        validation_action: options.validation_action,
    })
}

/// Runs one DDL call after checking the connection may run `command`.
macro_rules! ddl_call {
    ($state:expr, $conn:expr, $command:literal, $request:expr, $method:ident) => {{
        routes::require($command, $conn)?;
        session_for($state, $conn)
            .await?
            .call($request, |channel, request| async move {
                client!(DdlServiceClient, channel).$method(request).await
            })
            .await
    }};
}

pub(crate) async fn create_collection(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
) -> Result<(), String> {
    let request = CreateCollectionRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
    };
    ddl_call!(state, conn, "create_collection", request, create_collection).map(|_| ())
}

/// A view named `view` on `view_on` through `stages`.
pub(crate) async fn create_view(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    view: &str,
    view_on: &str,
    stages: &[Document],
) -> Result<(), String> {
    let request = CreateViewRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        view: view.to_string(),
        view_on: view_on.to_string(),
        pipeline_json: Bson::Array(stages.iter().cloned().map(Bson::Document).collect())
            .into_canonical_extjson()
            .to_string(),
    };
    ddl_call!(state, conn, "create_view", request, create_view).map(|_| ())
}

pub(crate) async fn drop_collection(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
) -> Result<(), String> {
    let request = DropCollectionRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
    };
    ddl_call!(state, conn, "drop_collection", request, drop_collection).map(|_| ())
}

pub(crate) async fn rename_collection(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let request = RenameCollectionRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: from.to_string(),
        new_name: to.to_string(),
    };
    ddl_call!(state, conn, "rename_collection", request, rename_collection).map(|_| ())
}

/// Validation rules, with the level and action local mode accepted ("" leaves
/// one as it is).
pub(crate) struct Validation<'a> {
    pub validator: &'a Document,
    pub level: &'a str,
    pub action: &'a str,
}

pub(crate) async fn set_validator(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    validation: Validation<'_>,
) -> Result<(), String> {
    let request = SetValidatorRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        validator: ejson::doc_to_wire(validation.validator),
        validation_level: validation.level.to_string(),
        validation_action: validation.action.to_string(),
    };
    ddl_call!(state, conn, "set_validator", request, set_validator).map(|_| ())
}

pub(crate) async fn drop_database(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
) -> Result<(), String> {
    let request = DropDatabaseRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
    };
    ddl_call!(state, conn, "drop_database", request, drop_database).map(|_| ())
}

/// Copies `from` to `to`, dropping `from` when asked; what moved, as local
/// mode reports it.
pub(crate) async fn rename_database(
    state: &AppState,
    conn: &RemoteConn,
    from: &str,
    to: &str,
    drop_source: bool,
) -> Result<DatabaseRenameResult, String> {
    let request = RenameDatabaseDetailedRequest {
        connection_id: conn.remote_id.clone(),
        database: from.to_string(),
        new_name: to.to_string(),
        drop_source,
    };
    let moved = ddl_call!(
        state,
        conn,
        "rename_database",
        request,
        rename_database_detailed
    )?;
    let count = |n: i64| {
        u64::try_from(n).map_err(|_| "MQLens Server reported a negative count".to_string())
    };
    Ok(DatabaseRenameResult {
        collections: count(moved.collections)?,
        documents: count(moved.documents)?,
    })
}

#[cfg(test)]
mod tests {
    use crate::db::ddl::{
        create_collection_impl, create_view_impl, drop_collection_impl, drop_database_impl,
        rename_collection_impl, rename_database_impl, set_validator_impl,
    };
    use crate::server::fake::FakeWrite;

    async fn with_ddl() -> (crate::server::fake::Env, crate::AppState, String) {
        let env = crate::server::fake::Env::new().await;
        env.fake
            .with(|s| s.connections[0].op_classes.push("ddl".to_string()));
        let (state, id) = crate::server::ops::connected(&env).await;
        (env, state, id)
    }

    fn ddl_writes(env: &crate::server::fake::Env) -> Vec<FakeWrite> {
        env.fake.with(|s| s.writes.clone())
    }

    // Collections and views are created, renamed and dropped on the server,
    // the view's pipeline as local mode parses it.
    #[tokio::test]
    async fn collections_and_views_change_on_the_server() {
        let (env, state, id) = with_ddl().await;

        create_collection_impl(&state, &id, "orders", "audit")
            .await
            .unwrap();
        create_view_impl(
            &state,
            &id,
            "orders",
            "big",
            "customers",
            r#"[{"$match": {"n": {"$gt": 5}}}]"#,
        )
        .await
        .unwrap();
        rename_collection_impl(&state, &id, "orders", "audit", "audit_old", false)
            .await
            .unwrap();
        drop_collection_impl(&state, &id, "orders", "audit_old", false)
            .await
            .unwrap();

        match ddl_writes(&env).as_slice() {
            [FakeWrite::CreateCollection(c), FakeWrite::CreateView(v), FakeWrite::RenameCollection(r), FakeWrite::DropCollection(d)] =>
            {
                assert_eq!(
                    (c.database.as_str(), c.collection.as_str()),
                    ("orders", "audit")
                );
                assert_eq!((v.view.as_str(), v.view_on.as_str()), ("big", "customers"));
                let sent: serde_json::Value = serde_json::from_str(&v.pipeline_json).unwrap();
                assert_eq!(
                    mongodb::bson::Bson::try_from(sent).unwrap(),
                    mongodb::bson::Bson::Array(vec![mongodb::bson::Bson::Document(
                        mongodb::bson::doc! { "$match": { "n": { "$gt": 5_i64 } } }
                    )])
                );
                assert_eq!(
                    (r.collection.as_str(), r.new_name.as_str()),
                    ("audit", "audit_old")
                );
                assert_eq!(d.collection, "audit_old");
            }
            other => panic!("{other:?}"),
        }
    }

    // Validation rules go with the level and action local mode accepts.
    #[tokio::test]
    async fn validation_rules_are_set_on_the_server() {
        let (env, state, id) = with_ddl().await;

        set_validator_impl(
            &state,
            &id,
            "orders",
            "customers",
            r#"{"n": {"$type": "int"}}"#,
            "moderate",
            "warn",
        )
        .await
        .unwrap();

        match ddl_writes(&env).as_slice() {
            [FakeWrite::SetValidator(v)] => {
                assert_eq!(
                    crate::server::ejson::doc_from_wire(&v.validator).unwrap(),
                    mongodb::bson::doc! { "n": { "$type": "int" } }
                );
                assert_eq!(
                    (v.validation_level.as_str(), v.validation_action.as_str()),
                    ("moderate", "warn")
                );
            }
            other => panic!("{other:?}"),
        }
    }

    // A database is dropped, or renamed reporting what moved, as local mode does.
    #[tokio::test]
    async fn databases_are_dropped_and_renamed_on_the_server() {
        let (env, state, id) = with_ddl().await;

        let moved = rename_database_impl(&state, &id, "orders", "orders_v2", true, false)
            .await
            .unwrap();
        drop_database_impl(&state, &id, "scratch", false)
            .await
            .unwrap();

        assert_eq!((moved.collections, moved.documents), (2, 40));
        match ddl_writes(&env).as_slice() {
            [FakeWrite::RenameDatabase(r), FakeWrite::DropDatabase(d)] => {
                assert_eq!(
                    (r.database.as_str(), r.new_name.as_str(), r.drop_source),
                    ("orders", "orders_v2", true)
                );
                assert_eq!(d.database, "scratch");
            }
            other => panic!("{other:?}"),
        }
    }

    // What local mode refuses goes nowhere: a confirm-destructive connection
    // without confirmation, a rename to the same name, a bad pipeline or level.
    #[tokio::test]
    async fn local_ddl_refusals_come_before_any_request() {
        let (env, state, id) = with_ddl().await;
        assert!(
            rename_collection_impl(&state, &id, "orders", "a", "a", false)
                .await
                .is_err()
        );
        assert!(
            create_view_impl(&state, &id, "orders", "v", "customers", "{not json")
                .await
                .is_err()
        );
        assert!(
            set_validator_impl(&state, &id, "orders", "customers", "{}", "loose", "")
                .await
                .is_err()
        );
        crate::set_connection_meta_impl(
            &state,
            &id,
            "server:a:c1",
            "Orders",
            false,
            crate::connections::ConnectionMode::ConfirmDestructive,
        )
        .unwrap();
        assert!(drop_database_impl(&state, &id, "orders", false)
            .await
            .is_err());
        assert!(ddl_writes(&env).is_empty());
    }

    // A user without the ddl role is told so before any request.
    #[tokio::test]
    async fn a_role_without_ddl_cannot_change_structure() {
        let env = crate::server::fake::Env::new().await;
        let (state, id) = crate::server::ops::connected(&env).await;

        let err = drop_collection_impl(&state, &id, "orders", "customers", true)
            .await
            .unwrap_err();
        assert!(err.contains("does not allow ddl operations"), "{err}");
        assert!(ddl_writes(&env).is_empty());
    }

    use crate::db::ddl::get_collection_options_impl;
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use mongodb::bson::doc;

    // Local mode pretty-prints the validator document the driver reads; the
    // server sends it as relaxed Extended JSON. They must read the same.
    #[tokio::test]
    async fn the_validator_reads_as_local_mode_prints_it() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        let options = get_collection_options_impl(&state, &id, "orders", "customers")
            .await
            .unwrap();

        let validator = doc! {
            "$jsonSchema": { "required": ["email"], "properties": { "age": { "minimum": 0 } } }
        };
        assert_eq!(
            options.validator,
            serde_json::to_string_pretty(&validator).unwrap()
        );
        assert_eq!(options.validation_level, "strict");
        assert_eq!(options.validation_action, "error");
    }

    #[tokio::test]
    async fn no_validator_reads_as_local_mode_shows_none() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.collection_options.validator = "{}".to_string();
            s.collection_options.validation_level = String::new();
            s.collection_options.validation_action = String::new();
        });
        let (state, id) = connected(&env).await;

        let options = get_collection_options_impl(&state, &id, "orders", "customers")
            .await
            .unwrap();

        assert_eq!(options.validator, "{}");
        assert_eq!(options.validation_level, "");
        assert_eq!(options.validation_action, "");
    }
}
