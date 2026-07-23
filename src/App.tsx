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
import { workspaceReducer, createInitialLayout, findPane, paneOfTab, allPanes, allTabIds, mapLayoutTabIds, type WorkspaceAction, type WorkspaceLayout } from './workspace/model';
import { WorkspaceRoot } from './workspace/WorkspaceRoot';
import {
  workspaceApply,
  updateTabState,
  actionToOp,
  workspaceGet,
  windowLabel,
  subscribeWorkspaceChanged,
  subscribeConnectionsChanged,
  setConnectionMeta,
  connectionList,
  detachTabToNewWindow,
  closeWorkspaceWindow,
  moveTabToWindow,
  type WorkspaceChangedPayload,
  type ConnectionsChangedPayload,
  type ConnectionEntry,
} from './workspace/workspaceStore';
import {
  toPersistedTab,
  toDisconnectedSnapshot,
  rebindConnection,
  toProfileSpaceId,
  toLiveSpaceId,
  materializeArrivingTab,
  type PersistedWorkspace,
  type PersistedWindow,
  type PersistedTab,
} from './workspace/persistence';
import { ReconnectBanner } from './workspace/ReconnectBanner';
import { collectionTabsMatching } from './workspace/collectionTabs';
import { uniqueCollectionTabId } from './workspace/tabId';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { CreateViewView } from './components/CreateViewView';
import { ValidationRulesView } from './components/ValidationRulesView';
import { GenerateView } from './components/GenerateView';
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
import { confirmByTypedName } from './lib/typedNameConfirm';
import { detectAggregateWriteStage } from './lib/aggregateWriteStage';
import type { ConnectionProfile } from './lib/connection';
import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FolderCode, KeyRound, Play, Settings, Terminal, Rocket, Download, Upload, Table2, Eye, HardDrive, Activity, Copy, Users, ListChecks, DatabaseBackup, DatabaseZap, ShieldCheck, ExternalLink, MoveRight, Wand2, Lock, ShieldAlert } from 'lucide-react';
import logoMark from './assets/logo-mark.svg';

interface QueryTab {
  id: string;
  type: 'collection' | 'index' | 'shell' | 'settings' | 'quickstart' | 'export' | 'import' | 'tasks' | 'schema' | 'create-view' | 'gridfs' | 'monitoring' | 'users' | 'dump' | 'restore' | 'validation' | 'generate';
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
  /** True iff opened by the embedded MCP server's `connect` tool rather than a human (#98 Task 4). */
  viaMcp?: boolean;
  /**
   * Read-only / confirm-destructive production safeguard (#188), captured
   * at connect time. Type-only for now — populating this from
   * `connections-changed`/`connection_list` and rendering the banner off it
   * is Task 5; this field just needs to exist so that wiring compiles
   * against a stable shape.
   */
  mode?: 'normal' | 'read_only' | 'confirm_destructive';
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
    case 'generate':
      return <Wand2 size={size} className={className} />;
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
    case 'generate':
      return `Generate: ${tab.collection || tab.db}`;
    default:
      return tab.collection;
  }
};

/**
 * Tab types that operate on a live connection — everything except
 * `settings`/`quickstart`/`tasks`, which render regardless of (or without)
 * any particular connection. `renderTabContent`'s mode banner (#188 Task 5)
 * only mounts for these, matching the plan's "skip settings/quickstart/tasks"
 * instruction.
 */
const CONNECTION_TAB_TYPES = new Set<QueryTab['type']>([
  'collection',
  'index',
  'shell',
  'export',
  'import',
  'schema',
  'create-view',
  'gridfs',
  'monitoring',
  'users',
  'dump',
  'restore',
  'validation',
  'generate',
]);

/**
 * A short human hint for a FOREIGN window's tab-context-menu entry (Phase 3
 * Task 5's "Move to Window" list) — the collection/kind of that window's
 * currently active tab, resolved from the same `PersistedWorkspace` snapshot
 * `lastWorkspaceRef` already carries (no extra IPC round trip). `null` when
 * unresolvable (window has no focused pane's active tab, or that tab id
 * isn't in the flat `tabs[]` list — e.g. a not-yet-mirrored write race);
 * callers fall back to the bare window id in that case.
 */
function activeTabHintFor(win: PersistedWindow, allTabs: PersistedTab[]): string | null {
  const pane = findPane(win.splitTree, win.focusedPaneId);
  const activeId = pane?.activeTabId;
  if (!activeId) return null;
  const tab = allTabs.find((t) => t.id === activeId);
  if (!tab) return null;
  if (tab.type === 'quickstart') return 'Quick Start';
  return tab.collection || tab.type;
}

function Workspace() {
  const { toast, confirm, prompt } = useDialogs();
  const { config, resolvedMode, setMode, setSpacingDensity, resetZoom } = useTheme();
  const density = config.spacingDensity;
  // Phase 3 Task 4: every window runs this same component — `isMainWindow`
  // gates the behaviors that only make sense for the primary window
  // (quickstart resurrection, restore-driven secondary-window spawning).
  // `windowLabel()` is memoized process-wide (see workspaceStore.ts), so
  // this is stable for the component's whole lifetime.
  const isMainWindow = windowLabel() === 'main';
  // Open the Quick Start tab by default so the app never starts on a blank canvas.
  const [tabs, setTabs] = useState<QueryTab[]>([createQuickStartTab()]);
  // Foreign-event reconciliation (below) runs inside a `listen` callback
  // captured once at mount — it can never see a fresh `tabs` STATE value
  // from that closure, same staleness problem `activeConnectionsRef` exists
  // to solve for `handleBuilderStateChange`. Mirrors `tabs` on every change.
  const tabsRef = useRef<QueryTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const [layout, dispatchLayout] = useReducer(
    workspaceReducer,
    undefined,
    () => createInitialLayout([QUICK_START_TAB_ID], QUICK_START_TAB_ID),
  );
  // `dispatchWorkspace` (below) needs to know, synchronously, whether an
  // action it's about to mirror to the backend is one the frontend reducer
  // itself no-opped on — but `layout` above is a render-scope closure value,
  // stale for every dispatch after the first in a single synchronous handler
  // (multiple `dispatchWorkspace` calls in one tick, e.g. a rename storm,
  // all fire before React re-renders and refreshes `layout`). `layoutRef`
  // mirrors `layout` on every render (assignment during render, not an
  // effect — the correct value once React settles) AND is advanced
  // optimistically inside `dispatchWorkspace` itself right after each
  // dispatch, so a second dispatch in the same tick compares against the
  // first dispatch's result, not the stale pre-tick value. #97 phase 2 final
  // review Fix 3.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const focusedPane = findPane(layout.root, layout.focusedPaneId);
  const activeTabId = focusedPane?.activeTabId ?? null;
  if (import.meta.env.DEV) {
    const known = new Set(tabs.map(t => t.id));
    const layoutIds = allTabIds(layout);
    for (const id of layoutIds) {
      if (!known.has(id)) console.error(`workspace layout references unknown tab: ${id}`);
    }
    const inLayout = new Set(layoutIds);
    const orphans = tabs.map(t => t.id).filter(id => !inLayout.has(id));
    if (orphans.length > 0) {
      console.error(`tabs[] contains ids missing from workspace layout: ${orphans.join(', ')}`);
    }
  }
  const tabBuilderStateCache = useRef(new Map<string, BuilderState>());
  // Workspace-store mirroring plumbing (Phase 2 Task 5). Mirroring starts
  // DISABLED — the restore effect below is the only thing allowed to turn it
  // on, once workspace_get has resolved (snapshot applied or none found).
  // Starting it true would let the initial-render quickstart state (or
  // anything the user clicks before the restore settles) mirror to the
  // backend store as "new" ops, potentially clobbering a legitimate snapshot
  // a previous session already wrote before this GET resolves.
  const mirroringEnabledRef = useRef(false);
  // Tab ids whose open_tab was never mirrored (toPersistedTab returned null
  // — export/import tabs) or that were themselves rebound out of mirroring.
  // close_tab/close_many/move_tab/rename_tab consult this so they never
  // reference a tab id the backend has no record of.
  const unmirroredTabIdsRef = useRef(new Set<string>());
  // Guards `closeWorkspaceWindow()` (Phase 3 Task 5) against firing twice
  // for the same close: the remote-close reconciliation branch's own
  // `setTabs([])` flips `tabs.length` to 0, which would otherwise
  // independently re-trigger the tabs-empty effect's `closeWorkspaceWindow()`
  // call too. The backend command is idempotent either way (a second
  // `WindowClosed` apply for an already-removed window no-ops), but there is
  // no reason to fire the IPC call twice for one logical close.
  const windowClosingRef = useRef(false);
  // The most recent full backend `Workspace` document (Phase 3 Task 4) —
  // seeded from `workspace_get` at boot, kept current by every accepted
  // `workspace-changed` event thereafter (self-origin or not; see the
  // reconciliation effect below). Two consumers: the foreign-event
  // reconciliation itself, and `dispatchWorkspace`'s cross-window open
  // dedupe (a tab already open in ANOTHER window's tree must not be opened
  // here too — see its own comment). `lastSeenRevisionRef` guards against
  // applying an out-of-order/replayed event (revision <= what's already
  // been applied is dropped).
  const lastWorkspaceRef = useRef<PersistedWorkspace | null>(null);
  const lastSeenRevisionRef = useRef(-1);
  const [activeConnections, setActiveConnections] = useState<ActiveConnection[]>([]);
  // `handleBuilderStateChange` below is a `useCallback` with an empty deps
  // array (a stable identity for DocumentViewer), so it can never see a
  // fresh `activeConnections` STATE value from its closure — it would stay
  // pinned at mount's `[]` forever. A ref mirrors the state on every change
  // so the callback can read the current connections via `.current` instead.
  const activeConnectionsRef = useRef<ActiveConnection[]>(activeConnections);
  useEffect(() => {
    activeConnectionsRef.current = activeConnections;
  }, [activeConnections]);
  // Every CONNECTION id this window has ever learned about from a
  // `connections-changed` broadcast OR the boot-time `connection_list` seed
  // (final whole-branch review, Fix 3; keyed by connection id, not
  // profileId, per the closing review's residual fix) — NOT from this
  // window's own local connects, which never touch it. Gates the removal
  // branch of the `connections-changed` listener below: a LOCAL connection
  // absent from a broadcast is only ever torn down if its own id was
  // previously SEEN live in some earlier broadcast. Without this, a
  // connection THIS window just opened itself (added to `activeConnections`
  // synchronously, but whose `set_connection_meta` hasn't landed
  // backend-side yet) looks identical to a genuinely-removed one the moment
  // an unrelated broadcast arrives — e.g. some other window
  // connecting/disconnecting something else — and would otherwise have its
  // tabs killed by a broadcast that has nothing to do with it.
  //
  // Keyed by connection id rather than profileId (closing review): a
  // profileId-keyed gate has a race once two rows can exist for the same
  // profile (final fix wave, agent-connection visibility) — a window opens
  // `connect_db` for profile P (local row added optimistically, id not yet
  // announced backend-side) and, before its own `set_connection_meta`
  // lands, a broadcast arrives carrying a DIFFERENT row for P (an agent
  // `connect`, or a second window). A profileId-keyed gate would mark P
  // "seen" off that unrelated row, and the removal loop below — seeing the
  // local id absent from that same broadcast — would tear down the user's
  // just-opened, still-live connection and close its tabs. Keying by
  // connection id means that broadcast never marks the local (still
  // unannounced) id as seen, so it falls through to the self-heal branch
  // (re-announce via `setConnectionMeta`) instead.
  const seenConnectionIdsRef = useRef<Set<string>>(new Set());
  // Shared by every `update_tab_state` emission site (handleBuilderStateChange
  // here, plus handleExecuteQuery/handleExecuteAggregate below): skips
  // unmirrored tabs and translates the live id to profile-space before
  // handing off to `updateTabState`, exactly like `dispatchWorkspace`'s
  // `actionToOp(..., activeConnections)` calls do for layout ops — see
  // persistence.ts's "Global Constraint" note. `connections` is threaded in
  // by each call site rather than closed over here so the memoized
  // `handleBuilderStateChange` below can supply the always-fresh
  // `activeConnectionsRef.current` instead of a potentially-stale closure.
  const mirrorUpdateTabState = (
    tabId: string,
    connections: ActiveConnection[],
    patch: Parameters<typeof updateTabState>[1]
  ) => {
    // Mirroring gate (#97 phase 2 final review Fix 5): airtight against the
    // same restore-race `dispatchWorkspace` guards against below — before
    // the session-restore effect flips `mirroringEnabledRef` on, an
    // `update_tab_state` mirror (builder-state edits, query/aggregate
    // refreshes) must be dropped too, not just layout ops.
    if (!mirroringEnabledRef.current) return;
    if (unmirroredTabIdsRef.current.has(tabId)) return;
    updateTabState(toProfileSpaceId(tabId, connections), patch);
  };
  const handleBuilderStateChange = useCallback((tabId: string, state: BuilderState) => {
    tabBuilderStateCache.current.set(tabId, state);
    mirrorUpdateTabState(tabId, activeConnectionsRef.current, { builderState: state });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [profilesRefreshKey, setProfilesRefreshKey] = useState(0);
  const [isConnectionModalOpen, setIsConnectionModalOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTabId | undefined>();

  // (final fix wave, agent-connection visibility) `viaMcp` entries dedupe by
  // CONNECTION id only, never by `profileId`: an MCP agent's `connect` to a
  // profile that already has a live human connection must still get its own
  // sidebar row (badged "via MCP") rather than being silently dropped —
  // previously the profileId dedupe below meant a second connection to an
  // already-connected profile was a live backend connection NO window ever
  // displayed, since it never made it into `activeConnections` at all. A
  // non-MCP entry keeps the original profileId dedupe (a human never opens
  // two simultaneous connections to the same profile from one path).
  // `mode` (#188 Task 3): the connection's read-only/confirm-destructive
  // safeguard, captured at connect time. `ActiveConnection.mode` was
  // type-only until now — this is the minimal threading needed so the
  // destructive-op call sites below (`handleDeleteMany`/`handleUpdateMany`)
  // can read a real value via `activeConnections.find(...).mode` instead of
  // always seeing `undefined`. Full UI consumption (persistent banner,
  // sidebar badge) is Task 5.
  const addActiveConnection = (
    id: string,
    name: string,
    uri: string,
    profileId: string,
    color_tag?: string,
    viaMcp?: boolean,
    mode?: ActiveConnection['mode']
  ) => {
    setActiveConnections((prev) => {
      if (prev.some((c) => c.id === id)) return prev;
      if (!viaMcp && prev.some((c) => c.profileId === profileId)) return prev;
      return [...prev, { id, profileId, name, uri, color_tag, viaMcp, mode }];
    });
  };

  // Shared by every path that can hand a profile its first live connection
  // id in a session — `handleReconnectProfile`, `handleQuickConnect`, and the
  // ConnectionManager `onConnect` handler (#97 phase 2 final review Fix 1 /
  // Fix 2). Any restored-but-disconnected tab for `profileId` still carries
  // a `profile:<profileId>` id/connectionId (see persistence.ts's Global
  // Constraint note) and renders a ReconnectBanner (App.tsx's
  // `renderTabContent` keys the banner purely off that prefix) until it's
  // rebound onto `liveId`. Calling this from all three connect paths — not
  // just the banner's own onReconnect — means a normal quick-connect/
  // ConnectionManager connect clears those banners immediately instead of
  // leaving them stale until clicked; a stale banner click would otherwise
  // call `connect_db` a SECOND time for a profile that's already connected
  // (`addActiveConnection` dedupes by profileId, so that second id would
  // never land in `activeConnections` — every tab rebound to it becomes
  // unreachable, and every later mirror for those tabs ships a live id the
  // backend can't translate back to profile-space).
  //
  // Reads `layoutRef.current`, not the `layout` render-scope closure
  // (Phase 3 Task 4): the `connections-changed` reconciliation effect below
  // calls this from a `listen` callback captured once at mount, where
  // `layout` would be frozen at its mount-time value forever. `layoutRef`
  // is the same mutable ref object across every render, so reading
  // `.current` always sees whatever the component most recently committed,
  // regardless of which render's closure is doing the reading — identical
  // behavior to before for every existing (render-fresh) call site.
  const rebindProfileTabs = (
    profileId: string,
    liveId: string
  ): { pairs: Array<{ oldId: string; newId: string }>; idMap: Map<string, string> } => {
    const oldPrefix = `profile:${profileId}`;
    const pairs = rebindConnection(oldPrefix, liveId, allTabIds(layoutRef.current));
    if (pairs.length === 0) return { pairs, idMap: new Map() };

    const idMap = new Map(pairs.map((p) => [p.oldId, p.newId]));
    setTabs((prev) =>
      prev.map((t) => {
        const renamedId = idMap.get(t.id);
        return renamedId ? { ...t, id: renamedId, connectionId: liveId } : t;
      })
    );

    // Re-key any cached builder state (Fix 2): the session-restore effect
    // seeds `tabBuilderStateCache` under profile-space tab ids. Without
    // re-keying here, a rebind silently drops as-typed query-builder state
    // for the rebound tab — a cache MISS under the new id, and a leaked
    // entry under the now-dead old one — in the only flow that could ever
    // surface it (a restored tab that still has unsaved builder state).
    for (const { oldId, newId } of pairs) {
      const bs = tabBuilderStateCache.current.get(oldId);
      if (bs) {
        tabBuilderStateCache.current.set(newId, bs);
        tabBuilderStateCache.current.delete(oldId);
      }
    }

    // Dispatched straight to the layout reducer via `dispatchLayout`,
    // bypassing `dispatchWorkspace`'s mirror entirely — not a "skip mirror"
    // option, a raw dispatch. The backend store must stay in
    // `profile:<id>` id space (persistence.ts's Global Constraint note):
    // that's what the NEXT restart needs to restore from. Mirroring these
    // renames would leave the backend holding this session's live
    // connection id, which is worthless the moment the app closes.
    pairs.forEach(({ oldId, newId }) => dispatchLayout({ type: 'rename_tab', oldId, newId }));

    return { pairs, idMap };
  };

  // Shared "a live connection this window doesn't have locally yet" path
  // (final whole-branch review, Fix 2) — the connections-changed listener's
  // addition loop below AND the boot-time `connection_list` seed both funnel
  // through here, so a spawned window's very first paint and every later
  // broadcast add/rebind identically: `addActiveConnection` (dedupes by
  // profileId) plus `rebindProfileTabs` (rebinds any restored `profile:<id>`
  // tab onto the live id, same as `handleQuickConnect`/`handleReconnectProfile`
  // do after their own `connect_db`). Also updates `seenConnectionIdsRef`
  // (Fix 3; connection-id-keyed per the closing review) for every entry's
  // own id, regardless of whether it was new — a boot seed or broadcast
  // that mentions a connection is evidence that SPECIFIC connection is
  // being actively tracked, whether or not this window happens to already
  // have it locally. Deliberately NOT `entry.profileId` — see
  // `seenConnectionIdsRef`'s own doc comment for the teardown race that
  // profileId-keying opened up.
  const applyConnectionsAdditions = (connections: ConnectionEntry[]) => {
    for (const entry of connections) seenConnectionIdsRef.current.add(entry.id);
    const localById = new Map(activeConnectionsRef.current.map((c) => [c.id, c]));
    const localByProfile = new Map(activeConnectionsRef.current.map((c) => [c.profileId, c]));
    for (const entry of connections) {
      if (localById.has(entry.id)) continue; // already have exactly this connection row
      // A non-viaMcp entry still dedupes by profileId (unchanged): the
      // backend never hands out two ids for the same human-facing profile
      // connection. A viaMcp entry does NOT — see `addActiveConnection`'s
      // doc comment (final fix wave, agent-connection visibility) — so it
      // always reaches `addActiveConnection` below, which is itself the
      // authority on whether this exact row already exists.
      if (!entry.viaMcp && localByProfile.has(entry.profileId)) continue;
      addActiveConnection(entry.id, entry.name, '', entry.profileId, undefined, entry.viaMcp, entry.mode);
      rebindProfileTabs(entry.profileId, entry.id);
    }
  };

  // profileId -> profileName for every restored-but-not-yet-reconnected tab,
  // captured from the persisted snapshot at restore time. RestoredTab (what
  // toDisconnectedSnapshot hands back) deliberately drops profileName — it's
  // a structural subset of QueryTab, which has no such field — so this is the
  // only place ReconnectBanner's label can come from until the tab reconnects.
  const [restoredProfileNames, setRestoredProfileNames] = useState<Map<string, string>>(new Map());
  // Per-profile Reconnect busy/error state, keyed by profileId. Shared across
  // every ReconnectBanner instance for that profile (a profile's tabs can be
  // spread across multiple panes), so one click's busy/error state is visible
  // on all of them, and a second click while busy is a no-op (guarded below).
  const [reconnectState, setReconnectState] = useState<Map<string, { busy: boolean; error: string | null }>>(
    new Map()
  );
  // `reconnectState` is a render-captured snapshot — two ReconnectBanners for
  // the same profile (or a fast double-click on one) can both read `busy:
  // false` before either's `setReconnectState({busy:true})` has committed and
  // re-rendered, so the `reconnectState.get(profileId)?.busy` check alone
  // lets both calls through and fires `connect_db` twice (a leaked
  // connection). This ref is checked-and-set synchronously at the top of
  // `handleReconnectProfile`, before any `await`, so the second caller in the
  // same microtask/click burst sees it immediately — `reconnectState` stays
  // as the UI-facing (render-driven) busy/error source of truth.
  const reconnectBusyRef = useRef(new Set<string>());
  const patchReconnectState = (profileId: string, patch: Partial<{ busy: boolean; error: string | null }>) => {
    setReconnectState((prev) => {
      const next = new Map(prev);
      const cur = next.get(profileId) ?? { busy: false, error: null };
      next.set(profileId, { ...cur, ...patch });
      return next;
    });
  };

  // Session restore (Phase 2 Task 6). Runs once on mount: pulls whatever
  // workspace.json snapshot the backend has and, if it holds at least one
  // persisted tab, swaps the default Quick Start state for it — every
  // restored tab renders disconnected (ReconnectBanner) until its profile
  // reconnects. `restoredRef` guards against React 18 StrictMode's double-
  // invoke of effects in dev: the ref is set synchronously before the first
  // await, so a second invocation of this same effect (same component
  // instance, refs persist across it) returns immediately instead of firing
  // a second workspace_get / hydrate / mirroring-enable.
  //
  // Chosen behavior for a "slow disk" race (snapshot resolves AFTER the user
  // has already clicked around while mirroring was still suppressed): hydrate
  // wins and clobbers whatever the user did. workspace_get is a local file
  // read the backend caches after the first call, so the realistic window is
  // milliseconds at app boot, and merging "whatever the user did in that
  // window" with a persisted snapshot is a lot of complexity for an edge case
  // this narrow — losing a few clicks from before the very first paint has
  // settled is an acceptable trade for a wholesale, easy-to-reason-about
  // restore.
  // Phase 3 Task 4: every window boots from the SAME `workspace_get` call
  // but hydrates only ITS OWN slice — `toDisconnectedSnapshot(ws,
  // windowLabel())` selects the window entry matching this label (default
  // `"main"`) instead of always reading `windows[0]`, and filters
  // `ws.tabs` (a flat list shared across every window) down to the ids
  // this window's tree actually references.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    (async () => {
      try {
        const ws = await workspaceGet();
        // Guards against more than a bare `null`/absent snapshot — a
        // malformed or unexpectedly-shaped response (e.g. a test harness's
        // untyped default mock) must not seed `lastWorkspaceRef` with
        // something whose `.windows` isn't actually an array, which the
        // dedupe check and reconciliation effect both assume.
        const wsValid = !!ws && Array.isArray(ws.tabs) && Array.isArray(ws.windows);
        if (wsValid) {
          // Seed the cross-window view (dedupe's `lastWorkspaceRef`,
          // reconciliation's `lastSeenRevisionRef`) from the FULL document,
          // regardless of whether THIS window ends up with any tabs of its
          // own — both need to see every window, not just this one.
          lastWorkspaceRef.current = ws;
          lastSeenRevisionRef.current = typeof ws.revision === 'number' ? ws.revision : -1;
        }
        if (wsValid) {
          const snapshot = toDisconnectedSnapshot(ws, windowLabel());
          if (snapshot.tabs.length > 0) {
            setTabs(snapshot.tabs as QueryTab[]);
            // Clear first: `hydrate` wholesale-replaces `tabs` (see the
            // "hydrate wins" note above), but the builder-state cache is a
            // ref keyed by tab id — if the user opened a builder on any
            // pre-restore tab (e.g. the default Quick Start render) before
            // this settled, that stale entry would otherwise survive under an
            // id that may now belong to a completely different restored tab.
            tabBuilderStateCache.current.clear();
            for (const [tabId, state] of snapshot.builderStates) {
              tabBuilderStateCache.current.set(tabId, state as BuilderState);
            }
            const windowTabIds = new Set(snapshot.tabs.map((t) => t.id));
            const profileNames = new Map<string, string>();
            for (const t of ws.tabs) {
              if (windowTabIds.has(t.id) && t.profileId) profileNames.set(t.profileId, t.profileName || t.profileId);
            }
            setRestoredProfileNames(profileNames);
            // `hydrate` is a frontend-only reducer action — there is no backend
            // op for "replace my whole layout". Dispatched via raw
            // `dispatchLayout`, bypassing `dispatchWorkspace`'s mirror-to-
            // backend choke point entirely, so this restore is never echoed
            // back to workspace_apply as a stream of synthetic ops (mirroring
            // is still disabled here regardless — see mirroringEnabledRef's
            // init above — but the direct dispatch documents the exception
            // even once mirroring flips on below).
            dispatchLayout({ type: 'hydrate', layout: snapshot.layout });
            // `dispatchLayout` (React's reducer dispatch) doesn't commit
            // synchronously — `layoutRef.current` (line ~350) only catches up
            // on the next render. The connection_list seed below (Fix 2) runs
            // later in this SAME tick and needs `rebindProfileTabs` (which
            // reads `layoutRef.current`, not React state) to already see this
            // hydrated layout's restored tab ids, so advance the ref by hand
            // here — same technique `dispatchWorkspace`'s own `nextLayout`
            // optimistic-advance uses below, for the same reason.
            layoutRef.current = snapshot.layout;
          } else if (!isMainWindow) {
            // No tabs for THIS window and it's a secondary one: the
            // component's initializers default to a Quick Start tab
            // regardless of window kind (shared across `Workspace()`
            // instances), which would otherwise sit there forever — a
            // secondary window never resurrects Quick Start, so nothing
            // would ever make `tabs.length` actually hit 0 to trigger the
            // tabs-empty effect's `window_closed` dispatch below. Clear it
            // explicitly so that effect fires.
            setTabs([]);
            dispatchLayout({ type: 'hydrate', layout: createInitialLayout([], null) });
          }
          // Main window with nothing of its own: the default Quick Start
          // state from this component's initializers stands as-is.
        }
      } catch {
        // workspace_get failing (corrupt file, IO error) is not fatal —
        // fall back to the default Quick Start state exactly as if there
        // were no snapshot at all.
      } finally {
        // Final whole-branch review, Fix 2: seed every connection already
        // live in this session BEFORE mirroring flips on below, same
        // "restore settles first" ordering as the hydrate above. Every
        // window does this (not just spawned secondaries) — main boots
        // first in the common case and simply seeds nothing, but a window
        // spawned later (or re-launched into an already-running session)
        // needs this to avoid a spurious ReconnectBanner + duplicate
        // connect_db for a profile another window already connected.
        // `applyConnectionsAdditions` (Fix 3) also seeds `seenConnectionIdsRef`
        // for every entry's own id here, exactly like a `connections-changed`
        // broadcast would.
        try {
          const connections = await connectionList();
          if (Array.isArray(connections) && connections.length > 0) {
            applyConnectionsAdditions(connections);
          }
        } catch {
          // connection_list failing at boot is not fatal — this window
          // just starts with nothing pre-seeded, same as before this fix;
          // the next connections-changed broadcast still catches it up.
        }
        mirroringEnabledRef.current = true;
        if (isMainWindow) {
          // Recreates a real OS window per `windows[1..]` the snapshot above
          // just proved exist (main-window-only — a secondary window has no
          // business recreating siblings). Fire-and-forget: this window has
          // nothing further to do once the spawn requests are sent, and a
          // failure here (e.g. a window that can't be created) is not fatal
          // to this window's own boot.
          invoke('spawn_saved_windows').catch(console.warn);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleQuickConnect = async (profile: ConnectionProfile): Promise<string | null> => {
    const existing = activeConnections.find(
      (c) => c.profileId === profile.id || c.name === profile.name,
    );
    if (existing) return existing.id;
    try {
      const id = await invoke<string>('connect_db', { uri: profile.uri, ssh: profile.ssh ?? null });
      addActiveConnection(id, profile.name, profile.uri, profile.id, profile.color_tag ?? undefined, undefined, profile.connection_mode ?? 'normal');
      // Announce this fresh id to every other window (Phase 3 Task 6) — see
      // `setConnectionMeta`'s doc comment for why every connect path calls it.
      setConnectionMeta(id, profile.id, profile.name, profile.connection_mode ?? 'normal');
      // Clear any ReconnectBanner this profile still has showing (#97 phase
      // 2 final review Fix 1) — see `rebindProfileTabs`'s doc comment.
      rebindProfileTabs(profile.id, id);
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
  // #91: the generate task id running for a given `generate` tab, so the
  // rendered GenerateView instance can find its own `task` in `exportTasks`
  // (TaskInfo carries no tab/connection/db/collection fields to match on —
  // same reasoning as pendingImportRefreshRef above). Entries are evicted
  // ONLY on tab close — `close_tab` AND `close_many`, both in
  // `dispatchWorkspace` below — not on task completion. A completion-
  // triggered eviction was tried and reverted: the SAME watcher effect that
  // would evict it also calls `refreshTabResults` for the matching
  // collection tab (both keyed off the same completed task id, since
  // `handleRunGenerate` sets both refs together), and that refresh's state
  // update re-renders this tab reading the just-cleared ref BEFORE the user
  // ever sees the "Inserted N documents" message — the completed banner
  // silently never appears, regressing "Completed/failed states render
  // their message." Evicting only on close avoids that: a still-open tab
  // keeps showing its finished task's status (as it must). Close-based
  // eviction covers every REACHABLE staleness path for this ref
  // (`close_tab` for a single tab; `close_many` for
  // `handleDatabaseDropped`'s drop-and-later-recreate-the-same-db case,
  // which reuses the connection's connectionId and so can reuse this ref's
  // deterministic tab id too) — see `close_many`'s branch below for why its
  // other two call sites need no such fix.
  const generateTaskIdsRef = React.useRef(new Map<string, string>());
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

  // Never sit on a blank canvas — if every tab is closed, bring back Quick
  // Start. Main-window-only (Phase 3 Task 4): a secondary window has no
  // quickstart concept — the spec says an emptied secondary window closes
  // itself instead. `closeWorkspaceWindow()` (Phase 3 Task 5) applies
  // `WindowClosed` for THIS window's own label itself (broadcasting
  // `workspace-changed` so every other window sees it's gone) and then
  // destroys the real OS window — no separate `workspaceApply` call needed
  // here, and there is nothing else useful to render once it fires.
  useEffect(() => {
    if (tabs.length !== 0) return;
    if (isMainWindow) {
      const qs = createQuickStartTab();
      setTabs([qs]);
      dispatchWorkspace({ type: 'open_tab', tabId: QUICK_START_TAB_ID }, { tab: qs });
      return;
    }
    if (windowClosingRef.current) return; // already closing via the remote-close path below
    windowClosingRef.current = true;
    closeWorkspaceWindow();
  }, [tabs.length, isMainWindow]);

  // The resolved query definition for a tab: either a saved query or the
  // collection's pinned default (see handleSelectCollection below).
  type QueryDef =
    | { queryType: 'aggregate'; pipeline: Record<string, unknown>[] }
    | { queryType: 'find'; filter?: unknown; sort?: unknown; projection?: unknown; limit?: number; skip?: number };

  // Runs `def` for `tabId` (aggregate or find), updates its results/loading
  // state, fetches the document count for find queries, and records history.
  // Assumes the tab already exists in `tabs` and its `open_tab` dispatch has
  // already happened — callers are responsible for both.
  const loadTabResults = async (
    tabId: string,
    connectionId: string,
    dbName: string,
    collName: string,
    def: QueryDef | null,
  ) => {
    try {
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
  };

  // savedQuery (palette "jump to saved query") runs instead of the pinned
  // default — for existing tabs it re-runs in place.
  const handleSelectCollection = async (
    connectionId: string,
    dbName: string,
    collName: string,
    savedQuery?: SavedQueryBody,
    opts?: { newTab?: boolean },
  ) => {
    if (!connectionId || !dbName || !collName) return;

    const baseId = `${connectionId}.${dbName}.${collName}`;
    const tabId = opts?.newTab
      ? uniqueCollectionTabId(baseId, tabs.map((t) => t.id))
      : baseId;
    const tabExists = !opts?.newTab && tabs.some(t => t.id === tabId);

    if (!tabExists || savedQuery) {
      let newTab: QueryTab | undefined;
      if (!tabExists) {
        newTab = {
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
        setTabs(prev => [...prev, newTab as QueryTab]);
      } else {
        setTabs(prev => prev.map(t => t.id === tabId ? { ...t, loading: true, error: null } : t));
      }
      dispatchWorkspace({ type: 'open_tab', tabId }, newTab ? { tab: newTab } : undefined);

      // A saved query (palette) wins; otherwise a pinned default query loads
      // instead of the plain {} find.
      let def: QueryDef | null = (savedQuery as QueryDef | undefined) ?? null;
      if (!def) {
        try {
          const cq = await loadCollectionQueries(connectionNameFor(connectionId), dbName, collName);
          def = (cq.default as QueryDef | null) ?? null;
        } catch {
          def = null;
        }
      }
      await loadTabResults(tabId, connectionId, dbName, collName, def);
    } else {
      dispatchWorkspace({ type: 'open_tab', tabId });
    }
  };

  const handleDuplicateTab = (sourceTabId: string) => {
    const src = tabs.find((t) => t.id === sourceTabId && t.type === 'collection');
    if (!src) return;

    const baseId = `${src.connectionId}.${src.db}.${src.collection}`;
    const tabId = uniqueCollectionTabId(baseId, tabs.map((t) => t.id));

    let def: QueryDef | null;
    try {
      def = src.lastAggregate
        ? { queryType: 'aggregate', pipeline: src.lastAggregate }
        : src.lastQuery
          ? {
              queryType: 'find',
              filter: JSON.parse(src.lastQuery.filter || '{}'),
              sort: JSON.parse(src.lastQuery.sort || '{}'),
              projection: JSON.parse(src.lastQuery.projection || '{}'),
              limit: src.lastQuery.limit,
              skip: src.lastQuery.skip,
            }
          : null;
    } catch {
      def = null; // corrupted persisted query — fall back to the default find
    }

    const newTab: QueryTab = {
      id: tabId,
      type: 'collection',
      connectionId: src.connectionId,
      db: src.db,
      collection: src.collection,
      results: [],
      loading: true,
      error: null,
      explainResult: null,
      lastQuery: src.lastQuery ?? DEFAULT_QUERY,
      lastAggregate: src.lastAggregate,
    };
    setTabs((prev) => [...prev, newTab]);
    dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
    void loadTabResults(tabId, src.connectionId, src.db, src.collection, def);
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
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
    } else {
      dispatchWorkspace({ type: 'open_tab', tabId });
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
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
      return;
    }
    if (initialCommand) {
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, initialShellCommand: initialCommand } : t));
    }
    dispatchWorkspace({ type: 'open_tab', tabId });
  };

  const openSettingsTab = (section: SettingsTabId = 'appearance') => {
    const tabId = 'settings';
    const tabExists = tabs.some(t => t.id === tabId);
    setSettingsInitialTab(section);
    if (!tabExists) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'settings',
        connectionId: '',
        db: '',
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
      return;
    }
    dispatchWorkspace({ type: 'open_tab', tabId });
  };

  const handleOpenSettingsTab = () => openSettingsTab('appearance');
  // Tool guidance cards ("mongodump was not found…") point the user at the
  // tool paths, so they land on the Tools section rather than Appearance.
  const handleOpenToolsSettings = () => openSettingsTab('tools');
  const handleOpenShortcutsReference = () => openSettingsTab('shortcuts');

  const handleOpenTasksTab = () => {
    if (!tabs.some(t => t.id === TASKS_TAB_ID)) {
      const tasksTab = createTasksTab();
      setTabs(prev => [...prev, tasksTab]);
      dispatchWorkspace({ type: 'open_tab', tabId: TASKS_TAB_ID }, { tab: tasksTab });
      return;
    }
    dispatchWorkspace({ type: 'open_tab', tabId: TASKS_TAB_ID });
  };

  const handleOpenExportTab = (sourceTab: QueryTab) => {
    if (sourceTab.type !== 'collection') return;
    const tabId = `export.${sourceTab.connectionId}.${sourceTab.db}.${sourceTab.collection}`;
    const tabExists = tabs.some(t => t.id === tabId);
    if (!tabExists) {
      const newTab: QueryTab = {
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
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
    } else {
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, exportSourceTabId: sourceTab.id } : t));
      dispatchWorkspace({ type: 'open_tab', tabId });
    }
    loadExportTasks();
  };

  const handleOpenImportTab = (sourceTab: QueryTab) => {
    if (sourceTab.type !== 'collection') return;
    const tabId = `import.${sourceTab.connectionId}.${sourceTab.db}.${sourceTab.collection}`;
    const tabExists = tabs.some(t => t.id === tabId);
    if (!tabExists) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'import',
        connectionId: sourceTab.connectionId,
        db: sourceTab.db,
        collection: sourceTab.collection,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
    } else {
      dispatchWorkspace({ type: 'open_tab', tabId });
    }
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
      const newTab: QueryTab = {
        id: tabId,
        type: 'dump',
        connectionId,
        db: db ?? '',
        collection: coll ?? '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
    } else {
      dispatchWorkspace({ type: 'open_tab', tabId });
    }
    void loadMongoTools();
    void loadDumpDbTree(connectionId);
  };

  // #91: open a Generate Data tab — schema-seeded when opened on a specific
  // collection, a starter template when opened on a database (Sidebar's
  // database-row entry; GenerateView lets the user type a target collection
  // in that case — Task 5).
  const handleOpenGenerateTab = (connectionId: string, db: string, collection?: string) => {
    const idParts = ['generate', connectionId, db, collection].filter((p): p is string => !!p);
    const tabId = idParts.join('.');
    if (!tabs.some(t => t.id === tabId)) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'generate',
        connectionId,
        db,
        collection: collection ?? '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
    } else {
      dispatchWorkspace({ type: 'open_tab', tabId });
    }
  };

  const handleOpenRestoreTab = (connectionId: string) => {
    const tabId = `restore.${connectionId}`;
    if (!tabs.some(t => t.id === tabId)) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'restore',
        connectionId,
        db: '',
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
    } else {
      dispatchWorkspace({ type: 'open_tab', tabId });
    }
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

  // #91: start a background generate run (mirrors handleRunDump). `collection`
  // is GenerateView's resolved target — for a collection-scoped tab this is
  // just `tab.collection` handed back; for a database-scoped tab (opened
  // with no collection) it's the name the user typed into GenerateView's own
  // "Target collection" field, since `tab.collection` is empty in that case.
  const handleRunGenerate = async (
    tab: QueryTab,
    template: string,
    count: number,
    seed: number | undefined,
    collection: string
  ) => {
    try {
      const task = await invoke<ExportTaskInfo>('start_generate_task', {
        id: tab.connectionId,
        database: tab.db,
        collection,
        template,
        count,
        seed: seed ?? null,
      });
      generateTaskIdsRef.current.set(tab.id, task.id);
      pendingImportRefreshRef.current.set(task.id, {
        connectionId: tab.connectionId,
        db: tab.db,
        collection,
      });
      insertExportTasks([task]);
      // Unlike `handleRunDump`/`handleRunRestore` (which have no in-tab
      // progress UI, so switching to the Tasks tab is the only way to see
      // anything happening), GenerateView renders its own inline
      // `TaskProgress` for this tab's task — stealing focus to the Tasks
      // tab here would yank the user away right as that inline progress
      // appears. "View in Tasks" on that inline progress panel already
      // covers discoverability, so this run intentionally does not call
      // `handleOpenTasksTab()`.
      await loadExportTasks();
    } catch (err: any) {
      toast(`Generate failed to start: ${err?.message || err}`, 'error');
    }
  };

  // M7: open a Create-View tab for a database.
  const handleOpenCreateViewTab = (connectionId: string, db: string) => {
    const tabId = `create-view.${connectionId}.${db}`;
    if (!tabs.some(t => t.id === tabId)) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'create-view',
        connectionId,
        db,
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
      return;
    }
    dispatchWorkspace({ type: 'open_tab', tabId });
  };

  // #93: open a Validation Rules tab for a collection.
  const handleOpenValidationTab = (connectionId: string, db: string, collection: string) => {
    const tabId = `validation.${connectionId}.${db}.${collection}`;
    if (!tabs.some(t => t.id === tabId)) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'validation',
        connectionId,
        db,
        collection,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
      return;
    }
    dispatchWorkspace({ type: 'open_tab', tabId });
  };

  // M7: open a GridFS browser tab for a bucket (bucket stored in `collection`).
  const handleOpenGridfsTab = (connectionId: string, db: string, bucket: string) => {
    const tabId = `gridfs.${connectionId}.${db}.${bucket}`;
    if (!tabs.some(t => t.id === tabId)) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'gridfs',
        connectionId,
        db,
        collection: bucket,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
      return;
    }
    dispatchWorkspace({ type: 'open_tab', tabId });
  };

  // M6: open a schema-analysis tab for a collection.
  const handleOpenSchemaTab = (connectionId: string, db: string, collection: string) => {
    const tabId = `schema.${connectionId}.${db}.${collection}`;
    const tabExists = tabs.some(t => t.id === tabId);
    if (!tabExists) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'schema',
        connectionId,
        db,
        collection,
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs(prev => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
      return;
    }
    dispatchWorkspace({ type: 'open_tab', tabId });
  };

  const handleOpenMonitoringTab = (connectionId: string) => {
    const tabId = `monitoring.${connectionId}`;
    if (!tabs.some((t) => t.id === tabId)) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'monitoring',
        connectionId,
        db: '',
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs((prev) => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
      return;
    }
    dispatchWorkspace({ type: 'open_tab', tabId });
  };

  const handleOpenUsersTab = (connectionId: string, db?: string) => {
    const tabId = `users.${connectionId}`;
    if (!tabs.some((t) => t.id === tabId)) {
      const newTab: QueryTab = {
        id: tabId,
        type: 'users',
        connectionId,
        db: db ?? '',
        collection: '',
        results: [],
        loading: false,
        error: null,
        explainResult: null,
      };
      setTabs((prev) => [...prev, newTab]);
      dispatchWorkspace({ type: 'open_tab', tabId }, { tab: newTab });
      return;
    }
    if (db) {
      // Re-opened scoped to a database (sidebar db menu): refocus the scope.
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, db } : t)));
    }
    dispatchWorkspace({ type: 'open_tab', tabId });
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
    renamedPairs.forEach(({ oldId, newId }) => dispatchWorkspace({ type: 'rename_tab', oldId, newId }));
    invalidatePaletteNamespaceIndex(connectionId);
  };

  const handleDatabaseDropped = (connectionId: string, dbName: string) => {
    invalidatePaletteNamespaceIndex(connectionId);
    const removed = tabs
      .filter(t => t.connectionId === connectionId && t.db === dbName)
      .map(t => t.id);
    setTabs(prev => prev.filter(t => t.connectionId !== connectionId || t.db !== dbName));
    dispatchWorkspace({ type: 'close_many', tabIds: removed });
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
    renamedPairs.forEach(({ oldId, newId }) => dispatchWorkspace({ type: 'rename_tab', oldId, newId }));
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
        closeTabById(oldTabId);
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
      closeTabById(tabId);

      // Trigger sidebar refresh
      setIndexMutationTrigger(prev => prev + 1);
    } catch (err: any) {
      toast(`Failed to delete index: ${err}`, 'error');
    }
  };

  const closeTabById = (tabId: string) => {
    dispatchWorkspace({ type: 'close_tab', tabId });
  };

  // Passed to WorkspaceRoot/PaneView as their `dispatch`, and the single
  // choke point every other workspace action flows through — the ONLY place
  // `dispatchLayout` is called. Two responsibilities beyond forwarding to the
  // layout reducer:
  //  1. `close_tab` also needs `tabs` state and the builder-state cache kept
  //     in sync (panes close their own tabs by dispatching `close_tab`
  //     directly — drag/drop and split ops only touch the layout reducer;
  //     `closeTabById` above is just a thin wrapper for other call sites).
  //  2. Every action is mirrored to the backend store via `workspaceApply`
  //     (fire-and-forget), unless mirroring is globally suppressed
  //     (`mirroringEnabledRef` — Task 6 flips this off until the
  //     restore-on-boot snapshot settles) OR the frontend reducer itself
  //     no-opped the action (#97 phase 2 final review Fix 3 — see the
  //     no-op check below; there is no longer an `options.mirror` escape
  //     hatch, nothing ever used one — hydrate/reconnect renames bypass
  //     this function entirely via a raw `dispatchLayout`, same as
  //     `open_tab`'s persisted-payload enrichment below). `open_tab` is
  //     enriched with the persisted tab payload when `options.tab` is
  //     supplied (i.e. this call just created a brand-new frontend tab);
  //     reopening/refocusing an already-open tab omits it — the backend
  //     already has that tab's model. `toPersistedTab` returning null
  //     (export/import) means this tab id must never exist in the backend
  //     store at all — its open_tab is dropped entirely (sending it without
  //     a tab payload would create a dangling backend layout entry) and the
  //     id is tracked in `unmirroredTabIdsRef` so its later close/move/
  //     rename mirrors are skipped consistently too. A move_tab of an
  //     unmirrored tab is also skipped entirely — it only relocates that
  //     one id, so skipping keeps the backend tree valid at the cost of
  //     losing that tab's pane placement on restore, which is acceptable
  //     since the tab itself was never going to be restored anyway.
  const dispatchWorkspace = (
    action: WorkspaceAction,
    options?: { tab?: QueryTab }
  ) => {
    // Cross-window open dedupe (Phase 3 Task 4 — MANDATE from Task 2
    // review): the backend's own OpenTab dedupe only applies WITHIN one
    // window's tree, so it would happily accept a tab id that's already
    // open in a DIFFERENT window — the next `workspace_get`/`validate()`
    // would then choke on the same tab id living in two trees at once.
    // `lastWorkspaceRef` (seeded at boot, kept current by every accepted
    // `workspace-changed` event) is the full cross-window view; compare in
    // PROFILE-space (the backend's own space) since a live id is only
    // meaningful within the window that minted/owns the connection.
    // Every `open_tab` caller in this file does its own optimistic
    // `setTabs`/local-state update BEFORE calling `dispatchWorkspace` (it
    // has no way to know about a foreign duplicate ahead of time) — the
    // filter below undoes that speculative insert so the tab never lingers
    // in `tabs[]` unreferenced by any pane. `focus_window` (Phase 3 Task 5)
    // brings that foreign window to the front; fire-and-forget, same as
    // `spawn_saved_windows` above — losing this race (the window closed in
    // the meantime) is a no-op on the backend side, never an error worth
    // surfacing.
    if (action.type === 'open_tab') {
      const profileSpaceId = toProfileSpaceId(action.tabId, activeConnections);
      const foreignWindow = lastWorkspaceRef.current?.windows.find(
        (w) =>
          w.id !== windowLabel() &&
          allTabIds({ root: w.splitTree, focusedPaneId: w.focusedPaneId }).includes(profileSpaceId)
      );
      if (foreignWindow) {
        setTabs((prev) => prev.filter((t) => t.id !== action.tabId));
        invoke('focus_window', { label: foreignWindow.id }).catch(console.warn);
        return;
      }
    }
    if (action.type === 'close_tab') {
      tabBuilderStateCache.current.delete(action.tabId);
      // #91: forget this tab's generate-task tracking on close (running or
      // finished) — otherwise reopening "Generate Data…" on the same
      // namespace reuses the same deterministic tab id and the fresh view
      // would immediately render the OLD task's progress bar. `close_many`
      // (below) gets the identical treatment for the multi-tab-close path.
      generateTaskIdsRef.current.delete(action.tabId);
      setTabs(prev => prev.filter(t => t.id !== action.tabId));
    }
    if (action.type === 'close_many') {
      // Same eviction as close_tab, just over `action.tabIds`. Of this
      // action's three call sites, only `handleDatabaseDropped` (dropping a
      // database) is exploitable for `generateTaskIdsRef`: it reuses the
      // connection's existing connectionId, so a later-recreated db.coll
      // can resolve the SAME deterministic `generate.<connId>.<db>.<coll>`
      // tab id a stale entry was keyed under. The other two `close_many`
      // sites tear down an entire connection instead (Sidebar's
      // `onDisconnect`, and the cross-window connection-removal listener —
      // which calls `dispatchLayout` directly and never reaches this
      // function at all): `connect_db` mints a fresh connectionId on every
      // connect, so any stale entries either of those leaves behind
      // permanently fall outside the tab-id space any future tab could
      // ever resolve — harmless, not reachable again. No fix needed there.
      action.tabIds.forEach((id) => generateTaskIdsRef.current.delete(id));
    }
    dispatchLayout(action);

    // Skip mirroring an action the frontend reducer itself no-opped on —
    // e.g. `split_pane` moving a pane's only tab (reachable via unmirrored
    // export/import tabs, which never get a backend-side pane to move out
    // of). The reducer is pure and returns the SAME layout object reference
    // for a no-op, so identity comparison is exact, no deep-equal needed.
    // React still sees the dispatch above (a harmless no-op there too) —
    // only the backend mirror is skipped: backend only sees ops the
    // frontend actually applied. `layoutRef.current` (not the `layout`
    // render-scope closure) because multiple `dispatchWorkspace` calls can
    // land in one synchronous handler (rename storms) — see layoutRef's
    // declaration above for why the closure value would be stale for the
    // second and later calls in that case.
    // This trial reducer call used to need a snapshot/restore bracket
    // (`snapshotLayoutIds`/`restoreLayoutIds`) around it: `workspaceReducer`
    // minted fresh pane/split ids via module-level counters, and this
    // trial's return value is discarded except for reference-identity
    // comparison — left unchecked, a real `split_pane` minted TWICE per
    // dispatch (once here, once more when React actually applies the action
    // during render), so the id React committed ended up one generation
    // ahead of what the mirrored op caused the backend to mint from its own,
    // separately-counted id space. Minting is now a stateless scan of the
    // layout being reduced (model.ts's `nextPaneId`/`nextSplitId`, #197) —
    // the same (layout, action) pair always mints the same id no matter how
    // many times it's evaluated, so this trial call and the later real
    // render-time application naturally mint identical ids with no
    // bracketing required. `nextLayout` below is a different object than
    // what React eventually commits, but its pane/split ids are identical,
    // so using it for the optimistic `layoutRef.current` advance (compared
    // against by later same-tick dispatches) stays accurate.
    const currentLayout = layoutRef.current;
    const nextLayout = workspaceReducer(currentLayout, action);
    layoutRef.current = nextLayout;
    const isNoOp = nextLayout === currentLayout;

    if (isNoOp || !mirroringEnabledRef.current) {
      if (action.type === 'close_tab') unmirroredTabIdsRef.current.delete(action.tabId);
      return;
    }

    // Every `actionToOp` call below passes `activeConnections` so live
    // connection-id fields translate to `profile:<profileId>` form before
    // reaching `workspace_apply` — see persistence.ts's "Global Constraint"
    // note. `unmirroredTabIdsRef` bookkeeping below always compares against
    // the RAW action id (pre-translation, i.e. the frontend's own id space),
    // since that's the space the ref is populated and queried in throughout.
    switch (action.type) {
      case 'open_tab': {
        if (options?.tab) {
          const conn = activeConnections.find(c => c.id === options.tab!.connectionId);
          const builderState = tabBuilderStateCache.current.get(options.tab.id);
          const persisted = toPersistedTab(options.tab, conn, builderState);
          if (persisted === null) {
            unmirroredTabIdsRef.current.add(action.tabId);
            return;
          }
          unmirroredTabIdsRef.current.delete(action.tabId);
          workspaceApply(actionToOp(action, persisted, activeConnections));
          return;
        }
        if (unmirroredTabIdsRef.current.has(action.tabId)) return;
        workspaceApply(actionToOp(action, undefined, activeConnections));
        return;
      }
      case 'close_tab':
        if (unmirroredTabIdsRef.current.has(action.tabId)) {
          unmirroredTabIdsRef.current.delete(action.tabId);
          return;
        }
        workspaceApply(actionToOp(action, undefined, activeConnections));
        return;
      case 'close_many': {
        const tabIds = action.tabIds.filter(id => !unmirroredTabIdsRef.current.has(id));
        action.tabIds.forEach(id => unmirroredTabIdsRef.current.delete(id));
        if (tabIds.length === 0) return;
        workspaceApply(actionToOp({ ...action, tabIds }, undefined, activeConnections));
        return;
      }
      case 'move_tab':
        if (unmirroredTabIdsRef.current.has(action.tabId)) return;
        workspaceApply(actionToOp(action, undefined, activeConnections));
        return;
      case 'rename_tab':
        if (unmirroredTabIdsRef.current.has(action.oldId)) {
          unmirroredTabIdsRef.current.delete(action.oldId);
          unmirroredTabIdsRef.current.add(action.newId);
          return;
        }
        workspaceApply(actionToOp(action, undefined, activeConnections));
        return;
      default:
        workspaceApply(actionToOp(action, undefined, activeConnections));
    }
  };

  // Tab strip right-click menu (Phase 3 Task 5): detach the tab into a new
  // window, or move it straight into an already-open one. Both cross-window
  // ops are backend-authoritative (see `moveTabToWindow`'s doc comment in
  // workspaceStore.ts) — neither handler below touches `dispatchLayout`
  // directly; the eventual `workspace-changed` broadcast reconciles this
  // window (and the target window) via the existing crossWindow echo path.
  const [tabContextMenu, setTabContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);

  const handleTabContextMenu = (tabId: string, e: React.MouseEvent) => {
    // Sole tab in this window, no other windows to move to: buildTabContextMenuItems
    // returns [] and an empty ContextMenu would render as an empty floating box.
    // Skip opening the menu entirely in that case.
    if (buildTabContextMenuItems(tabId).length === 0) return;
    setTabContextMenu({ tabId, x: e.clientX, y: e.clientY });
  };

  const handleDetachTab = (tabId: string) => {
    detachTabToNewWindow(toProfileSpaceId(tabId, activeConnections));
  };

  const handleMoveTab = (tabId: string, targetWindowId: string) => {
    moveTabToWindow(toProfileSpaceId(tabId, activeConnections), targetWindowId);
    // Final whole-branch review, Fix 4(b): the "Move to <window>" list is
    // built from `lastWorkspaceRef` (the last-known cross-window document),
    // which can list a window whose OS window died without a clean
    // `WindowClosed` record — a dead move target. `focus_window`'s widened
    // backend contract (windows.rs) spawns `targetWindowId` if the store
    // still remembers it but no OS window is currently open, and just
    // focuses it otherwise — fire-and-forget, same as the cross-window open
    // dedupe's own `focus_window` call above.
    invoke('focus_window', { label: targetWindowId }).catch(console.warn);
  };

  // Simplest correct rule (documented, per the task brief): "Detach to New
  // Window" is hidden unless THIS window currently holds more than one tab
  // across ALL its panes (`allTabIds(layout).length > 1`) — the same single
  // condition covers both cases the spec calls out: detaching the sole tab
  // of a secondary window is a backend no-op (`apply_detach_tab`'s
  // "already alone" guard), and detaching a main window's only tab is
  // pointless churn (destroy-and-recreate an equivalent window). "Move to
  // Window" has no such restriction — moving a window's sole tab elsewhere
  // is meaningful (it empties this window, which then closes itself via the
  // tabs-empty effect above) — it's gated only on other windows existing.
  // Unmirrored (export/import) tabs can't participate in either — the
  // backend has no record of them — so both are hidden for them, replaced
  // by a single disabled, explanatory entry.
  const buildTabContextMenuItems = (tabId: string): ContextMenuItem[] => {
    if (unmirroredTabIdsRef.current.has(tabId)) {
      const explanation = 'Export/import tabs stay in their window';
      return [{ label: explanation, onClick: () => {}, disabled: true, title: explanation }];
    }

    const items: ContextMenuItem[] = [];

    const dupSource = tabs.find((t) => t.id === tabId && t.type === 'collection');
    if (dupSource) {
      items.push({
        label: 'Duplicate Tab',
        icon: <Copy />,
        onClick: () => handleDuplicateTab(tabId),
      });
    }

    if (allTabIds(layout).length > 1) {
      items.push({
        label: 'Detach to New Window',
        icon: <ExternalLink />,
        separatorBefore: items.length > 0,
        onClick: () => handleDetachTab(tabId),
      });
    }

    const otherWindows = (lastWorkspaceRef.current?.windows ?? []).filter((w) => w.id !== windowLabel());
    const allTabs = lastWorkspaceRef.current?.tabs ?? [];
    // Separator only when there's something above to separate from (i.e. a
    // "Detach to New Window" item was actually pushed) — otherwise the
    // first "Move to" entry would render an orphan divider line at the very
    // top of the menu.
    otherWindows.forEach((w, i) => {
      const hint = activeTabHintFor(w, allTabs);
      items.push({
        label: `Move to ${hint ? `${w.id} (${hint})` : w.id}`,
        icon: <MoveRight />,
        separatorBefore: i === 0 && items.length > 0,
        onClick: () => handleMoveTab(tabId, w.id),
      });
    });

    return items;
  };

  const cycleTab = (dir: 1 | -1) => {
    const p = focusedPane;
    if (!p || p.tabIds.length < 2) return;
    const i = p.tabIds.indexOf(p.activeTabId ?? '');
    const next = p.tabIds[(i + dir + p.tabIds.length) % p.tabIds.length];
    dispatchWorkspace({ type: 'set_active', paneId: p.id, tabId: next });
  };

  const openQuickStartTab = () => {
    const alreadyOpen = tabs.some(t => t.id === QUICK_START_TAB_ID);
    if (!alreadyOpen) {
      const qs = createQuickStartTab();
      setTabs(prev => prev.some(t => t.id === QUICK_START_TAB_ID) ? prev : [...prev, qs]);
      dispatchWorkspace({ type: 'open_tab', tabId: QUICK_START_TAB_ID }, { tab: qs });
      return;
    }
    dispatchWorkspace({ type: 'open_tab', tabId: QUICK_START_TAB_ID });
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
    ...(focusedPane && focusedPane.tabIds.length > 1 ? [
      { id: 'next-tab', title: 'Next Tab', keywords: 'tab switch', run: () => cycleTab(1) },
      { id: 'prev-tab', title: 'Previous Tab', keywords: 'tab switch', run: () => cycleTab(-1) },
    ] : []),
    ...(activeTabId && focusedPane && focusedPane.tabIds.length > 1 ? [
      { id: 'workspace.split-right', title: 'Split Right', keywords: 'workspace pane layout', run: () => dispatchWorkspace({ type: 'split_pane', paneId: focusedPane.id, dir: 'row', side: 'end', moveTabId: activeTabId }) },
      { id: 'workspace.split-down', title: 'Split Down', keywords: 'workspace pane layout', run: () => dispatchWorkspace({ type: 'split_pane', paneId: focusedPane.id, dir: 'col', side: 'end', moveTabId: activeTabId }) },
    ] : []),
    ...(allPanes(layout.root).length > 1 ? [
      { id: 'workspace.focus-next-pane', title: 'Focus Next Pane', keywords: 'workspace pane layout switch', run: () => {
        const panes = allPanes(layout.root);
        const i = panes.findIndex(p => p.id === layout.focusedPaneId);
        dispatchWorkspace({ type: 'focus_pane', paneId: panes[(i + 1) % panes.length].id });
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
      // `lastAggregate: null` (not omitted) explicitly clears any
      // previously-mirrored aggregate on the backend tab, matching the
      // local `lastAggregate: undefined` above.
      mirrorUpdateTabState(tab.id, activeConnections, { lastQuery: query, lastAggregate: null });
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
    // #188 security review Fix 1: a $out/$merge stage writes the pipeline's
    // output into a collection ($out replaces it, $merge upserts) — on a
    // confirm_destructive (production-safeguard) connection that needs the
    // same typed-name confirmation as drop_collection/delete_many. A
    // read_only connection is backend-blocked (`execute_aggregate_impl`'s
    // guard) regardless of what's sent here; the error surfaces inline via
    // the existing `tab.error` catch below, same as every other query error.
    const mode = activeConnections.find(c => c.id === tab.connectionId)?.mode ?? 'normal';
    let confirmed = false;
    if (mode === 'confirm_destructive') {
      const writeStage = detectAggregateWriteStage(pipeline);
      if (writeStage.hasWriteStage) {
        const ok = await confirmByTypedName(prompt, {
          title: 'Run aggregation',
          kind: 'collection',
          // Fall back to a "type CONFIRM" prompt when the $out/$merge
          // target couldn't be extracted cleanly (e.g. an unrecognized
          // shape) rather than silently under-matching a name.
          expectedName: writeStage.target ?? 'CONFIRM',
          message: writeStage.target
            ? `This pipeline writes into "${writeStage.target}" ($out/$merge) on a safeguarded connection.\n\nType the target collection name to confirm.`
            : 'This pipeline writes to a collection via $out/$merge on a safeguarded connection, but the target could not be determined automatically.\n\nType CONFIRM to proceed.',
        });
        if (!ok) return;
        confirmed = true;
      }
    }

    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, loading: true, error: null } : t));

    try {
      const resultStrs = await invoke<string[]>('execute_aggregate', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        pipeline: JSON.stringify(pipeline),
        confirmed,
      });

      const parsedResults = resultStrs.map(s => JSON.parse(s));
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, results: parsedResults, loading: false, lastAggregate: pipeline } : t));
      mirrorUpdateTabState(tab.id, activeConnections, { lastAggregate: pipeline });
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

  // Foreign-event reconciliation (Phase 3 Task 4). Two independent
  // subscriptions, symmetric setup/cleanup on every mount (the
  // `resUsage`-poll `let active = true` pattern above) — NOT a persist-
  // across-remount ref guard: React 18 StrictMode's dev double-invoke runs
  // setup→cleanup→setup, and a ref guard set permanently `true` by the
  // FIRST setup makes the SECOND setup's early-return skip subscribing
  // entirely, leaving this component with zero listeners for the rest of
  // its life (a real bug caught in review — the ref-guard idiom is only
  // safe for effects that must run their body's side effect at most once
  // ever, like `restoredRef`'s single `workspace_get`; it actively breaks
  // effects, like this one, whose job is to stay subscribed for the
  // component's lifetime). `listen`'s subscribe call is itself async
  // (`Promise<UnlistenFn>`) — `cancelled` covers the case where cleanup
  // runs before that promise resolves (StrictMode's rapid setup/cleanup),
  // unlistening immediately once it does rather than leaking a listener
  // registered after this instance was already torn down. Both listener
  // callbacks are captured ONCE per mount and never refreshed on later
  // renders of that same mount, so — like `handleBuilderStateChange`
  // above — they must read live component state exclusively through refs
  // (`activeConnectionsRef`, `tabsRef`, `layoutRef`, `lastWorkspaceRef`) or
  // through a setter's functional-update form (`setTabs(prev => ...)`),
  // never through a state variable captured directly in the closure.
  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];
    const own = (p: Promise<() => void>) => {
      p.then((unlisten) => {
        if (cancelled) unlisten();
        else unlistenFns.push(unlisten);
      }).catch(() => {});
    };

    own(
      subscribeWorkspaceChanged((payload: WorkspaceChangedPayload) => {
        // Drop a replayed/out-of-order event — revisions only ever
        // increase, so anything at or below what's already applied adds
        // nothing (and applying it would risk clobbering newer local state
        // with older backend state).
        if (payload.revision <= lastSeenRevisionRef.current) return;
        lastSeenRevisionRef.current = payload.revision;
        lastWorkspaceRef.current = payload.workspace;

        // Bystander semantics (CRITICAL fix, review round 1): the backend
        // guarantees `crossWindow: false` for an op iff it changed ONLY
        // the origin window's own tree (see workspace.rs's
        // `op_is_cross_window`). That means, for every non-crossWindow
        // event regardless of origin:
        //  - if origin IS this window: it's our own optimistic dispatch
        //    echoing back — already applied locally, nothing to do.
        //  - if origin is ANOTHER window: that op provably did not touch
        //    THIS window's tree, so this window's entry in `payload` is
        //    just whatever it already was — reconciling against it is a
        //    no-op AT BEST. At worst it's actively wrong: if this window
        //    has a local optimistic change in flight whose mirror hasn't
        //    landed yet, the payload's snapshot of "this window" predates
        //    that change, and hydrating from it would silently roll the
        //    local change back — with no way to recover, since the
        //    self-origin echo that will eventually confirm the mirror is
        //    exactly the kind of event this same branch would (correctly)
        //    ignore too.
        // Only cross-window ops (move_tab_to_window/detach_tab/
        // window_closed) can touch more than one window's tree, including
        // this one's, and are the only ones ever worth reconciling against
        // — regardless of origin, since none of them ever run through this
        // window's own layout reducer even when THIS window caused them
        // (there is no frontend action for them; Task 5 fires them
        // straight at `workspace_apply`).
        if (!payload.crossWindow) return;

        const connections = activeConnectionsRef.current;
        const winEntry = payload.workspace.windows.find((w) => w.id === windowLabel());
        if (!winEntry) {
          // Another window's op (a fold-on-close, a detach, a
          // move-to-window) removed THIS window from the document — there
          // is no tree left to reconcile against. Render empty and destroy
          // the real OS window (Phase 3 Task 5): `closeWorkspaceWindow()`'s
          // `WindowClosed` apply no-ops here (the backend already removed
          // this window from the store — that's WHY `winEntry` is missing),
          // but it still destroys the OS window, which is otherwise never
          // told to close in this "closed by someone else" path.
          // `windowClosingRef` guard: `setTabs([])` right below will also
          // flip `tabs.length` to 0, which would otherwise independently
          // re-trigger the tabs-empty effect's own `closeWorkspaceWindow()`
          // call for this same close (see that effect's comment).
          windowClosingRef.current = true;
          closeWorkspaceWindow();
          setTabs([]);
          tabBuilderStateCache.current.clear();
          dispatchLayout({ type: 'hydrate', layout: createInitialLayout([], null) });
          return;
        }

        // IMPORTANT fix (review round 1): unmirrored tabs (export/import —
        // `toPersistedTab` returns null for them, so they're NEVER sent to
        // the backend and can never appear in ANY snapshot) must survive a
        // hydrate. Captured from `layoutRef.current` (the last-committed
        // local layout — refs stay fresh across this frozen listener,
        // renders keep it current) BEFORE hydrating, so each can be grafted
        // back into the pane it occupied.
        const unmirroredPlacements = tabsRef.current
          .filter((t) => unmirroredTabIdsRef.current.has(t.id))
          .map((t) => ({ tabId: t.id, paneId: paneOfTab(layoutRef.current.root, t.id)?.id }))
          .filter((p): p is { tabId: string; paneId: string } => !!p.paneId);

        // The backend stays in profile-space always (persistence.ts's
        // Global Constraint); translate every id in the incoming tree to
        // THIS window's live space wherever it already has that
        // connection, so a foreign tab whose profile is already connected
        // here renders live immediately instead of as a `profile:` banner.
        const foreignLayout: WorkspaceLayout = { root: winEntry.splitTree, focusedPaneId: winEntry.focusedPaneId };
        const liveLayout = mapLayoutTabIds(foreignLayout, (id) => toLiveSpaceId(id, connections));
        // `{mirror:false}`-equivalent: a raw hydrate, exactly like the
        // restore effect's own dispatch — never mirrored back to the
        // backend, which is where this tree just came from.
        dispatchLayout({ type: 'hydrate', layout: liveLayout });

        // Graft local unmirrored tabs back in: the pane they occupied
        // before, if it still exists in the just-hydrated tree (checked
        // against the plain `liveLayout` value, not React state — a
        // second `dispatchLayout` in this same synchronous callback is
        // applied by the reducer strictly AFTER the hydrate above, same as
        // any other same-tick multi-dispatch burst in this file), else the
        // window's newly-focused pane. Raw `open_tab` (never mirrored —
        // these tabs were never mirrored to begin with); `existing` inside
        // the reducer is guaranteed null since the hydrated tree can never
        // reference an id that was never sent to the backend.
        for (const { tabId, paneId } of unmirroredPlacements) {
          const targetPaneId = findPane(liveLayout.root, paneId) ? paneId : liveLayout.focusedPaneId;
          dispatchLayout({ type: 'open_tab', tabId, paneId: targetPaneId });
        }

        const foreignProfileIds = allTabIds(foreignLayout);
        const foreignLiveIds = new Set(foreignProfileIds.map((id) => toLiveSpaceId(id, connections)));
        const localIds = new Set(tabsRef.current.map((t) => t.id));

        // Leaving: local tabs this window's foreign tree no longer
        // references (moved/detached elsewhere) — EXCLUDING unmirrored
        // tabs (IMPORTANT fix above: they never appear in ANY snapshot, so
        // without this exclusion every export/import tab would look
        // "leaving" on every single crossWindow event). `hydrate` above
        // already replaced the whole tree (grafting unmirrored tabs back
        // in), so there's nothing left to fold in the layout for the
        // REST of this set — just drop their now-orphaned entries from
        // `tabs[]` and the builder cache. Never mirrored: this window
        // didn't cause the change, the window that DID already mirrored
        // it.
        const leaving = tabsRef.current.filter(
          (t) => !foreignLiveIds.has(t.id) && !unmirroredTabIdsRef.current.has(t.id)
        );
        if (leaving.length > 0) {
          const leavingIds = new Set(leaving.map((t) => t.id));
          leavingIds.forEach((id) => {
            tabBuilderStateCache.current.delete(id);
            unmirroredTabIdsRef.current.delete(id);
          });
          setTabs((prev) => prev.filter((t) => !leavingIds.has(t.id)));
        }

        // Arriving: tabs newly referenced by this window's foreign tree.
        // Looked up in `payload.workspace.tabs` (the flat, profile-space
        // backend tab list) by the RAW (pre-translation) id, since that's
        // the space wire `TabModel`s are keyed in.
        const toRefresh: QueryTab[] = [];
        for (const profileId of foreignProfileIds) {
          const liveId = toLiveSpaceId(profileId, connections);
          if (localIds.has(liveId)) continue; // already open here
          const tabModel = payload.workspace.tabs.find((t) => t.id === profileId);
          if (!tabModel) continue; // defensive: tree referenced an unknown tab
          const { tab: arrivingTab, isLive } = materializeArrivingTab(tabModel, connections);
          setTabs((prev) => (prev.some((t) => t.id === arrivingTab.id) ? prev : [...prev, arrivingTab as QueryTab]));
          if (tabModel.builderState != null) {
            tabBuilderStateCache.current.set(arrivingTab.id, tabModel.builderState as BuilderState);
          }
          if (tabModel.profileId) {
            const label = tabModel.profileName || tabModel.profileId;
            setRestoredProfileNames((prev) =>
              prev.get(tabModel.profileId) === label ? prev : new Map(prev).set(tabModel.profileId, label)
            );
          }
          if (isLive && arrivingTab.type === 'collection') toRefresh.push(arrivingTab as QueryTab);
        }
        // Sequential — reuses `refreshTabResults`, the same revive path
        // `handleReconnectProfile` uses below, and for the same reason:
        // don't burst concurrent queries at a connection that may just
        // have finished dialing.
        (async () => {
          for (const tab of toRefresh) {
            await refreshTabResults(tab);
          }
        })();
      })
    );

    own(
      subscribeConnectionsChanged((payload: ConnectionsChangedPayload) => {
        // Connection-id keyed, NOT profileId keyed (final fix wave,
        // agent-connection visibility): a profile can now legitimately have
        // TWO live rows locally — a human connection plus a `viaMcp` one
        // (see `addActiveConnection`'s doc comment) — so "is this profile
        // still live" is no longer the same question as "is this SPECIFIC
        // local connection still live". Keying removal off profileId alone
        // would mean the agent's row (or the human's) could never be torn
        // down by a broadcast as long as the OTHER row for the same profile
        // remained live.
        const liveConnectionIds = new Set(payload.connections.map((c) => c.id));

        // Additions: a profile now has a live id we didn't know about —
        // another window connected it. `applyConnectionsAdditions`
        // (`addActiveConnection`/`rebindProfileTabs`, same two calls
        // `handleQuickConnect`/`handleReconnectProfile` make after their
        // own `connect_db`) also marks every entry's OWN id here as SEEN
        // (`seenConnectionIdsRef` — Fix 3, connection-id-keyed per the
        // closing review; read by the removal loop below); the
        // payload carries no `uri` by design (Task 3 — connection strings
        // never ride an event), so any UI reading `activeConnections[].uri`
        // (the status bar's username display) degrades to '' for a
        // connection registered this way rather than crash.
        applyConnectionsAdditions(payload.connections);

        // Phase 3 Task 6 (LEDGER MANDATE) considered — and deliberately does
        // NOT implement — a self-healing cleanup for "stale" backend
        // `connection_meta` entries: an id present in `payload.connections`
        // that is NOT this window's local id for that profile, while THIS
        // window already has a DIFFERENT, live id for the same profileId
        // (`localByProfile.has(entry.profileId) && localByProfile.get(entry.profileId)!.id !== entry.id`).
        // The backend never prunes `connection_meta` on anything but an
        // explicit `disconnect_db` (see `set_connection_meta_impl`/
        // `connection_list_impl`), so a truly-orphaned id (this window's own
        // past reconnect that never disconnected its predecessor) really
        // would sit there forever without one.
        //
        // The blocker: that same shape is indistinguishable from a genuine
        // race where ANOTHER window is fresh-connecting the same profile
        // concurrently. `handleReconnectProfile`'s fresh-connect branch runs
        // whenever a window's OWN `activeConnections` lacks the profile —
        // nothing stops two windows from independently reconnecting the same
        // profile before either's `connections-changed` broadcast reaches
        // the other (the addition loop above only reconciles a profile ONCE
        // a window has learned about it; until then, both windows call
        // `connect_db` and mint their own id). If that race lands here, BOTH
        // windows would see "an id for my profile that isn't mine" and BOTH
        // would call `disconnect_db` on what is, from the other window's
        // point of view, its own live connection — tearing down a
        // still-in-use connection instead of an orphan. There is no signal
        // in the payload (no origin/window id) to tell the two cases apart.
        // Per the task's own safety rule — "a lingering meta entry is
        // cosmetic; killing a live connection is not" — this cleanup is
        // skipped entirely. The cost is a harmless extra row in another
        // window's `connections-changed` payload for an id nothing
        // references anymore, invisible in the UI (no local `activeConnections`
        // entry ever points at it) until that window reconnects/restarts.

        // Removals: a profile we thought was live is gone from the
        // broadcast — another window disconnected it. Mirrors Sidebar's
        // `onDisconnect` teardown (activeConnections + tabs[] + layout)
        // MINUS the two things that window already did: calling
        // `disconnect_db` itself, and mirroring the `close_many` (mirroring
        // it again here would double-apply the same close backend-side —
        // see the who-mirrors-what note in the task report).
        //
        // Final whole-branch review, Fix 3: gated on `seenConnectionIdsRef`
        // — absence from THIS broadcast alone is not enough to tear down. A
        // connection THIS window just opened can legitimately be missing
        // from an UNRELATED broadcast that races ahead of its own
        // `set_connection_meta` landing backend-side (e.g. some other
        // window connecting/disconnecting something else — OR, per the
        // closing review, an agent/second window connecting a DIFFERENT
        // connection for the SAME profile — in between); that shape is
        // indistinguishable from a real removal by `liveConnectionIds`
        // alone. Only tear down a connection whose own id was previously
        // SEEN live in some earlier broadcast (or the boot `connection_list`
        // seed) and is NOW absent — see `seenConnectionIdsRef`'s own doc
        // comment. A local connection whose id was NEVER seen is instead
        // self-healed by re-announcing it via `setConnectionMeta`, so the
        // backend's `connection_meta` map (and hence the next broadcast)
        // catches up instead of this window silently killing its own live
        // tabs. Keyed by connection id, NOT profileId (the pre-closing-review
        // shape): a profileId-keyed gate would have this exact local
        // connection's OWN profile marked "seen" by the unrelated broadcast
        // row that raced it, and tear it down anyway — the residual bug this
        // fix closes.
        for (const local of activeConnectionsRef.current) {
          if (liveConnectionIds.has(local.id)) continue;
          if (!seenConnectionIdsRef.current.has(local.id)) {
            setConnectionMeta(local.id, local.profileId, local.name, local.mode ?? 'normal');
            continue;
          }
          setActiveConnections((prev) => prev.filter((c) => c.id !== local.id));
          const removed = tabsRef.current.filter((t) => t.connectionId === local.id).map((t) => t.id);
          if (removed.length === 0) continue;
          const removedIds = new Set(removed);
          removedIds.forEach((id) => {
            tabBuilderStateCache.current.delete(id);
            unmirroredTabIdsRef.current.delete(id);
          });
          setTabs((prev) => prev.filter((t) => !removedIds.has(t.id)));
          dispatchLayout({ type: 'close_many', tabIds: removed });
        }
      })
    );

    return () => {
      cancelled = true;
      unlistenFns.forEach((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconnect flow for a ReconnectBanner (Phase 2 Task 6). One click revives
  // EVERY restored tab for this profile — not just the tab whose banner was
  // clicked — since they share the same `profile:<profileId>` prefix and the
  // same underlying connection.
  const handleReconnectProfile = async (profileId: string, profileName: string) => {
    // Synchronous check-and-set on a ref, not `reconnectState` (React state
    // reads/writes are render-batched — two banners for the same profile, or
    // a fast double-click, can both observe `busy: false` before either's
    // `setReconnectState` commits). This is the actual guard; `reconnectState`
    // stays purely for the UI's busy/error display.
    if (reconnectBusyRef.current.has(profileId)) return;
    reconnectBusyRef.current.add(profileId);
    patchReconnectState(profileId, { busy: true, error: null });
    try {
      // Already connected — via quick-connect or the ConnectionManager,
      // whose banners now clear themselves on a normal connect (Fix 1
      // above), but a banner click racing that rebind, or a session from
      // before this fix, can still land here with a live connection already
      // in `activeConnections`. Reuse it instead of minting a duplicate:
      // `addActiveConnection` dedupes by profileId, so a second `connect_db`
      // here would produce an id that never lands in `activeConnections` —
      // every tab rebound to it would be unreachable, and no profile lookup
      // (`load_connection_profiles`) is needed to reuse it either.
      const existing = activeConnections.find((c) => c.profileId === profileId);
      let newId: string;
      if (existing) {
        newId = existing.id;
      } else {
        const profiles = await invoke<ConnectionProfile[]>('load_connection_profiles');
        const profile = profiles.find((p) => p.id === profileId);
        if (!profile) {
          patchReconnectState(profileId, { busy: false, error: 'Connection profile no longer exists' });
          return;
        }

        newId = await invoke<string>('connect_db', { uri: profile.uri, ssh: profile.ssh ?? null });
        addActiveConnection(newId, profileName, profile.uri, profile.id, profile.color_tag ?? undefined, undefined, profile.connection_mode ?? 'normal');
        // Announce this fresh id to every other window (Phase 3 Task 6) —
        // see `setConnectionMeta`'s doc comment. Deliberately NOT called on
        // the `existing` (reuse) branch above: that id's meta was already
        // set the first time it connected.
        setConnectionMeta(newId, profile.id, profileName, profile.connection_mode ?? 'normal');
      }

      // Captured before any state updates below — `tabs`/`layout` in this
      // closure still reflect the profile: id space this reconnect started
      // from, which is exactly what `rebindProfileTabs`/oldTabsSnapshot need.
      const oldTabsSnapshot = tabs;
      const activeOldIds = new Set(
        allPanes(layout.root)
          .map((p) => p.activeTabId)
          .filter((id): id is string => !!id)
      );

      const { idMap } = rebindProfileTabs(profileId, newId);

      patchReconnectState(profileId, { busy: false, error: null });

      // Eagerly reload every revived collection tab's last query/aggregate so
      // the grid isn't left empty post-reconnect (index/shell/etc. tabs have
      // no query to re-run). Sequential, not Promise.all — a burst of
      // concurrent queries against a connection that just finished dialing is
      // unfriendly; whichever tab was visible (its pane's active tab) before
      // the reconnect goes first, since that's what the user is looking at.
      const revived = oldTabsSnapshot
        .filter((t) => idMap.has(t.id) && t.type === 'collection')
        .map((t) => ({ oldId: t.id, tab: { ...t, id: idMap.get(t.id)!, connectionId: newId } }));
      revived.sort((a, b) => Number(activeOldIds.has(b.oldId)) - Number(activeOldIds.has(a.oldId)));
      for (const { tab } of revived) {
        await refreshTabResults(tab);
      }
    } catch (err: any) {
      patchReconnectState(profileId, { busy: false, error: err?.message || String(err) });
    } finally {
      reconnectBusyRef.current.delete(profileId);
    }
  };

  // When a tracked import OR generate task (started from the Import tab, or
  // #91's Generate tab) is observed completed by the task poll, refresh the
  // matching open collection tab so newly-written documents show up without
  // a manual re-run.
  useEffect(() => {
    const pending = pendingImportRefreshRef.current;
    if (pending.size === 0) return;
    for (const task of exportTasks) {
      if ((task.kind !== 'import' && task.kind !== 'generate') || task.status !== 'completed') continue;
      const info = pending.get(task.id);
      if (!info) continue;
      pending.delete(task.id);
      const matches = collectionTabsMatching(tabs, {
        connectionId: info.connectionId,
        db: info.db,
        collection: info.collection,
      });
      for (const match of matches) refreshTabResults(match);
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

  // All three take the rendered export `tab` (not activeTab / focused-pane state) so
  // that every per-pane ExportView instance acts on its own pane's collection, even
  // when a different pane is focused (see renderTabContent's export branch).
  const handleCopyCurrentExport = async (
    tab: QueryTab,
    format: 'json' | 'ndjson' | 'csv',
    options: ExportOptions
  ) => {
    const sourceTab = deriveExportSourceTab(tab);
    if (!sourceTab?.results?.length) return;
    try {
      const text = await invoke<string | null>('format_current_docs', {
        docs: sourceTab.results,
        format,
        options,
        path: null,
      });
      if (text) await navigator.clipboard.writeText(text);
      toast(`Copied ${sourceTab.results.length} document(s) as ${format.toUpperCase()}`, 'success');
    } catch (err: any) {
      toast(`Copy failed: ${err?.message || err}`, 'error');
    }
  };

  const handleScanExportFields = (tab: QueryTab, query?: FilteredExportQuery) =>
    invoke<string[]>('sample_export_fields', {
      id: tab.connectionId,
      database: tab.db,
      collection: tab.collection,
      filter: query?.kind === 'find' ? query.filter : '{}',
      pipeline: query?.kind === 'aggregate' ? query.pipeline : '',
    });

  const handlePreviewExport = async (
    tab: QueryTab,
    format: ExportFormat,
    scope: 'current' | 'full' | 'filtered',
    options: ExportOptions,
    query?: FilteredExportQuery
  ): Promise<string> => {
    if (scope === 'current') {
      const sourceTab = deriveExportSourceTab(tab);
      const docs = (sourceTab?.results ?? []).slice(0, 5);
      return (
        (await invoke<string | null>('format_current_docs', { docs, format, options, path: null })) ?? ''
      );
    }
    return invoke<string>('preview_export', {
      id: tab.connectionId,
      database: tab.db,
      collection: tab.collection,
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
    // #188 Task 3: on a confirm_destructive connection, delete_many requires
    // a typed-name match before `confirmed: true` is sent — see
    // `confirmByTypedName`'s doc comment. Read from `activeConnections`
    // (populated at connect time — see `addActiveConnection`'s doc comment);
    // defaults to 'normal' both when the connection carries no mode (a
    // normal/sample connection) and pre-Task-5 for any connection this
    // window learned about via `connections-changed` rather than connecting
    // itself.
    const mode = activeConnections.find((c) => c.id === tab.connectionId)?.mode ?? 'normal';
    try {
      const count = await invoke<number>('count_documents', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter,
      });
      let confirmed = false;
      if (mode === 'confirm_destructive') {
        const ok = await confirmByTypedName(prompt, {
          title: 'Delete many',
          kind: 'collection',
          expectedName: tab.collection,
          message: `${bulkConfirmMessage('Delete', count, filter)}\n\nType the collection name to confirm.`,
        });
        if (!ok) return;
        confirmed = true;
      } else if (
        !(await confirm({
          title: 'Delete many',
          message: bulkConfirmMessage('Delete', count, filter),
          confirmLabel: 'Delete',
          destructive: true,
        }))
      ) {
        return;
      }
      const deleted = await invoke<number>('delete_many', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter,
        confirmed,
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
    // #188 Task 3: see handleDeleteMany's comment on this same lookup.
    const mode = activeConnections.find((c) => c.id === tab.connectionId)?.mode ?? 'normal';
    try {
      const count = await invoke<number>('count_documents', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter,
      });
      let confirmed = false;
      if (mode === 'confirm_destructive') {
        const ok = await confirmByTypedName(prompt, {
          title: 'Update many',
          kind: 'collection',
          expectedName: tab.collection,
          message: `${bulkConfirmMessage('Apply this update to', count, filter)}\n\nType the collection name to confirm.`,
        });
        if (!ok) return;
        confirmed = true;
      } else if (
        !(await confirm({
          title: 'Update many',
          message: bulkConfirmMessage('Apply this update to', count, filter),
          confirmLabel: 'Update',
          destructive: true,
        }))
      ) {
        return;
      }
      const modified = await invoke<number>('update_many', {
        id: tab.connectionId,
        database: tab.db,
        collection: tab.collection,
        filter,
        update,
        confirmed,
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
    // A restored-but-not-yet-reconnected tab (see the session-restore effect
    // above) still carries its `profile:<profileId>` connectionId — render
    // the Reconnect banner INSTEAD of the tab's normal content, for every
    // tab type (collection, index, shell, ...), checked before the type
    // switch below so no branch there ever sees a `profile:` connectionId.
    if (tab.connectionId.startsWith('profile:')) {
      const profileId = tab.connectionId.slice('profile:'.length);
      const profileName = restoredProfileNames.get(profileId) || profileId;
      const namespace = [tab.db, tab.collection, tab.indexName].filter(Boolean).join('.');
      const state = reconnectState.get(profileId);
      return (
        <ReconnectBanner
          profileName={profileName}
          namespace={namespace}
          busy={!!state?.busy}
          error={state?.error ?? null}
          onReconnect={() => handleReconnectProfile(profileId, profileName)}
        />
      );
    }
    // Per-tab mode banner (#188 Task 5) — the connection's read-only /
    // confirm-destructive safeguard, if any, read straight off
    // `activeConnections` (populated at connect time, see `addActiveConnection`
    // and `applyConnectionsAdditions`). Rendered ABOVE the tab's normal
    // content (not instead of it, unlike the ReconnectBanner above) for every
    // tab type that operates on a connection; `settings`/`quickstart`/`tasks`
    // have no connection to badge.
    const connMode = activeConnections.find((c) => c.id === tab.connectionId)?.mode;
    const showModeBanner = !!connMode && connMode !== 'normal' && CONNECTION_TAB_TYPES.has(tab.type);
    const body = (
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
                    connectionMode={connMode}
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
        {tab.type === 'generate' && (
          <GenerateView
            key={tab.id}
            connectionId={tab.connectionId}
            database={tab.db}
            collection={tab.collection || undefined}
            task={(() => {
              const taskId = generateTaskIdsRef.current.get(tab.id);
              return taskId ? exportTasks.find((t) => t.id === taskId) : undefined;
            })()}
            onRun={(template, count, seed, collection) => handleRunGenerate(tab, template, count, seed, collection)}
            onOpenTasks={handleOpenTasksTab}
            onCancel={handleCancelTask}
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
              onScanFields={(query) => handleScanExportFields(tab, query)}
              onCopyCurrent={(format, options) => handleCopyCurrentExport(tab, format, options)}
              onPreview={(format, scope, options, query) => handlePreviewExport(tab, format, scope, options, query)}
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

    if (!showModeBanner) return body;

    const bannerIsReadOnly = connMode === 'read_only';
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          data-testid="connection-mode-banner"
          data-mode={connMode}
          className={cn(
            'flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs font-medium',
            bannerIsReadOnly
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
          )}
        >
          {bannerIsReadOnly ? <Lock size={12} className="shrink-0" /> : <ShieldAlert size={12} className="shrink-0" />}
          <span>
            {bannerIsReadOnly
              ? 'Read-only connection — writes are blocked'
              : 'Production safeguard — destructive operations require confirmation'}
          </span>
        </div>
        <div className="min-h-0 flex-1">{body}</div>
      </div>
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
          isCollectionOpen={(connectionId, db, collection) =>
            collectionTabsMatching(tabs, { connectionId, db, collection }).length > 0
          }
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
          onOpenGenerate={handleOpenGenerateTab}
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
            dispatchWorkspace({ type: 'close_many', tabIds: removed });
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
            onConnect={(id, name, uri, profileId, colorTag, connectionMode) => {
              addActiveConnection(id, name, uri, profileId, colorTag ?? undefined, undefined, connectionMode ?? 'normal');
              // Announce this fresh id to every other window (Phase 3 Task 6)
              // — see `setConnectionMeta`'s doc comment.
              setConnectionMeta(id, profileId, name, connectionMode ?? 'normal');
              // Clear any ReconnectBanner this profile still has showing
              // (#97 phase 2 final review Fix 1) — see `rebindProfileTabs`'s
              // doc comment.
              rebindProfileTabs(profileId, id);
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
        onTabContextMenu={handleTabContextMenu}
      />
      {tabContextMenu && (
        <ContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          items={buildTabContextMenuItems(tabContextMenu.tabId)}
          onClose={() => setTabContextMenu(null)}
        />
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
