import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectionsSeen,
  describeEvent,
  eventDocumentId,
  filterByNamespace,
  mergeEvents,
  pollChangeStream,
  startChangeStream,
  type ChangeEvent,
} from '../changeStream';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const event = (seq: number, extra: Partial<ChangeEvent> = {}): ChangeEvent => ({
  seq,
  operationType: 'insert',
  database: 'sales',
  collection: 'orders',
  atMs: 0,
  ...extra,
});

describe('change stream client', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  describe('merging polls into the view', () => {
    it('puts the newest first, which is where a tail is read', () => {
      const merged = mergeEvents([event(1)], [event(2), event(3)], 100);
      expect(merged.map((e) => e.seq)).toEqual([3, 2, 1]);
    });

    it('stays bounded, dropping the oldest', () => {
      // The backend caps its buffer, but a tab left open for hours accumulates
      // far more than the backend ever held at once.
      const merged = mergeEvents([event(2), event(1)], [event(3)], 2);
      expect(merged.map((e) => e.seq)).toEqual([3, 2]);
    });

    it('stays bounded by bytes too, not just by row count', () => {
      // A MongoDB document can approach 16 MiB, so a thousand large inserts is
      // gigabytes held in a WebView — a count-only cap is not a memory bound.
      const big = (seq: number) => event(seq, { bytes: 4_000 });
      const merged = mergeEvents([big(2), big(1)], [big(3)], 100, 9_000);
      expect(merged.map((e) => e.seq)).toEqual([3, 2]);
    });

    it('keeps the newest event even when it alone is over budget', () => {
      // Dropping what just arrived would make a large-document collection look
      // idle, which is worse than briefly exceeding the budget.
      const merged = mergeEvents([], [event(1, { bytes: 50_000 })], 100, 1_000);
      expect(merged.map((e) => e.seq)).toEqual([1]);
    });

    it('does not evict on size when the backend sent no measurements', () => {
      // Older backends, and any event whose bodies were all absent.
      const merged = mergeEvents([event(2), event(1)], [event(3)], 100, 10);
      expect(merged.map((e) => e.seq)).toEqual([3, 2, 1]);
    });

    it('drops events it already has, rather than duplicating rows', () => {
      // Two polls can overlap on the same `afterSeq`, and duplicate keys make
      // React reconcile the wrong rows.
      const current = [event(2), event(1)];
      expect(mergeEvents(current, [event(2), event(3)], 100).map((e) => e.seq)).toEqual([3, 2, 1]);
    });

    it('returns the same array when every incoming event is already known', () => {
      const current = [event(2), event(1)];
      expect(mergeEvents(current, [event(1)], 100)).toBe(current);
    });

    it('leaves the view untouched when a poll brings nothing', () => {
      const current = [event(1)];
      expect(mergeEvents(current, [], 10)).toBe(current);
    });

    it('orders a batch that arrives out of order', () => {
      const merged = mergeEvents([], [event(3), event(1), event(2)], 10);
      expect(merged.map((e) => e.seq)).toEqual([3, 2, 1]);
    });
  });

  describe('polling', () => {
    it('asks only for what it has not seen', async () => {
      invokeMock.mockResolvedValue({ events: [], status: 'running', error: null, dropped: 0, lastSeq: 4 });

      await pollChangeStream('s1', 4);

      expect(invokeMock).toHaveBeenCalledWith('poll_change_stream', {
        streamId: 's1',
        afterSeq: 4,
      });
    });

    it('takes everything on a first poll', async () => {
      await pollChangeStream('s1');
      expect(invokeMock).toHaveBeenCalledWith('poll_change_stream', {
        streamId: 's1',
        afterSeq: null,
      });
    });

    it('does not throw when a poll fails', async () => {
      // A tail that tears itself down over one transient failure is worse than
      // one that waits for the next tick.
      invokeMock.mockRejectedValue(new Error('backend gone'));
      await expect(pollChangeStream('s1', 1)).resolves.toBeUndefined();
    });
  });

  describe('the three levels', () => {
    it('watches one collection', async () => {
      await startChangeStream({
        streamId: 's1',
        connectionId: 'c1',
        database: 'sales',
        collection: 'orders',
        operationTypes: [],
      });

      expect(invokeMock).toHaveBeenCalledWith(
        'start_change_stream',
        expect.objectContaining({ database: 'sales', collection: 'orders' }),
      );
    });

    it('watches a whole database when no collection is given', async () => {
      await startChangeStream({
        streamId: 's1',
        connectionId: 'c1',
        database: 'sales',
        operationTypes: ['insert'],
      });

      expect(invokeMock).toHaveBeenCalledWith(
        'start_change_stream',
        expect.objectContaining({ database: 'sales', collection: null }),
      );
    });

    it('treats an empty name as no name, not as a namespace', async () => {
      // A deployment tab stores its database as ''. Passing that through
      // reaches the driver as `client.database("")`, and the server rejects
      // the namespace outright: `Invalid namespace specified: .$cmd.aggregate`.
      await startChangeStream({
        streamId: 's1',
        connectionId: 'c1',
        database: '',
        collection: '',
        operationTypes: [],
      });

      expect(invokeMock).toHaveBeenCalledWith(
        'start_change_stream',
        expect.objectContaining({ database: null, collection: null }),
      );
    });

    it('watches the whole deployment when neither is given', async () => {
      // Both null is what tells the backend to call `client.watch()` rather
      // than reaching for a database that was never named.
      await startChangeStream({ streamId: 's1', connectionId: 'c1', operationTypes: [] });

      expect(invokeMock).toHaveBeenCalledWith(
        'start_change_stream',
        expect.objectContaining({ database: null, collection: null }),
      );
    });
  });

  describe('narrowing to a collection', () => {
    const ev = (db: string, coll: string | undefined, seq: number) =>
      event(seq, { database: db, collection: coll });

    it('lists the namespaces actually seen, sorted', () => {
      // A deployment-wide tail cannot know up front which collections will
      // appear, so the filter is built from what has arrived.
      const seen = collectionsSeen([
        ev('sales', 'orders', 1),
        ev('sales', 'users', 2),
        ev('sales', 'orders', 3),
      ]);
      expect(seen).toEqual(['sales.orders', 'sales.users']);
    });

    it('ignores events with no collection', () => {
      // A database-level drop has no collection of its own.
      expect(collectionsSeen([ev('sales', undefined, 1)])).toEqual([]);
    });

    it('filters to one namespace and back', () => {
      const all = [ev('sales', 'orders', 1), ev('sales', 'users', 2)];
      expect(filterByNamespace(all, 'sales.users').map((e) => e.seq)).toEqual([2]);
      expect(filterByNamespace(all, null)).toBe(all);
    });

    it('does not confuse same-named collections in different databases', () => {
      const all = [ev('sales', 'orders', 1), ev('archive', 'orders', 2)];
      expect(filterByNamespace(all, 'archive.orders').map((e) => e.seq)).toEqual([2]);
    });
  });

  describe('event summaries', () => {
    it('names the document when the key has one', () => {
      expect(describeEvent(event(1, { documentKey: { _id: 'abc' } }))).toBe('sales.orders · abc');
    });

    it('unwraps an ObjectId rather than showing its EJSON wrapper', () => {
      // It crosses IPC as `{ $oid: "..." }`, and the hex is what a reader is
      // scanning for.
      expect(eventDocumentId(event(1, { documentKey: { _id: { $oid: 'deadbeef' } } }))).toBe(
        'deadbeef',
      );
    });

    it('has no id for an event that carries no key', () => {
      expect(eventDocumentId(event(1))).toBeUndefined();
    });

    it('falls back to the namespace alone', () => {
      expect(describeEvent(event(1))).toBe('sales.orders');
    });

    it('handles a database-wide event with no collection', () => {
      expect(describeEvent(event(1, { collection: undefined }))).toBe('sales');
    });
  });
});
