//! Crash-safe file writes for vault-backed data (#272).
//!
//! `fs::write` only reaches the page cache: an OS crash or power loss can leave
//! a rename pointing at bytes that never hit the disk, losing the whole file
//! rather than one update. Everything that must survive that goes through here.

use std::fs;
use std::io::Write;
use std::path::Path;

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
    {
        let mut file =
            fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("fsync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} → {}: {e}", tmp.display(), path.display()))?;
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

fn tmp_path(path: &Path) -> std::path::PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
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
        assert!(!tmp_path(&target).exists(), "temp file must be renamed away");
    }

    #[test]
    fn write_atomic_replaces_existing_content() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("data.enc");
        write_atomic(&target, b"first").expect("write");
        write_atomic(&target, b"second").expect("rewrite");
        assert_eq!(fs::read(&target).unwrap(), b"second");
    }

    #[test]
    fn temp_path_keeps_the_full_name_so_it_never_collides_with_the_target() {
        // `with_extension("tmp")` would turn `audit.log.enc` into `audit.log.tmp`,
        // which is a different file's name pattern; append instead.
        let p = Path::new("/x/audit.log.enc");
        assert_eq!(tmp_path(p), Path::new("/x/audit.log.enc.tmp"));
    }
}
