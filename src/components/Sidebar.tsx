import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useDialogs } from './dialogs/DialogProvider';
import { fuzzyMatch } from '../lib/fuzzyMatch';
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
  Sun,
  Moon,
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
  X
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

interface SidebarProps {
  onSelectCollection: (connectionId: string, dbName: string, collName: string) => void;
  onSelectIndex: (connectionId: string, dbName: string, collName: string, indexName: string) => void;
  activeCollection: { connectionId: string; db: string; collection: string; indexName?: string } | null;
  activeConnections: { id: string; name: string; uri: string }[];
  onOpenConnectionManager: () => void;
  onDisconnect: (connectionId: string) => void;
  width?: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onCreateIndex?: (connectionId: string, dbName: string, collName: string) => void;
  onDeleteIndex?: (connectionId: string, dbName: string, collName: string, indexName: string) => void;
  onOpenShell?: (connectionId: string, dbName: string, collName?: string, initialCommand?: string) => void;
  onOpenMonitoring?: (connectionId: string) => void;
  onOpenUsers?: (connectionId: string) => void;
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
}

interface SidebarContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}

const SidebarContextMenu: React.FC<SidebarContextMenuProps> = ({ x, y, onClose, children }) => {
  const [pos, setPos] = useState({ x, y, ready: false });
  const ref = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let newX = x;
    let newY = y;
    if (x + r.width > window.innerWidth) newX = window.innerWidth - r.width - 8;
    if (y + r.height > window.innerHeight) newY = window.innerHeight - r.height - 8;
    newX = Math.max(8, newX);
    newY = Math.max(8, newY);
    setPos({ x: newX, y: newY, ready: true });
  }, [x, y]);

  useEffect(() => {
    const handleClose = () => onClose();
    window.addEventListener('click', handleClose);
    window.addEventListener('scroll', handleClose, true);
    return () => {
      window.removeEventListener('click', handleClose);
      window.removeEventListener('scroll', handleClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="mql-ctx-menu"
      style={{
        left: pos.x,
        top: pos.y,
        visibility: pos.ready ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {children}
    </div>,
    document.body
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  onSelectCollection,
  onSelectIndex,
  activeCollection,
  activeConnections,
  onOpenConnectionManager,
  onDisconnect,
  width,
  theme,
  onToggleTheme,
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
}) => {
  const { toast, confirm, prompt } = useDialogs();
  // Tree filter: matches connection / database / (loaded) collection names.
  const [filterQuery, setFilterQuery] = useState('');
  useEffect(() => {
    onFilterQueryChange?.(filterQuery);
  }, [filterQuery, onFilterQueryChange]);
  const [helpOpen, setHelpOpen] = useState(false);
  // key: connectionId, value: database names list
  const [databases, setDatabases] = useState<{ [connectionId: string]: string[] }>({});
  
  // key: `${connectionId}/${dbName}`, value: collection info list (name + type)
  const [collections, setCollections] = useState<{ [connectionDbKey: string]: CollectionInfo[] }>({});

  // key: `${connectionId}/${dbName}/${collName}`, value: index names list
  const [indexes, setIndexes] = useState<{ [connectionDbCollKey: string]: IndexInfo[] }>({});

  // Expanded States
  const [expandedConnections, setExpandedConnections] = useState<{ [connectionId: string]: boolean }>({});
  const [expandedDbs, setExpandedDbs] = useState<{ [connectionDbKey: string]: boolean }>({});
  const [expandedCollectionsFolders, setExpandedCollectionsFolders] = useState<{ [connectionDbFolderKey: string]: boolean }>({});
  const [expandedCollections, setExpandedCollections] = useState<{ [connectionDbCollKey: string]: boolean }>({});
  const [expandedIndexesFolders, setExpandedIndexesFolders] = useState<{ [connectionDbCollKey: string]: boolean }>({});

  const toggleIndexesFolder = (connectionId: string, dbName: string, collName: string) => {
    const key = `${connectionId}/${dbName}/${collName}`;
    setExpandedIndexesFolders((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    connectionId?: string;
    dbName?: string;
    collName?: string;
    indexName?: string;
    isIndexesFolder?: boolean;
    isConnectionNode?: boolean;
    isEmptySpace?: boolean;
  } | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    const handleOutsideClick = () => setContextMenu(null);
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  // Fetch databases and automatically expand for new connections
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

    // Cleanup disconnected connections from databases list
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

  // Re-fetch indexes for all currently expanded collections when indexMutationTrigger changes
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

  // Re-fetch collections for every expanded database when a collection/view is added.
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

  // Toggle a virtual category folder (Views / GridFS Buckets / System) — these are
  // derived from the already-loaded collection list, so no fetch is needed.
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

  const handleContextMenu = (
    e: React.MouseEvent,
    connectionId?: string,
    dbName?: string,
    collName?: string,
    indexName?: string,
    isIndexesFolder?: boolean,
    isConnectionNode?: boolean
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      connectionId,
      dbName,
      collName,
      indexName,
      isIndexesFolder,
      isConnectionNode
    });
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

    // A MongoDB database only exists once it has a collection — create the first one.
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

  const handleEmptySpaceContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.classList.contains('sidebar') ||
      target.classList.contains('database-tree-container') ||
      target.classList.contains('sidebar-empty-prompt')
    ) {
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        isEmptySpace: true
      });
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

  const handleRenameCollection = async (
    connectionId: string,
    dbName: string,
    collName: string
  ) => {
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
        [dbKey]: (prev[dbKey] || []).map((c) =>
          c.name === collName ? { ...c, name: newName } : c
        ),
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

  // Renders a single collection node (the row plus its nested indexes folder).
  // Shared by the Collections and System virtual folders so both behave identically.
  const renderCollectionNode = (connId: string, dbName: string, collName: string) => {
    const collKey = `${connId}/${dbName}/${collName}`;
    const isCollExpanded = expandedCollections[collKey];
    const collIndexes = indexes[collKey] || [];
    const isActive = activeCollection?.connectionId === connId && activeCollection?.db === dbName && activeCollection?.collection === collName && !activeCollection?.indexName;

    return (
      <div key={collName} className="mql-tree-node">
        <div
          onClick={() => {
            onSelectCollection(connId, dbName, collName);
            toggleCollectionNode(connId, dbName, collName);
          }}
          onContextMenu={(e) => handleContextMenu(e, connId, dbName, collName)}
          className={`mql-row-h mql-tree-row mql-coll-row ${isActive ? 'is-active' : ''}`}
        >
          <ChevronRight
            size={10}
            className={`transition-transform duration-150 ${isCollExpanded ? 'rotate-90' : ''}`}
            style={{ color: 'var(--text-dim)', flexShrink: 0 }}
          />
          <Layers size={11} className={isActive ? 'text-[var(--accent-blue)]' : 'text-[var(--accent-green)]'} style={{ flexShrink: 0 }} />
          <span className="mql-coll-name" title={collName}>{collName}</span>
        </div>

        {/* Indexes Folder under collection node */}
        {isCollExpanded && (
          <div className="mql-tree-children">
            <div
              className="mql-row-h mql-tree-row"
              onClick={(e) => {
                e.stopPropagation();
                toggleIndexesFolder(connId, dbName, collName);
              }}
              onContextMenu={(e) => handleContextMenu(e, connId, dbName, collName, undefined, true)}
            >
              <ChevronRight
                size={10}
                className={`transition-transform duration-150 ${expandedIndexesFolders[`${connId}/${dbName}/${collName}`] ? 'rotate-90' : ''}`}
                style={{ color: 'var(--text-dim)', flexShrink: 0 }}
              />
              <Folder size={11} className="text-[var(--accent-amber)] flex-shrink-0" />
              <span className="mql-folder-label">indexes</span>
              {collIndexes && collIndexes.length > 0 && (
                <span className="mql-count" data-testid="indexes-count">
                  ({collIndexes.length})
                </span>
              )}
            </div>

            {expandedIndexesFolders[`${connId}/${dbName}/${collName}`] && (
              <div className="mql-tree-children">
                {collIndexes.map((idx) => {
                  const indexName = idx.name;
                  const isIndexActive = activeCollection?.connectionId === connId && activeCollection?.db === dbName && activeCollection?.collection === collName && activeCollection?.indexName === indexName;
                  return (
                    <div
                      key={indexName}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectIndex(connId, dbName, collName, indexName);
                      }}
                      onContextMenu={(e) => handleContextMenu(e, connId, dbName, collName, indexName)}
                      className={`mql-row-h mql-tree-row mql-idx-row ${isIndexActive ? 'is-active' : ''}`}
                    >
                      <KeyRound size={10} className={isIndexActive ? 'text-[var(--accent-blue)]' : 'text-[var(--accent-amber)] flex-shrink-0'} />
                      <span className="mql-idx-name">{indexName}</span>
                    </div>
                  );
                })}
                {collIndexes.length === 0 && (
                  <div className="text-[9px] text-[var(--text-dim)] pl-6 py-0.5 italic">Empty</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      style={width ? { width: `${width}px` } : undefined}
      className="sidebar mql-sidebar"
      onContextMenu={handleEmptySpaceContextMenu}
    >
      {/* Sidebar Header */}
      <header className="mql-sidebar-h">
        <div className="mql-row" style={{ gap: 6 }}>
          <Server size={14} className="text-[var(--accent-blue)]" />
          <span style={{ fontWeight: 600, fontSize: 12, letterSpacing: '0.02em' }}>MQLens Workspace</span>
        </div>
        <div className="mql-row" style={{ gap: 2 }}>
          <button
            onClick={onToggleTheme}
            className="mql-icon-btn"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label="Toggle Theme"
          >
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
          </button>
          <button
            onClick={onOpenSettings}
            className="mql-icon-btn"
            title="Settings"
            aria-label="Open Settings"
          >
            <Settings size={13} />
          </button>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              onClick={() => setHelpOpen((o) => !o)}
              className="mql-icon-btn"
              title="Help & feedback"
              aria-label="Help and feedback"
              aria-haspopup="menu"
              aria-expanded={helpOpen}
              data-testid="help-menu-btn"
            >
              <HelpCircle size={13} />
            </button>
            {helpOpen && (
              <>
                <div
                  onClick={() => setHelpOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 60 }}
                  aria-hidden="true"
                />
                <div className="mql-help-menu" role="menu">
                  {HELP_LINKS.map(({ Icon, label, url }) => (
                    <button
                      key={label}
                      type="button"
                      role="menuitem"
                      onClick={() => { setHelpOpen(false); void openUrl(url); }}
                    >
                      <Icon size={13} /> <span>{label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </span>
          <button
            onClick={onOpenConnectionManager}
            className="mql-icon-btn"
            title="Manage Connections"
            aria-label="Manage Connections"
          >
            <Plus size={14} />
          </button>
        </div>
      </header>

      {/* Filter / search the tree */}
      {activeConnections.length > 0 && (
        <div className="mql-tree-search">
          <Search size={12} className="mql-tree-search-icon" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Search connections, databases, collections…"
            aria-label="Search sidebar"
            data-testid="sidebar-search"
          />
          {filterQuery && (
            <button
              type="button"
              className="mql-tree-search-clear"
              onClick={() => setFilterQuery('')}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* Database Navigation Tree */}
      <div
        className="mql-tree-scroll database-tree-container"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) handleEmptySpaceContextMenu(e);
        }}
      >
        {activeConnections.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {activeConnections.map((conn) => {
              const q = filterQuery.trim();
              const filterActive = q.length > 0;
              const connDbs = databases[conn.id] || [];
              const connNameMatch = filterActive && fuzzyMatch(q, conn.name);
              const visibleDbs = connDbs.filter((dbName) =>
                !filterActive ||
                connNameMatch ||
                fuzzyMatch(q, dbName) ||
                (collections[`${conn.id}/${dbName}`] || []).some((c) => fuzzyMatch(q, c.name))
              );
              // Hide a connection entirely when nothing under it matches.
              if (filterActive && !connNameMatch && visibleDbs.length === 0) return null;
              // While filtering, auto-reveal connections so matches are visible.
              const isConnExpanded = expandedConnections[conn.id] || filterActive;

              return (
                <div key={conn.id} className="mql-tree-node">
                  {/* Connection Node */}
                  <div
                    className="mql-conn-row"
                    role="button"
                    aria-expanded={isConnExpanded}
                    aria-label={`Connection ${conn.name}`}
                    onClick={() => setExpandedConnections((prev) => ({ ...prev, [conn.id]: !prev[conn.id] }))}
                    onContextMenu={(e) => handleContextMenu(e, conn.id, undefined, undefined, undefined, false, true)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
                      <ChevronRight 
                        size={11} 
                        className={`transition-transform duration-150 ${isConnExpanded ? 'rotate-90' : ''}`} 
                        style={{ color: 'var(--text-dim)', flexShrink: 0 }} 
                      />
                      <Server size={12} className="text-[var(--accent-blue)] flex-shrink-0" />
                      <span className="mql-conn-name">{conn.name}</span>
                      <span className="mql-live-dot" title="Connected" />
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDisconnect(conn.id);
                      }}
                      title="Disconnect Connection"
                      aria-label="Disconnect"
                      className="mql-icon-btn mql-disconnect-btn"
                      style={{ padding: '2px', opacity: 0.8, color: 'var(--text-muted)' }}
                    >
                      <LogOut size={12} />
                    </button>
                  </div>

                  {/* Databases List */}
                  {isConnExpanded && (
                    <div className="mql-tree-children">
                      {visibleDbs.map((dbName) => {
                        const dbKey = `${conn.id}/${dbName}`;
                        const rawColls = collections[dbKey] || [];
                        // When filtering and neither the connection nor the db name
                        // matches, narrow the db's collections to the matches and
                        // auto-expand so they're visible.
                        const dbNameMatch = filterActive && (connNameMatch || fuzzyMatch(q, dbName));
                        const dbColls = filterActive && !dbNameMatch
                          ? rawColls.filter((c) => fuzzyMatch(q, c.name))
                          : rawColls;
                        const autoExpandDb = filterActive && !dbNameMatch && dbColls.length > 0;
                        const isDbExpanded = expandedDbs[dbKey] || autoExpandDb;
                        const isFolderExpanded = expandedCollectionsFolders[`${dbKey}/collections`] || autoExpandDb;

                        // Separate the flat collection list into the standard MongoDB
                        // categories. Views come from the backend's collection type;
                        // GridFS buckets are derived from the `<bucket>.files` convention;
                        // System covers the `system.*` namespace.
                        const systemColls = dbColls
                          .filter((c) => c.name.startsWith('system.'))
                          .map((c) => c.name)
                          .sort(compareCollectionNames);
                        const gridfsBuckets = Array.from(
                          new Set(
                            dbColls
                              .filter((c) => /\.files$/.test(c.name))
                              .map((c) => c.name.replace(/\.files$/, ''))
                          )
                        ).sort(compareCollectionNames);
                        const gridfsColls = new Set(
                          gridfsBuckets.flatMap((b) => [`${b}.files`, `${b}.chunks`])
                        );
                        const views = dbColls
                          .filter((c) => c.type === 'view' && !c.name.startsWith('system.'))
                          .map((c) => c.name)
                          .sort(compareCollectionNames);
                        const regularColls = dbColls
                          .filter(
                            (c) =>
                              c.type !== 'view' &&
                              !c.name.startsWith('system.') &&
                              !gridfsColls.has(c.name)
                          )
                          .map((c) => c.name)
                          .sort(compareCollectionNames);

                        const isViewsExpanded = expandedCollectionsFolders[`${dbKey}/views`];
                        const isGridfsExpanded = expandedCollectionsFolders[`${dbKey}/gridfs`];
                        const isSystemExpanded = expandedCollectionsFolders[`${dbKey}/system`];

                        return (
                          <div key={dbName} className="mql-tree-node">
                            {/* Database Node */}
                            <div
                              className="mql-row-h mql-tree-row"
                              role="button"
                              aria-expanded={isDbExpanded}
                              aria-label={`Database ${dbName}`}
                              onClick={() => toggleDb(conn.id, dbName)}
                              onContextMenu={(e) => handleContextMenu(e, conn.id, dbName)}
                            >
                              <ChevronRight 
                                size={11} 
                                className={`transition-transform duration-150 ${isDbExpanded ? 'rotate-90' : ''}`} 
                                style={{ color: 'var(--text-dim)', flexShrink: 0 }} 
                              />
                              <Database size={12} className="text-[var(--accent-amber)] flex-shrink-0" />
                              <span className="mql-db-name">{dbName}</span>
                            </div>

                            {/* Database Subtree: category virtual folders */}
                            {isDbExpanded && (
                              <div className="mql-tree-children">
                                {/* Collections */}
                                <div
                                  className="mql-row-h mql-tree-row"
                                  onClick={() => toggleCollectionsFolder(conn.id, dbName)}
                                  onContextMenu={(e) => handleContextMenu(e, conn.id, dbName)}
                                >
                                  <ChevronRight
                                    size={10}
                                    className={`transition-transform duration-150 ${isFolderExpanded ? 'rotate-90' : ''}`}
                                    style={{ color: 'var(--text-dim)', flexShrink: 0 }}
                                  />
                                  <Folder size={11} className="text-[var(--accent-amber)] flex-shrink-0" />
                                  <span className="mql-folder-label">Collections</span>
                                  <span className="mql-count" data-testid="collections-count">
                                    ({regularColls.length})
                                  </span>
                                </div>
                                {isFolderExpanded && (
                                  <div className="mql-tree-children">
                                    {regularColls.map((collName) => renderCollectionNode(conn.id, dbName, collName))}
                                    {regularColls.length === 0 && (
                                      <div className="text-[10px] text-[var(--text-dim)] pl-6 py-0.5 italic">Empty</div>
                                    )}
                                  </div>
                                )}

                                {/* Views */}
                                <div
                                  className="mql-row-h mql-tree-row"
                                  onClick={() => toggleVirtualFolder(`${dbKey}/views`)}
                                >
                                  <ChevronRight
                                    size={10}
                                    className={`transition-transform duration-150 ${isViewsExpanded ? 'rotate-90' : ''}`}
                                    style={{ color: 'var(--text-dim)', flexShrink: 0 }}
                                  />
                                  <Eye size={11} className="text-[var(--accent-amber)] flex-shrink-0" />
                                  <span className="mql-folder-label">Views</span>
                                  <span className="mql-count" data-testid="views-count">
                                    ({views.length})
                                  </span>
                                </div>
                                {isViewsExpanded && (
                                  <div className="mql-tree-children">
                                    {views.map((viewName) => renderCollectionNode(conn.id, dbName, viewName))}
                                    {views.length === 0 && (
                                      <div className="text-[10px] text-[var(--text-dim)] pl-6 py-0.5 italic">Empty</div>
                                    )}
                                  </div>
                                )}

                                {/* GridFS Buckets */}
                                <div
                                  className="mql-row-h mql-tree-row"
                                  onClick={() => toggleVirtualFolder(`${dbKey}/gridfs`)}
                                >
                                  <ChevronRight
                                    size={10}
                                    className={`transition-transform duration-150 ${isGridfsExpanded ? 'rotate-90' : ''}`}
                                    style={{ color: 'var(--text-dim)', flexShrink: 0 }}
                                  />
                                  <Archive size={11} className="text-[var(--accent-amber)] flex-shrink-0" />
                                  <span className="mql-folder-label">GridFS Buckets</span>
                                  <span className="mql-count" data-testid="gridfs-count">
                                    ({gridfsBuckets.length})
                                  </span>
                                </div>
                                {isGridfsExpanded && (
                                  <div className="mql-tree-children">
                                    {gridfsBuckets.map((bucket) => (
                                      <div
                                        key={bucket}
                                        className="mql-row-h mql-tree-row mql-coll-row"
                                        onClick={() => onOpenGridfs?.(conn.id, dbName, bucket)}
                                      >
                                        <Archive size={11} className="text-[var(--accent-green)] flex-shrink-0" style={{ marginLeft: 14 }} />
                                        <span className="mql-coll-name" title={bucket}>{bucket}</span>
                                      </div>
                                    ))}
                                    {gridfsBuckets.length === 0 && (
                                      <div className="text-[10px] text-[var(--text-dim)] pl-6 py-0.5 italic">Empty</div>
                                    )}
                                  </div>
                                )}

                                {/* System */}
                                <div
                                  className="mql-row-h mql-tree-row"
                                  onClick={() => toggleVirtualFolder(`${dbKey}/system`)}
                                >
                                  <ChevronRight
                                    size={10}
                                    className={`transition-transform duration-150 ${isSystemExpanded ? 'rotate-90' : ''}`}
                                    style={{ color: 'var(--text-dim)', flexShrink: 0 }}
                                  />
                                  <Cog size={11} className="text-[var(--accent-amber)] flex-shrink-0" />
                                  <span className="mql-folder-label">System</span>
                                  <span className="mql-count" data-testid="system-count">
                                    ({systemColls.length})
                                  </span>
                                </div>
                                {isSystemExpanded && (
                                  <div className="mql-tree-children">
                                    {systemColls.map((collName) => renderCollectionNode(conn.id, dbName, collName))}
                                    {systemColls.length === 0 && (
                                      <div className="text-[10px] text-[var(--text-dim)] pl-6 py-0.5 italic">Empty</div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {connDbs.length === 0 && (
                        <div className="text-[10px] text-[var(--text-dim)] pl-6 py-0.5 italic">Empty</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-[var(--text-dim)] text-center p-4 gap-3">
            <span style={{ fontSize: 11 }}>Connect to MongoDB server to browse database tree structures.</span>
            <button
              onClick={onOpenConnectionManager}
              className="mql-btn mql-btn-primary"
              aria-label="Connect to Database"
            >
              <Plus size={11} className="mr-1.5" />
              Connect to Database...
            </button>
          </div>
        )}
      </div>

      {/* Floating Resilient Context Menu */}
      {contextMenu && (
        <SidebarContextMenu 
          x={contextMenu.x} 
          y={contextMenu.y} 
          onClose={() => setContextMenu(null)}
        >
          {contextMenu.indexName ? (
            /* Index Context Options */
            <>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  navigator.clipboard?.writeText(contextMenu.indexName!);
                  setContextMenu(null);
                }}
              >
                <Plus size={12} />
                <span>Copy Index Name</span>
              </div>
              <div className="mql-ctx-sep" />
              <div 
                className="mql-ctx-item mql-ctx-item-danger"
                style={{ color: 'var(--accent-red)' }}
                onClick={() => {
                  if (onDeleteIndex) {
                    onDeleteIndex(contextMenu.connectionId!, contextMenu.dbName!, contextMenu.collName!, contextMenu.indexName!);
                  }
                  setContextMenu(null);
                }}
              >
                <Trash2 size={12} />
                <span>Delete Index</span>
              </div>
            </>
          ) : contextMenu.isIndexesFolder ? (
            /* Indexes Folder Context Options */
            <>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  if (onCreateIndex) {
                    onCreateIndex(contextMenu.connectionId!, contextMenu.dbName!, contextMenu.collName!);
                  }
                  setContextMenu(null);
                }}
              >
                <Plus size={12} />
                <span>Create Index</span>
              </div>
            </>
          ) : contextMenu.collName ? (
            /* Collection Context Options */
            <>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  onSelectCollection(contextMenu.connectionId!, contextMenu.dbName!, contextMenu.collName!);
                  setContextMenu(null);
                }}
              >
                <FolderOpen size={12} />
                <span>Open Collection</span>
              </div>
              <div
                className="mql-ctx-item"
                onClick={() => {
                  onOpenShell?.(
                    contextMenu.connectionId!,
                    contextMenu.dbName!,
                    contextMenu.collName!,
                    `db.${contextMenu.collName!}.find({}).limit(50)`
                  );
                  setContextMenu(null);
                }}
              >
                <Terminal size={12} />
                <span>Open mongosh Shell</span>
              </div>
              <div
                className="mql-ctx-item"
                onClick={() => {
                  onAnalyzeSchema?.(contextMenu.connectionId!, contextMenu.dbName!, contextMenu.collName!);
                  setContextMenu(null);
                }}
              >
                <Table2 size={12} />
                <span>Analyze Schema</span>
              </div>
              <div
                className="mql-ctx-item"
                onClick={() => {
                  navigator.clipboard?.writeText(contextMenu.collName!);
                  setContextMenu(null);
                }}
              >
                <FolderOpen size={12} />
                <span>Copy Collection Name</span>
              </div>
              <div
                className="mql-ctx-item"
                onClick={() => {
                  handleRenameCollection(contextMenu.connectionId!, contextMenu.dbName!, contextMenu.collName!);
                  setContextMenu(null);
                }}
              >
                <Pencil size={12} />
                <span>Rename Collection</span>
              </div>
              <div className="mql-ctx-sep" />
              <div 
                className="mql-ctx-item mql-ctx-item-danger"
                style={{ color: 'var(--accent-red)' }}
                onClick={() => {
                  handleDropCollection(contextMenu.connectionId!, contextMenu.dbName!, contextMenu.collName!);
                  setContextMenu(null);
                }}
              >
                <Trash2 size={12} />
                <span>
                  {(collections[`${contextMenu.connectionId}/${contextMenu.dbName}`] || [])
                    .find((c) => c.name === contextMenu.collName)?.type === 'view'
                    ? 'Drop View'
                    : 'Drop Collection'}
                </span>
              </div>
            </>
          ) : contextMenu.isConnectionNode ? (
            /* Connection Node Context Options */
            <>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  handleAddDatabase(contextMenu.connectionId!);
                  setContextMenu(null);
                }}
              >
                <Plus size={12} />
                <span>Add Database</span>
              </div>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  onOpenConnectionManager();
                  setContextMenu(null);
                }}
              >
                <Server size={12} />
                <span>Manage Connections</span>
              </div>
              <div
                className="mql-ctx-item"
                data-testid="ctx-monitor"
                onClick={() => {
                  onOpenMonitoring?.(contextMenu.connectionId!);
                  setContextMenu(null);
                }}
              >
                <Activity size={12} />
                <span>Monitor cluster</span>
              </div>
              <div
                className="mql-ctx-item"
                data-testid="ctx-users"
                onClick={() => {
                  onOpenUsers?.(contextMenu.connectionId!);
                  setContextMenu(null);
                }}
              >
                <Users size={12} />
                <span>Manage users</span>
              </div>
              <div className="mql-ctx-sep" />
              <div 
                className="mql-ctx-item mql-ctx-item-danger"
                style={{ color: 'var(--accent-red)' }}
                onClick={() => {
                  onDisconnect(contextMenu.connectionId!);
                  setContextMenu(null);
                }}
              >
                <LogOut size={12} />
                <span>Disconnect</span>
              </div>
            </>
          ) : contextMenu.isEmptySpace ? (
            /* Empty Space Context Options */
            <>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  onOpenConnectionManager();
                  setContextMenu(null);
                }}
              >
                <Plus size={12} />
                <span>New Connection</span>
              </div>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  onOpenSettings();
                  setContextMenu(null);
                }}
              >
                <Settings size={12} />
                <span>Settings</span>
              </div>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  onToggleTheme();
                  setContextMenu(null);
                }}
              >
                {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
                <span>Toggle Theme</span>
              </div>
            </>
          ) : (
            /* Database Context Options */
            <>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  handleAddCollection(contextMenu.connectionId!, contextMenu.dbName!);
                  setContextMenu(null);
                }}
              >
                <Plus size={12} />
                <span>Add Collection</span>
              </div>
              <div
                className="mql-ctx-item"
                onClick={() => {
                  onCreateView?.(contextMenu.connectionId!, contextMenu.dbName!);
                  setContextMenu(null);
                }}
              >
                <Eye size={12} />
                <span>Create View</span>
              </div>
              <div
                className="mql-ctx-item"
                onClick={() => {
                  onOpenShell?.(contextMenu.connectionId!, contextMenu.dbName!, undefined, 'show collections');
                  setContextMenu(null);
                }}
              >
                <Terminal size={12} />
                <span>Open mongosh Shell</span>
              </div>
              <div 
                className="mql-ctx-item"
                onClick={() => {
                  handleRefreshDb(contextMenu.connectionId!, contextMenu.dbName!);
                  setContextMenu(null);
                }}
              >
                <RefreshCw size={12} />
                <span>Refresh Database</span>
              </div>
              <div
                className="mql-ctx-item"
                onClick={() => {
                  handleRenameDatabase(contextMenu.connectionId!, contextMenu.dbName!);
                  setContextMenu(null);
                }}
              >
                <Pencil size={12} />
                <span>Rename Database</span>
              </div>
              <div className="mql-ctx-sep" />
              <div
                className="mql-ctx-item mql-ctx-item-danger"
                style={{ color: 'var(--accent-red)' }}
                onClick={() => {
                  handleDropDatabase(contextMenu.connectionId!, contextMenu.dbName!);
                  setContextMenu(null);
                }}
              >
                <Trash2 size={12} />
                <span>Drop Database</span>
              </div>
            </>
          )}
        </SidebarContextMenu>
      )}
    </aside>
  );
};
