import { invoke } from '@tauri-apps/api/core';

/**
 * Client for a backend change-stream tail.
 *
 * The backend owns the cursor and a bounded buffer; this polls for whatever is
 * newer than the last sequence it saw. Polling rather than listening is
 * deliberate — a busy collection outruns a renderer, and asking for "everything
 * after N" makes a missed or duplicated poll harmless where a dropped event
 * would not be.
 *
 * Nothing here is persisted: a tail is a live view, and the issue puts surviving
 * a restart out of scope.
 */

export type ChangeOperation =
  | 'insert'
  | 'update'
  | 'replace'
  | 'delete'
  | 'drop'
  | 'rename'
  | 'invalidate';

export interface ChangeEvent {
  seq: number;
  operationType: string;
  database: string;
  collection?: string;
  documentKey?: unknown;
  fullDocument?: unknown;
  updatedFields?: unknown;
  removedFields?: string[];
  /** Where a rename sent the collection; rename events carry no document. */
  renamedTo?: string;
  atMs: number;
  /** Roughly what this event's bodies weigh, measured by the backend so the
   *  view can stay bounded by memory and not only by row count. */
  bytes?: number;
}

/**
 * What the VIEW holds, in bytes.
 *
 * Smaller than the backend's buffer on purpose: the backend keeps events so a
 * poll cannot miss them, while this is what a WebView carries around for as
 * long as the tab is open.
 */
export const VIEW_BYTES = 8 * 1024 * 1024;

export type StreamStatus = 'starting' | 'running' | 'paused' | 'unsupported' | 'ended' | 'error';

export interface StreamPoll {
  events: ChangeEvent[];
  status: StreamStatus;
  error: string | null;
  dropped: number;
  lastSeq: number;
}

/** The operations a user can filter on, in the order the UI shows them. */
export const CHANGE_OPERATIONS: ChangeOperation[] = [
  'insert',
  'update',
  'replace',
  'delete',
];

export interface StartOptions {
  streamId: string;
  connectionId: string;
  /** Omit to watch the whole deployment rather than one database. */
  database?: string;
  /** Omit to watch the whole database rather than one collection. */
  collection?: string;
  operationTypes: ChangeOperation[];
}

export async function startChangeStream(opts: StartOptions): Promise<void> {
  await invoke('start_change_stream', {
    streamId: opts.streamId,
    connectionId: opts.connectionId,
    // `||`, not `??`: an empty string is how a deployment-level tab spells
    // "no database", and sending it as a name asks the driver for the
    // namespace `.$cmd.aggregate`, which the server rejects outright.
    database: opts.database || null,
    collection: opts.collection || null,
    operationTypes: opts.operationTypes,
  });
}

/** What a stream is watching, as the backend has it. */
export interface StreamInfo {
  connectionId: string;
  database: string | null;
  collection: string | null;
  operationTypes: string[];
  status: StreamStatus;
}

/**
 * What is running under this id, or `undefined` if nothing is.
 *
 * A watch tab is unmounted while inactive, so the panel's own filter state
 * comes back empty when the user returns. Starting on that empty state would
 * read as a different stream and discard the buffer, so the panel asks first
 * and adopts what is already there.
 */
export async function describeChangeStream(streamId: string): Promise<StreamInfo | undefined> {
  return invoke<StreamInfo | null>('describe_change_stream', { streamId })
    .then((info) => info ?? undefined)
    .catch(() => undefined);
}

/**
 * Ask for everything after `afterSeq`.
 *
 * Never rejects: a tail that throws on a transient poll would tear down the
 * view over something the next poll fixes. A failure reads as "nothing new, no
 * status change", which the caller renders as-is.
 *
 * `null` is different from `undefined`: it means nothing is watching under
 * that id at all. A caller that expects to be polling something is looking at
 * a stream that went away — closing a tab and reopening the same target can
 * land the old stop after the new start — and can start it again rather than
 * polling an empty id for ever.
 */
export async function pollChangeStream(
  streamId: string,
  afterSeq?: number
): Promise<StreamPoll | null | undefined> {
  return invoke<StreamPoll | null>('poll_change_stream', {
    streamId,
    afterSeq: afterSeq ?? null,
  }).catch(() => undefined);
}

export async function pauseChangeStream(streamId: string): Promise<void> {
  await invoke('pause_change_stream', { streamId }).catch(() => undefined);
}

export async function resumeChangeStream(streamId: string): Promise<void> {
  await invoke('resume_change_stream', { streamId }).catch(() => undefined);
}

export async function stopChangeStream(streamId: string): Promise<void> {
  await invoke('stop_change_stream', { streamId }).catch(() => undefined);
}

/**
 * Merge a poll into what is on screen, keeping the newest events.
 *
 * The backend caps its own buffer, but a tab left open for hours accumulates
 * far more than the backend ever held at once, so the view needs its own bound.
 * Pure, because "the list stays bounded and in order" is the one behaviour a
 * tail viewer cannot get wrong.
 *
 * Bounded by BYTES as well as by count, for the same reason the backend is: a
 * MongoDB document can approach 16 MiB, so a thousand large inserts is
 * gigabytes — and holding that in a WebView is worse than holding it in the
 * host process. Whichever limit is reached first evicts.
 */
export function mergeEvents(
  current: ChangeEvent[],
  incoming: ChangeEvent[],
  cap: number,
  maxBytes = VIEW_BYTES
): ChangeEvent[] {
  if (incoming.length === 0) return current;
  // Deduplicated by sequence. Polls are serialized at the call site, but a
  // retry or an overlapping `afterSeq` would otherwise add the same change
  // twice — and duplicate keys make React reconcile the wrong rows.
  const seen = new Set(current.map((e) => e.seq));
  const fresh = incoming.filter((e) => !seen.has(e.seq));
  if (fresh.length === 0) return current;
  // Newest first: a tail is read from the top, and prepending keeps the thing
  // the user is watching where their eyes already are.
  const next = fresh.sort((a, b) => b.seq - a.seq).concat(current);
  let bytes = 0;
  for (let i = 0; i < next.length; i += 1) {
    bytes += next[i].bytes ?? 0;
    // Past either limit, everything older goes. The newest event always
    // survives, even alone over budget — dropping what just arrived would make
    // a large-document collection look idle.
    if (i > 0 && (i + 1 > cap || bytes > maxBytes)) return next.slice(0, i);
  }
  return next;
}

/** The document's `_id` as text, when the event carries one. */
export function eventDocumentId(event: ChangeEvent): string | undefined {
  const key = event.documentKey as { _id?: unknown } | undefined;
  if (!key || typeof key !== 'object' || !('_id' in key)) return undefined;
  const id = (key as { _id: unknown })._id;
  // An ObjectId crosses IPC as `{ $oid: "..." }`; showing the wrapper would be
  // noise where the hex is the thing being scanned for.
  if (id && typeof id === 'object' && '$oid' in (id as Record<string, unknown>)) {
    return String((id as { $oid: unknown }).$oid);
  }
  return String(id);
}

/** A one-line summary. Kept for callers that want the namespace as one string;
 *  the event list renders the parts separately so they can be scanned. */
export function describeEvent(event: ChangeEvent): string {
  const id = eventDocumentId(event);
  const ns = event.collection ? `${event.database}.${event.collection}` : event.database;
  return id ? `${ns} · ${id}` : ns;
}

/** How many fields an update touched, for the event list. Undefined for
 *  operations that do not describe a change (inserts carry a whole document). */
export function changedFieldCount(event: ChangeEvent): number | undefined {
  const updated = event.updatedFields;
  const removed = event.removedFields?.length ?? 0;
  const updatedCount =
    updated && typeof updated === 'object' && !Array.isArray(updated)
      ? Object.keys(updated).length
      : 0;
  const total = updatedCount + removed;
  return total > 0 ? total : undefined;
}

/** Wall-clock time of an event as `HH:MM:SS`, which is the resolution a tail is
 *  read at — the date is almost always today and would just be noise. */
export function eventTime(event: ChangeEvent): string {
  const d = new Date(event.atMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The collections seen so far, for the filter. Derived from what has actually
 *  arrived rather than listed up front — a deployment-wide tail cannot know
 *  which collections will show up. */
export function collectionsSeen(events: ChangeEvent[]): string[] {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.collection) seen.add(`${e.database}.${e.collection}`);
  }
  return [...seen].sort();
}

/** Narrow to one namespace. Client-side on purpose: it filters what is already
 *  buffered, so switching it costs nothing and does not restart the cursor the
 *  way an operation filter must. */
export function filterByNamespace(events: ChangeEvent[], ns: string | null): ChangeEvent[] {
  if (!ns) return events;
  return events.filter((e) => e.collection && `${e.database}.${e.collection}` === ns);
}
