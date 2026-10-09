//! GridFS on a server connection: listing a bucket, and moving files in
//! and out of it.

use crate::db::gridfs::{file_info, GridFsTransferProgress};
use crate::limits::{GRIDFS_STREAM_BUF, MAX_GRIDFS_LIST};
use crate::server::channel::client;
use crate::server::ejson;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::grid_fs_service_client::GridFsServiceClient;
use crate::server::pb::mqlens::v1::{
    DeleteFileRequest, DownloadFileRequest, ListFilesRequest, UploadChunk,
};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::server::session::{next_message, STREAM_IDLE_TIMEOUT};
use crate::AppState;
use mongodb::bson::{doc, Bson, Document};
use tokio::sync::mpsc;

type Progress<'a> = Option<&'a (dyn Fn(GridFsTransferProgress) + Send + Sync)>;

/// A file id as the server reads it, for download and delete alike:
/// `{"_id": <id>}` (the download field's proto comment says the bare value,
/// but the server takes `_id` from a document either way).
fn id_document(id: &Bson) -> String {
    Bson::Document(doc! { "_id": id.clone() })
        .into_canonical_extjson()
        .to_string()
}

/// The bucket's files as local mode lists them: by name, at most as many.
pub(crate) async fn list_files(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    bucket: &str,
) -> Result<String, String> {
    routes::require("list_gridfs_files", conn)?;
    let request = ListFilesRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        bucket: bucket.to_string(),
        raw_bson: true,
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(GridFsServiceClient, channel)
                .list_files(request)
                .await
        })
        .await?;
    let mut files = response
        .files_bson
        .iter()
        .map(|bytes| ejson::doc_from_bson(bytes))
        .collect::<Result<Vec<Document>, String>>()?;
    // The server lists in stored order; a stable sort keeps that order among
    // equal names, as a sort on the files collection does.
    files.sort_by(|a, b| {
        a.get_str("filename")
            .unwrap_or("")
            .cmp(b.get_str("filename").unwrap_or(""))
    });
    files.truncate(MAX_GRIDFS_LIST as usize);
    let files: Vec<_> = files.iter().map(file_info).collect();
    serde_json::to_string(&files).map_err(|e| format!("Serialization error: {}", e))
}

/// Where a download comes from and goes to.
pub(crate) struct Download<'a> {
    pub database: &'a str,
    pub bucket: &'a str,
    pub file_id: &'a Bson,
    pub dest_path: &'a str,
    /// The size the progress counts towards, 0 when unknown.
    pub total: u64,
}

/// Writes the file to `dest_path`, reporting progress as local mode does;
/// how many bytes were written.
pub(crate) async fn download(
    state: &AppState,
    conn: &RemoteConn,
    download: Download<'_>,
    on_progress: Progress<'_>,
) -> Result<u64, String> {
    routes::require("download_gridfs_file", conn)?;
    let request = DownloadFileRequest {
        connection_id: conn.remote_id.clone(),
        database: download.database.to_string(),
        bucket: download.bucket.to_string(),
        file_id_ejson: id_document(download.file_id),
    };
    let mut stream = session_for(state, conn)
        .await?
        .open_stream(request, |channel, request| async move {
            client!(GridFsServiceClient, channel)
                .download_file(request)
                .await
        })
        .await?;

    use tokio::io::AsyncWriteExt;
    let total = download.total;
    if let Some(cb) = on_progress {
        cb(GridFsTransferProgress {
            transferred: 0,
            total,
        });
    }
    let mut file = tokio::fs::File::create(download.dest_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;
    let mut transferred = 0u64;
    while let Some(chunk) = next_message(&mut stream).await? {
        file.write_all(&chunk.data)
            .await
            .map_err(|e| format!("Failed to write file: {}", e))?;
        transferred += chunk.data.len() as u64;
        if let Some(cb) = on_progress {
            cb(GridFsTransferProgress { transferred, total });
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {}", e))?;
    Ok(transferred)
}

/// A file to store, as local mode prepared it.
pub(crate) struct Upload<'a> {
    pub database: &'a str,
    pub bucket: &'a str,
    pub source_path: &'a str,
    pub filename: String,
    pub content_type: Option<String>,
    pub metadata: Option<Document>,
    /// The source's size, which progress counts towards.
    pub total: u64,
}

/// What reading the source tells the waiting upload.
enum Sent {
    Bytes(u64),
    Failed(String),
}

/// Everything an attempt needs to stream the file again from the start.
#[derive(Clone)]
struct Source {
    first: UploadChunk,
    path: std::path::PathBuf,
    events: mpsc::UnboundedSender<Sent>,
}

/// The upload's messages: the first carries the name, type and metadata, every
/// one up to 64 KiB of the file. A read that fails stops the stream without
/// ending it, so the server never takes a truncated file for a whole one; the
/// waiting upload hears of the failure and abandons the call.
fn chunks(source: Source) -> impl futures::Stream<Item = UploadChunk> + Send + 'static {
    futures::stream::unfold(
        (source, None::<tokio::fs::File>, 0u64, true),
        |(source, file, sent, first)| async move {
            use tokio::io::AsyncReadExt;
            let mut file = match file {
                Some(file) => file,
                None => match tokio::fs::File::open(&source.path).await {
                    Ok(file) => file,
                    Err(e) => {
                        let _ = source
                            .events
                            .send(Sent::Failed(format!("Failed to open source file: {}", e)));
                        return futures::future::pending().await;
                    }
                },
            };
            let mut buf = vec![0u8; GRIDFS_STREAM_BUF];
            match file.read(&mut buf).await {
                Ok(0) if !first => None,
                Ok(n) => {
                    buf.truncate(n);
                    let mut chunk = if first {
                        source.first.clone()
                    } else {
                        UploadChunk::default()
                    };
                    chunk.data = buf.into();
                    let sent = sent + n as u64;
                    let _ = source.events.send(Sent::Bytes(sent));
                    Some((chunk, (source, Some(file), sent, false)))
                }
                Err(e) => {
                    let _ = source
                        .events
                        .send(Sent::Failed(format!("Failed to read source file: {}", e)));
                    futures::future::pending().await
                }
            }
        },
    )
}

/// Stores the file, reporting progress as local mode does; the new file's id
/// in relaxed Extended JSON, as local mode returns it.
pub(crate) async fn upload(
    state: &AppState,
    conn: &RemoteConn,
    upload: Upload<'_>,
    on_progress: Progress<'_>,
) -> Result<String, String> {
    routes::require("upload_gridfs_file", conn)?;
    let (events, mut sent) = mpsc::unbounded_channel();
    let source = Source {
        first: UploadChunk {
            connection_id: conn.remote_id.clone(),
            database: upload.database.to_string(),
            bucket: upload.bucket.to_string(),
            filename: upload.filename,
            data: Default::default(),
            content_type: upload.content_type.unwrap_or_default(),
            metadata_json: upload
                .metadata
                .as_ref()
                .map(ejson::doc_to_wire)
                .unwrap_or_default(),
        },
        path: std::path::PathBuf::from(upload.source_path),
        events,
    };
    let session = session_for(state, conn).await?;
    let call = session.call_unbounded(source, |channel, request| async move {
        client!(GridFsServiceClient, channel)
            .upload_file(request.map(chunks))
            .await
    });
    tokio::pin!(call);
    let total = upload.total;
    if let Some(cb) = on_progress {
        cb(GridFsTransferProgress {
            transferred: 0,
            total,
        });
    }
    // Bounded by progress: the call may take as long as the file needs, but
    // not a stall of STREAM_IDLE_TIMEOUT between two messages or before the
    // server's answer.
    let stalled = || "MQLens Server stopped answering during the upload".to_string();
    let response = loop {
        tokio::select! {
            result = &mut call => break result?,
            event = tokio::time::timeout(STREAM_IDLE_TIMEOUT, sent.recv()) => match event {
                Ok(Some(Sent::Bytes(transferred))) => {
                    if let Some(cb) = on_progress {
                        cb(GridFsTransferProgress { transferred, total });
                    }
                }
                Ok(Some(Sent::Failed(e))) => return Err(e),
                // Every byte is sent (the last attempt's source is gone):
                // only the answer is left to wait for.
                Ok(None) => {
                    break tokio::time::timeout(STREAM_IDLE_TIMEOUT, &mut call)
                        .await
                        .map_err(|_| stalled())??
                }
                Err(_) => return Err(stalled()),
            },
        }
    };
    let stored = ejson::doc_from_wire(&response.file_id_ejson)?;
    let id = stored
        .get("_id")
        .cloned()
        .ok_or_else(|| "MQLens Server did not report the new file's id".to_string())?;
    Ok(id.into_relaxed_extjson().to_string())
}

pub(crate) async fn delete(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    bucket: &str,
    file_id: &Bson,
) -> Result<(), String> {
    routes::require("delete_gridfs_file", conn)?;
    let request = DeleteFileRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        bucket: bucket.to_string(),
        file_id_ejson: id_document(file_id),
    };
    session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(GridFsServiceClient, channel)
                .delete_file(request)
                .await
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::gridfs::{
        delete_gridfs_file_impl, download_gridfs_file_impl, list_gridfs_files_impl,
        upload_gridfs_file_impl, GridFsTransferProgress,
    };
    use crate::server::ejson;
    use crate::server::fake::{Env, FakeGridFs};
    use crate::server::ops::connected;
    use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};
    use std::sync::Mutex;

    fn file(id: &str, name: &str) -> Document {
        doc! {
            "_id": ObjectId::parse_str(id).unwrap(),
            "filename": name,
            "length": 12_i64,
            "chunkSize": 261_120,
            "uploadDate": DateTime::from_millis(1_749_427_200_000),
            "contentType": "text/plain",
        }
    }

    // A bucket lists as local mode lists it: sorted by name, each file with
    // its id in relaxed Extended JSON and its size, chunk size, date and type.
    #[tokio::test]
    async fn a_bucket_lists_as_local_mode_lists_it() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.gridfs_files = vec![
                file("64b7f0c2a1b2c3d4e5f60702", "b.txt"),
                file("64b7f0c2a1b2c3d4e5f60701", "a.txt"),
            ]
        });
        let (state, id) = connected(&env).await;

        let listed = list_gridfs_files_impl(&state, &id, "orders", "fs")
            .await
            .unwrap();

        let listed: serde_json::Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(
            listed,
            serde_json::json!([
                {
                    "id": r#"{"$oid":"64b7f0c2a1b2c3d4e5f60701"}"#,
                    "filename": "a.txt",
                    "length": 12,
                    "chunk_size_bytes": 261120,
                    "upload_date": "2025-06-09T00:00:00Z",
                    "content_type": "text/plain"
                },
                {
                    "id": r#"{"$oid":"64b7f0c2a1b2c3d4e5f60702"}"#,
                    "filename": "b.txt",
                    "length": 12,
                    "chunk_size_bytes": 261120,
                    "upload_date": "2025-06-09T00:00:00Z",
                    "content_type": "text/plain"
                }
            ])
        );
    }

    // A download writes every byte to the file and reports its progress, as
    // local mode does; the id goes as the document the server reads.
    #[tokio::test]
    async fn a_download_writes_the_file_and_reports_progress() {
        let env = Env::new().await;
        env.fake
            .with(|s| s.gridfs_content = b"hello, gridfs".to_vec());
        let (state, id) = connected(&env).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.txt");
        let seen = Mutex::new(Vec::new());
        let progress = |p: GridFsTransferProgress| seen.lock().unwrap().push(p.transferred);

        let written = download_gridfs_file_impl(
            &state,
            &id,
            "orders",
            "fs",
            r#"{"$oid":"64b7f0c2a1b2c3d4e5f60701"}"#,
            dest.to_str().unwrap(),
            Some(13),
            Some(&progress),
        )
        .await
        .unwrap();

        assert_eq!(written, 13);
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello, gridfs");
        assert_eq!(seen.lock().unwrap().as_slice(), [0, 4, 8, 12, 13]);
        match env.fake.with(|s| s.gridfs_requests.clone()).as_slice() {
            [FakeGridFs::Download(d)] => assert_eq!(
                ejson::doc_from_wire(&d.file_id_ejson).unwrap(),
                doc! { "_id": ObjectId::parse_str("64b7f0c2a1b2c3d4e5f60701").unwrap() }
            ),
            other => panic!("{other:?}"),
        }
    }

    // An upload sends every byte, with the name, the content type local mode
    // would pick and the metadata in its first message, and reports the new
    // id as local mode does.
    #[tokio::test]
    async fn an_upload_sends_the_file_with_its_type_and_metadata() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("report.pdf");
        let bytes: Vec<u8> = (0..150_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&source, &bytes).unwrap();
        let seen = Mutex::new(Vec::new());
        let progress = |p: GridFsTransferProgress| seen.lock().unwrap().push(p.transferred);

        let new_id = upload_gridfs_file_impl(
            &state,
            &id,
            "orders",
            "fs",
            source.to_str().unwrap(),
            None,
            Some(r#"{"owner": "ops"}"#),
            None,
            Some(&progress),
        )
        .await
        .unwrap();

        assert_eq!(new_id, r#"{"$oid":"64b7f0c2a1b2c3d4e5f60719"}"#);
        let (first, data) = env.fake.with(|s| s.uploads[0].clone());
        assert_eq!(data, bytes);
        assert_eq!(
            (first.filename.as_str(), first.content_type.as_str()),
            ("report.pdf", "application/pdf")
        );
        assert_eq!(
            ejson::doc_from_wire(&first.metadata_json).unwrap(),
            doc! { "owner": "ops" }
        );
        let seen = seen.lock().unwrap();
        assert_eq!((seen.first(), seen.last()), (Some(&0), Some(&150_000)));
    }

    // A server that takes the whole file but never answers is given up on,
    // even when the upload had to be sent again after a refresh.
    #[tokio::test]
    async fn an_upload_resent_after_a_refresh_still_gives_up_on_a_silent_server() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("a.bin");
        std::fs::write(&source, [1u8, 2, 3]).unwrap();
        env.fake.revoke_access_tokens();
        env.fake
            .with(|s| s.upload_delay = std::time::Duration::from_secs(60));

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            upload_gridfs_file_impl(
                &state,
                &id,
                "orders",
                "fs",
                source.to_str().unwrap(),
                None,
                None,
                None,
                None,
            ),
        )
        .await
        .expect("the upload waited on the server without a bound");

        assert_eq!(
            result.unwrap_err(),
            "MQLens Server stopped answering during the upload"
        );
        assert_eq!(env.fake.with(|s| s.uploads.len()), 1);
    }

    #[tokio::test]
    async fn a_file_is_deleted_by_its_id() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        delete_gridfs_file_impl(
            &state,
            &id,
            "orders",
            "fs",
            r#"{"$oid":"64b7f0c2a1b2c3d4e5f60701"}"#,
        )
        .await
        .unwrap();

        match env.fake.with(|s| s.gridfs_requests.clone()).as_slice() {
            [FakeGridFs::Delete(d)] => {
                assert_eq!(d.bucket, "fs");
                assert_eq!(
                    ejson::doc_from_wire(&d.file_id_ejson).unwrap(),
                    doc! { "_id": ObjectId::parse_str("64b7f0c2a1b2c3d4e5f60701").unwrap() }
                );
            }
            other => panic!("{other:?}"),
        }
    }

    // What local mode refuses goes nowhere: a missing source, bad metadata, a
    // read-only connection; nor does a change by a user who may only read.
    #[tokio::test]
    async fn refused_gridfs_changes_send_nothing() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        assert!(upload_gridfs_file_impl(
            &state,
            &id,
            "orders",
            "fs",
            "/no/such/file",
            None,
            None,
            None,
            None
        )
        .await
        .is_err());
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("a.txt");
        std::fs::write(&source, b"x").unwrap();
        assert!(upload_gridfs_file_impl(
            &state,
            &id,
            "orders",
            "fs",
            source.to_str().unwrap(),
            None,
            Some("[1]"),
            None,
            None
        )
        .await
        .is_err());
        crate::set_connection_meta_impl(
            &state,
            &id,
            "server:a:c1",
            "Orders",
            false,
            crate::connections::ConnectionMode::ReadOnly,
        )
        .unwrap();
        assert!(
            delete_gridfs_file_impl(&state, &id, "orders", "fs", r#""x""#)
                .await
                .is_err()
        );

        let reader = Env::new().await;
        reader
            .fake
            .with(|s| s.connections[0].op_classes = vec!["read".to_string()]);
        let (state, id) = connected(&reader).await;
        let err = delete_gridfs_file_impl(&state, &id, "orders", "fs", r#""x""#)
            .await
            .unwrap_err();
        assert!(err.contains("does not allow write operations"), "{err}");

        assert!(env
            .fake
            .with(|s| s.uploads.is_empty() && s.gridfs_requests.is_empty()));
        assert!(reader.fake.with(|s| s.gridfs_requests.is_empty()));
    }
}
