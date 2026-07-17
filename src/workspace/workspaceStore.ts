// Thin invoke wrappers for the backend workspace store (see
// src-tauri/src/workspace.rs) — mirrors the queryStore.ts idiom: async
// wrappers for reads, fire-and-forget for writes the caller doesn't need to
// await. Pure translation logic (id substitution, snapshot shaping) lives in
// persistence.ts; this module is the only one that touches `invoke`.

import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceAction } from './model';
import type { PersistedTab, PersistedWorkspace } from './persistence';

/** `GET workspace.json` (backend-cached after first call). */
export async function workspaceGet(): Promise<PersistedWorkspace | null> {
  return invoke<PersistedWorkspace | null>('workspace_get');
}

/**
 * Fire-and-forget apply of one op to the backend store. Never throws — the
 * mirror must never block or fail the UI action it shadows; failures are
 * logged and dropped.
 */
export function workspaceApply(op: Record<string, unknown>): void {
  invoke('workspace_apply', { op }).catch((err) => {
    console.warn('workspace_apply failed', err);
  });
}

/**
 * Translate one frontend `WorkspaceAction` (camelCase keys) into the wire-
 * shaped op `workspace_apply` expects (snake_case keys; a nested `tab`
 * payload, when present, keeps TabModel's camelCase fields as-is). `tab` is
 * only meaningful for `open_tab` — pass the already-persisted form (or
 * `null`/omit to move/focus an existing backend tab without touching its
 * stored model).
 */
export function actionToOp(
  action: WorkspaceAction,
  tab?: PersistedTab | null
): Record<string, unknown> {
  switch (action.type) {
    case 'open_tab': {
      const op: Record<string, unknown> = { type: 'open_tab', tab_id: action.tabId };
      if (action.paneId !== undefined) op.pane_id = action.paneId;
      if (tab) op.tab = tab;
      return op;
    }
    case 'close_tab':
      return { type: 'close_tab', tab_id: action.tabId };
    case 'close_many':
      return { type: 'close_many', tab_ids: action.tabIds };
    case 'move_tab': {
      const op: Record<string, unknown> = {
        type: 'move_tab',
        tab_id: action.tabId,
        target_pane_id: action.targetPaneId,
      };
      if (action.index !== undefined) op.index = action.index;
      return op;
    }
    case 'split_pane': {
      const op: Record<string, unknown> = {
        type: 'split_pane',
        pane_id: action.paneId,
        dir: action.dir,
        side: action.side,
      };
      if (action.moveTabId !== undefined) op.move_tab_id = action.moveTabId;
      return op;
    }
    case 'resize_split':
      return { type: 'resize_split', split_id: action.splitId, ratio: action.ratio };
    case 'set_active':
      return { type: 'set_active', pane_id: action.paneId, tab_id: action.tabId };
    case 'focus_pane':
      return { type: 'focus_pane', pane_id: action.paneId };
    case 'rename_tab':
      return { type: 'rename_tab', old_id: action.oldId, new_id: action.newId };
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
