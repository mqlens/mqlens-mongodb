import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Eye, Loader2, AlertCircle } from 'lucide-react';
import type { CollectionInfo } from './Sidebar';

interface CreateViewViewProps {
  connectionId: string;
  databaseName: string;
  /** Called with the new view's name after a successful create. */
  onCreated: (viewName: string) => void;
}

export const CreateViewView: React.FC<CreateViewViewProps> = ({
  connectionId,
  databaseName,
  onCreated,
}) => {
  const [collections, setCollections] = useState<string[]>([]);
  const [loadingColls, setLoadingColls] = useState(true);
  const [viewName, setViewName] = useState('');
  const [source, setSource] = useState('');
  const [pipeline, setPipeline] = useState('[]');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingColls(true);
    (async () => {
      try {
        const list = await invoke<CollectionInfo[]>('list_collections', {
          id: connectionId,
          db: databaseName,
        });
        if (cancelled) return;
        const names = list
          .map((c) => c.name)
          .filter((n) => !n.startsWith('system.'));
        setCollections(names);
        if (names.length > 0) setSource((prev) => prev || names[0]);
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoadingColls(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, databaseName]);

  const handleCreate = async () => {
    setError(null);
    if (!viewName.trim()) {
      setError('View name is required.');
      return;
    }
    if (!source) {
      setError('Select a source collection.');
      return;
    }
    // Validate the pipeline JSON client-side before any backend call.
    try {
      const parsed = JSON.parse(pipeline || '[]');
      if (!Array.isArray(parsed)) {
        setError('Pipeline must be a JSON array of stages.');
        return;
      }
    } catch (e: any) {
      setError(`Invalid pipeline JSON: ${e?.message || 'syntax error'}`);
      return;
    }

    setCreating(true);
    try {
      await invoke('create_view', {
        id: connectionId,
        database: databaseName,
        viewName: viewName.trim(),
        sourceCollection: source,
        pipeline,
      });
      onCreated(viewName.trim());
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-auto" data-testid="create-view">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-color)] text-sm font-semibold text-[var(--text-main)]">
        <Eye size={14} className="text-emerald-500" />
        <span>Create View — {databaseName}</span>
      </div>

      <div className="flex flex-col gap-4 p-4 max-w-[640px]">
        <div className="flex flex-col gap-1.5">
          <span className="mql-label">View Name</span>
          <input
            type="text"
            className="mql-ncd-input"
            data-testid="view-name-input"
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            placeholder="active_premium_customers"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="mql-label">Source Collection</span>
          {loadingColls ? (
            <div className="flex items-center gap-2 text-[var(--text-muted)] text-xs">
              <Loader2 size={13} className="animate-spin" /> Loading collections…
            </div>
          ) : (
            <div className="mql-ncd-select-wrap">
              <select
                className="mql-ncd-select"
                data-testid="view-source-select"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                {collections.length === 0 && <option value="">(no collections)</option>}
                {collections.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="mql-label">Aggregation Pipeline (JSON array)</span>
          <textarea
            className="mql-ncd-input font-mono"
            data-testid="view-pipeline-input"
            rows={8}
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value)}
            placeholder='[{ "$match": { "active": true } }]'
            style={{ resize: 'vertical' }}
          />
        </div>

        {error && (
          <div
            className="flex items-center gap-2 text-rose-400 text-xs font-mono"
            data-testid="view-error"
          >
            <AlertCircle size={13} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div>
          <button
            type="button"
            className="mql-btn mql-btn-primary"
            data-testid="view-create-btn"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Creating…' : 'Create View'}
          </button>
        </div>
      </div>
    </div>
  );
};
