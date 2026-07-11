//! Pinned MongoDB tool manifest, platform selection, checksum verification,
//! archive extraction helpers, and the download/verify/extract/probe install
//! pipeline that turns a manifest entry into a managed, ready-to-run tool
//! (run as a cancellable background task from `lib.rs`).

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::db::tasks::{fail_task, finish_task, now_ms, update_task};
use crate::state::{AppState, LockExt};
use crate::TaskInfo;

/// Supported host operating systems for tool artifacts.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Os {
    Macos,
    Windows,
    Linux,
}

/// Supported host architectures for tool artifacts.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Arch {
    Arm64,
    X64,
}

/// Archive container format for a pinned artifact.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ArchiveKind {
    Zip,
    Tgz,
}

/// A single platform-specific downloadable artifact for a pinned tool.
#[derive(Debug)]
pub struct PinnedArtifact {
    pub os: Os,
    pub arch: Arch,
    pub url: &'static str,
    pub sha256: &'static str,
    pub archive: ArchiveKind,
    /// Path of the directory (inside the extracted archive) that contains the
    /// tool's binaries, e.g. `mongosh-2.9.2-darwin-arm64/bin`.
    pub bin_subpath: &'static str,
}

/// A pinned tool: a fixed name/version plus one artifact per supported
/// platform.
pub struct PinnedTool {
    pub name: &'static str,
    pub version: &'static str,
    pub binaries: &'static [&'static str],
    pub artifacts: &'static [PinnedArtifact],
}

/// The compiled-in manifest of tools MQLens knows how to install.
///
/// Values (URLs, sha256 digests, bin_subpaths) are transcribed verbatim from
/// the resolved manifest in `docs/superpowers/plans/2026-07-06-guided-tool-setup.md`.
pub const PINNED_TOOLS: [PinnedTool; 2] = [
    PinnedTool {
        name: "database-tools",
        version: "100.17.0",
        binaries: &["mongodump", "mongorestore"],
        artifacts: &[
            PinnedArtifact {
                os: Os::Macos,
                arch: Arch::Arm64,
                url: "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-macos-arm64-100.17.0.zip",
                sha256: "099691c9059b25504a1b318bc31b3b9bd965ff78ce6b9f629090f89b25539dac",
                archive: ArchiveKind::Zip,
                bin_subpath: "mongodb-database-tools-macos-arm64-100.17.0/bin",
            },
            PinnedArtifact {
                os: Os::Macos,
                arch: Arch::X64,
                url: "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-macos-x86_64-100.17.0.zip",
                sha256: "b488e12a3e2399f8ee3ba0abf6da54dbac1bda678c230963edaa7c435887ae99",
                archive: ArchiveKind::Zip,
                bin_subpath: "mongodb-database-tools-macos-x86_64-100.17.0/bin",
            },
            PinnedArtifact {
                os: Os::Windows,
                arch: Arch::X64,
                url: "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-windows-x86_64-100.17.0.zip",
                sha256: "07b8fca56272397490102051edad4aeadc79369365ffdcda4ff70b4549512c5b",
                archive: ArchiveKind::Zip,
                bin_subpath: "mongodb-database-tools-windows-x86_64-100.17.0/bin",
            },
            PinnedArtifact {
                os: Os::Linux,
                arch: Arch::X64,
                url: "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2204-x86_64-100.17.0.tgz",
                sha256: "f30d0b3115cc31b1f360af2341a794d890c74ceb41e5a4931d3b945efeeb628e",
                archive: ArchiveKind::Tgz,
                bin_subpath: "mongodb-database-tools-ubuntu2204-x86_64-100.17.0/bin",
            },
        ],
    },
    PinnedTool {
        name: "mongosh",
        version: "2.9.2",
        binaries: &["mongosh"],
        artifacts: &[
            PinnedArtifact {
                os: Os::Macos,
                arch: Arch::Arm64,
                url: "https://github.com/mongodb-js/mongosh/releases/download/v2.9.2/mongosh-2.9.2-darwin-arm64.zip",
                sha256: "386392be90e5ff4b827d8c21cc828ff6f82cdbc045a6f6a7eb8bc3c641c9181f",
                archive: ArchiveKind::Zip,
                bin_subpath: "mongosh-2.9.2-darwin-arm64/bin",
            },
            PinnedArtifact {
                os: Os::Macos,
                arch: Arch::X64,
                url: "https://github.com/mongodb-js/mongosh/releases/download/v2.9.2/mongosh-2.9.2-darwin-x64.zip",
                sha256: "56c5c0b36213335ac375c9a5e2a8ebbdc3910ebe73019c24fa02a24dbdc68b86",
                archive: ArchiveKind::Zip,
                bin_subpath: "mongosh-2.9.2-darwin-x64/bin",
            },
            PinnedArtifact {
                os: Os::Windows,
                arch: Arch::X64,
                url: "https://github.com/mongodb-js/mongosh/releases/download/v2.9.2/mongosh-2.9.2-win32-x64.zip",
                sha256: "1e9b505f78830a717bfc8c22d6a904cc68e3aa5a3b47fe1453a9eb2ed400fbc0",
                archive: ArchiveKind::Zip,
                bin_subpath: "mongosh-2.9.2-win32-x64/bin",
            },
            PinnedArtifact {
                os: Os::Linux,
                arch: Arch::X64,
                url: "https://github.com/mongodb-js/mongosh/releases/download/v2.9.2/mongosh-2.9.2-linux-x64.tgz",
                sha256: "b0febe385c10c9be755c29095ffa95a42bed16ea6625ea3fbde36ae33b42da79",
                archive: ArchiveKind::Tgz,
                bin_subpath: "mongosh-2.9.2-linux-x64/bin",
            },
        ],
    },
];

/// Detects the current host's OS/arch pair via `cfg!` checks.
pub fn current_platform() -> (Os, Arch) {
    let os = if cfg!(target_os = "macos") {
        Os::Macos
    } else if cfg!(target_os = "windows") {
        Os::Windows
    } else {
        Os::Linux
    };
    let arch = if cfg!(target_arch = "aarch64") {
        Arch::Arm64
    } else {
        Arch::X64
    };
    (os, arch)
}

/// Selects the artifact matching `os`/`arch` from `tool`'s manifest.
pub fn select_artifact(tool: &PinnedTool, os: Os, arch: Arch) -> Result<&'static PinnedArtifact, String> {
    tool.artifacts
        .iter()
        .find(|a| a.os == os && a.arch == arch)
        .ok_or_else(|| format!("{} is not supported on {:?}/{:?}", tool.name, os, arch))
}

/// Looks up a pinned tool by name.
pub fn find_pinned_tool(name: &str) -> Result<&'static PinnedTool, String> {
    PINNED_TOOLS
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| format!("unknown tool: {name}"))
}

/// Returns the lowercase hex SHA-256 digest of `bytes`.
#[allow(dead_code)] // used by Task 2
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

/// Streams `path` through SHA-256 (8 KiB buffer) and compares against
/// `expected_hex`. Returns an error containing "checksum mismatch" on
/// mismatch.
pub fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = hex_encode(&hasher.finalize());
    if actual.eq_ignore_ascii_case(expected_hex) {
        Ok(())
    } else {
        Err(format!(
            "checksum mismatch for {}: expected {expected_hex}, got {actual}",
            path.display()
        ))
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Extracts `archive` (of `kind`) into `dest_dir`, creating it if needed.
///
/// Zip entries are sandboxed via `enclosed_name()` (rejecting `..`/absolute
/// paths); unix file modes are restored when present in the zip entry.
/// Tgz entries are sandboxed by `tar::Archive::unpack`'s built-in guard.
pub fn extract_archive(archive: &Path, kind: ArchiveKind, dest_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("failed to create {}: {e}", dest_dir.display()))?;
    match kind {
        ArchiveKind::Zip => extract_zip(archive, dest_dir),
        ArchiveKind::Tgz => extract_tgz(archive, dest_dir),
    }
}

fn extract_zip(archive: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("failed to open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("invalid zip {}: {e}", archive.display()))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("failed to read zip entry {i}: {e}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            // Skip entries with unsafe paths (e.g. containing "..") instead of
            // failing the whole extraction.
            continue;
        };
        let out_path = dest_dir.join(enclosed);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("failed to create dir {}: {e}", out_path.display()))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("failed to create dir {}: {e}", parent.display()))?;
        }

        let mut out_file =
            std::fs::File::create(&out_path).map_err(|e| format!("failed to create {}: {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("failed to write {}: {e}", out_path.display()))?;

        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

fn extract_tgz(archive: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("failed to open {}: {e}", archive.display()))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar_archive = tar::Archive::new(decoder);
    tar_archive
        .unpack(dest_dir)
        .map_err(|e| format!("failed to extract {}: {e}", archive.display()))?;
    Ok(())
}

/// `{app_data}/tools`
pub fn managed_tools_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tools")
}

/// `{app_data}/tools/{name}-{version}`
pub fn managed_install_dir(app_data_dir: &Path, tool: &PinnedTool) -> PathBuf {
    install_dir_for(app_data_dir, tool.name, tool.version)
}

/// `{app_data}/tools/{name}-{version}/bin` — platform-free; the install
/// pipeline moves the archive's `bin_subpath` contents here regardless of the
/// archive's internal top-level directory name.
pub fn managed_bin_dir(app_data_dir: &Path, tool: &PinnedTool) -> PathBuf {
    bin_dir_for(app_data_dir, tool.name, tool.version)
}

fn install_dir_for(app_data_dir: &Path, name: &str, version: &str) -> PathBuf {
    managed_tools_dir(app_data_dir).join(format!("{name}-{version}"))
}

fn bin_dir_for(app_data_dir: &Path, name: &str, version: &str) -> PathBuf {
    install_dir_for(app_data_dir, name, version).join("bin")
}

fn binary_file_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Resolve the `mongosh` executable to invoke: a non-empty (trimmed)
/// `configured` path wins outright (even if the file turns out not to
/// exist — the caller's spawn will surface that error); otherwise, if the
/// managed `mongosh` install's binary exists under `app_data_dir`, its path
/// is used; otherwise fall back to the bare `"mongosh"` (resolved via `PATH`
/// by the caller's process spawn).
pub fn resolve_mongosh_executable(configured: &str, app_data_dir: Option<&Path>) -> String {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }

    if let Some(app_data_dir) = app_data_dir {
        if let Ok(tool) = find_pinned_tool("mongosh") {
            let candidate = managed_bin_dir(app_data_dir, tool).join(binary_file_name("mongosh"));
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }

    "mongosh".to_string()
}

/// One working mongosh binary found by [`detect_mongosh`], with where it came
/// from so the UI can phrase the offer ("found on PATH", "managed install").
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MongoshDetection {
    pub path: String,
    pub version: String,
    /// "configured" | "managed" | "path" | "common"
    pub source: String,
}

/// Run `path --version` and return the first output line, or `None` when the
/// binary is missing, not executable, or exits non-zero.
fn probe_version(path: &Path) -> Option<String> {
    let out = std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

/// Well-known install locations probed after PATH — covers packaged-app
/// launches where the login-shell PATH merge didn't help (notably Windows,
/// which has no `path_env` equivalent).
fn common_mongosh_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            dirs.push(PathBuf::from(pf).join("mongosh"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Programs").join("mongosh"));
        }
    }
    #[cfg(not(windows))]
    {
        dirs.extend(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"]
                .iter()
                .map(PathBuf::from),
        );
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".local/bin"));
        }
    }
    dirs
}

/// Find a working mongosh, probing (in order) the configured path, the
/// managed install, every PATH entry, and finally `common_mongosh_dirs()`
/// plus `extra_dirs` (tests inject temp dirs there). Unlike
/// [`resolve_mongosh_executable`] — which decides what to *spawn* — this
/// verifies each candidate actually runs, for the shell's guided-setup card.
pub fn detect_mongosh(
    configured: &str,
    app_data_dir: Option<&Path>,
    extra_dirs: &[PathBuf],
) -> Option<MongoshDetection> {
    let hit = |path: &Path, source: &str| -> Option<MongoshDetection> {
        probe_version(path).map(|version| MongoshDetection {
            path: path.to_string_lossy().into_owned(),
            version,
            source: source.to_string(),
        })
    };

    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        if let Some(found) = hit(Path::new(trimmed), "configured") {
            return Some(found);
        }
    }

    let bin_name = binary_file_name("mongosh");
    if let Some(app_data_dir) = app_data_dir {
        if let Ok(tool) = find_pinned_tool("mongosh") {
            if let Some(found) = hit(&managed_bin_dir(app_data_dir, tool).join(&bin_name), "managed") {
                return Some(found);
            }
        }
    }

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if let Some(found) = hit(&dir.join(&bin_name), "path") {
                return Some(found);
            }
        }
    }

    for dir in common_mongosh_dirs().iter().chain(extra_dirs) {
        if let Some(found) = hit(&dir.join(&bin_name), "common") {
            return Some(found);
        }
    }

    None
}

/// Runs `path --version`, treating any spawn failure or non-zero exit as
/// "not usable" — the safety net after extraction, and the check
/// `managed_tools_status` uses to decide `installed`.
fn probe_binary_ok(path: &Path) -> bool {
    std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Time allowed for a `--version` probe during an install before it counts as
/// failed — a wedged binary must not block the install task forever.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// [`probe_binary_ok`] on a blocking thread with a hard timeout, used by the
/// async install flow (a timed-out probe counts as failure).
/// `managed_tools_status` keeps the plain synchronous probe.
async fn probe_binary_ok_timeout(path: &Path) -> bool {
    let path = path.to_path_buf();
    let probe = tokio::task::spawn_blocking(move || probe_binary_ok(&path));
    matches!(tokio::time::timeout(PROBE_TIMEOUT, probe).await, Ok(Ok(true)))
}

/// Staging directories (one per tool name + app data dir) with an install
/// currently in flight. Guards against two concurrent installs of the same
/// tool corrupting each other's staging dir or a just-completed install.
static IN_FLIGHT_INSTALLS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn in_flight_installs() -> &'static Mutex<HashSet<PathBuf>> {
    IN_FLIGHT_INSTALLS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// RAII registration of one in-flight install, keyed by its staging dir.
/// Acquiring fails when the same tool is already being installed into the
/// same app data dir; dropping releases the slot on every exit path.
struct InstallGuard {
    key: PathBuf,
}

impl InstallGuard {
    fn acquire(name: &str, staging_dir: &Path) -> Result<Self, String> {
        let mut in_flight = in_flight_installs()
            .lock()
            .map_err(|_| "in-flight install registry lock poisoned".to_string())?;
        if !in_flight.insert(staging_dir.to_path_buf()) {
            return Err(format!("{name} is already being installed"));
        }
        Ok(Self { key: staging_dir.to_path_buf() })
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Ok(mut in_flight) = in_flight_installs().lock() {
            in_flight.remove(&self.key);
        }
    }
}

/// Installed/available status for one pinned tool, reported to the frontend
/// (camelCase over IPC).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedToolStatus {
    pub name: String,
    pub version: String,
    pub installed: bool,
    pub path: Option<String>,
}

/// Status for every pinned tool: `installed` requires the managed bin dir to
/// exist AND every one of the tool's binaries to probe `--version`
/// successfully (a stale or partially-removed install reports
/// `installed: false`).
pub fn managed_tools_status(app_data_dir: &Path) -> Vec<ManagedToolStatus> {
    PINNED_TOOLS
        .iter()
        .map(|tool| {
            let bin_dir = managed_bin_dir(app_data_dir, tool);
            let installed = bin_dir.is_dir()
                && tool
                    .binaries
                    .iter()
                    .all(|b| probe_binary_ok(&bin_dir.join(binary_file_name(b))));
            ManagedToolStatus {
                name: tool.name.to_string(),
                version: tool.version.to_string(),
                installed,
                path: if installed { Some(bin_dir.to_string_lossy().into_owned()) } else { None },
            }
        })
        .collect()
}

/// A tool resolved to concrete, owned download coordinates: either from the
/// real (network-backed) [`PINNED_TOOLS`] manifest, or — in test builds only
/// — from the [`test_support`] registry, so tests never need real network
/// access or a `'static` synthetic [`PinnedTool`].
#[derive(Clone, Debug)]
pub(crate) struct ResolvedTool {
    name: String,
    version: String,
    url: String,
    sha256: String,
    archive: ArchiveKind,
    bin_subpath: String,
    binaries: Vec<String>,
}

fn resolve_tool(name: &str) -> Result<ResolvedTool, String> {
    #[cfg(test)]
    if let Some(tool) = test_support::lookup(name) {
        return Ok(tool);
    }
    let tool = find_pinned_tool(name)?;
    let (os, arch) = current_platform();
    let artifact = select_artifact(tool, os, arch)?;
    Ok(ResolvedTool {
        name: tool.name.to_string(),
        version: tool.version.to_string(),
        url: artifact.url.to_string(),
        sha256: artifact.sha256.to_string(),
        archive: artifact.archive,
        bin_subpath: artifact.bin_subpath.to_string(),
        binaries: tool.binaries.iter().map(|s| s.to_string()).collect(),
    })
}

/// Test seam: when `base_url_override` is `Some`, rewrite `url` to
/// `{override}/{original file name}` so tests can redirect a real (or
/// test-registered) artifact URL to a local server without touching the
/// checksum, archive kind, or bin layout.
fn apply_base_url_override(url: &str, base_url_override: Option<&str>) -> String {
    match base_url_override {
        Some(base) => {
            let file_name = url.rsplit('/').next().unwrap_or(url);
            format!("{}/{}", base.trim_end_matches('/'), file_name)
        }
        None => url.to_string(),
    }
}

/// Time allowed to establish the download connection.
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Time allowed for the response headers, and for each streamed chunk, to
/// arrive — a stalled server fails the download instead of hanging the task
/// forever (cancel is only checked between chunks).
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Hard cap on artifact size while streaming; the real pinned artifacts are
/// all well under 200 MB, so anything past this is aborted as an error.
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

/// Streams `url` to `dest`, checking `cancel` before requesting each chunk
/// and reporting `("downloading", bytes_so_far, content_length)` after every
/// chunk is written to disk. Connect/read timeouts and the
/// [`MAX_DOWNLOAD_BYTES`] cap all surface as ordinary download errors.
async fn download_to_file(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    progress: &mut impl FnMut(&str, u64, Option<u64>),
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let mut resp = tokio::time::timeout(DOWNLOAD_READ_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| format!("timed out downloading {url}"))?
        .map_err(|e| format!("failed to download {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("failed to download {url}: HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    if total.is_some_and(|t| t > MAX_DOWNLOAD_BYTES) {
        return Err(format!(
            "refusing to download {url}: {} bytes exceeds the {MAX_DOWNLOAD_BYTES} byte limit",
            total.unwrap_or(0)
        ));
    }
    let mut file =
        std::fs::File::create(dest).map_err(|e| format!("failed to create {}: {e}", dest.display()))?;
    let mut processed: u64 = 0;
    progress("downloading", processed, total);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }
        let chunk = tokio::time::timeout(DOWNLOAD_READ_TIMEOUT, resp.chunk())
            .await
            .map_err(|_| format!("timed out downloading {url}"))?
            .map_err(|e| format!("failed to download {url}: {e}"))?;
        match chunk {
            Some(bytes) => {
                file.write_all(&bytes)
                    .map_err(|e| format!("failed to write {}: {e}", dest.display()))?;
                processed += bytes.len() as u64;
                if processed > MAX_DOWNLOAD_BYTES {
                    return Err(format!("download of {url} exceeded the {MAX_DOWNLOAD_BYTES} byte limit"));
                }
                progress("downloading", processed, total);
            }
            None => break,
        }
    }
    Ok(())
}

/// Download → verify → extract → move-into-place → probe one tool. The
/// directly-testable unit of work behind [`start_tool_install_task_impl`]
/// (mirroring how `db::import::run_import` is factored out from its task
/// wrapper): callers pass plain, owned parameters — no `'static`
/// [`PinnedTool`] required.
///
/// On any error (including cancellation, which surfaces as `Err("Cancelled")`
/// so the caller can distinguish it from a real failure), the staging
/// directory is removed before returning. A pre-existing install directory is
/// left untouched — it is removed only when the final swap into it fails
/// after this run has already started mutating it.
///
/// At most one install per tool (per app data dir) may be in flight at a
/// time; a second concurrent call fails with an "already being installed"
/// error instead of corrupting the first one's staging dir.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn install_one_tool(
    app_data_dir: &Path,
    name: &str,
    version: &str,
    url: &str,
    sha256: &str,
    archive: ArchiveKind,
    bin_subpath: &str,
    binaries: &[String],
    cancel: &AtomicBool,
    mut progress: impl FnMut(&str, u64, Option<u64>),
) -> Result<(), String> {
    let staging_dir = managed_tools_dir(app_data_dir).join(format!(".staging-{name}"));
    let install_dir = install_dir_for(app_data_dir, name, version);

    // NOTE: acquired before any filesystem mutation, and returning here must
    // not touch the staging dir — it belongs to the in-flight install.
    let _guard = InstallGuard::acquire(name, &staging_dir)?;

    let cleanup = |staging_dir: &Path, msg: String| -> String {
        let _ = std::fs::remove_dir_all(staging_dir);
        msg
    };

    // Clear any stale staging left by a previous failed attempt.
    let _ = std::fs::remove_dir_all(&staging_dir);
    if let Err(e) = std::fs::create_dir_all(&staging_dir) {
        return Err(cleanup(&staging_dir, format!("failed to create {}: {e}", staging_dir.display())));
    }

    let archive_path = staging_dir.join("archive");
    if let Err(e) = download_to_file(url, &archive_path, cancel, &mut progress).await {
        return Err(cleanup(&staging_dir, e));
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(cleanup(&staging_dir, "Cancelled".to_string()));
    }

    progress("verifying", 0, None);
    let verified = {
        let archive_path = archive_path.clone();
        let sha256 = sha256.to_string();
        tokio::task::spawn_blocking(move || verify_sha256(&archive_path, &sha256))
            .await
            .map_err(|e| format!("verify task failed: {e}"))
            .and_then(|r| r)
    };
    if let Err(e) = verified {
        return Err(cleanup(&staging_dir, e));
    }

    progress("extracting", 0, None);
    let extracted_dir = staging_dir.join("extracted");
    let extracted = {
        let archive_path = archive_path.clone();
        let extracted_dir = extracted_dir.clone();
        tokio::task::spawn_blocking(move || extract_archive(&archive_path, archive, &extracted_dir))
            .await
            .map_err(|e| format!("extract task failed: {e}"))
            .and_then(|r| r)
    };
    if let Err(e) = extracted {
        return Err(cleanup(&staging_dir, e));
    }

    let extracted_bin = extracted_dir.join(bin_subpath);
    if !extracted_bin.is_dir() {
        return Err(cleanup(
            &staging_dir,
            format!("archive did not contain the expected {}", bin_subpath),
        ));
    }

    // Set exec bits and probe `--version` on the STAGING copy first, before
    // any part of the managed install dir exists. This way a binary that
    // fails to run (corrupt archive, wrong architecture, etc.) never leaves
    // behind a half-installed managed dir — the atomic rename below is the
    // last, and only, fallible step that touches it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for b in binaries {
            let _ =
                std::fs::set_permissions(extracted_bin.join(binary_file_name(b)), std::fs::Permissions::from_mode(0o755));
        }
    }

    progress("checking", 0, None);
    for b in binaries {
        let bin_path = extracted_bin.join(binary_file_name(b));
        if !probe_binary_ok_timeout(&bin_path).await {
            return Err(cleanup(
                &staging_dir,
                format!("{} failed to run --version", bin_path.display()),
            ));
        }
    }

    if let Err(e) = std::fs::create_dir_all(&install_dir) {
        return Err(cleanup(&staging_dir, format!("failed to create {}: {e}", install_dir.display())));
    }
    let dest_bin = install_dir.join("bin");
    let _ = std::fs::remove_dir_all(&dest_bin);
    if let Err(e) = std::fs::rename(&extracted_bin, &dest_bin) {
        // This run already started mutating the install dir (its old bin dir,
        // if any, is gone), so a half-swapped dir must not survive to look
        // like a working install. This is the only failure path allowed to
        // remove the install dir.
        let _ = std::fs::remove_dir_all(&install_dir);
        return Err(cleanup(
            &staging_dir,
            format!("failed to move {} into place: {e}", extracted_bin.display()),
        ));
    }

    let _ = std::fs::remove_dir_all(&staging_dir);
    Ok(())
}

/// Start a cancellable background task that installs (or re-installs, when
/// `force`) each of `tools` (by [`PinnedTool::name`]) for the current
/// platform. `base_url_override` is a test seam only — the
/// `start_tool_install_task` Tauri command always passes `None`.
pub async fn start_tool_install_task_impl(
    state: &AppState,
    app_data_dir: PathBuf,
    tools: Vec<String>,
    force: bool,
    base_url_override: Option<String>,
) -> Result<TaskInfo, String> {
    if tools.is_empty() {
        return Err("No tools specified".to_string());
    }
    // Resolve every requested tool up front so an unknown/unsupported name
    // fails synchronously instead of surfacing only after the task starts.
    let mut resolved = Vec::with_capacity(tools.len());
    for name in &tools {
        resolved.push(resolve_tool(name)?);
    }

    let names = tools.join(", ");
    let task_id = Uuid::new_v4().to_string();
    let task = TaskInfo {
        id: task_id.clone(),
        kind: "tool_install".to_string(),
        label: format!("Install MongoDB tools ({names})"),
        status: "running".to_string(),
        processed: 0,
        total: None,
        message: "Queued".to_string(),
        path: None,
        error: None,
        created_at_ms: now_ms(),
        finished_at_ms: None,
        sub_label: None,
        items_processed: None,
        items_total: None,
        summary: None,
    };
    state.tasks.lock_safe()?.insert(task_id.clone(), task.clone());
    let cancel = state.register_cancel(&task_id);

    let tasks = state.tasks.clone();
    let cancels = state.cancels.clone();
    let task_id2 = task_id.clone();
    tokio::spawn(async move {
        run_tool_install_task(tasks, cancels, task_id2, cancel, app_data_dir, resolved, force, base_url_override)
            .await;
    });

    Ok(task)
}

/// Drive one tool-install task to completion: install each tool in order,
/// updating task status on every exit path (success/failure/cancel), and
/// always clean up the cancel-flag entry (mirrors
/// `db::mongotools::run_tool_task`'s discipline).
#[allow(clippy::too_many_arguments)]
async fn run_tool_install_task(
    tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    task_id: String,
    cancel: Arc<AtomicBool>,
    app_data_dir: PathBuf,
    tools: Vec<ResolvedTool>,
    force: bool,
    base_url_override: Option<String>,
) {
    let mut installed_names: Vec<String> = Vec::new();
    let mut skip_notes: Vec<String> = Vec::new();
    let mut outcome: Result<(), String> = Ok(());

    for tool in &tools {
        if cancel.load(Ordering::SeqCst) {
            outcome = Err("Cancelled".to_string());
            break;
        }

        let bin_dir = bin_dir_for(&app_data_dir, &tool.name, &tool.version);
        let mut already_installed = bin_dir.is_dir();
        if already_installed {
            for b in &tool.binaries {
                if !probe_binary_ok_timeout(&bin_dir.join(binary_file_name(b))).await {
                    already_installed = false;
                    break;
                }
            }
        }
        // `force` merely bypasses this short-circuit; the existing install is
        // only replaced by `install_one_tool`'s final swap, after the new
        // artifact has been downloaded, verified, and probed — so a failed
        // force-reinstall never leaves the user without a working tool.
        if already_installed && !force {
            let note = format!("{} already installed", tool.name);
            update_task(&tasks, &task_id, |t| t.message = note.clone());
            skip_notes.push(note);
            continue;
        }

        let url = apply_base_url_override(&tool.url, base_url_override.as_deref());
        let tasks_cb = tasks.clone();
        let task_id_cb = task_id.clone();
        let tool_name_cb = tool.name.clone();
        let mut progress = move |stage: &str, processed: u64, total: Option<u64>| {
            update_task(&tasks_cb, &task_id_cb, |t| {
                t.message = format!("{}: {}", tool_name_cb, stage);
                if stage == "downloading" {
                    t.processed = processed;
                    t.total = total;
                }
            });
        };

        let result = install_one_tool(
            &app_data_dir,
            &tool.name,
            &tool.version,
            &url,
            &tool.sha256,
            tool.archive,
            &tool.bin_subpath,
            &tool.binaries,
            &cancel,
            &mut progress,
        )
        .await;

        match result {
            Ok(()) => installed_names.push(tool.name.clone()),
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
    }

    match outcome {
        Err(e) if e == "Cancelled" => {
            update_task(&tasks, &task_id, |t| {
                t.status = "cancelled".to_string();
                t.message = "Cancelled".to_string();
                t.finished_at_ms = Some(now_ms());
            });
            crate::db::tasks::prune_tasks(&tasks);
        }
        Err(e) => fail_task(&tasks, &task_id, e),
        Ok(()) => {
            let mut parts = Vec::new();
            if !installed_names.is_empty() {
                parts.push(format!("Installed {}", installed_names.join(", ")));
            }
            parts.extend(skip_notes);
            let message = if parts.is_empty() { "Nothing to do".to_string() } else { parts.join("; ") };
            finish_task(&tasks, &task_id, tools.len() as u64, message);
        }
    }

    if let Ok(mut guard) = cancels.lock() {
        guard.remove(&task_id);
    }
}

/// Test-only helpers exposed to `tests.rs` (outside this module) for
/// exercising the install pipeline against a local HTTP server instead of the
/// real network, mirroring `db::mongotools::test_support`.
#[cfg(test)]
pub mod test_support {
    use super::{ArchiveKind, ResolvedTool};
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};

    static REGISTRY: OnceLock<Mutex<HashMap<String, ResolvedTool>>> = OnceLock::new();

    fn registry() -> &'static Mutex<HashMap<String, ResolvedTool>> {
        REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Registers (and returns) a synthetic pinned tool for tests, keyed by
    /// `name`, so `start_tool_install_task_impl`'s manifest resolution
    /// (`resolve_tool`) can find it without touching the real, network-backed
    /// `PINNED_TOOLS` manifest. Version is fixed at `"9.9.9-test"`.
    pub(crate) fn test_tool(name: &str, url: &str, sha256: &str, bin_subpath: &str, binaries: &[&str]) -> ResolvedTool {
        let tool = ResolvedTool {
            name: name.to_string(),
            version: "9.9.9-test".to_string(),
            url: url.to_string(),
            sha256: sha256.to_string(),
            archive: ArchiveKind::Zip,
            bin_subpath: bin_subpath.to_string(),
            binaries: binaries.iter().map(|s| s.to_string()).collect(),
        };
        registry().lock().unwrap().insert(name.to_string(), tool.clone());
        tool
    }

    pub(crate) fn lookup(name: &str) -> Option<ResolvedTool> {
        registry().lock().unwrap().get(name).cloned()
    }

    /// Serves `bytes` at any GET path from an ephemeral localhost port for
    /// the lifetime of the returned `Server` handle.
    pub fn serve_bytes(bytes: Vec<u8>) -> (String, std::sync::Arc<tiny_http::Server>) {
        let server = std::sync::Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let base = format!("http://{}", server.server_addr());
        let s2 = server.clone();
        std::thread::spawn(move || {
            for req in s2.incoming_requests() {
                let _ = req.respond(tiny_http::Response::from_data(bytes.clone()));
            }
        });
        (base, server)
    }

    /// Builds a zip whose layout matches a pinned artifact: `{top}/bin/{name}`
    /// for each `name`, with `script` as each entry's content. Used by
    /// [`fixture_zip`] (a script that prints a version and exits 0) and by
    /// probe-failure tests (a script that `exit`s non-zero, simulating a
    /// binary that survives extraction but fails `--version`).
    pub fn fixture_zip_with_script(top: &str, names: &[&str], script: &[u8]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            for n in names {
                z.start_file(format!("{top}/bin/{n}"), opts).unwrap();
                z.write_all(script).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    /// Builds a zip whose layout matches a pinned artifact: `{top}/bin/{name}`
    /// (a tiny executable `sh` script) for each `name`.
    pub fn fixture_zip(top: &str, names: &[&str]) -> Vec<u8> {
        fixture_zip_with_script(top, names, b"#!/bin/sh\necho tool version 9.9.9\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_covers_all_four_platforms_for_both_tools() {
        for tool in &PINNED_TOOLS {
            for (os, arch) in [(Os::Macos, Arch::Arm64), (Os::Macos, Arch::X64), (Os::Windows, Arch::X64), (Os::Linux, Arch::X64)] {
                let a = select_artifact(tool, os, arch).unwrap();
                assert!(a.url.starts_with("https://"), "{}", a.url);
                assert_eq!(a.sha256.len(), 64);
                assert!(!a.bin_subpath.is_empty());
            }
            assert!(select_artifact(tool, Os::Linux, Arch::Arm64).unwrap_err().contains("not supported on"));
        }
    }

    #[test]
    fn current_platform_selects_something_on_this_host() {
        let (os, arch) = current_platform();
        for tool in &PINNED_TOOLS {
            select_artifact(tool, os, arch).expect("host platform must be in the manifest");
        }
    }

    #[test]
    fn sha256_verify_accepts_good_and_rejects_bad() {
        let dir = std::env::temp_dir().join(format!("mqlens-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.bin");
        std::fs::write(&f, b"hello").unwrap();
        let good = sha256_hex(b"hello");
        assert_eq!(good, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        verify_sha256(&f, &good).unwrap();
        let err = verify_sha256(&f, &"0".repeat(64)).unwrap_err();
        assert!(err.contains("checksum mismatch"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_zip_and_tgz_fixtures() {
        // Build fixtures in-memory: a zip and a tgz each containing dir/bin/toolbin (content "#!x")
        let dir = std::env::temp_dir().join(format!("mqlens-extract-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let zip_path = dir.join("f.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut z = zip::ZipWriter::new(file);
            let opts: zip::write::SimpleFileOptions = Default::default();
            z.start_file("d/bin/toolbin", opts).unwrap();
            use std::io::Write;
            z.write_all(b"#!x").unwrap();
            z.finish().unwrap();
        }
        let out = dir.join("outz");
        extract_archive(&zip_path, ArchiveKind::Zip, &out).unwrap();
        assert_eq!(std::fs::read(out.join("d/bin/toolbin")).unwrap(), b"#!x");

        let tgz_path = dir.join("f.tgz");
        {
            let file = std::fs::File::create(&tgz_path).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut t = tar::Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            header.set_size(3);
            header.set_mode(0o755);
            header.set_cksum();
            t.append_data(&mut header, "d/bin/toolbin", &b"#!x"[..]).unwrap();
            t.into_inner().unwrap().finish().unwrap();
        }
        let out = dir.join("outt");
        extract_archive(&tgz_path, ArchiveKind::Tgz, &out).unwrap();
        assert_eq!(std::fs::read(out.join("d/bin/toolbin")).unwrap(), b"#!x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn managed_dirs_are_version_scoped_and_platform_free() {
        let base = Path::new("/data");
        let tool = find_pinned_tool("mongosh").unwrap();
        assert_eq!(managed_install_dir(base, tool), Path::new("/data/tools/mongosh-2.9.2"));
        assert_eq!(managed_bin_dir(base, tool), Path::new("/data/tools/mongosh-2.9.2/bin"));
        assert!(find_pinned_tool("nope").is_err());
    }

    #[test]
    fn resolve_mongosh_prefers_configured_then_managed_then_bare() {
        // configured "/x/mongosh" -> itself even if missing.
        assert_eq!(resolve_mongosh_executable("/x/mongosh", None), "/x/mongosh");
        assert_eq!(resolve_mongosh_executable("  /x/mongosh  ", None), "/x/mongosh");

        let app_data = std::env::temp_dir().join(format!(
            "mqlens-mongosh-resolve-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));

        // configured "" + no managed file -> "mongosh".
        assert_eq!(resolve_mongosh_executable("", Some(&app_data)), "mongosh");
        assert_eq!(resolve_mongosh_executable("   ", Some(&app_data)), "mongosh");
        assert_eq!(resolve_mongosh_executable("", None), "mongosh");

        // configured "" + managed file exists -> managed path.
        let tool = find_pinned_tool("mongosh").unwrap();
        let bin_dir = managed_bin_dir(&app_data, tool);
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin_name = if cfg!(windows) { "mongosh.exe" } else { "mongosh" };
        let managed_path = bin_dir.join(bin_name);
        std::fs::write(&managed_path, b"stub").unwrap();

        assert_eq!(resolve_mongosh_executable("", Some(&app_data)), managed_path.to_string_lossy());

        let _ = std::fs::remove_dir_all(&app_data);
    }

    fn test_app_data(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mqlens-toolsetup-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn write_fake_mongosh(dir: &Path, version_line: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("mongosh");
        std::fs::write(&path, format!("#!/bin/sh\necho '{version_line}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// `detect_mongosh` probes configured → managed → PATH → common locations
    /// and reports where the working binary came from, so the shell's failure
    /// card can offer "use this path" for binaries outside the configured one.
    #[cfg(unix)]
    #[test]
    fn detect_mongosh_probes_in_order_and_reports_source() {
        let base = test_app_data("detect-mongosh");

        // Nothing anywhere -> None (empty extra dirs keep PATH from mattering:
        // a real mongosh on the test machine's PATH would be reported as
        // source "path", which the assertions below tolerate).
        let empty = detect_mongosh("", None, &[base.join("nowhere")]);
        assert!(
            empty.is_none() || empty.as_ref().unwrap().source == "path",
            "unexpected detection: {empty:?}"
        );

        // A working binary in a "common" dir is found with its version.
        let common_dir = base.join("common-bin");
        write_fake_mongosh(&common_dir, "2.9.9");
        let found = detect_mongosh("", None, &[common_dir.clone()]).expect("common dir hit");
        assert!(found.source == "common" || found.source == "path");
        if found.source == "common" {
            assert_eq!(found.version, "2.9.9");
            assert_eq!(found.path, common_dir.join("mongosh").to_string_lossy());
        }

        // A configured binary wins over everything else.
        let configured_dir = base.join("configured-bin");
        let configured = write_fake_mongosh(&configured_dir, "3.0.0");
        let found = detect_mongosh(configured.to_str().unwrap(), None, &[common_dir.clone()])
            .expect("configured hit");
        assert_eq!(found.source, "configured");
        assert_eq!(found.version, "3.0.0");

        // A broken configured path falls through to the next tier.
        let found = detect_mongosh(
            base.join("missing/mongosh").to_str().unwrap(),
            None,
            &[common_dir.clone()],
        )
        .expect("fallback hit");
        assert_ne!(found.source, "configured");

        // The managed install beats common dirs.
        let tool = find_pinned_tool("mongosh").unwrap();
        let managed = managed_bin_dir(&base, tool);
        write_fake_mongosh(&managed, "2.9.2");
        let found = detect_mongosh("", Some(&base), &[common_dir]).expect("managed hit");
        assert_eq!(found.source, "managed");
        assert_eq!(found.version, "2.9.2");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Polls the task map until `task_id` leaves "running", returning its
    /// final snapshot (local sibling of `tests.rs`'s `wait_for_task`).
    async fn wait_for_task_done(state: &AppState, task_id: &str) -> TaskInfo {
        for _ in 0..1500 {
            if let Some(t) = state.tasks.lock().unwrap().get(task_id).cloned() {
                if t.status != "running" {
                    return t;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("task {task_id} did not finish");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_installs_of_same_tool_one_succeeds_one_is_rejected() {
        use test_support::{fixture_zip, serve_bytes};

        let bytes = fixture_zip("mongosh-2.9.2-darwin-arm64", &["mongosh"]);
        let sha256 = sha256_hex(&bytes);
        let (base_url, _server) = serve_bytes(bytes);
        let url = format!("{base_url}/mongosh-2.9.2-darwin-arm64.zip");

        let app_data = test_app_data("concurrent");
        let binaries = vec!["mongosh".to_string()];
        let cancel_a = AtomicBool::new(false);
        let cancel_b = AtomicBool::new(false);

        // `join!` polls A first: A registers the in-flight guard before its
        // first await (the download), so B's guard acquisition — also before
        // any await — deterministically sees A in flight and must fail
        // without touching A's staging dir.
        let fut_a = install_one_tool(
            &app_data,
            "mongosh",
            "2.9.2",
            &url,
            &sha256,
            ArchiveKind::Zip,
            "mongosh-2.9.2-darwin-arm64/bin",
            &binaries,
            &cancel_a,
            |_, _, _| {},
        );
        let fut_b = install_one_tool(
            &app_data,
            "mongosh",
            "2.9.2",
            &url,
            &sha256,
            ArchiveKind::Zip,
            "mongosh-2.9.2-darwin-arm64/bin",
            &binaries,
            &cancel_b,
            |_, _, _| {},
        );
        let results = tokio::join!(fut_a, fut_b);
        let results = [results.0, results.1];

        let oks = results.iter().filter(|r| r.is_ok()).count();
        assert_eq!(oks, 1, "exactly one install must win: {results:?}");
        let err = results.iter().find_map(|r| r.as_ref().err()).unwrap();
        assert!(err.contains("already being installed"), "{err}");

        // The winner's install must survive intact.
        let bin = app_data.join("tools/mongosh-2.9.2/bin/mongosh");
        assert!(bin.exists(), "installed binary must survive the rejected concurrent attempt");
        assert!(probe_binary_ok(&bin), "installed binary must still run --version");
        assert!(
            !app_data.join("tools/.staging-mongosh").exists(),
            "staging dir should be cleaned up after the winning install"
        );
        // The guard slot must be released on every exit path.
        assert!(
            !in_flight_installs().lock().unwrap().contains(&app_data.join("tools/.staging-mongosh")),
            "in-flight guard must be released"
        );

        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn force_reinstall_keeps_existing_install_when_download_fails() {
        use test_support::{fixture_zip, serve_bytes, test_tool};

        let bytes = fixture_zip("test-force-tool-9.9.9-test", &["mongoforce"]);
        let sha256 = sha256_hex(&bytes);
        let (base_url, _server) = serve_bytes(bytes);
        test_tool(
            "test-force-tool",
            "https://example.invalid/test-force-tool-fixture.zip",
            &sha256,
            "test-force-tool-9.9.9-test/bin",
            &["mongoforce"],
        );

        let app_data = test_app_data("force-fail");
        let state = AppState::new();

        // First install succeeds.
        let task = start_tool_install_task_impl(
            &state,
            app_data.clone(),
            vec!["test-force-tool".to_string()],
            false,
            Some(base_url),
        )
        .await
        .unwrap();
        let t = wait_for_task_done(&state, &task.id).await;
        assert_eq!(t.status, "completed", "{:?}", t.error);
        let bin = bin_dir_for(&app_data, "test-force-tool", "9.9.9-test").join("mongoforce");
        assert!(probe_binary_ok(&bin), "initial install must probe ok");

        // Force reinstall against a dead server (connection refused): the
        // download fails, and the existing install must survive untouched.
        let dead_port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let task2 = start_tool_install_task_impl(
            &state,
            app_data.clone(),
            vec!["test-force-tool".to_string()],
            true,
            Some(format!("http://127.0.0.1:{dead_port}")),
        )
        .await
        .unwrap();
        let t2 = wait_for_task_done(&state, &task2.id).await;
        assert_eq!(t2.status, "failed", "{t2:?}");
        assert!(
            t2.error.as_deref().unwrap_or("").contains("failed to download"),
            "{:?}",
            t2.error
        );

        assert!(bin.exists(), "old install must survive a failed force reinstall");
        assert!(probe_binary_ok(&bin), "old install must still probe as installed");

        let _ = std::fs::remove_dir_all(&app_data);
    }
}
