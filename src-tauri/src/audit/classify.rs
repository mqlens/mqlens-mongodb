//! Map Tauri command / op names to [`OpClass`] for audit level gating (#272).

use super::level::OpClass;

/// Every op name this module classifies as a read, i.e. the activity levels B
/// and C advertise. `audit_records_every_classified_read` asserts each one has
/// a real recorder call site — classifying a read without instrumenting it made
/// level C silently record far less than "every database operation".
///
/// `find` is deliberately absent: it is an alias of `execute_mql_query`, not a
/// command of its own.
pub const CLASSIFIED_READ_OPS: &[&str] = &[
    "execute_mql_query",
    "count_documents",
    "explain_mql_query",
    "explain_aggregate_query",
    "list_databases",
    "list_collections",
    "list_indexes",
    "execute_aggregate_read",
    "db_stats",
    "coll_stats",
    "index_stats",
    "server_status",
    "current_ops",
    "repl_set_status",
    "get_profiling_status",
    "read_profile",
    "list_users",
    "list_roles",
    "analyze_schema",
];

/// Classify a registered command (or logical op name) for audit level gating.
///
/// Unknown names default to [`OpClass::Write`] so new mutating commands are
/// never silently skipped at level A.
pub fn classify_op(op: &str) -> OpClass {
    match op {
        "run_mongosh_command" | "mongosh" => OpClass::Shell,

        "execute_mql_query"
        | "find"
        | "count_documents"
        | "explain_mql_query"
        | "explain_aggregate_query"
        | "list_databases"
        | "list_collections"
        | "list_indexes"
        | "execute_aggregate_read" => OpClass::ReadHigh,

        "db_stats"
        | "coll_stats"
        | "index_stats"
        | "server_status"
        | "current_ops"
        | "repl_set_status"
        | "get_profiling_status"
        | "read_profile"
        | "list_users"
        | "list_roles"
        | "analyze_schema" => OpClass::ReadOther,

        _ => OpClass::Write,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agents_write_request_is_classed_as_a_write() {
        // `confirm_write` records the request under this op and relies on the
        // fall-through: a write asked for is a write attempt, and Write is the
        // class that survives the strictest level worth recording at. If the
        // default ever became something quieter, refusals would stop appearing.
        assert_eq!(classify_op("agent_write_request"), OpClass::Write);
    }

    #[test]
    fn writes_and_shell() {
        assert_eq!(classify_op("delete_many"), OpClass::Write);
        assert_eq!(classify_op("drop_collection"), OpClass::Write);
        assert_eq!(classify_op("drop_database"), OpClass::Write);
        assert_eq!(classify_op("insert_document"), OpClass::Write);
        assert_eq!(classify_op("run_mongosh_command"), OpClass::Shell);
        assert_eq!(classify_op("mongosh"), OpClass::Shell);
    }

    #[test]
    fn finds_are_read_high() {
        assert_eq!(classify_op("execute_mql_query"), OpClass::ReadHigh);
        assert_eq!(classify_op("find"), OpClass::ReadHigh);
        assert_eq!(classify_op("count_documents"), OpClass::ReadHigh);
    }

    #[test]
    fn stats_are_read_other() {
        assert_eq!(classify_op("db_stats"), OpClass::ReadOther);
        assert_eq!(classify_op("server_status"), OpClass::ReadOther);
    }

    /// Source of every module that owns a read entry point, so the coverage
    /// test below sees the actual recorder call sites.
    const AUDITED_READ_SOURCES: &[(&str, &str)] = &[
        ("db/query.rs", include_str!("../db/query.rs")),
        ("db/metadata.rs", include_str!("../db/metadata.rs")),
        ("db/aggregate.rs", include_str!("../db/aggregate.rs")),
        ("db/stats.rs", include_str!("../db/stats.rs")),
        ("db/users.rs", include_str!("../db/users.rs")),
        ("db/schema.rs", include_str!("../db/schema.rs")),
        ("monitoring.rs", include_str!("../monitoring.rs")),
    ];

    #[test]
    fn every_classified_read_op_is_actually_recorded() {
        let missing: Vec<&str> = CLASSIFIED_READ_OPS
            .iter()
            .copied()
            .filter(|op| {
                let needle = format!("\"{op}\",");
                !AUDITED_READ_SOURCES
                    .iter()
                    .any(|(_, src)| src.contains(&needle))
            })
            .collect();
        assert!(
            missing.is_empty(),
            "op(s) classified as a read but never passed to a recorder, so levels \
             B/C would not log them: {missing:?}"
        );
    }

    #[test]
    fn classified_read_ops_all_classify_as_reads() {
        for op in CLASSIFIED_READ_OPS {
            assert!(
                matches!(classify_op(op), OpClass::ReadHigh | OpClass::ReadOther),
                "{op} is listed as a read but classify_op says otherwise"
            );
        }
    }

    #[test]
    fn unknown_defaults_to_write() {
        assert_eq!(classify_op("brand_new_mutating_op"), OpClass::Write);
    }
}
