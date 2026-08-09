import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
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

// ─── Types ───────────────────────────────────────────────────────────────────

export type CopyRequest =
  | {
      type: 'collection';
      sourceId: string;
      sourceDb: string;
      sourceCollection: string;
      targetId: string;
      targetDb: string;
      targetCollection: string;
      filter?: string;
      includeIndexes: boolean;
      conflictMode: 'skip' | 'merge' | 'overwrite';
    }
  | {
      type: 'collections';
      sourceId: string;
      sourceDb: string;
      collections: string[];
      targetId: string;
      targetDb: string;
      includeIndexes: boolean;
      conflictMode: 'skip' | 'merge' | 'overwrite';
    }
  | {
      type: 'database';
      sourceId: string;
      sourceDb: string;
      targetId: string;
      targetDb: string;
      collections: string[] | null;
      includeIndexes: boolean;
      includeViews: boolean;
      conflictMode: 'skip' | 'merge' | 'overwrite';
    };

export interface PreflightRequest {
  sourceId: string;
  sourceDb: string;
  /** Source collection names — used to flag a true self-overwrite (target lands on a source). */
  sourceCollections: string[];
  targets: { connectionId: string; db: string; collection: string }[];
}

export interface PreflightResult {
  conflicts: { db: string; collection: string; targetExists: boolean; targetDocCount: number }[];
  selfOverwrite: boolean;
}

export interface CopyToDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: {
    connectionId: string;
    db: string;
    collections: string[];
  };
  activeConnections: { id: string; name: string; uri: string }[];
  listDatabases: (connectionId: string) => Promise<string[]>;
  listCollections: (connectionId: string, db: string) => Promise<string[]>;
  preflight: (req: PreflightRequest) => Promise<PreflightResult>;
  onConfirm: (req: CopyRequest) => Promise<void>;
  /** Pre-selected target (e.g. from a "Paste here" action). Falls back to the first connection / source db. */
  presetTargetId?: string;
  presetTargetDb?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const CopyToDialog: React.FC<CopyToDialogProps> = ({
  open,
  onOpenChange,
  source,
  activeConnections,
  listDatabases,
  listCollections,
  preflight,
  onConfirm,
  presetTargetId,
  presetTargetDb,
}) => {
  const { t } = useTranslation('transfer');

  // Derive mode from source.collections.length
  const mode: 'database' | 'collection' | 'collections' =
    source.collections.length === 0
      ? 'database'
      : source.collections.length === 1
      ? 'collection'
      : 'collections';

  // ─── State ─────────────────────────────────────────────────────────────────

  const resolvedDefaultTargetId = presetTargetId || activeConnections[0]?.id || '';

  const [targetId, setTargetId] = useState(resolvedDefaultTargetId);
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbsLoaded, setDbsLoaded] = useState(false);
  const [targetDb, setTargetDb] = useState(presetTargetDb || source.db);
  const [isNewDb, setIsNewDb] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [targetCollection, setTargetCollection] = useState(
    mode === 'collection' ? source.collections[0] : ''
  );
  const [includeIndexes, setIncludeIndexes] = useState(true);
  const [includeViews, setIncludeViews] = useState(true);
  const [filter, setFilter] = useState('');
  const [conflictMode, setConflictMode] = useState<'skip' | 'merge' | 'overwrite'>('merge');
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The actual source collections — known up front for collection(s) mode, fetched
  // for database mode. Used both to build preflight targets and to flag self-overwrite.
  const [sourceCollections, setSourceCollections] = useState<string[]>(
    mode === 'database' ? [] : source.collections
  );

  // ─── Effects ───────────────────────────────────────────────────────────────

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setTargetId(resolvedDefaultTargetId);
      setTargetDb(presetTargetDb || source.db);
      setIsNewDb(false);
      setNewDbName('');
      setTargetCollection(mode === 'collection' ? source.collections[0] : '');
      setIncludeIndexes(true);
      setIncludeViews(true);
      setFilter('');
      setConflictMode('merge');
      setOverwriteConfirmed(false);
      setPreflightResult(null);
      setDbsLoaded(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load databases when targetId changes
  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    setDbsLoaded(false);
    listDatabases(targetId)
      .then((dbs) => {
        if (cancelled) return;
        setDatabases(dbs);
        setDbsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setDatabases([]);
        setDbsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, listDatabases]);

  // Once the target's databases are known, if the chosen name isn't among them
  // (e.g. a pasted/pre-filled db that doesn't exist on this connection), switch
  // to the "new database" input so the name stays visible and will be created.
  useEffect(() => {
    if (!dbsLoaded || isNewDb || !targetDb) return;
    if (!databases.includes(targetDb)) {
      setIsNewDb(true);
      setNewDbName(targetDb);
      setTargetDb('');
    }
  }, [dbsLoaded, databases, isNewDb, targetDb]);

  // Resolve the source collection set: known for collection(s) mode; fetched from
  // the source database for a whole-database copy so preflight checks real targets.
  useEffect(() => {
    if (!open) return;
    if (mode === 'database') {
      let cancelled = false;
      listCollections(source.connectionId, source.db)
        .then((cols) => {
          if (!cancelled) setSourceCollections(cols);
        })
        .catch(() => {
          if (!cancelled) setSourceCollections([]);
        });
      return () => {
        cancelled = true;
      };
    }
    setSourceCollections(source.collections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, source.connectionId, source.db]);

  // Run preflight when target is known
  useEffect(() => {
    const effectiveDb = isNewDb ? newDbName.trim() : targetDb.trim();
    if (!targetId || !effectiveDb) {
      setPreflightResult(null);
      return;
    }

    let cancelled = false;

    // One target per real collection being copied. Database mode uses the fetched
    // source collections so existing target collections surface the conflict UI.
    const targets =
      mode === 'collection'
        ? targetCollection.trim()
          ? [{ connectionId: targetId, db: effectiveDb, collection: targetCollection.trim() }]
          : []
        : (mode === 'collections' ? source.collections : sourceCollections).map((c) => ({
            connectionId: targetId,
            db: effectiveDb,
            collection: c,
          }));

    if (targets.length === 0) {
      setPreflightResult(null);
      return;
    }

    preflight({ sourceId: source.connectionId, sourceDb: source.db, sourceCollections, targets })
      .then((result) => {
        if (!cancelled) setPreflightResult(result);
      })
      .catch(() => {
        if (!cancelled) setPreflightResult(null);
      });

    return () => {
      cancelled = true;
    };
  }, [targetId, targetDb, isNewDb, newDbName, targetCollection, mode, source, sourceCollections, preflight]);

  // ─── Gating logic ──────────────────────────────────────────────────────────

  const effectiveDb = isNewDb ? newDbName.trim() : targetDb.trim();
  const hasConflicts = preflightResult?.conflicts.some((c) => c.targetExists) ?? false;
  const needsOverwriteConfirm = conflictMode === 'overwrite' && hasConflicts;
  const startDisabled =
    !!preflightResult?.selfOverwrite ||
    !targetId ||
    !effectiveDb ||
    (mode === 'collection' && !targetCollection.trim()) ||
    (needsOverwriteConfirm && !overwriteConfirmed) ||
    isSubmitting;

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleTargetIdChange = (val: string) => {
    setTargetId(val);
    setTargetDb(source.db);
    setIsNewDb(false);
    setNewDbName('');
  };

  const handleTargetDbChange = (val: string) => {
    if (val === '__new__') {
      setIsNewDb(true);
      setTargetDb('');
    } else {
      setIsNewDb(false);
      setTargetDb(val);
    }
  };

  const handleStart = async () => {
    if (startDisabled) return;
    setIsSubmitting(true);
    try {
      const db = effectiveDb;
      let req: CopyRequest;
      if (mode === 'collection') {
        req = {
          type: 'collection',
          sourceId: source.connectionId,
          sourceDb: source.db,
          sourceCollection: source.collections[0],
          targetId,
          targetDb: db,
          targetCollection: targetCollection.trim(),
          filter: filter.trim() || undefined,
          includeIndexes,
          conflictMode,
        };
      } else if (mode === 'collections') {
        req = {
          type: 'collections',
          sourceId: source.connectionId,
          sourceDb: source.db,
          collections: source.collections,
          targetId,
          targetDb: db,
          includeIndexes,
          conflictMode,
        };
      } else {
        req = {
          type: 'database',
          sourceId: source.connectionId,
          sourceDb: source.db,
          targetId,
          targetDb: db,
          collections: null,
          includeIndexes,
          includeViews,
          conflictMode,
        };
      }
      await onConfirm(req);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const modeLabel =
    mode === 'collection'
      ? t('copyToDialog.title.collection', { name: source.collections[0] })
      : mode === 'collections'
      ? t('copyToDialog.title.collections', { count: source.collections.length })
      : t('copyToDialog.title.database', { name: source.db });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{modeLabel}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Target connection */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="target-connection">{t('copyToDialog.labels.targetConnection')}</Label>
            <Select value={targetId} onValueChange={handleTargetIdChange}>
              <SelectTrigger id="target-connection">
                <SelectValue placeholder={t('copyToDialog.placeholders.selectConnection')} />
              </SelectTrigger>
              <SelectContent>
                {activeConnections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Target database */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="target-database">{t('copyToDialog.labels.targetDatabase')}</Label>
            {isNewDb ? (
              <>
                <Input
                  id="target-database"
                  placeholder={t('copyToDialog.placeholders.newDatabaseName')}
                  value={newDbName}
                  onChange={(e) => setNewDbName(e.target.value)}
                  autoFocus
                />
                {newDbName.trim() && !databases.includes(newDbName.trim()) && (
                  <p className="text-xs text-muted-foreground">
                    {t('copyToDialog.hints.newDatabaseWillBeCreated')}
                  </p>
                )}
              </>
            ) : (
              <Select value={targetDb} onValueChange={handleTargetDbChange}>
                <SelectTrigger id="target-database">
                  <SelectValue placeholder={t('copyToDialog.placeholders.selectDatabase')} />
                </SelectTrigger>
                <SelectContent>
                  {databases.map((db) => (
                    <SelectItem key={db} value={db}>
                      {db}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">{t('copyToDialog.actions.newDatabase')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Target collection (single-collection mode only) */}
          {mode === 'collection' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="target-collection">{t('copyToDialog.labels.targetCollection')}</Label>
              <Input
                id="target-collection"
                value={targetCollection}
                onChange={(e) => setTargetCollection(e.target.value)}
                placeholder={t('copyToDialog.placeholders.collectionName')}
              />
            </div>
          )}

          {/* Single-collection filter */}
          {mode === 'collection' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-input">{t('copyToDialog.labels.filter')}</Label>
              <Input
                id="filter-input"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder='{"status": "active"}'
              />
            </div>
          )}

          {/* Options */}
          <div className="flex flex-col gap-2">
            <Label>{t('copyToDialog.labels.options')}</Label>
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeIndexes}
                  onChange={(e) => setIncludeIndexes(e.target.checked)}
                  id="include-indexes"
                />
                {t('copyToDialog.labels.includeIndexes')}
              </label>
              {mode === 'database' && (
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={includeViews}
                    onChange={(e) => setIncludeViews(e.target.checked)}
                    id="include-views"
                  />
                  {t('copyToDialog.labels.includeViews')}
                </label>
              )}
            </div>
          </div>

          {/* Conflict resolution — always rendered but only visible when there are conflicts */}
          {hasConflicts && (
            <div className="flex flex-col gap-2">
              <Label>{t('copyToDialog.labels.conflictResolution')}</Label>
              <div className="flex flex-col gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="conflictMode"
                    value="skip"
                    checked={conflictMode === 'skip'}
                    onChange={() => {
                      setConflictMode('skip');
                      setOverwriteConfirmed(false);
                    }}
                  />
                  {t('copyToDialog.labels.conflictModeSkip')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="conflictMode"
                    value="merge"
                    checked={conflictMode === 'merge'}
                    onChange={() => {
                      setConflictMode('merge');
                      setOverwriteConfirmed(false);
                    }}
                  />
                  {t('copyToDialog.labels.conflictModeMerge')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="conflictMode"
                    id="conflict-overwrite"
                    value="overwrite"
                    checked={conflictMode === 'overwrite'}
                    onChange={() => {
                      setConflictMode('overwrite');
                      setOverwriteConfirmed(false);
                    }}
                  />
                  {t('copyToDialog.labels.conflictModeOverwrite')}
                </label>
              </div>

              {/* Destructive confirm — shown when Overwrite selected */}
              {conflictMode === 'overwrite' && (
                <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm text-destructive">
                  <input
                    type="checkbox"
                    id="overwrite-confirm"
                    checked={overwriteConfirmed}
                    onChange={(e) => setOverwriteConfirmed(e.target.checked)}
                  />
                  {t('copyToDialog.labels.overwriteConfirm')}
                </label>
              )}
            </div>
          )}

          {/* Self-overwrite warning */}
          {preflightResult?.selfOverwrite && (
            <p className="text-sm text-destructive">
              {t('copyToDialog.errors.selfOverwrite')}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('copyToDialog.actions.cancel')}
          </Button>
          <Button onClick={handleStart} disabled={startDisabled}>
            {t('copyToDialog.actions.startCopy')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
