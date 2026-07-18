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
