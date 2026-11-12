//! Database, collection and index statistics, which the server curates
//! into the same figures local mode shows.

use crate::db::stats::{CollStatsUi, DbStatsUi, IndexStatUi};
use crate::server::channel::client;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::stats_service_client::StatsServiceClient;
use crate::server::pb::mqlens::v1::{CollStatsRequest, DbStatsRequest, IndexStatsRequest};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::AppState;

pub(crate) async fn db_stats(
    state: &AppState,
    conn: &RemoteConn,
    db: &str,
) -> Result<DbStatsUi, String> {
    routes::require("db_stats", conn)?;
    let request = DbStatsRequest {
        connection_id: conn.remote_id.clone(),
        database: db.to_string(),
    };
    let stats = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(StatsServiceClient, channel).db_stats(request).await
        })
        .await?;
    Ok(DbStatsUi {
        collections: stats.collections,
        views: stats.views,
        objects: stats.objects,
        avg_obj_size: stats.avg_obj_size,
        data_size: stats.data_size,
        storage_size: stats.storage_size,
        indexes: stats.indexes,
        total_index_size: stats.total_index_size,
    })
}

pub(crate) async fn coll_stats(
    state: &AppState,
    conn: &RemoteConn,
    db: &str,
    coll: &str,
) -> Result<CollStatsUi, String> {
    routes::require("coll_stats", conn)?;
    let request = CollStatsRequest {
        connection_id: conn.remote_id.clone(),
        database: db.to_string(),
        collection: coll.to_string(),
    };
    let stats = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(StatsServiceClient, channel)
                .coll_stats(request)
                .await
        })
        .await?;
    Ok(CollStatsUi {
        count: stats.count,
        avg_obj_size: stats.avg_obj_size,
        size: stats.size,
        storage_size: stats.storage_size,
        nindexes: stats.nindexes,
        total_index_size: stats.total_index_size,
        capped: stats.capped,
    })
}

pub(crate) async fn index_stats(
    state: &AppState,
    conn: &RemoteConn,
    db: &str,
    coll: &str,
) -> Result<Vec<IndexStatUi>, String> {
    routes::require("index_stats", conn)?;
    let request = IndexStatsRequest {
        connection_id: conn.remote_id.clone(),
        database: db.to_string(),
        collection: coll.to_string(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(StatsServiceClient, channel)
                .index_stats(request)
                .await
        })
        .await?;
    let mut indexes: Vec<IndexStatUi> = response
        .indexes
        .into_iter()
        .map(|index| IndexStatUi {
            name: index.name,
            size_bytes: index.size_bytes,
            ops: index.ops,
            since_ms: index.since_ms,
        })
        .collect();
    // Largest first, as local mode sorts them.
    indexes.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(indexes)
}

#[cfg(test)]
mod tests {
    use crate::db::stats::{
        coll_stats_impl, db_stats_impl, index_stats_impl, CollStatsUi, DbStatsUi, IndexStatUi,
    };
    use crate::server::fake::Env;
    use crate::server::ops::connected;

    #[tokio::test]
    async fn database_stats_carry_every_figure() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert_eq!(
            db_stats_impl(&state, &id, "orders").await.unwrap(),
            DbStatsUi {
                collections: 4,
                views: 1,
                objects: 12_345,
                avg_obj_size: 512.5,
                data_size: 6_327_000,
                storage_size: 8_192_000,
                indexes: 9,
                total_index_size: 1_048_576,
            }
        );
    }

    #[tokio::test]
    async fn collection_stats_carry_every_figure() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert_eq!(
            coll_stats_impl(&state, &id, "orders", "customers")
                .await
                .unwrap(),
            CollStatsUi {
                count: 3_000,
                avg_obj_size: 128.25,
                size: 384_750,
                storage_size: 409_600,
                nindexes: 3,
                total_index_size: 98_304,
                capped: true,
            }
        );
    }

    // Largest first, as local mode sorts them, whatever order the server
    // sends.
    #[tokio::test]
    async fn index_stats_come_largest_first_as_in_local_mode() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let stat = |name: &str, size_bytes, ops, since_ms| IndexStatUi {
            name: name.to_string(),
            size_bytes,
            ops,
            since_ms,
        };
        assert_eq!(
            index_stats_impl(&state, &id, "orders", "customers")
                .await
                .unwrap(),
            vec![
                stat("email_1", 65_536, 900, 1_700_000_100_000),
                stat("created_-1", 16_384, 0, 0),
                stat("_id_", 4_096, 10, 1_700_000_000_000),
            ]
        );
    }
}
