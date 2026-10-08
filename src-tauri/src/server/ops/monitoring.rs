//! Monitoring: server status, replica set health and profiling status, and
//! for admins the operations in progress and the profiler, curated by the
//! server into the same figures local mode shows.

use crate::monitoring::{
    cap_current_ops, CacheStats, Connections, CurrentOp, Memory, Network, OpCounters, OpId,
    ProfileEntry, ProfilingStatus, ReplSetMember, ReplSetStatus, ServerStatus, MAX_CMD_CHARS,
};
use crate::server::channel::client;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::monitoring_service_client::MonitoringServiceClient;
use crate::server::pb::mqlens::v1::{
    CurrentOpsRequest, GetProfilingStatusRequest, KillOpRequest, ReadProfileRequest,
    ReplSetStatusRequest, ServerStatusRequest, SetProfilingLevelRequest,
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

/// A command as local mode prints it: the document's own display, cut to the
/// same length. The server sends relaxed Extended JSON, already cut; a command
/// cut short cannot be read back, and is shown as it came.
fn command_text(json: &str) -> String {
    match crate::server::ejson::doc_from_wire(json) {
        Ok(doc) => {
            let text = mongodb::bson::Bson::Document(doc).to_string();
            if text.chars().count() <= MAX_CMD_CHARS {
                text
            } else {
                format!("{}…", text.chars().take(MAX_CMD_CHARS).collect::<String>())
            }
        }
        Err(_) => json.to_string(),
    }
}

/// The operations in progress, as local mode lists them.
pub(crate) async fn current_ops(
    state: &AppState,
    conn: &RemoteConn,
) -> Result<Vec<CurrentOp>, String> {
    routes::require("current_ops", conn)?;
    let request = CurrentOpsRequest {
        connection_id: conn.remote_id.clone(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MonitoringServiceClient, channel)
                .current_ops(request)
                .await
        })
        .await?;
    let ops = response
        .ops
        .into_iter()
        .map(|op| CurrentOp {
            opid: match op.opid.parse::<i64>() {
                Ok(n) => OpId::Num(n),
                Err(_) => OpId::Str(op.opid),
            },
            op: op.op,
            ns: op.ns,
            secs_running: op.secs_running,
            client: op.client,
            desc: op.desc,
            command: command_text(&op.command),
        })
        .collect();
    Ok(cap_current_ops(ops))
}

pub(crate) async fn kill_op(
    state: &AppState,
    conn: &RemoteConn,
    opid: &OpId,
) -> Result<(), String> {
    routes::require("kill_op", conn)?;
    let request = KillOpRequest {
        connection_id: conn.remote_id.clone(),
        opid: opid.to_string(),
    };
    session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MonitoringServiceClient, channel)
                .kill_op(request)
                .await
        })
        .await?;
    Ok(())
}

/// Sets the profiler and reports the level it now has.
pub(crate) async fn set_profiling_level(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    level: i32,
    slow_ms: i32,
) -> Result<ProfilingStatus, String> {
    routes::require("set_profiling_level", conn)?;
    let request = SetProfilingLevelRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        level,
        slow_ms,
    };
    let status = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MonitoringServiceClient, channel)
                .set_profiling_level(request)
                .await
        })
        .await?;
    Ok(ProfilingStatus {
        level: status.level,
        slow_ms: status.slow_ms,
    })
}

/// The newest profiled operations, at most as many as local mode reads.
pub(crate) async fn read_profile(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    limit: i64,
) -> Result<Vec<ProfileEntry>, String> {
    routes::require("read_profile", conn)?;
    let request = ReadProfileRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        limit: limit.clamp(1, 500),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(MonitoringServiceClient, channel)
                .read_profile(request)
                .await
        })
        .await?;
    Ok(response
        .entries
        .into_iter()
        .map(|e| ProfileEntry {
            op: e.op,
            ns: e.ns,
            millis: e.millis,
            ts_ms: e.ts_ms,
            plan_summary: e.plan_summary,
            command: command_text(&e.command),
        })
        .collect())
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

    use crate::monitoring::{
        current_ops_impl, kill_op_impl, read_profile_impl, set_profiling_level_impl, OpId,
    };
    use crate::server::fake::FakeAdmin;
    use crate::server::pb::mqlens::v1::{CurrentOp as PbCurrentOp, ProfileEntry as PbProfileEntry};
    use mongodb::bson::{doc, Bson};

    async fn with_admin() -> (Env, crate::AppState, String) {
        let env = Env::new().await;
        env.fake
            .with(|s| s.connections[0].op_classes.push("admin".to_string()));
        let (state, id) = connected(&env).await;
        (env, state, id)
    }

    fn op(opid: &str, secs: i64, command: &str) -> PbCurrentOp {
        PbCurrentOp {
            opid: opid.to_string(),
            op: "query".to_string(),
            ns: "orders.customers".to_string(),
            secs_running: secs,
            client: "10.0.0.5:51544".to_string(),
            desc: "conn9".to_string(),
            command: command.to_string(),
        }
    }

    // Operations read as local mode shows them: longest-running first, a
    // number id as a number and a sharded one as its string, the command
    // printed as local mode prints a document (kept as sent when the server
    // cut it short).
    #[tokio::test]
    async fn current_operations_read_as_local_mode_shows_them() {
        let (env, state, id) = with_admin().await;
        env.fake.with(|s| {
            s.current_ops = vec![
                op("12345", 3, r#"{"find":"orders","filter":{"n":{"$gt":5}}}"#),
                op("shard01:77", 9, r#"{"find":"big","filter":{"note":"…"#),
            ]
        });

        let ops = current_ops_impl(&state, &id).await.unwrap();

        assert_eq!(ops[0].opid, OpId::Str("shard01:77".to_string()));
        assert_eq!(ops[0].command, r#"{"find":"big","filter":{"note":"…"#);
        assert_eq!(ops[1].opid, OpId::Num(12345));
        assert_eq!(
            ops[1].command,
            Bson::Document(doc! { "find": "orders", "filter": { "n": { "$gt": 5 } } }).to_string()
        );
        assert_eq!(
            (ops[1].secs_running, ops[1].client.as_str()),
            (3, "10.0.0.5:51544")
        );
    }

    // An operation is killed by the id the server reported, number or string.
    #[tokio::test]
    async fn an_operation_is_killed_by_its_id() {
        let (env, state, id) = with_admin().await;

        kill_op_impl(&state, &id, OpId::Num(12345)).await.unwrap();
        kill_op_impl(&state, &id, OpId::Str("shard01:77".to_string()))
            .await
            .unwrap();

        let sent: Vec<String> = env.fake.with(|s| {
            s.admin_calls
                .iter()
                .filter_map(|c| match c {
                    FakeAdmin::KillOp(k) => Some(k.opid.clone()),
                    _ => None,
                })
                .collect()
        });
        assert_eq!(sent, ["12345", "shard01:77"]);
    }

    // The profiler is switched as asked and reports the level it now has; the
    // profile is read at the limit local mode allows, its commands printed as
    // local mode prints them.
    #[tokio::test]
    async fn the_profiler_is_set_and_read_on_the_server() {
        let (env, state, id) = with_admin().await;
        env.fake.with(|s| {
            s.profile = vec![PbProfileEntry {
                op: "query".to_string(),
                ns: "orders.customers".to_string(),
                millis: 142,
                ts_ms: 1_749_427_200_000,
                plan_summary: "COLLSCAN".to_string(),
                command: r#"{"find":"customers","filter":{"region":"EU"}}"#.to_string(),
            }]
        });

        let status = set_profiling_level_impl(&state, &id, "orders", 1, 50)
            .await
            .unwrap();
        let entries = read_profile_impl(&state, &id, "orders", 1000)
            .await
            .unwrap();

        assert_eq!(
            status,
            ProfilingStatus {
                level: 1,
                slow_ms: 50
            }
        );
        assert_eq!(entries[0].millis, 142);
        assert_eq!(
            entries[0].command,
            Bson::Document(doc! { "find": "customers", "filter": { "region": "EU" } }).to_string()
        );
        match env.fake.with(|s| s.admin_calls.clone()).as_slice() {
            [FakeAdmin::SetProfilingLevel(set), FakeAdmin::ReadProfile(read)] => {
                assert_eq!(
                    (set.database.as_str(), set.level, set.slow_ms),
                    ("orders", 1, 50)
                );
                assert_eq!(read.limit, 500);
            }
            other => panic!("{other:?}"),
        }
    }

    // Without the admin role, or on a read-only connection, nothing is asked.
    #[tokio::test]
    async fn admin_monitoring_needs_the_admin_role_and_a_writable_connection() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let err = current_ops_impl(&state, &id).await.unwrap_err();
        assert!(err.contains("does not allow admin operations"), "{err}");

        let (env, state, id) = with_admin().await;
        crate::set_connection_meta_impl(
            &state,
            &id,
            "server:a:c1",
            "Orders",
            false,
            crate::connections::ConnectionMode::ReadOnly,
        )
        .unwrap();
        assert!(kill_op_impl(&state, &id, OpId::Num(1)).await.is_err());
        assert!(env.fake.with(|s| s.admin_calls.is_empty()));
    }
}
