import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useDialogs } from './dialogs/DialogProvider';
import { confirmByTypedName } from '../lib/typedNameConfirm';
import { fuzzyMatch } from '../lib/fuzzyMatch';
import { type CollectionSelection, emptySelection, toggleCollection, selectionScope } from '@/lib/collectionSelection';
import {
  type FolderNode,
  FOLDERS_CHANGED_EVENT,
  FOLDERS_STORAGE_KEY,
  PROFILE_FOLDERS_STORAGE_KEY,
  loadConnectionFolders,
} from '../lib/connectionFolders';
import {
  type PinnedItem,
  PINNED_CHANGED_EVENT,
  PINNED_STORAGE_KEY,
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
  FAVORITES_STORAGE_KEY,
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
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { ClusterHealthCard } from '@/components/ClusterHealthCard';
import { DbStatsCard, CollStatsCard, IndexStatsCard } from '@/components/StatsCards';
import { ThemePicker } from '@/components/theme/ThemePicker';
import {
  Database,
  Folder,
  FolderOpen,
  FolderPlus,
  Server,
  RefreshCw,
  Trash2,
  Plus,
  LogOut,
  Layers,
  KeyRound,
  ChevronRight,
  Settings,
  Radio,
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
  ChartLine,
  ClipboardPaste,
  Copy,
  DatabaseBackup,
  DatabaseZap,
  ShieldCheck,
  Wand2,
} from 'lucide-react';

const REPO_URL = 'https://github.com/mqlens/mqlens-mongodb';

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

// Discriminated target for the row-hover stats popover (issue #178):
// connection → cluster health, database/collection/index → their stats cards.
type StatsPopoverTarget =
  | { kind: 'connection'; connId: string }
  | { kind: 'database'; connId: string; db: string }
  | { kind: 'collection'; connId: string; db: string; coll: string }
  | { kind: 'index'; connId: string; db: string; coll: string; index: string };

const targetKey = (t: StatsPopoverTarget): string => {
  switch (t.kind) {
    case 'connection':
      return `connection:${t.connId}`;
    case 'database':
      return `database:${t.connId}/${t.db}`;
    case 'collection':
      return `collection:${t.connId}/${t.db}/${t.coll}`;
    case 'index':
      return `index:${t.connId}/${t.db}/${t.coll}/${t.index}`;
  }
};

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
    opts?: { newTab?: boolean },
  ) => void;
  onSelectIndex: (connectionId: string, dbName: string, collName: string, indexName: string) => void;
  activeCollection: { connectionId: string; db: string; collection: string; indexName?: string } | null;
  activeConnections: {
    id: string;
    name: string;
    uri: string;
    profileId?: string;
    color_tag?: string;
    viaMcp?: boolean;
    /** Read-only / confirm-destructive production safeguard (#188), mirrors App.tsx's `ActiveConnection.mode`. */
    mode?: 'normal' | 'read_only' | 'confirm_destructive';
  }[];
  onOpenConnectionManager: () => void;
  onDisconnect: (connectionId: string) => void;
  width?: number;
  onOpenSettings: () => void;
  onCreateIndex?: (connectionId: string, dbName: string, collName: string) => void;
  onDeleteIndex?: (connectionId: string, dbName: string, collName: string, indexName: string) => void;
  onOpenShell?: (connectionId: string, dbName: string, collName?: string, initialCommand?: string) => void;
  /** Open a live change-stream tail (#190). Omit the collection to watch a
   *  whole database, and the database too to watch the deployment. */
  onWatchCollection?: (connectionId: string, dbName?: string, collName?: string) => void;
  onOpenMonitoring?: (connectionId: string) => void;
  onOpenUsers?: (connectionId: string, db?: string) => void;
  onAnalyzeSchema?: (connectionId: string, dbName: string, collName: string) => void;
  onEditValidation?: (connectionId: string, dbName: string, collName: string) => void;
  onCreateView?: (connectionId: string, dbName: string) => void;
  onOpenGridfs?: (connectionId: string, dbName: string, bucket: string) => void;
  /** Open a Dump tab scoped to the whole connection, a database, or a single collection. */
  onOpenDump?: (connectionId: string, dbName?: string, collName?: string) => void;
  /** Open a Restore tab for the connection. */
  onOpenRestore?: (connectionId: string) => void;
  /** Open a Generate Data tab scoped to a database (starter template) or a single collection (schema-seeded). */
  onOpenGenerate?: (connectionId: string, dbName: string, collName?: string) => void;
  onCollectionRenamed?: (connectionId: string, dbName: string, oldName: string, newName: string) => void;
  onDatabaseDropped?: (connectionId: string, dbName: string) => void;
  onDatabaseRenamed?: (connectionId: string, oldName: string, newName: string) => void;
  onNamespaceMutated?: (connectionId?: string) => void;
  onFilterQueryChange?: (query: string) => void;
  indexMutationTrigger?: number;
  collectionMutationTrigger?: number;
  onConnectProfile?: (profile: ConnectionProfile) => Promise<string | null> | string | null;
  profilesRefreshKey?: number;
  onCopyCollections?: (connectionId: string, db: string, collections: string[]) => void;
  onCopyDatabase?: (connectionId: string, db: string) => void;
  /** Copy source to the in-app clipboard (collections=[] means whole database). */
  onCopyToClipboard?: (connectionId: string, db: string, collections: string[]) => void;
  /** Paste the clipboard into a target (db omitted = paste onto a connection). */
  onPasteInto?: (connectionId: string, db?: string) => void;
  /** Whether the clipboard currently holds something to paste. */
  canPaste?: boolean;
  /**
   * Destination to refresh after a copy starts (and periodically while it runs),
   * so newly-copied databases/collections appear. `expand` auto-opens the target
   * db (only on copy start, so a manual collapse mid-copy is respected).
   */
  refreshTarget?: { connectionId: string; db?: string; expand: boolean } | null;
  /** Bumped by the parent to fire a refresh of `refreshTarget`. */
  refreshTargetNonce?: number;
  /** Hover delay before the connection cluster-health popover opens (ms). */
  clusterHoverDelayMs?: number;
  /** Whether the given collection already has at least one open tab. Used to gate
   *  double-click: a cold collection's double-click is a no-op (the single click
   *  already opened its sole tab), an already-open collection's adds another. */
  isCollectionOpen?: (connectionId: string, db: string, collection: string) => boolean;
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
  const { t } = useTranslation('sidebar');
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem className={ctxItemClass} onClick={onNewConnection}>
          <Plus />
          <span>{t('ctx.newConnection')}</span>
        </ContextMenuItem>
        <ContextMenuItem className={ctxItemClass} onClick={onSettings}>
          <Settings />
          <span>{t('ctx.settings')}</span>
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
  onWatchCollection,
  onOpenMonitoring,
  onOpenUsers,
  onAnalyzeSchema,
  onEditValidation,
  onCreateView,
  onOpenGridfs,
  onOpenDump,
  onOpenRestore,
  onOpenGenerate,
  onCollectionRenamed,
  onDatabaseDropped,
  onDatabaseRenamed,
  onNamespaceMutated,
  onFilterQueryChange,
  indexMutationTrigger,
  collectionMutationTrigger,
  onConnectProfile,
  profilesRefreshKey = 0,
  onCopyCollections,
  onCopyDatabase,
  onCopyToClipboard,
  onPasteInto,
  canPaste,
  refreshTarget,
  refreshTargetNonce,
  clusterHoverDelayMs = 400,
  isCollectionOpen,
}) => {
  const { t } = useTranslation('sidebar');
  const { toast, confirm, prompt } = useDialogs();

  const helpLinks = [
    { Icon: Bug, label: t('help.reportBug'), url: `${REPO_URL}/issues/new?template=bug_report.yml` },
    { Icon: Lightbulb, label: t('help.requestFeature'), url: `${REPO_URL}/issues/new?template=feature_request.yml` },
    { Icon: BookOpen, label: t('help.documentation'), url: 'https://mqlens.com/docs/' },
    { Icon: Star, label: t('help.starOnGithub'), url: `${REPO_URL}/stargazers` },
  ];

  const validateGridfsBucketName = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return t('dialogs.gridfsBucket.errors.required');
    if (trimmed.includes('.')) return t('dialogs.gridfsBucket.errors.noDot');
    if (trimmed.startsWith('system')) return t('dialogs.gridfsBucket.errors.noSystemPrefix');
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      return t('dialogs.gridfsBucket.errors.invalidChars');
    }
    return null;
  };

  const [filterQuery, setFilterQuery] = useState('');
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  // Whether the collection under a double-click gesture already had an open tab
  // at the moment the gesture began (captured on the first mousedown, before the
  // leading single-click opens it). Gates cold double-click to a single tab.
  const collectionWasOpenOnPressRef = React.useRef(false);

  // Stats hover popover: which row's card is open (connection → cluster
  // health, database/collection/index → their stats cards), plus open-delay
  // and grace-close timers so the pointer can travel into the card.
  const [statsPopover, setStatsPopover] = useState<StatsPopoverTarget | null>(null);
  const statsOpenTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsCloseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The popover opens at the mouse cursor, not beside the row: a virtual
  // anchor reports a zero-size rect at the last pointer position (updated
  // until the popover opens, then frozen so the card doesn't chase the mouse).
  const statsAnchorPoint = React.useRef({ x: 0, y: 0 });
  const statsVirtualAnchor = React.useRef({
    getBoundingClientRect: () => {
      const { x, y } = statsAnchorPoint.current;
      return { width: 0, height: 0, x, y, top: y, bottom: y, left: x, right: x, toJSON: () => ({}) } as DOMRect;
    },
  });
  const cancelStatsTimers = () => {
    if (statsOpenTimer.current) clearTimeout(statsOpenTimer.current);
    if (statsCloseTimer.current) clearTimeout(statsCloseTimer.current);
    statsOpenTimer.current = null;
    statsCloseTimer.current = null;
  };
  const scheduleStatsOpen = (target: StatsPopoverTarget) => {
    cancelStatsTimers();
    // Moving to a different row: close the previous popover immediately
    // instead of letting it linger for the open delay.
    setStatsPopover((cur) => (cur !== null && targetKey(cur) !== targetKey(target) ? null : cur));
    statsOpenTimer.current = setTimeout(() => setStatsPopover(target), clusterHoverDelayMs);
  };
  const scheduleStatsClose = () => {
    if (statsOpenTimer.current) clearTimeout(statsOpenTimer.current);
    statsCloseTimer.current = setTimeout(() => setStatsPopover(null), 150);
  };
  useEffect(() => cancelStatsTimers, []);

  // Hover props for a stats-popover row: capture the cursor position on
  // enter and schedule the open; keep tracking the pointer until this row's
  // popover actually opens; grace-close on leave so the pointer can travel
  // into the card without it disappearing.
  const statsHoverHandlers = (target: StatsPopoverTarget) => ({
    onMouseEnter: (e: React.MouseEvent) => {
      statsAnchorPoint.current = { x: e.clientX, y: e.clientY };
      scheduleStatsOpen(target);
    },
    onMouseMove: (e: React.MouseEvent) => {
      if (statsPopover === null || targetKey(statsPopover) !== targetKey(target)) {
        statsAnchorPoint.current = { x: e.clientX, y: e.clientY };
      }
    },
    onMouseLeave: scheduleStatsClose,
  });

  // Mock connections (the bundled sample data, or ids/URIs marked as such) never
  // reach a real mongodump/mongorestore binary — the backend rejects them outright
  // (see require_real_conn_uri in mongotools.rs) — so hide the Dump/Restore
  // context-menu items for them rather than surfacing a doomed invoke() call.
  const isMockConnection = React.useCallback(
    (connectionId: string): boolean => {
      const conn = activeConnections.find((c) => c.id === connectionId);
      return connectionId.startsWith('mock') || Boolean(conn?.uri.startsWith('mongodb://mock'));
    },
    [activeConnections]
  );

  useEffect(() => {
    onFilterQueryChange?.(filterQuery);
  }, [filterQuery, onFilterQueryChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'f'
      ) {
        return;
      }

      const searchInput = searchInputRef.current;
      if (!searchInput) return;

      const target = event.target;
      if (target instanceof Element && target !== searchInput) {
        const isEditable =
          target.closest('.monaco-editor') ||
          target.closest('input, textarea, select, [contenteditable="true"]');
        if (isEditable) return;
      }

      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  const [selection, setSelection] = useState<CollectionSelection>(emptySelection());

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

    // The mount-time profile load may not have landed yet — clicking a pinned
    // item right after launch used to dead-end on the empty list with a
    // "no saved connection" error. Fall back to a fresh on-demand load.
    let profile = connectionProfiles.find((p) => p.name === connectionName);
    if (!profile) {
      try {
        const fresh = (await invoke<ConnectionProfile[]>('load_connection_profiles')) ?? [];
        setConnectionProfiles(fresh);
        profile = fresh.find((p) => p.name === connectionName);
      } catch {
        /* fall through to the error toast below */
      }
    }
    if (!profile || !onConnectProfile) {
      toast(t('toasts.noSavedConnection', { name: connectionName }), 'error');
      return null;
    }

    toast(t('toasts.connectingTo', { name: connectionName }), 'info');
    const connId = await onConnectProfile(profile);
    if (connId) return connId;

    toast(t('toasts.couldNotConnect', { name: connectionName }), 'error');
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
    // Phase 3 Task 6: pins live in localStorage, shared same-origin across
    // every Tauri window — but each window only reads it once (on mount) and
    // otherwise relies on the in-window `PINNED_CHANGED_EVENT` above, which
    // never crosses windows (it's a plain `window.dispatchEvent`, scoped to
    // this window's own `window` object). The browser-native `storage` event
    // is the cross-window signal: it fires on every OTHER window's `window`
    // when localStorage changes (never on the window that made the change —
    // that's what `PINNED_CHANGED_EVENT` already covers), so the two
    // listeners together keep pins in sync everywhere. Filtered by key so an
    // unrelated localStorage write (folders, favorites, anything else) in
    // another window doesn't force a redundant reload here.
    const onStorage = (e: StorageEvent) => {
      if (e.key === PINNED_STORAGE_KEY) reloadPinned();
    };
    window.addEventListener(PINNED_CHANGED_EVENT, onPinned);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PINNED_CHANGED_EVENT, onPinned);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    reloadFavoritesStorage();
    const onFavorites = () => reloadFavoritesStorage();
    // Cross-window sync via the native `storage` event — see the pins effect
    // above for why this is needed alongside `FAVORITES_CHANGED_EVENT`.
    const onStorage = (e: StorageEvent) => {
      if (e.key === FAVORITES_STORAGE_KEY) reloadFavoritesStorage();
    };
    window.addEventListener(FAVORITES_CHANGED_EVENT, onFavorites);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(FAVORITES_CHANGED_EVENT, onFavorites);
      window.removeEventListener('storage', onStorage);
    };
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
    // Cross-window sync via the native `storage` event — see the pins
    // effect above. Folders persist across two keys (the node list and the
    // profile->folder map), so either one changing triggers a reload.
    const onStorage = (e: StorageEvent) => {
      if (e.key === FOLDERS_STORAGE_KEY || e.key === PROFILE_FOLDERS_STORAGE_KEY) reloadFolders();
    };
    window.addEventListener(FOLDERS_CHANGED_EVENT, onFolders);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(FOLDERS_CHANGED_EVENT, onFolders);
      window.removeEventListener('storage', onStorage);
    };
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
        toast(t('toasts.savedQueryGone'), 'info');
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
      toast(wasPinned ? t('toasts.unpinned') : t('toasts.pinned'), wasPinned ? 'info' : 'success');
    } catch {
      toast(t('toasts.couldNotUpdatePinned'), 'error');
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
      toast(wasFav ? t('toasts.removedFromFavorites') : t('toasts.addedToFavorites'), wasFav ? 'info' : 'success');
    } catch {
      toast(t('toasts.couldNotUpdateFavorites'), 'error');
    }
  };

  const pinMenuLabel = (entry: PinnedItem): string =>
    isItemPinned(pinnedItems, entry) ? t('ctx.unpinFromSidebar') : t('ctx.pinToSidebar');

  const favoriteMenuLabel = (entry: FavoriteItem): string =>
    isItemFavorited(favoriteItems, entry) ? t('ctx.removeFromFavorites') : t('ctx.addToFavorites');

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

  // Refresh a copy destination when the parent bumps the nonce — on copy start
  // and periodically while it runs — so new databases/collections appear live.
  useEffect(() => {
    if (!refreshTargetNonce || !refreshTarget) return;
    const { connectionId, db, expand } = refreshTarget;
    loadDatabases(connectionId);
    if (db) {
      const key = `${connectionId}/${db}`;
      if (expand) {
        setExpandedDbs((prev) => ({ ...prev, [key]: true }));
        setExpandedCollectionsFolders((prev) => ({ ...prev, [`${key}/collections`]: true }));
      }
      handleRefreshDb(connectionId, db);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTargetNonce]);

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
      title: t('dialogs.newDatabase.title'),
      message: t('dialogs.enterNewDatabaseName'),
      placeholder: t('dialogs.newDatabase.placeholder'),
      validate: (v) => (v ? null : t('dialogs.nameRequired')),
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
      title: t('dialogs.initialCollection.title'),
      message: t('dialogs.initialCollection.message'),
      defaultValue: t('dialogs.initialCollection.defaultValue'),
      validate: (v) => (v ? null : t('dialogs.nameRequired')),
    });
    if (!firstColl) return;
    try {
      await invoke('create_collection', { id: connectionId, database: name, collection: firstColl });
      await loadDatabases(connectionId);
      onNamespaceMutated?.(connectionId);
    } catch (err) {
      toast(t('toasts.createDatabaseFailed', { error: `${err}` }), 'error');
    }
  };

  const handleAddCollection = async (connectionId: string, dbName: string) => {
    const name = await prompt({
      title: t('dialogs.newCollection.title'),
      message: t('dialogs.enterNewCollectionName'),
      placeholder: t('dialogs.newCollection.placeholder'),
      validate: (v) => (v ? null : t('dialogs.nameRequired')),
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
      toast(t('toasts.createCollectionFailed', { error: `${err}` }), 'error');
    }
  };

  const handleOpenGridfsBucket = async (connectionId: string, dbName: string) => {
    const name = await prompt({
      title: t('dialogs.gridfsBucket.title'),
      message: t('dialogs.gridfsBucket.message'),
      defaultValue: t('dialogs.gridfsBucket.bucketDefault'),
      placeholder: t('dialogs.gridfsBucket.bucketDefault'),
      validate: validateGridfsBucketName,
    });
    if (!name) return;
    onOpenGridfs?.(connectionId, dbName, name.trim());
  };

  const handleDropCollection = async (connectionId: string, dbName: string, collName: string) => {
    const conn = activeConnections.find((c) => c.id === connectionId);
    // #188 security review Fix 5: block read-only BEFORE the confirm dialog
    // and, critically, before the `isMock` branch below — which mutates the
    // sidebar's local state directly and returns without ever calling the
    // backend, so a mock connection never hit `guard_writable`'s rejection
    // the way a real connection's `invoke('drop_collection', ...)` does.
    // Same exact wording as the backend's `write_guard::READ_ONLY_MSG` so a
    // mock and a real read-only connection behave identically here.
    if (conn?.mode === 'read_only') {
      toast(t('toasts.readOnlyBlocked'), 'error');
      return;
    }
    // #188 Task 3: on a confirm_destructive (production-safeguard) connection,
    // the ordinary yes/no confirm is replaced by a typed-name match — see
    // `confirmByTypedName`'s doc comment. `confirmed: true` is only ever
    // passed after that exact match; the backend's `guard_writable` is the
    // real gate either way.
    const confirmed = conn?.mode === 'confirm_destructive';
    if (confirmed) {
      if (
        !(await confirmByTypedName(prompt, {
          title: t('dialogs.dropCollection.title'),
          kind: 'collection',
          expectedName: collName,
        }, t))
      )
        return;
    } else if (
      !(await confirm({
        title: t('dialogs.dropCollection.title'),
        message: t('dialogs.dropCollection.message', { name: collName }),
        confirmLabel: t('dialogs.dropCollection.confirmLabel'),
        destructive: true,
      }))
    ) {
      return;
    }
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
      await invoke('drop_collection', { id: connectionId, database: dbName, collection: collName, confirmed });
      clearActiveIfDropped();
      await handleRefreshDb(connectionId, dbName);
      onNamespaceMutated?.(connectionId);
    } catch (err) {
      toast(t('toasts.dropCollectionFailed', { error: `${err}` }), 'error');
    }
  };

  const handleRenameCollection = async (connectionId: string, dbName: string, collName: string) => {
    const conn = activeConnections.find((c) => c.id === connectionId);
    // #188 Task 3: on a confirm_destructive connection, typing the current
    // collection name (the "already a prompt" precedent kept as-is below for
    // the new name) proves intent before the "enter new name" prompt is even
    // shown — see `confirmByTypedName`'s doc comment.
    const confirmed = conn?.mode === 'confirm_destructive';
    if (confirmed) {
      if (
        !(await confirmByTypedName(prompt, {
          title: t('dialogs.renameCollection.title'),
          kind: 'collection',
          expectedName: collName,
        }, t))
      )
        return;
    }

    const newName = await prompt({
      title: t('dialogs.renameCollection.title'),
      message: t('dialogs.enterNewCollectionName'),
      defaultValue: collName,
      validate: (v) => (v ? null : t('dialogs.nameRequired')),
    });
    if (!newName || newName === collName) return;

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
        confirmed,
      });
      applyLocalRename();
      await handleRefreshDb(connectionId, dbName);
    } catch (err) {
      toast(t('toasts.renameCollectionFailed', { error: `${err}` }), 'error');
    }
  };

  const handleDropDatabase = async (connectionId: string, dbName: string) => {
    const conn = activeConnections.find((c) => c.id === connectionId);
    // #188 security review Fix 5: see handleDropCollection's comment on this
    // same pattern — blocks the `isMock` branch below from dropping a
    // read-only mock connection's database without ever reaching the backend.
    if (conn?.mode === 'read_only') {
      toast(t('toasts.readOnlyBlocked'), 'error');
      return;
    }
    // #188 Task 3: see handleDropCollection's comment on this same pattern.
    const confirmed = conn?.mode === 'confirm_destructive';
    if (confirmed) {
      if (
        !(await confirmByTypedName(prompt, {
          title: t('dialogs.dropDatabase.title'),
          kind: 'database',
          expectedName: dbName,
        }, t))
      )
        return;
    } else if (
      !(await confirm({
        title: t('dialogs.dropDatabase.title'),
        message: t('dialogs.dropDatabase.message', { name: dbName }),
        confirmLabel: t('dialogs.dropDatabase.confirmLabel'),
        destructive: true,
      }))
    ) {
      return;
    }
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
      await invoke('drop_database', { id: connectionId, database: dbName, confirmed });
      clearLocalDatabase();
      await loadDatabases(connectionId);
    } catch (err) {
      toast(t('toasts.dropDatabaseFailed', { error: `${err}` }), 'error');
    }
  };

  const handleRenameDatabase = async (connectionId: string, dbName: string) => {
    const newName = await prompt({
      title: t('dialogs.renameDatabase.promptTitle'),
      message: t('dialogs.enterNewDatabaseName'),
      defaultValue: dbName,
      validate: (v) => (v ? null : t('dialogs.nameRequired')),
    });
    if (!newName || newName === dbName) return;

    const conn = activeConnections.find((c) => c.id === connectionId);
    // #188 Task 3: on a confirm_destructive connection, the typed-name match
    // (against the source/"from" database name) replaces the ordinary
    // yes/no confirm below — see `confirmByTypedName`'s doc comment.
    const confirmed = conn?.mode === 'confirm_destructive';
    if (confirmed) {
      if (
        !(await confirmByTypedName(prompt, {
          title: t('dialogs.renameDatabase.title', { name: dbName }),
          kind: 'database',
          expectedName: dbName,
          message: t('dialogs.renameDatabase.messageTyped', { oldName: dbName, newName }),
        }, t))
      )
        return;
    } else if (
      !(await confirm({
        title: t('dialogs.renameDatabase.title', { name: dbName }),
        message: t('dialogs.renameDatabase.messagePlain', { oldName: dbName, newName }),
        confirmLabel: t('dialogs.renameDatabase.confirmLabel'),
      }))
    ) {
      return;
    }

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
        confirmed,
      });
      applyLocalRename();
      await loadDatabases(connectionId);
    } catch (err) {
      toast(t('toasts.renameDatabaseFailed', { error: `${err}` }), 'error');
    }
  };

  const selectedNamesFor = (connId: string, dbName: string, collName: string): string[] => {
    const scope = selectionScope(connId, dbName);
    if (selection.scope === scope && selection.names.has(collName)) {
      return [...selection.names];
    }
    return [collName];
  };

  const renderCollectionNode = (connId: string, dbName: string, collName: string) => {
    const collKey = `${connId}/${dbName}/${collName}`;
    const isCollExpanded = expandedCollections[collKey];
    const collIndexes = indexes[collKey] || [];
    const collType = (collections[`${connId}/${dbName}`] || []).find((c) => c.name === collName)?.type;
    const isActive =
      activeCollection?.connectionId === connId &&
      activeCollection?.db === dbName &&
      activeCollection?.collection === collName &&
      !activeCollection?.indexName;
    const isSelected = selection.scope === selectionScope(connId, dbName) && selection.names.has(collName);

    return (
      <div key={collName}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelection((s) => toggleCollection(s, connId, dbName, collName));
                } else {
                  onSelectCollection(connId, dbName, collName);
                  toggleCollectionNode(connId, dbName, collName);
                }
              }}
              onMouseDown={(e) => {
                // detail === 1 is the first press of a potential double-click;
                // capture BEFORE the click's open mutates the tab list. Skip
                // cmd/ctrl (multi-select, not an open).
                if (e.detail === 1 && !e.metaKey && !e.ctrlKey) {
                  collectionWasOpenOnPressRef.current =
                    isCollectionOpen?.(connId, dbName, collName) ?? false;
                }
              }}
              onDoubleClick={(e) => {
                if (e.metaKey || e.ctrlKey) return; // cmd/ctrl is multi-select, not open
                e.preventDefault();
                e.stopPropagation();
                // Only open a NEW tab if the collection was ALREADY open before
                // this gesture. Cold collection: the leading single-click already
                // opened its one tab, so do nothing (no accidental pair).
                if (collectionWasOpenOnPressRef.current) {
                  onSelectCollection(connId, dbName, collName, undefined, { newTab: true });
                }
              }}
              className={cn(treeRowClass(isActive), isSelected && 'bg-accent')}
              {...statsHoverHandlers({ kind: 'collection', connId, db: dbName, coll: collName })}
            >
              <ChevronRight
                size={10}
                className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isCollExpanded && 'rotate-90')}
              />
              {collType === 'timeseries' ? (
                <span
                  aria-label={t('tree.timeseriesAriaLabel')}
                  data-testid="coll-icon-timeseries"
                  className="flex shrink-0 items-center"
                >
                  <ChartLine size={11} className={cn('shrink-0', isActive ? 'text-primary' : 'text-emerald-500')} />
                </span>
              ) : (
                <Layers size={11} className={cn('shrink-0', isActive ? 'text-primary' : 'text-emerald-500')} />
              )}
              <span className="min-w-0 truncate">
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
              <span>{t('ctx.openCollection')}</span>
            </ContextMenuItem>
            <ContextMenuItem
              className={ctxItemClass}
              onClick={() => onSelectCollection(connId, dbName, collName, undefined, { newTab: true })}
            >
              <FolderPlus />
              <span>{t('ctx.openInNewTab')}</span>
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
                    : t('ctx.pinToSidebar');
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
                    : t('ctx.addToFavorites');
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
              <span>{t('ctx.openShell')}</span>
            </ContextMenuItem>
            {/* Hidden for the built-in demo connections: they have no driver
                client behind them, so a change stream could never start. */}
            {!isMockConnection(connId) && (
              <ContextMenuItem
                className={ctxItemClass}
                onClick={() => onWatchCollection?.(connId, dbName, collName)}
                data-testid="ctx-watch-collection"
              >
                <Radio />
                <span>{t('ctx.watchCollection')}</span>
              </ContextMenuItem>
            )}
            <ContextMenuItem className={ctxItemClass} onClick={() => onAnalyzeSchema?.(connId, dbName, collName)}>
              <Table2 />
              <span>{t('ctx.analyzeSchema')}</span>
            </ContextMenuItem>
            {collType !== 'view' && collType !== 'timeseries' && !collName.startsWith('system.') && !/\.(files|chunks)$/.test(collName) && (
              <ContextMenuItem className={ctxItemClass} onClick={() => onEditValidation?.(connId, dbName, collName)}>
                <ShieldCheck />
                <span>{t('ctx.validationRules')}</span>
              </ContextMenuItem>
            )}
            {/* #91: same shape gate as Validation Rules above (not
                view/timeseries/system./gridfs bucket) — but, unlike Dump
                below, NOT gated on `isMockConnection`: a mock connection's
                generate run VALIDATES the template/count without writing
                anything (mock_db has no insert capability at all), so mock
                connections keep this entry — it's just a dry run there. */}
            {collType !== 'view' && collType !== 'timeseries' && !collName.startsWith('system.') && !/\.(files|chunks)$/.test(collName) && (
              <ContextMenuItem
                className={ctxItemClass}
                data-testid={`ctx-generate-coll-${connId}-${dbName}-${collName}`}
                onClick={() => onOpenGenerate?.(connId, dbName, collName)}
              >
                <Wand2 />
                <span>{t('ctx.generateData')}</span>
              </ContextMenuItem>
            )}
            {!isMockConnection(connId) && (
              <ContextMenuItem
                className={ctxItemClass}
                data-testid={`ctx-dump-coll-${connId}-${dbName}-${collName}`}
                onClick={() => onOpenDump?.(connId, dbName, collName)}
              >
                <DatabaseBackup />
                <span>{t('ctx.dump')}</span>
              </ContextMenuItem>
            )}
            <ContextMenuItem
              className={ctxItemClass}
              onClick={() => onCopyToClipboard?.(connId, dbName, selectedNamesFor(connId, dbName, collName))}
            >
              <Copy />
              <span>{t('ctx.copy')}</span>
            </ContextMenuItem>
            <ContextMenuItem
              className={ctxItemClass}
              onClick={() => onCopyCollections?.(connId, dbName, selectedNamesFor(connId, dbName, collName))}
            >
              {t('ctx.copyTo')}
            </ContextMenuItem>
            <ContextMenuItem
              className={ctxItemClass}
              onClick={() => navigator.clipboard?.writeText(collName)}
            >
              <FolderOpen />
              <span>{t('ctx.copyCollectionName')}</span>
            </ContextMenuItem>
            <ContextMenuItem className={ctxItemClass} onClick={() => handleRenameCollection(connId, dbName, collName)}>
              <Pencil />
              <span>{t('ctx.renameCollection')}</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={cn(ctxItemClass, 'text-destructive focus:text-destructive')}
              onClick={() => handleDropCollection(connId, dbName, collName)}
            >
              <Trash2 />
              <span>
                {(collections[`${connId}/${dbName}`] || []).find((c) => c.name === collName)?.type === 'view'
                  ? t('ctx.dropView')
                  : t('ctx.dropCollection')}
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
                  <span className="text-muted-foreground">{t('tree.indexesLabel')}</span>
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
                  <span>{t('ctx.createIndex')}</span>
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
                          {...statsHoverHandlers({ kind: 'index', connId, db: dbName, coll: collName, index: indexName })}
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
                          <span>{t('ctx.copyIndexName')}</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className={cn(ctxItemClass, 'text-destructive focus:text-destructive')}
                          onClick={() => onDeleteIndex?.(connId, dbName, collName, indexName)}
                        >
                          <Trash2 />
                          <span>{t('ctx.deleteIndex')}</span>
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
                {collIndexes.length === 0 && (
                  <div className="py-0.5 pl-6 text-[9px] italic text-muted-foreground">{t('tree.empty')}</div>
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
          <span className="text-[11px]">{t('empty.noConnections')}</span>
          <Button size="sm" onClick={onOpenConnectionManager} aria-label={t('empty.connectAriaLabel')}>
            <Plus className="mr-1.5 size-3" />
            {t('empty.connectButton')}
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
                    aria-label={t('connection.ariaLabel', { name: conn.name })}
                    onClick={() => setExpandedConnections((prev) => ({ ...prev, [conn.id]: !prev[conn.id] }))}
                    {...statsHoverHandlers({ kind: 'connection', connId: conn.id })}
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
                          aria-label={t('connection.colorAriaLabel')}
                        />
                      )}
                      <Server size={12} className="shrink-0 text-primary" />
                      <span className="min-w-0 truncate font-medium">{conn.name}</span>
                      {conn.viaMcp && (
                        <Badge
                          variant="secondary"
                          className="h-4 shrink-0 px-1 text-[9px] font-normal text-muted-foreground"
                          data-testid="connection-via-mcp-badge"
                          aria-label={t('connection.viaMcpAriaLabel')}
                        >
                          {t('connection.viaMcpBadge')}
                        </Badge>
                      )}
                      {conn.mode && conn.mode !== 'normal' && (
                        <Badge
                          variant={conn.mode === 'read_only' ? 'destructive' : 'warning'}
                          className="h-4 shrink-0 px-1 text-[9px] font-normal"
                          data-testid="connection-mode-badge"
                          data-mode={conn.mode}
                          aria-label={conn.mode === 'read_only' ? t('connection.readOnlyAriaLabel') : t('connection.guardedAriaLabel')}
                        >
                          {conn.mode === 'read_only' ? t('connection.readOnlyBadge') : t('connection.guardedBadge')}
                        </Badge>
                      )}
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                        aria-label={t('connection.connectedAriaLabel')}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        loadDatabases(conn.id);
                      }}
                      aria-label={t('connection.refreshAriaLabel')}
                    >
                      <RefreshCw className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDisconnect(conn.id);
                      }}
                      aria-label={t('ctx.disconnect')}
                    >
                      <LogOut className="size-3" />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem className={ctxItemClass} onClick={() => handleAddDatabase(conn.id)}>
                    <Plus />
                    <span>{t('ctx.addDatabase')}</span>
                  </ContextMenuItem>
                  <ContextMenuItem className={ctxItemClass} onClick={() => loadDatabases(conn.id)}>
                    <RefreshCw />
                    <span>{t('ctx.refreshDatabases')}</span>
                  </ContextMenuItem>
                  {canPaste && (
                    <ContextMenuItem className={ctxItemClass} onClick={() => onPasteInto?.(conn.id)}>
                      <ClipboardPaste />
                      <span>{t('ctx.pasteHere')}</span>
                    </ContextMenuItem>
                  )}
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
                        return entry ? pinMenuLabel(entry) : t('ctx.pinToSidebar');
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
                        return entry ? favoriteMenuLabel(entry) : t('ctx.addToFavorites');
                      })()}
                    </span>
                  </ContextMenuItem>
                  <ContextMenuItem className={ctxItemClass} onClick={onOpenConnectionManager}>
                    <Server />
                    <span>{t('ctx.manageConnections')}</span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={ctxItemClass}
                    data-testid="ctx-monitor"
                    onClick={() => onOpenMonitoring?.(conn.id)}
                  >
                    <Activity />
                    <span>{t('ctx.monitorCluster')}</span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={ctxItemClass}
                    data-testid="ctx-users"
                    onClick={() => onOpenUsers?.(conn.id)}
                  >
                    <Users />
                    <span>{t('ctx.manageUsersConnection')}</span>
                  </ContextMenuItem>
                  {!isMockConnection(conn.id) && (
                    <ContextMenuItem
                      className={ctxItemClass}
                      data-testid={`ctx-dump-${conn.id}`}
                      onClick={() => onOpenDump?.(conn.id)}
                    >
                      <DatabaseBackup />
                      <span>{t('ctx.dump')}</span>
                    </ContextMenuItem>
                  )}
                  {!isMockConnection(conn.id) && (
                    <ContextMenuItem
                      className={ctxItemClass}
                      data-testid={`ctx-restore-${conn.id}`}
                      onClick={() => onOpenRestore?.(conn.id)}
                    >
                      <DatabaseZap />
                      <span>{t('ctx.restore')}</span>
                    </ContextMenuItem>
                  )}
                  {!isMockConnection(conn.id) && (
                    <ContextMenuItem
                      className={ctxItemClass}
                      data-testid={`ctx-watch-deployment-${conn.id}`}
                      onClick={() => onWatchCollection?.(conn.id)}
                    >
                      <Radio />
                      <span>{t('ctx.watchDeployment')}</span>
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={cn(ctxItemClass, 'text-destructive focus:text-destructive')}
                    onClick={() => onDisconnect(conn.id)}
                  >
                    <LogOut />
                    <span>{t('ctx.disconnect')}</span>
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
                              aria-label={t('tree.databaseAriaLabel', { name: dbName })}
                              onClick={() => toggleDb(conn.id, dbName)}
                              {...statsHoverHandlers({ kind: 'database', connId: conn.id, db: dbName })}
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
                              <span>{t('ctx.addCollection')}</span>
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
                              <span>{t('ctx.createView')}</span>
                            </ContextMenuItem>
                            <ContextMenuItem className={ctxItemClass} onClick={() => onCopyToClipboard?.(conn.id, dbName, [])}>
                              <Copy />
                              <span>{t('ctx.copyDatabase')}</span>
                            </ContextMenuItem>
                            <ContextMenuItem className={ctxItemClass} onClick={() => onCopyDatabase?.(conn.id, dbName)}>
                              {t('ctx.copyDatabaseTo')}
                            </ContextMenuItem>
                            {canPaste && (
                              <ContextMenuItem className={ctxItemClass} onClick={() => onPasteInto?.(conn.id, dbName)}>
                                <ClipboardPaste />
                                <span>{t('ctx.pasteHere')}</span>
                              </ContextMenuItem>
                            )}
                            <ContextMenuItem
                              className={ctxItemClass}
                              data-testid={`ctx-add-gridfs-bucket-${conn.id}-${dbName}`}
                              onClick={() => void handleOpenGridfsBucket(conn.id, dbName)}
                            >
                              <Archive />
                              <span>{t('ctx.newBucket')}</span>
                            </ContextMenuItem>
                            {!isMockConnection(conn.id) && (
                              <ContextMenuItem
                                className={ctxItemClass}
                                data-testid={`ctx-watch-database-${conn.id}-${dbName}`}
                                onClick={() => onWatchCollection?.(conn.id, dbName)}
                              >
                                <Radio />
                                <span>{t('ctx.watchDatabase')}</span>
                              </ContextMenuItem>
                            )}
                            <ContextMenuItem
                              className={ctxItemClass}
                              onClick={() => onOpenShell?.(conn.id, dbName, undefined, 'show collections')}
                            >
                              <Terminal />
                              <span>{t('ctx.openShell')}</span>
                            </ContextMenuItem>
                            <ContextMenuItem className={ctxItemClass} onClick={() => handleRefreshDb(conn.id, dbName)}>
                              <RefreshCw />
                              <span>{t('ctx.refreshDatabase')}</span>
                            </ContextMenuItem>
                            <ContextMenuItem className={ctxItemClass} onClick={() => handleRenameDatabase(conn.id, dbName)}>
                              <Pencil />
                              <span>{t('ctx.renameDatabase')}</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              className={ctxItemClass}
                              data-testid="ctx-db-users"
                              onClick={() => onOpenUsers?.(conn.id, dbName)}
                            >
                              <Users />
                              <span>{t('ctx.manageUsersDatabase')}</span>
                            </ContextMenuItem>
                            {!isMockConnection(conn.id) && (
                              <ContextMenuItem
                                className={ctxItemClass}
                                data-testid={`ctx-dump-db-${conn.id}-${dbName}`}
                                onClick={() => onOpenDump?.(conn.id, dbName)}
                              >
                                <DatabaseBackup />
                                <span>{t('ctx.dump')}</span>
                              </ContextMenuItem>
                            )}
                            {/* #91: mocks ALLOWED (unlike Dump above) — see the
                                collection-row entry's comment for why. */}
                            <ContextMenuItem
                              className={ctxItemClass}
                              data-testid={`ctx-generate-db-${conn.id}-${dbName}`}
                              onClick={() => onOpenGenerate?.(conn.id, dbName)}
                            >
                              <Wand2 />
                              <span>{t('ctx.generateData')}</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              className={cn(ctxItemClass, 'text-destructive focus:text-destructive')}
                              onClick={() => handleDropDatabase(conn.id, dbName)}
                            >
                              <Trash2 />
                              <span>{t('ctx.dropDatabase')}</span>
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>

                        {isDbExpanded && (
                          <div className="ml-3 border-l border-border/50 pl-1">
                            <ContextMenu>
                              <ContextMenuTrigger asChild>
                                <div>
                                  <div className={treeRowClass()} onClick={() => toggleCollectionsFolder(conn.id, dbName)}>
                                    <ChevronRight
                                      size={10}
                                      className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isFolderExpanded && 'rotate-90')}
                                    />
                                    <Folder size={11} className="shrink-0 text-amber-500" />
                                    <span className="text-muted-foreground">{t('tree.collectionsLabel')}</span>
                                    <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="collections-count">
                                      ({regularColls.length})
                                    </Badge>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="ml-auto h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                                      data-testid={`collections-new-${conn.id}-${dbName}`}
                                      aria-label={t('tree.newCollectionAriaLabel')}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleAddCollection(conn.id, dbName);
                                      }}
                                    >
                                      <Plus size={11} />
                                    </Button>
                                  </div>
                                  {isFolderExpanded && (
                                    <div className="ml-3 border-l border-border/50 pl-1">
                                      {regularColls.map((collName) => renderCollectionNode(conn.id, dbName, collName))}
                                      {regularColls.length === 0 && (
                                        <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">{t('tree.empty')}</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem
                                  className={ctxItemClass}
                                  data-testid={`ctx-collections-new-${conn.id}-${dbName}`}
                                  onClick={() => void handleAddCollection(conn.id, dbName)}
                                >
                                  <Plus />
                                  <span>{t('ctx.newCollection')}</span>
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>

                            <ContextMenu>
                              <ContextMenuTrigger asChild>
                                <div>
                                  <div className={treeRowClass()} onClick={() => toggleVirtualFolder(`${dbKey}/views`)}>
                                    <ChevronRight
                                      size={10}
                                      className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isViewsExpanded && 'rotate-90')}
                                    />
                                    <Eye size={11} className="shrink-0 text-amber-500" />
                                    <span className="text-muted-foreground">{t('tree.viewsLabel')}</span>
                                    <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="views-count">
                                      ({views.length})
                                    </Badge>
                                  </div>
                                  {isViewsExpanded && (
                                    <div className="ml-3 border-l border-border/50 pl-1">
                                      {views.map((viewName) => renderCollectionNode(conn.id, dbName, viewName))}
                                      {views.length === 0 && (
                                        <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">{t('tree.empty')}</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem
                                  className={ctxItemClass}
                                  data-testid={`ctx-views-create-${conn.id}-${dbName}`}
                                  onClick={() => onCreateView?.(conn.id, dbName)}
                                >
                                  <Eye />
                                  <span>{t('ctx.createView')}</span>
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>

                            <ContextMenu>
                              <ContextMenuTrigger asChild>
                                <div>
                                  <div className={treeRowClass()} onClick={() => toggleVirtualFolder(`${dbKey}/gridfs`)}>
                                    <ChevronRight
                                      size={10}
                                      className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isGridfsExpanded && 'rotate-90')}
                                    />
                                    <Archive size={11} className="shrink-0 text-amber-500" />
                                    <span className="text-muted-foreground">{t('tree.gridfsBucketsLabel')}</span>
                                    <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="gridfs-count">
                                      ({gridfsBuckets.length})
                                    </Badge>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="ml-auto h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                                      data-testid={`gridfs-new-bucket-${conn.id}-${dbName}`}
                                      aria-label={t('tree.newBucketAriaLabel')}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleOpenGridfsBucket(conn.id, dbName);
                                      }}
                                    >
                                      <Plus size={11} />
                                    </Button>
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
                                          <span className="min-w-0 truncate">
                                            {bucket}
                                          </span>
                                        </div>
                                      ))}
                                      <div
                                        className={cn(treeRowClass(), 'text-[10px] text-primary')}
                                        data-testid={`gridfs-open-bucket-${conn.id}-${dbName}`}
                                        onClick={() => void handleOpenGridfsBucket(conn.id, dbName)}
                                      >
                                        <Plus size={11} className="ml-3.5 shrink-0" />
                                        <span>{t('tree.newBucketInline')}</span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem
                                  className={ctxItemClass}
                                  data-testid={`ctx-gridfs-new-bucket-${conn.id}-${dbName}`}
                                  onClick={() => void handleOpenGridfsBucket(conn.id, dbName)}
                                >
                                  <Plus />
                                  <span>{t('ctx.newBucket')}</span>
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>

                            <ContextMenu>
                              <ContextMenuTrigger asChild>
                                <div>
                                  <div className={treeRowClass()} onClick={() => toggleVirtualFolder(`${dbKey}/system`)}>
                                    <ChevronRight
                                      size={10}
                                      className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isSystemExpanded && 'rotate-90')}
                                    />
                                    <Cog size={11} className="shrink-0 text-amber-500" />
                                    <span className="text-muted-foreground">{t('tree.systemLabel')}</span>
                                    <Badge variant="secondary" className="h-4 px-1 text-[9px] font-normal" data-testid="system-count">
                                      ({systemColls.length})
                                    </Badge>
                                  </div>
                                  {isSystemExpanded && (
                                    <div className="ml-3 border-l border-border/50 pl-1">
                                      {systemColls.map((collName) => renderCollectionNode(conn.id, dbName, collName))}
                                      {systemColls.length === 0 && (
                                        <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">{t('tree.empty')}</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem
                                  className={ctxItemClass}
                                  data-testid={`ctx-system-refresh-${conn.id}-${dbName}`}
                                  onClick={() => void handleRefreshDb(conn.id, dbName)}
                                >
                                  <RefreshCw />
                                  <span>{t('ctx.refreshDatabase')}</span>
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {connDbs.length === 0 && (
                    <div className="py-0.5 pl-6 text-[10px] italic text-muted-foreground">{t('tree.empty')}</div>
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
          <span className="text-ui-xs font-semibold tracking-wide">{t('header.title')}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onOpenSettings} aria-label={t('header.openSettingsAriaLabel')}>
            <Settings className="size-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t('header.helpAriaLabel')}
                data-testid="help-menu-btn"
              >
                <HelpCircle className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {helpLinks.map(({ Icon, label, url }) => (
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
            aria-label={t('ctx.manageConnections')}
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
              ref={searchInputRef}
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder={t('search.placeholder')}
              aria-label={t('search.ariaLabel')}
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
                aria-label={t('search.clearAriaLabel')}
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
              title={t('sections.connections')}
              icon={Server}
              open={sectionsOpen.connections}
              onOpenChange={(open) => setSectionsOpen((s) => ({ ...s, connections: open }))}
            >
              {renderConnectionsTree()}
            </SidebarSection>

            <SidebarSection
              title={t('sections.pinned')}
              icon={Pin}
              open={sectionsOpen.pinned}
              onOpenChange={(open) => setSectionsOpen((s) => ({ ...s, pinned: open }))}
              isEmpty={pinnedItems.length === 0}
              emptyText={t('empty.pinnedHint')}
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
                            <span className="min-w-0 truncate">
                              {label}
                            </span>
                            <span className="ml-auto truncate text-[10px] text-muted-foreground">
                              {subtitle}
                              {!connected && t('tree.offlineSuffix')}
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            className={ctxItemClass}
                            onClick={() => void navigateToPinned(p)}
                          >
                            <FolderOpen />
                            <span>{t('ctx.open')}</span>
                          </ContextMenuItem>
                          <ContextMenuItem
                            className={ctxItemClass}
                            onSelect={() => {
                              const next = unpinItem(pinnedItems, p);
                              setPinnedItems(next);
                            }}
                          >
                            <Pin />
                            <span>{t('ctx.unpin')}</span>
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
              </div>
            </SidebarSection>

            <SidebarSection
              title={t('sections.favorites')}
              icon={Heart}
              open={sectionsOpen.favorites}
              onOpenChange={(open) => {
                setSectionsOpen((s) => ({ ...s, favorites: open }));
                if (open) void reloadSavedQueryCatalog();
              }}
              isEmpty={favoriteItems.length === 0}
              emptyText={t('empty.favoritesHint')}
            >
              <div className="flex flex-col gap-0.5 pb-1">
                {favoriteItems.map((fav) => {
                    const connected = Boolean(connectionIdForName(fav.connectionName));
                    const label = favoriteItemLabel(fav, t);
                    const subtitle = favoriteItemSubtitle(fav, t);
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
                              {!connected && fav.kind !== 'query' ? t('tree.offlineSuffix') : ''}
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            className={ctxItemClass}
                            onClick={() => void navigateToFavorite(fav)}
                          >
                            <FolderOpen />
                            <span>{t('ctx.open')}</span>
                          </ContextMenuItem>
                          <ContextMenuItem
                            className={ctxItemClass}
                            onSelect={() => {
                              const next = removeFavoriteItem(favoriteItems, fav);
                              setFavoriteItems(next);
                            }}
                          >
                            <Heart />
                            <span>{t('ctx.removeFromFavorites')}</span>
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
              </div>
            </SidebarSection>

            <SidebarSection
              title={t('sections.folders')}
              icon={FolderOpen}
              open={sectionsOpen.folders}
              onOpenChange={(open) => setSectionsOpen((s) => ({ ...s, folders: open }))}
              emptyText={
                connectionProfiles.length === 0
                  ? t('empty.foldersHint')
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
                                      aria-label={t('connection.connectedAriaLabel')}
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
                        >
                          <Server
                            size={11}
                            className={cn(
                              'shrink-0',
                              isConnected ? 'text-emerald-500' : 'text-muted-foreground',
                            )}
                          />
                          <span className="min-w-0 truncate">{profile.name}</span>
                          <span className="ml-auto text-[10px] text-muted-foreground">{t('tree.rootLabel')}</span>
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
                    {t('folders.manageConnectionsButton')}
                  </Button>
                </div>
              )}
            </SidebarSection>
          </div>
      </ScrollArea>

      <footer className="flex shrink-0 items-center justify-between border-t border-border px-3 py-2">
        <ThemePicker />
        <span className="text-[10px] text-muted-foreground">{t('footer.themeLabel')}</span>
      </footer>

      {/* Single root-level stats popover shared by connection/database/collection/index
          rows (issue #178) — the virtual anchor positions it at the cursor regardless
          of which row triggered it, so it doesn't need to live inside the tree map. */}
      <Popover
        open={statsPopover !== null}
        onOpenChange={(open) => {
          if (!open) {
            cancelStatsTimers();
            setStatsPopover(null);
          }
        }}
      >
        <PopoverAnchor virtualRef={statsVirtualAnchor} />
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onMouseEnter={cancelStatsTimers}
          onMouseLeave={scheduleStatsClose}
        >
          {statsPopover?.kind === 'connection' &&
            (() => {
              const conn = activeConnections.find((c) => c.id === statsPopover.connId);
              return (
                <ClusterHealthCard
                  connectionId={statsPopover.connId}
                  connectionName={conn?.name}
                  connectionUri={conn?.uri}
                  onOpenMonitoring={onOpenMonitoring}
                />
              );
            })()}
          {statsPopover?.kind === 'database' && (
            <DbStatsCard connectionId={statsPopover.connId} db={statsPopover.db} />
          )}
          {statsPopover?.kind === 'collection' && (
            <CollStatsCard connectionId={statsPopover.connId} db={statsPopover.db} collection={statsPopover.coll} />
          )}
          {statsPopover?.kind === 'index' && (
            <IndexStatsCard
              connectionId={statsPopover.connId}
              db={statsPopover.db}
              collection={statsPopover.coll}
              indexName={statsPopover.index}
            />
          )}
        </PopoverContent>
      </Popover>
    </aside>
    </EmptySpaceContextMenu>
  );
};
