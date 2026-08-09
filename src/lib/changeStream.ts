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
  atMs: number;
}

export type StreamStatus = 'starting' | 'running' | 'paused' | 'unsupported' | 'error';

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
    database: opts.database ?? null,
    collection: opts.collection ?? null,
    operationTypes: opts.operationTypes,
  });
}

/**
 * Ask for everything after `afterSeq`.
 *
 * Never rejects: a tail that throws on a transient poll would tear down the
 * view over something the next poll fixes. A failure reads as "nothing new, no
 * status change", which the caller renders as-is.
 */
export async function pollChangeStream(
  streamId: string,
  afterSeq?: number
): Promise<StreamPoll | undefined> {
  return invoke<StreamPoll>('poll_change_stream', {
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
 * Merge a poll into what is on screen, keeping the newest `cap`.
 *
 * The backend caps its own buffer, but a tab left open for hours accumulates
 * far more than the backend ever held at once, so the view needs its own bound.
 * Pure, because "the list stays bounded and in order" is the one behaviour a
 * tail viewer cannot get wrong.
 */
export function mergeEvents(
  current: ChangeEvent[],
  incoming: ChangeEvent[],
  cap: number
): ChangeEvent[] {
  if (incoming.length === 0) return current;
  // Newest first: a tail is read from the top, and prepending keeps the thing
  // the user is watching where their eyes already are.
  const next = [...incoming].sort((a, b) => b.seq - a.seq).concat(current);
  return next.length > cap ? next.slice(0, cap) : next;
}

/** A one-line summary for the event list. The full body goes to the viewer. */
export function describeEvent(event: ChangeEvent): string {
  const key = event.documentKey as { _id?: unknown } | undefined;
  const id = key && '_id' in key ? String((key as { _id: unknown })._id) : undefined;
  const ns = event.collection ? `${event.database}.${event.collection}` : event.database;
  return id ? `${ns} · ${id}` : ns;
}
