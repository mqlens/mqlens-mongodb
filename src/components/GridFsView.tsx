import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { HardDrive, Loader2, AlertCircle, Download } from 'lucide-react';
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
      if (!destPath) return; // cancelled
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
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] gap-2 text-sm">
        <Loader2 size={16} className="animate-spin" />
        Loading GridFS files…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="flex items-center gap-2 text-rose-400 text-sm font-mono">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="gridfs-view">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-main)]">
          <HardDrive size={14} className="text-emerald-500" />
          <span>
            GridFS: {databaseName}.{bucket}
          </span>
        </div>
        <span className="text-[11px] text-[var(--text-dim)] font-mono">{files.length} file(s)</span>
      </div>

      {files.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-2 text-sm">
          <HardDrive size={20} />
          No files in this bucket.
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead className="sticky top-0 bg-[var(--bg-sidebar)]">
              <tr className="text-left text-[var(--text-muted)]">
                <th className="px-4 py-2 font-medium">filename</th>
                <th className="px-4 py-2 font-medium">size</th>
                <th className="px-4 py-2 font-medium">uploaded</th>
                <th className="px-4 py-2 font-medium">chunk size</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr
                  key={file.id}
                  className="border-t border-[var(--border-color)] hover:bg-[var(--bg-item-hover)]"
                >
                  <td className="px-4 py-1.5 font-mono text-[var(--text-main)]">{file.filename}</td>
                  <td className="px-4 py-1.5 tabular-nums">{formatBytes(file.length)}</td>
                  <td className="px-4 py-1.5 text-[var(--text-muted)]">
                    {file.upload_date ? file.upload_date.replace('T', ' ').replace(/\..*$/, '') : '—'}
                  </td>
                  <td className="px-4 py-1.5 tabular-nums text-[var(--text-muted)]">
                    {formatBytes(file.chunk_size_bytes)}
                  </td>
                  <td className="px-4 py-1.5">
                    <button
                      type="button"
                      className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-item-hover)] cursor-pointer transition-all"
                      data-testid="gridfs-download-btn"
                      onClick={() => handleDownload(file)}
                    >
                      <Download size={12} />
                      <span>Download</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
