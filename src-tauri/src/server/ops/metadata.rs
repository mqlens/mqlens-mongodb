//! Metadata reads: the deployment's version, databases, collections and
//! indexes.

use crate::server::channel::client;
use crate::server::ejson;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::metadata_service_client::MetadataServiceClient;
use crate::server::pb::mqlens::v1::{
    ListCollectionsRequest, ListDatabasesRequest, ListIndexesRequest, MongoVersionRequest,
};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::{AppState, CollectionInfo, IndexInfo};

pub(crate) async fn mongo_version(state: &AppState, conn: &RemoteConn) -> Result<String, String> {
    routes::require("get_mongodb_version", conn)?;
    let request = MongoVersionRequest {
        connection_id: conn.remote_id.clone(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MetadataServiceClient, channel)
                .mongo_version(request)
                .await
        })
        .await?;
    Ok(response.version)
}

pub(crate) async fn list_databases(
    state: &AppState,
    conn: &RemoteConn,
) -> Result<Vec<String>, String> {
    routes::require("list_databases", conn)?;
    let request = ListDatabasesRequest {
        connection_id: conn.remote_id.clone(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MetadataServiceClient, channel)
                .list_databases(request)
                .await
        })
        .await?;
    Ok(response.databases)
}

pub(crate) async fn list_collections(
    state: &AppState,
    conn: &RemoteConn,
    db: &str,
) -> Result<Vec<CollectionInfo>, String> {
    routes::require("list_collections", conn)?;
    let request = ListCollectionsRequest {
        connection_id: conn.remote_id.clone(),
        database: db.to_string(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MetadataServiceClient, channel)
                .list_collections(request)
                .await
        })
        .await?;
    Ok(response
        .collections
        .into_iter()
        .map(|c| CollectionInfo {
            name: c.name,
            // A server that could not tell says nothing, as local mode's
            // names-only fallback does.
            collection_type: if c.r#type.is_empty() {
                crate::db::metadata::UNKNOWN_COLLECTION_TYPE.to_string()
            } else {
                c.r#type
            },
        })
        .collect())
}

pub(crate) async fn list_indexes(
    state: &AppState,
    conn: &RemoteConn,
    db: &str,
    collection: &str,
) -> Result<Vec<IndexInfo>, String> {
    routes::require("list_indexes", conn)?;
    let request = ListIndexesRequest {
        connection_id: conn.remote_id.clone(),
        database: db.to_string(),
        collection: collection.to_string(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MetadataServiceClient, channel)
                .list_indexes(request)
                .await
        })
        .await?;
    response
        .indexes
        .into_iter()
        .map(|index| {
            // Written as local mode writes the driver's key document, straight
            // from the document so field order holds.
            let keys = ejson::doc_from_wire(&index.keys_json)?;
            Ok(IndexInfo {
                name: index.name,
                keys: serde_json::to_string(&keys).unwrap_or_else(|_| "{}".to_string()),
                unique: index.unique,
                sparse: index.sparse,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::db::metadata::{list_collections_impl, list_databases_impl, list_indexes_impl};
    use crate::db::version::get_mongodb_version_impl;
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use mongodb::bson::doc;

    // Another window points the account at another user and signs that one in.
    // A connection made through the old identity must not run through the new
    // one's session.
    #[tokio::test]
    async fn a_connection_refuses_an_account_repointed_since() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        crate::server::accounts::update(&env.path, &crate::server::fake::KEY, |all| {
            all[0].email = "dba@acme.test".to_string();
            Ok(())
        })
        .unwrap();

        let err = list_databases_impl(&state, &id).await.unwrap_err();

        assert!(err.contains("Reconnect"), "{err}");
    }

    #[tokio::test]
    async fn the_version_comes_from_the_server() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert_eq!(
            get_mongodb_version_impl(&state, &id).await.unwrap(),
            "8.0.4"
        );
    }

    #[tokio::test]
    async fn databases_are_listed_through_the_server() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert_eq!(
            list_databases_impl(&state, &id).await.unwrap(),
            ["admin", "orders"]
        );
    }

    // Types as local mode names them; one the server could not tell is
    // "unknown", as local mode reports a server that would not say.
    #[tokio::test]
    async fn collections_keep_their_types() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let listed: Vec<(String, String)> = list_collections_impl(&state, &id, "orders")
            .await
            .unwrap()
            .into_iter()
            .map(|c| (c.name, c.collection_type))
            .collect();
        let expected: Vec<(String, String)> = [
            ("customers", "collection"),
            ("recent", "view"),
            ("metrics", "timeseries"),
            ("legacy", crate::db::metadata::UNKNOWN_COLLECTION_TYPE),
        ]
        .iter()
        .map(|(n, t)| (n.to_string(), t.to_string()))
        .collect();
        assert_eq!(listed, expected);
    }

    // Local mode writes an index's key pattern with serde_json from the
    // driver's document; the server sends canonical Extended JSON. They must
    // read the same, field order included.
    #[tokio::test]
    async fn index_keys_read_as_local_mode_writes_them() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let indexes = list_indexes_impl(&state, &id, "orders", "customers")
            .await
            .unwrap();

        let keys: Vec<&str> = indexes.iter().map(|i| i.keys.as_str()).collect();
        assert_eq!(
            keys,
            [
                serde_json::to_string(&doc! { "_id": 1 }).unwrap().as_str(),
                serde_json::to_string(&doc! { "z": 1, "a": -1 })
                    .unwrap()
                    .as_str(),
                serde_json::to_string(&doc! { "loc": "2dsphere" })
                    .unwrap()
                    .as_str(),
            ]
        );
        assert_eq!(indexes[1].name, "z_1_a_-1");
        assert!(indexes[1].unique && indexes[1].sparse);
        assert!(!indexes[0].unique && !indexes[0].sparse);
    }

    // A server too old to serve a command says so, rather than failing in a
    // way the user cannot act on.
    #[tokio::test]
    async fn a_server_that_does_not_offer_the_procedure_is_named() {
        let env = Env::new().await;
        env.fake
            .with(|s| s.procedures.retain(|p| !p.ends_with("/ListIndexes")));
        let (state, id) = connected(&env).await;

        let err = list_indexes_impl(&state, &id, "orders", "customers")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(
            err.contains("does not offer /mqlens.v1.MetadataService/ListIndexes"),
            "{err}"
        );
    }
}
