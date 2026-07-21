//! Security review #188 fix wave, Fix 3: a structural cross-check that
//! catches an unclassified command the way the ORIGINAL plan's hand-copied
//! coverage list couldn't. `write_guard.rs`'s `non_destructive_cases` /
//! `destructive_cases` tables are hand-maintained lists of the mutating
//! `_impl`s someone remembered to wire up — which is exactly how the two
//! CRITICAL findings in this fix wave (`execute_aggregate`'s $out/$merge and
//! the embedded mongosh shell) escaped the original #188 plan: both are
//! real Tauri commands that mutate data, and neither was on that hand-list.
//!
//! This module parses the ACTUAL `tauri::generate_handler![...]` macro
//! invocation out of `lib.rs`'s source at test time (`include_str!`, not a
//! second hand-copied list) and asserts every command it finds is in
//! EXACTLY ONE of the three buckets below. A new command that nobody
//! classifies fails this test immediately — forcing a human to decide
//! read/guarded/local instead of silently shipping unguarded, which is
//! precisely the class of bug this fix wave is closing.

#![cfg(test)]

use std::collections::HashSet;

/// Commands that only ever READ — either from a live MongoDB connection
/// (list/count/explain/analyze/stats/status-shaped commands, dumps that
/// write only to the local filesystem) or from a local resource that
/// doesn't need a connection-mode check. Never blocked by
/// `read_only`/`confirm_destructive`, and never should be.
const READ_COMMANDS: &[&str] = &[
    "start_dump_task", // mongodump reads the DB, writes only to a local file
    "get_mongodb_version",
    "list_databases",
    "list_collections",
    "list_indexes",
    "db_stats",
    "coll_stats",
    "index_stats",
    "list_gridfs_files",
    "download_gridfs_file",
    "execute_mql_query",
    "count_documents",
    "start_collection_export", // exports read data out, write only to a local file
    "start_filtered_export",
    "sample_export_fields",
    "preview_export",
    "preflight_copy", // dry-run conflict/count check, no write
    "get_collection_options",
    "explain_mql_query",
    "explain_aggregate_query", // explains, never executes a write
    "analyze_schema",
    "infer_generate_template", // samples existing docs to build a template
    "server_status",
    "current_ops",
    "repl_set_status",
    "list_users",
    "list_roles",
    "get_profiling_status",
    "read_profile",
];

/// App-local commands: no live MongoDB connection's data is touched, so no
/// connection-mode check applies. Covers connection lifecycle (before a
/// mode is even known / after it no longer matters), local app state
/// (vault, workspace/window layout, saved queries, settings, connection
/// profiles), local tooling (installers, path detection, resource usage),
/// and pure local computation (formatting already-fetched docs, generating
/// documents from a template with no DB round-trip).
const LOCAL_COMMANDS: &[&str] = &[
    "connect_db",
    "detect_mongo_tools",
    "detect_mongosh_binary",
    "start_tool_install_task",
    "managed_tools_status",
    "browse_dump_folder",
    "preview_dump_command",
    "preview_restore_command",
    "get_resource_usage",
    "generate_mql_query",
    "detect_local_agents",
    "stop_mongosh_session", // kills the local child process, no DB write
    "disconnect_db",
    "set_connection_meta", // renderer-callable with an arbitrary mode — see its own doc comment
    "connection_list",
    "preview_import", // parses a local file for a preview, no DB access
    "format_current_docs",
    "list_export_tasks",
    "clear_finished_export_tasks",
    "cancel_task",
    "preview_generated_documents", // pure template generation, no DB
    "vault_status",
    "vault_initialize",
    "vault_unlock",
    "vault_lock",
    "vault_reset",
    "vault_change_password",
    "mcp_get_status",
    "mcp_set_enabled",
    "mcp_regenerate_token",
    "biometric_status",
    "biometric_enable",
    "biometric_unlock",
    "biometric_disable",
    "load_connection_profiles",
    "save_connection_profile",
    "delete_connection_profile",
    "test_connection_uri", // ephemeral test connection, never tracked in connection_meta
    "load_app_settings",
    "save_app_settings",
    "test_mongosh_path",
    "load_collection_queries",
    "save_query",
    "delete_saved_query",
    "record_history",
    "set_default_query",
    "list_all_saved_queries",
    "workspace_get",
    "workspace_apply",
    "workspace_detach_tab",
    "spawn_saved_windows",
    "focus_window",
    "close_workspace_window",
    "update_check",
    "update_install",
];

/// Commands that can mutate a connection's data and are covered by the
/// write-guard system — either directly (`guard_writable` is the first
/// thing the `_impl` calls) or, for the two commands this fix wave added,
/// by an equivalent mode check that fires before anything mutating can
/// happen:
/// - `execute_aggregate` (Fix 1): guards on `WriteOp::Drop` only when the
///   pipeline carries a `$out`/`$merge` stage — see
///   `db::aggregate::execute_aggregate_impl`'s doc comment.
/// - `start_mongosh_session` (Fix 2): reads `write_guard::connection_mode`
///   directly and refuses `ReadOnly` before a shell is ever spawned — see
///   `start_mongosh_session_impl`'s doc comment.
/// - `run_mongosh_command` is included here too even though it has no guard
///   call of its own: it only ever operates on a session obtained from
///   `start_mongosh_session`, so a `read_only` connection can never produce
///   a session for it to run a command against. Its protection is entirely
///   transitive — see `start_mongosh_session_impl`'s doc comment for the
///   `confirm_destructive` limitation this implies (arbitrary shell input
///   can't be gated per-command).
const GUARDED_WRITE_COMMANDS: &[&str] = &[
    "start_restore_task",
    "start_mongosh_session",
    "run_mongosh_command",
    "create_index",
    "delete_index",
    "delete_document",
    "delete_many",
    "update_many",
    "upload_gridfs_file",
    "delete_gridfs_file",
    "insert_document",
    "start_import_task",
    "update_document",
    "execute_aggregate",
    "start_collection_copy",
    "start_database_copy",
    "create_collection",
    "create_view",
    "drop_collection",
    "rename_collection",
    "set_validator",
    "drop_database",
    "rename_database",
    "start_generate_task",
    "kill_op",
    "create_user",
    "update_user",
    "drop_user",
    "set_profiling_level",
];

/// Parse the command idents out of `lib.rs`'s `tauri::generate_handler![
/// ... ]` invocation. Tauri registers a command under its function's own
/// name (the last path segment) regardless of how it's referred to in the
/// macro — e.g. `biometric::biometric_status` registers as
/// `"biometric_status"` — so entries are normalized the same way.
fn parse_registered_commands() -> Vec<String> {
    let src = include_str!("lib.rs");
    let marker = "tauri::generate_handler![";
    let start = src
        .find(marker)
        .expect("tauri::generate_handler![ not found in lib.rs — did it move or get renamed?")
        + marker.len();
    let rest = &src[start..];
    let end = rest
        .find(']')
        .expect("no closing ] found for generate_handler! — macro body must be a flat ident list");
    let body = &rest[..end];

    body.lines()
        .map(|line| match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        })
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.rsplit("::").next().unwrap().to_string())
        .collect()
}

#[test]
fn every_registered_tauri_command_is_classified_into_exactly_one_bucket() {
    let commands = parse_registered_commands();
    // Sanity check: if the macro-parsing regressed (wrong marker, moved
    // file, comment syntax changed) it would likely find far fewer entries
    // than the real command list — fail loudly instead of silently passing
    // an empty/tiny set.
    assert!(
        commands.len() > 100,
        "parsed suspiciously few commands ({}) out of generate_handler! — \
         command-list parsing in command_coverage.rs likely broke",
        commands.len()
    );

    let read: HashSet<&str> = READ_COMMANDS.iter().copied().collect();
    let local: HashSet<&str> = LOCAL_COMMANDS.iter().copied().collect();
    let guarded: HashSet<&str> = GUARDED_WRITE_COMMANDS.iter().copied().collect();

    assert_eq!(
        read.len(),
        READ_COMMANDS.len(),
        "duplicate entry in READ_COMMANDS"
    );
    assert_eq!(
        local.len(),
        LOCAL_COMMANDS.len(),
        "duplicate entry in LOCAL_COMMANDS"
    );
    assert_eq!(
        guarded.len(),
        GUARDED_WRITE_COMMANDS.len(),
        "duplicate entry in GUARDED_WRITE_COMMANDS"
    );

    let overlap_read_local: Vec<&&str> = read.intersection(&local).collect();
    assert!(
        overlap_read_local.is_empty(),
        "command(s) classified in both READ_COMMANDS and LOCAL_COMMANDS: {overlap_read_local:?}"
    );
    let overlap_read_guarded: Vec<&&str> = read.intersection(&guarded).collect();
    assert!(
        overlap_read_guarded.is_empty(),
        "command(s) classified in both READ_COMMANDS and GUARDED_WRITE_COMMANDS: {overlap_read_guarded:?}"
    );
    let overlap_local_guarded: Vec<&&str> = local.intersection(&guarded).collect();
    assert!(
        overlap_local_guarded.is_empty(),
        "command(s) classified in both LOCAL_COMMANDS and GUARDED_WRITE_COMMANDS: {overlap_local_guarded:?}"
    );

    let unclassified: Vec<&String> = commands
        .iter()
        .filter(|c| !read.contains(c.as_str()) && !local.contains(c.as_str()) && !guarded.contains(c.as_str()))
        .collect();
    assert!(
        unclassified.is_empty(),
        "command(s) registered in lib.rs's generate_handler! but not classified in \
         command_coverage.rs — add each to exactly one of READ_COMMANDS (pure read, \
         never blocked), LOCAL_COMMANDS (app-local, no live connection data touched), \
         or GUARDED_WRITE_COMMANDS (mutates a connection's data — its _impl MUST call \
         write_guard::guard_writable, or an equivalent mode check, before doing any \
         work): {unclassified:?}"
    );

    // Catch the inverse rot too: a bucket entry for a command that was
    // renamed/removed would otherwise sit there unnoticed, silently
    // asserting nothing.
    let registered: HashSet<&str> = commands.iter().map(String::as_str).collect();
    let stale: Vec<&&str> = read
        .iter()
        .chain(local.iter())
        .chain(guarded.iter())
        .filter(|c| !registered.contains(*c))
        .collect();
    assert!(
        stale.is_empty(),
        "bucket entries in command_coverage.rs that no longer match a registered command \
         (renamed or removed?): {stale:?}"
    );
}
