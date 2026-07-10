import React from 'react';
import { DatabaseZap, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { type ToolInfoUi, type ToolsStatusUi } from './DumpView';

export type { ToolInfoUi, ToolsStatusUi };

/** A dump folder's on-disk layout, as reported by browsing it. */
export interface DumpTreeUi {
  dbs: { name: string; collections: { name: string; hasMetadata: boolean; gzip: boolean }[] }[];
}

/** One collection to restore, optionally renamed on the way in. */
export interface RestoreSelectionUi {
  db: string;
  coll: string;
  renameTo?: string;
}

/** Full mongorestore option set assembled from the UI state. */
export interface RestoreOptionsUi {
  source: { kind: 'folder'; dir: string } | { kind: 'archive'; file: string };
  gzip: boolean;
  selections: RestoreSelectionUi[]; // folder mode
  filterDb?: string;
  filterColl?: string; // archive mode
  drop: boolean;
  keepIndexVersion: boolean;
  noIndexRestore: boolean;
  noOptionsRestore: boolean;
  maintainInsertionOrder: boolean;
  stopOnError: boolean;
  bypassDocumentValidation: boolean;
  restoreDbUsersAndRoles: boolean;
  oplogReplay: boolean;
}

interface RestoreViewProps {
  connectionName: string;
  tools: ToolsStatusUi | null;
  onOpenSettings?: () => void;
  onInstallTools?: () => void;
  onPickFolder: () => Promise<string | null>;
  onPickArchiveFile: () => Promise<string | null>;
  onBrowseFolder: (path: string) => Promise<DumpTreeUi>;
  onPreviewCommand?: (options: RestoreOptionsUi) => Promise<string>;
  onRunRestore: (options: RestoreOptionsUi) => void | Promise<void>;
  onOpenTasks?: () => void;
}

const checkboxLabelClassName = 'flex cursor-pointer items-center gap-2 text-xs text-foreground';

const PREVIEW_DEBOUNCE_MS = 300;

const collKey = (db: string, coll: string) => `${db}.${coll}`;

const FLAG_FIELDS: {
  key: keyof Pick<
    RestoreOptionsUi,
    | 'drop'
    | 'keepIndexVersion'
    | 'noIndexRestore'
    | 'noOptionsRestore'
    | 'maintainInsertionOrder'
    | 'stopOnError'
    | 'bypassDocumentValidation'
    | 'restoreDbUsersAndRoles'
  >;
  testid: string;
  label: string;
}[] = [
  { key: 'drop', testid: 'restore-opt-drop', label: 'Drop existing collections before restoring' },
  { key: 'keepIndexVersion', testid: 'restore-opt-keepindexversion', label: 'Keep original index version' },
  { key: 'noIndexRestore', testid: 'restore-opt-noindexrestore', label: 'Do not restore indexes' },
  { key: 'noOptionsRestore', testid: 'restore-opt-nooptionsrestore', label: 'Do not restore collection options' },
  {
    key: 'maintainInsertionOrder',
    testid: 'restore-opt-maintaininsertionorder',
    label: 'Maintain document insertion order',
  },
  { key: 'stopOnError', testid: 'restore-opt-stoponerror', label: 'Stop on error' },
  {
    key: 'bypassDocumentValidation',
    testid: 'restore-opt-bypassvalidation',
    label: 'Bypass document validation',
  },
  { key: 'restoreDbUsersAndRoles', testid: 'restore-opt-usersroles', label: 'Restore users and roles' },
];

export const RestoreView: React.FC<RestoreViewProps> = ({
  connectionName,
  tools,
  onOpenSettings,
  onInstallTools,
  onPickFolder,
  onPickArchiveFile,
  onBrowseFolder,
  onPreviewCommand,
  onRunRestore,
  onOpenTasks,
}) => {
  const [sourceKind, setSourceKind] = React.useState<'folder' | 'archive'>('folder');
  const [folderPath, setFolderPath] = React.useState<string | null>(null);
  const [archiveFile, setArchiveFile] = React.useState<string | null>(null);
  const [gzip, setGzip] = React.useState(false);
  const [tree, setTree] = React.useState<DumpTreeUi | null>(null);
  const [checked, setChecked] = React.useState<Record<string, boolean>>({});
  const [renames, setRenames] = React.useState<Record<string, string>>({});
  const [filterDb, setFilterDb] = React.useState('');
  const [filterColl, setFilterColl] = React.useState('');
  const [browseError, setBrowseError] = React.useState<string | null>(null);

  const [drop, setDrop] = React.useState(false);
  const [keepIndexVersion, setKeepIndexVersion] = React.useState(false);
  const [noIndexRestore, setNoIndexRestore] = React.useState(false);
  const [noOptionsRestore, setNoOptionsRestore] = React.useState(false);
  const [maintainInsertionOrder, setMaintainInsertionOrder] = React.useState(false);
  const [stopOnError, setStopOnError] = React.useState(false);
  const [bypassDocumentValidation, setBypassDocumentValidation] = React.useState(false);
  const [restoreDbUsersAndRoles, setRestoreDbUsersAndRoles] = React.useState(false);
  const [oplogReplay, setOplogReplay] = React.useState(false);

  const [showDropConfirm, setShowDropConfirm] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [previewCmd, setPreviewCmd] = React.useState('');
  const previewGen = React.useRef(0);

  const toolMissing = !tools || !tools.mongorestore;

  const allKeys = React.useMemo(
    () =>
      tree
        ? tree.dbs.flatMap((db) => db.collections.map((c) => ({ db: db.name, coll: c.name, key: collKey(db.name, c.name) })))
        : [],
    [tree]
  );

  const anyRename = allKeys.some((k) => (renames[k.key] ?? '').trim() !== '');
  const anyUnchecked = allKeys.some((k) => checked[k.key] === false);

  const narrowingActive =
    sourceKind === 'folder' ? anyUnchecked || anyRename : filterDb.trim() !== '' || filterColl.trim() !== '';

  // Force oplogReplay off whenever narrowing makes it invalid, so the checkbox's
  // disabled state always matches the value that would be sent.
  React.useEffect(() => {
    if (narrowingActive && oplogReplay) setOplogReplay(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrowingActive]);

  const computeSelections = React.useCallback((): RestoreSelectionUi[] => {
    if (sourceKind !== 'folder') return [];
    const checkedKeys = allKeys.filter((k) => checked[k.key] !== false);
    if (checkedKeys.length === allKeys.length && !anyRename) return [];
    return checkedKeys.map((k) => {
      const renameTo = (renames[k.key] ?? '').trim();
      return renameTo ? { db: k.db, coll: k.coll, renameTo } : { db: k.db, coll: k.coll };
    });
  }, [sourceKind, allKeys, checked, renames, anyRename]);

  const buildOptions = React.useCallback((): RestoreOptionsUi => {
    const source =
      sourceKind === 'folder'
        ? ({ kind: 'folder', dir: folderPath ?? '' } as const)
        : ({ kind: 'archive', file: archiveFile ?? '' } as const);
    return {
      source,
      gzip,
      selections: computeSelections(),
      filterDb: sourceKind === 'archive' && filterDb.trim() ? filterDb.trim() : undefined,
      filterColl: sourceKind === 'archive' && filterColl.trim() ? filterColl.trim() : undefined,
      drop,
      keepIndexVersion,
      noIndexRestore,
      noOptionsRestore,
      maintainInsertionOrder,
      stopOnError,
      bypassDocumentValidation,
      restoreDbUsersAndRoles,
      oplogReplay,
    };
  }, [
    sourceKind,
    folderPath,
    archiveFile,
    gzip,
    computeSelections,
    filterDb,
    filterColl,
    drop,
    keepIndexVersion,
    noIndexRestore,
    noOptionsRestore,
    maintainInsertionOrder,
    stopOnError,
    bypassDocumentValidation,
    restoreDbUsersAndRoles,
    oplogReplay,
  ]);

  const hasSource = sourceKind === 'folder' ? folderPath !== null : archiveFile !== null;
  // With every collection unchecked, `selections` would be [] — which the
  // backend reads as "no namespace filter" (restore everything). Require at
  // least one checked collection whenever the browsed tree has any.
  const noneChecked = allKeys.length > 0 && allKeys.every((k) => checked[k.key] === false);
  const canRun =
    hasSource && !toolMissing && (sourceKind !== 'folder' || (tree !== null && !noneChecked));

  React.useEffect(() => {
    if (!hasSource || !onPreviewCommand) {
      previewGen.current++;
      setPreviewCmd('');
      return;
    }
    const options = buildOptions();
    const timer = setTimeout(() => {
      const gen = ++previewGen.current;
      onPreviewCommand(options)
        .then((cmd) => {
          if (gen === previewGen.current) setPreviewCmd(cmd);
        })
        .catch((err) => {
          if (gen === previewGen.current) setPreviewCmd(String(err));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSource, buildOptions]);

  const pickSource = async () => {
    if (sourceKind === 'folder') {
      const path = await onPickFolder();
      if (!path) return;
      setFolderPath(path);
      setBrowseError(null);
      try {
        const dumpTree = await onBrowseFolder(path);
        setTree(dumpTree);
        const initialChecked: Record<string, boolean> = {};
        let anyGzip = false;
        for (const db of dumpTree.dbs) {
          for (const c of db.collections) {
            initialChecked[collKey(db.name, c.name)] = true;
            if (c.gzip) anyGzip = true;
          }
        }
        setChecked(initialChecked);
        setRenames({});
        setGzip(anyGzip);
      } catch (err) {
        // A folder that fails to browse leaves `tree` null; `canRun` requires a
        // non-null tree in folder mode, so a failed browse can't silently arm a
        // restore-everything run (empty `selections`).
        setFolderPath(null);
        setTree(null);
        setBrowseError(err instanceof Error ? err.message : String(err));
      }
    } else {
      const path = await onPickArchiveFile();
      if (!path) return;
      setArchiveFile(path);
      setGzip(/\.gz$/i.test(path));
    }
  };

  const selectSourceKind = (kind: 'folder' | 'archive') => {
    setSourceKind(kind);
    setBrowseError(null);
  };

  const toggleChecked = (key: string) => {
    setChecked((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }));
  };

  const setRenameValue = (key: string, value: string) => {
    setRenames((prev) => ({ ...prev, [key]: value }));
  };

  const dropNamespaces = (): string[] => {
    if (sourceKind === 'folder') {
      const selections = computeSelections();
      if (selections.length > 0) return selections.map((s) => collKey(s.db, s.coll));
      return allKeys.map((k) => k.key);
    }
    if (filterDb.trim()) {
      return [filterColl.trim() ? collKey(filterDb.trim(), filterColl.trim()) : `${filterDb.trim()}.*`];
    }
    return ['(entire archive)'];
  };

  const startRestore = async () => {
    setStarting(true);
    try {
      await onRunRestore(buildOptions());
    } finally {
      setStarting(false);
    }
  };

  const handleRunClick = () => {
    if (!canRun || starting) return;
    if (drop) {
      setShowDropConfirm(true);
      return;
    }
    void startRestore();
  };

  const handleConfirmDrop = () => {
    if (starting) return;
    setShowDropConfirm(false);
    void startRestore();
  };

  const setFlag = (key: (typeof FLAG_FIELDS)[number]['key'], value: boolean) => {
    switch (key) {
      case 'drop':
        setDrop(value);
        if (!value) setShowDropConfirm(false);
        break;
      case 'keepIndexVersion':
        setKeepIndexVersion(value);
        break;
      case 'noIndexRestore':
        setNoIndexRestore(value);
        break;
      case 'noOptionsRestore':
        setNoOptionsRestore(value);
        break;
      case 'maintainInsertionOrder':
        setMaintainInsertionOrder(value);
        break;
      case 'stopOnError':
        setStopOnError(value);
        break;
      case 'bypassDocumentValidation':
        setBypassDocumentValidation(value);
        break;
      case 'restoreDbUsersAndRoles':
        setRestoreDbUsersAndRoles(value);
        break;
    }
  };

  const flagValue: Record<(typeof FLAG_FIELDS)[number]['key'], boolean> = {
    drop,
    keepIndexVersion,
    noIndexRestore,
    noOptionsRestore,
    maintainInsertionOrder,
    stopOnError,
    bypassDocumentValidation,
    restoreDbUsersAndRoles,
  };

  return (
    <div className="flex h-full flex-col overflow-auto" data-testid="restore-view">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-muted/30 px-3.5 py-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <DatabaseZap size={14} />
            <span>Restore</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{connectionName}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenTasks}>
          <ListChecks size={12} />
          View Tasks
        </Button>
      </header>

      <div className="divide-y divide-border">
        <section className="flex flex-col gap-2 px-3.5 py-3">
          {toolMissing ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3"
              data-testid="restore-tools-missing"
            >
              <p className="text-xs text-muted-foreground">
                mongorestore was not found. Configure the MongoDB Database Tools directory in
                Settings.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onOpenSettings}
                  data-testid="restore-open-settings-btn"
                >
                  Open Settings
                </Button>
                {onInstallTools && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onInstallTools}
                    data-testid="restore-install-tools-btn"
                  >
                    Install tools…
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground" data-testid="restore-tools-status">
              mongorestore {tools!.mongorestore!.version} — {tools!.mongorestore!.path}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2 px-3.5 py-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Source</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Restore from a dump folder or a single archive file.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="restore-source-kind"
                data-testid="restore-source-folder"
                checked={sourceKind === 'folder'}
                onChange={() => selectSourceKind('folder')}
              />
              <span>Folder</span>
            </label>
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="restore-source-kind"
                data-testid="restore-source-archive"
                checked={sourceKind === 'archive'}
                onChange={() => selectSourceKind('archive')}
              />
              <span>Archive</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={pickSource}
              data-testid="restore-pick-source-btn"
            >
              {sourceKind === 'folder' ? 'Choose folder…' : 'Choose archive…'}
            </Button>
            {(sourceKind === 'folder' ? folderPath : archiveFile) && (
              <span className="truncate text-xs text-muted-foreground" data-testid="restore-source-path">
                {sourceKind === 'folder' ? folderPath : archiveFile}
              </span>
            )}
          </div>

          {browseError && (
            <p className="text-xs text-destructive" data-testid="restore-browse-error">
              Failed to browse dump folder: {browseError}
            </p>
          )}

          <label className={checkboxLabelClassName}>
            <input
              type="checkbox"
              checked={gzip}
              onChange={() => setGzip((g) => !g)}
              className="rounded border-input"
              data-testid="restore-opt-gzip"
            />
            <span>gzip compressed</span>
          </label>

          {sourceKind === 'folder' && tree && (
            <div className="flex flex-col gap-3 pt-1" data-testid="restore-tree">
              {tree.dbs.map((db) => (
                <div key={db.name} className="flex flex-col gap-1" data-testid={`restore-tree-db-${db.name}`}>
                  <div className="text-xs font-medium text-foreground">{db.name}</div>
                  {db.collections.map((c) => {
                    const key = collKey(db.name, c.name);
                    return (
                      <div key={key} className="flex flex-wrap items-center gap-2 pl-4">
                        <label className={checkboxLabelClassName}>
                          <input
                            type="checkbox"
                            checked={checked[key] !== false}
                            onChange={() => toggleChecked(key)}
                            className="rounded border-input"
                            data-testid={`restore-tree-coll-${key}`}
                          />
                          <span>{c.name}</span>
                        </label>
                        <Input
                          value={renames[key] ?? ''}
                          onChange={(e) => setRenameValue(key, e.target.value)}
                          placeholder="new name (or db.name)"
                          title="A bare name restores into the same database; use db.name to restore into a different database."
                          className="h-7 w-44 text-xs"
                          data-testid={`restore-rename-${key}`}
                        />
                      </div>
                    );
                  })}
                </div>
              ))}
              {noneChecked && (
                <p className="text-xs text-destructive" data-testid="restore-empty-selection-hint">
                  Select at least one collection to restore.
                </p>
              )}
            </div>
          )}

          {sourceKind === 'archive' && (
            <div className="flex flex-col gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Database filter</Label>
                  <Input
                    value={filterDb}
                    onChange={(e) => setFilterDb(e.target.value)}
                    className="h-8 w-40 text-xs"
                    data-testid="restore-archive-filter-db"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Collection filter</Label>
                  <Input
                    value={filterColl}
                    onChange={(e) => setFilterColl(e.target.value)}
                    className="h-8 w-40 text-xs"
                    data-testid="restore-archive-filter-coll"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="restore-archive-note">
                Leave both blank to restore everything in the archive, or filter to a single
                database or namespace.
              </p>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2 px-3.5 py-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Options</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">mongorestore flags.</p>
          </div>
          <div className="flex flex-col gap-2">
            {FLAG_FIELDS.map((f) => (
              <label key={f.key} className={checkboxLabelClassName}>
                <input
                  type="checkbox"
                  checked={flagValue[f.key]}
                  onChange={(e) => setFlag(f.key, e.target.checked)}
                  className="rounded border-input"
                  data-testid={f.testid}
                />
                <span>{f.label}</span>
              </label>
            ))}
            <label
              className={cn(checkboxLabelClassName, narrowingActive && 'cursor-not-allowed opacity-60')}
            >
              <input
                type="checkbox"
                checked={oplogReplay}
                disabled={narrowingActive}
                onChange={(e) => setOplogReplay(e.target.checked)}
                className="rounded border-input"
                data-testid="restore-opt-oplogreplay"
              />
              <span>Replay oplog for point-in-time consistency (full dump only)</span>
            </label>
          </div>
        </section>

        <section className="flex flex-col gap-3 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                <DatabaseZap size={14} />
                <span>Run</span>
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Runs in the background and reports progress in the Tasks tab.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={!canRun || starting}
              onClick={handleRunClick}
              data-testid="restore-run-btn"
            >
              <DatabaseZap size={13} />
              {starting ? 'Starting…' : 'Restore'}
            </Button>
          </div>

          {previewCmd && (
            <code
              data-testid="restore-preview-cmd"
              className="block overflow-x-auto rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
            >
              {previewCmd}
            </code>
          )}

          {showDropConfirm && (
            <div
              className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
              data-testid="restore-drop-confirm"
            >
              <p className="text-xs text-foreground">
                This will drop the following namespace(s) before restoring:
              </p>
              <ul className="list-disc pl-4 text-xs text-muted-foreground">
                {dropNamespaces().map((ns) => (
                  <li key={ns}>{ns}</li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={starting}
                  onClick={handleConfirmDrop}
                  data-testid="restore-drop-confirm-btn"
                >
                  {starting ? 'Starting…' : 'Drop and restore'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowDropConfirm(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>

      <p className="px-3.5 py-3 text-xs text-muted-foreground">
        Restores run in the background. Track their progress in the{' '}
        <button type="button" className="underline hover:text-foreground" onClick={onOpenTasks}>
          Tasks
        </button>{' '}
        tab.
      </p>
    </div>
  );
};
