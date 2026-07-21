//! Central write guard (#188): the single choke point every mutating `_impl`
//! calls, first line, before any DB work. Reads the live connection's
//! `ConnectionMeta.mode` (captured at connect time from the profile's
//! `connection_mode` — never re-derived, so a live connection's guard
//! behavior can't drift out of sync with what was true when it connected)
//! and decides whether the write may proceed.
//!
//! `ReadOnly` blocks every write unconditionally. `ConfirmDestructive` only
//! blocks the four ops in [`WriteOp::is_destructive`] and only when the
//! caller hasn't set `confirmed` — everything else passes through. A
//! connection with no meta entry defaults to `Normal` (fail-open: this is an
//! opt-in production safeguard, not a security boundary against a hostile
//! local user).
//!
//! Sequencing note (#188 Task 2 vs Task 3, now both complete): Task 2 guarded
//! every non-destructive mutating `_impl` with `confirmed=false` (irrelevant
//! for those ops) and defined the guard + coverage test. Task 3 gave the six
//! genuinely destructive impls (`delete_many`, `update_many`,
//! `drop_collection`, `rename_collection`, `drop_database`,
//! `rename_database`) a real `confirmed: bool` command arg threaded through
//! to this guard, and extended the coverage test with a destructive-cases
//! table asserting all three mode behaviors for each. Task 3 also added the
//! two `WriteOp::ServerAdmin` guards (`kill_op`, `set_profiling_level`) to
//! the non-destructive table.
//!
//! `delete_index_impl`/`WriteOp::DropIndex` is guarded in the non-destructive
//! table: `WriteOp::is_destructive` only covers `Drop | DeleteMany |
//! UpdateMany | Rename` — `DropIndex` is not in that set, so a
//! `ConfirmDestructive` connection lets it through even with
//! `confirmed=false` (its command has no `confirmed` arg at all — dropping
//! an index isn't considered destructive enough to require typed
//! confirmation, unlike dropping a collection/database).

use crate::connections::ConnectionMode;
use crate::state::{AppState, LockExt};

/// Every mutating operation the write guard can be asked to authorize. One
/// variant per "kind" of write, not one per command, so several impls that
/// write the same way (e.g. `create_user`/`update_user`/`drop_user`) can
/// share `UserWrite`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WriteOp {
    Insert,
    UpdateMany,
    DeleteOne,
    DeleteMany,
    ReplaceOne,
    Drop,
    Rename,
    CreateCollection,
    CreateView,
    CreateIndex,
    DropIndex,
    CollMod,
    GridFsWrite,
    Import,
    Generate,
    CopyWrite,
    RestoreWrite,
    UserWrite,
    /// Server-admin operations that mutate live server/database state but
    /// aren't collection data writes: `killOp` and the profiler level
    /// (`setProfilingLevel`). Non-destructive — not in `is_destructive`.
    ServerAdmin,
}

impl WriteOp {
    /// The four ops a `ConfirmDestructive` connection requires an explicit
    /// `confirmed: bool` for. Everything else is allowed through even
    /// unconfirmed on a confirm-destructive connection.
    pub fn is_destructive(self) -> bool {
        matches!(self, WriteOp::Drop | WriteOp::DeleteMany | WriteOp::UpdateMany | WriteOp::Rename)
    }
}

/// Exact rejection string for a `ReadOnly` connection (spec-mandated wording).
pub const READ_ONLY_MSG: &str =
    "This connection is read-only (production safeguard). Change the connection mode in its settings to modify data.";
/// Exact rejection string for an unconfirmed destructive op on a `ConfirmDestructive` connection.
pub const CONFIRM_MSG: &str =
    "This operation modifies production data on a safeguarded connection. Confirm by typing the collection name.";

/// The single choke point for every mutating command. `connection_id` is
/// always the connection the write actually lands on — for copy commands
/// that's the TARGET connection, not the source, since a copy writes into
/// the target. Call this as the first line of every mutating `_impl`,
/// before any parsing or DB work, so a safeguarded connection rejects
/// uniformly regardless of what else is wrong with the call.
pub fn guard_writable(
    state: &AppState,
    connection_id: &str,
    op: WriteOp,
    confirmed: bool,
) -> Result<(), String> {
    let mode = {
        let meta = state.connection_meta.lock_safe()?;
        meta.get(connection_id).map(|m| m.mode).unwrap_or_default()
    };
    match mode {
        ConnectionMode::Normal => Ok(()),
        ConnectionMode::ReadOnly => Err(READ_ONLY_MSG.to_string()),
        ConnectionMode::ConfirmDestructive => {
            if op.is_destructive() && !confirmed {
                Err(CONFIRM_MSG.to_string())
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{copy, ddl, documents, generate, gridfs, import, metadata, mongotools, users};
    use crate::monitoring;
    use crate::state::ConnectionMeta;
    use std::future::Future;
    use std::pin::Pin;

    /// Number of non-destructive mutating `_impl`s wired in Task 2 (19) plus
    /// the two `WriteOp::ServerAdmin` impls wired in Task 3 (`kill_op_impl`,
    /// `set_profiling_level_impl`) = 21. A new mutating command must add a
    /// row to `non_destructive_cases` below AND bump this constant — kept as
    /// a paired assertion so a forgotten row fails the test loudly instead of
    /// silently shrinking coverage.
    const NON_DESTRUCTIVE_GUARDED_COUNT: usize = 21;

    /// Register a mock connection (`state.mocks`) with the given mode
    /// (`state.connection_meta`), mirroring the `mock_state` helper used
    /// elsewhere in the `db` test modules (see `db/copy.rs::tests::mock_state`).
    fn mock_conn(state: &AppState, id: &str, mode: ConnectionMode) {
        state.mocks.lock().unwrap().insert(id.to_string(), true);
        state.connection_meta.lock().unwrap().insert(
            id.to_string(),
            ConnectionMeta { profile_id: "p".into(), name: id.into(), via_mcp: false, mode },
        );
    }

    fn readonly_state(ids: &[&str]) -> AppState {
        let state = AppState::new();
        for id in ids {
            mock_conn(&state, id, ConnectionMode::ReadOnly);
        }
        state
    }

    type BoxedCall<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

    /// One closure invocation per non-destructive mutating `_impl`, called
    /// once each with minimal valid args against a read-only mock
    /// connection. Every call must return `Err` containing "read-only".
    /// Adding a new mutating command = adding a row here (and bumping
    /// `NON_DESTRUCTIVE_GUARDED_COUNT`).
    fn non_destructive_cases(state: &AppState) -> Vec<(&'static str, BoxedCall<'_>)> {
        vec![
            (
                "insert_document_impl",
                Box::pin(async move {
                    documents::insert_document_impl(state, "ro", "db", "coll", "{}")
                        .await
                        .map(|_| ())
                }),
            ),
            (
                "update_document_impl",
                Box::pin(async move {
                    documents::update_document_impl(state, "ro", "db", "coll", "{}", "{}")
                        .await
                        .map(|_| ())
                }),
            ),
            (
                "delete_document_impl",
                Box::pin(async move {
                    documents::delete_document_impl(state, "ro", "db", "coll", "{}")
                        .await
                        .map(|_| ())
                }),
            ),
            (
                "import_documents_impl",
                Box::pin(async move {
                    documents::import_documents_impl(state, "ro", "db", "coll", vec![], "skip")
                        .await
                        .map(|_| ())
                }),
            ),
            (
                "create_collection_impl",
                Box::pin(async move {
                    ddl::create_collection_impl(state, "ro", "db", "coll").await
                }),
            ),
            (
                "create_view_impl",
                Box::pin(async move {
                    ddl::create_view_impl(state, "ro", "db", "view", "src", "[]").await
                }),
            ),
            (
                "set_validator_impl",
                Box::pin(async move {
                    ddl::set_validator_impl(state, "ro", "db", "coll", "{}", "", "").await
                }),
            ),
            (
                "create_index_impl",
                Box::pin(async move {
                    metadata::create_index_impl(state, "ro", "db", "coll", "idx", "{}", false, false)
                        .await
                }),
            ),
            (
                "delete_index_impl",
                Box::pin(async move {
                    metadata::delete_index_impl(state, "ro", "db", "coll", "idx").await
                }),
            ),
            (
                "upload_gridfs_file_impl",
                Box::pin(async move {
                    gridfs::upload_gridfs_file_impl(
                        state, "ro", "db", "fs", "/nonexistent", None, None, None, None,
                    )
                    .await
                    .map(|_| ())
                }),
            ),
            (
                "delete_gridfs_file_impl",
                Box::pin(async move {
                    gridfs::delete_gridfs_file_impl(state, "ro", "db", "fs", "\"x\"").await
                }),
            ),
            (
                "create_user_impl",
                Box::pin(async move {
                    users::create_user_impl(state, "ro", "db", "u", "p", &[]).await
                }),
            ),
            (
                "update_user_impl",
                Box::pin(async move {
                    users::update_user_impl(state, "ro", "db", "u", Some("p"), None).await
                }),
            ),
            (
                "drop_user_impl",
                Box::pin(async move { users::drop_user_impl(state, "ro", "db", "u").await }),
            ),
            (
                "start_collection_copy_impl",
                Box::pin(async move {
                    copy::start_collection_copy_impl(
                        state, "src", "db", "coll", "ro", "db", "coll2", None, false,
                        "skip".to_string(),
                    )
                    .await
                    .map(|_| ())
                }),
            ),
            (
                "start_database_copy_impl",
                Box::pin(async move {
                    copy::start_database_copy_impl(
                        state, "src", "db", "ro", "db2", None, false, false, "skip".to_string(),
                    )
                    .await
                    .map(|_| ())
                }),
            ),
            (
                "start_import_task_impl",
                Box::pin(async move {
                    import::start_import_task_impl(
                        state,
                        "ro",
                        "db",
                        "coll",
                        import::ImportSourceArg::default(),
                        "json",
                        None,
                        "skip",
                    )
                    .await
                    .map(|_| ())
                }),
            ),
            (
                "start_generate_task_impl",
                Box::pin(async move {
                    generate::start_generate_task_impl(state, "ro", "db", "coll", "{}", 1, Some(1))
                        .await
                        .map(|_| ())
                }),
            ),
            (
                "start_restore_task_impl",
                Box::pin(async move {
                    mongotools::start_restore_task_impl(
                        state,
                        "ro",
                        "/usr/bin/mongorestore",
                        mongotools::RestoreOptions::default(),
                    )
                    .await
                    .map(|_| ())
                }),
            ),
            (
                "kill_op_impl",
                Box::pin(async move { monitoring::kill_op_impl(state, "ro", 1).await }),
            ),
            (
                "set_profiling_level_impl",
                Box::pin(async move {
                    monitoring::set_profiling_level_impl(state, "ro", "db", 1, 100)
                        .await
                        .map(|_| ())
                }),
            ),
        ]
    }

    #[tokio::test]
    async fn every_non_destructive_mutating_impl_rejects_on_a_read_only_connection() {
        let state = readonly_state(&["ro", "src"]);
        let cases = non_destructive_cases(&state);
        assert_eq!(
            cases.len(),
            NON_DESTRUCTIVE_GUARDED_COUNT,
            "a row was added/removed without updating NON_DESTRUCTIVE_GUARDED_COUNT"
        );
        for (name, fut) in cases {
            let res = fut.await;
            let err = res.expect_err(&format!("{name} should reject on a read-only connection"));
            assert!(
                err.contains("read-only"),
                "{name} error should mention read-only, got: {err}"
            );
        }
    }

    /// Copy commands guard the TARGET connection, not the source — a copy
    /// writes into the target. Proven both ways: read-only target blocks
    /// (even though the source is a normal, writable connection), and a
    /// read-only SOURCE with a normal target does NOT block (proving the
    /// guard doesn't key off the wrong connection).
    #[tokio::test]
    async fn copy_commands_guard_the_target_connection_not_the_source() {
        // Target read-only, source normal -> blocked.
        let target_ro = AppState::new();
        mock_conn(&target_ro, "source", ConnectionMode::Normal);
        mock_conn(&target_ro, "target", ConnectionMode::ReadOnly);
        let err = copy::start_collection_copy_impl(
            &target_ro, "source", "db", "coll", "target", "db", "coll2", None, false,
            "skip".to_string(),
        )
        .await
        .expect_err("read-only target must block the copy");
        assert!(err.contains("read-only"), "got: {err}");

        let err = copy::start_database_copy_impl(
            &target_ro, "source", "db", "target", "db2", None, false, false, "skip".to_string(),
        )
        .await
        .expect_err("read-only target must block the database copy");
        assert!(err.contains("read-only"), "got: {err}");

        // Source read-only, target normal -> NOT blocked by the guard (may
        // still fail later for other reasons on a mock, but not with the
        // read-only message).
        let source_ro = AppState::new();
        mock_conn(&source_ro, "source", ConnectionMode::ReadOnly);
        mock_conn(&source_ro, "target", ConnectionMode::Normal);
        let res = copy::start_collection_copy_impl(
            &source_ro, "source", "db", "coll", "target", "db", "coll2", None, false,
            "skip".to_string(),
        )
        .await;
        if let Err(e) = &res {
            assert!(
                !e.contains("read-only"),
                "a read-only SOURCE must not block the copy (guard is target-keyed), got: {e}"
            );
        }
    }

    /// Number of destructive mutating `_impl`s wired in Task 3 with a real
    /// `confirmed: bool` command arg: `delete_many_impl`, `update_many_impl`,
    /// `drop_collection_impl`, `rename_collection_impl`, `drop_database_impl`,
    /// `rename_database_impl`. That's 6, matching `WriteOp::is_destructive`'s
    /// four variants (`Drop` covers both drop_collection and drop_database;
    /// `Rename` covers both rename_collection and rename_database) — every
    /// impl that guards with a destructive `WriteOp` is in this table.
    /// (`delete_index_impl`/`WriteOp::DropIndex` is intentionally NOT here:
    /// it's non-destructive, see `non_destructive_cases` above and the
    /// module doc.) The plan text elsewhere says "7 destructive impls" /
    /// `DESTRUCTIVE_GUARDED_COUNT (=7)`, but its own opening summary and
    /// bulleted list enumerate exactly these 6 (drop_index is explicitly
    /// excluded in that same list) — treated as a slip in the plan and
    /// flagged in the Task 3 report rather than padding this table with a
    /// duplicate/fictitious 7th row.
    const DESTRUCTIVE_GUARDED_COUNT: usize = 6;

    /// A destructive `_impl`, called with an explicit `confirmed` value so
    /// the same case can be replayed against every mode. All args besides
    /// `confirmed` are fixed, valid-for-a-mock values (see each impl's mock
    /// branch): this only exercises the guard, not the rest of the impl.
    type DestructiveCall =
        for<'a> fn(&'a AppState, &'a str, bool) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

    fn destructive_cases() -> Vec<(&'static str, DestructiveCall)> {
        vec![
            ("delete_many_impl", |state, id, confirmed| {
                Box::pin(async move {
                    documents::delete_many_impl(state, id, "db", "coll", "{}", confirmed)
                        .await
                        .map(|_| ())
                })
            }),
            ("update_many_impl", |state, id, confirmed| {
                Box::pin(async move {
                    documents::update_many_impl(
                        state,
                        id,
                        "db",
                        "coll",
                        "{}",
                        r#"{"$set":{"a":1}}"#,
                        confirmed,
                    )
                    .await
                    .map(|_| ())
                })
            }),
            ("drop_collection_impl", |state, id, confirmed| {
                Box::pin(async move {
                    ddl::drop_collection_impl(state, id, "db", "coll", confirmed).await
                })
            }),
            ("rename_collection_impl", |state, id, confirmed| {
                Box::pin(async move {
                    ddl::rename_collection_impl(state, id, "db", "from", "to", confirmed).await
                })
            }),
            ("drop_database_impl", |state, id, confirmed| {
                Box::pin(async move { ddl::drop_database_impl(state, id, "db", confirmed).await })
            }),
            ("rename_database_impl", |state, id, confirmed| {
                Box::pin(async move {
                    ddl::rename_database_impl(state, id, "from_db", "to_db", false, confirmed)
                        .await
                        .map(|_| ())
                })
            }),
        ]
    }

    /// The three-mode contract for every destructive `_impl`: `ReadOnly`
    /// blocks it regardless of `confirmed` (there's no way to opt back into
    /// writing on a read-only connection); `ConfirmDestructive` blocks it
    /// unless `confirmed`, and passes when `confirmed`; `Normal` always
    /// passes. Adding a new destructive command = adding a row to
    /// `destructive_cases` (and bumping `DESTRUCTIVE_GUARDED_COUNT`).
    #[tokio::test]
    async fn destructive_impls_respect_mode_and_confirmed() {
        let cases = destructive_cases();
        assert_eq!(
            cases.len(),
            DESTRUCTIVE_GUARDED_COUNT,
            "a row was added/removed without updating DESTRUCTIVE_GUARDED_COUNT"
        );

        for (name, call) in cases {
            // ReadOnly blocks regardless of confirmed.
            let ro = readonly_state(&["ro"]);
            for confirmed in [false, true] {
                let err = call(&ro, "ro", confirmed).await.expect_err(&format!(
                    "{name} should reject on a read-only connection (confirmed={confirmed})"
                ));
                assert!(err.contains("read-only"), "{name}: got {err}");
            }

            // ConfirmDestructive blocks when unconfirmed, passes when confirmed.
            let cd = AppState::new();
            mock_conn(&cd, "cd", ConnectionMode::ConfirmDestructive);
            let err = call(&cd, "cd", false)
                .await
                .expect_err(&format!("{name} should reject unconfirmed on confirm-destructive"));
            assert_eq!(err, CONFIRM_MSG, "{name}: got {err}");
            call(&cd, "cd", true)
                .await
                .unwrap_or_else(|e| panic!("{name} should pass when confirmed: {e}"));

            // Normal passes regardless of confirmed.
            let norm = AppState::new();
            mock_conn(&norm, "norm", ConnectionMode::Normal);
            call(&norm, "norm", false)
                .await
                .unwrap_or_else(|e| panic!("{name} should pass on a normal connection: {e}"));
        }
    }

    // --- Part C: direct `guard_writable` unit tests (below the `_impl`
    // coverage tables above, which exercise the guard indirectly through
    // real commands). These pin down the guard's own contract in isolation.

    /// Every `WriteOp` variant on a `Normal` connection (with meta present)
    /// is allowed through, confirmed or not.
    #[tokio::test]
    async fn normal_with_meta_allows_every_op() {
        let state = AppState::new();
        mock_conn(&state, "norm", ConnectionMode::Normal);
        for op in ALL_OPS {
            guard_writable(&state, "norm", op, false)
                .unwrap_or_else(|e| panic!("{op:?} confirmed=false should pass on normal: {e}"));
            guard_writable(&state, "norm", op, true)
                .unwrap_or_else(|e| panic!("{op:?} confirmed=true should pass on normal: {e}"));
        }
    }

    /// A connection with no `connection_meta` entry at all defaults to
    /// `Normal` (fail-open — this is an opt-in safeguard, not a security
    /// boundary; see the module doc).
    #[tokio::test]
    async fn no_meta_fails_open_to_normal() {
        let state = AppState::new();
        for op in ALL_OPS {
            guard_writable(&state, "unknown", op, false)
                .unwrap_or_else(|e| panic!("{op:?} should fail open (no meta) to normal: {e}"));
        }
    }

    /// `ReadOnly` rejects every op, destructive or not, confirmed or not.
    #[tokio::test]
    async fn read_only_blocks_destructive_and_non_destructive() {
        let state = AppState::new();
        mock_conn(&state, "ro", ConnectionMode::ReadOnly);
        for (op, confirmed) in [
            (WriteOp::Insert, false),
            (WriteOp::Insert, true),
            (WriteOp::DeleteMany, false),
            (WriteOp::DeleteMany, true),
        ] {
            let err = guard_writable(&state, "ro", op, confirmed)
                .expect_err(&format!("{op:?} confirmed={confirmed} should reject on read-only"));
            assert_eq!(err, READ_ONLY_MSG);
        }
    }

    /// `ConfirmDestructive`: non-destructive ops always pass; destructive
    /// ops pass only when `confirmed`.
    #[tokio::test]
    async fn confirm_destructive_gates_only_destructive_ops() {
        let state = AppState::new();
        mock_conn(&state, "cd", ConnectionMode::ConfirmDestructive);

        guard_writable(&state, "cd", WriteOp::Insert, false)
            .expect("non-destructive op should pass unconfirmed on confirm-destructive");
        guard_writable(&state, "cd", WriteOp::DeleteMany, true)
            .expect("destructive op should pass when confirmed");
        let err = guard_writable(&state, "cd", WriteOp::DeleteMany, false)
            .expect_err("destructive op should reject when unconfirmed");
        assert_eq!(err, CONFIRM_MSG);
    }

    /// All `WriteOp` variants, for the "every op" sweeps above. Kept as a
    /// literal array (not derived) so adding a variant to the enum forces a
    /// conscious edit here too.
    const ALL_OPS: [WriteOp; 19] = [
        WriteOp::Insert,
        WriteOp::UpdateMany,
        WriteOp::DeleteOne,
        WriteOp::DeleteMany,
        WriteOp::ReplaceOne,
        WriteOp::Drop,
        WriteOp::Rename,
        WriteOp::CreateCollection,
        WriteOp::CreateView,
        WriteOp::CreateIndex,
        WriteOp::DropIndex,
        WriteOp::CollMod,
        WriteOp::GridFsWrite,
        WriteOp::Import,
        WriteOp::Generate,
        WriteOp::CopyWrite,
        WriteOp::RestoreWrite,
        WriteOp::UserWrite,
        WriteOp::ServerAdmin,
    ];
}
