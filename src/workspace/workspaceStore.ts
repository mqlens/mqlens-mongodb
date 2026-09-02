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
export function workspaceApply(op: Record<string, unknown>): Promise<boolean> {
  // Resolves to whether the write landed, rather than rejecting. Most callers
  // are fire-and-forget and ignore the result, so a rejection here would be an
  // unhandled one — but a caller that must not race the write needs to know it
  // happened at all: a cross-window move that proceeds on a failed flush reads
  // a stale model, which either drops the newest draft or brings back an editor
  // whose insert already succeeded, ready to write the document twice
  // (#326 review). Reporting it as a value keeps both callers honest.
  return invoke('workspace_apply', { op, origin: windowLabel() })
    .then(() => true)
    .catch((err) => {
      console.warn('workspace_apply failed', err);
      return false;
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

/**
 * Subscribe to the backend's `ai-providers-changed` broadcast, fired after every
 * settings write. Same shape/contract as `subscribeWorkspaceChanged`.
 *
 * No payload: the listener re-reads `ai_provider_options`, which resolves the
 * default and the per-provider `usesModel` flag backend-side. Sending the list
 * would put a second, differently-shaped copy of that logic on the wire.
 */
export function subscribeAiProvidersChanged(listener: () => void): Promise<UnlistenFn> {
  return listen('ai-providers-changed', () => listener());
}

/** A write MQLens's own agent has asked to make, awaiting the user's answer. */
export interface McpWriteRequest {
  id: string;
  tool: string;
  summary: string;
  /**
   * The run that asked, or `null` when MQLens cannot tell — an external MCP
   * client with no run of its own, or two runs at once. A named run is shown only
   * by the panel that started it; an unnamed one may be answered anywhere, since
   * it is the app asking its user rather than a conversation asking.
   */
  requester: string | null;
}

/**
 * Subscribe to writes MQLens's own agent asks for.
 *
 * The tool call is parked in the backend until `mcp_resolve_write` carries an
 * answer back, and refuses on its own after two minutes — so a missed event
 * costs a refusal, never an unintended write.
 *
 * Every webview receives it: that is what `emit` does. The request carries the id
 * of the panel that asked, and panels ignore the rest — deterministic in a way
 * that picking the right `EventTarget` variant is not, and able to tell apart two
 * panes of one window, which a window label cannot.
 */
export function subscribeMcpWriteRequest(
  listener: (request: McpWriteRequest) => void
): Promise<UnlistenFn> {
  return listen<McpWriteRequest>('mcp-write-request', (event) => listener(event.payload));
}

/**
 * Subscribe to a request the backend has finished with, however it ended.
 *
 * The request goes to every webview but is answered in one, so the others held a
 * prompt that had already been decided — and since a panel shows the oldest
 * first, that dead prompt hid live ones behind it. Emitted for a refusal and a
 * timeout too, so this clears them rather than waiting out the local TTL.
 */
export function subscribeMcpWriteSettled(
  listener: (id: string) => void
): Promise<UnlistenFn> {
  return listen<{ id: string }>('mcp-write-settled', (event) => listener(event.payload.id));
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
  /** The tab's unsaved document edit, or `null` once it is over.
   *
   *  Mirrored because a tab moved to another window is materialized from the
   *  backend's copy — so an edit that never reached it is an edit the move
   *  discards (#326 review). `null` rather than omitted on close: absent means
   *  "untouched", which would leave a finished draft on the model. */
  documentEdit?: unknown;
}

const DEBOUNCE_MS = 500;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingPatches = new Map<string, UpdateTabStatePatch>();
/**
 * What is still owed to the backend for one tab.
 *
 * Every write naming a tab goes through here, and they run one at a time in
 * the order they were issued. That ordering is the point. A tab's writes reach
 * a store that also serves other windows, and the interesting ops — a move, a
 * detach, a close — read it as it stands the moment they arrive, so two writes
 * for the same tab overtaking each other is the difference between carrying a
 * draft and carrying the one before it.
 *
 * Tracking a single outstanding write was not enough twice over: a second one
 * replaced the first's record, and a close could not see either (#326 review).
 * A chain has no such gaps — `tail` is everything outstanding, and
 * `documentEdits` counts how many of those carry a draft, which is what
 * decides whether a move may go now.
 */
interface TabWrites {
  tail: Promise<boolean>;
  documentEdits: number;
}
const tabWrites = new Map<string, TabWrites>();
/** Bumped when a tab closes, so a write issued before it cannot re-queue after. */
const tabGenerations = new Map<string, number>();

const generationOf = (tabId: string) => tabGenerations.get(tabId) ?? 0;

/**
 * Run `send` once every write already issued for these tabs has settled, and
 * count it as outstanding until it settles itself.
 *
 * `tabIds` is a list because a `close_many` names several at once: it has to
 * follow each of their queues, and each of them has to follow it.
 */
function chainTabWrites(
  tabIds: string[],
  send: () => Promise<boolean>,
  carriesDocumentEdit = false
): Promise<boolean> {
  const settle = (landed: boolean) => {
    for (const id of tabIds) {
      const entry = tabWrites.get(id);
      if (!entry) continue;
      if (carriesDocumentEdit) entry.documentEdits -= 1;
      // Only the last write out clears the tab: an earlier one settling says
      // nothing about the ones still behind it.
      if (entry.tail === done) tabWrites.delete(id);
    }
    return landed;
  };
  const priors = tabIds
    .map((id) => tabWrites.get(id)?.tail)
    .filter((tail): tail is Promise<boolean> => tail !== undefined);
  // Nothing outstanding means nothing to order behind, so the write goes now.
  // Waiting on an already-resolved promise would still cost a turn of the
  // microtask queue, which is a behaviour change for every write in the app to
  // buy ordering only some of them need.
  const done: Promise<boolean> =
    priors.length === 0 ? send().then(settle) : Promise.all(priors).then(send).then(settle);
  for (const id of tabIds) {
    const entry = tabWrites.get(id);
    tabWrites.set(id, {
      tail: done,
      documentEdits: (entry?.documentEdits ?? 0) + (carriesDocumentEdit ? 1 : 0),
    });
  }
  return done;
}

/**
 * Mirror one op that names tabs, ordered against everything else for them.
 *
 * Used for the ops that create and destroy tab models — a close must not
 * overtake a draft still on its way, and the reopen that follows must not
 * overtake the close (#326 review). Ordering only within a tab; ops for
 * different tabs still run concurrently.
 */
export function applyTabOp(tabIds: string[], op: Record<string, unknown>): Promise<boolean> {
  return chainTabWrites(tabIds, () => workspaceApply(op));
}

function flushUpdateTabState(tabId: string): Promise<boolean> {
  debounceTimers.delete(tabId);
  const patch = pendingPatches.get(tabId);
  pendingPatches.delete(tabId);
  if (!patch) return tabWrites.get(tabId)?.tail ?? Promise.resolve(true);

  const op: Record<string, unknown> = { type: 'update_tab_state', tab_id: tabId };
  if ('lastQuery' in patch) op.last_query = patch.lastQuery;
  if ('lastAggregate' in patch) op.last_aggregate = patch.lastAggregate;
  if ('builderState' in patch) op.builder_state = patch.builderState;
  if ('documentEdit' in patch) op.document_edit = patch.documentEdit;
  const issuedAt = generationOf(tabId);
  return chainTabWrites(
    [tabId],
    () =>
      workspaceApply(op).then((landed) => {
        // A failed write leaves the patch pending, not spent. Dropping it made
        // the next attempt look clean: nothing queued, so a flush would report
        // success without writing, and a move would go ahead on the same stale
        // model the first attempt refused to move against (#326 review).
        //
        // Unless the tab closed while this was away — then the patch describes
        // a model that no longer exists, and re-queueing it would leave a draft
        // waiting to attach itself to the next tab given the same id.
        //
        // Anything queued since is newer and wins; the restored fields fill
        // only what nobody has spoken for.
        if (!landed && generationOf(tabId) === issuedAt) {
          pendingPatches.set(tabId, { ...patch, ...(pendingPatches.get(tabId) ?? {}) });
        }
        return landed;
      }),
    'documentEdit' in patch
  );
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

/**
 * Send `tabId`'s pending patch now instead of when its timer fires.
 *
 * The debounce assumes nothing is racing it. A cross-window move is: it is
 * backend-authoritative and issued immediately, so the destination reads the
 * tab as the backend has it at that instant. Detach right after opening an
 * editor, or move right after typing, and the snapshot the destination sees
 * predates the draft — and the flush that follows is not a cross-window op, so
 * the destination never reconciles it (#326 review). Callers about to issue a
 * move or a detach flush first, so what travels is what is on screen.
 */
export async function flushTabState(tabId: string): Promise<boolean> {
  // Repeats because the wait is a gap: a keystroke during it queues a patch
  // behind the one being sent. Each pass sends what is queued and waits for
  // everything outstanding; it returns when a pass finds neither.
  for (let pass = 0; pass < 8; pass++) {
    const timer = debounceTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    // A write that did not land ends this: the patch stays pending, and
    // whether to try again is the caller's call, not a loop's.
    if (!(await flushUpdateTabState(tabId))) return false;
    const outstanding = tabWrites.get(tabId);
    if (outstanding && !(await outstanding.tail)) return false;
    if (!pendingPatches.has(tabId) && !tabWrites.has(tabId)) return true;
  }
  // Still not settled after eight rounds. Reporting failure is the honest
  // answer: the caller's whole reason for asking is that it must not act on a
  // model it cannot vouch for.
  return false;
}

/**
 * Drop `tabId`'s pending patch without sending it.
 *
 * Tab ids are deterministic, so closing a tab and reopening the same
 * collection produces the same id. A draft still inside the debounce would
 * then land on the newly created model — an editor the user closed,
 * reattached to a tab that never had one, waiting for the next restart or
 * move to bring it back (#326 review). A patch for a tab that is gone
 * describes nothing, so it goes with it.
 */
/**
 * Whether `tabId` has a document-edit change still waiting in the debounce.
 *
 * Asked before a cross-window move, which must not overtake it. A cancelled
 * edit queues `document_edit: null` and is gone from the tab immediately, so
 * "does this tab have an edit" is the wrong question at that moment — the tab
 * has none while the backend still holds the draft the move would carry
 * (#326 review). Only this field is asked about: the others have no ordering
 * requirement against a move, and flushing them would put a write in front of
 * every move that never used to be there.
 */
export function hasPendingDocumentEdit(tabId: string): boolean {
  const patch = pendingPatches.get(tabId);
  if (patch && 'documentEdit' in patch) return true;
  // Outstanding counts as pending: a write has left the queue but the backend
  // does not have it yet, which is exactly the interval a move must not slip
  // through. Counted rather than flagged, because several can overlap and the
  // last to settle is not necessarily the one carrying a draft (#326 review).
  return (tabWrites.get(tabId)?.documentEdits ?? 0) > 0;
}

/**
 * Move `oldId`'s queued patch onto `newId`, because its tab just became that.
 *
 * A patch restored after a failed write is keyed by the id it was sent with.
 * Rename the collection and that id is free again — recreate the namespace,
 * reopen the tab, and the deterministic id comes back with a stale draft still
 * queued against it, waiting for the next flush to put a renamed tab's text on
 * a model that never had it (#326 review). The patch belongs to the tab, so it
 * follows the tab.
 *
 * The old id's generation is bumped as well: a write still out under it must
 * not restore itself there on failure, now that nothing is that tab any more.
 */
export function renameTabState(oldId: string, newId: string): void {
  const timer = debounceTimers.get(oldId);
  if (timer !== undefined) clearTimeout(timer);
  debounceTimers.delete(oldId);

  const patch = pendingPatches.get(oldId);
  pendingPatches.delete(oldId);
  tabGenerations.set(oldId, generationOf(oldId) + 1);
  if (!patch) return;

  // Anything already queued under the new id is newer and wins.
  pendingPatches.set(newId, { ...patch, ...(pendingPatches.get(newId) ?? {}) });
  if (!debounceTimers.has(newId)) {
    debounceTimers.set(newId, setTimeout(() => flushUpdateTabState(newId), DEBOUNCE_MS));
  }
}

export function cancelTabState(tabIds: string | string[]): void {
  for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
    const timer = debounceTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.delete(tabId);
    pendingPatches.delete(tabId);
    // A write already on its way cannot be recalled, but it can be disowned:
    // past this generation its failure does not re-queue it, so it cannot come
    // back to attach a dead tab's draft to the next tab given the same id. The
    // close op itself is chained behind it, so the model it may land on is
    // removed immediately afterwards (#326 review).
    tabGenerations.set(tabId, generationOf(tabId) + 1);
  }
}

/** Test-only: flush and clear all pending debounced updateTabState timers. */
export function resetUpdateTabStateDebounce(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  pendingPatches.clear();
  tabWrites.clear();
  tabGenerations.clear();
}
