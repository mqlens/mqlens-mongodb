//! Durable AI Helper conversations.
//!
//! Modelled on [`crate::queries`], which already stores per-collection saved
//! queries and history in a JSON document under the app config dir. Chats get
//! the same treatment for the same reasons: a conversation is worth keeping
//! across restarts, it belongs to a connection/database/collection rather than
//! to a window, and the renderer is the wrong owner for anything that must
//! outlive it.
//!
//! Unlike queries, chats are stored as a FLAT list rather than a map keyed by
//! scope. Each chat carries its own scope, so the panel can show one
//! collection's chats or every chat, without the store having to be reshaped
//! for the second case.
//!
//! Following `queries.rs`, the backend keeps no clock: the frontend supplies
//! `createdAt`/`updatedAt` and the retention cutoff. That keeps every "when"
//! decision in one place and leaves this module pure enough to unit test.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::Manager;

/// Serialises every read-modify-write of the store.
///
/// Each command loads the whole document, changes one chat and writes it back.
/// Two of those interleaving — two tabs saving at once, or two windows — means
/// the second write is built on a snapshot taken before the first, and silently
/// drops it. The critical sections are pure synchronous file work with no
/// awaits inside, so a plain mutex is the right tool.
fn store_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| Mutex::new(()));
    // A panic elsewhere must not wedge the assistant: the data the guard
    // protects is the file itself, and every writer rewrites it wholesale.
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One bubble. `query` is the frontend's GeneratedQuery shape as raw JSON —
/// this module never interprets it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

/// One conversation, with the scope it belongs to baked in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    /// Connection NAME, not the session id — like `queries::collection_key`, so
    /// a chat survives reconnecting.
    pub connection_name: String,
    pub database: String,
    pub collection: String,
    /// `"editor"` or `"shell"`: the same collection has separate conversations
    /// in the document viewer and in the shell.
    pub variant: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

/// A chat without its messages, for the history list. Listing every transcript
/// just to render titles would grow with the size of the conversations.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub connection_name: String,
    pub database: String,
    pub collection: String,
    pub variant: String,
    pub updated_at: String,
    pub message_count: usize,
}

/// The scope a listing is narrowed to. Every field must match.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatScope {
    pub connection_name: String,
    pub database: String,
    pub collection: String,
    pub variant: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct ChatStore {
    #[serde(default)]
    pub chats: Vec<Chat>,
}

/// Most chats kept, across every scope. Oldest `updated_at` is dropped first.
pub const MAX_CHATS: usize = 200;
/// Most messages kept in one chat, oldest first out.
pub const MAX_MESSAGES: usize = 200;

impl Chat {
    fn in_scope(&self, scope: &ChatScope) -> bool {
        self.connection_name == scope.connection_name
            && self.database == scope.database
            && self.collection == scope.collection
            && self.variant == scope.variant
    }

    fn summary(&self) -> ChatSummary {
        ChatSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            connection_name: self.connection_name.clone(),
            database: self.database.clone(),
            collection: self.collection.clone(),
            variant: self.variant.clone(),
            updated_at: self.updated_at.clone(),
            message_count: self.messages.len(),
        }
    }
}

/// Insert or replace `chat`, newest first, capped.
///
/// Replacing by id rather than appending is what makes save idempotent: the
/// panel saves the whole conversation on every message.
pub fn upsert_chat(existing: Vec<Chat>, mut chat: Chat, max_chats: usize) -> Vec<Chat> {
    if chat.messages.len() > MAX_MESSAGES {
        // Keep the most recent exchange, not the oldest: a long conversation is
        // pruned from the top, the way the transcript itself scrolls.
        chat.messages = chat.messages.split_off(chat.messages.len() - MAX_MESSAGES);
    }
    let mut out: Vec<Chat> = Vec::with_capacity(existing.len() + 1);
    out.push(chat.clone());
    for c in existing {
        if c.id != chat.id {
            out.push(c);
        }
    }
    sort_newest_first(&mut out);
    out.truncate(max_chats);
    out
}

/// Drop chats untouched since `cutoff_iso` (an ISO-8601 instant from the
/// frontend's retention setting). An empty cutoff prunes nothing, so a caller
/// that has no setting to apply cannot accidentally erase everything.
pub fn prune_expired(existing: Vec<Chat>, cutoff_iso: &str) -> Vec<Chat> {
    if cutoff_iso.is_empty() {
        return existing;
    }
    existing
        .into_iter()
        // ISO-8601 UTC strings compare lexicographically in time order, which
        // is the only reason this works without a date library. A chat with no
        // timestamp at all is kept rather than silently discarded.
        .filter(|c| c.updated_at.is_empty() || c.updated_at.as_str() >= cutoff_iso)
        .collect()
}

fn sort_newest_first(chats: &mut [Chat]) {
    chats.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
}

/// Summaries, newest first, optionally narrowed to one scope.
pub fn summaries(chats: &[Chat], scope: Option<&ChatScope>) -> Vec<ChatSummary> {
    let mut out: Vec<ChatSummary> = chats
        .iter()
        .filter(|c| scope.is_none_or(|s| c.in_scope(s)))
        .map(Chat::summary)
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn get_chats_path(app_handle: &tauri::AppHandle) -> PathBuf {
    match app_handle.path().app_config_dir() {
        Ok(mut path) => {
            let _ = fs::create_dir_all(&path);
            path.push("chats.json");
            path
        }
        Err(_) => PathBuf::from("chats.json"),
    }
}

/// Load the store. A missing or corrupt file is an empty store — persistence is
/// best-effort and must never block the assistant.
pub fn load_store_from_file(path: &Path) -> ChatStore {
    if !path.exists() {
        return ChatStore::default();
    }
    let Ok(content) = fs::read_to_string(path) else {
        return ChatStore::default();
    };
    if content.trim().is_empty() {
        return ChatStore::default();
    }
    serde_json::from_str(&content).unwrap_or_default()
}

/// Write via a temp file and rename, so an interrupted write cannot leave a
/// half-written document behind — same approach as `workspace::save_to_file`.
pub fn save_store_to_file(path: &Path, store: &ChatStore) -> Result<(), String> {
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize chats: {}", e))?;
    // Includes the pid, so a second instance of the app writing at the same
    // moment cannot rename its half-written file over this one.
    let tmp = path.with_extension(format!("{}.json.tmp", std::process::id()));
    fs::write(&tmp, content).map_err(|e| format!("Failed to write chats file: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to replace chats file: {}", e))
}

#[tauri::command]
pub async fn list_chats(
    app_handle: tauri::AppHandle,
    scope: Option<ChatScope>,
    cutoff_iso: Option<String>,
) -> Result<Vec<ChatSummary>, String> {
    let _guard = store_lock();
    let path = get_chats_path(&app_handle);
    let mut store = load_store_from_file(&path);
    let before = store.chats.len();
    store.chats = prune_expired(store.chats, cutoff_iso.as_deref().unwrap_or_default());
    // Only rewrite when retention actually removed something, so listing stays
    // a read in the common case.
    if store.chats.len() != before {
        let _ = save_store_to_file(&path, &store);
    }
    Ok(summaries(&store.chats, scope.as_ref()))
}

/// Conversations a panel currently has open, chat id -> owner token.
///
/// The owner is a PANEL (`<window>#<n>`), not a window: two tabs in the same
/// window are two panels and must not both hold one.
///
/// The guard has to be shared: two WINDOWS are two renderers, so a
/// renderer-local set let both auto-adopt the same conversation, after which
/// each saved its own transcript over the other's. Not persisted — it describes
/// what is on screen right now, which is meaningless once the app exits.
fn open_chats() -> MutexGuard<'static, std::collections::HashMap<String, String>> {
    static OPEN: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    let lock = OPEN.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Take `chat_id` for `window_id`, or report that someone else has it. Taking a
/// chat you already hold succeeds — a remount must not lock itself out.
#[tauri::command]
pub async fn claim_chat(chat_id: String, owner: String) -> Result<bool, String> {
    let mut open = open_chats();
    match open.get(&chat_id) {
        Some(holder) if *holder != owner => Ok(false),
        _ => {
            open.insert(chat_id, owner);
            Ok(true)
        }
    }
}

/// Give up a claim. Ignores a claim held by someone else, so a late release
/// from a closing panel cannot free the chat out from under its new holder.
#[tauri::command]
pub async fn release_chat(chat_id: String, owner: String) -> Result<(), String> {
    let mut open = open_chats();
    if open.get(&chat_id).is_some_and(|holder| *holder == owner) {
        open.remove(&chat_id);
    }
    Ok(())
}

/// Drop every claim held by a window — called when that window closes, since
/// its panels get no chance to release anything.
pub fn release_window_chats(window_id: &str) {
    let prefix = format!("{window_id}#");
    open_chats().retain(|_, holder| !holder.starts_with(&prefix));
}

#[tauri::command]
pub async fn load_chat(app_handle: tauri::AppHandle, id: String) -> Result<Option<Chat>, String> {
    let _guard = store_lock();
    let path = get_chats_path(&app_handle);
    let store = load_store_from_file(&path);
    Ok(store.chats.into_iter().find(|c| c.id == id))
}

#[tauri::command]
pub async fn save_chat(
    app_handle: tauri::AppHandle,
    chat: Chat,
    cutoff_iso: Option<String>,
) -> Result<(), String> {
    let _guard = store_lock();
    let path = get_chats_path(&app_handle);
    let mut store = load_store_from_file(&path);
    store.chats = prune_expired(store.chats, cutoff_iso.as_deref().unwrap_or_default());
    store.chats = upsert_chat(store.chats, chat, MAX_CHATS);
    save_store_to_file(&path, &store)
}

#[tauri::command]
pub async fn delete_chat(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
    let _guard = store_lock();
    let path = get_chats_path(&app_handle);
    let mut store = load_store_from_file(&path);
    store.chats.retain(|c| c.id != id);
    save_store_to_file(&path, &store)
}

/// Delete every chat, or every chat in one scope.
#[tauri::command]
pub async fn clear_chats(
    app_handle: tauri::AppHandle,
    scope: Option<ChatScope>,
) -> Result<(), String> {
    let _guard = store_lock();
    let path = get_chats_path(&app_handle);
    let mut store = load_store_from_file(&path);
    match scope {
        Some(s) => store.chats.retain(|c| !c.in_scope(&s)),
        None => store.chats.clear(),
    }
    save_store_to_file(&path, &store)
}
