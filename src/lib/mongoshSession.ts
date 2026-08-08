import { invoke } from '@tauri-apps/api/core';
import { windowLabel } from '../workspace/workspaceStore';
import type { ChatMessage } from '../components/AIChatPanel';

/**
 * Live mongosh sessions and their transcripts, held outside the React tree.
 *
 * Inactive tabs are unmounted (PaneView renders only `pane.activeTabId`), and
 * MongoShell used to stop its mongosh session in an effect cleanup — so
 * glancing at another tab killed the user's shell process and threw away the
 * whole scrollback. Coming back spawned a fresh session with an empty
 * transcript (#240).
 *
 * A session is an OS process, not view state: its lifetime belongs to the tab,
 * not to whether that tab happens to be the one on screen. Keeping it here
 * means unmounting is free and `disposeShellSession` — called when the tab
 * actually closes — is the single place a session ends.
 *
 * Session-local by design, like `tabChatCache`: not part of the persisted
 * workspace snapshot, since a mongosh process cannot outlive the app anyway.
 */

export type ShellEntry =
  | { kind: 'input'; db: string; text: string }
  | { kind: 'text'; lines: string[] }
  | { kind: 'value'; value: unknown }
  | { kind: 'note'; text: string }
  | { kind: 'error'; message: string };

export interface ShellSession {
  /** Backend session id, or null when no session is currently attached. */
  sessionId: string | null;
  /** Console scrollback, including the startup banner. */
  entries: ShellEntry[];
  /** `use <db>` follows the session, so it has to survive with it. */
  currentDb: string;
  /** Whether the command that opened this tab has already been auto-run. Lives
   *  here rather than in a component ref because a ref resets on every mount:
   *  once the transcript started surviving tab switches, the re-runs became
   *  visible as the same command executing again on every switch. */
  autoRanCommand: boolean;
  /** The shell's AI helper, which unmounts with the tab exactly like the chat
   *  in DocumentViewer does — it just never got the same treatment, so the
   *  panel collapsed and its transcript vanished on every tab switch. */
  aiOpen: boolean;
  aiMessages: ChatMessage[];
}

/**
 * In-memory cache over the BACKEND's per-tab store.
 *
 * The backend is the source of truth (`get/set_shell_tab_state`), because
 * renderer state does not survive a Vite hot reload or a window refresh: the
 * map came back empty, the tab concluded it had no session and started a second
 * one, and the original mongosh child was orphaned with no id left to stop it.
 * The backend already owns those children.
 *
 * This cache exists only so the common case stays synchronous — a mounted
 * component can seed itself without waiting on IPC. After a hot reload it is
 * empty and `loadShellSession` refills it from the backend.
 */
const sessions: Map<string, ShellSession> =
  import.meta.hot?.data?.shellSessions ?? new Map<string, ShellSession>();
// Reuse the same instance across hot replacements too, so the common path does
// not even need the backend round trip during development.
if (import.meta.hot?.data) import.meta.hot.data.shellSessions = sessions;

/**
 * Per-key write epoch: how many times THIS renderer has stopped owning a key.
 *
 * A command can still be in flight when its tab is closed or moved to another
 * window, and the unmounted component goes on to persist the result — writing a
 * transcript built from its own stale snapshot. After a close that resurrects
 * the session the tab just discarded (deterministic tab ids mean reopening
 * lands on the same key, inheriting the old scrollback and `autoRanCommand`);
 * after a move it clobbers the destination window's newer state and, because
 * every write stamps the owning window, quietly steals ownership back — so
 * closing the source window would then kill a process the destination is
 * showing.
 *
 * A component captures the epoch when it mounts and passes it with every write.
 * `disposeShellSession` and `forgetShellSession` bump it, which silences that
 * component for good without disturbing whoever legitimately owns the key now.
 */
const epochs: Map<string, number> = import.meta.hot?.data?.shellEpochs ?? new Map<string, number>();
if (import.meta.hot?.data) import.meta.hot.data.shellEpochs = epochs;

/** The current write epoch for `key`. Capture this at mount; pass it to
 *  {@link writeShellSession} so writes that outlive ownership are dropped. */
export function shellSessionEpoch(key: string): number {
  return epochs.get(key) ?? 0;
}

function endEpoch(key: string): number {
  const next = shellSessionEpoch(key) + 1;
  epochs.set(key, next);
  return next;
}

/**
 * The epoch at which a key was last DISPOSED, as opposed to merely forgotten.
 *
 * Both end an epoch, but they mean opposite things for the mongosh child: a
 * disposed tab's child should die, a moved tab's child belongs to another
 * window now and must not be touched. Only the async start path needs to tell
 * them apart — see {@link wasDisposedSince}.
 */
const disposedAt: Map<string, number> =
  import.meta.hot?.data?.shellDisposedAt ?? new Map<string, number>();
if (import.meta.hot?.data) import.meta.hot.data.shellDisposedAt = disposedAt;

/** Whether this key was closed outright after `epoch` — i.e. whether a caller
 *  holding `epoch` is finishing work for a tab that no longer exists. False for
 *  a tab that merely moved to another window. */
export function wasDisposedSince(key: string, epoch: number): boolean {
  const at = disposedAt.get(key);
  return at !== undefined && at > epoch;
}

/** Write-through to the backend. Fire-and-forget: the cache is already updated,
 *  and a failed mirror must never break the shell. */
function persist(key: string, session: ShellSession): void {
  void invoke('set_shell_tab_state', {
    tabId: key,
    // Stamp the owning window. Closing a secondary window with its OS button
    // runs no frontend code, so the backend has to clean up that window's
    // shells itself — and it cannot do that by looking up the workspace's tab
    // ids, which are PROFILE-space while these keys are LIVE-space (a tab
    // rebound to a connection is re-keyed by `renameShellSession`, so the
    // lookup misses and the child survives the window). Recording ownership
    // here sidesteps the id-space mismatch entirely.
    value: { ...session, windowId: windowLabel() },
  }).catch(() => undefined);
}

/**
 * Read a tab's state from the backend, populating the cache.
 *
 * Callers use this when {@link readShellSession} misses — after a hot reload or
 * a refresh, when the cache is empty but a mongosh child is still running and
 * must be reattached rather than duplicated.
 */
export async function loadShellSession(key: string): Promise<ShellSession | undefined> {
  const cached = sessions.get(key);
  if (cached) return cached;
  const stored = await invoke<unknown>('get_shell_tab_state', { tabId: key }).catch(() => null);
  // Shape-check rather than trust: this crosses the IPC boundary, and a value
  // that is merely truthy (an array, say) would otherwise be cached as a
  // session and read for fields it does not have.
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const candidate = stored as Partial<ShellSession>;
  const session: ShellSession = {
    sessionId: candidate.sessionId ?? null,
    entries: Array.isArray(candidate.entries) ? candidate.entries : [],
    currentDb: candidate.currentDb ?? '',
    autoRanCommand: candidate.autoRanCommand ?? false,
    aiOpen: candidate.aiOpen ?? false,
    aiMessages: Array.isArray(candidate.aiMessages) ? candidate.aiMessages : [],
  };
  sessions.set(key, session);
  return session;
}

export function readShellSession(key: string): ShellSession | undefined {
  return sessions.get(key);
}

/**
 * Create or update the stored session. Merges, so a caller can persist one
 * field without knowing the rest.
 *
 * `epoch` is the value {@link shellSessionEpoch} returned when the writer
 * mounted. A mismatch means the writer no longer owns this key — its tab was
 * closed or moved to another window while a command was in flight — and the
 * write is dropped. Omitting it writes unconditionally, which is what the
 * registry's own helpers do.
 */
export function writeShellSession(
  key: string,
  patch: Partial<ShellSession>,
  epoch?: number
): void {
  if (epoch !== undefined && epoch !== shellSessionEpoch(key)) return;
  const prev = sessions.get(key);
  const next: ShellSession = {
    sessionId: patch.sessionId !== undefined ? patch.sessionId : (prev?.sessionId ?? null),
    entries: patch.entries ?? prev?.entries ?? [],
    currentDb: patch.currentDb ?? prev?.currentDb ?? '',
    autoRanCommand: patch.autoRanCommand ?? prev?.autoRanCommand ?? false,
    aiOpen: patch.aiOpen ?? prev?.aiOpen ?? false,
    aiMessages: patch.aiMessages ?? prev?.aiMessages ?? [],
  };
  sessions.set(key, next);
  persist(key, next);
}

/**
 * End a tab's session for good: stop the backend process and forget the
 * transcript. Call this when the TAB closes, never when it merely unmounts.
 *
 * Never rejects — a session that is already gone (backend restarted, process
 * died) is still a successful disposal from the caller's point of view, and
 * tab teardown must not be able to throw.
 */
export async function disposeShellSession(key: string): Promise<void> {
  const session = sessions.get(key) ?? (await loadShellSession(key));
  disposedAt.set(key, endEpoch(key));
  sessions.delete(key);
  void invoke('clear_shell_tab_state', { tabId: key }).catch(() => undefined);
  if (!session?.sessionId) return;
  await invoke('stop_mongosh_session', { sessionId: session.sessionId }).catch(() => undefined);
}

/**
 * Stop the running process but KEEP the tab's transcript and settings, so the
 * shell can start a fresh session without losing the scrollback. This is what
 * the Restart control uses; `disposeShellSession` is for a tab going away.
 */
export async function stopShellSessionProcess(key: string): Promise<void> {
  // Hydrate on a miss, like `disposeShellSession`: after a renderer refresh the
  // tab may not have mounted yet, so its running child is known only to the
  // backend and a cache-only check would quietly decline to stop it.
  const session = sessions.get(key) ?? (await loadShellSession(key));
  if (!session?.sessionId) return;
  const { sessionId } = session;
  writeShellSession(key, { sessionId: null });
  await invoke('stop_mongosh_session', { sessionId }).catch(() => undefined);
}

/** Follow a tab that was rebound to a new id (App's rebindProfileTabs). The
 *  session belongs to the tab, so it has to move with it — leaving it under the
 *  dead id would strand a live mongosh process that nothing can stop, and the
 *  rebound tab would start a second one. */
export function renameShellSession(oldKey: string, newKey: string): Promise<void> {
  // Returns the backend move so a caller that must then READ the new key can
  // await it. Nothing guarantees a later `get_shell_tab_state` is served after
  // an unawaited rename, and losing that race would look like an absent
  // session — i.e. a live mongosh child nothing goes on to stop.
  const moved = invoke('rename_shell_tab_state', { oldId: oldKey, newId: newKey })
    .then(() => undefined)
    .catch(() => undefined);
  const session = sessions.get(oldKey);
  if (session) {
    sessions.delete(oldKey);
    sessions.set(newKey, session);
  }
  return moved;
}

/**
 * Point a retained session at a renamed database and end its process, so the
 * next mount opens a fresh one against the new name with its scrollback intact.
 *
 * `renamed` is the backend move this follows, and is awaited ONLY on a cache
 * miss — see below for why the cached path must not await anything.
 */
export function retargetShellSessionDatabase(
  key: string,
  db: string,
  renamed: Promise<void>
): Promise<void> {
  const cached = sessions.get(key);
  if (cached) {
    const { sessionId } = cached;
    // Applied synchronously, before returning to the caller. The rename's
    // `setTabs` re-keys the tab in the same discrete event, so React remounts
    // MongoShell before any await here could resolve — and the component seeds
    // itself from the registry once, at mount, without subscribing to later
    // writes. Deferring this by even a microtask therefore hands the fresh
    // instance the old database and a session id that is about to be killed:
    // it would sit on a dead process, and restarting it would `use` the
    // database the rename just dropped, recreating it on the next write.
    writeShellSession(key, { currentDb: db, sessionId: null });
    if (!sessionId) return Promise.resolve();
    return invoke('stop_mongosh_session', { sessionId })
      .then(() => undefined)
      .catch(() => undefined);
  }
  // Not cached: the tab has not mounted since a refresh, so its state lives
  // only in the backend and can only be read back once the rename has landed.
  // Nothing is mounted under this key, so there is no remount to race.
  return renamed.then(async () => {
    await loadShellSession(key);
    writeShellSession(key, { currentDb: db });
    await stopShellSessionProcess(key);
  });
}

/**
 * Dispose the sessions belonging to a specific set of tabs.
 *
 * Deliberately scoped rather than global. Both callers run per-renderer — one
 * on workspace restore, one when this window is removed by another window's op
 * — so an app-wide clear would erase the recovery mapping for live shells owned
 * by OTHER windows without stopping their children, leaving processes that can
 * no longer be reattached or killed.
 */
export async function disposeShellSessionsForTabs(tabIds: string[]): Promise<void> {
  await Promise.all(tabIds.map(disposeShellSession));
}

/**
 * Drop this renderer's copy of a tab's state WITHOUT ending the session.
 *
 * For a tab that moved to another window: the mongosh child and the backend
 * entry belong to the destination now, so they must survive, but keeping the
 * cached object here is actively wrong. If the tab ever comes back, this
 * renderer would seed from a snapshot that predates everything the other window
 * did — showing the wrong database after a `use` there, and mirroring its stale
 * transcript over the newer one. Bumping the epoch also silences any command
 * this renderer still has in flight for the key.
 */
export function forgetShellSession(key: string): void {
  endEpoch(key);
  sessions.delete(key);
}

/** Test seam: forget everything without touching the backend. */
export function resetShellSessions(): void {
  sessions.clear();
  epochs.clear();
  disposedAt.clear();
}

/** Forget every tab, in the cache and the backend. */
export async function disposeAllShellTabState(): Promise<void> {
  sessions.clear();
  await invoke('clear_all_shell_tab_state').catch(() => undefined);
}
