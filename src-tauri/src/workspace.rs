//! Multi-panel workspace store: layout tree, tabs, and the workspace.json
//! document. This module owns the data model and best-effort file IO only —
//! the reducer (`apply`) and Tauri commands land in later tasks.
//!
//! ## DESIGN RULE: pane/split ids are WINDOW-LOCAL (Phase 3 Task 2)
//!
//! Two different windows may both contain a pane literally named `pane-2` —
//! ids are only unique *within* the window that minted them, never across
//! `ws.windows` as a whole. Every op that resolves a pane/split id (`apply`
//! dispatching through `workspace_reducer`, `find_pane`, `pane_of_tab`,
//! `next_pane_id`/`next_split_id`) MUST do so strictly within the one
//! `WindowModel.split_tree` it was resolved to — never by scanning across
//! windows. This matches Phase 3 Task 1's frontend semantics, where each
//! window owns an independent `WorkspaceLayout` and mints/resolves its own
//! pane/split ids purely from its own tree.
//!
//! Window ids, by contrast, ARE global (`"main"` plus `"win-N"`): `WindowClosed`/
//! `DetachTab`/`MoveTabToWindow` resolve/mint them by scanning `ws.windows`
//! as a whole, not any single tree.

use crate::state::{AppState, LockExt};
use serde::{Deserialize, Deserializer, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

/// The "double Option" pattern: distinguishes a field that was absent from
/// the JSON payload (outer `None` — leave untouched) from one that was
/// present with an explicit `null` (outer `Some`, inner `None` — clear it)
/// from one present with a value (outer `Some`, inner `Some(v)` — set it).
/// Plain `#[serde(default)]` on `Option<Option<T>>` can't express this on its
/// own: serde's stock `Option<T>` deserializer collapses a JSON `null`
/// straight into the outer `None`, the same as a missing key. Wrapping the
/// inner deserialize in an extra `Some(..)` here is what keeps `null`
/// distinguishable from "absent" once combined with `#[serde(default)]` on
/// the field (which only supplies the fallback for a truly missing key).
fn deserialize_some<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

/// One open query tab. `profile_id` identifies a saved connection profile,
/// NEVER a live session connectionId — tabs must survive reconnects.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabModel {
    pub id: String,
    #[serde(rename = "type")]
    pub tab_type: String, // the 17 QueryTab kinds
    pub profile_id: String, // NEVER a session connectionId
    pub profile_name: String,
    pub db: String,
    pub collection: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_query: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_aggregate: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builder_state: Option<serde_json::Value>,
}

/// A node in the split-pane layout tree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LayoutNode {
    // `rename_all` on the enum container only renames the `kind` tag values
    // (Pane -> pane, Split -> split); it does NOT cascade into struct-variant
    // fields. Each variant needs its own `rename_all` so `tab_ids` etc.
    // serialize as camelCase to match the frontend document.
    #[serde(rename = "pane", rename_all = "camelCase")]
    Pane {
        id: String,
        tab_ids: Vec<String>,
        active_tab_id: Option<String>,
    },
    #[serde(rename = "split", rename_all = "camelCase")]
    Split {
        id: String,
        dir: String,
        ratio: f64,
        children: Vec<LayoutNode>, // len==2 invariant
    },
}

/// One window's layout tree plus which pane currently has focus.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowModel {
    pub id: String,
    pub split_tree: LayoutNode,
    pub focused_pane_id: String,
}

/// The whole workspace.json document.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub windows: Vec<WindowModel>,
    #[serde(default)]
    pub tabs: Vec<TabModel>, // flat, mirrors frontend tabs[]
}

/// `"main"` — the id of the always-present primary window, and the fallback
/// every pane-referencing op's `window_id` decodes to when absent from the
/// wire payload (older callers/fixtures that predate multi-window).
fn default_window_id() -> String {
    "main".to_string()
}

/// The `workspace-changed` broadcast payload — emitted to every window
/// (Phase 3 Task 3) whenever `workspace_apply` actually changes state.
/// `origin` is the calling window's label (so a window can ignore its own
/// echo); `cross_window` flags the three ops whose effect spans more than
/// one window (`MoveTabToWindow`, `DetachTab`, `WindowClosed`) so a listener
/// can decide whether a narrower, single-window repaint suffices.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangedPayload {
    pub revision: u64,
    pub origin: String,
    pub cross_window: bool,
    pub workspace: Workspace,
}

/// True for the three window-lifecycle ops (see the module DESIGN RULE and
/// `apply`'s doc comment) — the only ops whose effect can be visible in more
/// than one window's layout tree at once.
fn op_is_cross_window(op: &WorkspaceOp) -> bool {
    matches!(
        op,
        WorkspaceOp::MoveTabToWindow { .. } | WorkspaceOp::DetachTab { .. } | WorkspaceOp::WindowClosed { .. }
    )
}

/// A single workspace mutation. The `type` discriminator is snake_case to
/// match the frontend reducer's action `type` strings exactly (e.g.
/// `split_pane`, `update_tab_state`).
///
/// Every variant that resolves a pane/split id also carries `window_id`
/// (`#[serde(default = "default_window_id")]`, so existing single-window
/// payloads keep decoding unchanged): `apply` resolves that op's target
/// window first, then every pane/split lookup happens strictly inside that
/// one window's tree — see the module DESIGN RULE above. `UpdateTabState`
/// is the one exception: it never touches a layout tree (it patches
/// `ws.tabs` only), so it carries no `window_id`. `MoveTabToWindow`,
/// `DetachTab`, and `WindowClosed` are window-lifecycle ops in their own
/// right (they name a source/target *window*, not a single resolved one) —
/// see their doc comments in `apply`'s helpers below.
// One WorkspaceOp is deserialized per user action (not a hot path), so the
// size gap between OpenTab (carries an optional inline TabModel) and the
// smaller variants (e.g. DetachTab's single String) is irrelevant — same
// rationale as db/import.rs's ImportReader / db/export/mod.rs's analogous
// allow.
#[allow(clippy::large_enum_variant)]
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkspaceOp {
    OpenTab {
        tab_id: String,
        #[serde(default)]
        pane_id: Option<String>,
        #[serde(default)]
        tab: Option<TabModel>,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    CloseTab {
        tab_id: String,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    CloseMany {
        tab_ids: Vec<String>,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    MoveTab {
        tab_id: String,
        target_pane_id: String,
        #[serde(default)]
        index: Option<usize>,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    SplitPane {
        pane_id: String,
        dir: String,
        side: String,
        #[serde(default)]
        move_tab_id: Option<String>,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    ResizeSplit {
        split_id: String,
        ratio: f64,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    SetActive {
        pane_id: String,
        tab_id: String,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    FocusPane {
        pane_id: String,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    RenameTab {
        old_id: String,
        new_id: String,
        #[serde(default = "default_window_id")]
        window_id: String,
    },
    UpdateTabState {
        tab_id: String,
        // `Option<Option<Value>>`: outer `None` = key absent (untouched),
        // `Some(None)` = explicit `null` (clear), `Some(Some(v))` = set.
        #[serde(default, deserialize_with = "deserialize_some")]
        last_query: Option<Option<serde_json::Value>>,
        #[serde(default, deserialize_with = "deserialize_some")]
        last_aggregate: Option<Option<serde_json::Value>>,
        #[serde(default, deserialize_with = "deserialize_some")]
        builder_state: Option<Option<serde_json::Value>>,
    },
    /// Moves an already-open tab from wherever it currently lives (found by
    /// scanning ALL windows — the op itself doesn't name a source) into
    /// `target_window_id`'s `target_pane_id` (or that window's focused pane
    /// if omitted), activating and focusing it there. `tabs[]` is untouched
    /// — the tab model already exists; this only moves its layout-tree
    /// placement. No-op if `tab_id` isn't open anywhere, or if
    /// `target_window_id` doesn't exist.
    MoveTabToWindow {
        tab_id: String,
        target_window_id: String,
        #[serde(default)]
        target_pane_id: Option<String>,
    },
    /// Pulls `tab_id` out of its current window into a brand-new window of
    /// its own (`win-N`, minted by scanning ALL window ids — window ids are
    /// global, unlike pane/split ids). No-op if `tab_id` is unknown, or if
    /// it's already the only tab in the only pane of a non-main window
    /// (already alone — detaching would just destroy and recreate an
    /// equivalent window).
    DetachTab { tab_id: String },
    /// A frontend window was closed. No-op for `"main"` (the primary window
    /// can't be closed this way) or an unknown id. Otherwise removes the
    /// window AND every tab id its layout tree referenced from `tabs[]` —
    /// closing a secondary window closes its tabs.
    WindowClosed { window_id: String },
}

/// The `window_id` a pane-referencing `WorkspaceOp` variant targets, or
/// `None` for the variants that don't resolve a pane inside one specific
/// window (`UpdateTabState` touches only `ws.tabs`; `MoveTabToWindow` /
/// `DetachTab` / `WindowClosed` are window-lifecycle ops with their own
/// source/target window resolution, handled outside `apply_layout_op`).
fn op_window_id(op: &WorkspaceOp) -> Option<&str> {
    match op {
        WorkspaceOp::OpenTab { window_id, .. }
        | WorkspaceOp::CloseTab { window_id, .. }
        | WorkspaceOp::CloseMany { window_id, .. }
        | WorkspaceOp::MoveTab { window_id, .. }
        | WorkspaceOp::SplitPane { window_id, .. }
        | WorkspaceOp::ResizeSplit { window_id, .. }
        | WorkspaceOp::SetActive { window_id, .. }
        | WorkspaceOp::FocusPane { window_id, .. }
        | WorkspaceOp::RenameTab { window_id, .. } => Some(window_id.as_str()),
        WorkspaceOp::UpdateTabState { .. }
        | WorkspaceOp::MoveTabToWindow { .. }
        | WorkspaceOp::DetachTab { .. }
        | WorkspaceOp::WindowClosed { .. } => None,
    }
}

// ---------------------------------------------------------------------------
// Reducer internals — a 1:1 port of src/workspace/model.ts. Helper names
// mirror the TS ones exactly (mapPane -> map_pane, removeTabFromPane ->
// remove_tab_from_pane, withFocusRepaired -> with_focus_repaired,
// workspaceReducer -> workspace_reducer, closeTab -> close_tab) so the two
// implementations can be diffed function-by-function across the language
// boundary.
// ---------------------------------------------------------------------------

const MIN_RATIO: f64 = 0.15;
const MAX_RATIO: f64 = 0.85;

/// The id of any layout node, pane or split (TS accesses `.id` directly on
/// the `LayoutNode` union; Rust needs a match since the two variants don't
/// share a common field).
fn node_id(node: &LayoutNode) -> &str {
    match node {
        LayoutNode::Pane { id, .. } => id,
        LayoutNode::Split { id, .. } => id,
    }
}

/// Port of TS `allPanes`.
fn all_panes<'a>(node: &'a LayoutNode, out: &mut Vec<&'a LayoutNode>) {
    match node {
        LayoutNode::Pane { .. } => out.push(node),
        LayoutNode::Split { children, .. } => {
            for c in children {
                all_panes(c, out);
            }
        }
    }
}

/// Port of TS `findPane`.
fn find_pane<'a>(node: &'a LayoutNode, pane_id: &str) -> Option<&'a LayoutNode> {
    match node {
        LayoutNode::Pane { id, .. } => {
            if id == pane_id {
                Some(node)
            } else {
                None
            }
        }
        LayoutNode::Split { children, .. } => children.iter().find_map(|c| find_pane(c, pane_id)),
    }
}

/// Port of TS `paneOfTab`.
fn pane_of_tab<'a>(node: &'a LayoutNode, tab_id: &str) -> Option<&'a LayoutNode> {
    match node {
        LayoutNode::Pane { tab_ids, .. } => {
            if tab_ids.iter().any(|t| t == tab_id) {
                Some(node)
            } else {
                None
            }
        }
        LayoutNode::Split { children, .. } => children.iter().find_map(|c| pane_of_tab(c, tab_id)),
    }
}

/// Port of TS `mapPane`: replaces the pane with `pane_id` via `f`. `f`
/// returning `None` requests a fold (its parent split collapses into the
/// sibling). The outermost call special-cases a lone-root pane: a fold
/// request there is ignored (`f(node).unwrap_or_else(|| node.clone())`),
/// mirroring TS's `fn(node) ?? node` — "root-level fold is ignored: root
/// pane persists". Every *recursive* self-call only ever re-enters this
/// function with a Split node (the branch that would recurse into a
/// directly-matching pane instead folds inline), so nested folds always
/// take effect; only the true top-level call can hit the "ignore" path.
fn map_pane(
    node: &LayoutNode,
    pane_id: &str,
    f: &mut dyn FnMut(&LayoutNode) -> Option<LayoutNode>,
) -> LayoutNode {
    match node {
        LayoutNode::Pane { id, .. } => {
            if id != pane_id {
                return node.clone();
            }
            f(node).unwrap_or_else(|| node.clone())
        }
        LayoutNode::Split { id, dir, ratio, children } => {
            let (a, b) = (&children[0], &children[1]);
            if find_pane(a, pane_id).is_some() {
                if let LayoutNode::Pane { id: aid, .. } = a {
                    if aid == pane_id {
                        return match f(a) {
                            None => b.clone(), // fold: parent split replaced by sibling
                            Some(next) => LayoutNode::Split {
                                id: id.clone(),
                                dir: dir.clone(),
                                ratio: *ratio,
                                children: vec![next, b.clone()],
                            },
                        };
                    }
                }
                return LayoutNode::Split {
                    id: id.clone(),
                    dir: dir.clone(),
                    ratio: *ratio,
                    children: vec![map_pane(a, pane_id, f), b.clone()],
                };
            }
            if find_pane(b, pane_id).is_some() {
                if let LayoutNode::Pane { id: bid, .. } = b {
                    if bid == pane_id {
                        return match f(b) {
                            None => a.clone(),
                            Some(next) => LayoutNode::Split {
                                id: id.clone(),
                                dir: dir.clone(),
                                ratio: *ratio,
                                children: vec![a.clone(), next],
                            },
                        };
                    }
                }
                return LayoutNode::Split {
                    id: id.clone(),
                    dir: dir.clone(),
                    ratio: *ratio,
                    children: vec![a.clone(), map_pane(b, pane_id, f)],
                };
            }
            node.clone()
        }
    }
}

/// Port of TS `withFocusRepaired`.
fn with_focus_repaired(root: &LayoutNode, focused_pane_id: &str) -> String {
    if find_pane(root, focused_pane_id).is_some() {
        return focused_pane_id.to_string();
    }
    let mut panes = Vec::new();
    all_panes(root, &mut panes);
    node_id(panes[0]).to_string() // a tree always has at least one pane
}

/// Port of TS `removeTabFromPane`. `None` signals "fold" (the pane became
/// empty); the pane is returned unchanged (`Some`) if `tab_id` wasn't
/// present, matching TS's `if (idx === -1) return pane;`.
fn remove_tab_from_pane(pane: &LayoutNode, tab_id: &str) -> Option<LayoutNode> {
    let LayoutNode::Pane { id, tab_ids, active_tab_id } = pane else {
        unreachable!("remove_tab_from_pane is only ever called with a pane node");
    };
    let Some(idx) = tab_ids.iter().position(|t| t == tab_id) else {
        return Some(pane.clone());
    };
    let new_tab_ids: Vec<String> = tab_ids.iter().filter(|t| *t != tab_id).cloned().collect();
    if new_tab_ids.is_empty() {
        return None; // request fold (ignored at root)
    }
    let new_active = if active_tab_id.as_deref() == Some(tab_id) {
        Some(new_tab_ids[idx.min(new_tab_ids.len() - 1)].clone())
    } else {
        active_tab_id.clone()
    };
    Some(LayoutNode::Pane { id: id.clone(), tab_ids: new_tab_ids, active_tab_id: new_active })
}

/// Port of TS `closeTab`.
fn close_tab(root: &LayoutNode, focused_pane_id: &str, tab_id: &str) -> (LayoutNode, String) {
    let Some(pane) = pane_of_tab(root, tab_id) else {
        return (root.clone(), focused_pane_id.to_string());
    };
    let pane_id = node_id(pane).to_string();
    let LayoutNode::Pane { tab_ids: pane_tab_ids, .. } = pane else {
        unreachable!("pane_of_tab only ever returns a pane node");
    };
    let pane_tab_ids = pane_tab_ids.clone();
    let tab_id_owned = tab_id.to_string();
    let mut new_root = map_pane(root, &pane_id, &mut |p| remove_tab_from_pane(p, &tab_id_owned));
    // Root pane emptied: TS detects this via `root === layout.root` (the
    // fold request bubbled all the way to mapPane's ignore-at-root case,
    // meaning the whole tree IS that one pane); we detect the equivalent
    // condition directly: the pane found by pane_of_tab is the tree root
    // and held exactly this one tab.
    let root_is_target_pane = matches!(root, LayoutNode::Pane { id, .. } if *id == pane_id);
    if root_is_target_pane && pane_tab_ids.len() == 1 && pane_tab_ids[0] == tab_id_owned {
        new_root = LayoutNode::Pane { id: pane_id, tab_ids: vec![], active_tab_id: None };
    }
    let new_focused = with_focus_repaired(&new_root, focused_pane_id);
    (new_root, new_focused)
}

/// Port of TS `workspaceReducer`'s `switch`, operating on the (root,
/// focusedPaneId) pair that TS calls `WorkspaceLayout`. Layout-only: the
/// Rust-only `tabs[]` bookkeeping (OpenTab's tab model, CloseTab/CloseMany/
/// RenameTab mirroring, UpdateTabState) is applied separately by `apply`.
fn workspace_reducer(root: &LayoutNode, focused_pane_id: &str, op: &WorkspaceOp) -> (LayoutNode, String) {
    match op {
        WorkspaceOp::OpenTab { tab_id, pane_id, .. } => {
            if let Some(existing) = pane_of_tab(root, tab_id) {
                let existing_id = node_id(existing).to_string();
                let tab_id_owned = tab_id.clone();
                let new_root = map_pane(root, &existing_id, &mut |p| {
                    let LayoutNode::Pane { id, tab_ids, .. } = p else { return None };
                    Some(LayoutNode::Pane {
                        id: id.clone(),
                        tab_ids: tab_ids.clone(),
                        active_tab_id: Some(tab_id_owned.clone()),
                    })
                });
                return (new_root, existing_id);
            }
            let target_id = pane_id
                .as_deref()
                .and_then(|pid| find_pane(root, pid))
                .map(|p| node_id(p).to_string())
                .unwrap_or_else(|| focused_pane_id.to_string());
            let tab_id_owned = tab_id.clone();
            let new_root = map_pane(root, &target_id, &mut |p| {
                let LayoutNode::Pane { id, tab_ids, .. } = p else { return None };
                let mut new_tab_ids = tab_ids.clone();
                new_tab_ids.push(tab_id_owned.clone());
                Some(LayoutNode::Pane { id: id.clone(), tab_ids: new_tab_ids, active_tab_id: Some(tab_id_owned.clone()) })
            });
            (new_root, target_id)
        }

        WorkspaceOp::CloseTab { tab_id, .. } => close_tab(root, focused_pane_id, tab_id),

        WorkspaceOp::CloseMany { tab_ids, .. } => {
            let mut r = root.clone();
            let mut f = focused_pane_id.to_string();
            for t in tab_ids {
                let (nr, nf) = close_tab(&r, &f, t);
                r = nr;
                f = nf;
            }
            (r, f)
        }

        WorkspaceOp::MoveTab { tab_id, target_pane_id, index, .. } => {
            let (Some(source), Some(target)) = (pane_of_tab(root, tab_id), find_pane(root, target_pane_id)) else {
                return (root.clone(), focused_pane_id.to_string());
            };
            let source_id = node_id(source).to_string();
            let target_id = node_id(target).to_string();
            if source_id == target_id {
                // Reorder within the pane.
                let LayoutNode::Pane { tab_ids, .. } = source else { unreachable!() };
                let without: Vec<String> = tab_ids.iter().filter(|t| **t != *tab_id).cloned().collect();
                let at = index.unwrap_or(without.len()).min(without.len());
                let mut new_tab_ids = without[..at].to_vec();
                new_tab_ids.push(tab_id.clone());
                new_tab_ids.extend_from_slice(&without[at..]);
                let new_root = map_pane(root, &source_id, &mut |p| {
                    let LayoutNode::Pane { id, active_tab_id, .. } = p else { return None };
                    Some(LayoutNode::Pane { id: id.clone(), tab_ids: new_tab_ids.clone(), active_tab_id: active_tab_id.clone() })
                });
                return (new_root, focused_pane_id.to_string());
            }
            let tab_id_owned = tab_id.clone();
            let mut new_root = map_pane(root, &source_id, &mut |p| remove_tab_from_pane(p, &tab_id_owned));
            // Source may have folded; the target pane still exists (folding
            // only removes the emptied pane itself).
            let index_owned = *index;
            new_root = map_pane(&new_root, &target_id, &mut |p| {
                let LayoutNode::Pane { id, tab_ids, .. } = p else { return None };
                let at = index_owned.unwrap_or(tab_ids.len()).min(tab_ids.len());
                let mut new_tab_ids = tab_ids[..at].to_vec();
                new_tab_ids.push(tab_id_owned.clone());
                new_tab_ids.extend_from_slice(&tab_ids[at..]);
                Some(LayoutNode::Pane { id: id.clone(), tab_ids: new_tab_ids, active_tab_id: Some(tab_id_owned.clone()) })
            });
            let new_focused = with_focus_repaired(&new_root, &target_id);
            (new_root, new_focused)
        }

        WorkspaceOp::SplitPane { pane_id, dir, side, move_tab_id, .. } => {
            let Some(pane) = find_pane(root, pane_id) else {
                return (root.clone(), focused_pane_id.to_string());
            };
            let LayoutNode::Pane { tab_ids: existing_tab_ids, .. } = pane else { unreachable!() };
            if let Some(mv) = move_tab_id {
                if existing_tab_ids.len() == 1 && existing_tab_ids[0] == *mv {
                    return (root.clone(), focused_pane_id.to_string()); // would empty the source pane — pointless split
                }
            }
            let moving: Option<String> =
                move_tab_id.as_ref().filter(|mv| existing_tab_ids.contains(mv)).cloned();
            let fresh_id = next_pane_id(root);
            let fresh = LayoutNode::Pane {
                id: fresh_id.clone(),
                tab_ids: moving.clone().map(|m| vec![m]).unwrap_or_default(),
                active_tab_id: moving.clone(),
            };
            let split_id = next_split_id(root);
            let side_is_start = side.as_str() == "start";
            let dir_owned = dir.clone();
            let new_root = map_pane(root, pane_id, &mut |p| {
                let remaining = match &moving {
                    Some(m) => remove_tab_from_pane(p, m)
                        .expect("split_pane's no-op guard above ensures removing `moving` never empties the pane"),
                    None => p.clone(),
                };
                let children = if side_is_start {
                    vec![fresh.clone(), remaining]
                } else {
                    vec![remaining, fresh.clone()]
                };
                Some(LayoutNode::Split { id: split_id.clone(), dir: dir_owned.clone(), ratio: 0.5, children })
            });
            (new_root, fresh_id)
        }

        WorkspaceOp::ResizeSplit { split_id, ratio, .. } => {
            let clamped = ratio.clamp(MIN_RATIO, MAX_RATIO);
            let mut found = false;
            fn visit(node: &LayoutNode, split_id: &str, clamped: f64, found: &mut bool) -> LayoutNode {
                match node {
                    LayoutNode::Pane { .. } => node.clone(),
                    LayoutNode::Split { id, dir, ratio, children } => {
                        if id == split_id {
                            *found = true;
                            LayoutNode::Split { id: id.clone(), dir: dir.clone(), ratio: clamped, children: children.clone() }
                        } else {
                            LayoutNode::Split {
                                id: id.clone(),
                                dir: dir.clone(),
                                ratio: *ratio,
                                children: children.iter().map(|c| visit(c, split_id, clamped, found)).collect(),
                            }
                        }
                    }
                }
            }
            let new_root = visit(root, split_id, clamped, &mut found);
            if found {
                (new_root, focused_pane_id.to_string())
            } else {
                (root.clone(), focused_pane_id.to_string())
            }
        }

        WorkspaceOp::SetActive { pane_id, tab_id, .. } => {
            let ok = matches!(find_pane(root, pane_id), Some(LayoutNode::Pane { tab_ids, .. }) if tab_ids.contains(tab_id));
            if !ok {
                return (root.clone(), focused_pane_id.to_string());
            }
            let tab_id_owned = tab_id.clone();
            let new_root = map_pane(root, pane_id, &mut |p| {
                let LayoutNode::Pane { id, tab_ids, .. } = p else { return None };
                Some(LayoutNode::Pane { id: id.clone(), tab_ids: tab_ids.clone(), active_tab_id: Some(tab_id_owned.clone()) })
            });
            (new_root, pane_id.clone())
        }

        WorkspaceOp::FocusPane { pane_id, .. } => {
            if find_pane(root, pane_id).is_some() {
                (root.clone(), pane_id.clone())
            } else {
                (root.clone(), focused_pane_id.to_string())
            }
        }

        WorkspaceOp::RenameTab { old_id, new_id, .. } => {
            let Some(pane) = pane_of_tab(root, old_id) else {
                return (root.clone(), focused_pane_id.to_string());
            };
            let pane_id = node_id(pane).to_string();
            let (old_owned, new_owned) = (old_id.clone(), new_id.clone());
            let new_root = map_pane(root, &pane_id, &mut |p| {
                let LayoutNode::Pane { id, tab_ids, active_tab_id } = p else { return None };
                let new_tab_ids: Vec<String> =
                    tab_ids.iter().map(|t| if *t == old_owned { new_owned.clone() } else { t.clone() }).collect();
                let new_active = if active_tab_id.as_deref() == Some(old_owned.as_str()) {
                    Some(new_owned.clone())
                } else {
                    active_tab_id.clone()
                };
                Some(LayoutNode::Pane { id: id.clone(), tab_ids: new_tab_ids, active_tab_id: new_active })
            });
            (new_root, focused_pane_id.to_string())
        }

        // Tabs-only op — no layout-tree effect. Handled by `apply`.
        WorkspaceOp::UpdateTabState { .. } => (root.clone(), focused_pane_id.to_string()),

        // Window-lifecycle ops never reach `workspace_reducer` — `apply`
        // dispatches them to their own appliers (`apply_move_tab_to_window`
        // / `apply_detach_tab` / `apply_window_closed`) before
        // `apply_layout_op` (this function's only caller) ever runs.
        WorkspaceOp::MoveTabToWindow { .. } | WorkspaceOp::DetachTab { .. } | WorkspaceOp::WindowClosed { .. } => {
            unreachable!("window-lifecycle ops are dispatched by `apply` before reaching workspace_reducer")
        }
    }
}

/// Scans the tree for the highest numeric suffix among ids sharing `prefix`
/// (e.g. `"pane-"` or `"split-"`), regardless of node kind — ids of the
/// other kind never share a prefix so they simply don't match.
fn max_numeric_suffix(node: &LayoutNode, prefix: &str) -> u64 {
    let mut best = node_id(node).strip_prefix(prefix).and_then(|r| r.parse::<u64>().ok()).unwrap_or(0);
    if let LayoutNode::Split { children, .. } = node {
        for c in children {
            best = best.max(max_numeric_suffix(c, prefix));
        }
    }
    best
}

/// Mints `pane-N` / `split-N` ids by scanning the live tree for the current
/// max suffix at call time, rather than keeping a counter on `Workspace`.
///
/// `model.ts`'s `nextPaneId`/`nextSplitId` (TS #197 fix) mirror this exactly
/// — both sides mint by scanning the tree being reduced rather than a
/// standalone counter. That statelessness matters most here: the Rust store
/// *restores* a tree from `workspace.json` that may already contain
/// `pane-7`/`split-3`, so a process-local counter seeded at 0 would
/// immediately collide with ids already in the restored tree. Scanning the
/// tree at mint time needs nothing to seed on load, nothing to serialize,
/// and nothing that can get out of sync with the actual tree — and is cheap
/// at these tree sizes.
fn next_pane_id(root: &LayoutNode) -> String {
    format!("pane-{}", max_numeric_suffix(root, "pane-") + 1)
}
fn next_split_id(root: &LayoutNode) -> String {
    format!("split-{}", max_numeric_suffix(root, "split-") + 1)
}

/// The single main window's initial state: one root pane, no tabs. Mirrors
/// TS `createInitialLayout([], null)` plus the window wrapper Phase 2 adds.
fn default_window() -> WindowModel {
    WindowModel {
        id: "main".into(),
        split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec![], active_tab_id: None },
        focused_pane_id: "pane-1".into(),
    }
}

/// Mints `win-N` by scanning ALL window ids in `ws.windows` for the current
/// max numeric suffix among ids prefixed `win-` — window ids are global
/// (unlike pane/split ids, which are window-local; see the module DESIGN
/// RULE), so this scan deliberately covers every window, not just one
/// tree. `"main"` never matches the `win-` prefix, so it's naturally
/// excluded. Stateless for the same reason `next_pane_id`/`next_split_id`
/// are: a `Workspace` restored from disk may already contain `win-3`, and a
/// process-local counter seeded at 0 would collide with it immediately.
fn next_window_id(ws: &Workspace) -> String {
    let best = ws
        .windows
        .iter()
        .filter_map(|w| w.id.strip_prefix("win-").and_then(|rest| rest.parse::<u64>().ok()))
        .max()
        .unwrap_or(0);
    format!("win-{}", best + 1)
}

/// Apply one op to the workspace. Window-lifecycle ops (`MoveTabToWindow`,
/// `DetachTab`, `WindowClosed`) name a source/target *window* themselves and
/// are dispatched to their own appliers below; every other op carries a
/// `window_id` (default `"main"`) naming the single window whose tree it
/// resolves against — see `apply_layout_op`. `ws.windows` is seeded with
/// `default_window()` on first use, same as Phase 2.
pub fn apply(ws: &mut Workspace, op: WorkspaceOp) {
    if ws.windows.is_empty() {
        ws.windows.push(default_window());
    }

    match op {
        WorkspaceOp::MoveTabToWindow { tab_id, target_window_id, target_pane_id } => {
            apply_move_tab_to_window(ws, &tab_id, &target_window_id, target_pane_id.as_deref());
        }
        WorkspaceOp::DetachTab { tab_id } => apply_detach_tab(ws, &tab_id),
        WorkspaceOp::WindowClosed { window_id } => apply_window_closed(ws, &window_id),
        other => apply_layout_op(ws, other),
    }
}

/// Applies every `WorkspaceOp` variant except the three window-lifecycle
/// ops (see `apply`). `revision` bumps only when something actually
/// changed — TS returns the same object reference for a no-op action; Rust
/// mutates in place, so we mirror that by comparing old vs. new values
/// (both `LayoutNode` and `WindowModel` derive `PartialEq`) rather than
/// tracking reference identity. See the Task 2 report (Phase 2) for the
/// semantic-choice writeup of edge cases (e.g. `open_tab` re-activating an
/// already-active+focused tab) where this differs from "TS would have
/// returned a new object".
///
/// An op naming an unknown `window_id` no-ops entirely — tree AND `tabs[]`
/// bookkeeping both skip, since there's no window to have resolved a pane
/// inside. This is what makes the window-local DESIGN RULE hold even for
/// the tabs[] side effects below: `CloseTab`/`RenameTab`'s bookkeeping is
/// gated on `tree_changed`, which (for these single-tab-id ops) is `true`
/// if and only if the tab was actually found inside the *resolved* window's
/// tree — so a tab id that happens to also exist in a different window is
/// never touched by an op that didn't target that window. `CloseMany` needs
/// finer-than-one-bool granularity (only some of its many ids may belong to
/// this window), so it precomputes a per-id membership set before the tree
/// mutates.
fn apply_layout_op(ws: &mut Workspace, op: WorkspaceOp) {
    let mut changed = false;

    // Precompute, before the tree mutates, exactly which of CloseMany's
    // requested ids actually live in the window this op resolves to. A tab
    // id absent there must never be deleted from the flat, cross-window
    // `tabs[]` here even if that same id happens to live in a *different*
    // window — pane/tab placement is window-local; ids are not required to
    // be, so a collision (unlikely, but not ruled out) must not leak.
    let close_many_scope: Option<std::collections::HashSet<String>> = match &op {
        WorkspaceOp::CloseMany { tab_ids, window_id } => ws
            .windows
            .iter()
            .find(|w| &w.id == window_id)
            .map(|w| tab_ids.iter().filter(|t| pane_of_tab(&w.split_tree, t).is_some()).cloned().collect()),
        _ => None,
    };

    let tree_changed = if matches!(op, WorkspaceOp::UpdateTabState { .. }) {
        false // tabs-only op — no window to resolve, no layout-tree effect.
    } else {
        let win_id = op_window_id(&op).expect("every non-UpdateTabState WorkspaceOp variant here carries window_id");
        let Some(win) = ws.windows.iter_mut().find(|w| w.id == win_id) else {
            return; // unknown window_id: the whole op no-ops, tabs[] included.
        };
        let (new_root, new_focused) = workspace_reducer(&win.split_tree, &win.focused_pane_id, &op);
        let tc = new_root != win.split_tree || new_focused != win.focused_pane_id;
        if tc {
            win.split_tree = new_root;
            win.focused_pane_id = new_focused;
        }
        tc
    };
    changed |= tree_changed;

    // Rust-only tabs[] bookkeeping — TS has no `tabs` array (the frontend
    // keeps QueryTab[] in App); these mirror the tree op above, gated to
    // the window this op resolved to (see the doc comment above).
    match &op {
        WorkspaceOp::OpenTab { tab: Some(model), .. } => match ws.tabs.iter_mut().find(|t| t.id == model.id) {
            Some(existing) if existing != model => {
                *existing = model.clone();
                changed = true;
            }
            Some(_) => {}
            None => {
                ws.tabs.push(model.clone());
                changed = true;
            }
        },
        WorkspaceOp::CloseTab { tab_id, .. } => {
            // `tree_changed` here is true iff `tab_id` was actually found in
            // the resolved window's tree (removing a present tab always
            // alters that pane's `tab_ids`; a not-found tab leaves the tree
            // byte-for-byte equal) — exactly the membership check we need.
            if tree_changed {
                let before = ws.tabs.len();
                ws.tabs.retain(|t| &t.id != tab_id);
                changed |= ws.tabs.len() != before;
            }
        }
        WorkspaceOp::CloseMany { .. } => {
            if let Some(scope) = &close_many_scope {
                let before = ws.tabs.len();
                ws.tabs.retain(|t| !scope.contains(&t.id));
                changed |= ws.tabs.len() != before;
            }
        }
        WorkspaceOp::RenameTab { old_id, new_id, .. } => {
            // Same reasoning as CloseTab: `tree_changed` <=> `old_id` was
            // present in the resolved window's tree.
            if tree_changed {
                if let Some(t) = ws.tabs.iter_mut().find(|t| &t.id == old_id) {
                    t.id = new_id.clone();
                    changed = true;
                }
            }
        }
        WorkspaceOp::UpdateTabState { tab_id, last_query, last_aggregate, builder_state } => {
            if let Some(t) = ws.tabs.iter_mut().find(|t| &t.id == tab_id) {
                // `patch` is `&Option<Value>` here: present-but-null (`Some(None)`
                // on the op) clears the field; present-with-value sets it.
                // Outer `None` (key absent) leaves the field untouched entirely.
                if let Some(patch) = last_query {
                    if &t.last_query != patch {
                        t.last_query = patch.clone();
                        changed = true;
                    }
                }
                if let Some(patch) = last_aggregate {
                    if &t.last_aggregate != patch {
                        t.last_aggregate = patch.clone();
                        changed = true;
                    }
                }
                if let Some(patch) = builder_state {
                    if &t.builder_state != patch {
                        t.builder_state = patch.clone();
                        changed = true;
                    }
                }
            }
        }
        _ => {}
    }

    if changed {
        ws.revision += 1;
    }
}

/// `MoveTabToWindow`: relocates `tab_id` from wherever it currently lives
/// (found by scanning ALL windows — the op names no source, only a target)
/// into `target_window_id`'s `target_pane_id` (or that window's focused
/// pane if omitted), activating and focusing it there. `tabs[]` is
/// untouched — the tab model already exists; only its layout-tree placement
/// moves. No-op if `tab_id` isn't open anywhere, or `target_window_id`
/// doesn't exist.
///
/// Source-side removal reuses `close_tab`'s fold semantics (a pane that's
/// emptied by the move folds into its sibling, exactly like `CloseTab`). If
/// that leaves the source window's entire tree as a single empty pane (i.e.
/// the source window is now fully empty) and that window isn't `"main"`,
/// the window itself is removed — UNLESS it's also the target window
/// (moving a tab "to" the same window it's already the sole occupant of
/// must never delete the window it's about to be reinserted into).
fn apply_move_tab_to_window(ws: &mut Workspace, tab_id: &str, target_window_id: &str, target_pane_id: Option<&str>) {
    if !ws.windows.iter().any(|w| w.id == target_window_id) {
        return; // unknown target window: no-op
    }
    let Some(source_idx) = ws.windows.iter().position(|w| pane_of_tab(&w.split_tree, tab_id).is_some()) else {
        return; // tab not open anywhere: no-op
    };

    let before = ws.windows.clone();
    let source_window_id = ws.windows[source_idx].id.clone();

    {
        let src = &mut ws.windows[source_idx];
        let (new_root, new_focused) = close_tab(&src.split_tree, &src.focused_pane_id, tab_id);
        src.split_tree = new_root;
        src.focused_pane_id = new_focused;
    }

    let source_is_now_empty =
        matches!(&ws.windows[source_idx].split_tree, LayoutNode::Pane { tab_ids, .. } if tab_ids.is_empty());
    if source_is_now_empty && source_window_id != "main" && source_window_id != target_window_id {
        ws.windows.remove(source_idx);
    }

    let target_win = ws
        .windows
        .iter_mut()
        .find(|w| w.id == target_window_id)
        .expect("target_window_id was checked to exist above and is never the window just removed");
    let resolved_pane = target_pane_id
        .and_then(|pid| find_pane(&target_win.split_tree, pid))
        .map(|p| node_id(p).to_string())
        .unwrap_or_else(|| target_win.focused_pane_id.clone());
    let tab_id_owned = tab_id.to_string();
    target_win.split_tree = map_pane(&target_win.split_tree, &resolved_pane, &mut |p| {
        let LayoutNode::Pane { id, tab_ids, .. } = p else { return None };
        let mut new_tab_ids = tab_ids.clone();
        new_tab_ids.push(tab_id_owned.clone());
        Some(LayoutNode::Pane { id: id.clone(), tab_ids: new_tab_ids, active_tab_id: Some(tab_id_owned.clone()) })
    });
    target_win.focused_pane_id = resolved_pane;

    if ws.windows != before {
        ws.revision += 1;
    }
}

/// `DetachTab`: pulls `tab_id` out of its current window into a brand-new
/// window of its own. No-op if `tab_id` is unknown, or if it's already the
/// only tab in the only pane of a non-`"main"` window — it's already alone,
/// so detaching would just destroy that window and recreate an equivalent
/// one.
///
/// Otherwise: source-side removal reuses the same fold-and-maybe-remove-the-
/// window logic as `apply_move_tab_to_window` (source pane folds; if the
/// source window empties entirely and isn't `"main"`, it's removed — no
/// self-target special case is needed here since the *new* window always
/// gets a fresh `win-N` id, never the source's). Then a new `WindowModel`
/// is pushed: `id` is the next `win-N` (scanning ALL window ids — see
/// `next_window_id`), `split_tree` a single `"pane-1"` holding just this
/// tab, `focused_pane_id: "pane-1"`.
fn apply_detach_tab(ws: &mut Workspace, tab_id: &str) {
    let Some(source_idx) = ws.windows.iter().position(|w| pane_of_tab(&w.split_tree, tab_id).is_some()) else {
        return; // unknown tab: no-op
    };

    let already_alone = {
        let src = &ws.windows[source_idx];
        src.id != "main"
            && matches!(&src.split_tree, LayoutNode::Pane { tab_ids, .. } if tab_ids.len() == 1 && tab_ids[0] == tab_id)
    };
    if already_alone {
        return;
    }

    let before = ws.windows.clone();

    let source_window_id = ws.windows[source_idx].id.clone();
    {
        let src = &mut ws.windows[source_idx];
        let (new_root, new_focused) = close_tab(&src.split_tree, &src.focused_pane_id, tab_id);
        src.split_tree = new_root;
        src.focused_pane_id = new_focused;
    }
    let source_is_now_empty =
        matches!(&ws.windows[source_idx].split_tree, LayoutNode::Pane { tab_ids, .. } if tab_ids.is_empty());
    if source_is_now_empty && source_window_id != "main" {
        ws.windows.remove(source_idx);
    }

    let new_window_id = next_window_id(ws);
    ws.windows.push(WindowModel {
        id: new_window_id,
        split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec![tab_id.to_string()], active_tab_id: Some(tab_id.to_string()) },
        focused_pane_id: "pane-1".into(),
    });

    if ws.windows != before {
        ws.revision += 1;
    }
}

/// `WindowClosed`: a frontend window was closed. No-op for `"main"` (the
/// primary window can't be closed this way) or an unknown id. Otherwise
/// removes the window from `ws.windows` AND removes every tab id its layout
/// tree referenced from `ws.tabs` — per spec, closing a secondary window
/// closes its tabs (unlike `MoveTabToWindow`/`DetachTab`, which relocate a
/// tab's layout placement but never touch `tabs[]`).
fn apply_window_closed(ws: &mut Workspace, window_id: &str) {
    if window_id == "main" {
        return;
    }
    let Some(idx) = ws.windows.iter().position(|w| w.id == window_id) else {
        return; // unknown window: no-op
    };
    let removed = ws.windows.remove(idx);
    let mut removed_tab_ids = Vec::new();
    collect_tab_ids(&removed.split_tree, &mut removed_tab_ids);
    ws.tabs.retain(|t| !removed_tab_ids.contains(&t.id));
    ws.revision += 1; // removing a found, non-main window always changes something
}

/// The id of the window whose layout tree currently references `tab_id`, or
/// `None` if it isn't open anywhere. Pure and `pub(crate)` (Phase 3 Task 5):
/// `windows.rs`'s `workspace_detach_tab` command calls `apply_impl` with a
/// `DetachTab` op (which always mints a brand-new `win-N` for the detached
/// tab — see `apply_detach_tab`), then needs to learn that fresh window's id
/// from the post-apply `Workspace` snapshot the payload carries in order to
/// spawn its OS window. Scanning for the window that now contains `tab_id` is
/// simpler and more robust than re-deriving `next_window_id`'s numbering a
/// second time on the Rust-command side (which would silently desync if
/// `apply_detach_tab`'s minting logic ever changed).
pub(crate) fn window_containing_tab<'a>(ws: &'a Workspace, tab_id: &str) -> Option<&'a str> {
    ws.windows
        .iter()
        .find(|w| pane_of_tab(&w.split_tree, tab_id).is_some())
        .map(|w| w.id.as_str())
}

/// Port of TS's tab-id collection helpers (`allTabIds`), used only by
/// `validate` below — flattens every `tabIds` entry across an entire
/// `LayoutNode` tree, panes and splits alike.
fn collect_tab_ids(node: &LayoutNode, out: &mut Vec<String>) {
    match node {
        LayoutNode::Pane { tab_ids, .. } => out.extend(tab_ids.iter().cloned()),
        LayoutNode::Split { children, .. } => {
            for c in children {
                collect_tab_ids(c, out);
            }
        }
    }
}

/// True if `ws` is structurally sound enough to hydrate the frontend
/// without crashing render, or panicking `map_pane`/`workspace_reducer`
/// deep inside the reducer the moment any op touches a malformed node —
/// which, since every mutation runs inside `AppState.workspace`'s held
/// mutex, would poison it and kill persistence for the rest of the
/// session. None of this is reachable through this app's own reducers
/// (every `Split` they ever mint has exactly 2 children, every `ratio`
/// they ever write is clamped to `[MIN_RATIO, MAX_RATIO]`) — only a
/// hand-edited file or a future format regression can produce it. Checked
/// once at load time so a broken file degrades to "start fresh" instead of
/// "crash on next click".
///
/// Checks, per window: every `Split` node has exactly 2 children; every
/// `ratio` is finite and strictly between 0 and 1; the tree resolves to at
/// least one pane; `focused_pane_id` names a pane that actually exists in
/// that same tree; and, across ALL windows combined, no tab id appears
/// twice (a reducer op can never produce that — `open_tab` on an
/// already-placed id just re-focuses it — so a duplicate can only mean a
/// corrupt file).
///
/// Window-level checks (Phase 3 Task 2): every `WindowModel.id` is unique;
/// a `"main"` window must exist (every op that omits `window_id` targets it,
/// and `WindowClosed`/`DetachTab`'s "non-main" special-casing assumes it's
/// always there); every non-`"main"` window holds at least one tab
/// (`WindowClosed` and the fold-empties-non-main-window paths in
/// `apply_move_tab_to_window`/`apply_detach_tab` remove a secondary window
/// the instant it empties, so a persisted empty secondary window can only
/// mean a corrupt file — `"main"` is exempt, since an empty root pane is
/// exactly Phase 2's initial state).
///
/// A dangling `focused_pane_id` is treated as invalid here rather than
/// silently repaired to the tree's first pane: `validate` takes `&Workspace`
/// and only ever reports a yes/no, so "repair" would mean a second, mutable
/// pass threaded through `load_from_file` for a case a hand-edited/corrupt
/// file already put in serious doubt — simpler, and consistent with every
/// other check here, to just reject and start fresh.
fn validate(ws: &Workspace) -> bool {
    fn shape(node: &LayoutNode) -> Option<usize> {
        match node {
            LayoutNode::Pane { .. } => Some(1),
            LayoutNode::Split { ratio, children, .. } => {
                if !ratio.is_finite() || *ratio <= 0.0 || *ratio >= 1.0 || children.len() != 2 {
                    return None;
                }
                Some(shape(&children[0])? + shape(&children[1])?)
            }
        }
    }

    if !ws.windows.iter().any(|w| w.id == "main") {
        return false;
    }

    let mut seen_window_ids = std::collections::HashSet::new();
    let mut seen_tab_ids = std::collections::HashSet::new();
    for win in &ws.windows {
        if !seen_window_ids.insert(win.id.as_str()) {
            return false; // duplicate window id
        }
        match shape(&win.split_tree) {
            Some(n) if n >= 1 => {}
            _ => return false,
        }
        if find_pane(&win.split_tree, &win.focused_pane_id).is_none() {
            return false;
        }
        let mut ids = Vec::new();
        collect_tab_ids(&win.split_tree, &mut ids);
        if win.id != "main" && ids.is_empty() {
            return false; // a non-main window must hold at least one tab
        }
        for id in ids {
            if !seen_tab_ids.insert(id) {
                return false;
            }
        }
    }
    true
}

/// Load the workspace document. A missing file, one that fails to parse as
/// JSON, or one that parses but fails `validate` (valid JSON, broken
/// document — see `validate`'s doc comment) all yield `None` — persistence
/// must never block startup, and fresh boot beats crashed boot — mirroring
/// queries.rs:83-84.
pub fn load_from_file(path: &Path) -> Option<Workspace> {
    let ws: Workspace = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())?;
    if !validate(&ws) {
        return None;
    }
    Some(ws)
}

/// Save the workspace document, pretty-printed. Errors are stringified so
/// callers (Tauri commands) can surface them without leaking IO types.
///
/// Written to `<path>.tmp` first, then renamed into place (Fix 5, #97 phase
/// 2 final review): `rename` within the same directory is atomic on every
/// platform this app ships for, so a crash or power loss mid-write can never
/// leave a truncated/corrupt `workspace.json` on disk — the file is always
/// either the fully-old or the fully-new content. Before this, a crash
/// mid-`fs::write` left a corrupt file that `load_from_file` would then fail
/// to parse (or fail `validate`) on every future boot, until the user
/// deleted it by hand.
pub fn save_to_file(path: &Path, ws: &Workspace) -> Result<(), String> {
    let content = serde_json::to_string_pretty(ws)
        .map_err(|e| format!("Failed to serialize workspace: {}", e))?;
    let mut tmp_os = path.as_os_str().to_os_string();
    tmp_os.push(".tmp");
    let tmp_path = PathBuf::from(tmp_os);
    fs::write(&tmp_path, content).map_err(|e| format!("Failed to write workspace file: {}", e))?;
    fs::rename(&tmp_path, path).map_err(|e| format!("Failed to finalize workspace file: {}", e))
}

/// Where workspace.json lives, mirroring `queries::get_queries_path`
/// (queries.rs:72-81). `pub(crate)` (Phase 3 Task 5): `windows.rs`'s
/// `workspace_detach_tab`/`spawn_saved_windows`/`close_workspace_window`
/// commands, and the `CloseRequested` handler `spawn_workspace_window`
/// attaches to every `win-*` window, all need to resolve the same path this
/// module's own `workspace_get`/`workspace_apply` commands use.
pub(crate) fn workspace_path(app_handle: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    match app_handle.path().app_config_dir() {
        Ok(mut path) => {
            let _ = fs::create_dir_all(&path);
            path.push("workspace.json");
            path
        }
        Err(_) => PathBuf::from("workspace.json"),
    }
}

// ---------------------------------------------------------------------------
// Store commands — in-memory cache of the workspace document plus a
// debounced, single-flight save. `get_impl`/`apply_impl` take `&AppState`
// and a plain `&Path` (rather than an `AppHandle`) so they're testable with
// temp-dir paths and no live Tauri app; `workspace_get`/`workspace_apply`
// are thin `#[tauri::command]` wrappers that resolve the real
// `workspace_path()` and delegate, mirroring the connect_db/connect_db_impl
// idiom in lib.rs.
// ---------------------------------------------------------------------------

/// Return the in-memory workspace, populating it from `path` on first call.
/// "First-get-loads-file-once": once `state.workspace` holds a value (even
/// `None` was never stored — only `Some` counts as populated), later calls
/// return the cached copy and never re-read the file, so an external edit to
/// the file after the first call has no effect on subsequent gets.
pub fn get_impl(state: &AppState, path: &Path) -> Result<Option<Workspace>, String> {
    let mut guard = state.workspace.lock_safe()?;
    if guard.is_none() {
        *guard = load_from_file(path);
    }
    Ok(guard.clone())
}

/// True if `own_gen` is still the most recently minted write generation —
/// i.e. no later `apply_impl` call has superseded this debounced save since
/// it was scheduled. Pulled out as a pure function so the single-flight
/// decision is unit-testable without spinning up a tokio runtime.
fn should_write(current_gen: u64, own_gen: u64) -> bool {
    current_gen == own_gen
}

/// Apply one op to `ws` and describe the result — `Some(payload)` iff the op
/// actually changed state, `None` for a no-op. Pure (no `AppState`, no
/// `AppHandle`, no IO): this is what makes the `workspace-changed` emit
/// decision unit-testable on its own, independent of the store's
/// lock/debounced-save plumbing in `apply_impl` and the `AppHandle`-only
/// `.emit()` call in the `workspace_apply` command wrapper.
fn apply_and_describe(ws: &mut Workspace, op: WorkspaceOp, origin: String) -> Option<WorkspaceChangedPayload> {
    let cross_window = op_is_cross_window(&op);
    let before_revision = ws.revision;
    apply(ws, op);
    if ws.revision == before_revision {
        return None;
    }
    Some(WorkspaceChangedPayload { revision: ws.revision, origin, cross_window, workspace: ws.clone() })
}

/// Apply one op to the in-memory workspace — initializing it (and its
/// default `main` window) on first use — and, if anything actually changed,
/// schedule a debounced save and return a `workspace-changed` payload for
/// the caller (the `workspace_apply` command) to broadcast.
///
/// Single-flight, last-writer-wins: every real change mints a new
/// generation via `state.workspace_write_gen.fetch_add`, *inside* the same
/// critical section that mutated the workspace, so generation order matches
/// mutation order even under concurrent callers. The spawned task sleeps
/// 500ms then only writes if its captured generation still equals the
/// current one; a burst of N changes therefore mints N generations but at
/// most one of the N spawned tasks ever finds its generation still current,
/// so at most one write hits disk. That surviving task writes a snapshot
/// cloned synchronously right after its own mutation (while the lock was
/// still held) rather than re-locking after the sleep — the two are
/// provably equivalent here: if its generation still compares equal after
/// the sleep, no later `apply_impl` call has run (that would have minted a
/// higher generation), so the workspace cannot have changed since the
/// snapshot was taken.
///
/// The `std::sync::MutexGuard` above is dropped before this function ever
/// spawns or awaits anything — required for correctness, since a std guard
/// is `!Send` and cannot cross an `.await` point.
pub fn apply_impl(
    state: &AppState,
    path: &Path,
    op: WorkspaceOp,
    origin: String,
) -> Result<Option<WorkspaceChangedPayload>, String> {
    let (payload, scheduled): (Option<WorkspaceChangedPayload>, Option<(Workspace, u64)>) = {
        let mut guard = state.workspace.lock_safe()?;
        let ws = guard.get_or_insert_with(Workspace::default);
        let payload = apply_and_describe(ws, op, origin);
        let scheduled = payload.as_ref().map(|p| {
            let gen = state.workspace_write_gen.fetch_add(1, Ordering::SeqCst) + 1;
            (p.workspace.clone(), gen)
        });
        (payload, scheduled)
    }; // guard dropped here, before any spawn/await.

    if let Some((snapshot, gen)) = scheduled {
        let gen_counter = Arc::clone(&state.workspace_write_gen);
        let path_owned = path.to_path_buf();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if should_write(gen_counter.load(Ordering::SeqCst), gen) {
                let _ = save_to_file(&path_owned, &snapshot);
            }
        });
    }

    Ok(payload)
}

#[tauri::command]
pub async fn workspace_get(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Workspace>, String> {
    get_impl(&state, &workspace_path(&app_handle))
}

/// Origin defaults to `"main"` when the frontend caller omits it. `origin`
/// can't be a plain `String` command parameter with a `#[serde(default)]`
/// fallback the way `WorkspaceOp`'s struct fields are — Tauri's `CommandArg`
/// deserializer errors on a genuinely missing key unless the parameter type
/// is `Option<T>` (a missing key deserializes to `None`; see
/// `tauri::ipc::command::CommandItem::deserialize_option`). So the wire
/// parameter is `Option<String>`, defaulted here — existing callers that
/// don't yet send `origin` (Task 4 wires the frontend) keep working exactly
/// as `#[serde(default = "default_window_id")]` does for `WorkspaceOp`.
/// `pub(crate)` (Phase 3 Task 5): `windows.rs`'s `workspace_detach_tab` /
/// `close_workspace_window` commands take the exact same `Option<String>`
/// `origin` parameter and need the same fallback.
pub(crate) fn default_origin() -> String {
    "main".to_string()
}

#[tauri::command]
pub async fn workspace_apply(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    op: WorkspaceOp,
    origin: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    let origin = origin.unwrap_or_else(default_origin);
    let payload = apply_impl(&state, &workspace_path(&app_handle), op, origin)?;
    if let Some(payload) = payload {
        // Broadcast is best-effort: a window that misses this event
        // re-syncs its workspace via `workspace_get` on its next boot, so a
        // dropped emit (e.g. no windows currently listening) is never fatal.
        let _ = app_handle.emit("workspace-changed", payload);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // Reducer tests — ported 1:1 from src/workspace/__tests__/model.test.ts
    // (same scenario names, snake_case). Where TS asserts `toBe(l0)`
    // (same object reference for a no-op), Rust mutates in place, so we
    // instead clone the workspace beforehand and assert full equality —
    // an equivalent check since `apply`'s changed-flag guarantees no
    // mutation happened at all when nothing changed.
    // -----------------------------------------------------------------

    fn ws_with(tab_ids: &[&str]) -> Workspace {
        let ids: Vec<String> = tab_ids.iter().map(|s| s.to_string()).collect();
        let active = ids.first().cloned();
        Workspace {
            revision: 0,
            windows: vec![WindowModel {
                id: "main".into(),
                focused_pane_id: "pane-1".into(),
                split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: ids, active_tab_id: active },
            }],
            tabs: vec![],
        }
    }

    fn root(ws: &Workspace) -> &LayoutNode {
        &ws.windows[0].split_tree
    }

    fn pane_fields(node: &LayoutNode) -> (&str, &[String], Option<&str>) {
        match node {
            LayoutNode::Pane { id, tab_ids, active_tab_id } => (id.as_str(), tab_ids.as_slice(), active_tab_id.as_deref()),
            LayoutNode::Split { .. } => panic!("expected a pane node, got a split"),
        }
    }

    fn split_fields(node: &LayoutNode) -> (&str, &str, f64, &[LayoutNode]) {
        match node {
            LayoutNode::Split { id, dir, ratio, children } => (id.as_str(), dir.as_str(), *ratio, children.as_slice()),
            LayoutNode::Pane { .. } => panic!("expected a split node, got a pane"),
        }
    }

    fn collect_ids(node: &LayoutNode, out: &mut Vec<String>) {
        out.push(node_id(node).to_string());
        if let LayoutNode::Split { children, .. } = node {
            for c in children {
                collect_ids(c, out);
            }
        }
    }

    #[test]
    fn creates_single_root_pane_holding_the_tabs() {
        // Port of the TS `createInitialLayout` test. Rust has no standalone
        // "create initial layout" entry point — the equivalent is `apply`'s
        // lazy default-window initialization, exercised here via a no-op-ish
        // op on an empty `Workspace`.
        let mut ws = Workspace::default();
        apply(&mut ws, WorkspaceOp::FocusPane { pane_id: "pane-1".into(), window_id: "main".into() });
        assert_eq!(ws.windows.len(), 1);
        assert_eq!(ws.windows[0].id, "main");
        let (id, tab_ids, active_tab_id) = pane_fields(root(&ws));
        assert_eq!(id, "pane-1");
        assert!(tab_ids.is_empty());
        assert_eq!(active_tab_id, None);
        assert_eq!(ws.windows[0].focused_pane_id, "pane-1");
    }

    #[test]
    fn open_tab_appends_new_tab_and_activates_it() {
        let mut ws = ws_with(&["a"]);
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "b".into(), pane_id: None, tab: None, window_id: "main".into() });
        let (_, tab_ids, active_tab_id) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["a", "b"]);
        assert_eq!(active_tab_id, Some("b"));
        assert_eq!(ws.revision, 1);
    }

    #[test]
    fn open_tab_focuses_and_activates_existing_tab_dedupe() {
        let mut ws = ws_with(&["a", "b"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()), window_id: "main".into() },
        );
        let pane_a = node_id(pane_of_tab(root(&ws), "a").unwrap()).to_string();
        apply(&mut ws, WorkspaceOp::FocusPane { pane_id: pane_a, window_id: "main".into() });
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "b".into(), pane_id: None, tab: None, window_id: "main".into() });
        let pane_b_id = node_id(pane_of_tab(root(&ws), "b").unwrap()).to_string();
        let (_, tab_ids, _) = pane_fields(find_pane(root(&ws), &pane_b_id).unwrap());
        assert_eq!(tab_ids, ["b"]); // still exactly one 'b' in that pane
        assert_eq!(ws.windows[0].focused_pane_id, pane_b_id);
        let mut all = Vec::new();
        all_panes(root(&ws), &mut all);
        let b_count: usize = all.iter().map(|p| pane_fields(p).1.iter().filter(|t| **t == "b").count()).sum();
        assert_eq!(b_count, 1);
    }

    #[test]
    fn split_pane_splits_into_row_ratio_0_5_and_focuses_new_pane() {
        let mut ws = ws_with(&["a", "b"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()), window_id: "main".into() },
        );
        let (id, dir, ratio, children) = split_fields(root(&ws));
        assert_eq!(id, "split-1");
        assert_eq!(dir, "row");
        assert_eq!(ratio, 0.5);
        let (_, left_tabs, _) = pane_fields(&children[0]);
        let (right_id, right_tabs, right_active) = pane_fields(&children[1]);
        assert_eq!(left_tabs, ["a"]);
        assert_eq!(right_tabs, ["b"]);
        assert_eq!(right_active, Some("b"));
        assert_eq!(ws.windows[0].focused_pane_id, right_id);
    }

    #[test]
    fn split_pane_side_start_puts_new_pane_first() {
        let mut ws = ws_with(&["a", "b"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "col".into(), side: "start".into(), move_tab_id: Some("b".into()), window_id: "main".into() },
        );
        let (_, _, _, children) = split_fields(root(&ws));
        let (_, first_tabs, _) = pane_fields(&children[0]);
        assert_eq!(first_tabs, ["b"]);
    }

    #[test]
    fn split_pane_is_noop_when_moving_only_tab() {
        let mut ws = ws_with(&["a"]);
        let before = ws.clone();
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("a".into()), window_id: "main".into() },
        );
        assert_eq!(ws, before);
        assert_eq!(ws.revision, 0);
    }

    #[test]
    fn split_pane_without_moving_tab_creates_empty_pane() {
        let mut ws = ws_with(&["a"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: None, window_id: "main".into() });
        let (_, _, _, children) = split_fields(root(&ws));
        let (_, right_tabs, right_active) = pane_fields(&children[1]);
        assert!(right_tabs.is_empty());
        assert_eq!(right_active, None);
    }

    #[test]
    fn close_tab_activates_last_remaining_tab() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::SetActive { pane_id: root_id, tab_id: "c".into(), window_id: "main".into() });
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "c".into(), window_id: "main".into() });
        let (_, tab_ids, active) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["a", "b"]);
        assert_eq!(active, Some("b"));
    }

    #[test]
    fn close_tab_folds_emptied_non_root_pane_into_sibling() {
        let mut ws = ws_with(&["a", "b"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()), window_id: "main".into() },
        );
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "b".into(), window_id: "main".into() });
        let (id, tab_ids, _) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["a"]);
        assert_eq!(ws.windows[0].focused_pane_id, id);
    }

    #[test]
    fn close_tab_leaves_empty_root_pane_in_place() {
        let mut ws = ws_with(&["a"]);
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "a".into(), window_id: "main".into() });
        let (_, tab_ids, active) = pane_fields(root(&ws));
        assert!(tab_ids.is_empty());
        assert_eq!(active, None);
    }

    #[test]
    fn close_tab_folds_nested_splits_depth_2() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()), window_id: "main".into() },
        );
        let pane_b = node_id(pane_of_tab(root(&ws), "b").unwrap()).to_string();
        // 'c' must belong to pane_b before it can be split off from it.
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "c".into(), target_pane_id: pane_b.clone(), index: None, window_id: "main".into() });
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: pane_b, dir: "col".into(), side: "end".into(), move_tab_id: Some("c".into()), window_id: "main".into() },
        );
        let mut all = Vec::new();
        all_panes(root(&ws), &mut all);
        assert_eq!(all.len(), 3);
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "c".into(), window_id: "main".into() }); // pane empties -> depth-2 fold
        let mut all2 = Vec::new();
        all_panes(root(&ws), &mut all2);
        assert_eq!(all2.len(), 2);
        assert!(pane_of_tab(root(&ws), "b").is_some());
        assert!(pane_of_tab(root(&ws), "a").is_some());
    }

    #[test]
    fn close_tab_empty_pane_persists_across_unrelated_close() {
        // Phase 1 Critical regression: an empty pane created by split_pane
        // (no move_tab_id) must NOT be swept away by an unrelated close_tab.
        let mut ws = ws_with(&["a", "b"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: None, window_id: "main".into() });
        let mut all = Vec::new();
        all_panes(root(&ws), &mut all);
        assert_eq!(all.len(), 2);
        let empty_pane_id = all.iter().find(|p| pane_fields(p).1.is_empty()).map(|p| node_id(p).to_string()).unwrap();
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "b".into(), window_id: "main".into() });
        let mut all2 = Vec::new();
        all_panes(root(&ws), &mut all2);
        assert_eq!(all2.len(), 2);
        assert!(find_pane(root(&ws), &empty_pane_id).is_some());
    }

    #[test]
    fn close_tab_activates_right_hand_neighbor() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::SetActive { pane_id: root_id, tab_id: "b".into(), window_id: "main".into() });
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "b".into(), window_id: "main".into() });
        let (_, tab_ids, active) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["a", "c"]);
        assert_eq!(active, Some("c"));
    }

    #[test]
    fn close_many_closes_all_and_folds_emptied_panes() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("c".into()), window_id: "main".into() },
        );
        apply(&mut ws, WorkspaceOp::CloseMany { tab_ids: vec!["b".into(), "c".into()], window_id: "main".into() });
        let mut all = Vec::new();
        all_panes(root(&ws), &mut all);
        assert_eq!(all.len(), 1);
        let (_, tab_ids, _) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["a"]);
    }

    #[test]
    fn move_tab_moves_to_another_pane_activates_and_focuses() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("c".into()), window_id: "main".into() },
        );
        let target = node_id(pane_of_tab(root(&ws), "c").unwrap()).to_string();
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "b".into(), target_pane_id: target.clone(), index: None, window_id: "main".into() });
        assert_eq!(node_id(pane_of_tab(root(&ws), "b").unwrap()), target);
        let (_, tab_ids, active) = pane_fields(find_pane(root(&ws), &target).unwrap());
        assert_eq!(tab_ids, ["c", "b"]);
        assert_eq!(active, Some("b"));
        assert_eq!(ws.windows[0].focused_pane_id, target);
    }

    #[test]
    fn move_tab_folds_source_pane_when_emptied() {
        let mut ws = ws_with(&["a", "b"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()), window_id: "main".into() },
        );
        let source_b = node_id(pane_of_tab(root(&ws), "b").unwrap()).to_string();
        let target_a = node_id(pane_of_tab(root(&ws), "a").unwrap()).to_string();
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "b".into(), target_pane_id: target_a, index: None, window_id: "main".into() });
        let (_, tab_ids, _) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["a", "b"]);
        assert!(find_pane(root(&ws), &source_b).is_none());
    }

    #[test]
    fn move_tab_reorders_within_same_pane_using_index() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "c".into(), target_pane_id: root_id, index: Some(0), window_id: "main".into() });
        let (_, tab_ids, _) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["c", "a", "b"]);
    }

    #[test]
    fn resize_split_sets_and_clamps_ratio() {
        let mut ws = ws_with(&["a", "b"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()), window_id: "main".into() },
        );
        let split_id = node_id(root(&ws)).to_string();

        let mut a = ws.clone();
        apply(&mut a, WorkspaceOp::ResizeSplit { split_id: split_id.clone(), ratio: 0.3, window_id: "main".into() });
        assert_eq!(split_fields(root(&a)).2, 0.3);

        let mut b = ws.clone();
        apply(&mut b, WorkspaceOp::ResizeSplit { split_id: split_id.clone(), ratio: 0.01, window_id: "main".into() });
        assert_eq!(split_fields(root(&b)).2, 0.15);

        let mut c = ws.clone();
        apply(&mut c, WorkspaceOp::ResizeSplit { split_id, ratio: 0.99, window_id: "main".into() });
        assert_eq!(split_fields(root(&c)).2, 0.85);
    }

    #[test]
    fn rename_tab_rewrites_id_everywhere_including_active() {
        let mut ws = ws_with(&["conn.db.old"]);
        apply(&mut ws, WorkspaceOp::RenameTab { old_id: "conn.db.old".into(), new_id: "conn.db.new".into(), window_id: "main".into() });
        let (_, tab_ids, active) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["conn.db.new"]);
        assert_eq!(active, Some("conn.db.new"));
    }

    #[test]
    fn unknown_ids_are_noops_without_revision_bump() {
        let mut ws = ws_with(&["a"]);
        let before = ws.clone();
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "nope".into(), window_id: "main".into() });
        assert_eq!(ws, before);
        apply(&mut ws, WorkspaceOp::SetActive { pane_id: "nope".into(), tab_id: "a".into(), window_id: "main".into() });
        assert_eq!(ws, before);
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "a".into(), target_pane_id: "nope".into(), index: None, window_id: "main".into() });
        assert_eq!(ws, before);
        apply(&mut ws, WorkspaceOp::ResizeSplit { split_id: "nope".into(), ratio: 0.5, window_id: "main".into() });
        assert_eq!(ws, before);
        assert_eq!(ws.revision, 0);
    }

    // -- Rust-only: tabs[] bookkeeping and id-counter seeding -----------

    fn sample_tab(id: &str) -> TabModel {
        TabModel {
            id: id.into(),
            tab_type: "documents".into(),
            profile_id: "p1".into(),
            profile_name: "Profile 1".into(),
            db: "mydb".into(),
            collection: "mycoll".into(),
            index_name: None,
            last_query: None,
            last_aggregate: None,
            builder_state: None,
        }
    }

    #[test]
    fn open_tab_upserts_tab_model_into_tabs() {
        let mut ws = ws_with(&[]);
        let tab = sample_tab("t1");
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "t1".into(), pane_id: None, tab: Some(tab.clone()), window_id: "main".into() });
        assert_eq!(ws.tabs, vec![tab.clone()]);
        assert_eq!(ws.revision, 1);

        // Re-opening with an identical model is a true no-op: no revision bump.
        let rev_before = ws.revision;
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "t1".into(), pane_id: None, tab: Some(tab.clone()), window_id: "main".into() });
        assert_eq!(ws.revision, rev_before);

        // A changed model (e.g. renamed profile) upserts in place, replacing not duplicating.
        let mut renamed = tab.clone();
        renamed.profile_name = "Renamed".into();
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "t1".into(), pane_id: None, tab: Some(renamed.clone()), window_id: "main".into() });
        assert_eq!(ws.tabs, vec![renamed]);
        assert_eq!(ws.revision, rev_before + 1);
    }

    #[test]
    fn update_tab_state_patches_selected_fields_only() {
        let mut ws = ws_with(&["t1"]);
        let mut tab = sample_tab("t1");
        tab.last_query = Some(serde_json::json!({"filter": "{}"}));
        ws.tabs.push(tab);
        let root_before = root(&ws).clone();

        apply(
            &mut ws,
            WorkspaceOp::UpdateTabState {
                tab_id: "t1".into(),
                last_query: None, // absent from the patch: untouched
                last_aggregate: Some(Some(serde_json::json!([{"$match": {}}]))), // present: set
                builder_state: None,
            },
        );
        let t = &ws.tabs[0];
        assert_eq!(t.last_query, Some(serde_json::json!({"filter": "{}"}))); // untouched (absent from the patch)
        assert_eq!(t.last_aggregate, Some(serde_json::json!([{"$match": {}}]))); // patched
        assert_eq!(t.builder_state, None);
        assert_eq!(ws.revision, 1);
        assert_eq!(root(&ws), &root_before); // a tabs-only op never touches the layout tree

        // Re-applying the identical patch is a true no-op.
        let rev_before = ws.revision;
        apply(
            &mut ws,
            WorkspaceOp::UpdateTabState {
                tab_id: "t1".into(),
                last_query: None,
                last_aggregate: Some(Some(serde_json::json!([{"$match": {}}]))),
                builder_state: None,
            },
        );
        assert_eq!(ws.revision, rev_before);
    }

    #[test]
    fn update_tab_state_explicit_null_clears_a_previously_set_field() {
        // Reviewer-flagged CRITICAL: absent and explicit-null both used to
        // decode to `None` (single Option), so there was no way to clear a
        // field once set. The double-Option `Some(None)` patch must clear it.
        let mut ws = ws_with(&["t1"]);
        let mut tab = sample_tab("t1");
        tab.last_aggregate = Some(serde_json::json!([{"$match": {}}]));
        ws.tabs.push(tab);

        apply(
            &mut ws,
            WorkspaceOp::UpdateTabState {
                tab_id: "t1".into(),
                last_query: None,
                last_aggregate: Some(None), // explicit null: clear
                builder_state: None,
            },
        );
        assert_eq!(ws.tabs[0].last_aggregate, None);
        assert_eq!(ws.revision, 1);
    }

    #[test]
    fn update_tab_state_absent_field_leaves_it_untouched() {
        let mut ws = ws_with(&["t1"]);
        let mut tab = sample_tab("t1");
        tab.last_query = Some(serde_json::json!({"filter": "{}"}));
        ws.tabs.push(tab);

        apply(
            &mut ws,
            WorkspaceOp::UpdateTabState {
                tab_id: "t1".into(),
                last_query: None, // absent: untouched, NOT cleared
                last_aggregate: None,
                builder_state: None,
            },
        );
        assert_eq!(ws.tabs[0].last_query, Some(serde_json::json!({"filter": "{}"})));
        assert_eq!(ws.revision, 0);
    }

    #[test]
    fn update_tab_state_clearing_an_already_none_field_does_not_bump_revision() {
        let mut ws = ws_with(&["t1"]);
        ws.tabs.push(sample_tab("t1")); // last_aggregate already None

        apply(
            &mut ws,
            WorkspaceOp::UpdateTabState {
                tab_id: "t1".into(),
                last_query: None,
                last_aggregate: Some(None), // explicit null on an already-None field: no-op
                builder_state: None,
            },
        );
        assert_eq!(ws.tabs[0].last_aggregate, None);
        assert_eq!(ws.revision, 0);
    }

    #[test]
    fn pane_and_split_id_counters_seed_past_max_existing_suffix() {
        // A tree restored from workspace.json already contains pane-7 /
        // split-2; freshly minted ids must not collide with them.
        let mut ws = Workspace {
            revision: 0,
            windows: vec![WindowModel {
                id: "main".into(),
                focused_pane_id: "pane-3".into(),
                split_tree: LayoutNode::Split {
                    id: "split-2".into(),
                    dir: "row".into(),
                    ratio: 0.5,
                    children: vec![
                        LayoutNode::Pane {
                            id: "pane-3".into(),
                            tab_ids: vec!["a".into(), "x".into()],
                            active_tab_id: Some("a".into()),
                        },
                        LayoutNode::Pane { id: "pane-7".into(), tab_ids: vec!["b".into()], active_tab_id: Some("b".into()) },
                    ],
                },
            }],
            tabs: vec![],
        };
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: "pane-3".into(), dir: "row".into(), side: "end".into(), move_tab_id: Some("x".into()), window_id: "main".into() },
        );
        let mut ids = Vec::new();
        collect_ids(root(&ws), &mut ids);
        assert!(ids.contains(&"pane-8".to_string()), "expected pane-8 past existing pane-7, got {ids:?}");
        assert!(ids.contains(&"split-3".to_string()), "expected split-3 past existing split-2, got {ids:?}");
    }

    #[test]
    fn op_json_tags_match_frontend_action_types() {
        let op: WorkspaceOp = serde_json::from_str(
            r#"{"type":"split_pane","pane_id":"pane-1","dir":"row","side":"end","move_tab_id":"a"}"#,
        )
        .expect("split_pane decodes");
        assert!(matches!(op, WorkspaceOp::SplitPane { .. }));
        let op: WorkspaceOp = serde_json::from_str(
            r#"{"type":"update_tab_state","tab_id":"a","last_query":{"filter":"{}"}}"#,
        )
        .expect("update_tab_state decodes");
        assert!(matches!(op, WorkspaceOp::UpdateTabState { .. }));
    }

    #[test]
    fn workspace_document_roundtrips_camel_case() {
        let ws = Workspace {
            revision: 3,
            windows: vec![WindowModel {
                id: "main".into(),
                focused_pane_id: "pane-1".into(),
                split_tree: LayoutNode::Split {
                    id: "split-1".into(),
                    dir: "row".into(),
                    ratio: 0.5,
                    children: vec![
                        LayoutNode::Pane {
                            id: "pane-1".into(),
                            tab_ids: vec!["a".into()],
                            active_tab_id: Some("a".into()),
                        },
                        LayoutNode::Pane {
                            id: "pane-2".into(),
                            tab_ids: vec![],
                            active_tab_id: None,
                        },
                    ],
                },
            }],
            tabs: vec![],
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains(r#""focusedPaneId":"pane-1""#));
        assert!(json.contains(r#""kind":"split""#));
        assert!(json.contains(r#""tabIds":["a"]"#));
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ws);
    }

    #[test]
    fn load_missing_or_corrupt_file_yields_none() {
        assert!(load_from_file(Path::new("/nonexistent/workspace.json")).is_none());
        let dir = std::env::temp_dir().join("mqlens-ws-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("corrupt.json");
        std::fs::write(&p, "not json").unwrap();
        assert!(load_from_file(&p).is_none());
    }

    // -----------------------------------------------------------------
    // `validate`/`load_from_file` malformed-document tests (#97 phase 2
    // final review Fix 4). Each fixture is valid JSON but a document no
    // reducer op could ever have produced — hand-edited or from a future
    // format regression — and must degrade to "start fresh" (`None`)
    // rather than surviving to crash the frontend's render or panic the
    // reducer later, inside the store's held mutex.
    // -----------------------------------------------------------------

    fn validate_fixture_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("mqlens-ws-validate-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn load_rejects_split_with_wrong_child_count() {
        let p = validate_fixture_path("bad-split-arity.json");
        let json = r#"{
            "revision": 1,
            "windows": [{
                "id": "main",
                "focusedPaneId": "pane-1",
                "splitTree": {
                    "kind": "split", "id": "split-1", "dir": "row", "ratio": 0.5,
                    "children": [
                        { "kind": "pane", "id": "pane-1", "tabIds": [], "activeTabId": null }
                    ]
                }
            }],
            "tabs": []
        }"#;
        std::fs::write(&p, json).unwrap();
        assert!(load_from_file(&p).is_none(), "a split with != 2 children must not load");
    }

    #[test]
    fn load_rejects_non_finite_ratio() {
        let p = validate_fixture_path("nonfinite-ratio.json");
        // `1e400` is syntactically a valid JSON number that overflows f64 to
        // infinity on parse — the only way to get serde_json to actually
        // deserialize a non-finite float. It can't parse a bare `NaN` token
        // (not valid JSON), and serde_json's own serializer writes `null`
        // for a Rust-side NaN/Infinity value, so this fixture can't be
        // produced by round-tripping a `Workspace` — it has to be authored
        // as raw JSON text.
        let json = r#"{
            "revision": 1,
            "windows": [{
                "id": "main",
                "focusedPaneId": "pane-1",
                "splitTree": {
                    "kind": "split", "id": "split-1", "dir": "row", "ratio": 1e400,
                    "children": [
                        { "kind": "pane", "id": "pane-1", "tabIds": [], "activeTabId": null },
                        { "kind": "pane", "id": "pane-2", "tabIds": [], "activeTabId": null }
                    ]
                }
            }],
            "tabs": []
        }"#;
        std::fs::write(&p, json).unwrap();
        assert!(load_from_file(&p).is_none(), "a non-finite ratio must not load");
    }

    #[test]
    fn load_rejects_out_of_range_ratio() {
        let p = validate_fixture_path("out-of-range-ratio.json");
        let json = r#"{
            "revision": 1,
            "windows": [{
                "id": "main",
                "focusedPaneId": "pane-1",
                "splitTree": {
                    "kind": "split", "id": "split-1", "dir": "row", "ratio": 1.5,
                    "children": [
                        { "kind": "pane", "id": "pane-1", "tabIds": [], "activeTabId": null },
                        { "kind": "pane", "id": "pane-2", "tabIds": [], "activeTabId": null }
                    ]
                }
            }],
            "tabs": []
        }"#;
        std::fs::write(&p, json).unwrap();
        assert!(load_from_file(&p).is_none(), "a ratio outside (0, 1) must not load");
    }

    #[test]
    fn load_rejects_dangling_focused_pane_id() {
        let p = validate_fixture_path("dangling-focus.json");
        let json = r#"{
            "revision": 1,
            "windows": [{
                "id": "main",
                "focusedPaneId": "pane-missing",
                "splitTree": { "kind": "pane", "id": "pane-1", "tabIds": [], "activeTabId": null }
            }],
            "tabs": []
        }"#;
        std::fs::write(&p, json).unwrap();
        assert!(load_from_file(&p).is_none(), "a dangling focusedPaneId must not load");
    }

    #[test]
    fn load_rejects_duplicate_tab_id_across_panes() {
        let p = validate_fixture_path("duplicate-tab-id.json");
        let json = r#"{
            "revision": 1,
            "windows": [{
                "id": "main",
                "focusedPaneId": "pane-1",
                "splitTree": {
                    "kind": "split", "id": "split-1", "dir": "row", "ratio": 0.5,
                    "children": [
                        { "kind": "pane", "id": "pane-1", "tabIds": ["dup"], "activeTabId": "dup" },
                        { "kind": "pane", "id": "pane-2", "tabIds": ["dup"], "activeTabId": "dup" }
                    ]
                }
            }],
            "tabs": []
        }"#;
        std::fs::write(&p, json).unwrap();
        assert!(load_from_file(&p).is_none(), "a tab id duplicated across panes must not load");
    }

    #[test]
    fn load_accepts_a_well_formed_document() {
        let p = validate_fixture_path("well-formed.json");
        let json = r#"{
            "revision": 3,
            "windows": [{
                "id": "main",
                "focusedPaneId": "pane-1",
                "splitTree": {
                    "kind": "split", "id": "split-1", "dir": "row", "ratio": 0.5,
                    "children": [
                        { "kind": "pane", "id": "pane-1", "tabIds": ["a"], "activeTabId": "a" },
                        { "kind": "pane", "id": "pane-2", "tabIds": ["b"], "activeTabId": "b" }
                    ]
                }
            }],
            "tabs": []
        }"#;
        std::fs::write(&p, json).unwrap();
        assert!(load_from_file(&p).is_some(), "a structurally valid document must load");
    }

    /// End-to-end regression for the id-space bug fixed in caa117c: the
    /// frontend mirror now translates EVERY id-bearing op field into
    /// `profile:<profileId>` space before it ever reaches `workspace_apply`
    /// (persistence.ts's Global Constraint), so a realistic session stream
    /// never contains a live connectionId anywhere in the tree. This test
    /// replays such a stream — 3 tabs across 2 profiles, a split, a
    /// `set_active`, a `update_tab_state` patch, and a `close_tab` — through
    /// `apply`, round-trips the result through disk via `save_to_file` /
    /// `load_from_file`, and checks the coherence invariant that bug broke:
    /// every tab id the layout tree references must actually exist in
    /// `tabs[]`.
    #[test]
    fn realistic_session_stream_round_trips_through_disk() {
        fn tab(id: &str, profile_id: &str, profile_name: &str, db: &str, collection: &str) -> TabModel {
            TabModel {
                id: id.into(),
                tab_type: "collection".into(),
                profile_id: profile_id.into(),
                profile_name: profile_name.into(),
                db: db.into(),
                collection: collection.into(),
                index_name: None,
                last_query: Some(serde_json::json!({ "filter": {} })),
                last_aggregate: None,
                builder_state: None,
            }
        }

        fn collect_tab_ids(node: &LayoutNode, out: &mut Vec<String>) {
            match node {
                LayoutNode::Pane { tab_ids, .. } => out.extend(tab_ids.iter().cloned()),
                LayoutNode::Split { children, .. } => {
                    for c in children {
                        collect_tab_ids(c, out);
                    }
                }
            }
        }

        let tab1_id = "profile:p1.mydb.customers".to_string();
        let tab2_id = "profile:p1.mydb.orders".to_string();
        let tab3_id = "profile:p2.otherdb.items".to_string();

        let mut ws = Workspace::default();

        // 3 open_tab ops across 2 profiles — mirrors the frontend opening
        // tabs against two different saved connections.
        apply(
            &mut ws,
            WorkspaceOp::OpenTab {
                tab_id: tab1_id.clone(),
                pane_id: None,
                tab: Some(tab(&tab1_id, "p1", "Prod Cluster", "mydb", "customers")),
                window_id: "main".into(),
            },
        );
        apply(
            &mut ws,
            WorkspaceOp::OpenTab {
                tab_id: tab2_id.clone(),
                pane_id: None,
                tab: Some(tab(&tab2_id, "p1", "Prod Cluster", "mydb", "orders")),
                window_id: "main".into(),
            },
        );
        apply(
            &mut ws,
            WorkspaceOp::OpenTab {
                tab_id: tab3_id.clone(),
                pane_id: None,
                tab: Some(tab(&tab3_id, "p2", "Analytics", "otherdb", "items")),
                window_id: "main".into(),
            },
        );

        // split_pane, moving the p2 tab into its own pane.
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane {
                pane_id: root_id,
                dir: "row".into(),
                side: "end".into(),
                move_tab_id: Some(tab3_id.clone()),
                window_id: "main".into(),
            },
        );

        // set_active on the pane that still holds tab1/tab2.
        let left_pane_id = node_id(pane_of_tab(root(&ws), &tab1_id).unwrap()).to_string();
        apply(&mut ws, WorkspaceOp::SetActive { pane_id: left_pane_id, tab_id: tab2_id.clone(), window_id: "main".into() });

        // update_tab_state patches tab1's lastQuery.
        let patched_query = serde_json::json!({ "filter": { "active": true } });
        apply(
            &mut ws,
            WorkspaceOp::UpdateTabState {
                tab_id: tab1_id.clone(),
                last_query: Some(Some(patched_query.clone())),
                last_aggregate: None,
                builder_state: None,
            },
        );

        // close_tab drops tab2.
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: tab2_id.clone(), window_id: "main".into() });

        // Save to a temp-dir file and load it back.
        let dir = std::env::temp_dir().join("mqlens-ws-realistic-roundtrip-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("workspace.json");
        let _ = std::fs::remove_file(&path);
        save_to_file(&path, &ws).unwrap();
        let loaded = load_from_file(&path).expect("a freshly-saved workspace file must load back");

        assert_eq!(loaded, ws, "round trip through disk must be lossless");

        // Coherence invariant the id-space bug broke: every tab id the
        // layout tree references must exist in tabs[].
        let known_tab_ids: std::collections::HashSet<&str> =
            loaded.tabs.iter().map(|t| t.id.as_str()).collect();
        let mut tree_tab_ids = Vec::new();
        collect_tab_ids(&loaded.windows[0].split_tree, &mut tree_tab_ids);
        assert!(!tree_tab_ids.is_empty(), "sanity: the tree must reference at least one tab");
        for id in &tree_tab_ids {
            assert!(known_tab_ids.contains(id.as_str()), "layout references unknown tab id `{id}`");
        }

        // tab2 was closed: 2 tabs remain, and tab1's patched lastQuery
        // survived the save/load round trip.
        assert_eq!(loaded.tabs.len(), 2);
        let restored_tab1 = loaded.tabs.iter().find(|t| t.id == tab1_id).expect("tab1 must survive the close");
        assert_eq!(restored_tab1.last_query, Some(patched_query));
        assert!(loaded.tabs.iter().any(|t| t.id == tab3_id), "tab3 must survive the close");
        assert!(!loaded.tabs.iter().any(|t| t.id == tab2_id), "tab2 was closed and must not survive");

        // Id-space invariant: every id anywhere in the tree is either
        // profile-space (a tab id) or connectionless (a structural
        // pane/split id, minted deterministically by the reducer — see
        // persistence.ts: "Pane/split ids are NOT part of this constraint").
        // A live connectionId (e.g. a bare Mongo connection UUID) must never
        // appear — that's precisely what caa117c fixed.
        let mut structural_ids = Vec::new();
        collect_ids(&loaded.windows[0].split_tree, &mut structural_ids);
        let mut all_ids = structural_ids;
        all_ids.extend(tree_tab_ids.iter().cloned());
        for id in &all_ids {
            let is_profile_space = id.starts_with("profile:");
            let is_connectionless = id.starts_with("pane-") || id.starts_with("split-");
            assert!(
                is_profile_space || is_connectionless,
                "id `{id}` is neither profile-space nor a connectionless structural id"
            );
        }
    }

    // -----------------------------------------------------------------
    // Phase 3 Task 2: window-scoped ops — MoveTabToWindow, DetachTab,
    // WindowClosed, window_id resolution, and validate()'s window rules.
    // -----------------------------------------------------------------

    #[test]
    fn move_tab_to_window_moves_and_activates_in_target() {
        let mut ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane {
                        id: "pane-1".into(),
                        tab_ids: vec!["a".into(), "b".into()],
                        active_tab_id: Some("a".into()),
                    },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["c".into()], active_tab_id: Some("c".into()) },
                },
            ],
            tabs: vec![],
        };
        apply(
            &mut ws,
            WorkspaceOp::MoveTabToWindow { tab_id: "b".into(), target_window_id: "win-1".into(), target_pane_id: None },
        );

        let (_, main_tabs, main_active) = pane_fields(&ws.windows[0].split_tree);
        assert_eq!(main_tabs, ["a"], "source pane loses the moved tab");
        assert_eq!(main_active, Some("a"));

        let (_, win1_tabs, win1_active) = pane_fields(&ws.windows[1].split_tree);
        assert_eq!(win1_tabs, ["c", "b"], "target pane gains the moved tab, appended");
        assert_eq!(win1_active, Some("b"), "moved tab activates in the target pane");
        assert_eq!(ws.windows[1].focused_pane_id, "pane-1", "target window focuses the pane the tab landed in");
        assert_eq!(ws.revision, 1);
        assert!(ws.tabs.is_empty(), "tabs[] is untouched — the tab model already existed");
    }

    #[test]
    fn move_tab_to_window_folds_source_pane_when_emptied() {
        let mut ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-2".into(),
                    split_tree: LayoutNode::Split {
                        id: "split-1".into(),
                        dir: "row".into(),
                        ratio: 0.5,
                        children: vec![
                            LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                            LayoutNode::Pane { id: "pane-2".into(), tab_ids: vec!["b".into()], active_tab_id: Some("b".into()) },
                        ],
                    },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["c".into()], active_tab_id: Some("c".into()) },
                },
            ],
            tabs: vec![],
        };
        apply(
            &mut ws,
            WorkspaceOp::MoveTabToWindow { tab_id: "b".into(), target_window_id: "win-1".into(), target_pane_id: None },
        );

        // pane-2 emptied and folded away; main's tree collapses to pane-1 alone.
        let (id, tab_ids, _) = pane_fields(&ws.windows[0].split_tree);
        assert_eq!(id, "pane-1");
        assert_eq!(tab_ids, ["a"]);
        assert_eq!(ws.windows[0].focused_pane_id, "pane-1", "focus repairs off the folded-away pane-2");
        assert_eq!(ws.windows.len(), 2, "main itself is never removed, only the folded pane inside it");

        let (_, win1_tabs, _) = pane_fields(&ws.windows[1].split_tree);
        assert_eq!(win1_tabs, ["c", "b"]);
    }

    #[test]
    fn move_tab_to_window_removes_emptied_non_main_source_window() {
        let mut ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                },
                WindowModel {
                    id: "win-2".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["x".into()], active_tab_id: Some("x".into()) },
                },
            ],
            tabs: vec![],
        };
        apply(
            &mut ws,
            WorkspaceOp::MoveTabToWindow { tab_id: "x".into(), target_window_id: "main".into(), target_pane_id: None },
        );

        assert_eq!(ws.windows.len(), 1, "the emptied non-main source window must be removed");
        assert_eq!(ws.windows[0].id, "main");
        let (_, tab_ids, active) = pane_fields(&ws.windows[0].split_tree);
        assert_eq!(tab_ids, ["a", "x"]);
        assert_eq!(active, Some("x"));
        assert_eq!(ws.revision, 1);
    }

    #[test]
    fn move_tab_to_window_honors_explicit_target_pane_id() {
        let mut ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(), // NOT the explicit target below
                    split_tree: LayoutNode::Split {
                        id: "split-1".into(),
                        dir: "row".into(),
                        ratio: 0.5,
                        children: vec![
                            LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["c".into()], active_tab_id: Some("c".into()) },
                            LayoutNode::Pane { id: "pane-2".into(), tab_ids: vec!["d".into()], active_tab_id: Some("d".into()) },
                        ],
                    },
                },
            ],
            tabs: vec![],
        };
        apply(
            &mut ws,
            WorkspaceOp::MoveTabToWindow {
                tab_id: "a".into(),
                target_window_id: "win-1".into(),
                target_pane_id: Some("pane-2".into()),
            },
        );

        let win1 = &ws.windows[1];
        assert_eq!(win1.focused_pane_id, "pane-2", "explicit target_pane_id wins over the target window's prior focus");
        let LayoutNode::Split { children, .. } = &win1.split_tree else { panic!("expected a split") };
        let (_, pane1_tabs, _) = pane_fields(&children[0]);
        let (_, pane2_tabs, pane2_active) = pane_fields(&children[1]);
        assert_eq!(pane1_tabs, ["c"], "the target window's other pane is untouched");
        assert_eq!(pane2_tabs, ["d", "a"]);
        assert_eq!(pane2_active, Some("a"));
    }

    #[test]
    fn move_tab_to_window_unknown_tab_or_window_is_noop() {
        let mut ws = ws_with(&["a"]);
        let before = ws.clone();
        apply(
            &mut ws,
            WorkspaceOp::MoveTabToWindow { tab_id: "nope".into(), target_window_id: "main".into(), target_pane_id: None },
        );
        assert_eq!(ws, before);
        apply(
            &mut ws,
            WorkspaceOp::MoveTabToWindow { tab_id: "a".into(), target_window_id: "nope".into(), target_pane_id: None },
        );
        assert_eq!(ws, before);
        assert_eq!(ws.revision, 0);
    }

    #[test]
    fn detach_tab_creates_new_window_and_folds_source() {
        let mut ws = Workspace {
            revision: 0,
            windows: vec![WindowModel {
                id: "main".into(),
                focused_pane_id: "pane-2".into(),
                split_tree: LayoutNode::Split {
                    id: "split-1".into(),
                    dir: "row".into(),
                    ratio: 0.5,
                    children: vec![
                        LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                        LayoutNode::Pane { id: "pane-2".into(), tab_ids: vec!["b".into()], active_tab_id: Some("b".into()) },
                    ],
                },
            }],
            tabs: vec![],
        };
        apply(&mut ws, WorkspaceOp::DetachTab { tab_id: "b".into() });

        assert_eq!(ws.windows.len(), 2);
        let (id, tab_ids, _) = pane_fields(&ws.windows[0].split_tree);
        assert_eq!(id, "pane-1");
        assert_eq!(tab_ids, ["a"], "source pane-2 emptied and folded away");
        assert_eq!(ws.windows[0].focused_pane_id, "pane-1");

        let new_win = &ws.windows[1];
        assert_eq!(new_win.id, "win-1");
        assert_eq!(new_win.focused_pane_id, "pane-1");
        let (_, new_tabs, new_active) = pane_fields(&new_win.split_tree);
        assert_eq!(new_tabs, ["b"]);
        assert_eq!(new_active, Some("b"));
        assert_eq!(ws.revision, 1);
    }

    #[test]
    fn detach_tab_noop_when_already_alone_in_non_main_window() {
        let mut ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["b".into()], active_tab_id: Some("b".into()) },
                },
            ],
            tabs: vec![],
        };
        let before = ws.clone();
        apply(&mut ws, WorkspaceOp::DetachTab { tab_id: "b".into() });
        assert_eq!(ws, before, "b is already the sole tab in the sole pane of its own non-main window");
        assert_eq!(ws.revision, 0);
    }

    #[test]
    fn detach_tab_always_detaches_a_main_window_singleton() {
        // The "already alone" no-op exemption is explicitly non-main only —
        // detaching main's last tab must still create a new window (main
        // stays behind, empty, exactly like Phase 2's initial state).
        let mut ws = ws_with(&["a"]);
        apply(&mut ws, WorkspaceOp::DetachTab { tab_id: "a".into() });
        assert_eq!(ws.windows.len(), 2);
        let (_, main_tabs, _) = pane_fields(root(&ws));
        assert!(main_tabs.is_empty());
        assert_eq!(ws.windows[1].id, "win-1");
        let (_, new_tabs, _) = pane_fields(&ws.windows[1].split_tree);
        assert_eq!(new_tabs, ["a"]);
    }

    #[test]
    fn detach_tab_unknown_tab_is_noop() {
        let mut ws = ws_with(&["a"]);
        let before = ws.clone();
        apply(&mut ws, WorkspaceOp::DetachTab { tab_id: "nope".into() });
        assert_eq!(ws, before);
        assert_eq!(ws.revision, 0);
    }

    #[test]
    fn detach_tab_mints_next_window_id_by_scanning_all_window_ids() {
        // win-3 already exists (unrelated to the window being detached
        // from) — the next id must be win-4, proving the scan covers ALL
        // window ids, not just a per-tree counter.
        let mut ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane {
                        id: "pane-1".into(),
                        tab_ids: vec!["a".into(), "b".into()],
                        active_tab_id: Some("a".into()),
                    },
                },
                WindowModel {
                    id: "win-3".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["z".into()], active_tab_id: Some("z".into()) },
                },
            ],
            tabs: vec![],
        };
        apply(&mut ws, WorkspaceOp::DetachTab { tab_id: "b".into() });
        let ids: Vec<&str> = ws.windows.iter().map(|w| w.id.as_str()).collect();
        assert!(ids.contains(&"win-4"), "expected win-4 past existing win-3, got {ids:?}");
    }

    #[test]
    fn window_containing_tab_finds_the_freshly_detached_window() {
        // Phase 3 Task 5: `workspace_detach_tab`'s exact use case — after
        // `DetachTab` runs, the command needs to learn which `win-N` the
        // reducer just minted for the detached tab so it can spawn that OS
        // window.
        let mut ws = ws_with(&["a", "b"]);
        apply(&mut ws, WorkspaceOp::DetachTab { tab_id: "b".into() });
        assert_eq!(window_containing_tab(&ws, "b"), Some("win-1"));
        assert_eq!(window_containing_tab(&ws, "a"), Some("main"));
    }

    #[test]
    fn window_containing_tab_is_none_for_an_unknown_tab() {
        let ws = ws_with(&["a"]);
        assert_eq!(window_containing_tab(&ws, "nope"), None);
    }

    #[test]
    fn window_closed_removes_window_and_its_tabs() {
        let mut ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane {
                        id: "pane-1".into(),
                        tab_ids: vec!["b".into(), "c".into()],
                        active_tab_id: Some("b".into()),
                    },
                },
            ],
            tabs: vec![sample_tab("a"), sample_tab("b"), sample_tab("c")],
        };
        apply(&mut ws, WorkspaceOp::WindowClosed { window_id: "win-1".into() });

        assert_eq!(ws.windows.len(), 1);
        assert_eq!(ws.windows[0].id, "main");
        let remaining_tab_ids: Vec<&str> = ws.tabs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(remaining_tab_ids, ["a"], "win-1's layout tab ids (b, c) leave tabs[] too");
        assert_eq!(ws.revision, 1);
    }

    #[test]
    fn window_closed_noop_for_main_or_unknown() {
        let mut ws = ws_with(&["a"]);
        let before = ws.clone();
        apply(&mut ws, WorkspaceOp::WindowClosed { window_id: "main".into() });
        assert_eq!(ws, before, "main can't be closed via window_closed");
        apply(&mut ws, WorkspaceOp::WindowClosed { window_id: "nope".into() });
        assert_eq!(ws, before);
        assert_eq!(ws.revision, 0);
    }

    #[test]
    fn window_scoped_op_resolves_panes_strictly_within_target_window() {
        // Two windows, each with a pane-2 — proves op.window_id resolution
        // never lets a window-local id cross-talk into the wrong window.
        let mut ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Split {
                        id: "split-1".into(),
                        dir: "row".into(),
                        ratio: 0.5,
                        children: vec![
                            LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["m1".into()], active_tab_id: Some("m1".into()) },
                            LayoutNode::Pane {
                                id: "pane-2".into(),
                                tab_ids: vec!["m2".into(), "m3".into()],
                                active_tab_id: Some("m2".into()),
                            },
                        ],
                    },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Split {
                        id: "split-1".into(),
                        dir: "row".into(),
                        ratio: 0.5,
                        children: vec![
                            LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["x1".into()], active_tab_id: Some("x1".into()) },
                            LayoutNode::Pane {
                                id: "pane-2".into(),
                                tab_ids: vec!["x2".into(), "x3".into()],
                                active_tab_id: Some("x2".into()),
                            },
                        ],
                    },
                },
            ],
            tabs: vec![],
        };
        let main_before = ws.windows[0].clone();

        apply(
            &mut ws,
            WorkspaceOp::SetActive { window_id: "win-1".into(), pane_id: "pane-2".into(), tab_id: "x3".into() },
        );

        assert_eq!(ws.windows[0], main_before, "main's pane-2 (same id, different window) must be untouched");
        let LayoutNode::Split { children, .. } = &ws.windows[1].split_tree else { panic!("expected a split") };
        let (_, _, active) = pane_fields(&children[1]);
        assert_eq!(active, Some("x3"));
        assert_eq!(ws.windows[1].focused_pane_id, "pane-2");
        assert_eq!(ws.revision, 1);
    }

    #[test]
    fn validate_rejects_missing_main_window() {
        let ws = Workspace {
            revision: 0,
            windows: vec![WindowModel {
                id: "win-1".into(),
                focused_pane_id: "pane-1".into(),
                split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
            }],
            tabs: vec![],
        };
        assert!(!validate(&ws));
    }

    #[test]
    fn validate_rejects_duplicate_window_ids() {
        let ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec![], active_tab_id: None },
                },
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                },
            ],
            tabs: vec![],
        };
        assert!(!validate(&ws));
    }

    #[test]
    fn validate_rejects_non_main_window_with_no_tabs() {
        let ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec![], active_tab_id: None },
                },
            ],
            tabs: vec![],
        };
        assert!(!validate(&ws));
    }

    #[test]
    fn validate_accepts_a_well_formed_multi_window_document() {
        let ws = Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec![], active_tab_id: None },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                },
            ],
            tabs: vec![],
        };
        assert!(validate(&ws));
    }
}

// ---------------------------------------------------------------------------
// Golden parity vectors — shared with src/workspace/__tests__/golden.test.ts
// via fixtures/workspace-golden.json. That TS runner asserts the layout half
// only (splitTree/focusedPaneId); this runner applies the exact same ops
// through `apply` and asserts full `Workspace` equality, including
// `revision` and `tabs[]` (Rust-only bookkeeping the TS side has no
// equivalent for). If a vector fails here but passes in TS, the TS reducer
// is the spec — investigate this port, don't adjust the vector to paper over
// the divergence.
//
// A sibling of `mod tests` (not nested in it) so `cargo test workspace::golden`
// matches this module's path directly.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod golden {
    use super::*;

    #[derive(Deserialize)]
    struct GoldenVector {
        name: String,
        initial: Workspace,
        ops: Vec<WorkspaceOp>,
        expected: Workspace,
    }

    #[derive(Deserialize)]
    struct GoldenFixture {
        vectors: Vec<GoldenVector>,
    }

    #[test]
    fn golden_vectors_match_fixture() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/workspace-golden.json");
        let data = fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("failed to read golden fixture at {path}: {e}"));
        let fixture: GoldenFixture = serde_json::from_str(&data)
            .unwrap_or_else(|e| panic!("failed to parse golden fixture: {e}"));
        for vector in fixture.vectors {
            let mut ws = vector.initial.clone();
            for op in vector.ops {
                apply(&mut ws, op);
            }
            assert_eq!(ws, vector.expected, "golden vector `{}` diverged", vector.name);
        }
    }
}

// ---------------------------------------------------------------------------
// Store command tests — impl-level (bypass the Tauri command wrappers, no
// `AppHandle`), per the Task 4 brief. A sibling of `mod tests`/`mod golden`
// so `cargo test workspace::store` targets this module directly.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod store {
    use super::*;
    use std::sync::atomic::Ordering;

    /// A fresh, unique-per-test path under the OS temp dir. Removes any
    /// leftover file from a prior run so each test starts from a clean disk
    /// state; distinct filenames keep parallel test threads from colliding.
    fn tmp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("mqlens-ws-store-tests");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = fs::remove_file(&p);
        p
    }

    fn sample_ws() -> Workspace {
        Workspace {
            revision: 5,
            windows: vec![WindowModel {
                id: "main".into(),
                focused_pane_id: "pane-1".into(),
                split_tree: LayoutNode::Pane {
                    id: "pane-1".into(),
                    tab_ids: vec!["a".into()],
                    active_tab_id: Some("a".into()),
                },
            }],
            tabs: vec![],
        }
    }

    #[test]
    fn workspace_get_loads_file_once() {
        let path = tmp_path("get-loads-once.json");
        let on_disk = sample_ws();
        save_to_file(&path, &on_disk).unwrap();

        let state = AppState::new();
        let first = get_impl(&state, &path).unwrap();
        assert_eq!(first, Some(on_disk.clone()));

        // Mutate the file on disk after the first load.
        let mut mutated = on_disk.clone();
        mutated.revision = 999;
        save_to_file(&path, &mutated).unwrap();

        let second = get_impl(&state, &path).unwrap();
        assert_eq!(
            second, first,
            "second call must return the cached in-memory copy, not re-read the mutated file"
        );
    }

    #[test]
    fn save_to_file_writes_atomically_via_tmp_rename() {
        // Fix 5 (#97 phase 2 final review): `save_to_file` must land the
        // final content directly at `path` with no stray `<path>.tmp` left
        // behind — the tmp file is an implementation detail of the
        // write-then-rename, never a durable artifact.
        let path = tmp_path("atomic-save.json");
        let mut tmp_os = path.as_os_str().to_os_string();
        tmp_os.push(".tmp");
        let tmp_path_for_this_save = PathBuf::from(tmp_os);
        let _ = fs::remove_file(&tmp_path_for_this_save);

        let ws = sample_ws();
        save_to_file(&path, &ws).unwrap();

        assert!(path.exists(), "the real path must exist after save");
        assert!(!tmp_path_for_this_save.exists(), "the .tmp file must not survive a successful save");
        assert_eq!(load_from_file(&path), Some(ws));
    }

    #[test]
    fn apply_initializes_default_main_window() {
        let state = AppState::new();
        let path = tmp_path("apply-init.json");
        assert!(state.workspace.lock_safe().unwrap().is_none(), "precondition: no workspace loaded yet");

        apply_impl(&state, &path, WorkspaceOp::FocusPane { pane_id: "pane-1".into(), window_id: "main".into() }, "main".into()).unwrap();

        let ws = state.workspace.lock_safe().unwrap().clone().unwrap();
        assert_eq!(ws.windows.len(), 1);
        let win = &ws.windows[0];
        assert_eq!(win.id, "main");
        assert_eq!(win.focused_pane_id, "pane-1");
        assert_eq!(
            win.split_tree,
            LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec![], active_tab_id: None }
        );
    }

    #[test]
    fn apply_noop_does_not_schedule_write() {
        let state = AppState::new();
        let path = tmp_path("apply-noop.json");

        // Unknown tab id on a freshly-initialized (empty) window: the
        // reducer returns the same layout and the tabs[] retain is a no-op,
        // so `apply`'s revision never bumps (see
        // `unknown_ids_are_noops_without_revision_bump` in `mod tests`).
        apply_impl(&state, &path, WorkspaceOp::CloseTab { tab_id: "nope".into(), window_id: "main".into() }, "main".into()).unwrap();

        assert_eq!(
            state.workspace_write_gen.load(Ordering::SeqCst),
            0,
            "a true no-op must not mint a write generation or schedule a save"
        );
    }

    #[test]
    fn should_write_only_when_generation_is_still_current() {
        assert!(should_write(1, 1));
        assert!(should_write(0, 0));
        assert!(!should_write(2, 1), "an earlier generation was superseded by a later apply");
        assert!(!should_write(1, 2), "a not-yet-minted generation can never be current");
    }

    // Exercises the real spawn/sleep path. `tauri::async_runtime::spawn`
    // lazily starts its own dedicated background Tokio runtime the first
    // time it's called (tauri-2.11.2's `async_runtime::default_runtime`),
    // independent of whatever runtime is driving this test — so it works
    // the same whether called from a plain `#[test]` or, as here, from a
    // `#[tokio::test]` (used only so this test can `.await` its own sleep
    // while polling for the debounced write to land). Existing precedent
    // for `#[tokio::test]` + `tokio::time::sleep` polling a background
    // mutation: `toolsetup.rs`'s `wait_for_task_done`, `tests.rs`.
    #[tokio::test]
    async fn apply_debounces_a_burst_into_a_single_final_write() {
        let state = AppState::new();
        let path = tmp_path("debounce-burst.json");

        for i in 0..10 {
            apply_impl(
                &state,
                &path,
                WorkspaceOp::OpenTab { tab_id: format!("t{i}"), pane_id: None, tab: None, window_id: "main".into() },
                "main".into(),
            )
            .unwrap();
        }

        // 10 distinct real changes mint 10 generations; only the last
        // scheduled task can ever find its generation still current, so at
        // most 1 of the 10 debounced writes actually lands (see
        // `should_write_only_when_generation_is_still_current` for the
        // pure-function proof of that invalidation). None of them have
        // fired yet — they all sleep 500ms before checking.
        assert_eq!(state.workspace_write_gen.load(Ordering::SeqCst), 10);
        assert!(!path.exists(), "must not write before the debounce window elapses");

        tokio::time::sleep(Duration::from_millis(700)).await;

        let saved = load_from_file(&path).expect("the last-scheduled write must have landed by now");
        let in_memory = state.workspace.lock_safe().unwrap().clone().unwrap();
        assert_eq!(
            saved, in_memory,
            "the surviving write must reflect the fully-applied burst, not a stale intermediate snapshot"
        );
        let LayoutNode::Pane { tab_ids, .. } = &saved.windows[0].split_tree else {
            panic!("expected a pane, got a split");
        };
        assert_eq!(tab_ids.len(), 10);
    }
}

// ---------------------------------------------------------------------------
// `workspace-changed` broadcast tests (Phase 3 Task 3) — pure, no AppState
// and no AppHandle: `apply_and_describe` is exercised directly, matching the
// module's precedent (`mod golden`, `mod store`) of a sibling module per
// concern so `cargo test workspace::broadcast` targets just these.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod broadcast {
    use super::*;

    fn single_window_ws(tab_ids: &[&str]) -> Workspace {
        let ids: Vec<String> = tab_ids.iter().map(|s| s.to_string()).collect();
        let active = ids.first().cloned();
        Workspace {
            revision: 0,
            windows: vec![WindowModel {
                id: "main".into(),
                focused_pane_id: "pane-1".into(),
                split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: ids, active_tab_id: active },
            }],
            tabs: vec![],
        }
    }

    /// A `"main"` window holding tab `"a"` plus a secondary `"win-1"`
    /// window holding tab `"b"` — the minimal shape every cross-window op
    /// test below needs a source and target window for.
    fn two_window_ws() -> Workspace {
        Workspace {
            revision: 0,
            windows: vec![
                WindowModel {
                    id: "main".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["a".into()], active_tab_id: Some("a".into()) },
                },
                WindowModel {
                    id: "win-1".into(),
                    focused_pane_id: "pane-1".into(),
                    split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec!["b".into()], active_tab_id: Some("b".into()) },
                },
            ],
            tabs: vec![],
        }
    }

    #[test]
    fn changing_op_returns_some_with_correct_revision_and_origin() {
        let mut ws = single_window_ws(&["a"]);
        let payload = apply_and_describe(
            &mut ws,
            WorkspaceOp::OpenTab { tab_id: "b".into(), pane_id: None, tab: None, window_id: "main".into() },
            "win-2".into(),
        )
        .expect("opening a new tab changes state");

        assert_eq!(payload.revision, 1);
        assert_eq!(payload.revision, ws.revision, "payload revision must match the mutated workspace");
        assert_eq!(payload.origin, "win-2");
        assert!(!payload.cross_window, "OpenTab is not a window-lifecycle op");
        assert_eq!(payload.workspace, ws, "payload must carry the fully-applied workspace, not a stale snapshot");
    }

    #[test]
    fn noop_returns_none() {
        let mut ws = single_window_ws(&["a"]);
        let before = ws.clone();
        let payload = apply_and_describe(
            &mut ws,
            WorkspaceOp::CloseTab { tab_id: "does-not-exist".into(), window_id: "main".into() },
            "main".into(),
        );
        assert_eq!(payload, None);
        assert_eq!(ws, before, "a no-op must never mutate the workspace");
    }

    #[test]
    fn cross_window_is_true_for_move_tab_to_window() {
        let mut ws = two_window_ws();
        let payload = apply_and_describe(
            &mut ws,
            WorkspaceOp::MoveTabToWindow { tab_id: "a".into(), target_window_id: "win-1".into(), target_pane_id: None },
            "main".into(),
        )
        .expect("moving an existing tab into another window changes state");
        assert!(payload.cross_window);
    }

    #[test]
    fn cross_window_is_true_for_detach_tab() {
        let mut ws = two_window_ws();
        let payload = apply_and_describe(&mut ws, WorkspaceOp::DetachTab { tab_id: "a".into() }, "main".into())
            .expect("detaching a tab out of a multi-tab window changes state");
        assert!(payload.cross_window);
    }

    #[test]
    fn cross_window_is_true_for_window_closed() {
        let mut ws = two_window_ws();
        let payload = apply_and_describe(&mut ws, WorkspaceOp::WindowClosed { window_id: "win-1".into() }, "main".into())
            .expect("closing a known non-main window changes state");
        assert!(payload.cross_window);
    }

    #[test]
    fn cross_window_is_false_for_every_non_lifecycle_op() {
        // A representative spread of the non-cross-window `WorkspaceOp`
        // shapes (layout ops and the tabs-only `UpdateTabState`), each set
        // up to actually change state so `apply_and_describe` returns
        // `Some` — every one of them must come back `cross_window: false`.
        let cases: Vec<(&str, WorkspaceOp)> = vec![
            ("open_tab", WorkspaceOp::OpenTab { tab_id: "b".into(), pane_id: None, tab: None, window_id: "main".into() }),
            ("close_tab", WorkspaceOp::CloseTab { tab_id: "a".into(), window_id: "main".into() }),
            ("close_many", WorkspaceOp::CloseMany { tab_ids: vec!["a".into()], window_id: "main".into() }),
            (
                "split_pane",
                WorkspaceOp::SplitPane { pane_id: "pane-1".into(), dir: "row".into(), side: "end".into(), move_tab_id: None, window_id: "main".into() },
            ),
            ("rename_tab", WorkspaceOp::RenameTab { old_id: "a".into(), new_id: "z".into(), window_id: "main".into() }),
            (
                "update_tab_state",
                WorkspaceOp::UpdateTabState {
                    tab_id: "a".into(),
                    last_query: Some(Some(serde_json::json!({"x": 1}))),
                    last_aggregate: None,
                    builder_state: None,
                },
            ),
        ];
        for (name, op) in cases {
            let mut ws = single_window_ws(&["a"]);
            ws.tabs.push(TabModel {
                id: "a".into(),
                tab_type: "collection".into(),
                profile_id: "p1".into(),
                profile_name: "p1".into(),
                db: "db".into(),
                collection: "coll".into(),
                index_name: None,
                last_query: None,
                last_aggregate: None,
                builder_state: None,
            });
            let payload = apply_and_describe(&mut ws, op, "main".into());
            let payload = payload.unwrap_or_else(|| panic!("`{name}` was expected to change state"));
            assert!(!payload.cross_window, "`{name}` must not be flagged cross-window");
        }
    }
}
