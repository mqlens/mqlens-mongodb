//! Resolve the user's real shell `PATH` so the released (Finder/Dock-launched)
//! app can find CLI tools (`claude`, `codex`, `cursor-agent`, `mongosh`, …) the
//! same way the user's terminal does.
//!
//! Why this exists: a macOS/Linux GUI app launched by `launchd` (Finder, Dock,
//! Spotlight) inherits a minimal `PATH` — on macOS just `/usr/bin:/bin:/usr/sbin:/sbin`.
//! Tools installed via Homebrew, npm/nvm, `~/.local/bin`, bun, cargo, etc. live
//! outside that, so `Command::new("claude")` fails with `NotFound`. In `tauri dev`
//! the app is launched from a terminal and inherits the full shell `PATH`, which
//! is why this only bites the packaged build.
//!
//! Fix: at startup, ask the user's login shell for its `PATH` (which sources
//! `.zshrc`/`.profile` and so picks up nvm/asdf/custom dirs), merge a static set
//! of common install dirs as a fallback, and apply the result to our own process
//! env. Because child `Command`s inherit the parent env, both agent detection and
//! agent execution then resolve binaries exactly as the terminal would.

#[cfg(unix)]
use std::path::{Path, PathBuf};

/// Markers wrapped around the printed `$PATH` so interactive-shell banner noise
/// (anything an rc file echoes on startup) can't be mistaken for PATH content.
#[cfg(unix)]
const BEGIN: &str = "__MQLENS_PATH_BEGIN__";
#[cfg(unix)]
const END: &str = "__MQLENS_PATH_END__";

/// Resolve the real user `PATH` and apply it to this process. Call once, early,
/// on the main thread (before any threads spawn children) so `set_var` is sound.
/// No-op on non-unix platforms, where GUI apps already inherit a usable `PATH`.
pub fn ensure_user_path() {
    #[cfg(unix)]
    {
        let current = std::env::var("PATH").unwrap_or_default();
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let shell_path = login_shell_path();
        let merged = merge_paths(shell_path.as_deref(), &current, home.as_deref());
        // SAFETY: edition 2021 — `set_var` is safe. Called from `run()` on the
        // main thread before the Tauri builder spawns any worker threads.
        std::env::set_var("PATH", merged);
    }
}

/// Ask the user's login+interactive shell to print its `PATH`. Returns `None` if
/// `$SHELL` is unset/fails — the static fallback in `merge_paths` then covers us.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    // -i interactive (sources .zshrc/.bashrc where nvm/asdf usually live),
    // -l login (sources .zprofile/.profile), -c runs the command then exits.
    let script = format!("printf '%s%s%s' '{BEGIN}' \"$PATH\" '{END}'");
    let output = std::process::Command::new(&shell)
        .args(["-ilc", &script])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let start = stdout.find(BEGIN)? + BEGIN.len();
    let rest = &stdout[start..];
    let stop = rest.find(END)?;
    let path = rest[..stop].trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Common install dirs to fall back on when (or in addition to) the shell PATH —
/// covers the usual Homebrew/npm/cargo/bun/etc. locations. Home-relative dirs are
/// skipped when `$HOME` is unknown.
#[cfg(unix)]
fn fallback_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(h) = home {
        for rel in [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".deno/bin",
            ".npm-global/bin",
            ".volta/bin",
            "go/bin",
        ] {
            dirs.push(h.join(rel));
        }
    }
    // Always keep the launchd defaults so we never drop the baseline.
    dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].iter().map(PathBuf::from));
    dirs
}

/// Merge, in priority order, the shell PATH, our current PATH, and the static
/// fallback dirs — de-duplicated, preserving first occurrence, dropping empties.
#[cfg(unix)]
fn merge_paths(shell_path: Option<&str>, current: &str, home: Option<&Path>) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();

    let mut push = |entry: &str| {
        let entry = entry.trim();
        if entry.is_empty() {
            return;
        }
        if seen.insert(entry.to_string()) {
            out.push(entry.to_string());
        }
    };

    if let Some(sp) = shell_path {
        for e in sp.split(':') {
            push(e);
        }
    }
    for e in current.split(':') {
        push(e);
    }
    for dir in fallback_dirs(home) {
        push(&dir.to_string_lossy());
    }

    out.join(":")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn merges_and_dedups_preserving_order() {
        let merged = merge_paths(
            Some("/shell/bin:/usr/bin"),
            "/usr/bin:/current/bin",
            Some(Path::new("/home/u")),
        );
        let parts: Vec<&str> = merged.split(':').collect();
        // Shell entries come first, in order.
        assert_eq!(parts[0], "/shell/bin");
        assert_eq!(parts[1], "/usr/bin");
        // Current PATH contributes new entries after the shell PATH.
        assert!(parts.contains(&"/current/bin"));
        // /usr/bin appears exactly once despite being in shell, current, and fallback.
        assert_eq!(parts.iter().filter(|p| **p == "/usr/bin").count(), 1);
    }

    #[test]
    fn includes_home_relative_fallbacks() {
        let merged = merge_paths(None, "", Some(Path::new("/home/u")));
        assert!(merged.split(':').any(|p| p == "/home/u/.local/bin"));
        assert!(merged.split(':').any(|p| p == "/opt/homebrew/bin"));
    }

    #[test]
    fn skips_home_fallbacks_without_home() {
        let merged = merge_paths(None, "/usr/bin", None);
        assert!(!merged.contains(".local/bin"));
        assert!(merged.split(':').any(|p| p == "/usr/bin"));
        // Non-home fallbacks still present.
        assert!(merged.split(':').any(|p| p == "/opt/homebrew/bin"));
    }

    #[test]
    fn drops_empty_segments() {
        let merged = merge_paths(Some(":/a::/b:"), "", Some(Path::new("/home/u")));
        assert!(!merged.split(':').any(|p| p.is_empty()));
        let parts: Vec<&str> = merged.split(':').collect();
        assert_eq!(parts[0], "/a");
        assert_eq!(parts[1], "/b");
    }
}
