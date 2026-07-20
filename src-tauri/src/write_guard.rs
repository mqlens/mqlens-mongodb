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
//! Sequencing note (#188 Task 2 vs Task 3): this module guards every
//! non-destructive mutating `_impl` with `confirmed=false` (irrelevant for
//! those ops). The six destructive commands (`drop_collection`,
//! `drop_database`, `delete_many`, `update_many`, `rename_collection`,
//! `drop_index`) gain a real `confirmed: bool` command arg in Task 3, which
//! is threaded through to this guard there.
//!
//! `delete_index_impl`/`WriteOp::DropIndex` is guarded HERE (Task 2), not in
//! Task 3: `WriteOp::is_destructive` only covers `Drop | DeleteMany |
//! UpdateMany | Rename` — `DropIndex` is not in that set, so it's a
//! non-destructive-arg impl guarded with `confirmed=false` like the rest of
//! this task's list. (The plan's prose mentions drop_index among Task 3's
//! confirmed-arg set in one place, but the destructive-four definition and
//! the file structure table are unambiguous: drop_index belongs here.)

use crate::connections::ConnectionMode;
use crate::state::{AppState, LockExt};

/// Every mutating operation the write guard can be asked to authorize. One
/// variant per "kind" of write, not one per command, so several impls that
/// write the same way (e.g. `create_user`/`update_user`/`drop_user`) can
/// share `UserWrite`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WriteOp {
    Insert,
    UpdateOne,
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
    use crate::state::ConnectionMeta;
    use std::future::Future;
    use std::pin::Pin;

    /// Number of non-destructive mutating `_impl`s wired in Task 2 (the
    /// plan's explicit coverage list). A new mutating command must add a row
    /// to `non_destructive_cases` below AND bump this constant — kept as a
    /// paired assertion so a forgotten row fails the test loudly instead of
    /// silently shrinking coverage.
    const NON_DESTRUCTIVE_GUARDED_COUNT: usize = 19;

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

    /// `rename_database_impl` (ddl.rs) is a mutating command NOT in the
    /// plan's Task 2/Task 3 coverage lists (it's neither one of the 19
    /// non-destructive impls nor one of the six named destructive commands
    /// `drop_collection`/`drop_database`/`delete_many`/`update_many`/
    /// `rename_collection`/`drop_index`) — flagged and guarded here as an
    /// addition beyond the plan. It renames every collection in a database
    /// and optionally drops the source, which is at least as destructive as
    /// `rename_collection`, so it's guarded with `WriteOp::Rename` — but
    /// unlike the six named destructive commands it has no `confirmed`
    /// command arg yet, so `confirmed` is hardcoded `false` here pending a
    /// follow-up task giving it one (interim effect: blocked on both
    /// `ReadOnly` and `ConfirmDestructive`, allowed on `Normal`). Not
    /// counted in `NON_DESTRUCTIVE_GUARDED_COUNT` since it isn't actually
    /// non-destructive; tested separately.
    #[tokio::test]
    async fn rename_database_impl_rejects_on_a_read_only_connection() {
        let state = readonly_state(&["ro"]);
        let err = match ddl::rename_database_impl(&state, "ro", "from_db", "to_db", false).await {
            Err(e) => e,
            Ok(_) => panic!("rename_database_impl should reject on a read-only connection"),
        };
        assert!(err.contains("read-only"), "got: {err}");
    }
}
