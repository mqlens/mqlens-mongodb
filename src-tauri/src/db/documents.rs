//! Document mutation and import operations.

use crate::{connection_is_mock, require_real_client, AppState};

// Parse a JSON string into a BSON Document, interpreting MongoDB Extended JSON
// (e.g. {"$oid": "..."} -> ObjectId, {"$date": ...} -> DateTime) so that writes
// match documents by their real _id type rather than a literal sub-document.
pub fn json_to_bson_document(s: &str) -> Result<mongodb::bson::Document, String> {
    let value: serde_json::Value =
        serde_json::from_str(s).map_err(|e| format!("Invalid JSON: {}", e))?;
    let bson = mongodb::bson::Bson::try_from(value)
        .map_err(|e| format!("Invalid BSON/Extended JSON: {}", e))?;
    match bson {
        mongodb::bson::Bson::Document(doc) => Ok(doc),
        _ => Err("Expected a JSON object (e.g. { \"field\": value })".to_string()),
    }
}

pub async fn delete_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    // Parse/validate up front so bad input fails the same way for mock & real.
    let filter_doc = json_to_bson_document(filter)?;

    if connection_is_mock(state, id)? {
        return Ok(1);
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .delete_one(filter_doc)
        .await
        .map_err(|e| format!("Failed to delete document: {}", e))?;
    Ok(res.deleted_count)
}

pub async fn delete_many_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    if connection_is_mock(state, id)? {
        return Ok(0); // mock connections don't persist deletes
    }
    let client = require_real_client(state, id)?;
    let res = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection)
        .delete_many(filter_doc)
        .await
        .map_err(|e| format!("Failed to delete documents: {}", e))?;
    Ok(res.deleted_count)
}

pub async fn update_many_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    update: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    let update_doc = json_to_bson_document(update)?;
    // Require an operator-keyed update ({ "$set": … }); reject bare replacements
    // / empty updates so a bulk op can't silently overwrite whole documents.
    if update_doc.is_empty() || !update_doc.keys().all(|k| k.starts_with('$')) {
        return Err("Update must use operators like $set (e.g. { \"$set\": { … } })".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(0); // mock connections don't persist updates
    }
    let client = require_real_client(state, id)?;
    let res = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection)
        .update_many(filter_doc, update_doc)
        .await
        .map_err(|e| format!("Failed to update documents: {}", e))?;
    Ok(res.modified_count)
}

pub async fn insert_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    document: &str,
) -> Result<String, String> {
    let doc = json_to_bson_document(document)?;

    if connection_is_mock(state, id)? {
        return Ok("mock-inserted-id".to_string());
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .insert_one(doc)
        .await
        .map_err(|e| format!("Failed to insert document: {}", e))?;
    // Return the inserted id as a JSON string (Extended JSON for ObjectId etc.).
    Ok(res.inserted_id.into_relaxed_extjson().to_string())
}

pub async fn update_document_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    filter: &str,
    replacement: &str,
) -> Result<u64, String> {
    let filter_doc = json_to_bson_document(filter)?;
    let replacement_doc = json_to_bson_document(replacement)?;

    if connection_is_mock(state, id)? {
        return Ok(1);
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);
    let res = coll
        .replace_one(filter_doc, replacement_doc)
        .await
        .map_err(|e| format!("Failed to update document: {}", e))?;
    Ok(res.modified_count)
}

#[derive(serde::Serialize)]
pub struct ImportResult {
    pub inserted: u64,
    pub updated: u64,
    pub skipped: u64,
}

// Bulk-import documents with a duplicate-handling mode:
//   "skip"   - insert_many(ordered:false); duplicate-key rows are counted as skipped.
//   "update" - per doc replace_one({_id}, doc, upsert:true); no _id -> insert.
//   "abort"  - if any incoming _id already exists, write nothing and error.
// Documents are already-validated JSON values from the frontend codec; each is
// converted to BSON here as a safety net.
pub async fn import_documents_impl(
    state: &AppState,
    id: &str,
    database: &str,
    collection: &str,
    docs: Vec<serde_json::Value>,
    mode: &str,
) -> Result<ImportResult, String> {
    // Convert all docs up front; a bad doc fails the whole import before writing.
    let mut bson_docs: Vec<mongodb::bson::Document> = Vec::with_capacity(docs.len());
    for value in &docs {
        let s = serde_json::to_string(value).map_err(|e| format!("Invalid document: {}", e))?;
        bson_docs.push(json_to_bson_document(&s)?);
    }

    if connection_is_mock(state, id)? {
        // Mock connections validate but do not persist.
        return Ok(match mode {
            "update" => ImportResult {
                inserted: 0,
                updated: bson_docs.len() as u64,
                skipped: 0,
            },
            _ => ImportResult {
                inserted: bson_docs.len() as u64,
                updated: 0,
                skipped: 0,
            },
        });
    }

    let client = require_real_client(state, id)?;
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(collection);

    // Collect the set of incoming _ids that already exist in the collection,
    // keyed by their stringified BSON (same rendering on both sides). Used by
    // skip (partition) and abort (pre-check) so we never rely on bulk-write
    // error introspection, which varies across driver versions.
    async fn existing_ids(
        coll: &mongodb::Collection<mongodb::bson::Document>,
        docs: &[mongodb::bson::Document],
    ) -> Result<std::collections::HashSet<String>, String> {
        let ids: Vec<mongodb::bson::Bson> =
            docs.iter().filter_map(|d| d.get("_id").cloned()).collect();
        let mut found = std::collections::HashSet::new();
        if ids.is_empty() {
            return Ok(found);
        }
        let mut cursor = coll
            .find(mongodb::bson::doc! { "_id": { "$in": ids } })
            .await
            .map_err(|e| format!("Failed to check existing documents: {}", e))?;
        use futures::stream::StreamExt;
        while let Some(result) = cursor.next().await {
            let doc = result.map_err(|e| format!("Cursor read error: {}", e))?;
            if let Some(id_val) = doc.get("_id") {
                found.insert(id_val.to_string());
            }
        }
        Ok(found)
    }

    match mode {
        "update" => {
            // Existing _ids get replaced (counts as updated); everything else is
            // inserted. This is an upsert-by-_id without relying on the driver's
            // option setters, which vary across versions.
            let existing = existing_ids(&coll, &bson_docs).await?;
            let mut inserted = 0u64;
            let mut updated = 0u64;
            for doc in bson_docs {
                match doc.get("_id").cloned() {
                    Some(id_val) if existing.contains(&id_val.to_string()) => {
                        let filter = mongodb::bson::doc! { "_id": id_val };
                        let res = coll
                            .replace_one(filter, doc)
                            .await
                            .map_err(|e| format!("Failed to import (update): {}", e))?;
                        updated += res.modified_count;
                    }
                    _ => {
                        coll.insert_one(doc)
                            .await
                            .map_err(|e| format!("Failed to import (insert): {}", e))?;
                        inserted += 1;
                    }
                }
            }
            Ok(ImportResult {
                inserted,
                updated,
                skipped: 0,
            })
        }
        "abort" => {
            // Any incoming _id already present -> abort, write nothing.
            let existing = existing_ids(&coll, &bson_docs).await?;
            if !existing.is_empty() {
                return Err(format!(
                    "Import aborted: {} document(s) already exist",
                    existing.len()
                ));
            }
            let total = bson_docs.len() as u64;
            coll.insert_many(bson_docs)
                .await
                .map_err(|e| format!("Failed to import: {}", e))?;
            Ok(ImportResult {
                inserted: total,
                updated: 0,
                skipped: 0,
            })
        }
        _ => {
            // "skip" (default): insert only docs whose _id does not already exist;
            // count existing ones as skipped. Docs without an _id always insert.
            let existing = existing_ids(&coll, &bson_docs).await?;
            let total = bson_docs.len() as u64;
            let to_insert: Vec<mongodb::bson::Document> = bson_docs
                .into_iter()
                .filter(|d| match d.get("_id") {
                    Some(id_val) => !existing.contains(&id_val.to_string()),
                    None => true,
                })
                .collect();
            let inserted = to_insert.len() as u64;
            if !to_insert.is_empty() {
                coll.insert_many(to_insert)
                    .await
                    .map_err(|e| format!("Failed to import: {}", e))?;
            }
            Ok(ImportResult {
                inserted,
                updated: 0,
                skipped: total - inserted,
            })
        }
    }
}
