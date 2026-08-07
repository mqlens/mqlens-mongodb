import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  disposeAllShellSessions,
  renameShellSession,
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
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('merges partial writes so one field can be persisted without the others', () => {
    writeShellSession('tab-1', { sessionId: 'sess-1', currentDb: 'sales' });
    writeShellSession('tab-1', { entries: [{ kind: 'note', text: 'later' }] });

    expect(readShellSession('tab-1')).toEqual({
      sessionId: 'sess-1',
      entries: [{ kind: 'note', text: 'later' }],
      currentDb: 'sales',
      autoRanCommand: false,
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

    expect(invokeMock).not.toHaveBeenCalled();
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

  it('disposes every session when the workspace is torn down', async () => {
    writeShellSession('tab-1', { sessionId: 'sess-1', entries: [], currentDb: 'a' });
    writeShellSession('tab-2', { sessionId: 'sess-2', entries: [], currentDb: 'b' });

    await disposeAllShellSessions();

    expect(invokeMock.mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining([{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }]),
    );
    expect(readShellSession('tab-1')).toBeUndefined();
    expect(readShellSession('tab-2')).toBeUndefined();
  });
});
