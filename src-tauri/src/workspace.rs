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
// Variant fields are populated by serde from frontend action payloads and
// matched on in Task 2's `apply` reducer; until that lands, rustc can't see
// any reads and flags every field as dead code.
#[allow(dead_code)]
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
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

/// Apply one op to the workspace. Implemented in Task 2 (the reducer port);
/// referenced here only by the op-decoding test above.
#[allow(dead_code)] // consumed by Task 2's reducer + Task 4's Tauri commands
pub fn apply(_ws: &mut Workspace, _op: WorkspaceOp) {
    unimplemented!("workspace reducer lands in Task 2")
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
