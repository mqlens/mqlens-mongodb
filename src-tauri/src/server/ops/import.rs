//! Import and document generation on a server connection: the same desktop
//! tasks, writing through InsertMany and ReplaceDocument.

use crate::db::documents::ImportResult;
use crate::server::ops::copy::RemoteSide;
use mongodb::bson::Document;

/// `documents::write_imported_docs` on a server connection, mode for mode.
/// Inserts go as raw BSON and keep every document as it is. A replacement
/// goes as Extended JSON, which would read a sub-document shaped like a type
/// wrapper (a BSON import keeps those as stored) as that type, so update mode
/// refuses such a document before writing any of the batch.
pub(crate) async fn write_imported_docs(
    remote: &RemoteSide,
    database: &str,
    collection: &str,
    docs: Vec<Document>,
    mode: &str,
) -> Result<ImportResult, String> {
    match mode {
        "update" => {
            let existing = remote.existing_ids(database, collection, &docs).await?;
            let replaced_wrapper_shaped = docs.iter().find(|d| {
                d.get("_id")
                    .is_some_and(|id| existing.contains(&id.to_string()))
                    && crate::db::documents::has_type_wrapper_key(d)
            });
            if let Some(doc) = replaced_wrapper_shaped {
                return Err(format!(
                    "Import aborted: the document with _id {} has a sub-document whose field \
                     names look like an Extended JSON type ($numberLong, $date, $oid and the \
                     like). Replacing it through MQLens Server would store that type in their \
                     place. Import it in update mode on a direct connection instead.",
                    doc.get("_id").map(|id| id.to_string()).unwrap_or_default()
                ));
            }
            let (mut inserted, mut updated) = (0u64, 0u64);
            let mut fresh = Vec::new();
            for doc in docs {
                match doc.get("_id").cloned() {
                    Some(id) if existing.contains(&id.to_string()) => {
                        updated += remote
                            .replace(database, collection, &id, &doc)
                            .await
                            .map_err(|e| format!("Failed to import (update): {}", e))?;
                    }
                    _ => {
                        inserted += 1;
                        fresh.push(doc);
                    }
                }
            }
            remote
                .insert_all(database, collection, fresh, "import (insert)")
                .await?;
            Ok(ImportResult {
                inserted,
                updated,
                skipped: 0,
            })
        }
        "abort" => {
            let existing = remote.existing_ids(database, collection, &docs).await?;
            if !existing.is_empty() {
                return Err(format!(
                    "Import aborted: {} document(s) already exist",
                    existing.len()
                ));
            }
            let total = docs.len() as u64;
            remote
                .insert_all(database, collection, docs, "import")
                .await?;
            Ok(ImportResult {
                inserted: total,
                updated: 0,
                skipped: 0,
            })
        }
        _ => {
            let existing = remote.existing_ids(database, collection, &docs).await?;
            let total = docs.len() as u64;
            let to_insert: Vec<Document> = docs
                .into_iter()
                .filter(|d| match d.get("_id") {
                    Some(id) => !existing.contains(&id.to_string()),
                    None => true,
                })
                .collect();
            let inserted = to_insert.len() as u64;
            remote
                .insert_all(database, collection, to_insert, "import")
                .await?;
            Ok(ImportResult {
                inserted,
                updated: 0,
                skipped: total - inserted,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::db::generate::{infer_generate_template_impl, start_generate_task_impl};
    use crate::db::import::{start_import_task_impl, ImportSourceArg};
    use crate::server::fake::{Env, FakeWrite};
    use crate::server::ops::connected;
    use crate::{AppState, TaskInfo};
    use mongodb::bson::Document;
    use std::time::Duration;

    /// Connected over API version 5 as an operator.
    async fn writing(env: &Env) -> (AppState, String) {
        env.fake.with(|s| {
            s.max_api_version = 5;
            s.connections[0].op_classes = ["read", "write"].map(String::from).to_vec();
        });
        connected(env).await
    }

    async fn finished(state: &AppState, task: &TaskInfo) -> TaskInfo {
        for _ in 0..250 {
            let now = state.tasks.lock().unwrap().get(&task.id).cloned().unwrap();
            if now.status != "running" {
                return now;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the task never finished");
    }

    async fn import(
        state: &AppState,
        id: &str,
        text: &str,
        mode: &str,
    ) -> Result<TaskInfo, String> {
        start_import_task_impl(
            state,
            id,
            "orders",
            "items",
            ImportSourceArg {
                path: None,
                text: Some(text.to_string()),
            },
            "json",
            None,
            mode,
        )
        .await
    }

    fn inserted(env: &Env) -> Vec<Document> {
        env.fake
            .with(|s| s.writes.clone())
            .into_iter()
            .filter_map(|w| match w {
                FakeWrite::InsertMany(r) => Some(r.documents_bson.into_iter().map(|d| {
                    crate::db::stored(
                        mongodb::bson::RawDocumentBuf::from_bytes(d.to_vec()).unwrap(),
                    )
                    .unwrap()
                })),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn replaced(env: &Env) -> Vec<String> {
        env.fake
            .with(|s| s.writes.clone())
            .into_iter()
            .filter_map(|w| match w {
                FakeWrite::Replace(r) => Some(r.filter_json),
                _ => None,
            })
            .collect()
    }

    // The fake's collection already holds _id 1 (its Find answers with its
    // documents whatever the filter), so skip writes only the new one.
    #[tokio::test]
    async fn an_import_skips_documents_already_on_the_server() {
        let env = Env::new().await;
        let (state, id) = writing(&env).await;

        let task = import(
            &state,
            &id,
            r#"[{"_id": 1, "x": 1}, {"_id": 99, "x": 2}]"#,
            "skip",
        )
        .await
        .unwrap();
        let done = finished(&state, &task).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        assert!(
            done.message.contains("1 inserted, 0 updated, 1 skipped"),
            "{}",
            done.message
        );
        let written = inserted(&env);
        assert_eq!(written.len(), 1);
        assert_eq!(written[0].get_i32("_id"), Ok(99));
    }

    #[tokio::test]
    async fn an_import_aborts_when_a_document_is_already_there() {
        let env = Env::new().await;
        let (state, id) = writing(&env).await;

        let done = finished(
            &state,
            &import(&state, &id, r#"[{"_id": 1}]"#, "abort")
                .await
                .unwrap(),
        )
        .await;

        assert_eq!(done.status, "failed");
        assert!(done.error.unwrap().contains("already exist"));
        assert!(inserted(&env).is_empty());
    }

    // Update replaces what is there and inserts the rest.
    #[tokio::test]
    async fn an_import_updates_documents_already_on_the_server() {
        let env = Env::new().await;
        let (state, id) = writing(&env).await;

        let task = import(
            &state,
            &id,
            r#"[{"_id": 1, "x": 1}, {"_id": 99, "x": 2}]"#,
            "update",
        )
        .await
        .unwrap();
        let done = finished(&state, &task).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        assert_eq!(replaced(&env).len(), 1, "{:?}", replaced(&env));
        assert!(replaced(&env)[0].contains("\"_id\""));
        assert_eq!(inserted(&env).len(), 1);
    }

    /// A document whose sub-document looks like an Extended JSON type.
    fn wrapper_shaped(id: i32) -> Document {
        mongodb::bson::doc! { "_id": id, "v": { "$numberLong": "7", "other": 1 } }
    }

    async fn import_bson(state: &AppState, id: &str, doc: &Document, mode: &str) -> TaskInfo {
        let path = std::env::temp_dir().join(format!(
            "mqlens-server-import-{}.bson",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&path, mongodb::bson::to_vec(doc).unwrap()).unwrap();
        let task = start_import_task_impl(
            state,
            id,
            "orders",
            "items",
            ImportSourceArg {
                path: Some(path.to_string_lossy().to_string()),
                text: None,
            },
            "bson",
            None,
            mode,
        )
        .await
        .unwrap();
        let done = finished(state, &task).await;
        let _ = std::fs::remove_file(&path);
        done
    }

    // A BSON import inserts such a document exactly as it is in the file.
    #[tokio::test]
    async fn a_bson_import_inserts_wrapper_shaped_documents_as_stored() {
        let env = Env::new().await;
        let (state, id) = writing(&env).await;

        let done = import_bson(&state, &id, &wrapper_shaped(99), "skip").await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        assert_eq!(inserted(&env), vec![wrapper_shaped(99)]);
    }

    // A replacement goes as Extended JSON, which would read such a document
    // as the type it imitates, so update mode refuses it and writes nothing.
    #[tokio::test]
    async fn an_update_import_refuses_to_replace_with_a_wrapper_shaped_document() {
        let env = Env::new().await;
        let (state, id) = writing(&env).await;

        let done = import_bson(&state, &id, &wrapper_shaped(1), "update").await;

        assert_eq!(done.status, "failed");
        assert!(
            done.error.as_deref().unwrap_or("").contains("$numberLong"),
            "{:?}",
            done.error
        );
        assert!(replaced(&env).is_empty(), "{:?}", replaced(&env));
    }

    // Generated documents are written to the server in batches.
    #[tokio::test]
    async fn documents_are_generated_on_the_server() {
        let env = Env::new().await;
        let (state, id) = writing(&env).await;

        let task = start_generate_task_impl(
            &state,
            &id,
            "orders",
            "items",
            r#"{"a": "$name", "n": {"$int": {"min": 0, "max": 10}}}"#,
            7,
            Some(1),
        )
        .await
        .unwrap();
        let done = finished(&state, &task).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let written = inserted(&env);
        assert_eq!(written.len(), 7);
        assert!(written
            .iter()
            .all(|d| d.contains_key("a") && d.contains_key("n")));
    }

    // A template is inferred from the server's sample of the collection.
    #[tokio::test]
    async fn a_template_is_inferred_through_the_server() {
        let env = Env::new().await;
        let (state, id) = writing(&env).await;

        let template = infer_generate_template_impl(&state, &id, "orders", "items", None)
            .await
            .unwrap();

        assert!(template.contains("name"), "{template}");
    }

    // Writing needs the write role, and a server that takes bulk inserts.
    #[tokio::test]
    async fn an_import_needs_write_and_version_five() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let err = import(&state, &id, "[]", "skip").await.unwrap_err();
        assert!(err.contains("API version 5"), "{err}");

        let env = Env::new().await;
        env.fake.with(|s| {
            s.max_api_version = 5;
            s.connections[0].op_classes = vec!["read".to_string()];
        });
        let (state, id) = connected(&env).await;
        let err = import(&state, &id, "[]", "skip").await.unwrap_err();
        assert!(err.contains("does not allow write"), "{err}");
    }

    // An import of large documents goes to the server in requests of
    // bounded size, as a copy does.
    #[tokio::test]
    async fn large_imported_documents_are_sent_in_bounded_requests() {
        let env = Env::new().await;
        let (state, id) = writing(&env).await;
        let pad = "x".repeat(1_500_000);
        let text = format!(
            "[{}]",
            (100..106)
                .map(|i| format!(r#"{{"_id": {i}, "pad": "{pad}"}}"#))
                .collect::<Vec<_>>()
                .join(",")
        );

        let done = finished(&state, &import(&state, &id, &text, "skip").await.unwrap()).await;

        assert_eq!(done.status, "completed", "{:?}", done.error);
        let sizes: Vec<usize> = env
            .fake
            .with(|s| s.writes.clone())
            .into_iter()
            .filter_map(|w| match w {
                FakeWrite::InsertMany(r) => Some(r.documents_bson.iter().map(|d| d.len()).sum()),
                _ => None,
            })
            .collect();
        assert!(sizes.len() > 1, "{sizes:?}");
        assert!(sizes.iter().all(|n| *n <= 4 << 20), "{sizes:?}");
    }
}
