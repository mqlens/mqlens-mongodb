import React, { useState, useEffect } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { WorkspaceTabBar } from '@/components/layout/WorkspaceTabBar';
import { StatusBar } from '@/components/layout/StatusBar';
import { Toaster } from '@/components/ui/sonner';
import { useTheme } from '@/hooks/use-theme';
import { Sidebar } from './components/Sidebar';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { DocumentViewer } from './components/DocumentViewer';
import { DataGrid } from './components/DataGrid';
import { ConnectionManager } from './components/ConnectionManager';
import { SettingsView } from './components/SettingsModal';
import { IndexViewer } from './components/IndexViewer';
import { IndexModal } from './components/IndexModal';
import { MongoShell } from './components/MongoShell';
import { QuickStart } from './components/QuickStart';
import { DocumentEditModal } from './components/DocumentEditModal';
import { ExportView } from './components/ExportView';
import { SchemaView } from './components/SchemaView';
import { CreateViewView } from './components/CreateViewView';
import { GridFsView } from './components/GridFsView';
import { MonitoringView } from './components/MonitoringView';
import { UserManagementView } from './components/UserManagementView';
import { type ExportTaskInfo } from './components/TaskManager';
import { VaultGate } from './components/VaultGate';
import { UpdatePrompt } from './components/UpdatePrompt';
import { DialogProvider, useDialogs } from './components/dialogs/DialogProvider';
import { formatBytes } from './lib/format';
import type { QueryCodeSpec } from './lib/queryCodeGen';
import { docToShell } from './lib/shellDoc';
import { recordHistory, loadCollectionQueries, type SavedQueryBody } from './lib/queryStore';
import { clearNamespaceIndex, loadNamespaceIndex, matchesNamespaceScope } from './lib/paletteIndex';
import { CHECK_UPDATE_EVENT } from './components/UpdatePrompt';
import type { ConnectionProfile } from './lib/connection';
import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { toJson, toCsv, parseJson, parseCsv } from './lib/dataTransfer';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { Button } from '@/components/ui/button';
import { FolderCode, KeyRound, Play, Settings, Terminal, Rocket, Download, Table2, Eye, HardDrive, Activity, Copy, Users } from 'lucide-react';
import logoMark from './assets/logo-mark.svg';

interface QueryTab {
  id: string;
  type: 'collection' | 'index' | 'shell' | 'settings' | 'quickstart' | 'export' | 'schema' | 'create-view' | 'gridfs' | 'monitoring' | 'users';
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
    default:
      return tab.collection;
  }
};

function Workspace() {
  const { toast, confirm, choose, prompt } = useDialogs();
  const { config, resolvedMode, setMode, setSpacingDensity } = useTheme();
  const density = config.spacingDensity;
  // Open the Quick Start tab by default so the app never starts on a blank canvas.
  const [tabs, setTabs] = useState<QueryTab[]>([createQuickStartTab()]);
  const [activeTabId, setActiveTabId] = useState<string | null>(QUICK_START_TAB_ID);
  const [activeConnections, setActiveConnections] = useState<ActiveConnection[]>([]);
  const [profilesRefreshKey, setProfilesRefreshKey] = useState(0);
  const [isConnectionModalOpen, setIsConnectionModalOpen] = useState(false);

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
      addActiveConnection(id, profile.name, profile.uri, profile.id, profile.color_tag);
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
  const loadExportTasks = React.useCallback(async () => {
    try {
      const tasks = await invoke<ExportTaskInfo[]>('list_export_tasks');
      setExportTasks(tasks);
    } catch {
      /* ignore — task polling should not interrupt the main workspace */
    }
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
      setActiveTabId(QUICK_START_TAB_ID);
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
      setActiveTabId(tabId);

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
      setActiveTabId(tabId);
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
      setActiveTabId(tabId);
    } else {
      setActiveTabId(tabId);
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

    setActiveTabId(tabId);
  };

  const handleOpenSettingsTab = () => {
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
    setActiveTabId(tabId);
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
    setActiveTabId(tabId);
    loadExportTasks();
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
    setActiveTabId(tabId);
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
    setActiveTabId(tabId);
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
    setActiveTabId(tabId);
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
    setActiveTabId(tabId);
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
    setActiveTabId(tabId);
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

    setTabs(prev => prev.map(renameTab));
    setActiveTabId(prev => {
      const current = tabs.find(t => t.id === prev);
      return current ? renameTab(current).id : prev;
    });
    invalidatePaletteNamespaceIndex(connectionId);
  };

  const handleDatabaseDropped = (connectionId: string, dbName: string) => {
    invalidatePaletteNamespaceIndex(connectionId);
    setTabs(prev => {
      const updated = prev.filter(t => t.connectionId !== connectionId || t.db !== dbName);
      const activeWasDropped = activeTabId
        ? prev.some(t => t.id === activeTabId && t.connectionId === connectionId && t.db === dbName)
        : false;
      if (activeWasDropped) {
        setActiveTabId(updated.length > 0 ? updated[updated.length - 1].id : null);
      }
      return updated;
    });
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

    setTabs(prev => prev.map(renameTab));
    setActiveTabId(prev => {
      const current = tabs.find(t => t.id === prev);
      return current ? renameTab(current).id : prev;
    });
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
      if (activeTabId === tabId) {
        // Find if there's any remaining tabs
        const remaining = tabs.filter(t => t.id !== tabId);
        if (remaining.length > 0) {
          setActiveTabId(remaining[remaining.length - 1].id);
        } else {
          setActiveTabId(null);
        }
      }

      // Trigger sidebar refresh
      setIndexMutationTrigger(prev => prev + 1);
    } catch (err: any) {
      toast(`Failed to delete index: ${err}`, 'error');
    }
  };

  const closeTabById = (tabId: string) => {
    const updatedTabs = tabs.filter(t => t.id !== tabId);
    setTabs(updatedTabs);

    if (activeTabId === tabId) {
      if (updatedTabs.length > 0) {
        setActiveTabId(updatedTabs[updatedTabs.length - 1].id);
      } else {
        setActiveTabId(null);
      }
    }
  };

  const cycleTab = (dir: 1 | -1) => {
    if (tabs.length < 2) return;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    setActiveTabId(tabs[(idx + dir + tabs.length) % tabs.length].id);
  };

  const openQuickStartTab = () => {
    setTabs(prev => prev.some(t => t.id === QUICK_START_TAB_ID) ? prev : [...prev, createQuickStartTab()]);
    setActiveTabId(QUICK_START_TAB_ID);
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

  const handleExecuteQuery = async (query: { filter: string; sort: string; projection: string; limit: number; skip: number }) => {
    if (!activeTab) return;

    // Update active tab loading state
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, loading: true, error: null } : t));

    try {
      const resultStrs = await invoke<string[]>('execute_mql_query', {
        id: activeTab.connectionId,
        database: activeTab.db,
        collection: activeTab.collection,
        filter: query.filter,
        sort: query.sort,
        projection: query.projection,
        limit: query.limit,
        skip: query.skip
      });

      const parsedResults = resultStrs.map(s => JSON.parse(s));
      setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, results: parsedResults, loading: false, lastQuery: query, lastAggregate: undefined } : t));
      // History is best-effort: never surface an error after a successful run.
      recordHistory(connectionNameFor(activeTab.connectionId), activeTab.db, activeTab.collection, {
        queryType: 'find',
        filter: JSON.parse(query.filter || '{}'),
        sort: JSON.parse(query.sort || '{}'),
        projection: JSON.parse(query.projection || '{}'),
        limit: query.limit,
        skip: query.skip,
      }).catch(() => {});
      // Pagination count: recount only when the filter changed since the last count.
      const prevFilter = activeTab.lastQuery?.filter;
      if (query.filter !== prevFilter || activeTab.totalCount === undefined) {
        setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, countLoading: true } : t));
        try {
          const total = await invoke<number>('count_documents', {
            id: activeTab.connectionId, database: activeTab.db, collection: activeTab.collection, filter: query.filter,
          });
          setTabs(prev => prev.map(t => t.id === activeTab.id
            ? { ...t, totalCount: total, estimated: isEmptyFilter(query.filter), countLoading: false }
            : t));
        } catch {
          setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, countLoading: false } : t));
        }
      }
    } catch (err: any) {
      setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, error: String(err), loading: false } : t));
    }
  };

  const handlePageChange = (newSkip: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || !tab.lastQuery) return;
    handleExecuteQuery({ ...tab.lastQuery, skip: Math.max(0, newSkip) });
  };

  const handlePageSizeChange = (newLimit: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || !tab.lastQuery) return;
    handleExecuteQuery({ ...tab.lastQuery, limit: newLimit, skip: 0 });
  };

  const handleExecuteAggregate = async (pipeline: Record<string, unknown>[]) => {
    if (!activeTab) return;

    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, loading: true, error: null } : t));

    try {
      const resultStrs = await invoke<string[]>('execute_aggregate', {
        id: activeTab.connectionId,
        database: activeTab.db,
        collection: activeTab.collection,
        pipeline: JSON.stringify(pipeline),
      });

      const parsedResults = resultStrs.map(s => JSON.parse(s));
      setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, results: parsedResults, loading: false, lastAggregate: pipeline } : t));
      recordHistory(connectionNameFor(activeTab.connectionId), activeTab.db, activeTab.collection, {
        queryType: 'aggregate',
        pipeline,
      }).catch(() => {});
    } catch (err: any) {
      setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, error: String(err), loading: false } : t));
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

  const [documentModal, setDocumentModal] = useState<
    { mode: 'insert' | 'edit'; initialJson: string; targetDoc: Record<string, any> | null } | null
  >(null);

  const handleInsertDocument = () => {
    setDocumentModal({ mode: 'insert', initialJson: '{\n  \n}', targetDoc: null });
  };

  const handleExportForTab = async (
    targetTab: QueryTab | null,
    format: 'json' | 'csv',
    scope: 'current' | 'full' = 'current'
  ) => {
    if (!targetTab || (targetTab.type !== 'collection' && targetTab.type !== 'export')) return;
    const docs = targetTab.type === 'collection' ? targetTab.results || [] : [];
    if (scope === 'current' && docs.length === 0) return;
    try {
      const path = await save({
        defaultPath: `${targetTab.collection}${scope === 'full' ? '.full' : ''}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path) return; // cancelled
      if (scope === 'full') {
        const task = await invoke<ExportTaskInfo>('start_collection_export', {
          id: targetTab.connectionId,
          database: targetTab.db,
          collection: targetTab.collection,
          format,
          path,
        });
        setExportTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
        await loadExportTasks();
        return;
      }

      const content = format === 'json' ? toJson(docs) : toCsv(docs);
      await writeTextFile(path, content);
      toast(`Exported ${docs.length} document(s) to ${path}`, 'success');
    } catch (err: any) {
      toast(`Export failed: ${err?.message || err}`, 'error');
    }
  };

  const handleImport = async () => {
    if (!activeTab || activeTab.type !== 'collection') return;
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: 'Data', extensions: ['json', 'csv'] }],
      });
      if (!path || typeof path !== 'string') return; // cancelled
      const text = await readTextFile(path);
      // Parse by extension; a malformed file aborts before any write.
      let docs: Record<string, any>[];
      try {
        docs = path.toLowerCase().endsWith('.csv') ? parseCsv(text) : parseJson(text);
      } catch (parseErr: any) {
        toast(`Import aborted — could not parse file: ${parseErr?.message || parseErr}`, 'error');
        return;
      }
      if (docs.length === 0) {
        toast('Nothing to import: the file has no documents.', 'error');
        return;
      }
      // Choose the duplicate-handling mode.
      const mode = await choose({
        title: `Import ${docs.length} document(s)`,
        message: 'How should existing documents with the same _id be handled?',
        choices: [
          { value: 'skip', label: 'Skip duplicates (insert new only)' },
          { value: 'update', label: 'Update existing by _id' },
          { value: 'abort', label: 'Abort if any _id already exists', destructive: true },
        ],
      });
      if (!mode) return; // cancelled
      const res = await invoke<{ inserted: number; updated: number; skipped: number }>(
        'import_documents',
        {
          id: activeTab.connectionId,
          database: activeTab.db,
          collection: activeTab.collection,
          docs,
          mode,
        }
      );
      await refreshTabResults(activeTab);
      toast(`Imported: ${res.inserted} inserted, ${res.updated} updated, ${res.skipped} skipped`, 'success');
    } catch (err: any) {
      toast(`Import failed: ${err?.message || err}`, 'error');
    }
  };

  const handleEditDocument = (doc: Record<string, any>) => {
    setDocumentModal({ mode: 'edit', initialJson: docToShell(doc), targetDoc: doc });
  };

  // Duplicate: open the insert modal pre-filled with the document minus its _id.
  const handleDuplicateDocument = (doc: Record<string, any>) => {
    const { _id, ...rest } = doc;
    setDocumentModal({ mode: 'insert', initialJson: docToShell(rest), targetDoc: null });
  };

  const handleDeleteDocument = async (doc: Record<string, any>) => {
    if (!activeTab) return;
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
        id: activeTab.connectionId,
        database: activeTab.db,
        collection: activeTab.collection,
        filter: JSON.stringify({ _id: doc._id }),
      });
      await refreshTabResults(activeTab);
      toast(`Document deleted from ${activeTab.collection}`, 'success', { title: 'Deleted' });
    } catch (err: any) {
      toast(`Failed to delete document: ${err}`, 'error');
    }
  };

  // M7: bulk operations on the active collection's current query filter.
  const bulkFilter = () => activeTab?.lastQuery?.filter?.trim() || '{}';
  const isEmptyFilterStr = (f: string) => {
    try { return Object.keys(JSON.parse(f)).length === 0; } catch { return false; }
  };
  const bulkConfirmMessage = (verb: string, count: number, filter: string) => {
    const base = `${verb} ${count} document(s) matching:\n${filter}`;
    return isEmptyFilterStr(filter)
      ? `${base}\n\n⚠ This affects ALL ${count} documents in the collection.`
      : base;
  };

  const handleDeleteMany = async () => {
    if (!activeTab || activeTab.type !== 'collection') return;
    const filter = bulkFilter();
    try {
      const count = await invoke<number>('count_documents', {
        id: activeTab.connectionId,
        database: activeTab.db,
        collection: activeTab.collection,
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
        id: activeTab.connectionId,
        database: activeTab.db,
        collection: activeTab.collection,
        filter,
      });
      await refreshTabResults(activeTab);
      toast(`Deleted ${deleted} document(s)`, 'success', { title: 'Deleted' });
    } catch (err: any) {
      toast(`Delete failed: ${err?.message || err}`, 'error');
    }
  };

  const handleUpdateMany = async () => {
    if (!activeTab || activeTab.type !== 'collection') return;
    const filter = bulkFilter();
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
        id: activeTab.connectionId,
        database: activeTab.db,
        collection: activeTab.collection,
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
        id: activeTab.connectionId,
        database: activeTab.db,
        collection: activeTab.collection,
        filter,
        update,
      });
      await refreshTabResults(activeTab);
      toast(`Modified ${modified} document(s)`, 'success', { title: 'Updated' });
    } catch (err: any) {
      toast(`Update failed: ${err?.message || err}`, 'error');
    }
  };

  const handleSaveDocument = async (json: string) => {
    if (!activeTab || !documentModal) return;
    const collection = activeTab.collection;
    if (documentModal.mode === 'insert') {
      await invoke('insert_document', {
        id: activeTab.connectionId,
        database: activeTab.db,
        collection,
        document: json,
      });
      setDocumentModal(null);
      await refreshTabResults(activeTab);
      toast(`Document inserted into ${collection}`, 'success', { title: 'Inserted' });
      return;
    }

    const target = documentModal.targetDoc;
    if (!target || target._id === undefined) {
      throw new Error('Cannot update: this document has no _id.');
    }
    await invoke('update_document', {
      id: activeTab.connectionId,
      database: activeTab.db,
      collection,
      filter: JSON.stringify({ _id: target._id }),
      replacement: json,
    });
    setDocumentModal(null);
    await refreshTabResults(activeTab);
    toast(`Document saved in ${collection}`, 'success', { title: 'Saved' });
  };

  const handleExplainQuery = async (filter: string): Promise<string> => {
    if (!activeTab) throw new Error("No active tab");
    const plan = await invoke<string>('explain_mql_query', {
      id: activeTab.connectionId,
      database: activeTab.db,
      collection: activeTab.collection,
      filter
    });
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, explainResult: plan } : t));
    return plan;
  };

  // M1: explain the full aggregation pipeline (not just its $match stage).
  const handleExplainAggregate = async (pipeline: string): Promise<string> => {
    if (!activeTab) throw new Error("No active tab");
    const plan = await invoke<string>('explain_aggregate_query', {
      id: activeTab.connectionId,
      database: activeTab.db,
      collection: activeTab.collection,
      pipeline
    });
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, explainResult: plan } : t));
    return plan;
  };

  const availableFields = React.useMemo(() => {
    if (!activeTab || activeTab.type !== 'collection' || !activeTab.results || activeTab.results.length === 0) {
      return ['_id'];
    }
    const keys = new Set<string>();
    activeTab.results.forEach(doc => {
      if (doc && typeof doc === 'object') {
        Object.keys(doc).forEach(k => keys.add(k));
      }
    });
    keys.add('_id');
    return Array.from(keys).sort((a, b) => {
      if (a === '_id') return -1;
      if (b === '_id') return 1;
      return a.localeCompare(b);
    });
  }, [activeTab?.results, activeTab?.type]);

  const workspaceTabs = React.useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tabLabelFor(tab, connectionNameFor),
        icon: tabIconFor(tab, tab.id === activeTabId),
      })),
    [tabs, activeTabId, activeConnections]
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
          onCreateView={handleOpenCreateViewTab}
          onOpenGridfs={handleOpenGridfsTab}
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
            setTabs(prev => {
              const updated = prev.filter(t => t.connectionId !== connId);
              if (activeTabId && prev.find(t => t.id === activeTabId)?.connectionId === connId) {
                if (updated.length > 0) {
                  setActiveTabId(updated[updated.length - 1].id);
                } else {
                  setActiveTabId(null);
                }
              }
              return updated;
            });
          }}
          onOpenSettings={handleOpenSettingsTab}
        />
      }
      sidebarWidth={sidebarWidth}
      onResizeStart={startResizing}
      tabBar={
        tabs.length > 0 ? (
          <WorkspaceTabBar
            tabs={workspaceTabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={closeTabById}
          />
        ) : null
      }
      statusBar={
        <StatusBar
          cpu={resUsage ? `${resUsage.cpu_percent.toFixed(0)}%` : undefined}
          memory={resUsage ? formatBytes(resUsage.memory_bytes) : undefined}
          mongoVersion={mongoVersion ?? undefined}
          appVersion={appVersion ? `v${appVersion}` : undefined}
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
              addActiveConnection(id, name, uri, profileId, colorTag);
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
            availableFields={availableFields}
            initialData={indexModalTarget?.initialData}
          />

          <DocumentEditModal
            isOpen={documentModal !== null}
            mode={documentModal?.mode || 'insert'}
            initialJson={documentModal?.initialJson || '{}'}
            onClose={() => setDocumentModal(null)}
            onSave={handleSaveDocument}
          />

          <UpdatePrompt />
        </>
      }
    >
      {tabs.length > 0 ? (
        <>
              {activeTab && activeTab.type === 'index' && (
                <IndexViewer
                  connectionId={activeTab.connectionId}
                  databaseName={activeTab.db}
                  collectionName={activeTab.collection}
                  indexName={activeTab.indexName || ''}
                  onEditIndex={(indexName, keys, unique, sparse) => 
                    handleOpenIndexModalForEdit(
                      activeTab.connectionId,
                      activeTab.db,
                      activeTab.collection,
                      indexName,
                      keys,
                      unique,
                      sparse
                    )
                  }
                  onDeleteIndex={(indexName) => 
                    handleDeleteIndex(
                      activeTab.connectionId,
                      activeTab.db,
                      activeTab.collection,
                      indexName
                    )
                  }
                />
              )}
              {activeTab && activeTab.type === 'collection' && (() => {
                const activeConnection = activeConnections.find(c => c.id === activeTab.connectionId);
                const connectionName = activeConnection ? activeConnection.name : 'cmi-dev';
                const connectionUser = activeConnection ? usernameFromUri(activeConnection.uri) : '';
                return (
                  <DocumentViewer
                    connectionId={activeTab.connectionId}
                    connectionName={connectionName}
                    connectionUser={connectionUser}
                    databaseName={activeTab.db}
                    collectionName={activeTab.collection}
                    onExecute={handleExecuteQuery}
                    onExecuteAggregate={handleExecuteAggregate}
                    onExplain={handleExplainQuery}
                    onExplainAggregate={handleExplainAggregate}
                    onOpenShell={(command) => handleOpenShell(activeTab.connectionId, activeTab.db, activeTab.collection, command)}
                    onOpenExport={() => handleOpenExportTab(activeTab)}
                    onImport={handleImport}
                    loading={activeTab.loading}
                    availableFields={availableFields}
                  >
                    <div className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
                      {activeTab.error && (
                        <div className="p-3 bg-destructive/10 border-b border-border text-destructive font-mono text-xs select-text flex items-start gap-2">
                          <span className="flex-grow">Error loading dataset: {activeTab.error}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            title="Copy error message"
                            onClick={() => { try { navigator.clipboard?.writeText(String(activeTab.error)); } catch { /* clipboard unavailable */ } }}
                          >
                            <Copy size={11} />
                            Copy
                          </Button>
                        </div>
                      )}
                      {activeTab.loading ? (
                        <div className="flex-grow flex items-center justify-center text-muted-foreground bg-background">
                          <div className="flex flex-col items-center gap-2 select-none">
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary"></div>
                            <span className="text-xs">Streaming documents asynchronously...</span>
                          </div>
                        </div>
                      ) : (
                        <DataGrid
                          documents={activeTab.results}
                          density={density}
                          explainResult={activeTab.explainResult}
                          querySpec={buildTabQuerySpec(activeTab)}
                          onInsertDocument={handleInsertDocument}
                          onEditDocument={handleEditDocument}
                          onDuplicateDocument={handleDuplicateDocument}
                          onDeleteDocument={handleDeleteDocument}
                          onAnalyzeSchema={() => handleOpenSchemaTab(activeTab.connectionId, activeTab.db, activeTab.collection)}
                          onUpdateMany={handleUpdateMany}
                          onDeleteMany={handleDeleteMany}
                          totalCount={activeTab.totalCount}
                          estimated={activeTab.estimated}
                          countLoading={activeTab.countLoading}
                          skip={activeTab.lastQuery?.skip ?? 0}
                          limit={activeTab.lastQuery?.limit ?? 50}
                          {...(!activeTab.lastAggregate ? {
                            onPageChange: handlePageChange,
                            onPageSizeChange: handlePageSizeChange,
                          } : {})}
                        />
                      )}
                    </div>
                  </DocumentViewer>
                );
              })()}
              {activeTab && activeTab.type === 'schema' && (
                <SchemaView
                  connectionId={activeTab.connectionId}
                  databaseName={activeTab.db}
                  collectionName={activeTab.collection}
                />
              )}
              {activeTab && activeTab.type === 'create-view' && (
                <CreateViewView
                  connectionId={activeTab.connectionId}
                  databaseName={activeTab.db}
                  onCreated={(viewName) => {
                    setCollectionMutationTrigger(prev => prev + 1);
                    handleSelectCollection(activeTab.connectionId, activeTab.db, viewName);
                  }}
                />
              )}
              {activeTab && activeTab.type === 'gridfs' && (
                <GridFsView
                  connectionId={activeTab.connectionId}
                  databaseName={activeTab.db}
                  bucket={activeTab.collection}
                />
              )}
              {activeTab && activeTab.type === 'monitoring' && (
                <MonitoringView connectionId={activeTab.connectionId} />
              )}
              {activeTab && activeTab.type === 'users' && (
                <UserManagementView connectionId={activeTab.connectionId} database={activeTab.db || undefined} />
              )}
              {activeTab && activeTab.type === 'export' && (() => {
                const activeConnection = activeConnections.find(c => c.id === activeTab.connectionId);
                const connectionName = activeConnection ? activeConnection.name : activeTab.connectionId;
                const sourceTab =
                  tabs.find(t => t.id === activeTab.exportSourceTabId && t.type === 'collection') ||
                  tabs.find(t =>
                    t.type === 'collection' &&
                    t.connectionId === activeTab.connectionId &&
                    t.db === activeTab.db &&
                    t.collection === activeTab.collection
                  ) ||
                  null;
                return (
                  <ExportView
                    connectionName={connectionName}
                    databaseName={activeTab.db}
                    collectionName={activeTab.collection}
                    currentResultCount={sourceTab?.results.length || 0}
                    tasks={exportTasks}
                    onExport={(format, scope) => handleExportForTab(sourceTab || activeTab, format, scope)}
                    onRefreshTasks={loadExportTasks}
                    onClearFinishedTasks={handleClearFinishedTasks}
                  />
                );
              })()}
              {activeTab && activeTab.type === 'shell' && (() => {
                const activeConnection = activeConnections.find(c => c.id === activeTab.connectionId);
                const connectionName = activeConnection ? activeConnection.name : activeTab.connectionId;
                return (
                  <MongoShell
                    key={`${activeTab.id}:${activeTab.initialShellCommand || ''}`}
                    connectionId={activeTab.connectionId}
                    connectionName={connectionName}
                    connectionUri={activeConnection?.uri || ''}
                    databaseName={activeTab.db}
                    collectionName={activeTab.collection || undefined}
                    initialCommand={activeTab.initialShellCommand}
                    density={density}
                    onOpenSettings={handleOpenSettingsTab}
                  />
                );
              })()}
              {activeTab && activeTab.type === 'settings' && (
                <SettingsView />
              )}
              {activeTab && activeTab.type === 'quickstart' && (
                <QuickStart
                  onConnect={() => setIsConnectionModalOpen(true)}
                  onOpenSettings={handleOpenSettingsTab}
                  onQuickConnect={handleQuickConnect}
                  onLoadSampleData={handleLoadSampleData}
                  activeConnections={activeConnections}
                  profilesRefreshKey={profilesRefreshKey}
                />
              )}
        </>
      ) : (
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
      )}
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
