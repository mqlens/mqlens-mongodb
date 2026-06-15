use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// One saved query. `query` is the frontend GeneratedQuery shape as raw JSON.
/// The frontend supplies `id` and `created_at` (the backend keeps no clock).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub query: Value,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
}

/// One history entry. `ran_at` is supplied by the frontend.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HistoryEntry {
    pub query: Value,
    #[serde(rename = "ranAt", default)]
    pub ran_at: String,
}

/// Everything stored for one collection.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct CollectionQueries {
    #[serde(default)]
    pub saved: Vec<SavedQuery>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    #[serde(default)]
    pub default: Option<Value>,
}

/// The whole queries.json document.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct QueryStore {
    #[serde(default)]
    pub collections: HashMap<String, CollectionQueries>,
}

/// Max history entries kept per collection.
pub const HISTORY_CAP: usize = 20;

/// Stable per-collection key. Uses the connection NAME (not the session id) so
/// saved queries survive reconnects.
pub fn collection_key(connection_name: &str, db: &str, collection: &str) -> String {
    format!("{}::{}::{}", connection_name, db, collection)
}

/// Prepend `entry`, drop any earlier entry with the same `query` body, and cap
/// the list at `cap` (most-recent-first).
pub fn push_history(
    existing: Vec<HistoryEntry>,
    entry: HistoryEntry,
    cap: usize,
) -> Vec<HistoryEntry> {
    let mut out: Vec<HistoryEntry> = Vec::with_capacity(existing.len() + 1);
    out.push(entry.clone());
    for e in existing {
        if e.query != entry.query {
            out.push(e);
        }
    }
    out.truncate(cap);
    out
}

pub fn get_queries_path(app_handle: &tauri::AppHandle) -> PathBuf {
    match app_handle.path().app_config_dir() {
        Ok(mut path) => {
            let _ = fs::create_dir_all(&path);
            path.push("queries.json");
            path
        }
        Err(_) => PathBuf::from("queries.json"),
    }
}

/// Load the store. A missing or corrupt file is treated as an empty store —
/// persistence is best-effort and must never block querying.
pub fn load_store_from_file(path: &Path) -> QueryStore {
    if !path.exists() {
        return QueryStore::default();
    }
    let Ok(content) = fs::read_to_string(path) else {
        return QueryStore::default();
    };
    if content.trim().is_empty() {
        return QueryStore::default();
    }
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save_store_to_file(path: &Path, store: &QueryStore) -> Result<(), String> {
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize queries: {}", e))?;
    fs::write(path, content).map_err(|e| format!("Failed to write queries file: {}", e))
}

#[tauri::command]
pub async fn load_collection_queries(
    app_handle: tauri::AppHandle,
    connection_name: String,
    db: String,
    collection: String,
) -> Result<CollectionQueries, String> {
    let path = get_queries_path(&app_handle);
    let store = load_store_from_file(&path);
    let key = collection_key(&connection_name, &db, &collection);
    Ok(store.collections.get(&key).cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn save_query(
    app_handle: tauri::AppHandle,
    connection_name: String,
    db: String,
    collection: String,
    saved: SavedQuery,
) -> Result<(), String> {
    let path = get_queries_path(&app_handle);
    let mut store = load_store_from_file(&path);
    let key = collection_key(&connection_name, &db, &collection);
    store.collections.entry(key).or_default().saved.push(saved);
    save_store_to_file(&path, &store)
}

#[tauri::command]
pub async fn delete_saved_query(
    app_handle: tauri::AppHandle,
    connection_name: String,
    db: String,
    collection: String,
    id: String,
) -> Result<(), String> {
    let path = get_queries_path(&app_handle);
    let mut store = load_store_from_file(&path);
    let key = collection_key(&connection_name, &db, &collection);
    if let Some(cq) = store.collections.get_mut(&key) {
        cq.saved.retain(|s| s.id != id);
    }
    save_store_to_file(&path, &store)
}

#[tauri::command]
pub async fn record_history(
    app_handle: tauri::AppHandle,
    connection_name: String,
    db: String,
    collection: String,
    entry: HistoryEntry,
) -> Result<(), String> {
    let path = get_queries_path(&app_handle);
    let mut store = load_store_from_file(&path);
    let key = collection_key(&connection_name, &db, &collection);
    let cq = store.collections.entry(key).or_default();
    cq.history = push_history(std::mem::take(&mut cq.history), entry, HISTORY_CAP);
    save_store_to_file(&path, &store)
}

#[tauri::command]
pub async fn set_default_query(
    app_handle: tauri::AppHandle,
    connection_name: String,
    db: String,
    collection: String,
    default: Option<Value>,
) -> Result<(), String> {
    let path = get_queries_path(&app_handle);
    let mut store = load_store_from_file(&path);
    let key = collection_key(&connection_name, &db, &collection);
    store.collections.entry(key).or_default().default = default;
    save_store_to_file(&path, &store)
}

/// Flat list of every saved query across all collections (for sidebar favorites).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryRef {
    pub connection_name: String,
    pub db: String,
    pub collection: String,
    pub id: String,
    pub name: String,
    pub query: Value,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_all_saved_queries(
    app_handle: tauri::AppHandle,
) -> Result<Vec<SavedQueryRef>, String> {
    let path = get_queries_path(&app_handle);
    let store = load_store_from_file(&path);
    let mut out = Vec::new();
    for (key, cq) in &store.collections {
        let parts: Vec<&str> = key.split("::").collect();
        if parts.len() != 3 {
            continue;
        }
        for s in &cq.saved {
            out.push(SavedQueryRef {
                connection_name: parts[0].to_string(),
                db: parts[1].to_string(),
                collection: parts[2].to_string(),
                id: s.id.clone(),
                name: s.name.clone(),
                query: s.query.clone(),
                created_at: s.created_at.clone(),
            });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(q: serde_json::Value, at: &str) -> HistoryEntry {
        HistoryEntry { query: q, ran_at: at.into() }
    }

    #[test]
    fn collection_key_is_stable_and_distinct() {
        assert_eq!(collection_key("conn", "db", "c"), "conn::db::c");
        assert_ne!(collection_key("conn", "db", "a"), collection_key("conn", "db", "b"));
    }

    #[test]
    fn push_history_prepends_and_caps() {
        let mut h: Vec<HistoryEntry> = Vec::new();
        for i in 0..(HISTORY_CAP + 5) {
            h = push_history(h, entry(json!({ "n": i }), &format!("t{i}")), HISTORY_CAP);
        }
        assert_eq!(h.len(), HISTORY_CAP);
        // Most recent first.
        assert_eq!(h[0].query, json!({ "n": HISTORY_CAP + 4 }));
    }

    #[test]
    fn push_history_dedupes_identical_query_bodies() {
        let mut h = Vec::new();
        h = push_history(h, entry(json!({ "filter": { "a": 1 } }), "t1"), HISTORY_CAP);
        h = push_history(h, entry(json!({ "filter": { "b": 2 } }), "t2"), HISTORY_CAP);
        h = push_history(h, entry(json!({ "filter": { "a": 1 } }), "t3"), HISTORY_CAP); // dup of t1
        assert_eq!(h.len(), 2, "identical query collapses to one entry");
        assert_eq!(h[0].ran_at, "t3", "re-running moves it to the front");
        assert_eq!(h[1].ran_at, "t2");
    }

    #[test]
    fn store_round_trips_through_json() {
        let mut store = QueryStore::default();
        let key = collection_key("c", "db", "coll");
        let cq = store.collections.entry(key.clone()).or_default();
        cq.saved.push(SavedQuery { id: "1".into(), name: "A".into(), query: json!({}), created_at: "t".into() });
        cq.default = Some(json!({ "filter": {} }));
        let text = serde_json::to_string(&store).unwrap();
        let back: QueryStore = serde_json::from_str(&text).unwrap();
        assert_eq!(back, store);
    }

    #[test]
    fn list_all_saved_queries_flattens_collections() {
        let mut store = QueryStore::default();
        let key = collection_key("Local", "db", "orders");
        let cq = store.collections.entry(key).or_default();
        cq.saved.push(SavedQuery {
            id: "q1".into(),
            name: "Active".into(),
            query: json!({ "queryType": "find" }),
            created_at: "2024-01-02".into(),
        });
        let key2 = collection_key("Local", "db", "users");
        store.collections.entry(key2).or_default().saved.push(SavedQuery {
            id: "q2".into(),
            name: "All users".into(),
            query: json!({}),
            created_at: "2024-01-01".into(),
        });
        let path = std::env::temp_dir().join(format!("mqlens_queries_test_{}.json", std::process::id()));
        save_store_to_file(&path, &store).unwrap();
        let loaded = load_store_from_file(&path);
        let mut out = Vec::new();
        for (k, cq) in &loaded.collections {
            let parts: Vec<&str> = k.split("::").collect();
            if parts.len() != 3 {
                continue;
            }
            for s in &cq.saved {
                out.push(SavedQueryRef {
                    connection_name: parts[0].to_string(),
                    db: parts[1].to_string(),
                    collection: parts[2].to_string(),
                    id: s.id.clone(),
                    name: s.name.clone(),
                    query: s.query.clone(),
                    created_at: s.created_at.clone(),
                });
            }
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "Active");
        let _ = std::fs::remove_file(path);
    }
}
