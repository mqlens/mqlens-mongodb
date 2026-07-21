// Thin invoke wrappers for the backend workspace store (see
// src-tauri/src/workspace.rs) — mirrors the queryStore.ts idiom: async
// wrappers for reads, fire-and-forget for writes the caller doesn't need to
// await. Pure translation logic (id substitution, snapshot shaping) lives in
// persistence.ts; this module is the only one that touches `invoke`.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { WorkspaceAction } from './model';
import { toProfileSpaceId, type PersistableConnection, type PersistedTab, type PersistedWorkspace } from './persistence';

/**
 * This window's Tauri label (`"main"` or `"win-N"`), memoized after the
 * first successful read — a webview's label never changes for its
 * lifetime. `getCurrentWebviewWindow().label` reaches into
 * `window.__TAURI_INTERNALS__.metadata`, which doesn't exist under jsdom
 * (vitest has no real Tauri runtime), so it throws synchronously there;
 * the catch falls back to `"main"`, matching every existing test's implicit
 * assumption that it's running as the primary window.
 */
let cachedWindowLabel: string | undefined;
export function windowLabel(): string {
  if (cachedWindowLabel === undefined) {
    try {
      cachedWindowLabel = getCurrentWebviewWindow().label;
    } catch {
      cachedWindowLabel = 'main';
    }
  }
  return cachedWindowLabel;
}

/** `GET workspace.json` (backend-cached after first call). */
export async function workspaceGet(): Promise<PersistedWorkspace | null> {
  return invoke<PersistedWorkspace | null>('workspace_get');
}

/**
 * Fire-and-forget apply of one op to the backend store. Never throws — the
 * mirror must never block or fail the UI action it shadows; failures are
 * logged and dropped. `origin` (this window's label) lets every window's
 * `workspace-changed` listener recognize and ignore its own echo — see
 * App.tsx's foreign-event reconciliation effect.
 */
export function workspaceApply(op: Record<string, unknown>): void {
  invoke('workspace_apply', { op, origin: windowLabel() }).catch((err) => {
    console.warn('workspace_apply failed', err);
  });
}

/**
 * Fire-and-forget: detach `tabId` (already profile-space — callers translate
 * via `toProfileSpaceId` before calling, same as every other cross-window op)
 * into a brand-new window via the backend `workspace_detach_tab` command
 * (Phase 3 Task 5). That command applies `DetachTab`, broadcasts
 * `workspace-changed` itself, and spawns the new OS window — nothing further
 * to do here; this window's own tree updates (if it was the source) via the
 * crossWindow echo, same as `moveTabToWindow` below.
 */
export function detachTabToNewWindow(tabId: string): void {
  invoke('workspace_detach_tab', { tabId, origin: windowLabel() }).catch((err) => {
    console.warn('workspace_detach_tab failed', err);
  });
}

/**
 * Fire-and-forget: close the OS window labeled `label` (default: this
 * window). Backs two `App.tsx` call sites (Phase 3 Task 5): a secondary
 * window proactively closing itself once its last tab closes/moves away, and
 * a window reacting to discovering its own entry vanished from a
 * `crossWindow` broadcast it didn't cause. The backend `close_workspace_window`
 * command applies `WindowClosed` (a no-op if already gone from the store)
 * and then destroys the real OS window if one is still open.
 */
export function closeWorkspaceWindow(label: string = windowLabel()): void {
  invoke('close_workspace_window', { label, origin: windowLabel() }).catch((err) => {
    console.warn('close_workspace_window failed', err);
  });
}

/**
 * Fire-and-forget: mirrors a `MoveTabToWindow` op straight to the backend
 * store (Phase 3 Task 5's "Move to Window" context menu entry). `tabId` must
 * already be profile-space (callers translate via `toProfileSpaceId` first,
 * same as `detachTabToNewWindow`). Deliberately a THIN wrapper around
 * `workspaceApply`, not a `dispatchWorkspace` action: this op is
 * backend-authoritative and cross-window by nature (it can empty THIS
 * window's tree, or fill another window's), so it must never be applied
 * locally via `dispatchLayout` — the eventual `workspace-changed` broadcast
 * (`crossWindow: true`) is what reconciles every affected window, including
 * this one if it was the source.
 */
export function moveTabToWindow(tabId: string, targetWindowId: string, targetPaneId?: string): void {
  const op: Record<string, unknown> = { type: 'move_tab_to_window', tab_id: tabId, target_window_id: targetWindowId };
  if (targetPaneId !== undefined) op.target_pane_id = targetPaneId;
  workspaceApply(op);
}

/** Wire shape of the `workspace-changed` broadcast (src-tauri/src/workspace.rs's `WorkspaceChangedPayload`). */
export interface WorkspaceChangedPayload {
  revision: number;
  origin: string;
  crossWindow: boolean;
  workspace: PersistedWorkspace;
}

/**
 * Subscribe to the backend's `workspace-changed` broadcast (Phase 3 Task 3),
 * fired after every state-changing `workspace_apply`. Thin wrapper around
 * `listen` (pattern precedent: UpdatePrompt.tsx's `update://progress`
 * listener) — returns the same `Promise<UnlistenFn>` `listen` does; the
 * caller owns StrictMode-safe subscribe-once/cleanup, same as any other
 * effect-scoped listener.
 */
export function subscribeWorkspaceChanged(
  listener: (payload: WorkspaceChangedPayload) => void
): Promise<UnlistenFn> {
  return listen<WorkspaceChangedPayload>('workspace-changed', (event) => listener(event.payload));
}

/** Wire shape of the `connections-changed` broadcast (src-tauri/src/state.rs's `ConnectionsChangedPayload`). */
export interface ConnectionEntry {
  id: string;
  profileId: string;
  name: string;
  /** True iff this connection was opened by the embedded MCP server's `connect` tool rather than a human (#98 Task 4). */
  viaMcp: boolean;
  /** Read-only / confirm-destructive production safeguard (#188), registered at connect time from the profile's `connection_mode`. */
  mode?: 'normal' | 'read_only' | 'confirm_destructive';
}
export interface ConnectionsChangedPayload {
  connections: ConnectionEntry[];
}

/** Subscribe to the backend's `connections-changed` broadcast (Phase 3 Task 3). Same shape/contract as `subscribeWorkspaceChanged`. */
export function subscribeConnectionsChanged(
  listener: (payload: ConnectionsChangedPayload) => void
): Promise<UnlistenFn> {
  return listen<ConnectionsChangedPayload>('connections-changed', (event) => listener(event.payload));
}

/**
 * `GET` the full current connection list (final whole-branch review, Fix
 * 2). Thin wrapper over the backend's `connection_list` command
 * (`connection_list_impl`) — same element shape as
 * `ConnectionsChangedPayload.connections`. Called once by App.tsx's boot
 * effect, after `workspace_get` resolves: without this, a freshly spawned
 * window (or a window that just missed the `connections-changed` broadcast
 * for a connection another window made before this one existed) starts
 * with no live connections at all — any restored `profile:<id>` tab it
 * hydrates renders a `ReconnectBanner` for a profile that's actually
 * already live, inviting a duplicate `connect_db`. Unlike
 * `subscribeConnectionsChanged`, this never broadcasts — it's a plain read.
 */
export async function connectionList(): Promise<ConnectionEntry[]> {
  return invoke<ConnectionEntry[]>('connection_list');
}

/**
 * Fire-and-forget: announce `id`'s profile/name to the backend's
 * `connection_meta` map (Phase 3 Task 3's `set_connection_meta` command),
 * which triggers a `connections-changed` broadcast every other window's
 * reconciliation listener consumes. Phase 3 Task 6: called once per
 * newly-minted connection id, right after every `connect_db` that produces
 * one — App.tsx's `handleQuickConnect`, the `ConnectionManager` `onConnect`
 * handler, and `handleReconnectProfile`'s fresh-connect branch. Never called
 * for a path that reuses an id already live in `activeConnections` — that
 * id's meta was already set the first time it connected, and a redundant
 * call would just re-broadcast unchanged data. Same fire-and-forget contract
 * as `workspaceApply`: never throws, failures are logged and dropped rather
 * than blocking the connect flow that shadows it.
 *
 * `mode` (#188) is the connecting profile's `connection_mode` at the moment
 * of connect — the backend command requires it, so every caller must supply
 * it (defaulting to `'normal'` covers a caller that only has an id/name to
 * re-announce, e.g. the self-heal path, and never had a profile in hand).
 */
export function setConnectionMeta(
  id: string,
  profileId: string,
  name: string,
  mode: 'normal' | 'read_only' | 'confirm_destructive' = 'normal'
): void {
  invoke('set_connection_meta', { id, profileId, name, mode }).catch((err) => {
    console.warn('set_connection_meta failed', err);
  });
}

/**
 * Translate one frontend `WorkspaceAction` (camelCase keys) into the wire-
 * shaped op `workspace_apply` expects (snake_case keys; a nested `tab`
 * payload, when present, keeps TabModel's camelCase fields as-is). `tab` is
 * only meaningful for `open_tab` — pass the already-persisted form (or
 * `null`/omit to move/focus an existing backend tab without touching its
 * stored model).
 *
 * `connections`, when supplied, translates every TAB-id-bearing field
 * (`tab_id`, `tab_ids[]`, `old_id`/`new_id`, `move_tab_id`) from the live
 * `<connectionId>` space the frontend action was built in into the
 * `profile:<profileId>` space the backend store must stay in — see
 * persistence.ts's "Global Constraint" note. PANE/split ids (`pane_id`,
 * `target_pane_id`, `split_id`) are deliberately left untouched: both the TS
 * and Rust reducers mint those deterministically from the same op stream, so
 * they already agree without translation. Omitting `connections` (or passing
 * an empty list) is a no-op passthrough — used by tests that want the raw,
 * untranslated op shape.
 */
export function actionToOp(
  action: WorkspaceAction,
  tab?: PersistedTab | null,
  connections: PersistableConnection[] = []
): Record<string, unknown> {
  const id = (raw: string): string => toProfileSpaceId(raw, connections);
  // Every pane-referencing WorkspaceOp variant carries `window_id` (Phase 3
  // Task 2) so the backend resolves this op against THIS window's tree —
  // `default_window_id` on the Rust side only covers callers that predate
  // multi-window, not this one. `update_tab_state`/`hydrate` are the two
  // exceptions (see their own cases below): the former never touches a
  // layout tree, the latter is never mirrored at all.
  const window_id = windowLabel();

  switch (action.type) {
    case 'open_tab': {
      const op: Record<string, unknown> = { type: 'open_tab', tab_id: id(action.tabId), window_id };
      if (action.paneId !== undefined) op.pane_id = action.paneId;
      if (tab) op.tab = tab;
      return op;
    }
    case 'close_tab':
      return { type: 'close_tab', tab_id: id(action.tabId), window_id };
    case 'close_many':
      return { type: 'close_many', tab_ids: action.tabIds.map(id), window_id };
    case 'move_tab': {
      const op: Record<string, unknown> = {
        type: 'move_tab',
        tab_id: id(action.tabId),
        target_pane_id: action.targetPaneId, // pane id — not translated
        window_id,
      };
      if (action.index !== undefined) op.index = action.index;
      return op;
    }
    case 'split_pane': {
      const op: Record<string, unknown> = {
        type: 'split_pane',
        pane_id: action.paneId, // pane id — not translated
        dir: action.dir,
        side: action.side,
        window_id,
      };
      // moveTabId is a TAB id (the tab being carried into the new pane) —
      // same translation requirement as move_tab.tabId, even though it
      // isn't itself a top-level op field.
      if (action.moveTabId !== undefined) op.move_tab_id = id(action.moveTabId);
      return op;
    }
    case 'resize_split':
      return { type: 'resize_split', split_id: action.splitId, ratio: action.ratio, window_id }; // split id — not translated
    case 'set_active':
      return { type: 'set_active', pane_id: action.paneId, tab_id: id(action.tabId), window_id }; // pane_id not translated
    case 'focus_pane':
      return { type: 'focus_pane', pane_id: action.paneId, window_id }; // pane id — not translated
    case 'rename_tab':
      return { type: 'rename_tab', old_id: id(action.oldId), new_id: id(action.newId), window_id };
    case 'hydrate':
      // Frontend-only (Phase 2 Task 6 restore-on-boot) — App.tsx dispatches
      // it via raw `dispatchLayout`, never through the mirrored
      // `dispatchWorkspace` path, so this must never actually be reached.
      throw new Error('hydrate is frontend-only and must never be mirrored to workspace_apply');
  }
}

export interface UpdateTabStatePatch {
  lastQuery?: unknown;
  lastAggregate?: unknown;
  builderState?: unknown;
}

const DEBOUNCE_MS = 500;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingPatches = new Map<string, UpdateTabStatePatch>();

function flushUpdateTabState(tabId: string): void {
  debounceTimers.delete(tabId);
  const patch = pendingPatches.get(tabId);
  pendingPatches.delete(tabId);
  if (!patch) return;

  const op: Record<string, unknown> = { type: 'update_tab_state', tab_id: tabId };
  if ('lastQuery' in patch) op.last_query = patch.lastQuery;
  if ('lastAggregate' in patch) op.last_aggregate = patch.lastAggregate;
  if ('builderState' in patch) op.builder_state = patch.builderState;
  workspaceApply(op);
}

/**
 * Queue an `update_tab_state` mirror for `tabId`, debounced 500ms per tab.
 * Repeated calls for the same tab within the window merge their patches
 * (later fields win) and reset the timer, so a burst of keystrokes/builder
 * edits collapses into a single backend write. Pass `null` (not omit) for a
 * field to explicitly clear it server-side — omitting a key leaves the
 * backend's current value untouched.
 */
export function updateTabState(tabId: string, patch: UpdateTabStatePatch): void {
  const merged = { ...(pendingPatches.get(tabId) ?? {}), ...patch };
  pendingPatches.set(tabId, merged);

  const existing = debounceTimers.get(tabId);
  if (existing !== undefined) clearTimeout(existing);
  debounceTimers.set(
    tabId,
    setTimeout(() => flushUpdateTabState(tabId), DEBOUNCE_MS)
  );
}

/** Test-only: flush and clear all pending debounced updateTabState timers. */
export function resetUpdateTabStateDebounce(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  pendingPatches.clear();
}
