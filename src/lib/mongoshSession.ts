import { invoke } from '@tauri-apps/api/core';

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
}

const sessions = new Map<string, ShellSession>();

export function readShellSession(key: string): ShellSession | undefined {
  return sessions.get(key);
}

/** Create or update the stored session. Merges, so a caller can persist one
 *  field without knowing the rest. */
export function writeShellSession(key: string, patch: Partial<ShellSession>): void {
  const prev = sessions.get(key);
  sessions.set(key, {
    sessionId: patch.sessionId !== undefined ? patch.sessionId : (prev?.sessionId ?? null),
    entries: patch.entries ?? prev?.entries ?? [],
    currentDb: patch.currentDb ?? prev?.currentDb ?? '',
    autoRanCommand: patch.autoRanCommand ?? prev?.autoRanCommand ?? false,
  });
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
  const session = sessions.get(key);
  sessions.delete(key);
  if (!session?.sessionId) return;
  await invoke('stop_mongosh_session', { sessionId: session.sessionId }).catch(() => undefined);
}

/** Follow a tab that was rebound to a new id (App's rebindProfileTabs). The
 *  session belongs to the tab, so it has to move with it — leaving it under the
 *  dead id would strand a live mongosh process that nothing can stop, and the
 *  rebound tab would start a second one. */
export function renameShellSession(oldKey: string, newKey: string): void {
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
