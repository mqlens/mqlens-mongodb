/**
 * In-flight AI Helper requests, held outside the React tree.
 *
 * Inactive tabs are unmounted (PaneView renders only `pane.activeTabId`), so a
 * request started in AIChatPanel used to die with the component: the awaited
 * `invoke` still completed, but `setChatMessages` on an unmounted component is
 * a silent no-op and the effect that mirrors messages into App's tab cache
 * never fired. The user's question was cached, the assistant's reply was
 * discarded, and the tab came back showing a question with no answer, no
 * spinner and no error — with the API call already paid for.
 *
 * Keeping the promise here instead means the request outlives the unmount. The
 * panel re-attaches to it on remount, or picks up an already-settled reply that
 * landed while it was gone.
 *
 * Session-local by design: this mirrors App's `tabChatCache`, which is also not
 * part of the persisted workspace snapshot.
 */

/** An assistant reply, minus its id — the id is assigned by the panel when it
 *  appends the message, because the id counter is panel-local. */
export interface PendingChatReply {
  text: string;
  query?: unknown;
  error?: boolean;
}

interface PendingChat {
  promise: Promise<PendingChatReply>;
  /** Set once the promise settles; cleared when a panel consumes it. */
  settled?: PendingChatReply;
}

// Survives Vite hot module replacement for the same reason the shell session
// registry does: a fresh Map would strand an in-flight request, and the reply
// would have nowhere to land. No effect in a packaged build.
const pending: Map<string, PendingChat> =
  import.meta.hot?.data?.pendingChat ?? new Map<string, PendingChat>();
// `data` is absent under vitest, where `import.meta.hot` exists but is inert.
if (import.meta.hot?.data) import.meta.hot.data.pendingChat = pending;

/**
 * Run `task` as the pending request for `key`. The returned promise never
 * rejects — a failure is delivered as a reply with `error: true`, so callers
 * have a single path and an unconsumed rejection can never become an unhandled
 * rejection while no panel is mounted.
 */
export function startChatRequest(
  key: string,
  task: () => Promise<PendingChatReply>,
): Promise<PendingChatReply> {
  const promise = task().catch((err): PendingChatReply => ({
    text: String(err),
    error: true,
  }));
  const entry: PendingChat = { promise };
  pending.set(key, entry);
  void promise.then((reply) => {
    // Only record it if this entry is still the current one for the key; a
    // newer request must not be overwritten by an older one settling late.
    if (pending.get(key) === entry) entry.settled = reply;
  });
  return promise;
}

/** The live promise for `key` while it is still running, else undefined. */
export function getPendingChatRequest(key: string): Promise<PendingChatReply> | undefined {
  const entry = pending.get(key);
  return entry && entry.settled === undefined ? entry.promise : undefined;
}

/** A reply that settled while no panel was mounted. Removes it — a reply is
 *  consumed exactly once, so remounting twice cannot duplicate a message. */
export function takeSettledChatRequest(key: string): PendingChatReply | undefined {
  const entry = pending.get(key);
  if (!entry?.settled) return undefined;
  pending.delete(key);
  return entry.settled;
}

/** Follow a tab that was rebound to a new id (App's rebindProfileTabs), so an
 *  in-flight reply is not orphaned by the rename — dropping it here would
 *  reintroduce exactly the loss this module exists to prevent. */
export function renameChatRequest(oldKey: string, newKey: string): void {
  const entry = pending.get(oldKey);
  if (!entry) return;
  pending.delete(oldKey);
  pending.set(newKey, entry);
}

/** Drop any request state for `key` — used when its tab closes. */
export function clearChatRequest(key: string): void {
  pending.delete(key);
}

/** Test seam: forget everything. */
export function resetChatRequests(): void {
  pending.clear();
}
