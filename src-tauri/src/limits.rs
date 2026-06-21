//! Hard caps to keep query results and bulk operations out of unbounded RAM.

/// Default page size when the client sends limit <= 0.
pub const DEFAULT_QUERY_LIMIT: i64 = 100;
/// Maximum documents returned per find query (also caps mock queries).
pub const MAX_QUERY_LIMIT: i64 = 1_000;
/// Maximum aggregation output documents buffered in memory.
pub const MAX_AGGREGATE_RESULTS: usize = 1_000;
/// Documents per insert_many / $in duplicate-check batch.
pub const IMPORT_BATCH_SIZE: usize = 500;
/// Maximum documents accepted in a single import IPC payload.
pub const MAX_IMPORT_DOCS: usize = 10_000;
/// GridFS download read buffer (stream to disk, never load whole file).
pub const GRIDFS_STREAM_BUF: usize = 64 * 1024;
/// Maximum GridFS file metadata entries listed at once.
pub const MAX_GRIDFS_LIST: i64 = 500;
/// Maximum single-file GridFS upload size (streamed; not loaded whole-file into RAM).
pub const MAX_GRIDFS_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// Maximum documents sampled for schema inference.
pub const MAX_SCHEMA_SAMPLE: i64 = 1_000;
/// Mongosh output caps per command.
pub const MAX_MONGOSH_LINES: usize = 2_000;
pub const MAX_MONGOSH_LINE_CHARS: usize = 8_192;
pub const MAX_MONGOSH_TOTAL_CHARS: usize = 512 * 1024;
/// Finished export tasks kept in memory before manual clear.
pub const MAX_TASK_HISTORY: usize = 50;
/// Rebuild the process tree for resource monitoring at most this often.
pub const RESOURCE_TREE_REFRESH_SECS: u64 = 10;

pub fn normalize_query_limit(limit: i64) -> i64 {
    if limit <= 0 {
        DEFAULT_QUERY_LIMIT
    } else {
        limit.min(MAX_QUERY_LIMIT)
    }
}

pub fn normalize_schema_sample(sample_size: i64) -> i64 {
    if sample_size <= 0 {
        100
    } else {
        sample_size.min(MAX_SCHEMA_SAMPLE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_limit_defaults_and_caps() {
        assert_eq!(normalize_query_limit(0), DEFAULT_QUERY_LIMIT);
        assert_eq!(normalize_query_limit(-5), DEFAULT_QUERY_LIMIT);
        assert_eq!(normalize_query_limit(50), 50);
        assert_eq!(normalize_query_limit(9999), MAX_QUERY_LIMIT);
    }
}
