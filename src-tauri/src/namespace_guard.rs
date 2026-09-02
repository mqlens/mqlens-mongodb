//! Keeps a namespace from being renamed or dropped while a document write is
//! in flight against it.
//!
//! The race is small and unrecoverable. An insert names its collection when it
//! is sent; if a rename or a drop reaches MongoDB first, the server recreates
//! that collection for the insert and the write lands in a namespace that was
//! supposed to be gone — a drop half-undone, or one write split across two
//! collections, with the UI reporting success against the new name.
//!
//! It belongs here rather than in the UI. Every window issues its commands
//! through this same process, so this is the only place that sees all of them:
//! a check in one renderer cannot know what another renderer has outstanding
//! (#326 review). The frontend keeps its own check for immediate feedback;
//! this is the one that is true.

use crate::state::{AppState, LockExt};
#[cfg(test)]
use std::collections::HashMap;

/// `connection/database/collection` — the granularity a write actually names.
fn key(connection_id: &str, database: &str, collection: &str) -> String {
    format!("{connection_id}/{database}/{collection}")
}

/// A write counted against its namespace for as long as this lives.
///
/// The count is released on drop, so it is released on every path out of the
/// command — including the error paths and a panic. A guard that had to be
/// released by hand would eventually be leaked by one of them, and a leak here
/// means a namespace nobody can ever rename again.
pub struct DocumentWriteGuard<'a> {
    state: &'a AppState,
    key: String,
}

impl Drop for DocumentWriteGuard<'_> {
    fn drop(&mut self) {
        let Ok(mut writes) = self.state.document_writes.lock_safe() else {
            // A poisoned lock means another thread panicked holding it. Nothing
            // useful to do here, and panicking inside a drop would abort.
            return;
        };
        if let Some(count) = writes.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                writes.remove(&self.key);
            }
        }
    }
}

/// Count a document write against its namespace until the returned guard drops.
pub fn begin_document_write<'a>(
    state: &'a AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
) -> Result<DocumentWriteGuard<'a>, String> {
    let key = key(connection_id, database, collection);
    *state.document_writes.lock_safe()?.entry(key.clone()).or_insert(0) += 1;
    Ok(DocumentWriteGuard { state, key })
}

/// Refuse when a document write is outstanding against this namespace.
///
/// `collection` is `None` for a database-level change, which moves or removes
/// every collection under it — so any write below that database blocks it.
pub fn ensure_namespace_idle(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: Option<&str>,
) -> Result<(), String> {
    let writes = state.document_writes.lock_safe()?;
    let busy = match collection {
        Some(collection) => writes.contains_key(&key(connection_id, database, collection)),
        None => {
            let prefix = format!("{connection_id}/{database}/");
            writes.keys().any(|k| k.starts_with(&prefix))
        }
    };
    if busy {
        // User-facing: the frontend renders a command's error text directly.
        return Err(
            "A document is still being saved here. Wait for it to finish, then try again."
                .to_string(),
        );
    }
    Ok(())
}

/// Test-only view of the counts, so a test can assert a guard released.
#[cfg(test)]
pub fn outstanding(state: &AppState) -> HashMap<String, usize> {
    state.document_writes.lock_safe().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_blocks_its_own_namespace_and_its_database() {
        let state = AppState::new();
        let _write = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();

        assert!(ensure_namespace_idle(&state, "conn-1", "sales", Some("customers")).is_err());
        // A database rename or drop moves every collection under it.
        assert!(ensure_namespace_idle(&state, "conn-1", "sales", None).is_err());

        // Everything else is free: a neighbouring collection, another database,
        // the same names on a different connection.
        assert!(ensure_namespace_idle(&state, "conn-1", "sales", Some("orders")).is_ok());
        assert!(ensure_namespace_idle(&state, "conn-1", "other", None).is_ok());
        assert!(ensure_namespace_idle(&state, "conn-2", "sales", Some("customers")).is_ok());
    }

    #[test]
    fn the_namespace_frees_when_the_write_ends_however_it_ends() {
        let state = AppState::new();
        {
            let _write = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();
            assert!(ensure_namespace_idle(&state, "conn-1", "sales", Some("customers")).is_err());
        }
        // Released on drop, so it is released on the error paths too — a guard
        // released by hand would eventually be leaked by one of them, and a leak
        // here is a namespace nobody can rename again.
        assert!(ensure_namespace_idle(&state, "conn-1", "sales", Some("customers")).is_ok());
        assert!(outstanding(&state).is_empty(), "no key should linger at zero");
    }

    #[test]
    fn concurrent_writes_on_one_namespace_are_counted_not_replaced() {
        let state = AppState::new();
        let first = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();
        let second = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();

        drop(first);
        // Still one outstanding: the earlier one ending says nothing about it.
        assert!(ensure_namespace_idle(&state, "conn-1", "sales", Some("customers")).is_err());

        drop(second);
        assert!(ensure_namespace_idle(&state, "conn-1", "sales", Some("customers")).is_ok());
    }
}
