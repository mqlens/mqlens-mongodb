//! macOS app menu. Tauri's default menu binds Cmd+W to "Close Window", and a
//! menu key equivalent beats the webview's own keydown handling, so Cmd+W
//! closed the whole window instead of the active tab.
//!
//! This is the default menu with the File menu's window items replaced by tab
//! commands. Edit stays the predefined set: without it Cmd+C/V/X/Z stop
//! working in the webview on macOS. Windows and Linux get no menu bar, and the
//! frontend handles the same chords itself (`src/lib/tabShortcuts.ts`).

use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

/// Delivered to the focused window only; the payload is the command id.
pub const TAB_COMMAND_EVENT: &str = "tab-command";

const CLOSE_WINDOW_ID: &str = "close-window";

/// (id, label, accelerator). The id doubles as the `tab-command` payload, so it
/// must match a `TabCommand` type in `src/lib/tabShortcuts.ts`.
pub const TAB_MENU_ITEMS: &[(&str, &str, &str)] = &[
    ("new-tab", "New Tab", "CmdOrCtrl+T"),
    ("reopen-closed-tab", "Reopen Closed Tab", "CmdOrCtrl+Shift+T"),
    ("close-tab", "Close Tab", "CmdOrCtrl+W"),
];

pub const SETTINGS_ITEM: (&str, &str, &str) = ("open-settings", "Settings…", "CmdOrCtrl+,");

#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction {
    CloseWindow,
    Tab(&'static str),
}

pub fn menu_action(id: &str) -> Option<MenuAction> {
    if id == CLOSE_WINDOW_ID {
        return Some(MenuAction::CloseWindow);
    }
    TAB_MENU_ITEMS
        .iter()
        .chain([&SETTINGS_ITEM])
        .find(|(item_id, _, _)| *item_id == id)
        .map(|(item_id, _, _)| MenuAction::Tab(item_id))
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let separator = || PredefinedMenuItem::separator(app);

    let (settings_id, settings_label, settings_accel) = SETTINGS_ITEM;
    let settings = MenuItem::with_id(app, settings_id, settings_label, true, Some(settings_accel))?;

    let app_menu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &separator()?,
            &settings,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let tab_items = TAB_MENU_ITEMS
        .iter()
        .map(|(id, label, accel)| MenuItem::with_id(app, *id, *label, true, Some(*accel)))
        .collect::<tauri::Result<Vec<_>>>()?;
    // No accelerator: MQLens never bound Cmd+Shift+W, and Cmd+W is Close Tab.
    let close_window = MenuItem::with_id(app, CLOSE_WINDOW_ID, "Close Window", true, None::<&str>)?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &tab_items[0],
            &tab_items[1],
            &separator()?,
            &tab_items[2],
            &close_window,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(action) = menu_action(id) else { return };
    let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
    else {
        return;
    };
    match action {
        // Same path as the red close button: `CloseRequested` quits from main
        // and records `WindowClosed` for a `win-*` window.
        MenuAction::CloseWindow => {
            let _ = window.close();
        }
        MenuAction::Tab(command) => {
            let target = EventTarget::webview_window(window.label());
            let _ = app.emit_to(target, TAB_COMMAND_EVENT, command);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_menu_ids_to_actions() {
        assert_eq!(menu_action("close-window"), Some(MenuAction::CloseWindow));
        assert_eq!(menu_action("close-tab"), Some(MenuAction::Tab("close-tab")));
        assert_eq!(menu_action("new-tab"), Some(MenuAction::Tab("new-tab")));
        assert_eq!(menu_action("reopen-closed-tab"), Some(MenuAction::Tab("reopen-closed-tab")));
        assert_eq!(menu_action("open-settings"), Some(MenuAction::Tab("open-settings")));
        assert_eq!(menu_action("quit"), None);
    }

    // `MenuItem::with_id` drops an accelerator it cannot parse without an
    // error, which would silently hand Cmd+W back to nobody.
    #[test]
    fn every_accelerator_parses() {
        let accels = TAB_MENU_ITEMS
            .iter()
            .map(|(_, _, accel)| *accel)
            .chain([SETTINGS_ITEM.2]);
        for accel in accels {
            assert!(
                accel.parse::<muda::accelerator::Accelerator>().is_ok(),
                "accelerator {accel} does not parse"
            );
        }
    }

    #[test]
    fn close_tab_owns_cmd_w() {
        let close_tab = TAB_MENU_ITEMS.iter().find(|(id, _, _)| *id == "close-tab").unwrap();
        assert_eq!(close_tab.2, "CmdOrCtrl+W");
        assert!(TAB_MENU_ITEMS.iter().chain([&SETTINGS_ITEM]).all(|(_, _, a)| !a.contains("Shift+W")));
    }
}
