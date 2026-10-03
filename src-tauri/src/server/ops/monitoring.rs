//! Read-class monitoring: server status, replica set health and profiling
//! status, curated by the server into the same figures local mode shows.

use crate::monitoring::{
    CacheStats, Connections, Memory, Network, OpCounters, ProfilingStatus, ReplSetMember,
    ReplSetStatus, ServerStatus,
};
use crate::server::channel::client;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::monitoring_service_client::MonitoringServiceClient;
use crate::server::pb::mqlens::v1::{
    GetProfilingStatusRequest, ReplSetStatusRequest, ServerStatusRequest,
};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::AppState;

pub(crate) async fn server_status(
    state: &AppState,
    conn: &RemoteConn,
) -> Result<ServerStatus, String> {
    routes::require("server_status", conn)?;
    let request = ServerStatusRequest {
        connection_id: conn.remote_id.clone(),
    };
    let status = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MonitoringServiceClient, channel)
                .server_status(request)
                .await
        })
        .await?;
    let connections = status.connections.unwrap_or_default();
    let opcounters = status.opcounters.unwrap_or_default();
    let memory = status.memory.unwrap_or_default();
    let network = status.network.unwrap_or_default();
    Ok(ServerStatus {
        host: status.host,
        version: status.version,
        uptime_seconds: status.uptime_seconds,
        connections: Connections {
            current: connections.current,
            available: connections.available,
            total_created: connections.total_created,
        },
        opcounters: OpCounters {
            insert: opcounters.insert,
            query: opcounters.query,
            update: opcounters.update,
            delete: opcounters.delete,
            getmore: opcounters.getmore,
            command: opcounters.command,
        },
        memory: Memory {
            resident_mb: memory.resident_mb,
            virtual_mb: memory.virtual_mb,
        },
        network: Network {
            bytes_in: network.bytes_in,
            bytes_out: network.bytes_out,
            num_requests: network.num_requests,
        },
        // Absent when the server reports no WiredTiger cache, as on a mongos.
        cache: status.cache.map(|cache| CacheStats {
            bytes_in_cache: cache.bytes_in_cache,
            max_bytes: cache.max_bytes,
            dirty_bytes: cache.dirty_bytes,
        }),
        repl_set: status.repl_set,
    })
}

pub(crate) async fn repl_set_status(
    state: &AppState,
    conn: &RemoteConn,
) -> Result<ReplSetStatus, String> {
    routes::require("repl_set_status", conn)?;
    let request = ReplSetStatusRequest {
        connection_id: conn.remote_id.clone(),
    };
    let status = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MonitoringServiceClient, channel)
                .repl_set_status(request)
                .await
        })
        .await?;
    Ok(ReplSetStatus {
        is_replica_set: status.is_replica_set,
        cluster_type: status.cluster_type,
        set: status.set,
        my_state_str: status.my_state_str,
        mongo_version: status.mongo_version,
        members: status
            .members
            .into_iter()
            .map(|member| ReplSetMember {
                name: member.name,
                state_str: member.state_str,
                health: member.health,
                self_member: member.self_,
                uptime_secs: member.uptime_secs,
                optime_date_ms: member.optime_date_ms,
                ping_ms: member.ping_ms,
                sync_source: member.sync_source,
                lag_secs: member.lag_secs,
            })
            .collect(),
    })
}

pub(crate) async fn profiling_status(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
) -> Result<ProfilingStatus, String> {
    routes::require("get_profiling_status", conn)?;
    let request = GetProfilingStatusRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
    };
    let status = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MonitoringServiceClient, channel)
                .get_profiling_status(request)
                .await
        })
        .await?;
    Ok(ProfilingStatus {
        level: status.level,
        slow_ms: status.slow_ms,
    })
}

#[cfg(test)]
mod tests {
    use crate::monitoring::{
        profiling_status_impl, repl_set_status_impl, server_status_impl, CacheStats, Connections,
        Memory, Network, OpCounters, ProfilingStatus, ReplSetMember, ReplSetStatus, ServerStatus,
    };
    use crate::server::fake::Env;
    use crate::server::ops::connected;

    #[tokio::test]
    async fn server_status_carries_every_figure() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert_eq!(
            server_status_impl(&state, &id).await.unwrap(),
            ServerStatus {
                host: "db-1.acme.internal:27017".to_string(),
                version: "8.0.4".to_string(),
                uptime_seconds: 86_400.5,
                connections: Connections {
                    current: 12,
                    available: 838_848,
                    total_created: 345,
                },
                opcounters: OpCounters {
                    insert: 1,
                    query: 2,
                    update: 3,
                    delete: 4,
                    getmore: 5,
                    command: 6,
                },
                memory: Memory {
                    resident_mb: 512,
                    virtual_mb: 2_048,
                },
                network: Network {
                    bytes_in: 1_000,
                    bytes_out: 2_000,
                    num_requests: 30,
                },
                cache: Some(CacheStats {
                    bytes_in_cache: 7,
                    max_bytes: 8,
                    dirty_bytes: 9,
                }),
                repl_set: Some("rs0".to_string()),
            }
        );
    }

    // A mongos reports no WiredTiger cache and belongs to no replica set:
    // both stay absent, as local mode leaves them.
    #[tokio::test]
    async fn absent_cache_and_replica_set_stay_absent() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.server_status.cache = None;
            s.server_status.repl_set = None;
        });
        let (state, id) = connected(&env).await;
        let status = server_status_impl(&state, &id).await.unwrap();
        assert_eq!((status.cache, status.repl_set), (None, None));
    }

    #[tokio::test]
    async fn replica_set_status_carries_every_member() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert_eq!(
            repl_set_status_impl(&state, &id).await.unwrap(),
            ReplSetStatus {
                is_replica_set: true,
                cluster_type: "replicaSet".to_string(),
                set: "rs0".to_string(),
                my_state_str: "PRIMARY".to_string(),
                mongo_version: "8.0.4".to_string(),
                members: vec![
                    ReplSetMember {
                        name: "db-1:27017".to_string(),
                        state_str: "PRIMARY".to_string(),
                        health: 1,
                        self_member: true,
                        uptime_secs: 86_400,
                        optime_date_ms: 1_700_000_000_000,
                        ping_ms: None,
                        sync_source: String::new(),
                        lag_secs: None,
                    },
                    ReplSetMember {
                        name: "db-2:27017".to_string(),
                        state_str: "SECONDARY".to_string(),
                        health: 1,
                        self_member: false,
                        uptime_secs: 86_000,
                        optime_date_ms: 1_699_999_999_000,
                        ping_ms: Some(3),
                        sync_source: "db-1:27017".to_string(),
                        lag_secs: Some(1.5),
                    },
                ],
            }
        );
    }

    #[tokio::test]
    async fn profiling_status_comes_from_the_server() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert_eq!(
            profiling_status_impl(&state, &id, "orders").await.unwrap(),
            ProfilingStatus {
                level: 1,
                slow_ms: 250,
            }
        );
    }
}
