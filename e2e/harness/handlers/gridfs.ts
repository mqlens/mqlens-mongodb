// GridFS buckets: listing, uploading, downloading and deleting files (#396).
// The backend refuses every GridFS command on the built-in sample server.
import type { Backend, Handler } from '../backend';
import { databaseOf, guardWritable, isMock } from '../lookup';
import { newObjectId } from '../mongo';
import type { E2EState, GridFsFile } from '../state';

/** The most files a listing returns (`MAX_GRIDFS_LIST` in src-tauri/src/limits.rs). */
const MAX_GRIDFS_LIST = 500;

const utf8 = new TextEncoder();

/** Two strings in MongoDB's binary order: by their UTF-8 bytes. */
function compareBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

export function registerGridFsHandlers(backend: Backend, state: E2EState): void {
  const keyOf = (database: unknown, bucket: unknown) => `${String(database)}.${String(bucket)}`;
  const refuseSample = (id: unknown) => {
    if (isMock(state, id)) throw 'GridFS is not supported on mock connections';
  };
  /** The bucket's files on the server the connection reaches; each server keeps its own. */
  const bucketsOf = (id: unknown, database: unknown) => {
    databaseOf(state, id, database);
    return (state.gridfs[state.connections[String(id)].uri] ??= {});
  };
  const bucketFiles = (id: unknown, database: unknown, bucket: unknown): GridFsFile[] =>
    (bucketsOf(id, database)[keyOf(database, bucket)] ??= []);
  const fileIn = (files: GridFsFile[], fileId: unknown): GridFsFile => {
    const file = files.find((candidate) => candidate.id === String(fileId));
    if (!file) throw `File not found: ${String(fileId)}`;
    return file;
  };

  const handlers: Record<string, Handler> = {
    // JSON text with snake_case fields and the id as Extended JSON, as the backend
    // sends it, sorted by filename and capped as its query is.
    list_gridfs_files: ({ id, database, bucket }) => {
      refuseSample(id);
      const files = [...bucketFiles(id, database, bucket)].sort((a, b) => compareBytes(a.filename, b.filename));
      return JSON.stringify(
        files.slice(0, MAX_GRIDFS_LIST).map((file) => ({
          id: file.id,
          filename: file.filename,
          length: file.length,
          chunk_size_bytes: file.chunk_size_bytes,
          upload_date: file.upload_date,
          content_type: file.content_type,
        })),
      );
    },
    upload_gridfs_file: ({ id, database, bucket, sourcePath, filename, contentType }) => {
      guardWritable(state, id);
      refuseSample(id);
      const files = bucketFiles(id, database, bucket);
      const content = state.files[String(sourcePath)];
      if (content === undefined) throw `No such file: ${String(sourcePath)}`;
      const file: GridFsFile = {
        id: JSON.stringify({ $oid: newObjectId() }),
        filename: String(filename),
        length: content.length,
        chunk_size_bytes: 261_120,
        upload_date: new Date().toISOString(),
        content_type: contentType == null ? null : String(contentType),
        content,
      };
      files.push(file);
      return file.id;
    },
    download_gridfs_file: ({ id, database, bucket, fileId, destPath }) => {
      refuseSample(id);
      const file = fileIn(bucketFiles(id, database, bucket), fileId);
      state.writtenFiles[String(destPath)] = file.content;
      return file.length;
    },
    delete_gridfs_file: ({ id, database, bucket, fileId }) => {
      guardWritable(state, id);
      refuseSample(id);
      const file = fileIn(bucketFiles(id, database, bucket), fileId);
      const buckets = bucketsOf(id, database);
      buckets[keyOf(database, bucket)] = buckets[keyOf(database, bucket)].filter((candidate) => candidate !== file);
      return null;
    },
  };

  backend.register(handlers);
}
