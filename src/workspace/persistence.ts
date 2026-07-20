// Pure helpers that translate between the live App.tsx tab/layout state and
// the persisted (backend) workspace document shape. No `invoke` calls here —
// see workspaceStore.ts for the IO side. Keeping this pure makes it trivial
// to unit test the profile-prefix id substitution and snapshot shaping
// without mocking Tauri or React.
//
// Global Constraint: the backend workspace store (ws.tabs + every window's
// splitTree) must live ENTIRELY in `profile:<profileId>` id space, never in
// live `connectionId` space. Live connection ids are minted per `connect_db`
// call and are worthless after a restart; `profile:<profileId>` ids are
// stable across reconnects and restarts. Two things follow:
//  1. `toPersistedTab` rewrites a tab's id at save time (this file).
//  2. Every OTHER id-bearing field that reaches `workspace_apply` — not just
//     `open_tab`'s nested tab payload, but every op's own top-level tab-id
//     field(s) (`tab_id`, `tab_ids[]`, `old_id`/`new_id`, `move_tab_id`,
//     etc.) — must be translated too, at the single mirror choke point
//     (`dispatchWorkspace` in App.tsx, via `actionToOp`'s `connections`
//     param in workspaceStore.ts). Missing (2) is exactly the bug this
//     comment exists to prevent recurring: a live id can slip into the
//     backend's layout tree while `ws.tabs` holds the profile-space id for
//     the same tab, splitting the tree and the tab list into two id spaces
//     that never resolve to each other again.
// Pane/split ids are NOT part of this constraint — both the TS and Rust
// reducers mint them deterministically from the same op stream, so they're
// already identical across the two sides without any translation.

import {
  workspaceReducer,
  allTabIds,
  type LayoutNode,
  type WorkspaceLayout,
} from './model';

// Mirrors src-tauri's `TabModel` wire shape (camelCase field names — see
// workspace.rs). `type` covers all 17 QueryTab kinds from App.tsx.
export type QueryTabType =
  | 'collection'
  | 'index'
  | 'shell'
  | 'settings'
  | 'quickstart'
  | 'export'
  | 'import'
  | 'tasks'
  | 'schema'
  | 'create-view'
  | 'gridfs'
  | 'monitoring'
  | 'users'
  | 'dump'
  | 'restore'
  | 'validation'
  | 'generate';

export interface PersistedTab {
  id: string;
  type: QueryTabType;
  profileId: string;
  profileName: string;
  db: string;
  collection: string;
  indexName?: string;
  lastQuery?: unknown;
  lastAggregate?: unknown;
  builderState?: unknown;
}

export interface PersistedWindow {
  id: string;
  splitTree: LayoutNode;
  focusedPaneId: string;
}

export interface PersistedWorkspace {
  revision: number;
  windows: PersistedWindow[];
  tabs: PersistedTab[];
}

// Structural subsets of App.tsx's private `QueryTab`/`ActiveConnection` types
// — keeping persistence.ts free of an import from App.tsx (which itself
// imports this module). Any object satisfying these shapes (App's real
// QueryTab/ActiveConnection included) can be passed in directly.
export interface PersistableTab {
  id: string;
  type: QueryTabType;
  connectionId: string;
  db: string;
  collection: string;
  indexName?: string;
  lastQuery?: unknown;
  lastAggregate?: unknown;
}

export interface PersistableConnection {
  id: string;
  profileId: string;
  name: string;
}

// The shape App.tsx's `tabs` state needs after a restore — a structural
// subset of App's `QueryTab` (extra optional QueryTab fields are simply
// absent, which is fine for assignment into `QueryTab[]`).
export interface RestoredTab {
  id: string;
  type: QueryTabType;
  connectionId: string;
  db: string;
  collection: string;
  indexName?: string;
  results: unknown[];
  loading: boolean;
  error: string | null;
  explainResult: string | null;
  lastQuery?: unknown;
  lastAggregate?: unknown;
}

// export/import tabs reference in-flight task state that no longer exists
// after a restart — they must never be persisted. `generate` joins them for
// the same reason (an in-progress/just-built template + its background task
// don't survive either) — this also makes it MCP-unmirrored automatically:
// `toPersistedTab` returning null for it is what App.tsx's `dispatchWorkspace`
// reads to populate `unmirroredTabIdsRef`, so no separate change is needed.
const NON_PERSISTED_TYPES = new Set<QueryTabType>(['export', 'import', 'generate']);
// These tab kinds carry no connection at all; pass their id through as-is.
const CONNECTIONLESS_TYPES = new Set<QueryTabType>(['settings', 'quickstart', 'tasks']);

/**
 * Rewrite `id`'s live `<connectionId>` segment (if any) to
 * `profile:<profileId>`, by scanning `connections` for one whose `id`
 * appears in `id` as a substring — the same substitution `toPersistedTab`
 * needs for a single already-known tab, generalized to scan a whole list so
 * the App-level mirror choke point can translate ANY id-bearing op field
 * (which may reference any of several live connections, e.g. a `close_many`
 * batch) without knowing in advance which connection it belongs to. Ids with
 * no matching live-connection segment pass through unchanged — this
 * correctly no-ops for ids already in `profile:` form (nothing in
 * `connections` has a live id that looks like `profile:...`) and for
 * connectionless ids (`settings`/`quickstart`/`tasks`, or a pane/split id).
 */
export function toProfileSpaceId(id: string, connections: PersistableConnection[]): string {
  const conn = connections.find((c) => id.includes(c.id));
  return conn ? id.replace(conn.id, `profile:${conn.profileId}`) : id;
}

/**
 * Inverse of `toProfileSpaceId` (Phase 3 Task 4): rewrite `id`'s
 * `profile:<profileId>` segment (if any) to the live `<connectionId>` of a
 * connection in `connections` matching that profile. Used when reconciling a
 * FOREIGN window's slice of the backend workspace (always profile-space,
 * per the Global Constraint above) into this window's local id space, where
 * a tab whose connection this window already has live should render exactly
 * like any other locally-reconnected tab, not stuck as a `profile:` banner.
 * Ids with no matching profile prefix — already live-space, connectionless
 * (`settings`/`quickstart`/`tasks`), or a pane/split id — pass through
 * unchanged, mirroring `toProfileSpaceId`'s own no-op cases.
 */
export function toLiveSpaceId(id: string, connections: PersistableConnection[]): string {
  const conn = connections.find((c) => id.includes(`profile:${c.profileId}`));
  return conn ? id.replace(`profile:${conn.profileId}`, conn.id) : id;
}

/**
 * Build the persisted (wire) form of a live tab, or `null` if this tab kind
 * never survives a restart (export/import). Connection-scoped tab ids are
 * rewritten at save time: the live id's leading `<connectionId>` segment
 * (a session-scoped id from `connect_db`) is replaced by the stable
 * `profile:<profileId>` prefix, so a saved tab id never depends on a live
 * connection session that won't exist after restart.
 */
export function toPersistedTab(
  tab: PersistableTab,
  conn: PersistableConnection | undefined,
  builderState: unknown
): PersistedTab | null {
  if (NON_PERSISTED_TYPES.has(tab.type)) return null;

  if (CONNECTIONLESS_TYPES.has(tab.type)) {
    return {
      id: tab.id,
      type: tab.type,
      profileId: '',
      profileName: '',
      db: tab.db,
      collection: tab.collection,
      indexName: tab.indexName,
      lastQuery: tab.lastQuery,
      lastAggregate: tab.lastAggregate,
      builderState,
    };
  }

  const profileId = conn?.profileId ?? '';
  const profileName = conn?.name ?? '';
  const id = conn ? toProfileSpaceId(tab.id, [conn]) : tab.id;
  return {
    id,
    type: tab.type,
    profileId,
    profileName,
    db: tab.db,
    collection: tab.collection,
    indexName: tab.indexName,
    lastQuery: tab.lastQuery,
    lastAggregate: tab.lastAggregate,
    builderState,
  };
}

/**
 * Rehydrate a persisted workspace document into the shape App.tsx needs
 * before any profile has reconnected: empty-results tabs (so the UI shows a
 * "reconnect to load" state rather than stale data), plus the layout tree
 * and any cached builder states. Tab ids are used exactly as stored —
 * `toPersistedTab` already rewrote them into `profile:<profileId>` form at
 * save time, so no further id surgery happens here.
 *
 * `windowId` (Phase 3 Task 4, default `"main"`) selects WHICH window's
 * slice of the document to materialize — `ws.windows` may hold more than
 * one window now, and `ws.tabs` is a FLAT list shared across all of them
 * (each window's `splitTree` only references a subset). Every window's
 * boot must materialize ONLY its own tabs into local state; the returned
 * `tabs`/`builderStates` are filtered down to the ids this window's layout
 * tree actually references. A `windowId` with no matching entry in
 * `ws.windows` (e.g. a not-yet-registered secondary window) produces the
 * same empty single-pane fallback as an empty/missing `ws.windows` — never
 * a silent fallback to some OTHER window's tree, which would leak its tabs
 * into this one.
 */
export function toDisconnectedSnapshot(
  ws: PersistedWorkspace,
  windowId: string = 'main'
): {
  tabs: RestoredTab[];
  layout: WorkspaceLayout;
  builderStates: Map<string, unknown>;
} {
  const win = ws.windows.find((w) => w.id === windowId);
  let layout: WorkspaceLayout = win
    ? { root: win.splitTree, focusedPaneId: win.focusedPaneId }
    : { root: { kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null }, focusedPaneId: 'pane-1' };

  const windowTabIds = new Set(allTabIds(layout));
  const windowTabs = ws.tabs.filter((t) => windowTabIds.has(t.id));

  const tabs: RestoredTab[] = windowTabs.map((t) => ({
    id: t.id,
    type: t.type,
    connectionId: t.profileId ? `profile:${t.profileId}` : '',
    db: t.db,
    collection: t.collection,
    indexName: t.indexName,
    results: [],
    loading: false,
    error: null,
    explainResult: null,
    lastQuery: t.lastQuery,
    lastAggregate: t.lastAggregate,
  }));

  const builderStates = new Map<string, unknown>();
  for (const t of windowTabs) {
    if (t.builderState != null) builderStates.set(t.id, t.builderState);
  }

  // Defensive: fold out any layout tab id with no matching persisted tab
  // (e.g. legacy/corrupt workspace.json) using the same reducer close_tab
  // uses live, so pane folding/focus-repair stays consistent with a normal
  // tab close rather than a naive tabIds filter.
  const knownIds = new Set(windowTabs.map((t) => t.id));
  for (const tabId of allTabIds(layout)) {
    if (!knownIds.has(tabId)) {
      layout = workspaceReducer(layout, { type: 'close_tab', tabId });
    }
  }

  return { tabs, layout, builderStates };
}

/**
 * Materialize one tab id ARRIVING into this window's tree from a foreign
 * `workspace-changed` event (Phase 3 Task 4) — the wire `TabModel`
 * (`tab`, always profile-space) plus whether this window already has a live
 * connection for its profile. Mirrors `toDisconnectedSnapshot`'s per-tab
 * shape for the disconnected case, but additionally rebinds onto the live
 * connection id (like a reconnect's `rebindProfileTabs`) when one exists —
 * an arriving tab whose profile is already connected here should render
 * live immediately, not as a stale `profile:` banner the user has to click
 * through. `results` always starts empty regardless of `isLive`; the caller
 * is responsible for refreshing (re-running `lastQuery`/`lastAggregate`)
 * live arrivals afterward — this function is pure and does no IO.
 */
export function materializeArrivingTab(
  tab: PersistedTab,
  connections: PersistableConnection[]
): { tab: RestoredTab; isLive: boolean } {
  const conn = connections.find((c) => c.profileId === tab.profileId && tab.profileId !== '');
  const id = conn ? toLiveSpaceId(tab.id, connections) : tab.id;
  const connectionId = conn ? conn.id : tab.profileId ? `profile:${tab.profileId}` : '';
  return {
    isLive: !!conn,
    tab: {
      id,
      type: tab.type,
      connectionId,
      db: tab.db,
      collection: tab.collection,
      indexName: tab.indexName,
      results: [],
      loading: false,
      error: null,
      explainResult: null,
      lastQuery: tab.lastQuery,
      lastAggregate: tab.lastAggregate,
    },
  };
}

/**
 * Map every id in `tabIds` that contains `oldPrefix` (a `profile:<id>`
 * connection prefix) to its rebound form under `newConnectionId` — the pairs
 * the App applies exactly like `handleDatabaseRenamed`: a `tabs` rewrite plus
 * one `rename_tab` dispatch per pair. Ids without the prefix are left out of
 * the result entirely (nothing to rebind).
 */
export function rebindConnection(
  oldPrefix: string,
  newConnectionId: string,
  tabIds: string[]
): Array<{ oldId: string; newId: string }> {
  return tabIds
    .filter((id) => id.includes(oldPrefix))
    .map((oldId) => ({ oldId, newId: oldId.replace(oldPrefix, newConnectionId) }));
}
