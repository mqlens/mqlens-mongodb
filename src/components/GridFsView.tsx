import React, { useCallback, useEffect, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { HardDrive, Loader2, AlertCircle, Download, Upload, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatBytes } from '../lib/format';
import { gridfsMetadataForUpload, validateGridfsMetadataJson } from '../lib/gridfsUpload';
import { useDialogs } from './dialogs/DialogProvider';

interface GridFsFile {
  id: string;
  filename: string;
  length: number;
  chunk_size_bytes: number;
  upload_date: string;
  content_type?: string | null;
}

interface GridFsTransferProgress {
  transferred: number;
  total: number;
}

interface GridFsViewProps {
  connectionId: string;
  databaseName: string;
  bucket: string;
  onNamespaceMutated?: () => void;
}

type TransferState = {
  kind: 'upload' | 'download';
  label: string;
  transferred: number;
  total: number;
} | null;

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export const GridFsView: React.FC<GridFsViewProps> = ({
  connectionId,
  databaseName,
  bucket,
  onNamespaceMutated = () => {},
}) => {
  const { toast, confirm, prompt, choose } = useDialogs();
  const [files, setFiles] = useState<GridFsFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferState>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await invoke<string>('list_gridfs_files', {
        id: connectionId,
        database: databaseName,
        bucket,
      });
      setFiles(JSON.parse(json) as GridFsFile[]);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, databaseName, bucket]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const makeProgressChannel = (kind: 'upload' | 'download', label: string) => {
    const channel = new Channel<GridFsTransferProgress>();
    channel.onmessage = (update) => {
      setTransfer({
        kind,
        label,
        transferred: update.transferred,
        total: update.total,
      });
    };
    return channel;
  };

  const resolveUploadMetadata = async (batchLabel: string): Promise<string | null> => {
    const choice = await choose({
      title: 'GridFS metadata',
      message: `${batchLabel}: add optional metadata?`,
      choices: [
        { value: 'skip', label: 'Skip metadata' },
        { value: 'add', label: 'Add metadata JSON' },
      ],
    });
    if (choice !== 'add') return null;

    const raw = await prompt({
      title: 'GridFS metadata',
      message: 'Metadata JSON object (stored on the file document):',
      defaultValue: '{\n  \n}',
      multiline: true,
      validate: validateGridfsMetadataJson,
    });
    if (raw === null) return null;
    return gridfsMetadataForUpload(raw);
  };

  const resolveUploadFilename = async (
    sourcePath: string,
    index: number,
    total: number,
  ): Promise<string | null> => {
    const defaultName = basename(sourcePath);
    const title = total > 1 ? `Upload file ${index + 1} of ${total}` : 'Upload to GridFS';
    const message =
      total > 1
        ? `Filename in the bucket for ${defaultName}:`
        : 'Filename in the bucket:';
    return prompt({
      title,
      message,
      defaultValue: defaultName,
      validate: (v) => (v.trim() ? null : 'Filename is required'),
    });
  };

  const uploadPaths = async (paths: string[]) => {
    if (paths.length === 0 || transfer) return;

    const planned: { sourcePath: string; filename: string }[] = [];
    for (let i = 0; i < paths.length; i += 1) {
      const sourcePath = paths[i];
      const filename = await resolveUploadFilename(sourcePath, i, paths.length);
      if (!filename?.trim()) return;
      planned.push({ sourcePath, filename: filename.trim() });
    }

    const metadataJson = await resolveUploadMetadata(
      paths.length > 1 ? 'These files' : 'This file',
    );

    let uploadedAny = false;
    const failed: string[] = [];
    for (const { sourcePath, filename } of planned) {
      const channel = makeProgressChannel('upload', filename);
      try {
        await invoke('upload_gridfs_file', {
          id: connectionId,
          database: databaseName,
          bucket,
          sourcePath,
          filename,
          metadataJson,
          contentType: null,
          onProgress: channel,
        });
        uploadedAny = true;
        toast(`Uploaded ${filename}`, 'success');
      } catch (err: any) {
        // Don't abort the batch — keep uploading the remaining files and
        // report which ones failed at the end.
        failed.push(filename);
        toast(`Upload failed for ${filename}: ${err?.message || err}`, 'error');
      } finally {
        setTransfer(null);
      }
    }
    if (failed.length > 1) {
      toast(`${failed.length} files failed to upload.`, 'error');
    }
    await loadFiles();
    if (uploadedAny) {
      onNamespaceMutated();
    }
  };

  const handleUploadClick = async () => {
    try {
      const selected = await open({ multiple: true });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await uploadPaths(paths.filter((p): p is string => typeof p === 'string'));
    } catch (err: any) {
      toast(`Upload failed: ${err?.message || err}`, 'error');
    }
  };

  const handleDownload = async (file: GridFsFile) => {
    if (transfer) return;
    try {
      const destPath = await save({ defaultPath: file.filename });
      if (!destPath) return;
      const channel = makeProgressChannel('download', file.filename);
      try {
        await invoke('download_gridfs_file', {
          id: connectionId,
          database: databaseName,
          bucket,
          fileId: file.id,
          destPath,
          totalBytes: file.length,
          onProgress: channel,
        });
        toast(`Downloaded ${file.filename}`, 'success');
      } finally {
        setTransfer(null);
      }
    } catch (err: any) {
      toast(`Download failed: ${err?.message || err}`, 'error');
      setTransfer(null);
    }
  };

  const handleDelete = async (file: GridFsFile) => {
    if (transfer) return;
    if (
      !(await confirm({
        title: 'Delete GridFS file',
        message: `Delete "${file.filename}" from ${databaseName}.${bucket}? This cannot be undone.`,
        confirmLabel: 'Delete',
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await invoke('delete_gridfs_file', {
        id: connectionId,
        database: databaseName,
        bucket,
        fileId: file.id,
      });
      toast(`Deleted ${file.filename}`, 'success');
      await loadFiles();
      onNamespaceMutated();
    } catch (err: any) {
      toast(`Delete failed: ${err?.message || err}`, 'error');
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        Loading GridFS files…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex items-center gap-2 font-mono text-sm text-destructive">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  const transferPct =
    transfer && transfer.total > 0
      ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100))
      : null;

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-testid="gridfs-view">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <HardDrive size={14} className="text-success" />
          <span>
            GridFS: {databaseName}.{bucket}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{files.length} file(s)</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            data-testid="gridfs-upload-btn"
            disabled={!!transfer}
            onClick={() => void handleUploadClick()}
          >
            <Upload size={12} />
            Upload
          </Button>
        </div>
      </div>

      {transfer && (
        <div className="border-b border-border bg-muted/30 px-4 py-2" data-testid="gridfs-transfer-progress">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {transfer.kind === 'upload' ? 'Uploading' : 'Downloading'} {transfer.label}
            </span>
            <span className="font-mono tabular-nums">
              {formatBytes(transfer.transferred)}
              {transfer.total > 0 ? ` / ${formatBytes(transfer.total)}` : ''}
              {transferPct !== null ? ` (${transferPct}%)` : ''}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width] duration-150 ease-out"
              style={{ width: `${transferPct ?? (transfer.transferred > 0 ? 8 : 0)}%` }}
            />
          </div>
        </div>
      )}

      {files.length === 0 ? (
        <div
          className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground"
          data-testid="gridfs-empty-state"
        >
          <HardDrive size={20} />
          <span>No files in this bucket.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!!transfer}
            onClick={() => void handleUploadClick()}
          >
            <Upload size={12} />
            Upload files
          </Button>
        </div>
      ) : (
        <ScrollArea className="relative flex-1">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
              <tr className="text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">filename</th>
                <th className="px-4 py-2 font-medium">size</th>
                <th className="px-4 py-2 font-medium">uploaded</th>
                <th className="px-4 py-2 font-medium">chunk size</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr
                  key={file.id}
                  className="border-t border-border hover:bg-accent/50"
                >
                  <td className="px-4 py-1.5 font-mono text-foreground">{file.filename}</td>
                  <td className="px-4 py-1.5 tabular-nums">{formatBytes(file.length)}</td>
                  <td className="px-4 py-1.5 text-muted-foreground">
                    {file.upload_date ? file.upload_date.replace('T', ' ').replace(/\..*$/, '') : '—'}
                  </td>
                  <td className="px-4 py-1.5 tabular-nums text-muted-foreground">
                    {formatBytes(file.chunk_size_bytes)}
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px]"
                        data-testid="gridfs-download-btn"
                        disabled={!!transfer}
                        onClick={() => void handleDownload(file)}
                      >
                        <Download size={12} />
                        Download
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px] text-destructive hover:text-destructive"
                        data-testid="gridfs-delete-btn"
                        disabled={!!transfer}
                        onClick={() => void handleDelete(file)}
                      >
                        <Trash2 size={12} />
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}
    </div>
  );
};
