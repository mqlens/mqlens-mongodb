import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  disposeShellSessionsForTabs,
  loadShellSession,
  renameShellSession,
  retargetShellSessionDatabase,
  stopShellSessionProcess,
  disposeShellSession,
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

    await retargetShellSessionDatabase('tab-1', 'after');

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
