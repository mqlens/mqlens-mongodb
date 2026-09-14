// Change streams behind the Watch tab (#396).
//
// The app starts a stream and polls it. A test adds events to the streams in
// the fake backend's state; a poll hands over those after the sequence number
// the app last saw, unless the stream is paused.
import type { Backend, Handler } from '../backend';
import type { E2EState } from '../state';

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
      const previous = state.changeStreams[String(streamId)];
      state.changeStreams[String(streamId)] = {
        connectionId: String(connectionId),
        database: database == null ? null : String(database),
        collection: collection == null ? null : String(collection),
        operationTypes: [...((operationTypes as string[] | undefined) ?? [])],
        status: 'running',
        // A restart with other filters carries on numbering where the last stream stopped.
        lastSeq: previous?.lastSeq ?? 0,
        events: [],
      };
      return null;
    },
    poll_change_stream: ({ streamId, afterSeq }) => {
      const stream = state.changeStreams[String(streamId)];
      if (!stream) return null;
      const after = typeof afterSeq === 'number' ? afterSeq : 0;
      const events =
        stream.status === 'paused'
          ? []
          : stream.events.filter(
              (event) =>
                Number(event.seq) > after &&
                (stream.operationTypes.length === 0 || stream.operationTypes.includes(String(event.operationType))),
            );
      return { events: structuredClone(events), status: stream.status, error: null, dropped: 0, lastSeq: stream.lastSeq };
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
