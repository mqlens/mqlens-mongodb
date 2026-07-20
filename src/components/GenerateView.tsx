import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Wand2, Loader2, AlertCircle } from 'lucide-react';

interface GenerateViewProps {
  connectionId: string;
  database: string;
  /** Absent when opened from a database-row entry — the user picks a target
   * collection before generating (Task 5); this shell shows a starter
   * template in that case rather than calling `infer_generate_template`
   * (which needs a real collection to sample). */
  collection?: string;
}

/**
 * Shown for a database-scoped generate tab (no collection chosen yet) — a
 * small, genuinely-useful starter template rather than an empty editor.
 * Task 5 replaces this whole view with the builder/raw/preview/confirm UI;
 * this shell only needs to be real enough that opening the tab is
 * end-to-end testable (it actually calls `infer_generate_template`).
 */
const STARTER_TEMPLATE = JSON.stringify(
  {
    name: '$name',
    email: '$email',
    createdAt: { $date: { past_days: 365 } },
  },
  null,
  2,
);

/**
 * Minimal #91 shell (Task 4): on mount, if opened with a `collection`, calls
 * `infer_generate_template` and renders the resulting template (or the
 * error); otherwise renders `STARTER_TEMPLATE`. Task 5 fills in the visual
 * builder, raw Monaco toggle, preview pane, and confirm/run flow.
 */
export const GenerateView: React.FC<GenerateViewProps> = ({ connectionId, database, collection }) => {
  const [template, setTemplate] = useState<string | null>(collection ? null : STARTER_TEMPLATE);
  const [loading, setLoading] = useState<boolean>(Boolean(collection));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!collection) {
      setTemplate(STARTER_TEMPLATE);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const result = await invoke<string>('infer_generate_template', {
          id: connectionId,
          database,
          collection,
        });
        if (!cancelled) setTemplate(result);
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, database, collection]);

  return (
    <div className="flex h-full flex-col overflow-auto p-4" data-testid="generate-view">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Wand2 size={14} className="text-primary" />
        <span>Generate Data: {collection ? `${database}.${collection}` : database}</span>
      </div>
      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="generate-loading">
          <Loader2 size={12} className="animate-spin" />
          <span>Loading template…</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive" data-testid="generate-error">
          <AlertCircle size={12} />
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && template && (
        <pre className="rounded-sm border border-border bg-muted/30 p-3 text-xs" data-testid="generate-template">
          {template}
        </pre>
      )}
    </div>
  );
};
