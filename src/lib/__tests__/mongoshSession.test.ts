import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  disposeShellSessionsForTabs,
  dropPendingShellStart,
  shareShellStart,
  watchShellSession,
  loadShellSession,
  renameShellSession,
  shellSessionEpoch,
  retargetShellSessionDatabase,
  stopShellSessionProcess,
  disposeShellSession,
  forgetShellSession,
  readShellSession,
  resetShellSessions,
  writeShellSession,
} from '../mongoshSession';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

describe('mongosh session registry (#240)', () => {
  beforeEach(() => {
    resetShellSessions();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('keeps a session and its transcript across an unmount', () => {
    writeShellSession('tab-1', {
      sessionId: 'sess-1',
      entries: [{ kind: 'note', text: 'attached' }],
      currentDb: 'sales',
    });

    // Unmounting no longer touches the registry, so a remount finds it intact.
    expect(readShellSession('tab-1')).toEqual({
      sessionId: 'sess-1',
      entries: [{ kind: 'note', text: 'attached' }],
      currentDb: 'sales',
      autoRanCommand: false,
      aiOpen: false,
      aiMessages: [],
    });
    // Writes now mirror to the backend; what must NOT happen is the child being
    // killed just because the component went away.
    expect(invokeMock).not.toHaveBeenCalledWith('stop_mongosh_session', expect.anything());
  });

  it('merges partial writes so one field can be persisted without the others', () => {
    writeShellSession('tab-1', { sessionId: 'sess-1', currentDb: 'sales' });
    writeShellSession('tab-1', { entries: [{ kind: 'note', text: 'later' }] });

    expect(readShellSession('tab-1')).toEqual({
      sessionId: 'sess-1',
      entries: [{ kind: 'note', text: 'later' }],
      currentDb: 'sales',
      autoRanCommand: false,
      aiOpen: false,
      aiMessages: [],
    });
  });

  it('stops the backend process only when the tab closes', async () => {
    writeShellSession('tab-1', { sessionId: 'sess-1', entries: [], currentDb: 'db' });

    await disposeShellSession('tab-1');

    expect(invokeMock).toHaveBeenCalledWith('stop_mongosh_session', { sessionId: 'sess-1' });
    expect(readShellSession('tab-1')).toBeUndefined();
  });

  it('disposing a tab that never attached does not call the backend', async () => {
    writeShellSession('tab-1', { sessionId: null, entries: [], currentDb: 'db' });

    await disposeShellSession('tab-1');

    expect(invokeMock).not.toHaveBeenCalledWith('stop_mongosh_session', expect.anything());
    expect(readShellSession('tab-1')).toBeUndefined();
  });

  it('never rejects when the backend refuses — tab teardown must not throw', async () => {
    invokeMock.mockRejectedValue(new Error('session already gone'));
    writeShellSession('tab-1', { sessionId: 'sess-1', entries: [], currentDb: 'db' });

    await expect(disposeShellSession('tab-1')).resolves.toBeUndefined();
    expect(readShellSession('tab-1')).toBeUndefined();
  });

  it('remembers that the opening command already ran, so a remount does not repeat it', () => {
    writeShellSession('tab-1', { sessionId: 'sess-1', autoRanCommand: true });
    writeShellSession('tab-1', { entries: [{ kind: 'note', text: 'output' }] });

    expect(readShellSession('tab-1')?.autoRanCommand).toBe(true);
  });

  it('mirrors every write to the backend, which owns the state across reloads', () => {
    writeShellSession('tab-1', { sessionId: 'sess-1', currentDb: 'sales' });

    expect(invokeMock).toHaveBeenCalledWith(
      'set_shell_tab_state',
      expect.objectContaining({ tabId: 'tab-1' }),
    );
  });

  it('stamps the owning window on every persisted session', () => {
    // How the backend finds a window's shells when it is closed with the OS X
    // button. It cannot go via the workspace: those tab ids are profile-space
    // while these keys are live-space, so a rebound shell — the only kind with
    // a child worth stopping — would never be matched.
    writeShellSession('tab-1', { sessionId: 'sess-1' });

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_shell_tab_state');
    expect((call?.[1] as { value: { windowId?: string } }).value.windowId).toBe('main');
  });

  it('follows a tab that is rebound to a new id', () => {
    writeShellSession('old-id', { sessionId: 'sess-1', entries: [{ kind: 'note', text: 'x' }] });

    renameShellSession('old-id', 'new-id');

    expect(readShellSession('old-id')).toBeUndefined();
    expect(readShellSession('new-id')?.sessionId).toBe('sess-1');
  });

  it('renaming a tab with no session is a no-op', () => {
    renameShellSession('nothing-here', 'new-id');
    expect(readShellSession('new-id')).toBeUndefined();
  });

  it('stops a process it only learns about from the backend', async () => {
    // The tab has not mounted since a refresh, so nothing has hydrated the
    // cache — but the child is running and must still be stoppable.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_shell_tab_state'
        ? Promise.resolve({ sessionId: 'sess-orphan' })
        : Promise.resolve(undefined),
    );

    await stopShellSessionProcess('tab-1');

    expect(invokeMock).toHaveBeenCalledWith('stop_mongosh_session', { sessionId: 'sess-orphan' });
  });

  it('retargets a CACHED session synchronously, before a remount can seed the old database', async () => {
    // The rename re-keys the tab in the same discrete event, so React remounts
    // MongoShell before any microtask here runs, and the component reads the
    // registry once at mount. Anything deferred is therefore invisible to the
    // instance that matters: it would keep the dropped database and a session
    // id about to be killed, and restarting it would recreate that database.
    writeShellSession('tab-1', {
      sessionId: 'sess-old',
      currentDb: 'before',
      entries: [{ kind: 'note', text: 'kept' }],
    });

    const done = retargetShellSessionDatabase('tab-1', 'after', Promise.resolve());

    // Read with no await at all — this is exactly what the remount sees.
    const atMount = readShellSession('tab-1');
    expect(atMount?.currentDb).toBe('after');
    expect(atMount?.sessionId).toBeNull();
    expect(atMount?.entries).toEqual([{ kind: 'note', text: 'kept' }]);

    await done;
    expect(invokeMock).toHaveBeenCalledWith('stop_mongosh_session', { sessionId: 'sess-old' });
  });

  it('retargets a renamed database and stops the child that is still on the old one', async () => {
    // Straight from the backend again: writing `currentDb` without hydrating
    // would create a cache entry with a null session id, and the stop would
    // then find nothing — leaving mongosh attached to a database the rename
    // has already dropped.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_shell_tab_state'
        ? Promise.resolve({ sessionId: 'sess-old', currentDb: 'before', entries: [] })
        : Promise.resolve(undefined),
    );

    await retargetShellSessionDatabase('tab-1', 'after', Promise.resolve());

    expect(invokeMock).toHaveBeenCalledWith('stop_mongosh_session', { sessionId: 'sess-old' });
    const after = readShellSession('tab-1');
    expect(after?.currentDb).toBe('after');
    expect(after?.sessionId).toBeNull();
  });

  it('stops the process for a restart but keeps the transcript', async () => {
    writeShellSession('tab-1', {
      sessionId: 'sess-1',
      entries: [{ kind: 'note', text: 'earlier output' }],
      currentDb: 'sales',
    });

    await stopShellSessionProcess('tab-1');

    expect(invokeMock).toHaveBeenCalledWith('stop_mongosh_session', { sessionId: 'sess-1' });
    const after = readShellSession('tab-1');
    expect(after?.sessionId).toBeNull();
    expect(after?.entries).toEqual([{ kind: 'note', text: 'earlier output' }]);
    expect(after?.currentDb).toBe('sales');
  });

  it('disposes only the tabs it is given, leaving other windows alone', async () => {
    // A global clear here would strip a live shell owned by ANOTHER window of
    // its recovery mapping without stopping the child — unreattachable and
    // unkillable.
    writeShellSession('mine-1', { sessionId: 'sess-1' });
    writeShellSession('mine-2', { sessionId: 'sess-2' });
    writeShellSession('other-window', { sessionId: 'sess-other' });

    await disposeShellSessionsForTabs(['mine-1', 'mine-2']);

    const stopped = invokeMock.mock.calls
      .filter((c) => c[0] === 'stop_mongosh_session')
      .map((c) => (c[1] as { sessionId: string }).sessionId);
    expect(stopped).toEqual(expect.arrayContaining(['sess-1', 'sess-2']));
    expect(stopped).not.toContain('sess-other');
    expect(readShellSession('other-window')?.sessionId).toBe('sess-other');
  });

  describe('writes that outlive ownership', () => {
    it('drops a completion that lands after its tab was closed', async () => {
      // Tab ids are deterministic, so reopening the same shell lands on the
      // same key: a late write would hand the new tab the old transcript and a
      // set `autoRanCommand`, which also suppresses its opening command.
      writeShellSession('tab-1', { sessionId: 'sess-1', autoRanCommand: true });
      const epoch = shellSessionEpoch('tab-1');

      await disposeShellSession('tab-1');
      writeShellSession('tab-1', { entries: [{ kind: 'note', text: 'late output' }] }, epoch);

      expect(readShellSession('tab-1')).toBeUndefined();
    });

    it('drops a completion that lands after its tab moved to another window', () => {
      // The destination owns the state now. A stale mirror from here would
      // overwrite what that window has since appended — and because every write
      // stamps the owning window, it would also steal ownership back, so
      // closing THIS window would kill a process the other one is showing.
      writeShellSession('tab-1', { sessionId: 'sess-1', entries: [] });
      const epoch = shellSessionEpoch('tab-1');

      forgetShellSession('tab-1');
      invokeMock.mockClear();
      writeShellSession('tab-1', { entries: [{ kind: 'note', text: 'stale' }] }, epoch);

      expect(readShellSession('tab-1')).toBeUndefined();
      expect(invokeMock).not.toHaveBeenCalledWith('set_shell_tab_state', expect.anything());
    });

    it('forgetting keeps the backend session alive — only disposing ends it', async () => {
      writeShellSession('tab-1', { sessionId: 'sess-1' });
      invokeMock.mockClear();

      forgetShellSession('tab-1');

      expect(invokeMock).not.toHaveBeenCalledWith('stop_mongosh_session', expect.anything());
      expect(invokeMock).not.toHaveBeenCalledWith('clear_shell_tab_state', expect.anything());
    });

    it('ends the epoch synchronously, before the close round trip', async () => {
      // The state of an inactive tab lives only in the backend, so closing it
      // has to go there — but tab ids are deterministic, so the same key can be
      // reopened while that call is in flight. Doing the bookkeeping afterwards
      // would end the REOPENED tab's epoch and delete its cache entry.
      let releaseClose: (v: unknown) => void = () => {};
      invokeMock.mockImplementation((cmd: string) =>
        cmd === 'close_shell_tab_session'
          ? new Promise((res) => { releaseClose = res; })
          : Promise.resolve(undefined),
      );

      const disposal = disposeShellSession('tab-1');
      await Promise.resolve();

      // A fresh mount takes the key over while the close is still pending.
      const reopenedEpoch = shellSessionEpoch('tab-1');
      writeShellSession('tab-1', { sessionId: 'sess-new' }, reopenedEpoch);

      releaseClose(undefined);
      await disposal;

      expect(invokeMock).toHaveBeenCalledWith('close_shell_tab_session', { tabId: 'tab-1' });
      expect(readShellSession('tab-1')?.sessionId).toBe('sess-new');
    });

    it('takes the backend entry and stops its child in ONE call', async () => {
      // Reading the id and clearing the entry as two commands is a race the
      // frontend cannot win: an inactive tab's id exists only in the backend,
      // so a clear that overtook the read would strand the mongosh child with
      // nothing left pointing at it.
      await disposeShellSession('tab-only-in-backend');

      expect(invokeMock).toHaveBeenCalledWith('close_shell_tab_session', {
        tabId: 'tab-only-in-backend',
      });
      expect(invokeMock).not.toHaveBeenCalledWith(
        'clear_shell_tab_state',
        expect.anything(),
      );
    });

    it('a reopened tab is not silenced by the previous tab\'s disposal', async () => {
      writeShellSession('tab-1', { sessionId: 'sess-1' });
      await disposeShellSession('tab-1');

      // What a fresh mount under the same deterministic id captures.
      const epoch = shellSessionEpoch('tab-1');
      writeShellSession('tab-1', { sessionId: 'sess-2' }, epoch);

      expect(readShellSession('tab-1')?.sessionId).toBe('sess-2');
      // ...and the previous tab's writes, holding the older epoch, still are.
      writeShellSession('tab-1', { sessionId: 'ghost' }, epoch - 1);
      expect(readShellSession('tab-1')?.sessionId).toBe('sess-2');
    });
  });

  describe('a start that outlives one mount', () => {
    it('joins the start already running instead of spawning a rival', async () => {
      // A start records nothing until it returns, so a remount partway through
      // saw an unattached tab and issued a second one; the two ids then
      // overwrote each other and one child was left untracked.
      let calls = 0;
      const task = () => {
        calls += 1;
        return new Promise<{ session_id: string }>((res) => setTimeout(() => res({ session_id: 'sess-1' }), 5));
      };

      const first = shareShellStart('tab-1', task);
      const second = shareShellStart('tab-1', task); // the remount

      expect(calls).toBe(1);
      expect((await first).session_id).toBe('sess-1');
      expect((await second).session_id).toBe('sess-1');
    });

    it('starts fresh once the previous attempt has settled', async () => {
      let calls = 0;
      const task = () => {
        calls += 1;
        return Promise.resolve({ session_id: 'sess' });
      };

      await shareShellStart('tab-1', task);
      await shareShellStart('tab-1', task);

      expect(calls).toBe(2);
    });

    it('lets Retry replace an attempt rather than join it', async () => {
      let calls = 0;
      const task = () => {
        calls += 1;
        return new Promise<{ session_id: string }>(() => {}); // never settles
      };

      shareShellStart('tab-1', task);
      dropPendingShellStart('tab-1');
      shareShellStart('tab-1', task);

      expect(calls).toBe(2);
    });

    it('a failed start does not wedge the tab', async () => {
      const boom = () => Promise.reject(new Error('no mongosh'));
      await expect(shareShellStart('tab-1', boom)).rejects.toThrow('no mongosh');

      // The entry is gone, so the next attempt is a real one.
      let called = false;
      await shareShellStart('tab-1', () => {
        called = true;
        return Promise.resolve({ session_id: 'sess' });
      });
      expect(called).toBe(true);
    });
  });

  describe('watchers', () => {
    it('tells the mounted instance about a write made by another one', () => {
      // The off-screen completion writes to the registry; without this the
      // visible instance would not know until its own next append.
      const seen: string[] = [];
      const stop = watchShellSession('tab-1', (s) => seen.push(s.currentDb));

      writeShellSession('tab-1', { currentDb: 'from-elsewhere' });

      expect(seen).toEqual(['from-elsewhere']);
      stop();
      writeShellSession('tab-1', { currentDb: 'after-unsubscribe' });
      expect(seen).toEqual(['from-elsewhere']);
    });

    it('does not notify for a write that was dropped as stale', () => {
      writeShellSession('tab-1', { sessionId: 'sess-1' });
      const epoch = shellSessionEpoch('tab-1');
      const seen: unknown[] = [];
      watchShellSession('tab-1', (s) => seen.push(s));

      forgetShellSession('tab-1');
      writeShellSession('tab-1', { currentDb: 'ghost' }, epoch);

      expect(seen).toEqual([]);
    });
  });

  it('keeps its sessions in a store that survives hot module replacement', async () => {
    // Regression guard for a dev-only failure that looked exactly like a bug in
    // the feature: editing any file in this module's graph replaced the module,
    // a plain `new Map()` came back empty, the tab started a second session and
    // the first mongosh process was orphaned with no id left to stop it.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/mongoshSession.ts', 'utf8'),
    );

    expect(source).toContain('import.meta.hot?.data?.shellSessions');
    expect(source).toContain('import.meta.hot?.data) import.meta.hot.data.shellSessions = sessions');
  });

  it('rebuilds a session from the backend when the cache is empty', async () => {
    // What a hot reload or a window refresh produces: no cache, but the child
    // is still running and the backend still knows about it.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_shell_tab_state'
        ? Promise.resolve({ sessionId: 'sess-live', entries: [{ kind: 'note', text: 'kept' }] })
        : Promise.resolve(undefined),
    );

    const restored = await loadShellSession('tab-1');

    expect(restored?.sessionId).toBe('sess-live');
    expect(restored?.entries).toEqual([{ kind: 'note', text: 'kept' }]);
    // Defaults fill in for fields the stored blob predates.
    expect(restored?.autoRanCommand).toBe(false);
    expect(readShellSession('tab-1')?.sessionId).toBe('sess-live');
  });

  it('ignores a backend value that is not a session object', async () => {
    // The payload crosses IPC as opaque JSON; anything merely truthy (an array,
    // say) must not be cached and then read for fields it does not have.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_shell_tab_state' ? Promise.resolve([]) : Promise.resolve(undefined),
    );

    expect(await loadShellSession('tab-1')).toBeUndefined();
    expect(readShellSession('tab-1')).toBeUndefined();
  });
});
