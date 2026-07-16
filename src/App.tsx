import React, { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { StatusBar } from '@/components/layout/StatusBar';
import { Toaster } from '@/components/ui/sonner';
import { useTheme } from '@/hooks/use-theme';
import { Sidebar } from './components/Sidebar';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { DocumentViewer, builderStateFromQueryTab, type BuilderState } from './components/DocumentViewer';
import { DataGrid } from './components/DataGrid';
import { ConnectionManager } from './components/ConnectionManager';
import { SettingsView, type SettingsTabId, MONGO_TOOLS_DIR_KEY } from './components/SettingsModal';
import { IndexViewer } from './components/IndexViewer';
import { IndexModal } from './components/IndexModal';
import { MongoShell } from './components/MongoShell';
import { ToolSetupDialog, type ManagedToolStatusUi, type InstallTaskUi } from './components/ToolSetupDialog';
import { QuickStart } from './components/QuickStart';
import { DocumentEditModal } from './components/DocumentEditModal';
import {
  ExportView,
  DEFAULT_EXPORT_OPTIONS,
  type ExportFormat,
  type ExportOptions,
  type FilteredExportSeed,
  type FilteredExportQuery,
} from './components/ExportView';
import { ImportView, type ImportPreviewData } from './components/ImportView';
import {
  DumpView,
  type ToolsStatusUi,
  type DumpScopeUi,
  type DumpOptionsUi,
} from './components/DumpView';
import {
  RestoreView,
  type DumpTreeUi,
  type RestoreOptionsUi,
} from './components/RestoreView';
import { CopyToDialog } from './components/CopyToDialog';
import { SchemaView } from './components/SchemaView';
import { workspaceReducer, createInitialLayout, findPane, allPanes, allTabIds, type WorkspaceAction } from './workspace/model';
import { WorkspaceRoot } from './workspace/WorkspaceRoot';
import { CreateViewView } from './components/CreateViewView';
import { ValidationRulesView } from './components/ValidationRulesView';
import { GridFsView } from './components/GridFsView';
import { MonitoringView } from './components/MonitoringView';
import { UserManagementView } from './components/UserManagementView';
import { TaskManager, type ExportTaskInfo } from './components/TaskManager';
import { VaultGate } from './components/VaultGate';
import { UpdatePrompt } from './components/UpdatePrompt';
import { DialogProvider, useDialogs } from './components/dialogs/DialogProvider';
import { formatBytes } from './lib/format';
import type { QueryCodeSpec } from './lib/queryCodeGen';
import type { IndexSuggestion } from './lib/indexSuggestions';
import { docToShell } from './lib/shellDoc';
import { recordHistory, loadCollectionQueries, type SavedQueryBody } from './lib/queryStore';
import { clearNamespaceIndex, loadNamespaceIndex, matchesNamespaceScope } from './lib/paletteIndex';
import { CHECK_UPDATE_EVENT } from './components/UpdatePrompt';
import type { ConnectionProfile } from './lib/connection';
import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { Button } from '@/components/ui/button';
import { FolderCode, KeyRound, Play, Settings, Terminal, Rocket, Download, Upload, Table2, Eye, HardDrive, Activity, Copy, Users, ListChecks, DatabaseBackup, DatabaseZap, ShieldCheck } from 'lucide-react';
import logoMark from './assets/logo-mark.svg';

interface QueryTab {
  id: string;
  type: 'collection' | 'index' | 'shell' | 'settings' | 'quickstart' | 'export' | 'import' | 'tasks' | 'schema' | 'create-view' | 'gridfs' | 'monitoring' | 'users' | 'dump' | 'restore' | 'validation';
  connectionId: string;
  db: string;
  collection: string;
  indexName?: string;
  initialShellCommand?: string;
  exportSourceTabId?: string;
  results: any[];
  loading: boolean;
  error: string | null;
  explainResult: string | null;
  // Last executed query for this tab, so writes can refresh with the same view.
  lastQuery?: { filter: string; sort: string; projection: string; limit: number; skip: number };
  // Last executed aggregation pipeline, so an aggregate view refreshes as an aggregate.
  lastAggregate?: Record<string, unknown>[];
  // Pagination count state.
  totalCount?: number;
  countLoading?: boolean;
  estimated?: boolean;
}

const DEFAULT_QUERY = { filter: '{}', sort: '{}', projection: '{}', limit: 50, skip: 0 };

const isEmptyFilter = (s: string): boolean => {
  const t = (s || '').trim();
  return t === '' || t === '{}';
};

/** The configured MongoDB Database Tools directory (mongodump/mongorestore); '' means unset (use PATH). */
const getMongoToolsDir = (): string => {
  try {
    return localStorage.getItem(MONGO_TOOLS_DIR_KEY) || '';
  } catch {
    return '';
  }
};

// Describe whatever a tab last executed, for the DataGrid "Query Code" tab
// (rendered there as runnable driver code per language). Null before any run.
const buildTabQuerySpec = (tab: QueryTab): QueryCodeSpec | null => {
  const parse = (s: string): unknown => {
    try {
      return s.trim() ? JSON.parse(s) : {};
    } catch {
      return {};
    }
  };
  if (tab.lastAggregate) {
    return {
      db: tab.db,
      collection: tab.collection,
      query: { queryType: 'aggregate', pipeline: tab.lastAggregate },
    };
  }
  if (tab.lastQuery) {
    const q = tab.lastQuery;
    return {
      db: tab.db,
      collection: tab.collection,
      query: {
        queryType: 'find',
        filter: parse(q.filter),
        sort: parse(q.sort),
        projection: parse(q.projection),
        limit: q.limit,
        skip: q.skip,
      },
    };
  }
  return null;
};

interface ActiveConnection {
  id: string;
  profileId: string;
  name: string;
  uri: string;
  color_tag?: string;
}

/** Extract the auth username from a MongoDB connection URI; '' when there are no credentials. */
function usernameFromUri(uri: string): string {
  try {
    const { username } = new URL(uri);
    return username ? decodeURIComponent(username) : '';
  } catch {
    return '';
  }
}

const QUICK_START_TAB_ID = 'quickstart';

const createQuickStartTab = (): QueryTab => ({
  id: QUICK_START_TAB_ID,
  type: 'quickstart',
  connectionId: '',
  db: '',
  collection: '',
  results: [],
  loading: false,
  error: null,
  explainResult: null,
});

const TASKS_TAB_ID = 'tasks';

const createTasksTab = (): QueryTab => ({
  id: TASKS_TAB_ID,
  type: 'tasks',
  connectionId: '',
  db: '',
  collection: '',
  results: [],
  loading: false,
  error: null,
  explainResult: null,
});

const tabIconFor = (tab: QueryTab, isActive: boolean): React.ReactNode => {
  const className = isActive ? 'text-primary' : 'text-muted-foreground';
  const size = 11;
  switch (tab.type) {
    case 'index':
      return <KeyRound size={size} className={className} />;
    case 'shell':
      return <Terminal size={size} className={className} />;
    case 'settings':
      return <Settings size={size} className={className} />;
    case 'quickstart':
      return <Rocket size={size} className={className} />;
    case 'export':
      return <Download size={size} className={className} />;
    case 'import':
      return <Upload size={size} className={className} />;
    case 'tasks':
      return <ListChecks size={size} className={className} />;
    case 'schema':
      return <Table2 size={size} className={className} />;
    case 'create-view':
      return <Eye size={size} className={className} />;
    case 'gridfs':
      return <HardDrive size={size} className={className} />;
    case 'monitoring':
      return <Activity size={size} className={className} />;
    case 'users':
      return <Users size={size} className={className} />;
    case 'dump':
      return <DatabaseBackup size={size} className={className} />;
    case 'restore':
      return <DatabaseZap size={size} className={className} />;
    case 'validation':
      return <ShieldCheck size={size} className={className} />;
    default:
      return <FolderCode size={size} className={className} />;
  }
};

const tabLabelFor = (
  tab: QueryTab,
  connectionName: (connectionId: string) => string
): string => {
  switch (tab.type) {
    case 'index':
      return `${tab.collection}.${tab.indexName}`;
    case 'shell':
      return `mongosh: ${tab.collection || tab.db}`;
    case 'settings':
      return 'Settings';
    case 'quickstart':
      return 'Quick Start';
    case 'export':
      return `Export: ${tab.collection}`;
    case 'import':
      return `Import: ${tab.collection}`;
    case 'tasks':
      return 'Tasks';
    case 'schema':
      return `Schema: ${tab.collection}`;
    case 'create-view':
      return `New View: ${tab.db}`;
    case 'gridfs':
      return `GridFS: ${tab.collection}`;
    case 'monitoring':
      return `Monitor: ${connectionName(tab.connectionId)}`;
    case 'users':
      return `Users: ${connectionName(tab.connectionId)}`;
    case 'dump':
      return `Dump: ${tab.db || connectionName(tab.connectionId)}`;
    case 'restore':
      return `Restore: ${connectionName(tab.connectionId)}`;
    case 'validation':
      return `Validation: ${tab.collection}`;
    default:
      return tab.collection;
  }
};

function Workspace() {
  const { toast, confirm, prompt } = useDialogs();
  const { config, resolvedMode, setMode, setSpacingDensity, resetZoom } = useTheme();
  const density = config.spacingDensity;
  // Open the Quick Start tab by default so the app never starts on a blank canvas.
  const [tabs, setTabs] = useState<QueryTab[]>([createQuickStartTab()]);
  const [layout, dispatchLayout] = useReducer(
    workspaceReducer,
    undefined,
    () => createInitialLayout([QUICK_START_TAB_ID], QUICK_START_TAB_ID),
  );
  const focusedPane = findPane(layout.root, layout.focusedPaneId);
  const activeTabId = focusedPane?.activeTabId ?? null;
  if (import.meta.env.DEV) {
    const known = new Set(tabs.map(t => t.id));
    for (const id of allTabIds(layout)) {
      if (!known.has(id)) console.error(`workspace layout references unknown tab: ${id}`);
    }
  }
  const tabBuilderStateCache = useRef(new Map<string, BuilderState>());
  const handleBuilderStateChange = useCallback((tabId: string, state: BuilderState) => {
    tabBuilderStateCache.current.set(tabId, state);
  }, []);
  const [activeConnections, setActiveConnections] = useState<ActiveConnection[]>([]);
  const [profilesRefreshKey, setProfilesRefreshKey] = useState(0);
  const [isConnectionModalOpen, setIsConnectionModalOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTabId | undefined>();

  const addActiveConnection = (
    id: string,
    name: string,
    uri: string,
    profileId: string,
    color_tag?: string
  ) => {
    setActiveConnections((prev) =>
      prev.some((c) => c.profileId === profileId)
        ? prev
        : [...prev, { id, profileId, name, uri, color_tag }]
    );
  };

  const handleQuickConnect = async (profile: ConnectionProfile): Promise<string | null> => {
    const existing = activeConnections.find(
      (c) => c.profileId === profile.id || c.name === profile.name,
    );
    if (existing) return existing.id;
    try {
      const id = await invoke<string>('connect_db', { uri: profile.uri, ssh: profile.ssh ?? null });
      addActiveConnection(id, profile.name, profile.uri, profile.id, profile.color_tag ?? undefined);
      return id;
    } catch (e) {
      toast(`Could not connect to ${profile.name}: ${(e as any)?.message || String(e)}`, 'error');
      return null;
    }
  };

  const handleLoadSampleData = async () => {
    const SAMPLE_ID = '__sample__';
    if (activeConnections.some((c) => c.profileId === SAMPLE_ID)) return;
    try {
      const id = await invoke<string>('connect_db', { uri: 'mongodb://mock', ssh: null });
      addActiveConnection(id, 'Sample (mqlens_demo)', 'mongodb://mock', SAMPLE_ID);
    } catch (e) {
      toast(`Could not load sample data: ${(e as any)?.message || String(e)}`, 'error');
    }
  };
  const [isIndexModalOpen, setIsIndexModalOpen] = useState(false);
  const [indexModalTarget, setIndexModalTarget] = useState<{
    connectionId: string;
    db: string;
    collection: string;
    initialData?: {
      name: string;
      keys: Record<string, number>;
      unique: boolean;
      sparse: boolean;
    } | null;
    prefill?: {
      name: string;
      keys: Record<string, number>;
    } | null;
  } | null>(null);
  const [indexMutationTrigger, setIndexMutationTrigger] = useState(0);
  const [collectionMutationTrigger, setCollectionMutationTrigger] = useState(0);
  const [sidebarFilterQuery, setSidebarFilterQuery] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [isResizing, setIsResizing] = useState(false);

  const startResizing = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    setIsResizing(true);
  };

  const toggleTheme = () => {
    setMode(resolvedMode === 'dark' ? 'light' : 'dark');
  };

  // Poll this process's CPU + memory for the status bar.
  const [resUsage, setResUsage] = useState<{ cpu_percent: number; memory_bytes: number } | null>(null);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const usage = await invoke<{ cpu_percent: number; memory_bytes: number }>('get_resource_usage');
        if (active && usage && typeof usage.cpu_percent === 'number') setResUsage(usage);
      } catch {
        /* ignore — keep last reading */
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // App + connected MongoDB versions for the status bar.
  const [appVersion, setAppVersion] = useState('');
  const [mongoVersion, setMongoVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  const [exportTasks, setExportTasks] = useState<ExportTaskInfo[]>([]);
  // Import tasks started from the Import tab, keyed by task id, so the poll
  // below can refresh the source collection tab once the task completes.
  // TaskInfo has no connection/db/collection fields, so we track them here
  // at the point the task is started instead of trying to recover them later.
  const pendingImportRefreshRef = React.useRef(
    new Map<string, { connectionId: string; db: string; collection: string }>()
  );
  // Bumped on every optimistic task insert below. A list_export_tasks response
  // requested BEFORE a start_*_task registered could otherwise resolve AFTER the
  // optimistic insert and clobber it for a whole poll cycle — so a load only
  // applies when no insert happened since it started (the next poll is ≤1s away).
  const exportTasksSeqRef = React.useRef(0);
  const loadExportTasks = React.useCallback(async () => {
    const seq = exportTasksSeqRef.current;
    try {
      const tasks = await invoke<ExportTaskInfo[]>('list_export_tasks');
      if (exportTasksSeqRef.current === seq) setExportTasks(tasks);
    } catch {
      /* ignore — task polling should not interrupt the main workspace */
    }
  }, []);
  // Optimistically surface freshly-started tasks ahead of the next poll.
  const insertExportTasks = React.useCallback((tasks: ExportTaskInfo[]) => {
    exportTasksSeqRef.current += 1;
    setExportTasks((prev) => [...tasks, ...prev.filter((t) => !tasks.some((n) => n.id === t.id))]);
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!active) return;
      await loadExportTasks();
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [loadExportTasks]);

  const handleClearFinishedTasks = async () => {
    try {
      const tasks = await invoke<ExportTaskInfo[]>('clear_finished_export_tasks');
      setExportTasks(tasks);
    } catch {
      /* ignore */
    }
  };

  type CopySource = { connectionId: string; db: string; collections: string[] };
  const [copyDialog, setCopyDialog] = useState<
    { source: CopySource; target?: { connectionId: string; db?: string } } | null
  >(null);
  // In-app clipboard for the Copy → Paste-here flow.
  const [copyClipboard, setCopyClipboard] = useState<CopySource | null>(null);

  // Destination to refresh in the sidebar after a copy starts (and periodically
  // while it runs), so newly-copied databases/collections show up live.
  const [copyRefresh, setCopyRefresh] = useState<
    { connectionId: string; db?: string; expand: boolean } | null
  >(null);
  const [copyRefreshNonce, setCopyRefreshNonce] = useState(0);
  const triggerCopyRefresh = React.useCallback(
    (target: { connectionId: string; db?: string }, expand: boolean) => {
      setCopyRefresh({ ...target, expand });
      setCopyRefreshNonce((n) => n + 1);
    },
    []
  );

  // While a copy task is running, periodically re-refresh its destination so
  // collections that trickle in during a long copy stay visible. `expand: false`
  // keeps reloading collections without re-opening a db the user has collapsed.
  const copyRunning = exportTasks.some(
    (t) => (t.kind === 'collection_copy' || t.kind === 'database_copy') && t.status === 'running'
  );
  const refreshConnId = copyRefresh?.connectionId;
  const refreshDb = copyRefresh?.db;
  useEffect(() => {
    if (!copyRunning || !refreshConnId) return;
    const id = setInterval(() => {
      setCopyRefresh((prev) => (prev ? { ...prev, expand: false } : prev));
      setCopyRefreshNonce((n) => n + 1);
    }, 4000);
    return () => clearInterval(id);
  }, [copyRunning, refreshConnId, refreshDb]);

  const handleCopyCollections = (connectionId: string, db: string, collections: string[]) =>
    setCopyDialog({ source: { connectionId, db, collections } });
  const handleCopyDatabase = (connectionId: string, db: string) =>
    setCopyDialog({ source: { connectionId, db, collections: [] } });

  // Copy → clipboard (no dialog); Paste-here opens the dialog pre-filled with that target.
  const handleCopyToClipboard = (connectionId: string, db: string, collections: string[]) => {
    setCopyClipboard({ connectionId, db, collections });
    const what = collections.length === 0 ? `database ${db}` : `${collections.length} collection(s)`;
    toast(`Copied ${what} — right-click a target and choose “Paste here”.`, 'success');
  };
  const handlePasteInto = (connectionId: string, db?: string) => {
    if (!copyClipboard) return;
    setCopyDialog({ source: copyClipboard, target: { connectionId, db } });
  };

  const handleCancelTask = async (taskId: string): Promise<boolean> => {
    try {
      await invoke('cancel_task', { id: taskId });
      await loadExportTasks();
      return true;
    } catch (err: any) {
      toast(`Could not cancel: ${err?.message || err}`, 'error');
      return false;
    }
  };

  useEffect(() => {
    const handleMouseMove = (mouseMoveEvent: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = mouseMoveEvent.clientX;
      if (newWidth >= 180 && newWidth <= 600) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const activeTab = tabs.find(t => t.id === activeTabId) || null;

  // The collection tab an 'export' tab was opened from (results/query source for the
  // Current Results and Filtered cards). Falls back to a matching collection tab by
  // namespace when the originating tab has since closed.
  const deriveExportSourceTab = (exportTab: QueryTab): QueryTab | null =>
    tabs.find(t => t.id === exportTab.exportSourceTabId && t.type === 'collection') ||
    tabs.find(
      t =>
        t.type === 'collection' &&
        t.connectionId === exportTab.connectionId &&
        t.db === exportTab.db &&
        t.collection === exportTab.collection
    ) ||
    null;
  const exportSourceTab = activeTab && activeTab.type === 'export' ? deriveExportSourceTab(activeTab) : null;

  // MongoDB server version of the active connection, for the status bar.
  const activeConnId = activeTab && activeConnections.some(c => c.id === activeTab.connectionId) ? activeTab.connectionId : null;
  useEffect(() => {
    if (!activeConnId) {
      setMongoVersion(null);
      return;
    }
    let alive = true;
    invoke<string>('get_mongodb_version', { id: activeConnId })
      .then((v) => { if (alive) setMongoVersion(v || null); })
      .catch(() => { if (alive) setMongoVersion(null); });
    return () => { alive = false; };
  }, [activeConnId]);

  const connectionNameFor = (connectionId: string): string =>
    activeConnections.find((c) => c.id === connectionId)?.name || connectionId;

  // Never sit on a blank canvas — if every tab is closed, bring back Quick Start.
  useEffect(() => {
    if (tabs.length === 0) {
      setTabs([createQuickStartTab()]);
      dispatchLayout({ type: 'open_tab', tabId: QUICK_START_TAB_ID });
    }
  }, [tabs.length]);

  // savedQuery (palette "jump to saved query") runs instead of the pinned
  // default — for existing tabs it re-runs in place.
  const handleSelectCollection = async (connectionId: string, dbName: string, collName: string, savedQuery?: SavedQueryBody) => {
    if (!connectionId || !dbName || !collName) return;

    const tabId = `${connectionId}.${dbName}.${collName}`;
    const tabExists = tabs.some(t => t.id === tabId);

    if (!tabExists || savedQuery) {
      if (!tabExists) {
        const newTab: QueryTab = {
          id: tabId,
          type: 'collection',
          connectionId,
          db: dbName,
          collection: collName,
          results: [],
          loading: true,
          error: null,
          explainResult: null,
          lastQuery: DEFAULT_QUERY,
        };
        setTabs(prev => [...prev, newTab]);
      } else {
        setTabs(prev => prev.map(t => t.id === tabId ? { ...t, loading: true, error: null } : t));
      }
      dispatchLayout({ type: 'open_tab', tabId });

      try {
        // A saved query (palette) wins; otherwise a pinned default query loads
        // instead of the plain {} find.
        let def: any = savedQuery ?? null;
        if (!def) {
          try {
            const cq = await loadCollectionQueries(connectionNameFor(connectionId), dbName, collName);
            def = cq.default;
          } catch {
            def = null;
          }
        }

        if (def && def.queryType === 'aggregate') {
          const pipeline = (def.pipeline ?? []) as Record<string, unknown>[];
          const resultStrs = await invoke<string[]>('execute_aggregate', {
            id: connectionId,
            database: dbName,
            collection: collName,
            pipeline: JSON.stringify(pipeline),
          });
          const parsedResults = resultStrs.map(s => JSON.parse(s));
          setTabs(prev => prev.map(t => t.id === tabId ? { ...t, results: parsedResults, loading: false, lastAggregate: pipeline } : t));
          // History is best-effort: never surface an error after a successful run.
          recordHistory(connectionNameFor(connectionId), dbName, collName, {
            queryType: 'aggregate',
            pipeline,
          }).catch(() => {});
        } else {
          const q = def && def.queryType === 'find'
            ? {
                filter: JSON.stringify(def.filter ?? {}),
                sort: JSON.stringify(def.sort ?? {}),
                projection: JSON.stringify(def.projection ?? {}),
                limit: def.limit ?? 50,
                skip: def.skip ?? 0,
              }
            : { filter: '{}', sort: '{}', projection: '{}', limit: 50, skip: 0 };
          const resultStrs = await invoke<string[]>('execute_mql_query', {
            id: connectionId,
            database: dbName,
            collection: collName,
            ...q,
          });
          const parsedResults = resultStrs.map(s => JSON.parse(s));
          setTabs(prev => prev.map(t => t.id === tabId ? { ...t, results: parsedResults, loading: false, lastQuery: q } : t));
          // History is best-effort: never surface an error after a successful run.
          recordHistory(connectionNameFor(connectionId), dbName, collName, {
            queryType: 'find',
            filter: JSON.parse(q.filter || '{}'),
            sort: JSON.parse(q.sort || '{}'),
            projection: JSON.parse(q.projection || '{}'),
            limit: q.limit,
            skip: q.skip,
          }).catch(() => {});
          // Fetch count for first open (filter is always new on open).
          setTabs(prev => prev.map(t => t.id === tabId ? { ...t, countLoading: true } : t));
          try {
            const total = await invoke<number>('count_documents', {
              id: connectionId, database: dbName, collection: collName, filter: q.filter,
            });
            setTabs(prev => prev.map(t => t.id === tabId
              ? { ...t, totalCount: total, estimated: isEmptyFilter(q.filter), countLoading: false }
              : t));
          } catch {
            setTabs(prev => prev.map(t => t.id === tabId ? { ...t, countLoading: false } : t));
          }
        }
      } catch (err: any) {
        setTabs(prev => prev.map(t => t.id === tabId ? { ...t, error: String(err), loading: false } : t));
      }
    } else {
      dispatchLayout({ type: 'open_tab', tabId });
    }
  };

  const handleSelectIndex = (connectionId: string, dbName: string, collName: string, indexName: string) => {
    if (!connectionId || !dbName || !collName || !indexName) return;

    const tabId = `${connectionId}.${dbName}.${collName}.${indexName}`;
    const tabExists = tabs.some(t => t.id === tabId);

    if (!tabExists) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'index',
        connectionId,
        db: dbName,
        collection: collName,
        indexName,
        results: [],
        loading: false,
        error: null,
        explainResult: null
      };
      setTabs(prev => [...prev, newTab]);
      dispatchLayout({ type: 'open_tab', tabId });
    } else {
      dispatchLayout({ type: 'open_tab', tabId });
    }
  };

  const handleOpenShell = (connectionId: string, dbName: string, collName = '', initialCommand?: string) => {
    if (!connectionId || !dbName) return;

    const tabId = `shell.${connectionId}.${dbName}.${collName || 'database'}`;
    const tabExists = tabs.some(t => t.id === tabId);

    if (!tabExists) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'shell',
        connectionId,
        db: dbName,
        collection: collName,
        initialShellCommand: initialCommand,
        results: [],
        loading: false,
        error: null,
        explainResult: null
      };
      setTabs(prev => [...prev, newTab]);
    } else if (initialCommand) {
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, initialShellCommand: initialCommand } : t));
    }

    dispatchLayout({ type: 'open_tab', tabId });
  };

  const openSettingsTab = (section: SettingsTabId = 'appearance') => {
    const tabId = 'settings';
    const tabExists = tabs.some(t => t.id === tabId);
    if (!tabExists) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'settings',
        connectionId: '',
        db: '',
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    setSettingsInitialTab(section);
    dispatchLayout({ type: 'open_tab', tabId });
  };

  const handleOpenSettingsTab = () => openSettingsTab('appearance');
  // Tool guidance cards ("mongodump was not found…") point the user at the
  // tool paths, so they land on the Tools section rather than Appearance.
  const handleOpenToolsSettings = () => openSettingsTab('tools');
  const handleOpenShortcutsReference = () => openSettingsTab('shortcuts');

  const handleOpenTasksTab = () => {
    if (!tabs.some(t => t.id === TASKS_TAB_ID)) {
      setTabs(prev => [...prev, createTasksTab()]);
    }
    dispatchLayout({ type: 'open_tab', tabId: TASKS_TAB_ID });
  };

  const handleOpenExportTab = (sourceTab: QueryTab) => {
    if (sourceTab.type !== 'collection') return;
    const tabId = `export.${sourceTab.connectionId}.${sourceTab.db}.${sourceTab.collection}`;
    const tabExists = tabs.some(t => t.id === tabId);
    if (!tabExists) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'export',
        connectionId: sourceTab.connectionId,
        db: sourceTab.db,
        collection: sourceTab.collection,
        exportSourceTabId: sourceTab.id,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
    loadExportTasks();
  };

  const handleOpenImportTab = (sourceTab: QueryTab) => {
    if (sourceTab.type !== 'collection') return;
    const tabId = `import.${sourceTab.connectionId}.${sourceTab.db}.${sourceTab.collection}`;
    const tabExists = tabs.some(t => t.id === tabId);
    if (!tabExists) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'import',
        connectionId: sourceTab.connectionId,
        db: sourceTab.db,
        collection: sourceTab.collection,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
    loadExportTasks();
  };

  // Detection of the mongodump/mongorestore binaries, refreshed whenever a Dump
  // or Restore tab is opened (so a Settings change to the tools directory takes
  // effect the next time either tab is opened).
  const [mongoTools, setMongoTools] = useState<ToolsStatusUi | null>(null);
  const loadMongoTools = React.useCallback(async () => {
    try {
      const dir = getMongoToolsDir();
      const status = await invoke<ToolsStatusUi>('detect_mongo_tools', {
        configuredDir: dir || null,
      });
      setMongoTools(status);
    } catch {
      setMongoTools({ mongodump: null, mongorestore: null });
    }
  }, []);

  // Guided MongoDB tool setup — a single dialog instance at app level. Entry
  // points (Dump/Restore guidance cards, the shell's spawn-failure gate,
  // Settings) all call handleOpenToolSetup(); the running/most-recent install
  // task is fed in from the existing task-polling list (exportTasks) by id.
  const [toolSetupOpen, setToolSetupOpen] = useState(false);
  const [managedToolStatuses, setManagedToolStatuses] = useState<ManagedToolStatusUi[] | null>(null);
  const [toolInstallTaskId, setToolInstallTaskId] = useState<string | null>(null);
  // Bumped when the tool-install dialog finishes, so an open mongosh tab (gated
  // on a failed session) re-attempts its session the same way its own Retry does.
  const [shellReconnectNonce, setShellReconnectNonce] = useState(0);
  // Bumped when the tool-install dialog finishes, so a mounted Settings view
  // re-fetches managed_tools_status instead of showing a stale "Managed tools" card.
  const [toolStatusRefreshNonce, setToolStatusRefreshNonce] = useState(0);

  const refreshManagedToolStatuses = React.useCallback(async () => {
    try {
      const statuses = await invoke<ManagedToolStatusUi[]>('managed_tools_status');
      setManagedToolStatuses(statuses);
      return statuses;
    } catch {
      setManagedToolStatuses([]);
      return [];
    }
  }, []);

  const handleOpenToolSetup = React.useCallback(async () => {
    setManagedToolStatuses(null);
    await refreshManagedToolStatuses();
    setToolSetupOpen(true);
  }, [refreshManagedToolStatuses]);

  const handleInstallTools = React.useCallback(
    async (tools: string[], force: boolean) => {
      try {
        const task = await invoke<ExportTaskInfo>('start_tool_install_task', { tools, force });
        setToolInstallTaskId(task.id);
        insertExportTasks([task]);
        await loadExportTasks();
      } catch (err: any) {
        toast(`Could not start tool install: ${err?.message || err}`, 'error');
      }
    },
    [loadExportTasks, toast]
  );

  const handleCancelToolInstall = React.useCallback(() => {
    if (toolInstallTaskId) void handleCancelTask(toolInstallTaskId);
  }, [toolInstallTaskId]);

  // Completion side effects — refresh tool discovery, managed statuses, and the
  // shell/Settings nonces. Runs from the Done button AND from any other way of
  // closing the dialog after the install reached a terminal state (ESC, X,
  // overlay), so guidance cards can't keep showing "not found" for tools that
  // just got installed.
  const finalizeToolSetup = React.useCallback(() => {
    setToolInstallTaskId(null);
    void loadMongoTools();
    void refreshManagedToolStatuses();
    setShellReconnectNonce((n) => n + 1);
    setToolStatusRefreshNonce((n) => n + 1);
  }, [loadMongoTools, refreshManagedToolStatuses]);

  const handleToolSetupDone = React.useCallback(() => {
    setToolSetupOpen(false);
    finalizeToolSetup();
  }, [finalizeToolSetup]);

  const handleToolSetupOpenChange = React.useCallback(
    (open: boolean) => {
      setToolSetupOpen(open);
      if (!open && toolInstallTaskId) {
        const task = exportTasks.find((t) => t.id === toolInstallTaskId);
        if (task && task.status !== 'running') finalizeToolSetup();
      }
    },
    [toolInstallTaskId, exportTasks, finalizeToolSetup]
  );

  const toolInstallTask: InstallTaskUi | null = React.useMemo(() => {
    if (!toolInstallTaskId) return null;
    const task = exportTasks.find((t) => t.id === toolInstallTaskId);
    if (!task) return null;
    return {
      status: task.status,
      message: task.status === 'failed' ? task.error || task.message : task.message,
      processed: task.processed,
      total: task.total ?? null,
    };
  }, [exportTasks, toolInstallTaskId]);

  // Database/collection tree per connection, for the Dump view's scope picker.
  // Dump has no standing sidebar-tree state to reuse from App, so this loads it
  // directly via list_databases/list_collections when a Dump tab is opened.
  const [dumpDbTrees, setDumpDbTrees] = useState<Record<string, { name: string; collections: string[] }[]>>({});
  const loadDumpDbTree = React.useCallback(async (connectionId: string) => {
    try {
      const dbs = await invoke<string[]>('list_databases', { id: connectionId });
      const withColls = await Promise.all(
        dbs.map(async (name) => {
          try {
            const colls = await invoke<{ name: string }[]>('list_collections', { id: connectionId, db: name });
            return { name, collections: colls.map((c) => c.name) };
          } catch {
            return { name, collections: [] as string[] };
          }
        })
      );
      setDumpDbTrees((prev) => ({ ...prev, [connectionId]: withColls }));
    } catch {
      setDumpDbTrees((prev) => ({ ...prev, [connectionId]: [] }));
    }
  }, []);

  const handleOpenDumpTab = (connectionId: string, db?: string, coll?: string) => {
    const idParts = ['dump', connectionId, db, coll].filter((p): p is string => !!p);
    const tabId = idParts.join('.');
    if (!tabs.some(t => t.id === tabId)) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'dump',
        connectionId,
        db: db ?? '',
        collection: coll ?? '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
    void loadMongoTools();
    void loadDumpDbTree(connectionId);
  };

  const handleOpenRestoreTab = (connectionId: string) => {
    const tabId = `restore.${connectionId}`;
    if (!tabs.some(t => t.id === tabId)) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'restore',
        connectionId,
        db: '',
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
    void loadMongoTools();
  };

  const handleRunDump = async (tab: QueryTab, options: DumpOptionsUi) => {
    const toolPath = mongoTools?.mongodump?.path;
    if (!toolPath) return;
    try {
      const task = await invoke<ExportTaskInfo>('start_dump_task', {
        id: tab.connectionId,
        toolPath,
        options,
      });
      insertExportTasks([task]);
      handleOpenTasksTab();
      await loadExportTasks();
    } catch (err: any) {
      toast(`Dump failed to start: ${err?.message || err}`, 'error');
    }
  };

  const handleRunRestore = async (tab: QueryTab, options: RestoreOptionsUi) => {
    const toolPath = mongoTools?.mongorestore?.path;
    if (!toolPath) return;
    try {
      const task = await invoke<ExportTaskInfo>('start_restore_task', {
        id: tab.connectionId,
        toolPath,
        options,
      });
      insertExportTasks([task]);
      handleOpenTasksTab();
      await loadExportTasks();
    } catch (err: any) {
      toast(`Restore failed to start: ${err?.message || err}`, 'error');
    }
  };

  // M7: open a Create-View tab for a database.
  const handleOpenCreateViewTab = (connectionId: string, db: string) => {
    const tabId = `create-view.${connectionId}.${db}`;
    if (!tabs.some(t => t.id === tabId)) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'create-view',
        connectionId,
        db,
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
  };

  // #93: open a Validation Rules tab for a collection.
  const handleOpenValidationTab = (connectionId: string, db: string, collection: string) => {
    const tabId = `validation.${connectionId}.${db}.${collection}`;
    if (!tabs.some(t => t.id === tabId)) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'validation',
        connectionId,
        db,
        collection,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
  };

  // M7: open a GridFS browser tab for a bucket (bucket stored in `collection`).
  const handleOpenGridfsTab = (connectionId: string, db: string, bucket: string) => {
    const tabId = `gridfs.${connectionId}.${db}.${bucket}`;
    if (!tabs.some(t => t.id === tabId)) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'gridfs',
        connectionId,
        db,
        collection: bucket,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
  };

  // M6: open a schema-analysis tab for a collection.
  const handleOpenSchemaTab = (connectionId: string, db: string, collection: string) => {
    const tabId = `schema.${connectionId}.${db}.${collection}`;
    const tabExists = tabs.some(t => t.id === tabId);
    if (!tabExists) {
      setTabs(prev => [...prev, {
        id: tabId,
        type: 'schema',
        connectionId,
        db,
        collection,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
  };

  const handleOpenMonitoringTab = (connectionId: string) => {
    const tabId = `monitoring.${connectionId}`;
    if (!tabs.some((t) => t.id === tabId)) {
      setTabs((prev) => [...prev, {
        id: tabId,
        type: 'monitoring',
        connectionId,
        db: '',
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    }
    dispatchLayout({ type: 'open_tab', tabId });
  };

  const handleOpenUsersTab = (connectionId: string, db?: string) => {
    const tabId = `users.${connectionId}`;
    if (!tabs.some((t) => t.id === tabId)) {
      setTabs((prev) => [...prev, {
        id: tabId,
        type: 'users',
        connectionId,
        db: db ?? '',
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      }]);
    } else if (db) {
      // Re-opened scoped to a database (sidebar db menu): refocus the scope.
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, db } : t)));
    }
    dispatchLayout({ type: 'open_tab', tabId });
  };

  const handleCollectionRenamed = (
    connectionId: string,
    dbName: string,
    oldName: string,
    newName: string
  ) => {
    const renameTab = (tab: QueryTab): QueryTab => {
      if (tab.connectionId !== connectionId || tab.db !== dbName || tab.collection !== oldName) {
        return tab;
      }
      if (tab.type === 'index') {
        return { ...tab, id: `${connectionId}.${dbName}.${newName}.${tab.indexName}`, collection: newName };
      }
      if (tab.type === 'shell') {
        return { ...tab, id: `shell.${connectionId}.${dbName}.${newName}`, collection: newName };
      }
      if (tab.type === 'export') {
        return { ...tab, id: `export.${connectionId}.${dbName}.${newName}`, collection: newName };
      }
      return { ...tab, id: `${connectionId}.${dbName}.${newName}`, collection: newName };
    };

    const renamedPairs = tabs
      .map(t => ({ oldId: t.id, newId: renameTab(t).id }))
      .filter(p => p.oldId !== p.newId);
    setTabs(prev => prev.map(renameTab));
    renamedPairs.forEach(({ oldId, newId }) => dispatchLayout({ type: 'rename_tab', oldId, newId }));
    invalidatePaletteNamespaceIndex(connectionId);
  };

  const handleDatabaseDropped = (connectionId: string, dbName: string) => {
    invalidatePaletteNamespaceIndex(connectionId);
    const removed = tabs
      .filter(t => t.connectionId === connectionId && t.db === dbName)
      .map(t => t.id);
    setTabs(prev => prev.filter(t => t.connectionId !== connectionId || t.db !== dbName));
    dispatchLayout({ type: 'close_many', tabIds: removed });
  };

  const handleDatabaseRenamed = (connectionId: string, oldName: string, newName: string) => {
    const renameTab = (tab: QueryTab): QueryTab => {
      if (tab.connectionId !== connectionId || tab.db !== oldName) {
        return tab;
      }
      if (tab.type === 'index') {
        return {
          ...tab,
          id: `${connectionId}.${newName}.${tab.collection}.${tab.indexName}`,
          db: newName,
        };
      }
      if (tab.type === 'shell') {
        return {
          ...tab,
          id: `shell.${connectionId}.${newName}.${tab.collection || 'database'}`,
          db: newName,
        };
      }
      if (tab.type === 'export') {
        return {
          ...tab,
          id: `export.${connectionId}.${newName}.${tab.collection}`,
          db: newName,
        };
      }
      return {
        ...tab,
        id: `${connectionId}.${newName}.${tab.collection}`,
        db: newName,
      };
    };

    const renamedPairs = tabs
      .map(t => ({ oldId: t.id, newId: renameTab(t).id }))
      .filter(p => p.oldId !== p.newId);
    setTabs(prev => prev.map(renameTab));
    renamedPairs.forEach(({ oldId, newId }) => dispatchLayout({ type: 'rename_tab', oldId, newId }));
    invalidatePaletteNamespaceIndex(connectionId);
  };

  const handleOpenIndexModalForCreate = (connectionId: string, dbName: string, collName: string) => {
    setIndexModalTarget({
      connectionId,
      db: dbName,
      collection: collName,
      initialData: null,
    });
    setIsIndexModalOpen(true);
  };

  // Fired by the DataGrid COLLSCAN suggestion banner: opens the create-index
  // flow pre-filled with the ESR-ordered keys, scoped to the active tab's own
  // connection/db/collection (preferred over parsing the explain namespace).
  const handleCreateSuggestedIndex = (tab: QueryTab, suggestion: IndexSuggestion) => {
    if (tab.type !== 'collection') return;
    setIndexModalTarget({
      connectionId: tab.connectionId,
      db: tab.db,
      collection: tab.collection,
      initialData: null,
      prefill: {
        name: suggestion.suggestedName,
        keys: suggestion.keys,
      },
    });
    setIsIndexModalOpen(true);
  };

  const handleOpenIndexModalForEdit = (
    connectionId: string,
    dbName: string,
    collName: string,
    indexName: string,
    keys: Record<string, number>,
    unique: boolean,
    sparse: boolean
  ) => {
    setIndexModalTarget({
      connectionId,
      db: dbName,
      collection: collName,
      initialData: {
        name: indexName,
        keys,
        unique,
        sparse,
      },
    });
    setIsIndexModalOpen(true);
  };

  const handleSaveIndex = async (indexName: string, keys: string, unique: boolean, sparse: boolean) => {
    if (!indexModalTarget) return;
    const { connectionId, db, collection, initialData } = indexModalTarget;

    try {
      if (initialData) {
        // Edit mode: drop index first
        await invoke('delete_index', {
          id: connectionId,
          database: db,
          collection,
          indexName: initialData.name,
        });

        // Close/rename tab
        const oldTabId = `${connectionId}.${db}.${collection}.${initialData.name}`;
        setTabs(prev => prev.filter(t => t.id !== oldTabId));
        dispatchLayout({ type: 'close_tab', tabId: oldTabId });
      }

      // Create new index
      await invoke('create_index', {
        id: connectionId,
        database: db,
        collection,
        indexName,
        keys,
        unique,
        sparse,
      });

      setIsIndexModalOpen(false);
      setIndexModalTarget(null);

      // Trigger sidebar refresh
      setIndexMutationTrigger(prev => prev + 1);

      // Automatically open/focus the new index tab!
      handleSelectIndex(connectionId, db, collection, indexName);
    } catch (err: any) {
      toast(`Failed to save index: ${err}`, 'error');
    }
  };

  const handleDeleteIndex = async (connectionId: string, dbName: string, collName: string, indexName: string) => {
    try {
      await invoke('delete_index', {
        id: connectionId,
        database: dbName,
        collection: collName,
        indexName,
      });

      // Close the deleted index tab
      const tabId = `${connectionId}.${dbName}.${collName}.${indexName}`;
      setTabs(prev => prev.filter(t => t.id !== tabId));
      dispatchLayout({ type: 'close_tab', tabId });

      // Trigger sidebar refresh
      setIndexMutationTrigger(prev => prev + 1);
    } catch (err: any) {
      toast(`Failed to delete index: ${err}`, 'error');
    }
  };

  const closeTabById = (tabId: string) => {
    tabBuilderStateCache.current.delete(tabId);
    const updatedTabs = tabs.filter(t => t.id !== tabId);
    setTabs(updatedTabs);
    dispatchLayout({ type: 'close_tab', tabId });
  };

  // Passed to WorkspaceRoot/PaneView as their `dispatch`. Panes close their own
  // tabs by dispatching `close_tab` directly (drag/drop and split ops only need
  // the layout reducer), so we intercept that one action to also keep `tabs`
  // state and the builder-state cache in sync — mirroring closeTabById.
  const dispatchWorkspace = (action: WorkspaceAction) => {
    if (action.type === 'close_tab') {
      closeTabById(action.tabId);
      return;
    }
    dispatchLayout(action);
  };

  const cycleTab = (dir: 1 | -1) => {
    const p = focusedPane;
    if (!p || p.tabIds.length < 2) return;
    const i = p.tabIds.indexOf(p.activeTabId ?? '');
    const next = p.tabIds[(i + dir + p.tabIds.length) % p.tabIds.length];
    dispatchLayout({ type: 'set_active', paneId: p.id, tabId: next });
  };

  const openQuickStartTab = () => {
    setTabs(prev => prev.some(t => t.id === QUICK_START_TAB_ID) ? prev : [...prev, createQuickStartTab()]);
    dispatchLayout({ type: 'open_tab', tabId: QUICK_START_TAB_ID });
  };

  // Command palette: Cmd/Ctrl+K from anywhere in the workspace.
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsPaletteOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Dynamic palette items load only after the user starts searching, so opening
  // command mode does not immediately inventory every connected cluster.
  const [paletteDynamicItems, setPaletteDynamicItems] = useState<PaletteAction[]>([]);
  const [paletteQuery, setPaletteQuery] = useState('');
  const paletteDynamicLoadKey = React.useRef<string | null>(null);
  const paletteNamespaceScope = sidebarFilterQuery.trim();
  const shouldLoadPaletteDynamic =
    isPaletteOpen && (paletteQuery.trim().length >= 2 || paletteNamespaceScope.length >= 2);
  const invalidatePaletteNamespaceIndex = React.useCallback((connectionId?: string) => {
    clearNamespaceIndex(connectionId);
    paletteDynamicLoadKey.current = null;
    setPaletteDynamicItems(prev => prev.length === 0 ? prev : []);
  }, []);
  useEffect(() => {
    if (collectionMutationTrigger > 0) invalidatePaletteNamespaceIndex();
  }, [collectionMutationTrigger, invalidatePaletteNamespaceIndex]);
  useEffect(() => {
    if (!shouldLoadPaletteDynamic) {
      paletteDynamicLoadKey.current = null;
      setPaletteDynamicItems(prev => prev.length === 0 ? prev : []);
      return;
    }
    const collTabs = tabs.filter(t => t.type === 'collection');
    const loadKey = [
      activeConnections.map(c => `${c.id}:${c.name}`).join('|'),
      collTabs.map(t => `${t.id}:${t.connectionId}:${t.db}:${t.collection}`).join('|'),
      paletteNamespaceScope,
    ].join('::');
    if (paletteDynamicLoadKey.current === loadKey) return;
    paletteDynamicLoadKey.current = loadKey;
    let alive = true;
    (async () => {
      const items: PaletteAction[] = [];
      const namespaces = await loadNamespaceIndex(activeConnections.map(c => ({ id: c.id, name: c.name })));
      for (const ns of namespaces) {
        for (const coll of ns.collections) {
          if (!matchesNamespaceScope(paletteNamespaceScope, { connectionName: ns.connectionName, db: ns.db, collection: coll })) {
            continue;
          }
          items.push({
            id: `coll:${ns.connectionId}:${ns.db}:${coll}`,
            title: coll,
            hint: `${ns.connectionName} · ${ns.db}`,
            keywords: `collection ${ns.db} ${ns.connectionName}`,
            run: () => { void handleSelectCollection(ns.connectionId, ns.db, coll); },
          });
        }
      }
      await Promise.all(collTabs.map(async (t) => {
        try {
          const connectionName = connectionNameFor(t.connectionId);
          if (!matchesNamespaceScope(paletteNamespaceScope, { connectionName, db: t.db, collection: t.collection })) {
            return;
          }
          const cq = await loadCollectionQueries(connectionName, t.db, t.collection);
          for (const s of cq.saved) {
            items.push({
              id: `saved:${t.id}:${s.id}`,
              title: `Saved query: ${s.name}`,
              hint: `${t.db}.${t.collection}`,
              keywords: `saved query ${t.collection} ${t.db}`,
              run: () => { void handleSelectCollection(t.connectionId, t.db, t.collection, s.query); },
            });
          }
        } catch { /* store unavailable — skip */ }
      }));
      if (alive) setPaletteDynamicItems(items);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoadPaletteDynamic, activeConnections, tabs, paletteNamespaceScope]);

  const paletteActions: PaletteAction[] = [
    { id: 'new-connection', title: 'New Connection…', keywords: 'connect database add server', run: () => setIsConnectionModalOpen(true) },
    { id: 'toggle-theme', title: 'Toggle Light/Dark Theme', keywords: 'appearance color mode', run: toggleTheme },
    { id: 'open-settings', title: 'Open Settings', keywords: 'preferences config density', run: handleOpenSettingsTab },
    { id: 'open-quickstart', title: 'Open Quick Start', keywords: 'welcome home help', run: openQuickStartTab },
    { id: 'refresh-palette-index', title: 'Refresh Command Palette Index', keywords: 'reload databases collections namespaces cache stale', run: () => invalidatePaletteNamespaceIndex() },
    { id: 'density-roomy', title: 'Density: Roomy', keywords: 'layout spacing', run: () => setSpacingDensity('roomy') },
    { id: 'density-cozy', title: 'Density: Cozy', keywords: 'layout spacing', run: () => setSpacingDensity('cozy') },
    { id: 'density-compact', title: 'Density: Compact', keywords: 'layout spacing dense', run: () => setSpacingDensity('compact') },
    ...(activeTab && activeTab.type === 'collection' ? [
      { id: 'open-shell', title: 'Open mongosh Shell', hint: `${activeTab.db}.${activeTab.collection}`, keywords: 'terminal mongosh script', run: () => handleOpenShell(activeTab.connectionId, activeTab.db, activeTab.collection) },
      { id: 'export-collection', title: 'Export Collection…', hint: `${activeTab.db}.${activeTab.collection}`, keywords: 'download json csv import', run: () => handleOpenExportTab(activeTab) },
      { id: 'analyze-schema', title: 'Analyze Schema', hint: `${activeTab.db}.${activeTab.collection}`, keywords: 'fields types', run: () => handleOpenSchemaTab(activeTab.connectionId, activeTab.db, activeTab.collection) },
    ] : []),
    ...(activeTabId ? [{ id: 'close-tab', title: 'Close Tab', keywords: 'tab', run: () => closeTabById(activeTabId) }] : []),
    ...(tabs.length > 1 ? [
      { id: 'next-tab', title: 'Next Tab', keywords: 'tab switch', run: () => cycleTab(1) },
      { id: 'prev-tab', title: 'Previous Tab', keywords: 'tab switch', run: () => cycleTab(-1) },
    ] : []),
    ...(activeTabId && focusedPane && focusedPane.tabIds.length > 1 ? [
      { id: 'workspace.split-right', title: 'Split Right', keywords: 'workspace pane layout', run: () => dispatchLayout({ type: 'split_pane', paneId: focusedPane.id, dir: 'row', side: 'end', moveTabId: activeTabId }) },
      { id: 'workspace.split-down', title: 'Split Down', keywords: 'workspace pane layout', run: () => dispatchLayout({ type: 'split_pane', paneId: focusedPane.id, dir: 'col', side: 'end', moveTabId: activeTabId }) },
    ] : []),
    ...(allPanes(layout.root).length > 1 ? [
      { id: 'workspace.focus-next-pane', title: 'Focus Next Pane', keywords: 'workspace pane layout switch', run: () => {
        const panes = allPanes(layout.root);
        const i = panes.findIndex(p => p.id === layout.focusedPaneId);
        dispatchLayout({ type: 'focus_pane', paneId: panes[(i + 1) % panes.length].id });
      } },
    ] : []),
    ...activeConnections.map(c => ({
      id: `monitoring:${c.id}`,
      title: `Open Monitoring: ${c.name}`,
      keywords: 'monitoring metrics server status profiler',
      run: () => handleOpenMonitoringTab(c.id),
    })),
    ...activeConnections.map(c => ({
      id: `users:${c.id}`,
      title: `Manage Users: ${c.name}`,
      keywords: 'users roles access permissions authentication admin',
      run: () => handleOpenUsersTab(c.id),
    })),
    { id: 'check-updates', title: 'Check for Updates', keywords: 'version upgrade release', run: () => window.dispatchEvent(new Event(CHECK_UPDATE_EVENT)) },
    ...paletteDynamicItems,
  ];

  const handleExecuteQuery = async (tab: QueryTab, query: { filter: string; sort: string; projection: string; limit: number; skip: number }) => {
    // Update the tab's loading state
    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, loading: true, error: null } : t));

    try {
      const resultStrs = await invoke<string[]>('execute_mql_query', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter: query.filter,
        sort: query.sort,
        projection: query.projection,
        limit: query.limit,
        skip: query.skip
      });

      const parsedResults = resultStrs.map(s => JSON.parse(s));
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, results: parsedResults, loading: false, lastQuery: query, lastAggregate: undefined } : t));
      // History is best-effort: never surface an error after a successful run.
      recordHistory(connectionNameFor(tab.connectionId), tab.db, tab.collection, {
        queryType: 'find',
        filter: JSON.parse(query.filter || '{}'),
        sort: JSON.parse(query.sort || '{}'),
        projection: JSON.parse(query.projection || '{}'),
        limit: query.limit,
        skip: query.skip,
      }).catch(() => {});
      // Pagination count: recount only when the filter changed since the last count.
      const prevFilter = tab.lastQuery?.filter;
      if (query.filter !== prevFilter || tab.totalCount === undefined) {
        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, countLoading: true } : t));
        try {
          const total = await invoke<number>('count_documents', {
            id: tab.connectionId, database: tab.db, collection: tab.collection, filter: query.filter,
          });
          setTabs(prev => prev.map(t => t.id === tab.id
            ? { ...t, totalCount: total, estimated: isEmptyFilter(query.filter), countLoading: false }
            : t));
        } catch {
          setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, countLoading: false } : t));
        }
      }
    } catch (err: any) {
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, error: String(err), loading: false } : t));
    }
  };

  const handlePageChange = (tab: QueryTab, newSkip: number) => {
    if (!tab.lastQuery) return;
    handleExecuteQuery(tab, { ...tab.lastQuery, skip: Math.max(0, newSkip) });
  };

  const handlePageSizeChange = (tab: QueryTab, newLimit: number) => {
    if (!tab.lastQuery) return;
    handleExecuteQuery(tab, { ...tab.lastQuery, limit: newLimit, skip: 0 });
  };

  const handleExecuteAggregate = async (tab: QueryTab, pipeline: Record<string, unknown>[]) => {
    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, loading: true, error: null } : t));

    try {
      const resultStrs = await invoke<string[]>('execute_aggregate', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        pipeline: JSON.stringify(pipeline),
      });

      const parsedResults = resultStrs.map(s => JSON.parse(s));
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, results: parsedResults, loading: false, lastAggregate: pipeline } : t));
      recordHistory(connectionNameFor(tab.connectionId), tab.db, tab.collection, {
        queryType: 'aggregate',
        pipeline,
      }).catch(() => {});
    } catch (err: any) {
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, error: String(err), loading: false } : t));
    }
  };

  // Re-run a tab's last query — used to refresh the grid after a document write.
  const refreshTabResults = async (tab: QueryTab) => {
    try {
      // An aggregate view refreshes by re-running its pipeline; otherwise re-run the find.
      if (tab.lastAggregate) {
        const resultStrs = await invoke<string[]>('execute_aggregate', {
          id: tab.connectionId,
          database: tab.db,
          collection: tab.collection,
          pipeline: JSON.stringify(tab.lastAggregate),
        });
        const parsedResults = resultStrs.map(s => JSON.parse(s));
        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, results: parsedResults } : t));
        return;
      }
      const query = tab.lastQuery || DEFAULT_QUERY;
      const resultStrs = await invoke<string[]>('execute_mql_query', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter: query.filter,
        sort: query.sort,
        projection: query.projection,
        limit: query.limit,
        skip: query.skip,
      });
      const parsedResults = resultStrs.map(s => JSON.parse(s));
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, results: parsedResults } : t));
    } catch (err: any) {
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, error: String(err) } : t));
    }
  };

  // When a tracked import task (started from the Import tab) is observed
  // completed by the task poll, refresh the matching open collection tab so
  // newly-imported documents show up without a manual re-run.
  useEffect(() => {
    const pending = pendingImportRefreshRef.current;
    if (pending.size === 0) return;
    for (const task of exportTasks) {
      if (task.kind !== 'import' || task.status !== 'completed') continue;
      const info = pending.get(task.id);
      if (!info) continue;
      pending.delete(task.id);
      const match = tabs.find(
        (t) =>
          t.type === 'collection' &&
          t.connectionId === info.connectionId &&
          t.db === info.db &&
          t.collection === info.collection
      );
      if (match) refreshTabResults(match);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportTasks]);

  const [documentModal, setDocumentModal] = useState<
    { mode: 'insert' | 'edit'; initialJson: string; targetDoc: Record<string, any> | null; tabId: string } | null
  >(null);

  const handleInsertDocument = (tab: QueryTab) => {
    setDocumentModal({ mode: 'insert', initialJson: '{\n  \n}', targetDoc: null, tabId: tab.id });
  };

  const handleExportForTab = async (
    targetTab: QueryTab | null,
    format: ExportFormat,
    scope: 'current' | 'full' | 'filtered' = 'current',
    options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
    query?: FilteredExportQuery
  ) => {
    if (!targetTab || (targetTab.type !== 'collection' && targetTab.type !== 'export')) return;
    const docs = targetTab.type === 'collection' ? targetTab.results || [] : [];
    if (scope === 'current' && docs.length === 0) return;
    if (scope === 'filtered' && !query) {
      toast('No query to export — edit the filter first.', 'error');
      return;
    }
    try {
      const suffix = scope === 'full' ? '.full' : scope === 'filtered' ? '.filtered' : '';
      // NDJSON conventionally uses the .jsonl extension; the rest match the format.
      const ext = format === 'ndjson' ? 'jsonl' : format;
      const path = await save({
        defaultPath: `${targetTab.collection}${suffix}.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });
      if (!path) return; // cancelled
      if (scope === 'full') {
        const task = await invoke<ExportTaskInfo>('start_collection_export', {
          id: targetTab.connectionId,
          database: targetTab.db,
          collection: targetTab.collection,
          format,
          path,
          options,
        });
        insertExportTasks([task]);
        handleOpenTasksTab();
        await loadExportTasks();
        return;
      }
      if (scope === 'filtered' && query) {
        const isAgg = query.kind === 'aggregate';
        const task = await invoke<ExportTaskInfo>('start_filtered_export', {
          id: targetTab.connectionId,
          database: targetTab.db,
          collection: targetTab.collection,
          format,
          path,
          filter: isAgg ? '{}' : query.filter || '{}',
          sort: isAgg ? '{}' : query.sort || '{}',
          projection: isAgg ? '{}' : query.projection || '{}',
          pipeline: isAgg ? query.pipeline : '',
          skip: !isAgg && query.skip > 0 ? query.skip : null,
          limit: !isAgg && query.limit > 0 ? query.limit : null,
          options,
        });
        insertExportTasks([task]);
        handleOpenTasksTab();
        await loadExportTasks();
        return;
      }

      // Current-results export: the backend's single formatter handles every
      // format (including bson/xlsx binary output) so the frontend just forwards
      // the in-memory docs and lets it write the file.
      await invoke('format_current_docs', { docs, format, options, path });
      toast(`Exported ${docs.length} document(s) to ${path}`, 'success');
    } catch (err: any) {
      toast(`Export failed: ${err?.message || err}`, 'error');
    }
  };

  const handleCopyCurrentExport = async (
    format: 'json' | 'ndjson' | 'csv',
    options: ExportOptions
  ) => {
    if (!exportSourceTab?.results?.length) return;
    try {
      const text = await invoke<string | null>('format_current_docs', {
        docs: exportSourceTab.results,
        format,
        options,
        path: null,
      });
      if (text) await navigator.clipboard.writeText(text);
      toast(`Copied ${exportSourceTab.results.length} document(s) as ${format.toUpperCase()}`, 'success');
    } catch (err: any) {
      toast(`Copy failed: ${err?.message || err}`, 'error');
    }
  };

  const handleScanExportFields = (query?: FilteredExportQuery) =>
    invoke<string[]>('sample_export_fields', {
      id: activeTab?.connectionId,
      database: activeTab?.db,
      collection: activeTab?.collection,
      filter: query?.kind === 'find' ? query.filter : '{}',
      pipeline: query?.kind === 'aggregate' ? query.pipeline : '',
    });

  const handlePreviewExport = async (
    format: ExportFormat,
    scope: 'current' | 'full' | 'filtered',
    options: ExportOptions,
    query?: FilteredExportQuery
  ): Promise<string> => {
    if (scope === 'current') {
      const docs = (exportSourceTab?.results ?? []).slice(0, 5);
      return (
        (await invoke<string | null>('format_current_docs', { docs, format, options, path: null })) ?? ''
      );
    }
    return invoke<string>('preview_export', {
      id: activeTab?.connectionId,
      database: activeTab?.db,
      collection: activeTab?.collection,
      format,
      filter: query?.kind === 'find' ? query.filter : '{}',
      sort: query?.kind === 'find' ? query.sort : '{}',
      projection: query?.kind === 'find' ? query.projection : '{}',
      pipeline: query?.kind === 'aggregate' ? query.pipeline : '',
      options,
    });
  };

  // Top-level field names from a tab's loaded documents, for the export query editors'
  // autocomplete (the export tab itself has no results, so derive from the source tab).
  const fieldsFromResults = (results?: any[]): string[] => {
    if (!results || results.length === 0) return ['_id'];
    const keys = new Set<string>();
    results.forEach((doc) => {
      if (doc && typeof doc === 'object') Object.keys(doc).forEach((k) => keys.add(k));
    });
    keys.add('_id');
    return Array.from(keys).sort((a, b) => {
      if (a === '_id') return -1;
      if (b === '_id') return 1;
      return a.localeCompare(b);
    });
  };

  // Seed the Export view's editable Filtered card from the source tab's last run.
  const buildFilteredExportSeed = (tab: QueryTab | null): FilteredExportSeed => {
    if (tab?.lastAggregate) {
      return { kind: 'aggregate', pipeline: JSON.stringify(tab.lastAggregate, null, 2) };
    }
    return {
      kind: 'find',
      filter: tab?.lastQuery?.filter || '{}',
      sort: tab?.lastQuery?.sort || '{}',
      projection: tab?.lastQuery?.projection || '{}',
      matchCount: typeof tab?.totalCount === 'number' ? tab.totalCount : null,
    };
  };

  const handleImport = (tab: QueryTab) => {
    if (tab.type !== 'collection') return;
    handleOpenImportTab(tab);
  };

  const handleEditDocument = (tab: QueryTab, doc: Record<string, any>) => {
    setDocumentModal({ mode: 'edit', initialJson: docToShell(doc), targetDoc: doc, tabId: tab.id });
  };

  // Duplicate: open the insert modal pre-filled with the document minus its _id.
  const handleDuplicateDocument = (tab: QueryTab, doc: Record<string, any>) => {
    const { _id, ...rest } = doc;
    setDocumentModal({ mode: 'insert', initialJson: docToShell(rest), targetDoc: null, tabId: tab.id });
  };

  const handleDeleteDocument = async (tab: QueryTab, doc: Record<string, any>) => {
    if (doc._id === undefined) {
      toast('Cannot delete: this document has no _id.', 'error');
      return;
    }
    if (
      !(await confirm({
        title: 'Delete document',
        message: 'Delete this document? This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      }))
    )
      return;
    try {
      await invoke('delete_document', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter: JSON.stringify({ _id: doc._id }),
      });
      await refreshTabResults(tab);
      toast(`Document deleted from ${tab.collection}`, 'success', { title: 'Deleted' });
    } catch (err: any) {
      toast(`Failed to delete document: ${err}`, 'error');
    }
  };

  // M7: bulk operations on a collection tab's current query filter.
  const bulkFilter = (tab: QueryTab) => tab.lastQuery?.filter?.trim() || '{}';
  const isEmptyFilterStr = (f: string) => {
    try { return Object.keys(JSON.parse(f)).length === 0; } catch { return false; }
  };
  const bulkConfirmMessage = (verb: string, count: number, filter: string) => {
    const base = `${verb} ${count} document(s) matching:\n${filter}`;
    return isEmptyFilterStr(filter)
      ? `${base}\n\n⚠ This affects ALL ${count} documents in the collection.`
      : base;
  };

  const handleDeleteMany = async (tab: QueryTab) => {
    if (tab.type !== 'collection') return;
    const filter = bulkFilter(tab);
    try {
      const count = await invoke<number>('count_documents', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter,
      });
      if (
        !(await confirm({
          title: 'Delete many',
          message: bulkConfirmMessage('Delete', count, filter),
          confirmLabel: 'Delete',
          destructive: true,
        }))
      )
        return;
      const deleted = await invoke<number>('delete_many', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter,
      });
      await refreshTabResults(tab);
      toast(`Deleted ${deleted} document(s)`, 'success', { title: 'Deleted' });
    } catch (err: any) {
      toast(`Delete failed: ${err?.message || err}`, 'error');
    }
  };

  const handleUpdateMany = async (tab: QueryTab) => {
    if (tab.type !== 'collection') return;
    const filter = bulkFilter(tab);
    const update = await prompt({
      title: 'Update many',
      message: 'Update document (operators, e.g. {"$set": {...}}):',
      defaultValue: '{ "$set": {} }',
      validate: (v) => {
        let parsed: any;
        try {
          parsed = JSON.parse(v);
        } catch {
          return 'Invalid JSON';
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return 'Update must be a JSON object';
        }
        if (Object.keys(parsed).length === 0 || !Object.keys(parsed).every((k) => k.startsWith('$'))) {
          return 'Update must use operators like $set';
        }
        return null;
      },
    });
    if (!update) return; // cancelled
    try {
      const count = await invoke<number>('count_documents', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter,
      });
      if (
        !(await confirm({
          title: 'Update many',
          message: bulkConfirmMessage('Apply this update to', count, filter),
          confirmLabel: 'Update',
          destructive: true,
        }))
      )
        return;
      const modified = await invoke<number>('update_many', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter,
        update,
      });
      await refreshTabResults(tab);
      toast(`Modified ${modified} document(s)`, 'success', { title: 'Updated' });
    } catch (err: any) {
      toast(`Update failed: ${err?.message || err}`, 'error');
    }
  };

  const handleSaveDocument = async (json: string) => {
    if (!documentModal) return;
    const tab = tabs.find(t => t.id === documentModal.tabId);
    if (!tab) return;
    const collection = tab.collection;
    if (documentModal.mode === 'insert') {
      await invoke('insert_document', {
        id: tab.connectionId,
        database: tab.db,
        collection,
        document: json,
      });
      setDocumentModal(null);
      await refreshTabResults(tab);
      toast(`Document inserted into ${collection}`, 'success', { title: 'Inserted' });
      return;
    }

    const target = documentModal.targetDoc;
    if (!target || target._id === undefined) {
      throw new Error('Cannot update: this document has no _id.');
    }
    await invoke('update_document', {
      id: tab.connectionId,
      database: tab.db,
      collection,
      filter: JSON.stringify({ _id: target._id }),
      replacement: json,
    });
    setDocumentModal(null);
    await refreshTabResults(tab);
    toast(`Document saved in ${collection}`, 'success', { title: 'Saved' });
  };

  const handleExplainQuery = async (tab: QueryTab, filter: string): Promise<string> => {
    const plan = await invoke<string>('explain_mql_query', {
      id: tab.connectionId,
      database: tab.db,
      collection: tab.collection,
      filter
    });
    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, explainResult: plan } : t));
    return plan;
  };

  // M1: explain the full aggregation pipeline (not just its $match stage).
  const handleExplainAggregate = async (tab: QueryTab, pipeline: string): Promise<string> => {
    const plan = await invoke<string>('explain_aggregate_query', {
      id: tab.connectionId,
      database: tab.db,
      collection: tab.collection,
      pipeline
    });
    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, explainResult: plan } : t));
    return plan;
  };

  // Renders the content pane for a single tab. Parameterized by `tab` (not the
  // module-level `activeTab`) so multiple panes can each render their own tab
  // simultaneously.
  const renderTabContent = (tabId: string): React.ReactNode => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return null;
    return (
      <>
        {tab.type === 'index' && (
          <IndexViewer
            connectionId={tab.connectionId}
            databaseName={tab.db}
            collectionName={tab.collection}
            indexName={tab.indexName || ''}
            onEditIndex={(indexName, keys, unique, sparse) =>
              handleOpenIndexModalForEdit(
                tab.connectionId,
                tab.db,
                tab.collection,
                indexName,
                keys,
                unique,
                sparse
              )
            }
            onDeleteIndex={(indexName) =>
              handleDeleteIndex(
                tab.connectionId,
                tab.db,
                tab.collection,
                indexName
              )
            }
          />
        )}
        {tab.type === 'collection' && (() => {
          const activeConnection = activeConnections.find(c => c.id === tab.connectionId);
          const connectionName = activeConnection ? activeConnection.name : 'cmi-dev';
          const connectionUser = activeConnection ? usernameFromUri(activeConnection.uri) : '';
          return (
            <DocumentViewer
              key={tab.id}
              connectionId={tab.connectionId}
              connectionName={connectionName}
              connectionUser={connectionUser}
              databaseName={tab.db}
              collectionName={tab.collection}
              initialBuilderState={
                tabBuilderStateCache.current.get(tab.id)
                ?? builderStateFromQueryTab(tab.lastQuery, tab.lastAggregate)
              }
              onBuilderStateChange={(state) => handleBuilderStateChange(tab.id, state)}
              onExecute={q => handleExecuteQuery(tab, q)}
              onExecuteAggregate={pipeline => handleExecuteAggregate(tab, pipeline)}
              onExplain={filter => handleExplainQuery(tab, filter)}
              onExplainAggregate={pipeline => handleExplainAggregate(tab, pipeline)}
              onOpenShell={(command) => handleOpenShell(tab.connectionId, tab.db, tab.collection, command)}
              onOpenExport={() => handleOpenExportTab(tab)}
              onImport={() => handleImport(tab)}
              loading={tab.loading}
              availableFields={fieldsFromResults(tab.results)}
            >
              <div className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
                {tab.error && (
                  <div className="p-3 bg-destructive/10 border-b border-border text-destructive font-mono text-xs select-text flex items-start gap-2">
                    <span className="flex-grow">Error loading dataset: {tab.error}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      title="Copy error message"
                      onClick={() => { try { navigator.clipboard?.writeText(String(tab.error)); } catch { /* clipboard unavailable */ } }}
                    >
                      <Copy size={11} />
                      Copy
                    </Button>
                  </div>
                )}
                {tab.loading ? (
                  <div className="flex-grow flex items-center justify-center text-muted-foreground bg-background">
                    <div className="flex flex-col items-center gap-2 select-none">
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary"></div>
                      <span className="text-xs">Streaming documents asynchronously...</span>
                    </div>
                  </div>
                ) : (
                  <DataGrid
                    documents={tab.results}
                    density={density}
                    explainResult={tab.explainResult}
                    querySpec={buildTabQuerySpec(tab)}
                    onInsertDocument={() => handleInsertDocument(tab)}
                    onEditDocument={doc => handleEditDocument(tab, doc)}
                    onDuplicateDocument={doc => handleDuplicateDocument(tab, doc)}
                    onDeleteDocument={doc => handleDeleteDocument(tab, doc)}
                    onAnalyzeSchema={() => handleOpenSchemaTab(tab.connectionId, tab.db, tab.collection)}
                    onUpdateMany={() => handleUpdateMany(tab)}
                    onDeleteMany={() => handleDeleteMany(tab)}
                    totalCount={tab.totalCount}
                    estimated={tab.estimated}
                    countLoading={tab.countLoading}
                    skip={tab.lastQuery?.skip ?? 0}
                    limit={tab.lastQuery?.limit ?? 50}
                    onCreateSuggestedIndex={s => handleCreateSuggestedIndex(tab, s)}
                    {...(!tab.lastAggregate ? {
                      onPageChange: (newSkip: number) => handlePageChange(tab, newSkip),
                      onPageSizeChange: (newLimit: number) => handlePageSizeChange(tab, newLimit),
                    } : {})}
                  />
                )}
              </div>
            </DocumentViewer>
          );
        })()}
        {tab.type === 'schema' && (
          <SchemaView
            connectionId={tab.connectionId}
            databaseName={tab.db}
            collectionName={tab.collection}
          />
        )}
        {tab.type === 'create-view' && (
          <CreateViewView
            connectionId={tab.connectionId}
            databaseName={tab.db}
            onCreated={(viewName) => {
              setCollectionMutationTrigger(prev => prev + 1);
              handleSelectCollection(tab.connectionId, tab.db, viewName);
            }}
          />
        )}
        {tab.type === 'validation' && (
          <ValidationRulesView
            connectionId={tab.connectionId}
            databaseName={tab.db}
            collectionName={tab.collection}
            onApplied={() => setCollectionMutationTrigger(prev => prev + 1)}
          />
        )}
        {tab.type === 'gridfs' && (
          <GridFsView
            connectionId={tab.connectionId}
            databaseName={tab.db}
            bucket={tab.collection}
            onNamespaceMutated={() => setCollectionMutationTrigger((prev) => prev + 1)}
          />
        )}
        {tab.type === 'monitoring' && (
          <MonitoringView connectionId={tab.connectionId} />
        )}
        {tab.type === 'users' && (
          <UserManagementView connectionId={tab.connectionId} database={tab.db || undefined} />
        )}
        {tab.type === 'export' && (() => {
          const activeConnection = activeConnections.find(c => c.id === tab.connectionId);
          const connectionName = activeConnection ? activeConnection.name : tab.connectionId;
          const sourceTab = deriveExportSourceTab(tab);
          return (
            <ExportView
              key={`export:${tab.connectionId}:${tab.db}:${tab.collection}`}
              connectionId={tab.connectionId}
              connectionName={connectionName}
              databaseName={tab.db}
              collectionName={tab.collection}
              currentResultCount={sourceTab?.results.length || 0}
              availableFields={fieldsFromResults(sourceTab?.results)}
              filtered={buildFilteredExportSeed(sourceTab)}
              onExport={(format, scope, options, query) =>
                handleExportForTab(sourceTab || tab, format, scope, options, query)
              }
              onCountFilter={(filter) =>
                invoke<number>('count_documents', {
                  id: tab.connectionId,
                  database: tab.db,
                  collection: tab.collection,
                  filter,
                })
              }
              onOpenTasks={handleOpenTasksTab}
              onScanFields={handleScanExportFields}
              onCopyCurrent={handleCopyCurrentExport}
              onPreview={handlePreviewExport}
            />
          );
        })()}
        {tab.type === 'import' && (() => {
          const activeConnection = activeConnections.find(c => c.id === tab.connectionId);
          const connectionName = activeConnection ? activeConnection.name : tab.connectionId;
          return (
            <ImportView
              key={`import:${tab.connectionId}:${tab.db}:${tab.collection}`}
              connectionName={connectionName}
              databaseName={tab.db}
              collectionName={tab.collection}
              onOpenTasks={handleOpenTasksTab}
              onPickFile={async () => {
                const p = await open({
                  multiple: false,
                  filters: [{ name: 'Data', extensions: ['json', 'jsonl', 'ndjson', 'csv', 'bson'] }],
                });
                return typeof p === 'string' ? p : null;
              }}
              onPreview={(source, format, csvOptions) =>
                invoke<ImportPreviewData>('preview_import', { source, format, csvOptions, limit: 20 })
              }
              onRunImport={async (source, format, csvOptions, mode) => {
                try {
                  const task = await invoke<ExportTaskInfo>('start_import_task', {
                    id: tab.connectionId,
                    database: tab.db,
                    collection: tab.collection,
                    source,
                    format,
                    csvOptions,
                    mode,
                  });
                  pendingImportRefreshRef.current.set(task.id, {
                    connectionId: tab.connectionId,
                    db: tab.db,
                    collection: tab.collection,
                  });
                  insertExportTasks([task]);
                  handleOpenTasksTab();
                  await loadExportTasks();
                } catch (err: any) {
                  toast(`Import failed to start: ${err?.message || err}`, 'error');
                }
              }}
            />
          );
        })()}
        {tab.type === 'dump' && (() => {
          const activeConnection = activeConnections.find(c => c.id === tab.connectionId);
          const connectionName = activeConnection ? activeConnection.name : tab.connectionId;
          const initialScope: DumpScopeUi = tab.collection
            ? { kind: 'collection', db: tab.db, coll: tab.collection }
            : tab.db
              ? { kind: 'db', db: tab.db }
              : { kind: 'server' };
          return (
            <DumpView
              key={tab.id}
              connectionName={connectionName}
              databases={dumpDbTrees[tab.connectionId] ?? []}
              initialScope={initialScope}
              tools={mongoTools}
              onOpenSettings={handleOpenToolsSettings}
              onInstallTools={handleOpenToolSetup}
              onPickFolder={async () => {
                const p = await open({ directory: true });
                return typeof p === 'string' ? p : null;
              }}
              onPickArchiveFile={async (defaultName) => {
                const p = await save({ defaultPath: defaultName });
                return p ?? null;
              }}
              onPreviewCommand={(options) =>
                invoke<string>('preview_dump_command', {
                  id: tab.connectionId,
                  toolPath: mongoTools?.mongodump?.path ?? '',
                  options,
                })
              }
              onRunDump={(options) => handleRunDump(tab, options)}
              onOpenTasks={handleOpenTasksTab}
            />
          );
        })()}
        {tab.type === 'restore' && (() => {
          const activeConnection = activeConnections.find(c => c.id === tab.connectionId);
          const connectionName = activeConnection ? activeConnection.name : tab.connectionId;
          return (
            <RestoreView
              key={tab.id}
              connectionName={connectionName}
              tools={mongoTools}
              onOpenSettings={handleOpenToolsSettings}
              onInstallTools={handleOpenToolSetup}
              onPickFolder={async () => {
                const p = await open({ directory: true });
                return typeof p === 'string' ? p : null;
              }}
              onPickArchiveFile={async () => {
                const p = await open({ multiple: false });
                return typeof p === 'string' ? p : null;
              }}
              onBrowseFolder={(path) => invoke<DumpTreeUi>('browse_dump_folder', { path })}
              onPreviewCommand={(options) =>
                invoke<string>('preview_restore_command', {
                  id: tab.connectionId,
                  toolPath: mongoTools?.mongorestore?.path ?? '',
                  options,
                })
              }
              onRunRestore={(options) => handleRunRestore(tab, options)}
              onOpenTasks={handleOpenTasksTab}
            />
          );
        })()}
        {tab.type === 'tasks' && (
          <div className="flex h-full flex-col overflow-auto p-4" data-testid="tasks-view">
            <header className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Background copy and export jobs.
              </p>
            </header>
            <TaskManager
              tasks={exportTasks}
              onRefresh={loadExportTasks}
              onClearFinished={handleClearFinishedTasks}
              onCancel={handleCancelTask}
              variant="embedded"
            />
          </div>
        )}
        {tab.type === 'shell' && (() => {
          const activeConnection = activeConnections.find(c => c.id === tab.connectionId);
          const connectionName = activeConnection ? activeConnection.name : tab.connectionId;
          return (
            <MongoShell
              key={`${tab.id}:${tab.initialShellCommand || ''}`}
              connectionId={tab.connectionId}
              connectionName={connectionName}
              connectionUri={activeConnection?.uri || ''}
              databaseName={tab.db}
              collectionName={tab.collection || undefined}
              initialCommand={tab.initialShellCommand}
              density={density}
              onOpenSettings={handleOpenToolsSettings}
              onInstallTools={handleOpenToolSetup}
              reconnectSignal={shellReconnectNonce}
            />
          );
        })()}
        {tab.type === 'settings' && (
          <SettingsView
            initialTab={settingsInitialTab}
            onInstallTools={handleOpenToolSetup}
            toolStatusRefreshNonce={toolStatusRefreshNonce}
          />
        )}
        {tab.type === 'quickstart' && (
          <QuickStart
            onConnect={() => setIsConnectionModalOpen(true)}
            onOpenSettings={handleOpenSettingsTab}
            onOpenShortcuts={handleOpenShortcutsReference}
            onQuickConnect={async (profile) => {
              await handleQuickConnect(profile);
            }}
            onLoadSampleData={handleLoadSampleData}
            activeConnections={activeConnections}
            profilesRefreshKey={profilesRefreshKey}
          />
        )}
      </>
    );
  };

  const renderEmptyPane = () => (
    /* Empty/Welcome Dashboard Panel */
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
        <img src={logoMark} alt="" className="h-10 w-10 animate-pulse" />
      </div>
      <h1 className="text-2xl font-semibold text-foreground">MQLens</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        No active connection. Connect to a MongoDB cluster to browse collections and run queries.
      </p>

      <Button onClick={() => setIsConnectionModalOpen(true)}>
        <Play size={14} className="mr-1.5" fill="currentColor" />
        Connect to Database...
      </Button>
    </div>
  );

  return (
    <AppShell
      sidebar={
        <Sidebar
          onSelectCollection={handleSelectCollection}
          onSelectIndex={handleSelectIndex}
          onCreateIndex={handleOpenIndexModalForCreate}
          onDeleteIndex={handleDeleteIndex}
          onOpenShell={handleOpenShell}
          onOpenMonitoring={handleOpenMonitoringTab}
          onOpenUsers={handleOpenUsersTab}
          onAnalyzeSchema={handleOpenSchemaTab}
          onEditValidation={handleOpenValidationTab}
          onCreateView={handleOpenCreateViewTab}
          onOpenGridfs={handleOpenGridfsTab}
          onOpenDump={handleOpenDumpTab}
          onOpenRestore={handleOpenRestoreTab}
          collectionMutationTrigger={collectionMutationTrigger}
          onCollectionRenamed={handleCollectionRenamed}
          onDatabaseDropped={handleDatabaseDropped}
          onDatabaseRenamed={handleDatabaseRenamed}
          onNamespaceMutated={invalidatePaletteNamespaceIndex}
          onFilterQueryChange={setSidebarFilterQuery}
          indexMutationTrigger={indexMutationTrigger}
          activeCollection={activeTab ? { connectionId: activeTab.connectionId, db: activeTab.db, collection: activeTab.collection, indexName: activeTab.indexName } : null}
          activeConnections={activeConnections}
          onOpenConnectionManager={() => setIsConnectionModalOpen(true)}
          onConnectProfile={handleQuickConnect}
          profilesRefreshKey={profilesRefreshKey}
          onDisconnect={async (connId) => {
            try {
              await invoke('disconnect_db', { id: connId });
            } catch (err) {}
            setActiveConnections(prev => prev.filter(c => c.id !== connId));
            const removed = tabs.filter(t => t.connectionId === connId).map(t => t.id);
            setTabs(prev => prev.filter(t => t.connectionId !== connId));
            dispatchLayout({ type: 'close_many', tabIds: removed });
          }}
          onOpenSettings={handleOpenSettingsTab}
          onCopyCollections={handleCopyCollections}
          onCopyDatabase={handleCopyDatabase}
          onCopyToClipboard={handleCopyToClipboard}
          onPasteInto={handlePasteInto}
          canPaste={!!copyClipboard}
          refreshTarget={copyRefresh}
          refreshTargetNonce={copyRefreshNonce}
        />
      }
      sidebarWidth={sidebarWidth}
      onResizeStart={startResizing}
      tabBar={null}
      statusBar={
        <StatusBar
          cpu={resUsage ? `${resUsage.cpu_percent.toFixed(0)}%` : undefined}
          memory={resUsage ? formatBytes(resUsage.memory_bytes) : undefined}
          mongoVersion={mongoVersion ?? undefined}
          appVersion={appVersion ? `v${appVersion}` : undefined}
          zoomPercent={Math.round(config.uiZoom * 100)}
          onZoomReset={resetZoom}
          onOpenTasks={handleOpenTasksTab}
          runningTasks={exportTasks.filter((t) => t.status === 'running').length}
        />
      }
      overlays={
        <>
          <CommandPalette
            open={isPaletteOpen}
            onClose={() => {
              setIsPaletteOpen(false);
              setPaletteQuery('');
            }}
            actions={paletteActions}
            scopeLabel={paletteNamespaceScope}
            onQueryChange={setPaletteQuery}
          />

          <ConnectionManager
            isOpen={isConnectionModalOpen}
            onClose={() => { setIsConnectionModalOpen(false); setProfilesRefreshKey((k) => k + 1); }}
            onConnect={(id, name, uri, profileId, colorTag) => {
              addActiveConnection(id, name, uri, profileId, colorTag ?? undefined);
              setIsConnectionModalOpen(false);
              setProfilesRefreshKey((k) => k + 1);
            }}
            activeConnections={activeConnections}
          />

          <IndexModal
            isOpen={isIndexModalOpen}
            onClose={() => {
              setIsIndexModalOpen(false);
              setIndexModalTarget(null);
            }}
            onSave={handleSaveIndex}
            connectionId={indexModalTarget?.connectionId}
            databaseName={indexModalTarget?.db}
            collectionName={indexModalTarget?.collection}
            availableFields={fieldsFromResults(activeTab?.results)}
            initialData={indexModalTarget?.initialData}
            prefill={indexModalTarget?.prefill}
          />

          <DocumentEditModal
            isOpen={documentModal !== null}
            mode={documentModal?.mode || 'insert'}
            initialJson={documentModal?.initialJson || '{}'}
            onClose={() => setDocumentModal(null)}
            onSave={handleSaveDocument}
          />

          <UpdatePrompt />

          <ToolSetupDialog
            open={toolSetupOpen}
            onOpenChange={handleToolSetupOpenChange}
            statuses={managedToolStatuses}
            installTask={toolInstallTask}
            onInstall={handleInstallTools}
            onCancel={handleCancelToolInstall}
            onDone={handleToolSetupDone}
          />

          {copyDialog && (
            <CopyToDialog
              open={!!copyDialog}
              onOpenChange={(o) => !o && setCopyDialog(null)}
              source={copyDialog.source}
              presetTargetId={copyDialog.target?.connectionId}
              presetTargetDb={copyDialog.target?.db}
              activeConnections={activeConnections.map((c) => ({ id: c.id, name: c.name, uri: c.uri }))}
              listDatabases={(id) => invoke<string[]>('list_databases', { id })}
              listCollections={(id, db) =>
                invoke<{ name: string }[]>('list_collections', { id, db }).then((cs) => cs.map((c) => c.name))
              }
              preflight={(req) =>
                invoke('preflight_copy', {
                  sourceId: req.sourceId,
                  sourceDb: req.sourceDb,
                  sourceCollections: req.sourceCollections,
                  targets: req.targets,
                })
              }
              onConfirm={async (req) => {
                handleOpenTasksTab();
                // Surface the destination right away and expand it; the periodic
                // effect keeps it fresh while the copy runs.
                triggerCopyRefresh({ connectionId: req.targetId, db: req.targetDb }, true);
                let task: ExportTaskInfo;
                if (req.type === 'database') {
                  task = await invoke<ExportTaskInfo>('start_database_copy', {
                    sourceId: req.sourceId, sourceDb: req.sourceDb,
                    targetId: req.targetId, targetDb: req.targetDb,
                    collections: req.collections, includeIndexes: req.includeIndexes,
                    includeViews: req.includeViews, conflictMode: req.conflictMode,
                  });
                } else if (req.type === 'collections') {
                  // Copy each selected collection as its own task (same target db, same name).
                  const tasks = await Promise.all(req.collections.map((name) =>
                    invoke<ExportTaskInfo>('start_collection_copy', {
                      sourceId: req.sourceId, sourceDb: req.sourceDb, sourceCollection: name,
                      targetId: req.targetId, targetDb: req.targetDb, targetCollection: name,
                      filter: null, includeIndexes: req.includeIndexes, conflictMode: req.conflictMode,
                    })));
                  insertExportTasks(tasks);
                  await loadExportTasks();
                  return;
                } else {
                  task = await invoke<ExportTaskInfo>('start_collection_copy', {
                    sourceId: req.sourceId, sourceDb: req.sourceDb, sourceCollection: req.sourceCollection,
                    targetId: req.targetId, targetDb: req.targetDb, targetCollection: req.targetCollection,
                    filter: req.filter ?? null, includeIndexes: req.includeIndexes, conflictMode: req.conflictMode,
                  });
                }
                insertExportTasks([task]);
                await loadExportTasks();
              }}
            />
          )}
        </>
      }
    >
      <WorkspaceRoot
        layout={layout}
        dispatch={dispatchWorkspace}
        tabsFor={pane =>
          pane.tabIds
            .map(id => tabs.find(t => t.id === id))
            .filter((t): t is QueryTab => !!t)
            .map(t => ({ id: t.id, label: tabLabelFor(t, connectionNameFor), icon: tabIconFor(t, t.id === pane.activeTabId) }))
        }
        renderTabContent={renderTabContent}
        renderEmptyPane={renderEmptyPane}
      />
    </AppShell>
  );
}

function App() {
  return (
    <DialogProvider>
      <Toaster />
      <VaultGate>
        <Workspace />
      </VaultGate>
    </DialogProvider>
  );
}

export default App;
