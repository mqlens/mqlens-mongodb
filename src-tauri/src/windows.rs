//! Window lifecycle: spawning/focusing secondary `WebviewWindow`s, and the
//! commands the frontend's Task 5 detach/move UX calls to drive the backend
//! workspace store's window-lifecycle ops (`DetachTab`/`WindowClosed`) in
//! lockstep with the real OS windows they describe.
//!
//! ## Design: who applies what, and who owns OS-window teardown
//!
//! - **User drags/clicks "Detach to New Window"**: frontend calls
//!   [`workspace_detach_tab`], which applies `DetachTab` (mutating the store
//!   and broadcasting `workspace-changed` exactly like `workspace_apply`
//!   does), then spawns the `win-N` the reducer just minted for the detached
//!   tab.
//! - **User clicks "Move to Window"**: this is a plain `workspace_apply`
//!   call with a `MoveTabToWindow` op — no OS window is created or
//!   destroyed, so it needs nothing from this module. (Handled entirely by
//!   `workspace.rs` + the existing `workspace_apply` command.)
//! - **A secondary window empties out (its last tab closes/moves away) and
//!   the frontend proactively wants to close itself**, or **another
//!   window's op silently removed this window from the document and its
//!   frontend notices its own entry is gone**: both call
//!   [`close_workspace_window`], which applies `WindowClosed` (a no-op if
//!   the window is already gone from the store — see
//!   `workspace::apply_window_closed`) and then destroys the real OS window.
//! - **The user clicks a secondary window's OS close (X) button**: no
//!   frontend code runs at all — [`spawn_workspace_window`] attaches a
//!   `CloseRequested` handler to every `win-*` window it creates, which
//!   applies `WindowClosed` (origin `"backend"`) and broadcasts
//!   `workspace-changed`, then lets the close proceed via the runtime's
//!   default behavior (verified below). The **main** window never gets this
//!   handler — its close is untouched, default `ExitRequested` behavior
//!   (app exit), exactly as before this task.
//! - **App boot**: [`spawn_saved_windows`] recreates every non-main window
//!   the store remembers that isn't already open (used by `App.tsx`'s
//!   restore effect, main window only).
//!
//! ## `WebviewWindowBuilder` / `CloseRequested` API, verified against the
//! pinned `tauri` 2.11.2 source (`~/.cargo/registry/src/.../tauri-2.11.2`),
//! matching this repo's established precedent of reading the vendored crate
//! rather than assuming API shape:
//! - `WebviewWindowBuilder::new(&app_handle, label, WebviewUrl::App(...))`
//!   (`src/webview/webview_window.rs`) — the builder's own doc comment warns
//!   it can deadlock "when used in a synchronous command"; every caller here
//!   is an `async fn` Tauri command (or runs off one), matching the doc's
//!   own recommended fix.
//! - `WebviewWindow::on_window_event(&self, f: Fn(&WindowEvent) + Send +
//!   'static)` is an INSTANCE method (registered after `.build()`), not a
//!   builder method — there is no `.on_window_event(...)` step in the
//!   builder chain itself.
//! - `WindowEvent::CloseRequested { signal_tx: Sender<bool> }`
//!   (`tauri-runtime-2.11.2/src/window.rs`): sending `true` on `signal_tx`
//!   prevents the close. Tracing `tauri-runtime-wry-2.11.3/src/lib.rs`'s
//!   `on_close_requested`, every registered handler is invoked with the same
//!   `signal_tx`, then `rx.try_recv()` is checked ONCE after all handlers
//!   run: only an explicit `Ok(true)` prevents the close; leaving the
//!   channel untouched (an `Err` on `try_recv`) falls through to
//!   `on_window_close`, closing the window normally. So a handler that
//!   simply never touches `signal_tx` — exactly what this module's
//!   `CloseRequested` handler does — is the correct way to "observe but let
//!   the close proceed".
//! - `WebviewWindow::destroy()` "does not emit any events and force close[s]
//!   the window instead" (vs. `.close()`, which re-emits `CloseRequested`).
//!   `close_workspace_window` already applied `WindowClosed` itself before
//!   reaching the OS window, so it uses `.destroy()` — using `.close()`
//!   instead would loop back through the very `CloseRequested` handler this
//!   module attaches to every `win-*` window, redundantly (harmlessly,
//!   since a second `WindowClosed` apply for an already-removed window
//!   no-ops — but wasteful and not the simplest correct wiring).

use crate::workspace::{self, Workspace, WorkspaceOp};
use crate::AppState;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const WINDOW_TITLE: &str = "MQLens";
const DEFAULT_WIDTH: f64 = 1000.0;
const DEFAULT_HEIGHT: f64 = 700.0;
const MIN_WIDTH: f64 = 700.0;
const MIN_HEIGHT: f64 = 500.0;

/// Every non-`"main"` window id in `ws.windows` that isn't already present in
/// `open_labels` — the set of OS windows [`spawn_saved_windows`] still needs
/// to create. Pure and order-preserving (matches `ws.windows`'s own order)
/// so it's unit-testable without a live `AppHandle`/real `WebviewWindow`s;
/// `spawn_saved_windows` itself is a thin wrapper that gathers
/// `open_labels` from `app.webview_windows()` and calls this.
pub(crate) fn windows_to_spawn(ws: &Workspace, open_labels: &[String]) -> Vec<String> {
    ws.windows
        .iter()
        .map(|w| w.id.as_str())
        .filter(|id| *id != "main" && !open_labels.iter().any(|l| l == id))
        .map(|id| id.to_string())
        .collect()
}

/// Applies `WorkspaceOp::WindowClosed { window_id: label }` and, if that
/// actually changed the store, broadcasts `workspace-changed` — the shared
/// core of the `CloseRequested` handler (X button, origin `"backend"`) and
/// the [`close_workspace_window`] command (frontend-initiated, any origin).
/// Errors are swallowed (logged) rather than propagated: a `CloseRequested`
/// handler has no `Result` return, and `close_workspace_window` treats a
/// failure to record the close as non-fatal to actually closing the OS
/// window — matching every other best-effort broadcast in this codebase
/// (`workspace_apply`'s own emit, `connections-changed`, etc.).
fn apply_window_closed_and_broadcast(app: &AppHandle, label: &str, origin: String) {
    let state = app.state::<AppState>();
    let path = workspace::workspace_path(app);
    match workspace::apply_impl(&state, &path, WorkspaceOp::WindowClosed { window_id: label.to_string() }, origin) {
        Ok(Some(payload)) => {
            let _ = app.emit("workspace-changed", payload);
        }
        Ok(None) => {} // already gone from the store, or unknown/"main" — nothing to broadcast
        Err(e) => eprintln!("close_workspace_window: failed to apply window_closed for {label}: {e}"),
    }
}

/// Create (or, if already open, focus) the `WebviewWindow` labeled `label`.
/// Every window this app spawns beyond the config-defined `"main"` goes
/// through here — `workspace_detach_tab`, `spawn_saved_windows`, and manual
/// testing/future call sites all get the same size/title and (for `win-*`
/// labels) the same `CloseRequested` -> `WindowClosed` wiring for free.
pub fn spawn_workspace_window(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(label) {
        return existing.set_focus().map_err(|e| e.to_string());
    }

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(WINDOW_TITLE)
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .build()
        .map_err(|e| e.to_string())?;

    // Main is created from `tauri.conf.json`, never through this function —
    // this check is what keeps main's close behavior untouched (default
    // `ExitRequested`/app-exit) even if a future caller ever passed "main"
    // here by mistake.
    if label.starts_with("win-") {
        let app_for_close = app.clone();
        let label_owned = label.to_string();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Deliberately never touches `signal_tx` — see this module's
                // doc comment for why that's what lets the close proceed.
                apply_window_closed_and_broadcast(&app_for_close, &label_owned, "backend".to_string());
            }
        });
    }

    Ok(())
}

/// `workspace_detach_tab` command: applies `DetachTab` for `tab_id` (via the
/// same `apply_impl` path `workspace_apply` uses, so the broadcast/debounced-
/// save machinery is identical), finds the fresh `win-N` the reducer minted
/// for it, spawns that window, and returns its label. Errors if the op
/// no-opped (unknown `tab_id`, or it was already the sole tab of its own
/// non-main window — see `workspace::apply_detach_tab`'s doc comment) since
/// there is then no new window to report.
#[tauri::command]
pub async fn workspace_detach_tab(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    tab_id: String,
    origin: Option<String>,
) -> Result<String, String> {
    let origin = origin.unwrap_or_else(workspace::default_origin);
    let path = workspace::workspace_path(&app);
    let payload = workspace::apply_impl(&state, &path, WorkspaceOp::DetachTab { tab_id: tab_id.clone() }, origin)?
        .ok_or_else(|| "detach_tab: nothing to detach (unknown tab, or already alone)".to_string())?;

    let new_label = workspace::window_containing_tab(&payload.workspace, &tab_id)
        .ok_or_else(|| "detach_tab: detached tab not found in the post-apply workspace".to_string())?
        .to_string();

    let _ = app.emit("workspace-changed", payload);
    spawn_workspace_window(&app, &new_label)?;
    Ok(new_label)
}

/// `spawn_saved_windows` command: recreates every non-main OS window the
/// store remembers that isn't already open. Called once, main-window-only,
/// by `App.tsx`'s boot/restore effect after `workspace_get` resolves.
#[tauri::command]
pub async fn spawn_saved_windows(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = workspace::workspace_path(&app);
    let Some(ws) = workspace::get_impl(&state, &path)? else {
        return Ok(()); // no persisted workspace yet: nothing to recreate
    };
    let open_labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    for label in windows_to_spawn(&ws, &open_labels) {
        spawn_workspace_window(&app, &label)?;
    }
    Ok(())
}

/// `focus_window` command: brings an existing OS window to the front.
/// No-op (`Ok`) if `label` names a window that isn't currently open — the
/// caller (the cross-window open dedupe in `App.tsx`) can't know in advance
/// whether the window it's about to focus is still alive, and losing that
/// race must never surface as an error.
#[tauri::command]
pub async fn focus_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `close_workspace_window` command: applies `WorkspaceOp::WindowClosed` for
/// `label` (broadcasting `workspace-changed` if that actually changed the
/// store — a no-op if `label` is already gone, e.g. this is the "remote
/// close" path reacting to another window's op that already removed it), then
/// destroys the real OS window if one is still open. Two call sites in
/// `App.tsx`: a secondary window proactively closing itself once its last tab
/// closes/moves away, and a window discovering its own entry vanished from a
/// `crossWindow` broadcast it didn't cause.
#[tauri::command]
pub async fn close_workspace_window(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    label: String,
    origin: Option<String>,
) -> Result<(), String> {
    let origin = origin.unwrap_or_else(workspace::default_origin);
    let path = workspace::workspace_path(&app);
    let payload = workspace::apply_impl(&state, &path, WorkspaceOp::WindowClosed { window_id: label.clone() }, origin)?;
    if let Some(payload) = payload {
        let _ = app.emit("workspace-changed", payload);
    }
    // `.destroy()`, not `.close()` — see this module's doc comment: the
    // WindowClosed op above is already applied, so re-emitting
    // CloseRequested (what `.close()` does) would be redundant.
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{LayoutNode, WindowModel};

    fn ws_with_windows(ids: &[&str]) -> Workspace {
        Workspace {
            revision: 0,
            windows: ids
                .iter()
                .map(|id| WindowModel {
                    id: id.to_string(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane {
                        id: "pane-1".into(),
                        tab_ids: if *id == "main" { vec![] } else { vec![format!("{id}-tab")] },
                        active_tab_id: None,
                    },
                })
                .collect(),
            tabs: vec![],
        }
    }

    #[test]
    fn windows_to_spawn_skips_main_and_already_open_windows() {
        let ws = ws_with_windows(&["main", "win-1", "win-2"]);
        let open: Vec<String> = vec!["main".into(), "win-1".into()];
        assert_eq!(windows_to_spawn(&ws, &open), vec!["win-2".to_string()]);
    }

    #[test]
    fn windows_to_spawn_returns_everything_non_main_when_nothing_is_open() {
        let ws = ws_with_windows(&["main", "win-1", "win-2"]);
        assert_eq!(windows_to_spawn(&ws, &[]), vec!["win-1".to_string(), "win-2".to_string()]);
    }

    #[test]
    fn windows_to_spawn_is_empty_when_only_main_exists() {
        let ws = ws_with_windows(&["main"]);
        assert!(windows_to_spawn(&ws, &[]).is_empty());
    }

    #[test]
    fn windows_to_spawn_is_empty_when_everything_is_already_open() {
        let ws = ws_with_windows(&["main", "win-1"]);
        let open: Vec<String> = vec!["main".into(), "win-1".into()];
        assert!(windows_to_spawn(&ws, &open).is_empty());
    }
}
