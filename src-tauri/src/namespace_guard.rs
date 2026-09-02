//! Keeps a namespace from being renamed or dropped while a document write is
//! in flight against it, and vice versa.
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
//!
//! Reservations, not checks. Asking "is anything running?" and then awaiting
//! the operation leaves exactly the gap it was meant to close — the answer is
//! stale the moment the lock is released, and a write starting in that gap is
//! the corruption again (#326 review). A document write and a DDL each claim
//! the namespaces they name, for as long as they run, and each refuses to
//! start while the other holds an overlapping claim. Document writes do not
//! exclude each other: several inserts into one collection are ordinary.

use crate::state::{AppState, LockExt};
use std::collections::HashMap;

/// `connection/database` — the scope a database rename or drop claims, and the
/// prefix every collection under it shares.
fn db_key(connection_id: &str, database: &str) -> String {
    format!("{connection_id}/{database}")
}

/// `connection/database/collection` — the scope a write or a collection DDL
/// claims.
fn collection_key(connection_id: &str, database: &str, collection: &str) -> String {
    format!("{connection_id}/{database}/{collection}")
}

/// What is currently claimed, and by which kind of caller.
#[derive(Default)]
pub struct NamespaceLocks {
    /// Document writes outstanding, by collection scope.
    writes: HashMap<String, usize>,
    /// Renames and drops in progress, by the scope each claimed — a collection
    /// key or a database key.
    ddl: HashMap<String, usize>,
}

fn release(counts: &mut HashMap<String, usize>, key: &str) {
    if let Some(count) = counts.get_mut(key) {
        *count -= 1;
        if *count == 0 {
            counts.remove(key);
        }
    }
}

/// Held for the life of a call; releases its claims on drop.
///
/// Dropping is what releases them, so they are released on every path out —
/// the error paths and a panic included. A claim released by hand is one some
/// path eventually leaks, and a leak here is a namespace nobody can rename
/// again.
pub struct NamespaceClaim<'a> {
    state: &'a AppState,
    keys: Vec<String>,
    ddl: bool,
}

impl Drop for NamespaceClaim<'_> {
    fn drop(&mut self) {
        let Ok(mut locks) = self.state.namespaces.lock_safe() else {
            // Another thread panicked holding the lock. Nothing useful to do,
            // and panicking inside a drop would abort the process.
            return;
        };
        for key in &self.keys {
            if self.ddl {
                release(&mut locks.ddl, key);
            } else {
                release(&mut locks.writes, key);
            }
        }
    }
}

/// User-facing: a command's error text is rendered straight into the UI.
const BUSY_WITH_SAVE: &str =
    "A document is still being saved here. Wait for it to finish, then try again.";
const BUSY_WITH_DDL: &str =
    "This collection is being renamed or dropped. Wait for that to finish, then try again.";

/// Claim a collection for one document write.
///
/// Refused while a rename or a drop holds this collection, or the database it
/// is in.
pub fn begin_document_write<'a>(
    state: &'a AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
) -> Result<NamespaceClaim<'a>, String> {
    let key = collection_key(connection_id, database, collection);
    let mut locks = state.namespaces.lock_safe()?;
    if locks.ddl.contains_key(&key) || locks.ddl.contains_key(&db_key(connection_id, database)) {
        return Err(BUSY_WITH_DDL.to_string());
    }
    *locks.writes.entry(key.clone()).or_insert(0) += 1;
    Ok(NamespaceClaim { state, keys: vec![key], ddl: false })
}

/// Claim collections for a rename or a drop, for as long as it runs.
///
/// A rename claims both names: a write into the destination while the rename is
/// in flight is the same hazard from the other side.
pub fn begin_collection_ddl<'a>(
    state: &'a AppState,
    connection_id: &str,
    database: &str,
    collections: &[&str],
) -> Result<NamespaceClaim<'a>, String> {
    let database_scope = db_key(connection_id, database);
    let keys: Vec<String> = collections
        .iter()
        .map(|c| collection_key(connection_id, database, c))
        .collect();
    let mut locks = state.namespaces.lock_safe()?;
    for key in &keys {
        if locks.writes.contains_key(key) {
            return Err(BUSY_WITH_SAVE.to_string());
        }
        if locks.ddl.contains_key(key) || locks.ddl.contains_key(&database_scope) {
            return Err(BUSY_WITH_DDL.to_string());
        }
    }
    // Claimed only once every name is free, so a refusal leaves nothing behind.
    for key in &keys {
        *locks.ddl.entry(key.clone()).or_insert(0) += 1;
    }
    Ok(NamespaceClaim { state, keys, ddl: true })
}

/// Claim whole databases for a rename or a drop: every collection under them
/// moves or goes, so any write below one blocks it.
pub fn begin_database_ddl<'a>(
    state: &'a AppState,
    connection_id: &str,
    databases: &[&str],
) -> Result<NamespaceClaim<'a>, String> {
    let keys: Vec<String> = databases.iter().map(|d| db_key(connection_id, d)).collect();
    let mut locks = state.namespaces.lock_safe()?;
    for key in &keys {
        let below = format!("{key}/");
        if locks.writes.keys().any(|k| k.starts_with(&below)) {
            return Err(BUSY_WITH_SAVE.to_string());
        }
        if locks.ddl.contains_key(key) || locks.ddl.keys().any(|k| k.starts_with(&below)) {
            return Err(BUSY_WITH_DDL.to_string());
        }
    }
    for key in &keys {
        *locks.ddl.entry(key.clone()).or_insert(0) += 1;
    }
    Ok(NamespaceClaim { state, keys, ddl: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_blocks_its_collection_and_its_database() {
        let state = AppState::new();
        let _write = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();

        assert!(begin_collection_ddl(&state, "conn-1", "sales", &["customers"]).is_err());
        // A database rename or drop takes every collection under it.
        assert!(begin_database_ddl(&state, "conn-1", &["sales"]).is_err());

        // Everything else is free: a neighbouring collection, another database,
        // the same names on another connection.
        assert!(begin_collection_ddl(&state, "conn-1", "sales", &["orders"]).is_ok());
        assert!(begin_database_ddl(&state, "conn-1", &["other"]).is_ok());
        assert!(begin_collection_ddl(&state, "conn-2", "sales", &["customers"]).is_ok());
    }

    #[test]
    fn a_ddl_in_progress_blocks_a_write_starting_under_it() {
        // The check-then-act gap: the DDL is awaited, so a write arriving after
        // the old check and before MongoDB saw the rename was accepted, and then
        // recreated the namespace the rename had just moved (#326 review).
        let state = AppState::new();
        let _rename =
            begin_collection_ddl(&state, "conn-1", "sales", &["customers", "clients"]).unwrap();

        assert!(begin_document_write(&state, "conn-1", "sales", "customers").is_err());
        // Both names, because a write into the destination is the same hazard.
        assert!(begin_document_write(&state, "conn-1", "sales", "clients").is_err());
        assert!(begin_document_write(&state, "conn-1", "sales", "orders").is_ok());
    }

    #[test]
    fn a_database_ddl_blocks_writes_to_every_collection_under_it() {
        let state = AppState::new();
        let _drop = begin_database_ddl(&state, "conn-1", &["sales"]).unwrap();

        assert!(begin_document_write(&state, "conn-1", "sales", "customers").is_err());
        assert!(begin_document_write(&state, "conn-1", "sales", "orders").is_err());
        assert!(begin_document_write(&state, "conn-1", "other", "customers").is_ok());
    }

    #[test]
    fn overlapping_ddl_is_refused_from_either_direction() {
        let state = AppState::new();
        let collection = begin_collection_ddl(&state, "conn-1", "sales", &["customers"]).unwrap();
        // The database above it is not free while one of its collections is busy.
        assert!(begin_database_ddl(&state, "conn-1", &["sales"]).is_err());
        drop(collection);

        let _database = begin_database_ddl(&state, "conn-1", &["sales"]).unwrap();
        assert!(begin_collection_ddl(&state, "conn-1", "sales", &["customers"]).is_err());
    }

    #[test]
    fn a_refused_claim_leaves_nothing_behind() {
        let state = AppState::new();
        let _write = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();
        // "orders" is free, "customers" is not: the whole claim is refused, and
        // "orders" must not be left claimed by the attempt.
        assert!(begin_collection_ddl(&state, "conn-1", "sales", &["orders", "customers"]).is_err());
        assert!(begin_document_write(&state, "conn-1", "sales", "orders").is_ok());
    }

    #[test]
    fn claims_release_however_the_call_ends() {
        let state = AppState::new();
        {
            let _write = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();
            assert!(begin_collection_ddl(&state, "conn-1", "sales", &["customers"]).is_err());
        }
        assert!(begin_collection_ddl(&state, "conn-1", "sales", &["customers"]).is_ok());
        let locks = state.namespaces.lock_safe().unwrap();
        assert!(locks.writes.is_empty(), "no key should linger at zero");
        assert!(locks.ddl.is_empty(), "no key should linger at zero");
    }

    #[test]
    fn document_writes_do_not_exclude_each_other() {
        // Several inserts into one collection are ordinary; only DDL is exclusive.
        let state = AppState::new();
        let first = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();
        let second = begin_document_write(&state, "conn-1", "sales", "customers").unwrap();

        drop(first);
        // Still one outstanding: the earlier one ending says nothing about it.
        assert!(begin_collection_ddl(&state, "conn-1", "sales", &["customers"]).is_err());
        drop(second);
        assert!(begin_collection_ddl(&state, "conn-1", "sales", &["customers"]).is_ok());
    }
}
