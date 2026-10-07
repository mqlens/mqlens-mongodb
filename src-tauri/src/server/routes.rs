//! Which commands that touch a deployment run on MQLens Server, and through
//! what. One row per command: either the server procedures it is served by,
//! with the op class and server features it needs, or the reason it is not
//! served yet.

/// The server's op classes, from least to most powerful.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpClass {
    Read,
    Write,
    Ddl,
    Admin,
}

impl OpClass {
    /// As the server names it in capabilities.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            OpClass::Read => "read",
            OpClass::Write => "write",
            OpClass::Ddl => "ddl",
            OpClass::Admin => "admin",
        }
    }
}

#[derive(Debug)]
pub(crate) enum Serve {
    /// Served through `procedures`, for a user with at least `class` on the
    /// connection, by a server that announces every one of `features`.
    /// `adapter` stays false until the desktop has a server adapter for it.
    Rpc {
        procedures: &'static [&'static str],
        class: OpClass,
        features: &'static [&'static str],
        adapter: bool,
    },
    /// Not served on MQLens Server yet. The command refuses a remote
    /// connection before doing any work.
    Deferred { reason: &'static str },
}

#[derive(Debug)]
pub(crate) struct CommandRoute {
    pub command: &'static str,
    pub serve: Serve,
}

/// Documents travel as raw BSON, so they reach the UI exactly as stored.
const RAW_BSON: &str = "documents.raw_bson";
/// Count estimates when unfiltered, as local mode does.
const COUNT_ESTIMATE: &str = "count.estimate";
/// Explain at the verbosity local mode uses.
const EXPLAIN_VERBOSITY: &str = "explain.verbosity";
/// A GridFS upload keeps its content type and metadata.
const GRIDFS_UPLOAD_OPTIONS: &str = "gridfs.upload_options";
/// Renaming a database reports what it moved, as local mode does.
const RENAME_DATABASE_RESULT: &str = "ddl.rename_database_result";
/// The shell keeps stderr apart from stdout.
const SHELL_STDERR: &str = "shell.stderr";

const TASKS: &str = "Long-running tasks are not available on MQLens Server connections yet";
const DATABASE_TOOLS: &str =
    "The MongoDB Database Tools are not available on MQLens Server connections yet";

pub(crate) const ROUTES: &[CommandRoute] = &[
    // Metadata
    CommandRoute {
        command: "get_mongodb_version",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/MongoVersion"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "list_databases",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/ListDatabases"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "list_collections",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/ListCollections"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "list_indexes",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/ListIndexes"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "create_index",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/CreateIndex"],
            class: OpClass::Ddl,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "delete_index",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/DropIndex"],
            class: OpClass::Ddl,
            features: &[],
            adapter: false,
        },
    },
    // Documents
    CommandRoute {
        command: "execute_mql_query",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Find"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: true,
        },
    },
    CommandRoute {
        command: "count_documents",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Count"],
            class: OpClass::Read,
            features: &[COUNT_ESTIMATE],
            adapter: false,
        },
    },
    CommandRoute {
        command: "explain_mql_query",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Explain"],
            class: OpClass::Read,
            features: &[EXPLAIN_VERBOSITY],
            adapter: false,
        },
    },
    CommandRoute {
        command: "explain_aggregate_query",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Explain"],
            class: OpClass::Read,
            features: &[EXPLAIN_VERBOSITY],
            adapter: false,
        },
    },
    CommandRoute {
        command: "execute_aggregate",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Aggregate"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: true,
        },
    },
    CommandRoute {
        command: "analyze_schema",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Aggregate"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: true,
        },
    },
    CommandRoute {
        command: "insert_document",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.WriteService/InsertDocument"],
            class: OpClass::Write,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "update_document",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.WriteService/UpdateDocument", "/mqlens.v1.WriteService/ReplaceDocument"],
            class: OpClass::Write,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "update_many",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.WriteService/UpdateMany"],
            class: OpClass::Write,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "delete_document",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.WriteService/DeleteDocument"],
            class: OpClass::Write,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "delete_many",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.WriteService/DeleteMany"],
            class: OpClass::Write,
            features: &[],
            adapter: false,
        },
    },
    // Export
    CommandRoute {
        command: "start_collection_export",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Find"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: false,
        },
    },
    CommandRoute {
        command: "start_filtered_export",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Find", "/mqlens.v1.DataService/Aggregate"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: false,
        },
    },
    CommandRoute {
        command: "sample_export_fields",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Aggregate"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: false,
        },
    },
    CommandRoute {
        command: "preview_export",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Find", "/mqlens.v1.DataService/Aggregate"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: false,
        },
    },
    // Collections and databases
    CommandRoute {
        command: "get_collection_options",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DdlService/GetCollectionOptions"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "create_collection",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DdlService/CreateCollection"],
            class: OpClass::Ddl,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "create_view",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DdlService/CreateView"],
            class: OpClass::Ddl,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "drop_collection",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DdlService/DropCollection"],
            class: OpClass::Ddl,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "rename_collection",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DdlService/RenameCollection"],
            class: OpClass::Ddl,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "set_validator",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DdlService/SetValidator"],
            class: OpClass::Ddl,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "drop_database",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DdlService/DropDatabase"],
            class: OpClass::Ddl,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "rename_database",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DdlService/RenameDatabase"],
            class: OpClass::Ddl,
            features: &[RENAME_DATABASE_RESULT],
            adapter: false,
        },
    },
    // Statistics
    CommandRoute {
        command: "db_stats",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.StatsService/DbStats"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "coll_stats",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.StatsService/CollStats"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "index_stats",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.StatsService/IndexStats"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    // GridFS
    CommandRoute {
        command: "list_gridfs_files",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.GridFsService/ListFiles"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: false,
        },
    },
    CommandRoute {
        command: "download_gridfs_file",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.GridFsService/DownloadFile"],
            class: OpClass::Read,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "upload_gridfs_file",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.GridFsService/UploadFile"],
            class: OpClass::Write,
            features: &[GRIDFS_UPLOAD_OPTIONS],
            adapter: false,
        },
    },
    CommandRoute {
        command: "delete_gridfs_file",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.GridFsService/DeleteFile"],
            class: OpClass::Write,
            features: &[],
            adapter: false,
        },
    },
    // Monitoring
    CommandRoute {
        command: "server_status",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/ServerStatus"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "repl_set_status",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/ReplSetStatus"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "get_profiling_status",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/GetProfilingStatus"],
            class: OpClass::Read,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "current_ops",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/CurrentOps"],
            class: OpClass::Admin,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "kill_op",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/KillOp"],
            class: OpClass::Admin,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "read_profile",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/ReadProfile"],
            class: OpClass::Admin,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "set_profiling_level",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/SetProfilingLevel"],
            class: OpClass::Admin,
            features: &[],
            adapter: false,
        },
    },
    // Deployment users
    CommandRoute {
        command: "list_users",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DeploymentUserService/ListUsers"],
            class: OpClass::Admin,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "list_roles",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DeploymentUserService/ListRoles"],
            class: OpClass::Admin,
            features: &[],
            adapter: true,
        },
    },
    CommandRoute {
        command: "create_user",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DeploymentUserService/CreateUser"],
            class: OpClass::Admin,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "update_user",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DeploymentUserService/UpdateUser"],
            class: OpClass::Admin,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "drop_user",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DeploymentUserService/DropUser"],
            class: OpClass::Admin,
            features: &[],
            adapter: false,
        },
    },
    // The MongoDB shell
    CommandRoute {
        command: "start_mongosh_session",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.ShellService/MongoshSession"],
            class: OpClass::Admin,
            features: &[SHELL_STDERR],
            adapter: false,
        },
    },
    CommandRoute {
        command: "run_mongosh_command",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.ShellService/MongoshSession"],
            class: OpClass::Admin,
            features: &[SHELL_STDERR],
            adapter: false,
        },
    },
    CommandRoute {
        command: "run_mongosh_script",
        serve: Serve::Deferred {
            reason: "One-shot mongosh scripts are not available on MQLens Server connections; use the shell",
        },
    },
    // Not served yet
    CommandRoute {
        command: "start_change_stream",
        serve: Serve::Deferred {
            reason: "Change streams are not available on MQLens Server connections yet",
        },
    },
    CommandRoute {
        command: "start_dump_task",
        serve: Serve::Deferred {
            reason: DATABASE_TOOLS,
        },
    },
    CommandRoute {
        command: "start_restore_task",
        serve: Serve::Deferred {
            reason: DATABASE_TOOLS,
        },
    },
    CommandRoute {
        command: "start_import_task",
        serve: Serve::Deferred {
            reason: TASKS,
        },
    },
    CommandRoute {
        command: "preflight_copy",
        serve: Serve::Deferred {
            reason: TASKS,
        },
    },
    CommandRoute {
        command: "start_collection_copy",
        serve: Serve::Deferred {
            reason: TASKS,
        },
    },
    CommandRoute {
        command: "start_database_copy",
        serve: Serve::Deferred {
            reason: TASKS,
        },
    },
    CommandRoute {
        command: "infer_generate_template",
        serve: Serve::Deferred {
            reason: TASKS,
        },
    },
    CommandRoute {
        command: "start_generate_task",
        serve: Serve::Deferred {
            reason: TASKS,
        },
    },
];

/// Whether `route` can run on `conn`: served through an adapter the desktop
/// has, by procedures and features the server announced, for a user with the
/// op class it needs. Deferred commands never can.
pub(crate) fn command_available(route: &CommandRoute, conn: &RemoteConn) -> bool {
    check(route, conn).is_ok()
}

/// Why `route` cannot run on `conn`, if it cannot: in words the user can
/// act on, whether that means waiting for the desktop, a newer server or a
/// different role.
pub(crate) fn check(route: &CommandRoute, conn: &RemoteConn) -> Result<(), String> {
    let (procedures, class, features) = match route.serve {
        Serve::Deferred { reason } => return Err(reason.to_string()),
        Serve::Rpc { adapter: false, .. } => {
            return Err(crate::server::remote::NOT_SERVED.to_string())
        }
        Serve::Rpc {
            procedures,
            class,
            features,
            adapter: true,
        } => (procedures, class, features),
    };
    let has = |list: &[String], item: &str| list.iter().any(|x| x == item);
    if let Some(missing) = procedures.iter().find(|p| !has(&conn.procedures, p)) {
        return Err(format!(
            "This MQLens Server does not offer {missing}; it may need updating"
        ));
    }
    if let Some(missing) = features.iter().find(|f| !has(&conn.features, f)) {
        return Err(format!(
            "This MQLens Server does not support {missing} yet; it may need updating"
        ));
    }
    if !has(&conn.op_classes, class.as_str()) {
        return Err(format!(
            "Your role on this MQLens Server connection does not allow {} operations",
            class.as_str()
        ));
    }
    Ok(())
}

/// `check` for the route of `command`, which must have one.
pub(crate) fn require(command: &str, conn: &RemoteConn) -> Result<(), String> {
    match ROUTES.iter().find(|route| route.command == command) {
        Some(route) => check(route, conn),
        None => Err(crate::server::remote::NOT_SERVED.to_string()),
    }
}

/// The commands `conn` cannot run.
pub(crate) fn blocked_commands(conn: &RemoteConn) -> Vec<&'static str> {
    ROUTES
        .iter()
        .filter(|route| !command_available(route, conn))
        .map(|route| route.command)
        .collect()
}

/// Refuses a deferred command when any of `ids` is a remote connection,
/// with the reason its route gives. Called first thing, before any work.
pub(crate) fn refuse_deferred(
    state: &crate::state::AppState,
    command: &str,
    ids: &[&str],
) -> Result<(), String> {
    for id in ids {
        if state.server.remote(id)?.is_some() {
            let reason = ROUTES
                .iter()
                .find_map(|route| match route.serve {
                    Serve::Deferred { reason } if route.command == command => Some(reason),
                    _ => None,
                })
                .unwrap_or(crate::server::remote::NOT_SERVED);
            return Err(reason.to_string());
        }
    }
    Ok(())
}

use crate::server::remote::RemoteConn;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::collections::{BTreeMap, BTreeSet};

    fn with_remote(id: &str) -> AppState {
        let state = AppState::new();
        state
            .server
            .add_remote(RemoteConn {
                desktop_id: id.to_string(),
                account_id: "account".to_string(),
                accounts_path: std::path::PathBuf::new(),
                account_name: "Acme".to_string(),
                server_url: "https://mqlens.acme.test".to_string(),
                remote_id: format!("srv-{id}"),
                op_classes: vec!["read".to_string()],
                features: Vec::new(),
                procedures: Vec::new(),
            })
            .unwrap();
        state.mocks.lock().unwrap().insert(id.to_string(), false);
        state
    }

    fn conn(op_classes: &[&str], features: &[&str], procedures: &[&str]) -> RemoteConn {
        RemoteConn {
            desktop_id: "r1".to_string(),
            account_id: "account".to_string(),
            accounts_path: std::path::PathBuf::new(),
            account_name: "Acme".to_string(),
            server_url: "https://mqlens.acme.test".to_string(),
            remote_id: "srv-r1".to_string(),
            op_classes: op_classes.iter().map(|s| s.to_string()).collect(),
            features: features.iter().map(|s| s.to_string()).collect(),
            procedures: procedures.iter().map(|s| s.to_string()).collect(),
        }
    }

    // A command runs only when every condition holds; each one alone blocks it.
    #[test]
    fn a_command_is_available_only_with_its_adapter_procedures_features_and_class() {
        let route = CommandRoute {
            command: "update_many",
            serve: Serve::Rpc {
                procedures: &["/mqlens.v1.WriteService/UpdateMany"],
                class: OpClass::Write,
                features: &["writes.thing"],
                adapter: true,
            },
        };
        let all = conn(
            &["read", "write"],
            &["writes.thing"],
            &["/mqlens.v1.WriteService/UpdateMany"],
        );
        assert!(command_available(&route, &all));

        let no_class = conn(
            &["read"],
            &["writes.thing"],
            &["/mqlens.v1.WriteService/UpdateMany"],
        );
        assert!(
            !command_available(&route, &no_class),
            "without the op class"
        );
        let no_feature = conn(
            &["read", "write"],
            &[],
            &["/mqlens.v1.WriteService/UpdateMany"],
        );
        assert!(
            !command_available(&route, &no_feature),
            "without the feature"
        );
        let no_procedure = conn(&["read", "write"], &["writes.thing"], &[]);
        assert!(
            !command_available(&route, &no_procedure),
            "without the procedure"
        );

        let no_adapter = CommandRoute {
            command: "update_many",
            serve: Serve::Rpc {
                procedures: &["/mqlens.v1.WriteService/UpdateMany"],
                class: OpClass::Write,
                features: &["writes.thing"],
                adapter: false,
            },
        };
        assert!(!command_available(&no_adapter, &all), "without an adapter");
        let deferred = CommandRoute {
            command: "start_import_task",
            serve: Serve::Deferred { reason: TASKS },
        };
        assert!(!command_available(&deferred, &all), "a deferred command");
    }

    // Each condition that fails says which, so the user knows whether to ask
    // for a role or for a newer server.
    #[test]
    fn an_unavailable_command_says_why() {
        let route = CommandRoute {
            command: "update_many",
            serve: Serve::Rpc {
                procedures: &["/mqlens.v1.WriteService/UpdateMany"],
                class: OpClass::Write,
                features: &["writes.thing"],
                adapter: true,
            },
        };
        let all = |classes: &[&str], features: &[&str], procedures: &[&str]| {
            check(&route, &conn(classes, features, procedures))
        };
        let procedure = ["/mqlens.v1.WriteService/UpdateMany"];

        assert_eq!(
            all(&["read", "write"], &["writes.thing"], &procedure),
            Ok(())
        );
        let err = all(&["read", "write"], &["writes.thing"], &[]).unwrap_err();
        assert!(
            err.contains("does not offer /mqlens.v1.WriteService/UpdateMany"),
            "{err}"
        );
        let err = all(&["read", "write"], &[], &procedure).unwrap_err();
        assert!(err.contains("does not support writes.thing"), "{err}");
        let err = all(&["read"], &["writes.thing"], &procedure).unwrap_err();
        assert!(err.contains("does not allow write operations"), "{err}");
    }

    // A connection that has everything is blocked exactly where the desktop
    // has no adapter yet, and for deferred commands.
    #[test]
    fn a_capable_connection_is_blocked_only_without_an_adapter() {
        let every_procedure: Vec<&str> = ROUTES
            .iter()
            .flat_map(|route| match route.serve {
                Serve::Rpc { procedures, .. } => procedures.to_vec(),
                Serve::Deferred { .. } => Vec::new(),
            })
            .collect();
        let capable = conn(
            &["read", "write", "ddl", "admin"],
            &[
                RAW_BSON,
                COUNT_ESTIMATE,
                EXPLAIN_VERBOSITY,
                GRIDFS_UPLOAD_OPTIONS,
                RENAME_DATABASE_RESULT,
                SHELL_STDERR,
            ],
            &every_procedure,
        );
        let without_adapter: Vec<&str> = ROUTES
            .iter()
            .filter(|route| !matches!(route.serve, Serve::Rpc { adapter: true, .. }))
            .map(|route| route.command)
            .collect();
        assert_eq!(blocked_commands(&capable), without_adapter);
    }

    #[test]
    fn a_deferred_command_refuses_any_remote_connection_with_its_reason() {
        let state = with_remote("r1");
        assert_eq!(
            refuse_deferred(&state, "start_collection_copy", &["local", "r1"]),
            Err(TASKS.to_string())
        );
        assert_eq!(
            refuse_deferred(&state, "start_change_stream", &["r1"]),
            Err("Change streams are not available on MQLens Server connections yet".to_string())
        );
        assert_eq!(
            refuse_deferred(&state, "start_collection_copy", &["local"]),
            Ok(())
        );
    }

    #[tokio::test]
    async fn deferred_commands_refuse_a_remote_connection_before_any_work() {
        let state = with_remote("r1");
        match crate::db::copy::preflight_copy_impl(&state, "r1", "db", Vec::new(), Vec::new()).await
        {
            Err(e) => assert_eq!(e, TASKS),
            Ok(_) => panic!("preflight_copy ran for a remote connection"),
        }
        let err = crate::db::generate::infer_generate_template_impl(&state, "r1", "db", "c", None)
            .await
            .unwrap_err();
        assert_eq!(err, TASKS);
    }

    // Every deferred command refuses a remote connection itself, by name, so
    // none can reach a driver client, a URI or a background task first.
    #[test]
    fn every_deferred_command_calls_refuse_deferred() {
        fn sources(dir: &std::path::Path, out: &mut String) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    sources(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push_str(
                        &std::fs::read_to_string(&path)
                            .unwrap()
                            .replace("\r\n", "\n"),
                    );
                    out.push('\n');
                }
            }
        }
        let mut all = String::new();
        sources(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut all,
        );
        // A function's text, up to the next item that starts a line.
        let body = |name: &str| -> Option<String> {
            let start = all.find(&format!("fn {name}("))?;
            let rest = &all[start..];
            let end = [
                "\npub async fn ",
                "\npub fn ",
                "\nasync fn ",
                "\nfn ",
                "\n#[tauri::command]",
            ]
            .iter()
            .filter_map(|next| rest[1..].find(next))
            .min()
            .unwrap_or(rest.len() - 1);
            Some(rest[..=end].to_string())
        };
        for route in ROUTES {
            if let Serve::Deferred { .. } = route.serve {
                let name = route.command;
                let code = body(&format!("{name}_impl"))
                    .or_else(|| body(name))
                    .unwrap_or_else(|| panic!("{name}: no function found"));
                assert!(
                    code.contains("refuse_deferred(") && code.contains(&format!("\"{name}\"")),
                    "{name} must call refuse_deferred(state, \"{name}\", ..) first"
                );
            }
        }
    }

    /// Commands bucketed LOCAL that still touch the deployment: a change
    /// stream opens a cursor on it.
    const LOCAL_BUT_DEPLOYMENT: &[&str] = &["start_change_stream"];

    // A new command that touches a deployment must say how server mode treats
    // it, and no command may be described twice.
    #[test]
    fn every_command_that_touches_a_deployment_has_exactly_one_route() {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for route in ROUTES {
            *counts.entry(route.command).or_default() += 1;
        }
        let twice: Vec<_> = counts
            .iter()
            .filter(|(_, n)| **n > 1)
            .map(|(c, _)| *c)
            .collect();
        assert!(twice.is_empty(), "routed more than once: {twice:?}");

        let expected: BTreeSet<&str> = crate::command_coverage::READ_COMMANDS
            .iter()
            .chain(crate::command_coverage::GUARDED_WRITE_COMMANDS)
            .chain(LOCAL_BUT_DEPLOYMENT)
            .copied()
            .collect();
        let routed: BTreeSet<&str> = counts.keys().copied().collect();
        assert_eq!(
            expected.difference(&routed).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "commands with no route"
        );
        assert_eq!(
            routed.difference(&expected).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "routes for commands that touch no deployment"
        );
    }

    // A procedure named here must exist in the vendored contract.
    #[test]
    fn every_procedure_routed_to_is_in_the_contract() {
        let contract = include_str!("pb/mqlens/v1/mqlens.v1.tonic.rs");
        for route in ROUTES {
            if let Serve::Rpc { procedures, .. } = route.serve {
                for procedure in procedures {
                    assert!(
                        contract.contains(&format!("\"{procedure}\"")),
                        "{}: {procedure} is not in the contract",
                        route.command
                    );
                }
            }
        }
    }
}
