import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useDialogs } from './dialogs/DialogProvider';
import { fuzzyMatch } from '../lib/fuzzyMatch';
import {
  type FolderNode,
  FOLDERS_CHANGED_EVENT,
  loadConnectionFolders,
} from '../lib/connectionFolders';
import {
  type PinnedItem,
  PINNED_CHANGED_EVENT,
  loadPinnedCollections,
  isItemPinned,
  togglePinItem,
  unpinItem,
  pinnedItemLabel,
  pinnedItemSubtitle,
  pinnedItemKey,
} from '../lib/pinnedCollections';
import {
  type FavoriteItem,
  FAVORITES_CHANGED_EVENT,
  loadFavoriteItems,
  isItemFavorited,
  toggleFavoriteItem,
  removeFavoriteItem,
  favoriteItemLabel,
  favoriteItemSubtitle,
  favoriteItemKey,
} from '../lib/favoriteItems';
import {
  listAllSavedQueries,
  QUERIES_CHANGED_EVENT,
  type SavedQueryBody,
  type SavedQueryRef,
} from '../lib/queryStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ThemePicker } from '@/components/theme/ThemePicker';
import {
  Database,
  Folder,
  FolderOpen,
  Server,
  RefreshCw,
  Trash2,
  Plus,
  LogOut,
  Layers,
  KeyRound,
  ChevronRight,
  Settings,
  Terminal,
  Eye,
  Archive,
  Cog,
  Pencil,
  Table2,
  Activity,
  Users,
  Search,
  HelpCircle,
  Bug,
  Lightbulb,
  Star,
  BookOpen,
  X,
  Pin,
  Heart,
} from 'lucide-react';

const REPO_URL = 'https://github.com/mqlens/mqlens-mongodb';
const HELP_LINKS = [
  { Icon: Bug, label: 'Report a bug', url: `${REPO_URL}/issues/new?template=bug_report.yml` },
  { Icon: Lightbulb, label: 'Request a feature', url: `${REPO_URL}/issues/new?template=feature_request.yml` },
  { Icon: BookOpen, label: 'Documentation', url: 'https://mqlens.com/docs/' },
  { Icon: Star, label: 'Star on GitHub', url: `${REPO_URL}/stargazers` },
];

// Mirrors the backend CollectionInfo struct returned by `list_collections`.
export interface CollectionInfo {
  name: string;
  type: 'collection' | 'view' | 'timeseries' | string;
}

// Mirrors the backend IndexInfo struct returned by `list_indexes`.
// `keys` is a JSON string of the real key pattern, e.g. '{"email":1}'.
export interface IndexInfo {
  name: string;
  keys: string;
  unique: boolean;
  sparse: boolean;
}

const compareCollectionNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

interface ConnectionProfile {
  id: string;
  name: string;
  uri: string;
  color_tag?: string;
}

interface SidebarProps {
  onSelectCollection: (
    connectionId: string,
    dbName: string,
    collName: string,
    savedQuery?: SavedQueryBody,
  ) => void;
  onSelectIndex: (connectionId: string, dbName: string, collName: string, indexName: string) => void;
  activeCollection: { connectionId: string; db: string; collection: string; indexName?: string } | null;
  activeConnections: { id: string; name: string; uri: string; color_tag?: string }[];
  onOpenConnectionManager: () => void;
  onDisconnect: (connectionId: string) => void;
  width?: number;
  onOpenSettings: () => void;
  onCreateIndex?: (connectionId: string, dbName: string, collName: string) => void;
  onDeleteIndex?: (connectionId: string, dbName: string, collName: string, indexName: string) => void;
  onOpenShell?: (connectionId: string, dbName: string, collName?: string, initialCommand?: string) => void;
  onOpenMonitoring?: (connectionId: string) => void;
  onOpenUsers?: (connectionId: string, db?: string) => void;
  onAnalyzeSchema?: (connectionId: string, dbName: string, collName: string) => void;
  onCreateView?: (connectionId: string, dbName: string) => void;
  onOpenGridfs?: (connectionId: string, dbName: string, bucket: string) => void;
  onCollectionRenamed?: (connectionId: string, dbName: string, oldName: string, newName: string) => void;
  onDatabaseDropped?: (connectionId: string, dbName: string) => void;
  onDatabaseRenamed?: (connectionId: string, oldName: string, newName: string) => void;
  onNamespaceMutated?: (connectionId?: string) => void;
  onFilterQueryChange?: (query: string) => void;
  indexMutationTrigger?: number;
  collectionMutationTrigger?: number;
  onConnectProfile?: (profile: ConnectionProfile) => Promise<string | null> | string | null;
  profilesRefreshKey?: number;
}

const treeRowClass = (active?: boolean) =>
  cn(
    'flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-xs transition-colors hover:bg-accent/80',
    active && 'bg-accent font-medium text-primary',
  );

const sectionEmptyClass = 'px-3 py-2 text-[10px] italic text-muted-foreground';

const ctxItemClass = 'gap-2 text-xs [&_svg]:size-3';

function SidebarSection({
  title,
  icon: Icon,
  open,
  onOpenChange,
  children,
  emptyText,
  isEmpty = false,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: React.ReactNode;
  emptyText?: string;
  isEmpty?: boolean;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/50">
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <Icon className="h-3 w-3 shrink-0" />
        <span>{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:hidden">
        {isEmpty
          ? emptyText
            ? <p className={sectionEmptyClass}>{emptyText}</p>
            : null
          : children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function EmptySpaceContextMenu({
  children,
  onNewConnection,
  onSettings,
}: {
  children: React.ReactNode;
  onNewConnection: () => void;
  onSettings: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem className={ctxItemClass} onClick={onNewConnection}>
          <Plus />
          <span>New Connection</span>
        </ContextMenuItem>
        <ContextMenuItem className={ctxItemClass} onClick={onSettings}>
          <Settings />
          <span>Settings</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const Sidebar: React.FC<SidebarProps> = ({
  onSelectCollection,
  onSelectIndex,
  activeCollection,
  activeConnections,
  onOpenConnectionManager,
  onDisconnect,
  width,
  onOpenSettings,
  onCreateIndex,
  onDeleteIndex,
  onOpenShell,
  onOpenMonitoring,
  onOpenUsers,
  onAnalyzeSchema,
  onCreateView,
  onOpenGridfs,
  onCollectionRenamed,
  onDatabaseDropped,
  onDatabaseRenamed,
  onNamespaceMutated,
  onFilterQueryChange,
  indexMutationTrigger,
  collectionMutationTrigger,
  onConnectProfile,
  profilesRefreshKey = 0,
}) => {
  const { toast, confirm, prompt } = useDialogs();
  const [filterQuery, setFilterQuery] = useState('');
  useEffect(() => {
    onFilterQueryChange?.(filterQuery);
  }, [filterQuery, onFilterQueryChange]);

  const [sectionsOpen, setSectionsOpen] = useState({
    connections: true,
    pinned: false,
    favorites: false,
    folders: false,
  });

  const [databases, setDatabases] = useState<{ [connectionId: string]: string[] }>({});
  const [collections, setCollections] = useState<{ [connectionDbKey: string]: CollectionInfo[] }>({});
  const [indexes, setIndexes] = useState<{ [connectionDbCollKey: string]: IndexInfo[] }>({});

  const [expandedConnections, setExpandedConnections] = useState<{ [connectionId: string]: boolean }>({});
  const [expandedDbs, setExpandedDbs] = useState<{ [connectionDbKey: string]: boolean }>({});
  const [expandedCollectionsFolders, setExpandedCollectionsFolders] = useState<{ [connectionDbFolderKey: string]: boolean }>({});
  const [expandedCollections, setExpandedCollections] = useState<{ [connectionDbCollKey: string]: boolean }>({});
  const [expandedIndexesFolders, setExpandedIndexesFolders] = useState<{ [connectionDbCollKey: string]: boolean }>({});

  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>(() => loadPinnedCollections());
  const [favoriteItems, setFavoriteItems] = useState<FavoriteItem[]>(() => loadFavoriteItems());
  const [savedQueryCatalog, setSavedQueryCatalog] = useState<SavedQueryRef[]>([]);
  const [connectionProfiles, setConnectionProfiles] = useState<ConnectionProfile[]>([]);
  const [connectionFolders, setConnectionFolders] = useState<FolderNode[]>([]);
  const [profileFolderMap, setProfileFolderMap] = useState<Record<string, string>>({});
  const [expandedProfileFolders, setExpandedProfileFolders] = useState<Record<string, boolean>>({
    'local-resources': true,
  });

  const connectionIdForName = (name: string): string | null =>
    activeConnections.find((c) => c.name === name)?.id ?? null;

  const ensureConnection = async (connectionName: string): Promise<string | null> => {
    const existing = connectionIdForName(connectionName);
    if (existing) return existing;

    const profile = connectionProfiles.find((p) => p.name === connectionName);
    if (!profile || !onConnectProfile) {
      toast(
        `No saved connection "${connectionName}". Add it in Connection Manager, then try again.`,
        'error',
      );
      return null;
    }

    toast(`Connecting to ${connectionName}…`, 'info');
    const connId = await onConnectProfile(profile);
    if (connId) return connId;

    toast(`Could not connect to ${connectionName}`, 'error');
    return null;
  };

  const openCollectionTarget = async (
    connectionName: string,
    db: string,
    collection: string,
    savedQuery?: SavedQueryBody,
  ) => {
    const connId = await ensureConnection(connectionName);
    if (!connId) return;
    onSelectCollection(connId, db, collection, savedQuery);
  };

  const reloadPinned = () => setPinnedItems(loadPinnedCollections());
  const reloadFavoritesStorage = () => setFavoriteItems(loadFavoriteItems());

  const reloadFolders = () => {
    const { folders, profileFolderMap: map } = loadConnectionFolders();
    setConnectionFolders(folders);
    setProfileFolderMap(map);
  };

  const reloadSavedQueryCatalog = async () => {
    try {
      setSavedQueryCatalog(await listAllSavedQueries());
    } catch {
      setSavedQueryCatalog([]);
    }
  };

  useEffect(() => {
    reloadPinned();
    const onPinned = () => reloadPinned();
    window.addEventListener(PINNED_CHANGED_EVENT, onPinned);
    return () => window.removeEventListener(PINNED_CHANGED_EVENT, onPinned);
  }, []);

  useEffect(() => {
    reloadFavoritesStorage();
    const onFavorites = () => reloadFavoritesStorage();
    window.addEventListener(FAVORITES_CHANGED_EVENT, onFavorites);
    return () => window.removeEventListener(FAVORITES_CHANGED_EVENT, onFavorites);
  }, []);

  useEffect(() => {
    void reloadSavedQueryCatalog();
    const onQueries = () => void reloadSavedQueryCatalog();
    window.addEventListener(QUERIES_CHANGED_EVENT, onQueries);
    return () => window.removeEventListener(QUERIES_CHANGED_EVENT, onQueries);
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<ConnectionProfile[]>('load_connection_profiles')
      .then((list) => { if (alive) setConnectionProfiles(list ?? []); })
      .catch(() => { if (alive) setConnectionProfiles([]); });
    reloadFolders();
    return () => { alive = false; };
  }, [profilesRefreshKey]);

  useEffect(() => {
    const onFolders = () => reloadFolders();
    window.addEventListener(FOLDERS_CHANGED_EVENT, onFolders);
    return () => window.removeEventListener(FOLDERS_CHANGED_EVENT, onFolders);
  }, []);

  const ensureConnectionExpanded = (connId: string) => {
    setSectionsOpen((s) => ({ ...s, connections: true }));
    setExpandedConnections((prev) => ({ ...prev, [connId]: true }));
  };

  const ensureDbExpanded = async (connId: string, dbName: string) => {
    const key = `${connId}/${dbName}`;
    setExpandedDbs((prev) => ({ ...prev, [key]: true }));
    if (!collections[key]) {
      try {
        const colls = await invoke<CollectionInfo[]>('list_collections', { id: connId, db: dbName });
        setCollections((prev) => ({ ...prev, [key]: colls }));
      } catch (err) {
        console.error(`Failed to load collections for database ${dbName}`, err);
      }
    }
  };

  const navigateToPinned = async (item: PinnedItem) => {
    const connId = await ensureConnection(item.connectionName);
    if (!connId) return;
    ensureConnectionExpanded(connId);
    if (item.kind === 'connection') return;
    await ensureDbExpanded(connId, item.db!);
    if (item.kind === 'database') return;
    onSelectCollection(connId, item.db!, item.collection!);
  };

  const navigateToFavorite = async (item: FavoriteItem) => {
    if (item.kind === 'query') {
      const resolved = savedQueryCatalog.find(
        (q) =>
          q.connectionName === item.connectionName &&
          q.db === item.db &&
          q.collection === item.collection &&
          q.id === item.queryId,
      );
      if (!resolved) {
        toast('Saved query no longer exists', 'info');
        return;
      }
      await openCollectionTarget(
        resolved.connectionName,
        resolved.db,
        resolved.collection,
        resolved.query,
      );
      return;
    }
    const connId = await ensureConnection(item.connectionName);
    if (!connId) return;
    ensureConnectionExpanded(connId);
    if (item.kind === 'connection') return;
    await ensureDbExpanded(connId, item.db!);
    if (item.kind === 'database') return;
    onSelectCollection(connId, item.db!, item.collection!);
  };

  const pinEntryForConnection = (connId: string): PinnedItem | null => {
    const conn = activeConnections.find((c) => c.id === connId);
    if (!conn) return null;
    return { kind: 'connection', connectionName: conn.name };
  };

  const favoriteEntryForConnection = (connId: string): FavoriteItem | null => {
    const conn = activeConnections.find((c) => c.id === connId);
    if (!conn) return null;
    return { kind: 'connection', connectionName: conn.name };
  };

  const handleTogglePin = (entry: PinnedItem) => {
    try {
      const wasPinned = isItemPinned(pinnedItems, entry);
      const next = togglePinItem(pinnedItems, entry);
      setPinnedItems(next);
      if (!wasPinned) {
        setSectionsOpen((s) => ({ ...s, pinned: true }));
      }
      toast(wasPinned ? 'Unpinned from sidebar' : 'Pinned to sidebar', wasPinned ? 'info' : 'success');
    } catch {
      toast('Could not update pinned items', 'error');
    }
  };

  const handleToggleFavorite = (entry: FavoriteItem) => {
    try {
      const wasFav = isItemFavorited(favoriteItems, entry);
      const next = toggleFavoriteItem(favoriteItems, entry);
      setFavoriteItems(next);
      if (!wasFav) {
        setSectionsOpen((s) => ({ ...s, favorites: true }));
      }
      toast(wasFav ? 'Removed from favorites' : 'Added to favorites', wasFav ? 'info' : 'success');
    } catch {
      toast('Could not update favorites', 'error');
    }
  };

  const pinMenuLabel = (entry: PinnedItem): string =>
    isItemPinned(pinnedItems, entry) ? 'Unpin from sidebar' : 'Pin to sidebar';

  const favoriteMenuLabel = (entry: FavoriteItem): string =>
    isItemFavorited(favoriteItems, entry) ? 'Remove from favorites' : 'Add to favorites';

  const toggleIndexesFolder = (connectionId: string, dbName: string, collName: string) => {
    const key = `${connectionId}/${dbName}/${collName}`;
    setExpandedIndexesFolders((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    activeConnections.forEach((conn) => {
      if (!databases[conn.id]) {
        loadDatabases(conn.id);
      }
      setExpandedConnections((prev) => {
        if (prev[conn.id] === undefined) {
          return { ...prev, [conn.id]: true };
        }
        return prev;
      });
    });

    setDatabases((prev) => {
      const next = { ...prev };
      let changed = false;
      Object.keys(next).forEach((key) => {
        if (!activeConnections.some((c) => c.id === key)) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [activeConnections]);

  useEffect(() => {
    if (indexMutationTrigger) {
      Object.keys(expandedCollections).forEach(async (collKey) => {
        if (expandedCollections[collKey]) {
          const parts = collKey.split('/');
          if (parts.length === 3) {
            const [connectionId, dbName, collName] = parts;
            try {
              const idxs = await invoke<IndexInfo[]>('list_indexes', {
                id: connectionId,
                db: dbName,
                collection: collName,
              });
              setIndexes((prev) => ({ ...prev, [collKey]: idxs }));
            } catch (err) {
              console.error(`Failed to re-fetch indexes for ${collName}`, err);
            }
          }
        }
      });
    }
  }, [indexMutationTrigger]);

  useEffect(() => {
    if (collectionMutationTrigger) {
      Object.keys(expandedDbs).forEach((dbKey) => {
        if (expandedDbs[dbKey]) {
          const slash = dbKey.indexOf('/');
          if (slash > 0) {
            const connectionId = dbKey.slice(0, slash);
            const dbName = dbKey.slice(slash + 1);
            handleRefreshDb(connectionId, dbName);
          }
        }
      });
    }
  }, [collectionMutationTrigger]);

  const loadDatabases = async (connectionId: string) => {
    try {
      const dbs = await invoke<string[]>('list_databases', { id: connectionId });
      setDatabases((prev) => ({ ...prev, [connectionId]: dbs }));
    } catch (err) {
      console.error(`Failed to load databases for connection ${connectionId}`, err);
    }
  };

  const toggleDb = async (connectionId: string, dbName: string) => {
    const key = `${connectionId}/${dbName}`;
    const isExpanding = !expandedDbs[key];
    setExpandedDbs((prev) => ({ ...prev, [key]: !prev[key] }));

    if (isExpanding && !collections[key]) {
      try {
        const colls = await invoke<CollectionInfo[]>('list_collections', { id: connectionId, db: dbName });
        setCollections((prev) => ({ ...prev, [key]: colls }));
      } catch (err) {
        console.error(`Failed to load collections for database ${dbName}`, err);
      }
    }
  };

  const toggleCollectionsFolder = async (connectionId: string, dbName: string) => {
    const folderKey = `${connectionId}/${dbName}/collections`;
    const isCurrentlyExpanded = expandedCollectionsFolders[folderKey];
    setExpandedCollectionsFolders((prev) => ({ ...prev, [folderKey]: !prev[folderKey] }));

    const collsKey = `${connectionId}/${dbName}`;
    if (!isCurrentlyExpanded && !collections[collsKey]) {
      try {
        const colls = await invoke<CollectionInfo[]>('list_collections', { id: connectionId, db: dbName });
        setCollections((prev) => ({ ...prev, [collsKey]: colls }));
      } catch (err) {
        console.error(`Failed to load collections for database ${dbName}`, err);
      }
    }
  };

  const toggleVirtualFolder = (key: string) => {
    setExpandedCollectionsFolders((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleCollectionNode = async (connectionId: string, dbName: string, collName: string) => {
    const collKey = `${connectionId}/${dbName}/${collName}`;
    const isCurrentlyExpanded = expandedCollections[collKey];
    setExpandedCollections((prev) => ({ ...prev, [collKey]: !prev[collKey] }));

    if (!isCurrentlyExpanded && !indexes[collKey]) {
      try {
        const idxs = await invoke<IndexInfo[]>('list_indexes', {
          id: connectionId,
          db: dbName,
          collection: collName,
        });
        setIndexes((prev) => ({ ...prev, [collKey]: idxs }));
      } catch (err) {
        console.error(`Failed to load indexes for collection ${collName}`, err);
      }
    }
  };

  const handleRefreshDb = async (connectionId: string, dbName: string) => {
    const key = `${connectionId}/${dbName}`;
    try {
      const colls = await invoke<CollectionInfo[]>('list_collections', { id: connectionId, db: dbName });
      setCollections((prev) => ({ ...prev, [key]: colls }));
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddDatabase = async (connectionId: string) => {
    const name = await prompt({
      title: 'New database',
      message: 'Enter new database name:',
      placeholder: 'database name',
      validate: (v) => (v ? null : 'Name is required'),
    });
    if (!name) return;

    const conn = activeConnections.find((c) => c.id === connectionId);
    const isMock = connectionId.startsWith('mock') || conn?.uri.startsWith('mongodb://mock');

    if (isMock) {
      setDatabases((prev) => ({
        ...prev,
        [connectionId]: [...(prev[connectionId] || []), name],
      }));
      onNamespaceMutated?.(connectionId);
      return;
    }

    const firstColl = await prompt({
      title: 'Initial collection',
      message: 'Database needs an initial collection. Enter its name:',
      defaultValue: 'collection',
      validate: (v) => (v ? null : 'Name is required'),
    });
    if (!firstColl) return;
    try {
      await invoke('create_collection', { id: connectionId, database: name, collection: firstColl });
      await loadDatabases(connectionId);
      onNamespaceMutated?.(connectionId);
    } catch (err) {
      toast(`Failed to create database: ${err}`, 'error');
    }
  };

  const handleAddCollection = async (connectionId: string, dbName: string) => {
    const name = await prompt({
      title: 'New collection',
      message: 'Enter new collection name:',
      placeholder: 'collection name',
      validate: (v) => (v ? null : 'Name is required'),
    });
    if (!name) return;

    const conn = activeConnections.find((c) => c.id === connectionId);
    const isMock = connectionId.startsWith('mock') || conn?.uri.startsWith('mongodb://mock');

    if (isMock) {
      const key = `${connectionId}/${dbName}`;
      setCollections((prev) => ({
        ...prev,
        [key]: [...(prev[key] || []), { name, type: 'collection' }],
      }));
      onNamespaceMutated?.(connectionId);
      return;
    }

    try {
      await invoke('create_collection', { id: connectionId, database: dbName, collection: name });
      await handleRefreshDb(connectionId, dbName);
      onNamespaceMutated?.(connectionId);
    } catch (err) {
      toast(`Failed to create collection: ${err}`, 'error');
    }
  };

  const handleDropCollection = async (connectionId: string, dbName: string, collName: string) => {
    if (
      !(await confirm({
        title: 'Drop collection',
        message: `Are you sure you want to drop collection "${collName}"?`,
        confirmLabel: 'Drop',
        destructive: true,
      }))
    )
      return;
    const conn = activeConnections.find((c) => c.id === connectionId);
    const isMock = connectionId.startsWith('mock') || conn?.uri.startsWith('mongodb://mock');

    const clearActiveIfDropped = () => {
      if (
        activeCollection?.connectionId === connectionId &&
        activeCollection?.db === dbName &&
        activeCollection?.collection === collName
      ) {
        onSelectCollection('', '', '');
      }
    };

    if (isMock) {
      const key = `${connectionId}/${dbName}`;
      setCollections((prev) => ({
        ...prev,
        [key]: (prev[key] || []).filter((c) => c.name !== collName),
      }));
      clearActiveIfDropped();
      onNamespaceMutated?.(connectionId);
      return;
    }

    try {
      await invoke('drop_collection', { id: connectionId, database: dbName, collection: collName });
      clearActiveIfDropped();
      await handleRefreshDb(connectionId, dbName);
      onNamespaceMutated?.(connectionId);
    } catch (err) {
      toast(`Failed to drop collection: ${err}`, 'error');
    }
  };

  const handleRenameCollection = async (connectionId: string, dbName: string, collName: string) => {
    const newName = await prompt({
      title: 'Rename collection',
      message: 'Enter new collection name:',
      defaultValue: collName,
      validate: (v) => (v ? null : 'Name is required'),
    });
    if (!newName || newName === collName) return;

    const conn = activeConnections.find((c) => c.id === connectionId);
    const isMock = connectionId.startsWith('mock') || conn?.uri.startsWith('mongodb://mock');

    const applyLocalRename = () => {
      const dbKey = `${connectionId}/${dbName}`;
      const oldCollKey = `${connectionId}/${dbName}/${collName}`;
      const newCollKey = `${connectionId}/${dbName}/${newName}`;

      setCollections((prev) => ({
        ...prev,
        [dbKey]: (prev[dbKey] || []).map((c) => (c.name === collName ? { ...c, name: newName } : c)),
      }));
      setIndexes((prev) => {
        const next = { ...prev };
        if (next[oldCollKey]) {
          next[newCollKey] = next[oldCollKey];
          delete next[oldCollKey];
        }
        return next;
      });
      setExpandedCollections((prev) => {
        const next = { ...prev };
        if (oldCollKey in next) {
          next[newCollKey] = next[oldCollKey];
          delete next[oldCollKey];
        }
        return next;
      });
      setExpandedIndexesFolders((prev) => {
        const next = { ...prev };
        if (oldCollKey in next) {
          next[newCollKey] = next[oldCollKey];
          delete next[oldCollKey];
        }
        return next;
      });
      onCollectionRenamed?.(connectionId, dbName, collName, newName);
      onNamespaceMutated?.(connectionId);
    };

    if (isMock) {
      applyLocalRename();
      return;
    }

    try {
      await invoke('rename_collection', {
        id: connectionId,
        database: dbName,
        from: collName,
        to: newName,
      });
      applyLocalRename();
      await handleRefreshDb(connectionId, dbName);
    } catch (err) {
      toast(`Failed to rename collection: ${err}`, 'error');
    }
  };

  const handleDropDatabase = async (connectionId: string, dbName: string) => {
    if (
      !(await confirm({
        title: 'Drop database',
        message: `Are you sure you want to drop database "${dbName}"? This cannot be undone.`,
        confirmLabel: 'Drop',
        destructive: true,
      }))
    )
      return;
    const conn = activeConnections.find((c) => c.id === connectionId);
    const isMock = connectionId.startsWith('mock') || conn?.uri.startsWith('mongodb://mock');

    const clearLocalDatabase = () => {
      const dbKey = `${connectionId}/${dbName}`;
      setDatabases((prev) => ({
        ...prev,
        [connectionId]: (prev[connectionId] || []).filter((db) => db !== dbName),
      }));
      setCollections((prev) => {
        const next = { ...prev };
        delete next[dbKey];
        return next;
      });
      setIndexes((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((key) => {
          if (key.startsWith(`${connectionId}/${dbName}/`)) delete next[key];
        });
        return next;
      });
      setExpandedDbs((prev) => {
        const next = { ...prev };
        delete next[dbKey];
        return next;
      });
      setExpandedCollectionsFolders((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((key) => {
          if (key.startsWith(`${connectionId}/${dbName}/`)) delete next[key];
        });
        return next;
      });
      setExpandedCollections((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((key) => {
          if (key.startsWith(`${connectionId}/${dbName}/`)) delete next[key];
        });
        return next;
      });
      setExpandedIndexesFolders((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((key) => {
          if (key.startsWith(`${connectionId}/${dbName}/`)) delete next[key];
        });
        return next;
      });
      onDatabaseDropped?.(connectionId, dbName);
      onNamespaceMutated?.(connectionId);
    };

    if (isMock) {
      clearLocalDatabase();
      return;
    }

    try {
      await invoke('drop_database', { id: connectionId, database: dbName });
      clearLocalDatabase();
      await loadDatabases(connectionId);
    } catch (err) {
      toast(`Failed to drop database: ${err}`, 'error');
    }
  };

  const handleRenameDatabase = async (connectionId: string, dbName: string) => {
    const newName = await prompt({
      title: 'Rename database',
      message: 'Enter new database name:',
      defaultValue: dbName,
      validate: (v) => (v ? null : 'Name is required'),
    });
    if (!newName || newName === dbName) return;
    const ok = await confirm({
      title: `Rename database "${dbName}"`,
      message:
        `Rename database "${dbName}" to "${newName}"?\n\n` +
        `MongoDB does not support native database rename. MQLens will copy collections and indexes, verify document counts, then drop the source database.`,
      confirmLabel: 'Rename',
    });
    if (!ok) return;

    const conn = activeConnections.find((c) => c.id === connectionId);
    const isMock = connectionId.startsWith('mock') || conn?.uri.startsWith('mongodb://mock');

    const applyLocalRename = () => {
      const oldDbKey = `${connectionId}/${dbName}`;
      const newDbKey = `${connectionId}/${newName}`;
      setDatabases((prev) => ({
        ...prev,
        [connectionId]: (prev[connectionId] || []).map((db) => (db === dbName ? newName : db)),
      }));
      setCollections((prev) => {
        const next = { ...prev };
        if (next[oldDbKey]) {
          next[newDbKey] = next[oldDbKey];
          delete next[oldDbKey];
        }
        return next;
      });
      setIndexes((prev) => {
        const next: typeof prev = {};
        Object.entries(prev).forEach(([key, value]) => {
          const prefix = `${connectionId}/${dbName}/`;
          next[key.startsWith(prefix) ? `${connectionId}/${newName}/${key.slice(prefix.length)}` : key] = value;
        });
        return next;
      });
      setExpandedDbs((prev) => {
        const next = { ...prev };
        if (oldDbKey in next) {
          next[newDbKey] = next[oldDbKey];
          delete next[oldDbKey];
        }
        return next;
      });
      setExpandedCollectionsFolders((prev) => {
        const next: typeof prev = {};
        Object.entries(prev).forEach(([key, value]) => {
          const prefix = `${connectionId}/${dbName}/`;
          next[key.startsWith(prefix) ? `${connectionId}/${newName}/${key.slice(prefix.length)}` : key] = value;
        });
        return next;
      });
      setExpandedCollections((prev) => {
        const next: typeof prev = {};
        Object.entries(prev).forEach(([key, value]) => {
          const prefix = `${connectionId}/${dbName}/`;
          next[key.startsWith(prefix) ? `${connectionId}/${newName}/${key.slice(prefix.length)}` : key] = value;
        });
        return next;
      });
      setExpandedIndexesFolders((prev) => {
        const next: typeof prev = {};
        Object.entries(prev).forEach(([key, value]) => {
          const prefix = `${connectionId}/${dbName}/`;
          next[key.startsWith(prefix) ? `${connectionId}/${newName}/${key.slice(prefix.length)}` : key] = value;
        });
        return next;
      });
      onDatabaseRenamed?.(connectionId, dbName, newName);
      onNamespaceMutated?.(connectionId);
    };

    if (isMock) {
      applyLocalRename();
      return;
    }

    try {
      await invoke('rename_database', {
        id: connectionId,
        from: dbName,
        to: newName,
        dropSource: true,
      });
      applyLocalRename();
      await loadDatabases(connectionId);
    } catch (err) {
      toast(`Failed to rename database: ${err}`, 'error');
    }
  };

  const renderCollectionNode = (connId: string, dbName: string, collName: string) => {
    const collKey = `${connId}/${dbName}/${collName}`;
    const isCollExpanded = expandedCollections[collKey];
    const collIndexes = indexes[collKey] || [];
    const isActive =
      activeCollection?.connectionId === connId &&
      activeCollection?.db === dbName &&
      activeCollection?.collection === collName &&
      !activeCollection?.indexName;

    return (
      <div key={collName}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              onClick={() => {
                onSelectCollection(connId, dbName, collName);
                toggleCollectionNode(connId, dbName, collName);
              }}
              className={treeRowClass(isActive)}
            >
              <ChevronRight
                size={10}
                className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isCollExpanded && 'rotate-90')}
              />
              <Layers size={11} className={cn('shrink-0', isActive ? 'text-primary' : 'text-emerald-500')} />
              <span className="min-w-0 truncate" title={collName}>
                {collName}
              </span>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              className={ctxItemClass}
              onClick={() => onSelectCollection(connId, dbName, collName)}
            >
              <FolderOpen />
              <span>Open Collection</span>
            </ContextMenuItem>
            <ContextMenuItem
              className={ctxItemClass}
              data-testid={`ctx-pin-${connId}-${dbName}-${collName}`}
              onSelect={() => {
                const conn = activeConnections.find((c) => c.id === connId);
                if (conn) {
                  handleTogglePin({
                    kind: 'collection',
                    connectionName: conn.name,
                    db: dbName,
                    collection: collName,
                  });
                }
              }}
            >
              <Pin />
              <span>
                {(() => {
                  const conn = activeConnections.find((c) => c.id === connId);
                  return conn
                    ? pinMenuLabel({
                        kind: 'collection',
                        connectionName: conn.name,
                        db: dbName,
                        collection: collName,
                      })
                    : 'Pin to sidebar';
                })()}
              </span>
            </ContextMenuItem>
            <ContextMenuItem
              className={ctxItemClass}
              onSelect={() => {
                const conn = activeConnections.find((c) => c.id === connId);
                if (conn) {
                  handleToggleFavorite({
                    kind: 'collection',
                    connectionName: conn.name,
                    db: dbName,
                    collection: collName,
                  });
                }
              }}
            >
              <Heart />
              <span>
                {(() => {
                  const conn = activeConnections.find((c) => c.id === connId);
                  return conn
                    ? favoriteMenuLabel({
                        kind: 'collection',
                        connectionName: conn.name,
                        db: dbName,
                        collection: collName,
                      })
                    : 'Add to favorites';
                })()}
              </span>
            </ContextMenuItem>
            <ContextMenuItem
              className={ctxItemClass}
              onClick={() =>
                onOpenShell?.(connId, dbName, collName, `db.${collName}.find({}).limit(50)`)
              }
            >
              <Terminal />
              <span>Open mongosh Shell</span>
            </ContextMenuItem>
            <ContextMenuItem className={ctxItemClass} onClick={() => onAnalyzeSchema?.(connId, dbName, collName)}>
              <Table2 />
              <span>Analyze Schema</span>
            </ContextMenuItem>
            <ContextMenuItem
              className={ctxItemClass}
              onClick={() => navigator.clipboard?.writeText(collName)}
            >
              <FolderOpen />
              <span>Copy Collection Name</span>
            </ContextMenuItem>
            <ContextMenuItem className={ctxItemClass} onClick={() => handleRenameCollection(connId, dbName, collName)}>
              <Pencil />
              <span>Rename Collection</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={cn(ctxItemClass, 'text-destructive focus:text-destructive')}
              onClick={() => handleDropCollection(connId, dbName, collName)}
            >
              <Trash2 />
              <span>
                {(collections[`${connId}/${dbName}`] || []).find((c) => c.name === collName)?.type === 'view'
                  ? 'Drop View'
                  : 'Drop Collection'}
              </span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {isCollExpanded && (
          <div className="ml-3 border-l border-border/50 pl-1">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className={treeRowClass()}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleIndexesFolder(connId, dbName, collName);
                  }}
                >
                  <ChevronRight
                    size={10}
                    className={cn(
                      'shrink-0 text-muted-foreground transition-transform duration-150',
                      expandedIndexesFolders[`${connId}/${dbName}/${collName}`] && 'rotate-90',
                    )}
                  />
                  <Folder size={11} className="shrink-0 text-amber-500" />
                  <span className="text-muted-foreground">indexes</span>
                  {collIndexes.length > 0 && (
                    <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="indexes-count">
                      ({collIndexes.length})
                    </Badge>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem className={ctxItemClass} onClick={() => onCreateIndex?.(connId, dbName, collName)}>
                  <Plus />
                  <span>Create Index</span>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            {expandedIndexesFolders[`${connId}/${dbName}/${collName}`] && (
              <div className="ml-3 border-l border-border/50 pl-1">
                {collIndexes.map((idx) => {
                  const indexName = idx.name;
                  const isIndexActive =
                    activeCollection?.connectionId === connId &&
                    activeCollection?.db === dbName &&
                    activeCollection?.collection === collName &&
                    activeCollection?.indexName === indexName;
                  return (
                    <ContextMenu key={indexName}>
                      <ContextMenuTrigger asChild>
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectIndex(connId, dbName, collName, indexName);
                          }}
                          className={treeRowClass(isIndexActive)}
                        >
                          <KeyRound
                            size={10}
                            className={cn('shrink-0', isIndexActive ? 'text-primary' : 'text-amber-500')}
                          />
                          <span className="min-w-0 truncate">{indexName}</span>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          className={ctxItemClass}
                          onClick={() => navigator.clipboard?.writeText(indexName)}
                        >
                          <Plus />
                          <span>Copy Index Name</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className={cn(ctxItemClass, 'text-destructive focus:text-destructive')}
                          onClick={() => onDeleteIndex?.(connId, dbName, collName, indexName)}
                        >
                          <Trash2 />
                          <span>Delete Index</span>
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
                {collIndexes.length === 0 && (
                  <div className="py-0.5 pl-6 text-[9px] italic text-muted-foreground">Empty</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderConnectionsTree = () => {
    if (activeConnections.length === 0) {
      return (
        <div className="sidebar-empty-prompt flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground">
          <span className="text-[11px]">Connect to MongoDB server to browse database tree structures.</span>
          <Button size="sm" onClick={onOpenConnectionManager} aria-label="Connect to Database">
            <Plus className="mr-1.5 size-3" />
            Connect to Database...
          </Button>
        </div>
      );
    }

    return (
      <div className="flex flex-col">
        {activeConnections.map((conn) => {
          const q = filterQuery.trim();
          const filterActive = q.length > 0;
          const connDbs = databases[conn.id] || [];
          const connNameMatch = filterActive && fuzzyMatch(q, conn.name);
          const visibleDbs = connDbs.filter(
            (dbName) =>
              !filterActive ||
              connNameMatch ||
              fuzzyMatch(q, dbName) ||
              (collections[`${conn.id}/${dbName}`] || []).some((c) => fuzzyMatch(q, c.name)),
          );
          if (filterActive && !connNameMatch && visibleDbs.length === 0) return null;
          const isConnExpanded = expandedConnections[conn.id] || filterActive;

          return (
            <div key={conn.id}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    className={cn(
                      'group flex h-7 cursor-pointer items-center gap-1 rounded-sm px-2 text-xs hover:bg-accent/80',
                      conn.color_tag && 'border-l-[3px]',
                    )}
                    style={conn.color_tag ? { borderLeftColor: conn.color_tag } : undefined}
                    role="button"
                    aria-expanded={isConnExpanded}
                    aria-label={`Connection ${conn.name}`}
                    onClick={() => setExpandedConnections((prev) => ({ ...prev, [conn.id]: !prev[conn.id] }))}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      <ChevronRight
                        size={11}
                        className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isConnExpanded && 'rotate-90')}
                      />
                      {conn.color_tag && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: conn.color_tag }}
                          title="Connection color"
                        />
                      )}
                      <Server size={12} className="shrink-0 text-primary" />
                      <span className="min-w-0 truncate font-medium">{conn.name}</span>
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                        title="Connected"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDisconnect(conn.id);
                      }}
                      title="Disconnect Connection"
                      aria-label="Disconnect"
                    >
                      <LogOut className="size-3" />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem className={ctxItemClass} onClick={() => handleAddDatabase(conn.id)}>
                    <Plus />
                    <span>Add Database</span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={ctxItemClass}
                    data-testid={`ctx-pin-conn-${conn.id}`}
                    onSelect={() => {
                      const entry = pinEntryForConnection(conn.id);
                      if (entry) handleTogglePin(entry);
                    }}
                  >
                    <Pin />
                    <span>
                      {(() => {
                        const entry = pinEntryForConnection(conn.id);
                        return entry ? pinMenuLabel(entry) : 'Pin to sidebar';
                      })()}
                    </span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={ctxItemClass}
                    onSelect={() => {
                      const entry = favoriteEntryForConnection(conn.id);
                      if (entry) handleToggleFavorite(entry);
                    }}
                  >
                    <Heart />
                    <span>
                      {(() => {
                        const entry = favoriteEntryForConnection(conn.id);
                        return entry ? favoriteMenuLabel(entry) : 'Add to favorites';
                      })()}
                    </span>
                  </ContextMenuItem>
                  <ContextMenuItem className={ctxItemClass} onClick={onOpenConnectionManager}>
                    <Server />
                    <span>Manage Connections</span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={ctxItemClass}
                    data-testid="ctx-monitor"
                    onClick={() => onOpenMonitoring?.(conn.id)}
                  >
                    <Activity />
                    <span>Monitor cluster</span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={ctxItemClass}
                    data-testid="ctx-users"
                    onClick={() => onOpenUsers?.(conn.id)}
                  >
                    <Users />
                    <span>Manage users</span>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={cn(ctxItemClass, 'text-destructive focus:text-destructive')}
                    onClick={() => onDisconnect(conn.id)}
                  >
                    <LogOut />
                    <span>Disconnect</span>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              {isConnExpanded && (
                <div className="ml-3 border-l border-border/50 pl-1">
                  {visibleDbs.map((dbName) => {
                    const dbKey = `${conn.id}/${dbName}`;
                    const rawColls = collections[dbKey] || [];
                    const dbNameMatch = filterActive && (connNameMatch || fuzzyMatch(q, dbName));
                    const dbColls =
                      filterActive && !dbNameMatch ? rawColls.filter((c) => fuzzyMatch(q, c.name)) : rawColls;
                    const autoExpandDb = filterActive && !dbNameMatch && dbColls.length > 0;
                    const isDbExpanded = expandedDbs[dbKey] || autoExpandDb;
                    const isFolderExpanded = expandedCollectionsFolders[`${dbKey}/collections`] || autoExpandDb;

                    const systemColls = dbColls
                      .filter((c) => c.name.startsWith('system.'))
                      .map((c) => c.name)
                      .sort(compareCollectionNames);
                    const gridfsBuckets = Array.from(
                      new Set(
                        dbColls.filter((c) => /\.files$/.test(c.name)).map((c) => c.name.replace(/\.files$/, '')),
                      ),
                    ).sort(compareCollectionNames);
                    const gridfsColls = new Set(gridfsBuckets.flatMap((b) => [`${b}.files`, `${b}.chunks`]));
                    const views = dbColls
                      .filter((c) => c.type === 'view' && !c.name.startsWith('system.'))
                      .map((c) => c.name)
                      .sort(compareCollectionNames);
                    const regularColls = dbColls
                      .filter(
                        (c) => c.type !== 'view' && !c.name.startsWith('system.') && !gridfsColls.has(c.name),
                      )
                      .map((c) => c.name)
                      .sort(compareCollectionNames);

                    const isViewsExpanded = expandedCollectionsFolders[`${dbKey}/views`];
                    const isGridfsExpanded = expandedCollectionsFolders[`${dbKey}/gridfs`];
                    const isSystemExpanded = expandedCollectionsFolders[`${dbKey}/system`];

                    return (
                      <div key={dbName}>
                        <ContextMenu>
                          <ContextMenuTrigger asChild>
                            <div
                              className={treeRowClass()}
                              role="button"
                              aria-expanded={isDbExpanded}
                              aria-label={`Database ${dbName}`}
                              onClick={() => toggleDb(conn.id, dbName)}
                            >
                              <ChevronRight
                                size={11}
                                className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isDbExpanded && 'rotate-90')}
                              />
                              <Database size={12} className="shrink-0 text-amber-500" />
                              <span className="min-w-0 truncate">{dbName}</span>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem className={ctxItemClass} onClick={() => handleAddCollection(conn.id, dbName)}>
                              <Plus />
                              <span>Add Collection</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              className={ctxItemClass}
                              data-testid={`ctx-pin-db-${conn.id}-${dbName}`}
                              onSelect={() =>
                                handleTogglePin({
                                  kind: 'database',
                                  connectionName: conn.name,
                                  db: dbName,
                                })
                              }
                            >
                              <Pin />
                              <span>
                                {pinMenuLabel({
                                  kind: 'database',
                                  connectionName: conn.name,
                                  db: dbName,
                                })}
                              </span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              className={ctxItemClass}
                              onSelect={() =>
                                handleToggleFavorite({
                                  kind: 'database',
                                  connectionName: conn.name,
                                  db: dbName,
                                })
                              }
                            >
                              <Heart />
                              <span>
                                {favoriteMenuLabel({
                                  kind: 'database',
                                  connectionName: conn.name,
                                  db: dbName,
                                })}
                              </span>
                            </ContextMenuItem>
                            <ContextMenuItem className={ctxItemClass} onClick={() => onCreateView?.(conn.id, dbName)}>
                              <Eye />
                              <span>Create View</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              className={ctxItemClass}
                              onClick={() => onOpenShell?.(conn.id, dbName, undefined, 'show collections')}
                            >
                              <Terminal />
                              <span>Open mongosh Shell</span>
                            </ContextMenuItem>
                            <ContextMenuItem className={ctxItemClass} onClick={() => handleRefreshDb(conn.id, dbName)}>
                              <RefreshCw />
                              <span>Refresh Database</span>
                            </ContextMenuItem>
                            <ContextMenuItem className={ctxItemClass} onClick={() => handleRenameDatabase(conn.id, dbName)}>
                              <Pencil />
                              <span>Rename Database</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              className={ctxItemClass}
                              data-testid="ctx-db-users"
                              onClick={() => onOpenUsers?.(conn.id, dbName)}
                            >
                              <Users />
                              <span>Manage Users</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              className={cn(ctxItemClass, 'text-destructive focus:text-destructive')}
                              onClick={() => handleDropDatabase(conn.id, dbName)}
                            >
                              <Trash2 />
                              <span>Drop Database</span>
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>

                        {isDbExpanded && (
                          <div className="ml-3 border-l border-border/50 pl-1">
                            <div className={treeRowClass()} onClick={() => toggleCollectionsFolder(conn.id, dbName)}>
                              <ChevronRight
                                size={10}
                                className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isFolderExpanded && 'rotate-90')}
                              />
                              <Folder size={11} className="shrink-0 text-amber-500" />
                              <span className="text-muted-foreground">Collections</span>
                              <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="collections-count">
                                ({regularColls.length})
                              </Badge>
                            </div>
                            {isFolderExpanded && (
                              <div className="ml-3 border-l border-border/50 pl-1">
                                {regularColls.map((collName) => renderCollectionNode(conn.id, dbName, collName))}
                                {regularColls.length === 0 && (
                                  <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">Empty</div>
                                )}
                              </div>
                            )}

                            <div className={treeRowClass()} onClick={() => toggleVirtualFolder(`${dbKey}/views`)}>
                              <ChevronRight
                                size={10}
                                className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isViewsExpanded && 'rotate-90')}
                              />
                              <Eye size={11} className="shrink-0 text-amber-500" />
                              <span className="text-muted-foreground">Views</span>
                              <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="views-count">
                                ({views.length})
                              </Badge>
                            </div>
                            {isViewsExpanded && (
                              <div className="ml-3 border-l border-border/50 pl-1">
                                {views.map((viewName) => renderCollectionNode(conn.id, dbName, viewName))}
                                {views.length === 0 && (
                                  <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">Empty</div>
                                )}
                              </div>
                            )}

                            <div className={treeRowClass()} onClick={() => toggleVirtualFolder(`${dbKey}/gridfs`)}>
                              <ChevronRight
                                size={10}
                                className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isGridfsExpanded && 'rotate-90')}
                              />
                              <Archive size={11} className="shrink-0 text-amber-500" />
                              <span className="text-muted-foreground">GridFS Buckets</span>
                              <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="gridfs-count">
                                ({gridfsBuckets.length})
                              </Badge>
                            </div>
                            {isGridfsExpanded && (
                              <div className="ml-3 border-l border-border/50 pl-1">
                                {gridfsBuckets.map((bucket) => (
                                  <div
                                    key={bucket}
                                    className={treeRowClass()}
                                    onClick={() => onOpenGridfs?.(conn.id, dbName, bucket)}
                                  >
                                    <Archive size={11} className="ml-3.5 shrink-0 text-emerald-500" />
                                    <span className="min-w-0 truncate" title={bucket}>
                                      {bucket}
                                    </span>
                                  </div>
                                ))}
                                {gridfsBuckets.length === 0 && (
                                  <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">Empty</div>
                                )}
                              </div>
                            )}

                            <div className={treeRowClass()} onClick={() => toggleVirtualFolder(`${dbKey}/system`)}>
                              <ChevronRight
                                size={10}
                                className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isSystemExpanded && 'rotate-90')}
                              />
                              <Cog size={11} className="shrink-0 text-amber-500" />
                              <span className="text-muted-foreground">System</span>
                              <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="system-count">
                                ({systemColls.length})
                              </Badge>
                            </div>
                            {isSystemExpanded && (
                              <div className="ml-3 border-l border-border/50 pl-1">
                                {systemColls.map((collName) => renderCollectionNode(conn.id, dbName, collName))}
                                {systemColls.length === 0 && (
                                  <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">Empty</div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {connDbs.length === 0 && (
                    <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">Empty</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <EmptySpaceContextMenu onNewConnection={onOpenConnectionManager} onSettings={onOpenSettings}>
    <aside
      style={width ? { width: `${width}px` } : undefined}
      className="sidebar flex h-full flex-col mql-chrome"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-1.5">
          <Server size={14} className="text-primary" />
          <span className="text-ui-xs font-semibold tracking-wide">MQLens Workspace</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onOpenSettings} title="Settings" aria-label="Open Settings">
            <Settings className="size-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Help & feedback"
                aria-label="Help and feedback"
                data-testid="help-menu-btn"
              >
                <HelpCircle className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {HELP_LINKS.map(({ Icon, label, url }) => (
                <DropdownMenuItem key={label} className="gap-2 text-xs" onClick={() => void openUrl(url)}>
                  <Icon className="size-3.5" />
                  <span>{label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onOpenConnectionManager}
            title="Manage Connections"
            aria-label="Manage Connections"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </header>

      {activeConnections.length > 0 && (
        <div className="shrink-0 border-b border-border px-2 py-1.5">
          <div className="relative">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search connections, databases, collections…"
              aria-label="Search sidebar"
              data-testid="sidebar-search"
              className="h-7 pl-7 pr-7 text-ui-xs"
            />
            {filterQuery && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-7 w-7"
                onClick={() => setFilterQuery('')}
                aria-label="Clear search"
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
          <div className="database-tree-container p-2">
            <SidebarSection
              title="Connections"
              icon={Server}
              open={sectionsOpen.connections}
              onOpenChange={(open) => setSectionsOpen((s) => ({ ...s, connections: open }))}
            >
              {renderConnectionsTree()}
            </SidebarSection>

            <SidebarSection
              title="Pinned"
              icon={Pin}
              open={sectionsOpen.pinned}
              onOpenChange={(open) => setSectionsOpen((s) => ({ ...s, pinned: open }))}
              isEmpty={pinnedItems.length === 0}
              emptyText="Right-click a connection, database, or collection → Pin to sidebar"
            >
              <div className="flex flex-col gap-0.5 pb-1">
                {pinnedItems.map((p) => {
                    const connected = Boolean(connectionIdForName(p.connectionName));
                    const label = pinnedItemLabel(p);
                    const subtitle = pinnedItemSubtitle(p);
                    const isActive =
                      p.kind === 'collection' &&
                      activeCollection &&
                      activeConnections.find((c) => c.id === activeCollection.connectionId)?.name ===
                        p.connectionName &&
                      activeCollection.db === p.db &&
                      activeCollection.collection === p.collection &&
                      !activeCollection.indexName;
                    const PinIcon =
                      p.kind === 'connection' ? Server : p.kind === 'database' ? Database : Layers;
                    return (
                      <ContextMenu key={pinnedItemKey(p)}>
                        <ContextMenuTrigger asChild>
                          <div
                            className={treeRowClass(!!isActive)}
                            data-testid={`pinned-item-${pinnedItemKey(p)}`}
                            onClick={() => void navigateToPinned(p)}
                          >
                            <PinIcon
                              size={10}
                              className={cn(
                                'shrink-0',
                                p.kind === 'connection'
                                  ? 'text-primary'
                                  : p.kind === 'database'
                                    ? 'text-amber-500'
                                    : 'text-emerald-500',
                              )}
                            />
                            <span className="min-w-0 truncate" title={label}>
                              {label}
                            </span>
                            <span className="ml-auto truncate text-[10px] text-muted-foreground">
                              {subtitle}
                              {!connected && ' · offline'}
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            className={ctxItemClass}
                            onClick={() => void navigateToPinned(p)}
                          >
                            <FolderOpen />
                            <span>Open</span>
                          </ContextMenuItem>
                          <ContextMenuItem
                            className={ctxItemClass}
                            onSelect={() => {
                              const next = unpinItem(pinnedItems, p);
                              setPinnedItems(next);
                            }}
                          >
                            <Pin />
                            <span>Unpin</span>
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
              </div>
            </SidebarSection>

            <SidebarSection
              title="Favorites"
              icon={Heart}
              open={sectionsOpen.favorites}
              onOpenChange={(open) => {
                setSectionsOpen((s) => ({ ...s, favorites: open }));
                if (open) void reloadSavedQueryCatalog();
              }}
              isEmpty={favoriteItems.length === 0}
              emptyText="Right-click items in the tree, or favorite a saved query from a collection tab"
            >
              <div className="flex flex-col gap-0.5 pb-1">
                {favoriteItems.map((fav) => {
                    const connected = Boolean(connectionIdForName(fav.connectionName));
                    const label = favoriteItemLabel(fav);
                    const subtitle = favoriteItemSubtitle(fav);
                    const FavIcon =
                      fav.kind === 'query'
                        ? Heart
                        : fav.kind === 'connection'
                          ? Server
                          : fav.kind === 'database'
                            ? Database
                            : Layers;
                    return (
                      <ContextMenu key={favoriteItemKey(fav)}>
                        <ContextMenuTrigger asChild>
                          <div
                            className={treeRowClass()}
                            onClick={() => void navigateToFavorite(fav)}
                            title={`${fav.connectionName}${fav.db ? ` · ${fav.db}` : ''}${fav.collection ? `.${fav.collection}` : ''}`}
                          >
                            <FavIcon
                              size={10}
                              className={cn(
                                'shrink-0',
                                fav.kind === 'query' ? 'text-rose-500' : 'text-primary',
                              )}
                            />
                            <span className="min-w-0 truncate">{label}</span>
                            <span className="ml-auto truncate text-[10px] text-muted-foreground">
                              {subtitle}
                              {!connected && fav.kind !== 'query' ? ' · offline' : ''}
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            className={ctxItemClass}
                            onClick={() => void navigateToFavorite(fav)}
                          >
                            <FolderOpen />
                            <span>Open</span>
                          </ContextMenuItem>
                          <ContextMenuItem
                            className={ctxItemClass}
                            onSelect={() => {
                              const next = removeFavoriteItem(favoriteItems, fav);
                              setFavoriteItems(next);
                            }}
                          >
                            <Heart />
                            <span>Remove from favorites</span>
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
              </div>
            </SidebarSection>

            <SidebarSection
              title="Folders"
              icon={FolderOpen}
              open={sectionsOpen.folders}
              onOpenChange={(open) => setSectionsOpen((s) => ({ ...s, folders: open }))}
              emptyText={
                connectionProfiles.length === 0
                  ? 'Save connections in Connection Manager'
                  : undefined
              }
            >
              {connectionProfiles.length > 0 && (
                <div className="flex flex-col gap-0.5 pb-1">
                  {connectionFolders.map((folder) => {
                    const folderProfiles = connectionProfiles.filter(
                      (p) => profileFolderMap[p.id] === folder.id,
                    );
                    if (folderProfiles.length === 0) return null;
                    const isExpanded = expandedProfileFolders[folder.id] ?? false;
                    return (
                      <div key={folder.id}>
                        <div
                          className={treeRowClass()}
                          onClick={() =>
                            setExpandedProfileFolders((prev) => ({
                              ...prev,
                              [folder.id]: !prev[folder.id],
                            }))
                          }
                        >
                          <ChevronRight
                            size={10}
                            className={cn(
                              'shrink-0 text-muted-foreground transition-transform duration-150',
                              isExpanded && 'rotate-90',
                            )}
                          />
                          <Folder size={11} className="shrink-0 text-amber-500" />
                          <span className="min-w-0 truncate">{folder.name}</span>
                          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[9px] font-normal">
                            {folderProfiles.length}
                          </Badge>
                        </div>
                        {isExpanded && (
                          <div className="ml-3 border-l border-border/50 pl-1">
                            {folderProfiles.map((profile) => {
                              const isConnected = activeConnections.some(
                                (c) => c.profileId === profile.id,
                              );
                              return (
                                <div
                                  key={profile.id}
                                  className={treeRowClass()}
                                  onClick={() => onConnectProfile?.(profile)}
                                  title={profile.name}
                                >
                                  <Server
                                    size={11}
                                    className={cn(
                                      'shrink-0',
                                      isConnected ? 'text-emerald-500' : 'text-muted-foreground',
                                    )}
                                  />
                                  <span className="min-w-0 truncate">{profile.name}</span>
                                  {isConnected && (
                                    <span
                                      className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                                      title="Connected"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {connectionProfiles
                    .filter((p) => !profileFolderMap[p.id])
                    .map((profile) => {
                      const isConnected = activeConnections.some((c) => c.profileId === profile.id);
                      return (
                        <div
                          key={profile.id}
                          className={treeRowClass()}
                          onClick={() => onConnectProfile?.(profile)}
                          title={profile.name}
                        >
                          <Server
                            size={11}
                            className={cn(
                              'shrink-0',
                              isConnected ? 'text-emerald-500' : 'text-muted-foreground',
                            )}
                          />
                          <span className="min-w-0 truncate">{profile.name}</span>
                          <span className="ml-auto text-[10px] text-muted-foreground">root</span>
                        </div>
                      );
                    })}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-7 w-full justify-start gap-1.5 px-2 text-[10px] text-muted-foreground"
                    onClick={onOpenConnectionManager}
                  >
                    <Settings size={11} />
                    Manage connections
                  </Button>
                </div>
              )}
            </SidebarSection>
          </div>
      </ScrollArea>

      <footer className="flex shrink-0 items-center justify-between border-t border-border px-3 py-2">
        <ThemePicker />
        <span className="text-[10px] text-muted-foreground">Theme</span>
      </footer>
    </aside>
    </EmptySpaceContextMenu>
  );
};
