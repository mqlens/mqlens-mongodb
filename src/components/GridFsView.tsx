import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { HardDrive, Loader2, AlertCircle, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatBytes } from '../lib/format';
import { useDialogs } from './dialogs/DialogProvider';

interface GridFsFile {
  id: string;
  filename: string;
  length: number;
  chunk_size_bytes: number;
  upload_date: string;
  content_type?: string | null;
}

interface GridFsViewProps {
  connectionId: string;
  databaseName: string;
  bucket: string;
}

export const GridFsView: React.FC<GridFsViewProps> = ({ connectionId, databaseName, bucket }) => {
  const { toast } = useDialogs();
  const [files, setFiles] = useState<GridFsFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const json = await invoke<string>('list_gridfs_files', {
          id: connectionId,
          database: databaseName,
          bucket,
        });
        if (cancelled) return;
        setFiles(JSON.parse(json) as GridFsFile[]);
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, databaseName, bucket]);

  const handleDownload = async (file: GridFsFile) => {
    try {
      const destPath = await save({ defaultPath: file.filename });
      if (!destPath) return;
      await invoke('download_gridfs_file', {
        id: connectionId,
        database: databaseName,
        bucket,
        fileId: file.id,
        destPath,
      });
      toast(`Downloaded ${file.filename}`, 'success');
    } catch (err: any) {
      toast(`Download failed: ${err?.message || err}`, 'error');
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

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="gridfs-view">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <HardDrive size={14} className="text-success" />
          <span>
            GridFS: {databaseName}.{bucket}
          </span>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">{files.length} file(s)</span>
      </div>

      {files.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <HardDrive size={20} />
          No files in this bucket.
        </div>
      ) : (
        <ScrollArea className="flex-1">
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
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px]"
                      data-testid="gridfs-download-btn"
                      onClick={() => handleDownload(file)}
                    >
                      <Download size={12} />
                      Download
                    </Button>
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
