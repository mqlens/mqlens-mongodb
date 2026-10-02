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
            adapter: false,
        },
    },
    CommandRoute {
        command: "list_databases",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/ListDatabases"],
            class: OpClass::Read,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "list_collections",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/ListCollections"],
            class: OpClass::Read,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "list_indexes",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MetadataService/ListIndexes"],
            class: OpClass::Read,
            features: &[],
            adapter: false,
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
            adapter: false,
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
            adapter: false,
        },
    },
    CommandRoute {
        command: "analyze_schema",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DataService/Aggregate"],
            class: OpClass::Read,
            features: &[RAW_BSON],
            adapter: false,
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
            adapter: false,
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
            adapter: false,
        },
    },
    CommandRoute {
        command: "coll_stats",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.StatsService/CollStats"],
            class: OpClass::Read,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "index_stats",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.StatsService/IndexStats"],
            class: OpClass::Read,
            features: &[],
            adapter: false,
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
            adapter: false,
        },
    },
    CommandRoute {
        command: "repl_set_status",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/ReplSetStatus"],
            class: OpClass::Read,
            features: &[],
            adapter: false,
        },
    },
    CommandRoute {
        command: "get_profiling_status",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.MonitoringService/GetProfilingStatus"],
            class: OpClass::Read,
            features: &[],
            adapter: false,
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
            adapter: false,
        },
    },
    CommandRoute {
        command: "list_roles",
        serve: Serve::Rpc {
            procedures: &["/mqlens.v1.DeploymentUserService/ListRoles"],
            class: OpClass::Admin,
            features: &[],
            adapter: false,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

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
