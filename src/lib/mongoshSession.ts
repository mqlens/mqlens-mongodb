import { invoke } from '@tauri-apps/api/core';
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

/** Write-through to the backend. Fire-and-forget: the cache is already updated,
 *  and a failed mirror must never break the shell. */
function persist(key: string, session: ShellSession): void {
  void invoke('set_shell_tab_state', { tabId: key, value: session }).catch(() => undefined);
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

/** Create or update the stored session. Merges, so a caller can persist one
 *  field without knowing the rest. */
export function writeShellSession(key: string, patch: Partial<ShellSession>): void {
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
  const session = sessions.get(key);
  if (!session?.sessionId) return;
  const { sessionId } = session;
  writeShellSession(key, { sessionId: null });
  await invoke('stop_mongosh_session', { sessionId }).catch(() => undefined);
}

/** Follow a tab that was rebound to a new id (App's rebindProfileTabs). The
 *  session belongs to the tab, so it has to move with it — leaving it under the
 *  dead id would strand a live mongosh process that nothing can stop, and the
 *  rebound tab would start a second one. */
export function renameShellSession(oldKey: string, newKey: string): void {
  void invoke('rename_shell_tab_state', { oldId: oldKey, newId: newKey }).catch(() => undefined);
  const session = sessions.get(oldKey);
  if (!session) return;
  sessions.delete(oldKey);
  sessions.set(newKey, session);
}

/** Dispose every session — used when the whole workspace is torn down. */
export async function disposeAllShellSessions(): Promise<void> {
  await Promise.all(Array.from(sessions.keys(), disposeShellSession));
}

/** Test seam: forget everything without touching the backend. */
export function resetShellSessions(): void {
  sessions.clear();
}

/** Forget every tab, in the cache and the backend. */
export async function disposeAllShellTabState(): Promise<void> {
  sessions.clear();
  await invoke('clear_all_shell_tab_state').catch(() => undefined);
}
