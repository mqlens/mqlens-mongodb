//! Crash-safe file writes for vault-backed data (#272).
//!
//! `fs::write` only reaches the page cache: an OS crash or power loss can leave
//! a rename pointing at bytes that never hit the disk, losing the whole file
//! rather than one update. Everything that must survive that goes through here.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Write `bytes` to `path` atomically and durably: temp file → fsync → rename.
///
/// The rename is atomic for readers, and the fsync before it guarantees the
/// bytes exist before anything points at them. On Unix the parent directory is
/// fsynced too, so the rename itself survives a power loss; Windows cannot open
/// a directory as a file and has different rename-ordering guarantees.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = tmp_path(path);
    let result = (|| -> Result<(), String> {
        {
            let mut file =
                fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
            file.write_all(bytes)
                .map_err(|e| format!("write {}: {e}", tmp.display()))?;
            file.sync_all()
                .map_err(|e| format!("fsync {}: {e}", tmp.display()))?;
        }
        fs::rename(&tmp, path)
            .map_err(|e| format!("rename {} → {}: {e}", tmp.display(), path.display()))
    })();
    if result.is_err() {
        // Leave nothing behind for the next writer to trip over.
        let _ = fs::remove_file(&tmp);
        return result;
    }
    sync_parent_dir(path);
    Ok(())
}

/// Flush the directory entry created by a rename. Best-effort by design: a
/// filesystem that rejects directory fsync must not fail the write itself.
pub fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// A temp path no other writer will pick.
///
/// A fixed `<target>.tmp` was not enough: two MQLens processes saving the same
/// vault file both opened it, so one truncated the other's staging file and,
/// after the first rename, the second kept writing to the inode now published as
/// the real file before its own rename failed. The pid separates processes and
/// the counter separates writes within one, so each write stages somewhere of
/// its own and the rename stays the only publishing step.
fn tmp_path(path: &Path) -> std::path::PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_atomic_creates_file_and_leaves_no_temp() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("nested").join("data.enc");
        write_atomic(&target, b"hello").expect("write");
        assert_eq!(fs::read(&target).unwrap(), b"hello");
        assert!(!leftover_temps(target.parent().unwrap()), "temp file must be renamed away");
    }

    #[test]
    fn write_atomic_replaces_existing_content() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("data.enc");
        write_atomic(&target, b"first").expect("write");
        write_atomic(&target, b"second").expect("rewrite");
        assert_eq!(fs::read(&target).unwrap(), b"second");
    }

    /// True when any staging file survives in `dir`.
    fn leftover_temps(dir: &Path) -> bool {
        fs::read_dir(dir)
            .map(|entries| {
                entries.filter_map(Result::ok).any(|e| {
                    e.file_name().to_string_lossy().ends_with(".tmp")
                })
            })
            .unwrap_or(false)
    }

    #[test]
    fn temp_path_keeps_the_full_target_name_as_its_prefix() {
        // `with_extension("tmp")` would turn `audit.log.enc` into `audit.log.tmp`,
        // which is a different file's name pattern; append instead.
        let p = Path::new("/x/audit.log.enc");
        let tmp = tmp_path(p);
        let name = tmp.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("audit.log.enc."), "{name}");
        assert!(name.ends_with(".tmp"), "{name}");
        assert_eq!(tmp.parent(), p.parent());
    }

    #[test]
    fn every_write_stages_under_its_own_name() {
        // Two writers sharing `<target>.tmp` is what let one truncate the
        // other's staging file and then publish a half-written inode.
        let p = Path::new("/x/settings.enc");
        let a = tmp_path(p);
        let b = tmp_path(p);
        assert_ne!(a, b, "two writes must not share a staging path");
        assert!(a.to_string_lossy().contains(&std::process::id().to_string()));
    }

    #[test]
    fn a_failed_write_leaves_no_staging_file() {
        // The target is a directory, so the rename cannot succeed.
        let dir = tempdir().unwrap();
        let target = dir.path().join("occupied");
        fs::create_dir(&target).unwrap();
        assert!(write_atomic(&target, b"x").is_err());
        assert!(!leftover_temps(dir.path()), "staging file left behind after a failure");
    }
}
