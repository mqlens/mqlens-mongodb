import React from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { DatabaseBackup, ListChecks, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { QueryEditor } from './QueryEditor';

/** Where an installed mongodump/mongorestore binary was found. */
export interface ToolInfoUi {
  path: string;
  version: string;
}

/** Detection result for both Database Tools binaries; null while detecting. */
export interface ToolsStatusUi {
  mongodump: ToolInfoUi | null;
  mongorestore: ToolInfoUi | null;
}

/** What a dump should cover. */
export type DumpScopeUi =
  | { kind: 'server' }
  | { kind: 'db'; db: string }
  | { kind: 'collection'; db: string; coll: string };

/** Options passed to mongodump, mirrored from its CLI flags. */
export interface DumpOptionsUi {
  scope: DumpScopeUi;
  target: { kind: 'folder'; out: string } | { kind: 'archive'; file: string };
  gzip: boolean;
  query?: string;
  forceTableScan: boolean;
  dumpUsersAndRoles: boolean;
  oplog: boolean;
}

interface DumpViewProps {
  connectionName: string;
  databases: { name: string; collections: string[] }[];
  initialScope?: DumpScopeUi;
  tools: ToolsStatusUi | null;
  onOpenSettings?: () => void;
  onInstallTools?: () => void;
  onPickFolder: () => Promise<string | null>;
  onPickArchiveFile: (defaultName: string) => Promise<string | null>;
  onPreviewCommand?: (options: DumpOptionsUi) => Promise<string>;
  onRunDump: (options: DumpOptionsUi) => void | Promise<void>;
  onOpenTasks?: () => void;
}

const selectClassName =
  'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const checkboxLabelClassName = 'flex cursor-pointer items-center gap-2 text-xs text-foreground';

const editorShellClassName =
  'rounded-md border border-input bg-background px-1.5 py-1 shadow-sm focus-within:ring-2 focus-within:ring-ring';

const PREVIEW_DEBOUNCE_MS = 300;

function scopeName(scope: DumpScopeUi, connectionName: string): string {
  if (scope.kind === 'server') return connectionName || 'dump';
  if (scope.kind === 'db') return scope.db || 'dump';
  return `${scope.db}.${scope.coll}`;
}

export const DumpView: React.FC<DumpViewProps> = ({
  connectionName,
  databases,
  initialScope,
  tools,
  onOpenSettings,
  onInstallTools,
  onPickFolder,
  onPickArchiveFile,
  onPreviewCommand,
  onRunDump,
  onOpenTasks,
}) => {
  const { t } = useTranslation('transfer');
  const [scope, setScope] = React.useState<DumpScopeUi>(initialScope ?? { kind: 'server' });
  const [query, setQuery] = React.useState('');
  const [targetKind, setTargetKind] = React.useState<'folder' | 'archive'>('folder');
  const [folderOut, setFolderOut] = React.useState<string | null>(null);
  const [archiveFile, setArchiveFile] = React.useState<string | null>(null);
  const [gzip, setGzip] = React.useState(true);
  const [forceTableScan, setForceTableScan] = React.useState(false);
  const [dumpUsersAndRoles, setDumpUsersAndRoles] = React.useState(false);
  const [oplog, setOplog] = React.useState(false);
  const [previewCmd, setPreviewCmd] = React.useState('');
  const [starting, setStarting] = React.useState(false);
  const previewGen = React.useRef(0);

  // Reset options that only make sense for a specific scope once that scope is left.
  React.useEffect(() => {
    if (scope.kind !== 'db' && dumpUsersAndRoles) setDumpUsersAndRoles(false);
    if (scope.kind !== 'server' && oplog) setOplog(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.kind]);

  const selectScopeKind = (kind: DumpScopeUi['kind']) => {
    if (kind === 'server') {
      setScope({ kind: 'server' });
      return;
    }
    const db = scope.kind === 'server' ? databases[0]?.name ?? '' : scope.db;
    if (kind === 'db') {
      setScope({ kind: 'db', db });
      return;
    }
    const dbEntry = databases.find((d) => d.name === db);
    const coll = dbEntry?.collections[0] ?? '';
    setScope({ kind: 'collection', db, coll });
  };

  const selectDb = (db: string) => {
    if (scope.kind === 'db') {
      setScope({ kind: 'db', db });
    } else if (scope.kind === 'collection') {
      const dbEntry = databases.find((d) => d.name === db);
      const coll = dbEntry?.collections[0] ?? '';
      setScope({ kind: 'collection', db, coll });
    }
  };

  const selectColl = (coll: string) => {
    if (scope.kind === 'collection') setScope({ ...scope, coll });
  };

  const destPath = targetKind === 'folder' ? folderOut : archiveFile;

  const buildOptions = React.useCallback((): DumpOptionsUi => ({
    scope,
    target:
      targetKind === 'folder'
        ? { kind: 'folder', out: folderOut ?? '' }
        : { kind: 'archive', file: archiveFile ?? '' },
    gzip,
    query: scope.kind === 'collection' && query.trim() ? query : undefined,
    forceTableScan,
    dumpUsersAndRoles,
    oplog,
  }), [scope, targetKind, folderOut, archiveFile, gzip, query, forceTableScan, dumpUsersAndRoles, oplog]);

  React.useEffect(() => {
    if (!onPreviewCommand) return;
    // Without a detected mongodump the backend can only answer with an error;
    // invalidate any in-flight request and show nothing instead.
    if (!tools?.mongodump) {
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
  }, [buildOptions, onPreviewCommand, tools]);

  const pickDestination = async () => {
    if (targetKind === 'folder') {
      const path = await onPickFolder();
      if (path) setFolderOut(path);
    } else {
      const defaultName = `${scopeName(scope, connectionName)}.archive${gzip ? '.gz' : ''}`;
      const path = await onPickArchiveFile(defaultName);
      if (path) setArchiveFile(path);
    }
  };

  const scopeReady =
    scope.kind === 'server'
      ? true
      : scope.kind === 'db'
        ? !!scope.db
        : !!scope.db && !!scope.coll;

  // mongodump --query only accepts canonical extended JSON, which is strict
  // JSON — validate here so a bad filter can't arm a run that always fails.
  const queryError = React.useMemo(() => {
    if (scope.kind !== 'collection' || !query.trim()) return null;
    try {
      JSON.parse(query);
      return null;
    } catch {
      return t('dumpView.errors.invalidQueryJson');
    }
  }, [scope.kind, query, t]);

  const canRun = !!tools?.mongodump && destPath !== null && scopeReady && !queryError;

  const runDump = async () => {
    if (!canRun || starting) return;
    setStarting(true);
    try {
      await onRunDump(buildOptions());
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-auto" data-testid="dump-view">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-muted/30 px-3.5 py-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('dumpView.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{connectionName}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenTasks}>
          <ListChecks size={12} />
          {t('dumpView.actions.viewTasks')}
        </Button>
      </header>

      <div className="divide-y divide-border">
        <section className="flex flex-col gap-2 px-3.5 py-3" data-testid="dump-tools-status">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <DatabaseBackup size={14} />
              <span>mongodump</span>
            </h3>
          </div>
          {tools === null ? (
            <p className="text-xs text-muted-foreground">
              {t('dumpView.status.detecting', { tools: 'mongodump / mongorestore' })}
            </p>
          ) : tools.mongodump ? (
            <p className="text-xs text-muted-foreground">
              mongodump {tools.mongodump.version} — {tools.mongodump.path}
            </p>
          ) : (
            <div
              className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border p-3"
              data-testid="dump-tools-missing"
            >
              <p className="text-xs text-muted-foreground">
                {t('dumpView.errors.toolMissing')}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onOpenSettings}>
                  <Settings size={12} />
                  {t('dumpView.actions.openSettings')}
                </Button>
                {onInstallTools && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onInstallTools}
                    data-testid="dump-install-tools-btn"
                  >
                    {t('dumpView.actions.installTools')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2 px-3.5 py-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">{t('dumpView.scope.title')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('dumpView.scope.hint')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="dump-scope-kind"
                data-testid="dump-scope-server"
                checked={scope.kind === 'server'}
                onChange={() => selectScopeKind('server')}
              />
              <span>{t('dumpView.scope.optionServer')}</span>
            </label>
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="dump-scope-kind"
                data-testid="dump-scope-db"
                checked={scope.kind === 'db'}
                onChange={() => selectScopeKind('db')}
              />
              <span>{t('dumpView.scope.optionDatabase')}</span>
            </label>
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="dump-scope-kind"
                data-testid="dump-scope-collection"
                checked={scope.kind === 'collection'}
                onChange={() => selectScopeKind('collection')}
              />
              <span>{t('dumpView.scope.optionCollection')}</span>
            </label>
          </div>

          {scope.kind !== 'server' && (
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-xs text-muted-foreground">{t('dumpView.labels.database')}</Label>
              <select
                value={scope.db}
                onChange={(e) => selectDb(e.target.value)}
                className={cn(selectClassName, 'w-48')}
                data-testid="dump-db-select"
              >
                <option value="" disabled>
                  {t('dumpView.labels.selectDatabase')}
                </option>
                {databases.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>

              {scope.kind === 'collection' && (
                <>
                  <Label className="text-xs text-muted-foreground">{t('dumpView.labels.collection')}</Label>
                  <select
                    value={scope.coll}
                    onChange={(e) => selectColl(e.target.value)}
                    className={cn(selectClassName, 'w-48')}
                    data-testid="dump-coll-select"
                  >
                    <option value="" disabled>
                      {t('dumpView.labels.selectCollection')}
                    </option>
                    {(databases.find((d) => d.name === scope.db)?.collections ?? []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}

          {scope.kind === 'collection' && (
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">{t('dumpView.labels.queryFilter')}</Label>
              <div className={editorShellClassName}>
                <QueryEditor
                  surface="filter"
                  value={query}
                  onChange={setQuery}
                  fields={['_id']}
                  height={80}
                  data-testid="dump-query-input"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('dumpView.hints.queryFilterEjson', {
                  oidExample: '{"$oid": "…"}',
                  dateExample: '{"$date": "…"}',
                })}
              </p>
              {queryError && (
                <p className="text-xs text-destructive" data-testid="dump-query-error">
                  {queryError}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2 px-3.5 py-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">{t('dumpView.destination.title')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('dumpView.destination.hint')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="dump-target-kind"
                data-testid="dump-target-folder"
                checked={targetKind === 'folder'}
                onChange={() => setTargetKind('folder')}
              />
              <span>{t('dumpView.destination.optionFolder')}</span>
            </label>
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="dump-target-kind"
                data-testid="dump-target-archive"
                checked={targetKind === 'archive'}
                onChange={() => setTargetKind('archive')}
              />
              <span>{t('dumpView.destination.optionArchive')}</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={pickDestination}
              data-testid="dump-pick-dest-btn"
            >
              {targetKind === 'folder' ? t('dumpView.actions.chooseFolder') : t('dumpView.actions.chooseFile')}
            </Button>
            {destPath && (
              <span className="truncate text-xs text-muted-foreground" data-testid="dump-dest-path">
                {destPath}
              </span>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-2 px-3.5 py-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">{t('dumpView.options.title')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('dumpView.options.hint')}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label className={checkboxLabelClassName}>
              <input
                type="checkbox"
                checked={gzip}
                onChange={() => setGzip((g) => !g)}
                data-testid="dump-opt-gzip"
              />
              <span>{t('dumpView.options.gzip')}</span>
            </label>
            <label className={checkboxLabelClassName}>
              <input
                type="checkbox"
                checked={forceTableScan}
                onChange={() => setForceTableScan((v) => !v)}
                data-testid="dump-opt-forcetablescan"
              />
              <span>{t('dumpView.options.forceTableScan')}</span>
            </label>
            <label className={cn(checkboxLabelClassName, scope.kind !== 'db' && 'opacity-50')}>
              <input
                type="checkbox"
                checked={dumpUsersAndRoles}
                disabled={scope.kind !== 'db'}
                onChange={() => setDumpUsersAndRoles((v) => !v)}
                data-testid="dump-opt-usersroles"
              />
              <span>{t('dumpView.options.usersAndRoles')}</span>
            </label>
            <label className={cn(checkboxLabelClassName, scope.kind !== 'server' && 'opacity-50')}>
              <input
                type="checkbox"
                checked={oplog}
                disabled={scope.kind !== 'server'}
                onChange={() => setOplog((v) => !v)}
                data-testid="dump-opt-oplog"
              />
              <span>{t('dumpView.options.oplog')}</span>
            </label>
          </div>
        </section>

        <section className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <DatabaseBackup size={14} />
              <span>{t('dumpView.run.title')}</span>
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('dumpView.run.hint')}
            </p>
            <code
              data-testid="dump-preview-cmd"
              className="mt-2 block overflow-x-auto rounded-md bg-muted/30 p-2 text-xs"
            >
              {previewCmd}
            </code>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={!canRun || starting}
            onClick={runDump}
            data-testid="dump-run-btn"
          >
            <DatabaseBackup size={13} />
            {starting ? t('dumpView.actions.starting') : t('dumpView.actions.runDump')}
          </Button>
        </section>
      </div>

      <p className="px-3.5 py-3 text-xs text-muted-foreground">
        <Trans i18nKey="dumpView.footer.backgroundNote" t={t}>
          Dumps run in the background. Track their progress in the{' '}
          <button type="button" className="underline hover:text-foreground" onClick={onOpenTasks}>
            Tasks
          </button>{' '}
          tab.
        </Trans>
      </p>
    </div>
  );
};
