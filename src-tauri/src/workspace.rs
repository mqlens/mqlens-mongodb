//! Multi-panel workspace store: layout tree, tabs, and the workspace.json
//! document. This module owns the data model and best-effort file IO only —
//! the reducer (`apply`) and Tauri commands land in later tasks.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// One open query tab. `profile_id` identifies a saved connection profile,
/// NEVER a live session connectionId — tabs must survive reconnects.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabModel {
    pub id: String,
    #[serde(rename = "type")]
    pub tab_type: String, // the 16 QueryTab kinds
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

/// A single workspace mutation. The `type` discriminator is snake_case to
/// match the frontend reducer's action `type` strings exactly (e.g.
/// `split_pane`, `update_tab_state`).
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)] // wired up by Task 4's Tauri commands
pub enum WorkspaceOp {
    OpenTab {
        tab_id: String,
        #[serde(default)]
        pane_id: Option<String>,
        #[serde(default)]
        tab: Option<TabModel>,
    },
    CloseTab {
        tab_id: String,
    },
    CloseMany {
        tab_ids: Vec<String>,
    },
    MoveTab {
        tab_id: String,
        target_pane_id: String,
        #[serde(default)]
        index: Option<usize>,
    },
    SplitPane {
        pane_id: String,
        dir: String,
        side: String,
        #[serde(default)]
        move_tab_id: Option<String>,
    },
    ResizeSplit {
        split_id: String,
        ratio: f64,
    },
    SetActive {
        pane_id: String,
        tab_id: String,
    },
    FocusPane {
        pane_id: String,
    },
    RenameTab {
        old_id: String,
        new_id: String,
    },
    UpdateTabState {
        tab_id: String,
        #[serde(default)]
        last_query: Option<serde_json::Value>,
        #[serde(default)]
        last_aggregate: Option<serde_json::Value>,
        #[serde(default)]
        builder_state: Option<serde_json::Value>,
    },
}

// ---------------------------------------------------------------------------
// Reducer internals — a 1:1 port of src/workspace/model.ts. Helper names
// mirror the TS ones exactly (mapPane -> map_pane, removeTabFromPane ->
// remove_tab_from_pane, withFocusRepaired -> with_focus_repaired,
// workspaceReducer -> workspace_reducer, closeTab -> close_tab) so the two
// implementations can be diffed function-by-function across the language
// boundary.
// ---------------------------------------------------------------------------

#[allow(dead_code)] // wired up by Task 4's Tauri commands
const MIN_RATIO: f64 = 0.15;
#[allow(dead_code)] // wired up by Task 4's Tauri commands
const MAX_RATIO: f64 = 0.85;

/// The id of any layout node, pane or split (TS accesses `.id` directly on
/// the `LayoutNode` union; Rust needs a match since the two variants don't
/// share a common field).
#[allow(dead_code)] // wired up by Task 4's Tauri commands
fn node_id(node: &LayoutNode) -> &str {
    match node {
        LayoutNode::Pane { id, .. } => id,
        LayoutNode::Split { id, .. } => id,
    }
}

/// Port of TS `allPanes`.
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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

        WorkspaceOp::CloseTab { tab_id } => close_tab(root, focused_pane_id, tab_id),

        WorkspaceOp::CloseMany { tab_ids } => {
            let mut r = root.clone();
            let mut f = focused_pane_id.to_string();
            for t in tab_ids {
                let (nr, nf) = close_tab(&r, &f, t);
                r = nr;
                f = nf;
            }
            (r, f)
        }

        WorkspaceOp::MoveTab { tab_id, target_pane_id, index } => {
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

        WorkspaceOp::SplitPane { pane_id, dir, side, move_tab_id } => {
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

        WorkspaceOp::ResizeSplit { split_id, ratio } => {
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

        WorkspaceOp::SetActive { pane_id, tab_id } => {
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

        WorkspaceOp::FocusPane { pane_id } => {
            if find_pane(root, pane_id).is_some() {
                (root.clone(), pane_id.clone())
            } else {
                (root.clone(), focused_pane_id.to_string())
            }
        }

        WorkspaceOp::RenameTab { old_id, new_id } => {
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
    }
}

/// Scans the tree for the highest numeric suffix among ids sharing `prefix`
/// (e.g. `"pane-"` or `"split-"`), regardless of node kind — ids of the
/// other kind never share a prefix so they simply don't match.
#[allow(dead_code)] // wired up by Task 4's Tauri commands
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
/// Deliberate divergence from TS: `model.ts` keeps module-level
/// `paneCounter`/`splitCounter` mutable statics (reset per-test via
/// `resetLayoutIds`) with no file-load case — a fresh page load starts both
/// counters at 0 because the in-memory layout is always freshly built from
/// `tabIds`. The Rust store, by contrast, *restores* a tree from
/// `workspace.json` that may already contain `pane-7`/`split-3`; a
/// process-local counter seeded at 0 would immediately collide with ids
/// already in the restored tree. Scanning the tree at mint time is
/// stateless (nothing to seed on load, nothing to serialize, nothing to get
/// out of sync with the actual tree) and cheap at these tree sizes.
#[allow(dead_code)] // wired up by Task 4's Tauri commands
fn next_pane_id(root: &LayoutNode) -> String {
    format!("pane-{}", max_numeric_suffix(root, "pane-") + 1)
}
#[allow(dead_code)] // wired up by Task 4's Tauri commands
fn next_split_id(root: &LayoutNode) -> String {
    format!("split-{}", max_numeric_suffix(root, "split-") + 1)
}

/// The single main window's initial state: one root pane, no tabs. Mirrors
/// TS `createInitialLayout([], null)` plus the window wrapper Phase 2 adds.
#[allow(dead_code)] // wired up by Task 4's Tauri commands
fn default_window() -> WindowModel {
    WindowModel {
        id: "main".into(),
        split_tree: LayoutNode::Pane { id: "pane-1".into(), tab_ids: vec![], active_tab_id: None },
        focused_pane_id: "pane-1".into(),
    }
}

/// Apply one op to the workspace, mutating `windows[0]` (Phase 2: exactly
/// one window; seeded with `default_window()` on first use) and `tabs`.
/// `revision` bumps only when something actually changed — TS returns the
/// same object reference for a no-op action; Rust mutates in place, so we
/// mirror that by comparing old vs. new values (both `LayoutNode` and
/// `WindowModel` derive `PartialEq`) rather than tracking reference
/// identity. See the Task 2 report for the semantic-choice writeup of edge
/// cases (e.g. `open_tab` re-activating an already-active+focused tab) where
/// this differs from "TS would have returned a new object".
#[allow(dead_code)] // wired up by Task 4's Tauri commands
pub fn apply(ws: &mut Workspace, op: WorkspaceOp) {
    if ws.windows.is_empty() {
        ws.windows.push(default_window());
    }

    let mut changed = false;

    if !matches!(op, WorkspaceOp::UpdateTabState { .. }) {
        let win = &mut ws.windows[0];
        let (new_root, new_focused) = workspace_reducer(&win.split_tree, &win.focused_pane_id, &op);
        if new_root != win.split_tree || new_focused != win.focused_pane_id {
            win.split_tree = new_root;
            win.focused_pane_id = new_focused;
            changed = true;
        }
    }

    // Rust-only tabs[] bookkeeping — TS has no `tabs` array (the frontend
    // keeps QueryTab[] in App); these mirror the tree op above.
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
        WorkspaceOp::CloseTab { tab_id } => {
            let before = ws.tabs.len();
            ws.tabs.retain(|t| &t.id != tab_id);
            changed |= ws.tabs.len() != before;
        }
        WorkspaceOp::CloseMany { tab_ids } => {
            let before = ws.tabs.len();
            ws.tabs.retain(|t| !tab_ids.contains(&t.id));
            changed |= ws.tabs.len() != before;
        }
        WorkspaceOp::RenameTab { old_id, new_id } => {
            if let Some(t) = ws.tabs.iter_mut().find(|t| &t.id == old_id) {
                t.id = new_id.clone();
                changed = true;
            }
        }
        WorkspaceOp::UpdateTabState { tab_id, last_query, last_aggregate, builder_state } => {
            if let Some(t) = ws.tabs.iter_mut().find(|t| &t.id == tab_id) {
                if let Some(v) = last_query {
                    if t.last_query.as_ref() != Some(v) {
                        t.last_query = Some(v.clone());
                        changed = true;
                    }
                }
                if let Some(v) = last_aggregate {
                    if t.last_aggregate.as_ref() != Some(v) {
                        t.last_aggregate = Some(v.clone());
                        changed = true;
                    }
                }
                if let Some(v) = builder_state {
                    if t.builder_state.as_ref() != Some(v) {
                        t.builder_state = Some(v.clone());
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

/// Load the workspace document. A missing or corrupt file yields `None` —
/// persistence must never block startup — mirroring queries.rs:83-84.
#[allow(dead_code)] // wired up by Task 4's Tauri commands
pub fn load_from_file(path: &Path) -> Option<Workspace> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// Save the workspace document, pretty-printed. Errors are stringified so
/// callers (Tauri commands) can surface them without leaking IO types.
#[allow(dead_code)] // wired up by Task 4's Tauri commands
pub fn save_to_file(path: &Path, ws: &Workspace) -> Result<(), String> {
    let content = serde_json::to_string_pretty(ws)
        .map_err(|e| format!("Failed to serialize workspace: {}", e))?;
    fs::write(path, content).map_err(|e| format!("Failed to write workspace file: {}", e))
}

/// Where workspace.json lives, mirroring `queries::get_queries_path`
/// (queries.rs:72-81).
#[allow(dead_code)] // wired up by Task 4's Tauri commands
fn workspace_path(app_handle: &tauri::AppHandle) -> PathBuf {
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
        apply(&mut ws, WorkspaceOp::FocusPane { pane_id: "pane-1".into() });
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
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "b".into(), pane_id: None, tab: None });
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()) },
        );
        let pane_a = node_id(pane_of_tab(root(&ws), "a").unwrap()).to_string();
        apply(&mut ws, WorkspaceOp::FocusPane { pane_id: pane_a });
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "b".into(), pane_id: None, tab: None });
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()) },
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "col".into(), side: "start".into(), move_tab_id: Some("b".into()) },
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("a".into()) },
        );
        assert_eq!(ws, before);
        assert_eq!(ws.revision, 0);
    }

    #[test]
    fn split_pane_without_moving_tab_creates_empty_pane() {
        let mut ws = ws_with(&["a"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: None });
        let (_, _, _, children) = split_fields(root(&ws));
        let (_, right_tabs, right_active) = pane_fields(&children[1]);
        assert!(right_tabs.is_empty());
        assert_eq!(right_active, None);
    }

    #[test]
    fn close_tab_activates_last_remaining_tab() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::SetActive { pane_id: root_id, tab_id: "c".into() });
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "c".into() });
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()) },
        );
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "b".into() });
        let (id, tab_ids, _) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["a"]);
        assert_eq!(ws.windows[0].focused_pane_id, id);
    }

    #[test]
    fn close_tab_leaves_empty_root_pane_in_place() {
        let mut ws = ws_with(&["a"]);
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "a".into() });
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()) },
        );
        let pane_b = node_id(pane_of_tab(root(&ws), "b").unwrap()).to_string();
        // 'c' must belong to pane_b before it can be split off from it.
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "c".into(), target_pane_id: pane_b.clone(), index: None });
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: pane_b, dir: "col".into(), side: "end".into(), move_tab_id: Some("c".into()) },
        );
        let mut all = Vec::new();
        all_panes(root(&ws), &mut all);
        assert_eq!(all.len(), 3);
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "c".into() }); // pane empties -> depth-2 fold
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
        apply(&mut ws, WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: None });
        let mut all = Vec::new();
        all_panes(root(&ws), &mut all);
        assert_eq!(all.len(), 2);
        let empty_pane_id = all.iter().find(|p| pane_fields(p).1.is_empty()).map(|p| node_id(p).to_string()).unwrap();
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "b".into() });
        let mut all2 = Vec::new();
        all_panes(root(&ws), &mut all2);
        assert_eq!(all2.len(), 2);
        assert!(find_pane(root(&ws), &empty_pane_id).is_some());
    }

    #[test]
    fn close_tab_activates_right_hand_neighbor() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::SetActive { pane_id: root_id, tab_id: "b".into() });
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "b".into() });
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("c".into()) },
        );
        apply(&mut ws, WorkspaceOp::CloseMany { tab_ids: vec!["b".into(), "c".into()] });
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("c".into()) },
        );
        let target = node_id(pane_of_tab(root(&ws), "c").unwrap()).to_string();
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "b".into(), target_pane_id: target.clone(), index: None });
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
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()) },
        );
        let source_b = node_id(pane_of_tab(root(&ws), "b").unwrap()).to_string();
        let target_a = node_id(pane_of_tab(root(&ws), "a").unwrap()).to_string();
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "b".into(), target_pane_id: target_a, index: None });
        let (_, tab_ids, _) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["a", "b"]);
        assert!(find_pane(root(&ws), &source_b).is_none());
    }

    #[test]
    fn move_tab_reorders_within_same_pane_using_index() {
        let mut ws = ws_with(&["a", "b", "c"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "c".into(), target_pane_id: root_id, index: Some(0) });
        let (_, tab_ids, _) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["c", "a", "b"]);
    }

    #[test]
    fn resize_split_sets_and_clamps_ratio() {
        let mut ws = ws_with(&["a", "b"]);
        let root_id = node_id(root(&ws)).to_string();
        apply(
            &mut ws,
            WorkspaceOp::SplitPane { pane_id: root_id, dir: "row".into(), side: "end".into(), move_tab_id: Some("b".into()) },
        );
        let split_id = node_id(root(&ws)).to_string();

        let mut a = ws.clone();
        apply(&mut a, WorkspaceOp::ResizeSplit { split_id: split_id.clone(), ratio: 0.3 });
        assert_eq!(split_fields(root(&a)).2, 0.3);

        let mut b = ws.clone();
        apply(&mut b, WorkspaceOp::ResizeSplit { split_id: split_id.clone(), ratio: 0.01 });
        assert_eq!(split_fields(root(&b)).2, 0.15);

        let mut c = ws.clone();
        apply(&mut c, WorkspaceOp::ResizeSplit { split_id, ratio: 0.99 });
        assert_eq!(split_fields(root(&c)).2, 0.85);
    }

    #[test]
    fn rename_tab_rewrites_id_everywhere_including_active() {
        let mut ws = ws_with(&["conn.db.old"]);
        apply(&mut ws, WorkspaceOp::RenameTab { old_id: "conn.db.old".into(), new_id: "conn.db.new".into() });
        let (_, tab_ids, active) = pane_fields(root(&ws));
        assert_eq!(tab_ids, ["conn.db.new"]);
        assert_eq!(active, Some("conn.db.new"));
    }

    #[test]
    fn unknown_ids_are_noops_without_revision_bump() {
        let mut ws = ws_with(&["a"]);
        let before = ws.clone();
        apply(&mut ws, WorkspaceOp::CloseTab { tab_id: "nope".into() });
        assert_eq!(ws, before);
        apply(&mut ws, WorkspaceOp::SetActive { pane_id: "nope".into(), tab_id: "a".into() });
        assert_eq!(ws, before);
        apply(&mut ws, WorkspaceOp::MoveTab { tab_id: "a".into(), target_pane_id: "nope".into(), index: None });
        assert_eq!(ws, before);
        apply(&mut ws, WorkspaceOp::ResizeSplit { split_id: "nope".into(), ratio: 0.5 });
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
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "t1".into(), pane_id: None, tab: Some(tab.clone()) });
        assert_eq!(ws.tabs, vec![tab.clone()]);
        assert_eq!(ws.revision, 1);

        // Re-opening with an identical model is a true no-op: no revision bump.
        let rev_before = ws.revision;
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "t1".into(), pane_id: None, tab: Some(tab.clone()) });
        assert_eq!(ws.revision, rev_before);

        // A changed model (e.g. renamed profile) upserts in place, replacing not duplicating.
        let mut renamed = tab.clone();
        renamed.profile_name = "Renamed".into();
        apply(&mut ws, WorkspaceOp::OpenTab { tab_id: "t1".into(), pane_id: None, tab: Some(renamed.clone()) });
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
                last_query: None,
                last_aggregate: Some(serde_json::json!([{"$match": {}}])),
                builder_state: None,
            },
        );
        let t = &ws.tabs[0];
        assert_eq!(t.last_query, Some(serde_json::json!({"filter": "{}"}))); // untouched (None in the patch)
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
                last_aggregate: Some(serde_json::json!([{"$match": {}}])),
                builder_state: None,
            },
        );
        assert_eq!(ws.revision, rev_before);
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
            WorkspaceOp::SplitPane { pane_id: "pane-3".into(), dir: "row".into(), side: "end".into(), move_tab_id: Some("x".into()) },
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
}
