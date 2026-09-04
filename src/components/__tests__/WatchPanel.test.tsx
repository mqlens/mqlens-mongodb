import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WatchPanel } from '../WatchPanel';
import { TabVisibleContext } from '../../workspace/tabVisibility';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// The virtualized list measures its container, which jsdom reports as 0 — no
// rows render either way. These tests are about what the panel asks the
// backend for, not about what it paints.
vi.mock('react-window', () => ({
  List: () => <div data-testid="watch-list" />,
}));

const callsTo = (command: string) => invokeMock.mock.calls.filter((c) => c[0] === command);

const panel = (props: Partial<React.ComponentProps<typeof WatchPanel>> = {}) => (
  <WatchPanel
    connectionId="c1"
    databaseName="sales"
    collectionName="orders"
    streamId="watch.c.c1.sales.orders"
    {...props}
  />
);

describe('WatchPanel', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') return Promise.resolve(null);
      if (command === 'poll_change_stream') {
        return Promise.resolve({ events: [], status: 'running', error: null, dropped: 0, lastSeq: 0 });
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adopts the filter of the stream it finds already running', async () => {
    // A watch tab is unmounted while it is inactive, so the panel's own filter
    // state comes back empty when the user returns. Starting on that empty
    // state sends different operation types, which the backend reads as a
    // different stream: buffer discarded, cursor restarted, filter silently
    // cleared. The remount has to start from what is actually running.
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') {
        return Promise.resolve({
          connectionId: 'c1',
          database: 'sales',
          collection: 'orders',
          operationTypes: ['insert', 'delete'],
          status: 'running',
        });
      }
      if (command === 'poll_change_stream') {
        return Promise.resolve({ events: [], status: 'running', error: null, dropped: 0, lastSeq: 0 });
      }
      return Promise.resolve(undefined);
    });

    render(panel());

    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));
    expect(callsTo('start_change_stream')[0][1]).toMatchObject({
      operationTypes: ['insert', 'delete'],
    });
  });

  it('starts unfiltered when nothing is running under that id', async () => {
    render(panel());
    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));
    expect(callsTo('start_change_stream')[0][1]).toMatchObject({ operationTypes: [] });
  });

  it('does not poll while its tab is hidden, and resumes when it is shown', async () => {
    // A kept-alive Watch tab stays mounted while another tab is on screen
    // (#240). The stream keeps running and buffering on the backend; this
    // panel just stops asking for it until someone can see it.
    const view = (visible: boolean) => (
      <TabVisibleContext.Provider value={visible}>{panel()}</TabVisibleContext.Provider>
    );
    const { rerender } = render(view(false));

    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 900));
    expect(callsTo('poll_change_stream')).toHaveLength(0);

    rerender(view(true));
    await waitFor(() => expect(callsTo('poll_change_stream').length).toBeGreaterThan(0), {
      timeout: 2000,
    });
  });

  it('does not poll until the stream it is polling exists', async () => {
    // On a filter change the previous stream is still installed under this id
    // until the replacement takes its place. A poll that overtook the start
    // would read the OLD buffer and push the last-seen sequence up to its
    // count, while the replacement starts counting from zero — every event it
    // then produced would look already-seen and the tail would sit there
    // looking idle.
    let releaseStart: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') return Promise.resolve(null);
      if (command === 'start_change_stream') return started;
      if (command === 'poll_change_stream') {
        return Promise.resolve({ events: [], status: 'running', error: null, dropped: 0, lastSeq: 0 });
      }
      return Promise.resolve(undefined);
    });

    render(panel());

    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));
    expect(callsTo('poll_change_stream')).toHaveLength(0);

    releaseStart();
    await waitFor(() => expect(callsTo('poll_change_stream').length).toBeGreaterThan(0));
  });

  it('does not re-pause a stream the user has just resumed', async () => {
    // The re-pause on a filter change reads a ref, and that ref cannot be
    // derived from the polled status: it arrives up to 700ms later. Resume,
    // change a filter before the next poll, and the replacement would be
    // paused again on the user's behalf — the Resume click looking like it did
    // nothing at all.
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') return Promise.resolve(null);
      if (command === 'poll_change_stream') {
        return Promise.resolve({ events: [], status: 'paused', error: null, dropped: 0, lastSeq: 0 });
      }
      return Promise.resolve(undefined);
    });

    render(panel());
    // The toggle offers Resume only once a poll has reported the pause.
    await waitFor(() => expect(callsTo('poll_change_stream').length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.getByTestId('watch-toggle').getAttribute('title')).toMatch(/resume/i)
    );

    fireEvent.click(screen.getByTestId('watch-toggle'));
    expect(callsTo('resume_change_stream')).toHaveLength(1);

    // Straight into a filter change, before any poll could report `running`.
    fireEvent.click(screen.getByTestId('watch-filter-insert'));
    await waitFor(() => expect(callsTo('start_change_stream').length).toBeGreaterThan(1));
    expect(callsTo('pause_change_stream')).toHaveLength(0);
  });

  it('starts the stream again when it finds nothing watching under its id', async () => {
    // Closing a tab and reopening the same target can land the old stop after
    // the new start. Without noticing, the panel would poll an id nothing
    // fills for as long as it stayed open — a tail that looks merely quiet.
    let exists = false;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') return Promise.resolve(null);
      if (command === 'start_change_stream') {
        exists = true;
        return Promise.resolve(undefined);
      }
      if (command === 'poll_change_stream') {
        // Deleted out from under the panel by a stop that arrived late.
        const answer = exists
          ? { events: [], status: 'running', error: null, dropped: 0, lastSeq: 0 }
          : null;
        exists = false;
        return Promise.resolve(answer);
      }
      return Promise.resolve(undefined);
    });

    render(panel());
    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));
    await waitFor(() => expect(callsTo('start_change_stream').length).toBeGreaterThan(1));
  });

  it('forgets the old events when its stream is replaced under it', async () => {
    // Sequence numbers restart at zero with the new cursor, and merging
    // deduplicates by sequence — so events kept from the old stream make every
    // fresh event up to the old high-water mark look already-shown, and the
    // tail silently drops them. Three old events and two new ones with
    // overlapping sequences: without the reset the count stays at three and
    // the new pair is never seen.
    const change = (seq: number) => ({
      seq,
      operationType: 'insert',
      database: 'sales',
      collection: 'orders',
      atMs: 0,
    });
    let phase: 'first' | 'gone' | 'second' = 'first';
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') return Promise.resolve(null);
      if (command === 'start_change_stream') return Promise.resolve(undefined);
      if (command === 'poll_change_stream') {
        if (phase === 'first') {
          phase = 'gone';
          return Promise.resolve({
            events: [change(0), change(1), change(2)],
            status: 'running',
            error: null,
            dropped: 0,
            lastSeq: 2,
          });
        }
        if (phase === 'gone') {
          // Removed by a stop that arrived late.
          phase = 'second';
          return Promise.resolve(null);
        }
        return Promise.resolve({
          events: [change(0), change(1)],
          status: 'running',
          error: null,
          dropped: 0,
          lastSeq: 1,
        });
      }
      return Promise.resolve(undefined);
    });

    render(panel());
    await waitFor(() => expect(screen.getByTestId('watch-count')).toHaveTextContent('3'));
    await waitFor(() => expect(callsTo('start_change_stream').length).toBeGreaterThan(1));
    // The replacement's events reuse sequences 0 and 1 and must still land.
    await waitFor(() => expect(screen.getByTestId('watch-count')).toHaveTextContent('2'));
  });

  it('sends filter changes one at a time, in the order they were asked for', async () => {
    // Two replacements in flight together means the backend keeps whichever
    // IPC call happens to land last, which can be the older filter — a tail
    // showing something other than what the buttons say.
    const settle: Array<() => void> = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') return Promise.resolve(null);
      if (command === 'start_change_stream') {
        return new Promise<void>((resolve) => settle.push(resolve));
      }
      if (command === 'poll_change_stream') {
        return Promise.resolve({ events: [], status: 'running', error: null, dropped: 0, lastSeq: 0 });
      }
      return Promise.resolve(undefined);
    });

    render(panel());
    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('watch-filter-insert'));
    fireEvent.click(screen.getByTestId('watch-filter-delete'));
    // Both toggles have happened; neither replacement can have been sent while
    // the first start is still unresolved.
    await waitFor(() => expect(screen.getByTestId('watch-filter-delete')).toBeInTheDocument());
    expect(callsTo('start_change_stream')).toHaveLength(1);

    // Releasing the first lets the queue drain. What matters is where it ends
    // up: the newest selection is what the backend is left holding, and no two
    // replacements were ever in flight together to decide that by arrival
    // order.
    settle.shift()?.();
    await waitFor(() => expect(callsTo('start_change_stream').length).toBeGreaterThan(1));
    const sent = callsTo('start_change_stream');
    expect(sent[sent.length - 1][1]).toMatchObject({ operationTypes: ['insert', 'delete'] });
  });

  it('drops a queued start when the tab goes away', async () => {
    // A start waiting behind another one outlives the panel. Close the tab and
    // the close path's stop can run first, after which the queued start
    // recreates a cursor for a tab that no longer exists — with no panel left
    // to notice, it holds its buffer until the app exits.
    const settle: Array<() => void> = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') return Promise.resolve(null);
      if (command === 'start_change_stream') {
        return new Promise<void>((resolve) => settle.push(resolve));
      }
      if (command === 'poll_change_stream') {
        return Promise.resolve({ events: [], status: 'running', error: null, dropped: 0, lastSeq: 0 });
      }
      return Promise.resolve(undefined);
    });

    const view = render(panel());
    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('watch-filter-insert'));

    view.unmount();
    settle.forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callsTo('start_change_stream')).toHaveLength(1);
  });

  it('comes back paused when that is how the tab was left', async () => {
    // Without adopting the status the toolbar reads `starting` until the first
    // poll 700ms later, offering Pause on something already paused — so the
    // click meant to resume pauses again and the tail stays stopped.
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') {
        return Promise.resolve({
          connectionId: 'c1',
          database: 'sales',
          collection: 'orders',
          operationTypes: [],
          status: 'paused',
        });
      }
      // Never answers, so nothing here can come from a poll.
      if (command === 'poll_change_stream') return new Promise(() => {});
      return Promise.resolve(undefined);
    });

    render(panel());

    await waitFor(() =>
      expect(screen.getByTestId('watch-toggle').getAttribute('title')).toMatch(/resume/i)
    );
    // The start settles into its own re-pause first — a paused tab stays
    // paused across a restart — so what matters is that the click is not
    // undone by it.
    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));
    const pausesBefore = callsTo('pause_change_stream').length;

    fireEvent.click(screen.getByTestId('watch-toggle'));
    expect(callsTo('resume_change_stream')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo('pause_change_stream')).toHaveLength(pausesBefore);
  });

  it('offers to retry a cursor that failed, rather than to pause it', async () => {
    // An errored cursor has no reader either. Showing Pause meant the only way
    // back from a transient failure was to pause a dead stream, wait for a
    // poll, and then click Resume.
    invokeMock.mockImplementation((command: string) => {
      if (command === 'describe_change_stream') return Promise.resolve(null);
      if (command === 'poll_change_stream') {
        return Promise.resolve({
          events: [],
          status: 'error',
          error: 'cursor died',
          dropped: 0,
          lastSeq: 0,
        });
      }
      return Promise.resolve(undefined);
    });

    render(panel());
    await waitFor(() =>
      expect(screen.getByTestId('watch-toggle').getAttribute('title')).toMatch(/again|retry/i)
    );

    fireEvent.click(screen.getByTestId('watch-toggle'));
    expect(callsTo('resume_change_stream')).toHaveLength(1);
    expect(callsTo('pause_change_stream')).toHaveLength(0);
  });

  it('watches the whole deployment when no database is given', async () => {
    // An empty database name reaches the driver as the namespace
    // `.$cmd.aggregate`, which the server rejects outright — a cluster-level
    // watch has to send nothing at all.
    render(panel({ databaseName: undefined, collectionName: undefined, streamId: 'watch.x.c1..' }));
    await waitFor(() => expect(callsTo('start_change_stream')).toHaveLength(1));
    expect(callsTo('start_change_stream')[0][1]).toMatchObject({
      database: null,
      collection: null,
    });
  });
});
