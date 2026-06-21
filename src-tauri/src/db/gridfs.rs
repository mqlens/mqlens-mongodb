//! GridFS browsing (M7): list, upload, download, and delete files in a bucket.

use crate::limits::{GRIDFS_STREAM_BUF, MAX_GRIDFS_LIST, MAX_GRIDFS_UPLOAD_BYTES};
use crate::{connection_is_mock, require_real_client, AppState};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone)]
pub struct GridFsFileInfo {
    pub id: String, // Extended-JSON of the file's _id
    pub filename: String,
    pub length: u64,
    pub chunk_size_bytes: u32,
    pub upload_date: String,
    pub content_type: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct GridFsTransferProgress {
    pub transferred: u64,
    pub total: u64,
}

fn gridfs_bucket(
    client: &mongodb::Client,
    database: &str,
    bucket: &str,
) -> mongodb::gridfs::GridFsBucket {
    client.database(database).gridfs_bucket(
        mongodb::options::GridFsBucketOptions::builder()
            .bucket_name(bucket.to_string())
            .build(),
    )
}

fn guess_content_type(filename: &str) -> Option<&'static str> {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())?;
    match ext.as_str() {
        "pdf" => Some("application/pdf"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "json" => Some("application/json"),
        "txt" => Some("text/plain"),
        "html" | "htm" => Some("text/html"),
        "css" => Some("text/css"),
        "js" => Some("text/javascript"),
        "csv" => Some("text/csv"),
        "xml" => Some("application/xml"),
        "zip" => Some("application/zip"),
        "gz" => Some("application/gzip"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "wasm" => Some("application/wasm"),
        _ => None,
    }
}

async fn set_gridfs_content_type(
    client: &mongodb::Client,
    database: &str,
    bucket: &str,
    file_id: &mongodb::bson::Bson,
    content_type: &str,
) -> Result<(), String> {
    let files_coll = format!("{}.files", bucket);
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(&files_coll);
    coll.update_one(
        mongodb::bson::doc! { "_id": file_id },
        mongodb::bson::doc! { "$set": { "contentType": content_type } },
    )
    .await
    .map_err(|e| format!("Failed to set GridFS content type: {}", e))?;
    Ok(())
}

pub async fn list_gridfs_files_impl(
    state: &AppState,
    id: &str,
    database: &str,
    bucket: &str,
) -> Result<String, String> {
    if connection_is_mock(state, id)? {
        return Err("GridFS is not supported on mock connections".to_string());
    }
    let client = require_real_client(state, id)?;
    let files_coll = format!("{}.files", bucket);
    let coll = client
        .database(database)
        .collection::<mongodb::bson::Document>(&files_coll);
    let mut cursor = coll
        .find(mongodb::bson::doc! {})
        .sort(mongodb::bson::doc! { "filename": 1 })
        .limit(MAX_GRIDFS_LIST)
        .await
        .map_err(|e| format!("Failed to list GridFS files: {}", e))?;

    use futures::stream::StreamExt;
    let mut files = Vec::new();
    while let Some(res) = cursor.next().await {
        let doc = res.map_err(|e| format!("Cursor read error: {}", e))?;
        let id_extjson = doc
            .get("_id")
            .cloned()
            .unwrap_or(mongodb::bson::Bson::Null)
            .into_relaxed_extjson()
            .to_string();
        let filename = doc.get_str("filename").unwrap_or("").to_string();
        let length = doc
            .get_i64("length")
            .map(|v| v as u64)
            .or_else(|_| doc.get_i32("length").map(|v| v as u64))
            .unwrap_or(0);
        let chunk_size_bytes = doc.get_i32("chunkSize").map(|v| v as u32).unwrap_or(0);
        let upload_date = doc
            .get_datetime("uploadDate")
            .ok()
            .and_then(|d| d.try_to_rfc3339_string().ok())
            .unwrap_or_default();
        let content_type = doc.get_str("contentType").ok().map(|s| s.to_string());
        files.push(GridFsFileInfo {
            id: id_extjson,
            filename,
            length,
            chunk_size_bytes,
            upload_date,
            content_type,
        });
    }
    serde_json::to_string(&files).map_err(|e| format!("Serialization error: {}", e))
}

pub async fn upload_gridfs_file_impl(
    state: &AppState,
    id: &str,
    database: &str,
    bucket: &str,
    source_path: &str,
    filename: Option<&str>,
    metadata_json: Option<&str>,
    content_type: Option<&str>,
    on_progress: Option<&(dyn Fn(GridFsTransferProgress) + Send + Sync)>,
) -> Result<String, String> {
    if connection_is_mock(state, id)? {
        return Err("GridFS is not supported on mock connections".to_string());
    }

    let metadata = match metadata_json {
        Some(json) if !json.trim().is_empty() => {
            let value: serde_json::Value =
                serde_json::from_str(json).map_err(|e| format!("Invalid metadata JSON: {}", e))?;
            let bson = mongodb::bson::Bson::try_from(value)
                .map_err(|e| format!("Invalid metadata document: {}", e))?;
            match bson {
                mongodb::bson::Bson::Document(doc) => Some(doc),
                _ => return Err("Metadata must be a JSON object".to_string()),
            }
        }
        _ => None,
    };

    let path = Path::new(source_path);
    if !path.is_file() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let file_meta = tokio::fs::metadata(source_path)
        .await
        .map_err(|e| format!("Failed to read source file metadata: {}", e))?;
    let total = file_meta.len();
    if total > MAX_GRIDFS_UPLOAD_BYTES {
        return Err(format!(
            "File exceeds the maximum GridFS upload size ({} bytes)",
            MAX_GRIDFS_UPLOAD_BYTES
        ));
    }

    let upload_name = filename
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| "Could not determine a filename for upload".to_string())?;
    let resolved_content_type = content_type
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| guess_content_type(&upload_name).map(|s| s.to_string()));

    let client = require_real_client(state, id)?;
    let bucket_obj = gridfs_bucket(&client, database, bucket);

    let mut upload_builder = bucket_obj.open_upload_stream(&upload_name);
    if let Some(meta) = metadata {
        upload_builder = upload_builder.metadata(meta);
    }
    let mut upload = upload_builder
        .await
        .map_err(|e| format!("Failed to open GridFS upload: {}", e))?;

    use futures::AsyncWriteExt;
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(source_path)
        .await
        .map_err(|e| format!("Failed to open source file: {}", e))?;
    let mut buf = vec![0u8; GRIDFS_STREAM_BUF];
    let mut transferred = 0u64;
    if let Some(cb) = on_progress {
        cb(GridFsTransferProgress {
            transferred: 0,
            total,
        });
    }
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Failed to read source file: {}", e))?;
        if n == 0 {
            break;
        }
        upload
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("GridFS write error: {}", e))?;
        transferred += n as u64;
        if let Some(cb) = on_progress {
            cb(GridFsTransferProgress {
                transferred,
                total,
            });
        }
    }
    let file_bson_id = upload.id().clone();
    upload
        .close()
        .await
        .map_err(|e| format!("Failed to finalize GridFS upload: {}", e))?;

    if let Some(ct) = resolved_content_type.as_deref() {
        set_gridfs_content_type(&client, database, bucket, &file_bson_id, ct).await?;
    }

    let file_id = file_bson_id.into_relaxed_extjson().to_string();
    Ok(file_id)
}

pub async fn delete_gridfs_file_impl(
    state: &AppState,
    id: &str,
    database: &str,
    bucket: &str,
    file_id_json: &str,
) -> Result<(), String> {
    if connection_is_mock(state, id)? {
        return Err("GridFS is not supported on mock connections".to_string());
    }
    let id_value: serde_json::Value =
        serde_json::from_str(file_id_json).map_err(|e| format!("Invalid file id JSON: {}", e))?;
    let file_id = mongodb::bson::Bson::try_from(id_value)
        .map_err(|e| format!("Invalid file id: {}", e))?;

    let client = require_real_client(state, id)?;
    let bucket_obj = gridfs_bucket(&client, database, bucket);
    bucket_obj
        .delete(file_id)
        .await
        .map_err(|e| format!("Failed to delete GridFS file: {}", e))
}

pub async fn download_gridfs_file_impl(
    state: &AppState,
    id: &str,
    database: &str,
    bucket: &str,
    file_id_json: &str,
    dest_path: &str,
    total_bytes: Option<u64>,
    on_progress: Option<&(dyn Fn(GridFsTransferProgress) + Send + Sync)>,
) -> Result<u64, String> {
    if connection_is_mock(state, id)? {
        return Err("GridFS is not supported on mock connections".to_string());
    }
    // Parse the file _id from its Extended JSON (e.g. {"$oid": "..."}).
    let id_value: serde_json::Value =
        serde_json::from_str(file_id_json).map_err(|e| format!("Invalid file id JSON: {}", e))?;
    let file_id = mongodb::bson::Bson::try_from(id_value)
        .map_err(|e| format!("Invalid file id: {}", e))?;

    let client = require_real_client(state, id)?;
    let bucket_obj = gridfs_bucket(&client, database, bucket);
    let mut stream = bucket_obj
        .open_download_stream(file_id)
        .await
        .map_err(|e| format!("Failed to open GridFS download: {}", e))?;

    use futures::AsyncReadExt;
    use tokio::io::AsyncWriteExt;

    let total = total_bytes.unwrap_or(0);
    if let Some(cb) = on_progress {
        cb(GridFsTransferProgress {
            transferred: 0,
            total,
        });
    }

    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;
    let mut buf = vec![0u8; GRIDFS_STREAM_BUF];
    let mut transferred = 0u64;
    loop {
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| format!("GridFS read error: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .await
            .map_err(|e| format!("Failed to write file: {}", e))?;
        transferred += n as u64;
        if let Some(cb) = on_progress {
            cb(GridFsTransferProgress {
                transferred,
                total,
            });
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {}", e))?;
    Ok(transferred)
}
