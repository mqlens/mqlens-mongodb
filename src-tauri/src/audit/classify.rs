//! Map Tauri command / op names to [`OpClass`] for audit level gating (#272).

use super::level::OpClass;

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

    #[test]
    fn unknown_defaults_to_write() {
        assert_eq!(classify_op("brand_new_mutating_op"), OpClass::Write);
    }
}
