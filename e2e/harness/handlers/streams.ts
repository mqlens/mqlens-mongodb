// Change streams behind the Watch tab (#396).
//
// The app starts a stream and polls it. A test adds events to the streams in
// the fake backend's state; a poll hands over those after the sequence number
// the app last saw, unless the stream is paused.
import type { Backend, Handler } from '../backend';
import { isMock } from '../lookup';
import type { ChangeStream, E2EState } from '../state';

/** Events a stream keeps, and bytes of their bodies (`BUFFER_CAP` and `BUFFER_BYTES` in src-tauri/src/change_streams.rs). */
const BUFFER_CAP = 1_000;
const BUFFER_BYTES = 16 * 1024 * 1024;

const utf8 = new TextEncoder();

/** An event's body size as `measure_event` takes it: its documents as JSON, and each removed field's name. */
function measureEvent(event: Record<string, unknown>): number {
  const json = (value: unknown) => (value === undefined ? 0 : utf8.encode(JSON.stringify(value)).length);
  const removed = ((event.removedFields as string[] | undefined) ?? []).reduce((sum, name) => sum + utf8.encode(name).length + 3, 0);
  return json(event.fullDocument) + json(event.updatedFields) + json(event.documentKey) + removed;
}

/**
 * Bring a stream's buffer within the backend's bounds (`push_event_bounded`).
 * An event outside the stream's operation filter never reaches the buffer, since
 * the server applies the filter. Past 1,000 events or 16 MiB of bodies,
 * whichever comes first, the oldest are evicted and counted in `dropped`, and
 * the newest stays even when it alone is over the byte limit. Tests add events
 * straight to the state, so this runs when the app reads the stream; evicting
 * from the front leaves the same buffer as evicting on every push would.
 */
function bound(stream: ChangeStream): void {
  if (stream.operationTypes.length > 0) {
    stream.events = stream.events.filter((event) => stream.operationTypes.includes(String(event.operationType)));
  }
  for (const event of stream.events) event.bytes ??= measureEvent(event);
  let bytes = stream.events.reduce((sum, event) => sum + Number(event.bytes), 0);
  while (stream.events.length > BUFFER_CAP || (bytes > BUFFER_BYTES && stream.events.length > 1)) {
    const evicted = stream.events.shift();
    bytes -= Number(evicted?.bytes ?? 0);
    stream.dropped += 1;
  }
}

export function registerStreamHandlers(backend: Backend, state: E2EState): void {
  const setStatus = (streamId: unknown, status: string) => {
    const stream = state.changeStreams[String(streamId)];
    if (stream) stream.status = status;
    return null;
  };

  const handlers: Record<string, Handler> = {
    describe_change_stream: ({ streamId }) => {
      const stream = state.changeStreams[String(streamId)];
      if (!stream) return null;
      const { connectionId, database, collection, operationTypes, status } = stream;
      return structuredClone({ connectionId, database, collection, operationTypes, status });
    },
    start_change_stream: ({ streamId, connectionId, database, collection, operationTypes }) => {
      if (!state.connections[String(connectionId)]) throw `Connection not found: ${String(connectionId)}`;
      // The backend has no client to open a stream on for the sample server.
      if (isMock(state, connectionId)) throw `connection ${String(connectionId)} is not open`;
      const orNull = (name: unknown) => (name == null || String(name).trim() === '' ? null : String(name));
      const wanted = {
        connectionId: String(connectionId),
        database: orNull(database),
        collection: orNull(collection),
        operationTypes: [...((operationTypes as string[] | undefined) ?? [])],
      };
      const previous = state.changeStreams[String(streamId)];
      // A remount isn't a restart: an identical start adopts the stream as it is,
      // its buffered events and a paused status included.
      if (
        previous &&
        previous.connectionId === wanted.connectionId &&
        previous.database === wanted.database &&
        previous.collection === wanted.collection &&
        JSON.stringify(previous.operationTypes) === JSON.stringify(wanted.operationTypes)
      ) {
        return null;
      }
      state.changeStreams[String(streamId)] = {
        ...wanted,
        // Other filters rebuild the stream: an empty buffer with nothing dropped yet,
        // numbering carried on where the last stream stopped, and a paused stream left paused.
        status: previous?.status === 'paused' ? 'paused' : 'running',
        lastSeq: previous?.lastSeq ?? 0,
        events: [],
        dropped: 0,
      };
      return null;
    },
    poll_change_stream: ({ streamId, afterSeq }) => {
      const stream = state.changeStreams[String(streamId)];
      if (!stream) return null;
      bound(stream);
      const after = typeof afterSeq === 'number' ? afterSeq : 0;
      const events = stream.status === 'paused' ? [] : stream.events.filter((event) => Number(event.seq) > after);
      // `dropped` is cumulative, so the Watch view can tell whether more were lost since it last said so.
      return { events: structuredClone(events), status: stream.status, error: null, dropped: stream.dropped, lastSeq: stream.lastSeq };
    },
    pause_change_stream: ({ streamId }) => setStatus(streamId, 'paused'),
    resume_change_stream: ({ streamId }) => setStatus(streamId, 'running'),
    // Also called for every closed tab, whether or not it ran a stream.
    stop_change_stream: ({ streamId }) => {
      delete state.changeStreams[String(streamId)];
      return null;
    },
  };

  backend.register(handlers);
}
