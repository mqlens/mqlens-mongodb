//! Document writes and index changes on a server connection. Each reports
//! what local mode reports for the same write.

use crate::server::channel::client;
use crate::server::ejson;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::metadata_service_client::MetadataServiceClient;
use crate::server::pb::mqlens::v1::write_service_client::WriteServiceClient;
use crate::server::pb::mqlens::v1::{
    CreateIndexRequest, DeleteDocumentRequest, DeleteManyRequest, DropIndexRequest,
    InsertDocumentRequest, ReplaceDocumentRequest, UpdateDocumentRequest, UpdateManyRequest,
};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::AppState;
use mongodb::bson::{Bson, Document};

fn count(n: i64) -> Result<u64, String> {
    u64::try_from(n).map_err(|_| "MQLens Server reported a negative count".to_string())
}

/// Inserts `document`; the new id as local mode reports it, in relaxed
/// Extended JSON.
pub(crate) async fn insert(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    document: &Document,
) -> Result<String, String> {
    routes::require("insert_document", conn)?;
    let request = InsertDocumentRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        document_json: ejson::doc_to_wire(document),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(WriteServiceClient, channel)
                .insert_document(request)
                .await
        })
        .await?;
    let id: serde_json::Value = serde_json::from_str(&response.inserted_id_json)
        .map_err(|e| format!("MQLens Server reported an unreadable id: {e}"))?;
    let id =
        Bson::try_from(id).map_err(|e| format!("MQLens Server reported an unreadable id: {e}"))?;
    Ok(id.into_relaxed_extjson().to_string())
}

/// Applies `update` to the document `filter` matches; how many changed.
pub(crate) async fn update_one(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    filter: &Document,
    update: &Document,
) -> Result<u64, String> {
    routes::require("update_document", conn)?;
    let request = UpdateDocumentRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        filter_json: ejson::doc_to_wire(filter),
        update_json: ejson::doc_to_wire(update),
    };
    let result = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(WriteServiceClient, channel)
                .update_document(request)
                .await
        })
        .await?;
    count(result.modified_count)
}

/// Replaces the document `filter` matches; how many changed.
pub(crate) async fn replace_one(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    filter: &Document,
    replacement: &Document,
) -> Result<u64, String> {
    routes::require("update_document", conn)?;
    let request = ReplaceDocumentRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        filter_json: ejson::doc_to_wire(filter),
        replacement_json: ejson::doc_to_wire(replacement),
    };
    let result = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(WriteServiceClient, channel)
                .replace_document(request)
                .await
        })
        .await?;
    count(result.modified_count)
}

/// Deletes the document `filter` matches; how many went.
pub(crate) async fn delete_one(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    filter: &Document,
) -> Result<u64, String> {
    routes::require("delete_document", conn)?;
    let request = DeleteDocumentRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        filter_json: ejson::doc_to_wire(filter),
    };
    let result = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(WriteServiceClient, channel)
                .delete_document(request)
                .await
        })
        .await?;
    count(result.deleted_count)
}

/// Applies `update` to every document `filter` matches; how many changed.
pub(crate) async fn update_many(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    filter: &Document,
    update: &Document,
) -> Result<u64, String> {
    routes::require("update_many", conn)?;
    let request = UpdateManyRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        filter_json: ejson::doc_to_wire(filter),
        update_json: ejson::doc_to_wire(update),
    };
    let result = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(WriteServiceClient, channel)
                .update_many(request)
                .await
        })
        .await?;
    count(result.modified_count)
}

/// Deletes every document `filter` matches; how many went.
pub(crate) async fn delete_many(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    filter: &Document,
) -> Result<u64, String> {
    routes::require("delete_many", conn)?;
    let request = DeleteManyRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        filter_json: ejson::doc_to_wire(filter),
    };
    let result = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(WriteServiceClient, channel)
                .delete_many(request)
                .await
        })
        .await?;
    count(result.deleted_count)
}

/// An index on `keys` named `name`.
pub(crate) struct NewIndex<'a> {
    pub name: &'a str,
    pub keys: &'a Document,
    pub unique: bool,
    pub sparse: bool,
}

pub(crate) async fn create_index(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    index: NewIndex<'_>,
) -> Result<(), String> {
    routes::require("create_index", conn)?;
    let request = CreateIndexRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        keys_json: ejson::doc_to_wire(index.keys),
        unique: index.unique,
        sparse: index.sparse,
        name: index.name.to_string(),
    };
    session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MetadataServiceClient, channel)
                .create_index(request)
                .await
        })
        .await?;
    Ok(())
}

pub(crate) async fn drop_index(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
    name: &str,
) -> Result<(), String> {
    routes::require("delete_index", conn)?;
    let request = DropIndexRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
        name: name.to_string(),
    };
    session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MetadataServiceClient, channel)
                .drop_index(request)
                .await
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::documents::{
        delete_document_impl, delete_many_impl, insert_document_impl, update_document_impl,
        update_many_impl,
    };
    use crate::db::metadata::{create_index_impl, delete_index_impl};
    use crate::server::ejson;
    use crate::server::fake::{Env, FakeWrite};
    use crate::server::ops::connected;
    use mongodb::bson::doc;

    fn writes(env: &Env) -> Vec<FakeWrite> {
        env.fake.with(|s| s.writes.clone())
    }

    // An insert sends the document as local mode parses it, and reports the
    // new id as local mode does: relaxed Extended JSON.
    #[tokio::test]
    async fn an_insert_reports_the_new_id_as_local_mode_does() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        let inserted = insert_document_impl(&state, &id, "orders", "customers", r#"{"n": 5}"#)
            .await
            .unwrap();

        assert_eq!(inserted, r#"{"$oid":"64b7f0c2a1b2c3d4e5f60718"}"#);
        match writes(&env).as_slice() {
            [FakeWrite::Insert(r)] => {
                assert_eq!(
                    (r.database.as_str(), r.collection.as_str()),
                    ("orders", "customers")
                );
                assert_eq!(
                    ejson::doc_from_wire(&r.document_json).unwrap(),
                    doc! { "n": 5_i32 }
                );
            }
            other => panic!("{other:?}"),
        }
    }

    // An edit sends the field update local mode would make, and falls back to
    // replacing the document where local mode does.
    #[tokio::test]
    async fn an_edit_sends_the_update_local_mode_would_make() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let filter = r#"{"_id": 1}"#;

        let modified = update_document_impl(
            &state,
            &id,
            "orders",
            "customers",
            filter,
            r#"{"_id": 1, "n": 1}"#,
            r#"{"_id": 1, "n": 2}"#,
            Some("{}"),
        )
        .await
        .unwrap();
        assert_eq!(modified, 1);

        // A field named with a dot cannot be set, so the whole document is replaced.
        update_document_impl(
            &state,
            &id,
            "orders",
            "customers",
            filter,
            r#"{"_id": 1, "a.b": 1}"#,
            r#"{"_id": 1, "a.b": 2}"#,
            Some("{}"),
        )
        .await
        .unwrap();

        match writes(&env).as_slice() {
            [FakeWrite::Update(u), FakeWrite::Replace(r)] => {
                assert_eq!(
                    ejson::doc_from_wire(&u.filter_json).unwrap(),
                    doc! { "_id": 1_i32 }
                );
                assert_eq!(
                    ejson::doc_from_wire(&u.update_json).unwrap(),
                    doc! { "$set": { "n": 2_i32 } }
                );
                assert_eq!(
                    ejson::doc_from_wire(&r.replacement_json).unwrap(),
                    doc! { "_id": 1_i32, "a.b": 2_i32 }
                );
            }
            other => panic!("{other:?}"),
        }
    }

    // The bulk writes and deletes report the counts local mode reports.
    #[tokio::test]
    async fn bulk_writes_and_deletes_report_their_counts() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.write_result.modified_count = 7;
            s.write_result.deleted_count = 3;
        });
        let (state, id) = connected(&env).await;
        let f = r#"{"n": {"$gt": 1}}"#;

        assert_eq!(
            update_many_impl(
                &state,
                &id,
                "orders",
                "customers",
                f,
                r#"{"$set": {"x": 1}}"#,
                false
            )
            .await,
            Ok(7)
        );
        assert_eq!(
            delete_many_impl(&state, &id, "orders", "customers", f, false).await,
            Ok(3)
        );
        assert_eq!(
            delete_document_impl(&state, &id, "orders", "customers", r#"{"_id": 1}"#).await,
            Ok(3)
        );

        match writes(&env).as_slice() {
            [FakeWrite::UpdateMany(u), FakeWrite::DeleteMany(d), FakeWrite::Delete(one)] => {
                assert_eq!(
                    ejson::doc_from_wire(&u.update_json).unwrap(),
                    doc! { "$set": { "x": 1_i32 } }
                );
                assert_eq!(
                    ejson::doc_from_wire(&d.filter_json).unwrap(),
                    doc! { "n": { "$gt": 1_i32 } }
                );
                assert_eq!(
                    ejson::doc_from_wire(&one.filter_json).unwrap(),
                    doc! { "_id": 1_i32 }
                );
            }
            other => panic!("{other:?}"),
        }
    }

    // An index is created with the keys local mode parses and its options,
    // and dropped by name.
    #[tokio::test]
    async fn indexes_are_created_and_dropped_on_the_server() {
        let env = Env::new().await;
        env.fake
            .with(|s| s.connections[0].op_classes.push("ddl".to_string()));
        let (state, id) = connected(&env).await;

        create_index_impl(
            &state,
            &id,
            "orders",
            "customers",
            "email_1",
            r#"{"email": 1}"#,
            true,
            false,
        )
        .await
        .unwrap();
        delete_index_impl(&state, &id, "orders", "customers", "email_1")
            .await
            .unwrap();

        match writes(&env).as_slice() {
            [FakeWrite::CreateIndex(c), FakeWrite::DropIndex(d)] => {
                assert_eq!(c.name, "email_1");
                assert_eq!(
                    ejson::doc_from_wire(&c.keys_json).unwrap(),
                    doc! { "email": 1_i64 }
                );
                assert!(c.unique && !c.sparse);
                assert_eq!(d.name, "email_1");
            }
            other => panic!("{other:?}"),
        }
    }

    // What local mode refuses is refused before the server hears of it: a
    // read-only connection, an update without operators, invalid JSON.
    #[tokio::test]
    async fn local_refusals_come_before_any_request() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert!(update_many_impl(
            &state,
            &id,
            "orders",
            "customers",
            "{}",
            r#"{"x": 1}"#,
            false
        )
        .await
        .is_err());
        assert!(
            insert_document_impl(&state, &id, "orders", "customers", "{not json")
                .await
                .is_err()
        );
        crate::set_connection_meta_impl(
            &state,
            &id,
            "server:a:c1",
            "Orders",
            false,
            crate::connections::ConnectionMode::ReadOnly,
        )
        .unwrap();
        assert!(
            insert_document_impl(&state, &id, "orders", "customers", "{}")
                .await
                .is_err()
        );
        assert!(writes(&env).is_empty());
    }

    // A user who may only read is refused by the desktop, naming the role it
    // lacks, before any request.
    #[tokio::test]
    async fn a_read_only_role_cannot_write() {
        let env = Env::new().await;
        env.fake
            .with(|s| s.connections[0].op_classes = vec!["read".to_string()]);
        let (state, id) = connected(&env).await;

        let err = insert_document_impl(&state, &id, "orders", "customers", "{}")
            .await
            .unwrap_err();
        assert!(err.contains("does not allow write operations"), "{err}");
        let err = create_index_impl(
            &state,
            &id,
            "orders",
            "customers",
            "n_1",
            r#"{"n": 1}"#,
            false,
            false,
        )
        .await
        .unwrap_err();
        assert!(err.contains("does not allow ddl operations"), "{err}");
        assert!(writes(&env).is_empty());
    }
}
