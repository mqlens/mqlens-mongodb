// GridFS buckets: listing, uploading, downloading and deleting files (#396).
import type { Backend, Handler } from '../backend';
import { databaseOf } from '../lookup';
import { newObjectId } from '../mongo';
import type { E2EState, GridFsFile } from '../state';

export function registerGridFsHandlers(backend: Backend, state: E2EState): void {
  const keyOf = (database: unknown, bucket: unknown) => `${String(database)}.${String(bucket)}`;
  const bucketFiles = (id: unknown, database: unknown, bucket: unknown): GridFsFile[] => {
    databaseOf(state, id, database);
    return (state.gridfs[keyOf(database, bucket)] ??= []);
  };
  const fileIn = (files: GridFsFile[], fileId: unknown): GridFsFile => {
    const file = files.find((candidate) => candidate.id === String(fileId));
    if (!file) throw `File not found: ${String(fileId)}`;
    return file;
  };

  const handlers: Record<string, Handler> = {
    // JSON text with snake_case fields and the id as Extended JSON, as the backend sends it.
    list_gridfs_files: ({ id, database, bucket }) =>
      JSON.stringify(
        bucketFiles(id, database, bucket).map((file) => ({
          id: file.id,
          filename: file.filename,
          length: file.length,
          chunk_size_bytes: file.chunk_size_bytes,
          upload_date: file.upload_date,
          content_type: file.content_type,
        })),
      ),
    upload_gridfs_file: ({ id, database, bucket, sourcePath, filename, contentType }) => {
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
      const file = fileIn(bucketFiles(id, database, bucket), fileId);
      state.writtenFiles[String(destPath)] = file.content;
      return file.length;
    },
    delete_gridfs_file: ({ id, database, bucket, fileId }) => {
      const files = bucketFiles(id, database, bucket);
      const file = fileIn(files, fileId);
      state.gridfs[keyOf(database, bucket)] = files.filter((candidate) => candidate !== file);
      return null;
    },
  };

  backend.register(handlers);
}
