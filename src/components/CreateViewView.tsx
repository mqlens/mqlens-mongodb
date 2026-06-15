import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Eye, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { CollectionInfo } from './Sidebar';

interface CreateViewViewProps {
  connectionId: string;
  databaseName: string;
  /** Called with the new view's name after a successful create. */
  onCreated: (viewName: string) => void;
}

const textareaClassName = cn(
  'flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm transition-colors',
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
);

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
    <div className="flex h-full flex-col overflow-auto" data-testid="create-view">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
        <Eye size={14} className="text-success" />
        <span>Create View — {databaseName}</span>
      </div>

      <div className="flex max-w-[640px] flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="view-name-input">View Name</Label>
          <Input
            id="view-name-input"
            type="text"
            data-testid="view-name-input"
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            placeholder="active_premium_customers"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Source Collection</Label>
          {loadingColls ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" /> Loading collections…
            </div>
          ) : (
            <Select value={source || '__none__'} onValueChange={(v) => setSource(v === '__none__' ? '' : v)}>
              <SelectTrigger data-testid="view-source-select">
                <SelectValue placeholder="(no collections)" />
              </SelectTrigger>
              <SelectContent>
                {collections.length === 0 && (
                  <SelectItem value="__none__" disabled>
                    (no collections)
                  </SelectItem>
                )}
                {collections.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="view-pipeline-input">Aggregation Pipeline (JSON array)</Label>
          <textarea
            id="view-pipeline-input"
            className={textareaClassName}
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
            className="flex items-center gap-2 font-mono text-xs text-destructive"
            data-testid="view-error"
          >
            <AlertCircle size={13} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div>
          <Button
            type="button"
            data-testid="view-create-btn"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Creating…' : 'Create View'}
          </Button>
        </div>
      </div>
    </div>
  );
};
