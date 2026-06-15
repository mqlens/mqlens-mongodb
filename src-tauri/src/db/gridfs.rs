//! GridFS browsing (M7): list files in a bucket and download them to disk.

use crate::limits::{GRIDFS_STREAM_BUF, MAX_GRIDFS_LIST};
use crate::{connection_is_mock, require_real_client, AppState};
use serde::Serialize;

#[derive(Serialize)]
pub struct GridFsFileInfo {
    pub id: String, // Extended-JSON of the file's _id
    pub filename: String,
    pub length: u64,
    pub chunk_size_bytes: u32,
    pub upload_date: String,
    pub content_type: Option<String>,
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

pub async fn download_gridfs_file_impl(
    state: &AppState,
    id: &str,
    database: &str,
    bucket: &str,
    file_id_json: &str,
    dest_path: &str,
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
    let bucket_obj = client.database(database).gridfs_bucket(
        mongodb::options::GridFsBucketOptions::builder()
            .bucket_name(bucket.to_string())
            .build(),
    );
    let mut stream = bucket_obj
        .open_download_stream(file_id)
        .await
        .map_err(|e| format!("Failed to open GridFS download: {}", e))?;

    use futures::AsyncReadExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;
    let mut buf = vec![0u8; GRIDFS_STREAM_BUF];
    let mut total = 0u64;
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
        total += n as u64;
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {}", e))?;
    Ok(total)
}
