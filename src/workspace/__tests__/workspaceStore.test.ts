import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { updateTabState, resetUpdateTabStateDebounce, workspaceApply, workspaceGet, actionToOp } from '../workspaceStore';
import { toPersistedTab, toProfileSpaceId, type PersistableConnection } from '../persistence';
import type { WorkspaceAction } from '../model';

describe('workspaceStore', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetUpdateTabStateDebounce();
    vi.useRealTimers();
  });

  it('workspaceGet invokes workspace_get', async () => {
    invokeMock.mockResolvedValueOnce(null);
    const result = await workspaceGet();
    expect(invokeMock).toHaveBeenCalledWith('workspace_get');
    expect(result).toBeNull();
  });

  it('workspaceApply fire-and-forgets workspace_apply with the op wrapped and this window\'s label as origin', () => {
    workspaceApply({ type: 'focus_pane', pane_id: 'pane-1' });
    // 'main' — jsdom has no real Tauri runtime, so `windowLabel()` falls
    // back to it (see workspaceStore.ts's doc comment).
    expect(invokeMock).toHaveBeenCalledWith('workspace_apply', {
      op: { type: 'focus_pane', pane_id: 'pane-1' },
      origin: 'main',
    });
  });

  it('workspaceApply swallows a rejected invoke rather than throwing', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom'));
    expect(() => workspaceApply({ type: 'focus_pane', pane_id: 'pane-1' })).not.toThrow();
    // Let the rejection's microtask settle so it doesn't surface as an
    // unhandled rejection in the test run.
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
  });

  it('updateTabState sends the wire op after the debounce window elapses', () => {
    updateTabState('t1', { lastQuery: { filter: '{}' } });
    expect(invokeMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(invokeMock).toHaveBeenCalledWith('workspace_apply', {
      op: { type: 'update_tab_state', tab_id: 't1', last_query: { filter: '{}' } },
      origin: 'main',
    });
  });

  it('omits fields never passed to updateTabState (no key at all, not undefined)', () => {
    updateTabState('t1', { lastQuery: { filter: '{}' } });
    vi.advanceTimersByTime(500);
    const [, { op }] = invokeMock.mock.calls[0];
    expect('last_aggregate' in op).toBe(false);
    expect('builder_state' in op).toBe(false);
  });

  it('sends an explicit null (own property) for a field cleared with null — CRITICAL wire regression guard', () => {
    // The backend's WorkspaceOp::UpdateTabState now distinguishes "absent"
    // (untouched) from "present but null" (clear) via a double-Option — the
    // frontend must actually serialize `null`, not drop the key, or the
    // clear never reaches the backend.
    updateTabState('t1', { lastQuery: { filter: '{}' }, lastAggregate: null });
    vi.advanceTimersByTime(500);
    const [, { op }] = invokeMock.mock.calls[0];
    expect('last_aggregate' in op).toBe(true);
    expect(op.last_aggregate).toBeNull();
    // JSON.stringify keeps explicit null (only `undefined` keys are dropped),
    // so this also verifies what actually crosses the Tauri IPC boundary.
    expect(JSON.parse(JSON.stringify(op)).last_aggregate).toBeNull();
  });

  it('merges patches from repeated calls within the debounce window (later fields win)', () => {
    updateTabState('t1', { builderState: { queryMode: 'find' } });
    updateTabState('t1', { lastAggregate: null });
    vi.advanceTimersByTime(500);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [, { op }] = invokeMock.mock.calls[0];
    expect(op).toEqual({
      type: 'update_tab_state',
      tab_id: 't1',
      builder_state: { queryMode: 'find' },
      last_aggregate: null,
    });
  });

  it('debounces independently per tab id', () => {
    updateTabState('t1', { lastQuery: { a: 1 } });
    vi.advanceTimersByTime(250);
    updateTabState('t2', { lastQuery: { b: 2 } });
    vi.advanceTimersByTime(250); // t1's window elapses; t2's has 250ms left
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('workspace_apply', {
      op: { type: 'update_tab_state', tab_id: 't1', last_query: { a: 1 } },
      origin: 'main',
    });
    vi.advanceTimersByTime(250);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('workspace_apply', {
      op: { type: 'update_tab_state', tab_id: 't2', last_query: { b: 2 } },
      origin: 'main',
    });
  });

  it('update_tab_state after a simulated reconnect rebind lands on the ORIGINAL profile-space tab_id — CRITICAL fix, wired end-to-end', () => {
    // Mirrors persistence.test.ts's pure version of this check, but through
    // the actual `updateTabState` -> `invoke` path, so the assertion is on
    // what would really cross the Tauri IPC boundary.
    const restoredTabId = 'profile:p1.mydb.mycoll';
    const newLiveConnId = 'fresh-conn-uuid';
    const reboundTabId = `${newLiveConnId}.mydb.mycoll`; // what rebindConnection would have produced
    const newConn: PersistableConnection = { id: newLiveConnId, profileId: 'p1', name: 'Profile 1' };

    updateTabState(toProfileSpaceId(reboundTabId, [newConn]), { lastQuery: { filter: '{}' } });
    vi.advanceTimersByTime(500);

    expect(invokeMock).toHaveBeenCalledWith('workspace_apply', {
      op: { type: 'update_tab_state', tab_id: restoredTabId, last_query: { filter: '{}' } },
      origin: 'main',
    });
  });
});

// CRITICAL regression coverage (see persistence.test.ts for the pure/
// round-trip version): `dispatchWorkspace`'s mirror choke point now passes
// `activeConnections` into `actionToOp` so every tab-id-bearing op field
// translates to profile-space before it reaches `workspace_apply`. This
// block asserts, for every op type, that none of them ever carry the raw
// live connection id — a captured-op-stream / regex sweep, exactly the kind
// of check that would have caught the original bug (the old code passed
// `action.tabId` etc. straight through unchanged).
describe('actionToOp id translation (CRITICAL fix)', () => {
  const LIVE_UUID = '5f1c9b3a-aaaa-4fff-8888-abcdefabcdef';
  const conn: PersistableConnection = { id: LIVE_UUID, profileId: 'p1', name: 'Profile 1' };
  const connections = [conn];
  const liveUuidPattern = new RegExp(LIVE_UUID);

  it('translates every tab-id-bearing field across every op type — no op ever contains the live connection id', () => {
    const actions: WorkspaceAction[] = [
      { type: 'open_tab', tabId: `${LIVE_UUID}.db.coll` },
      { type: 'open_tab', tabId: `${LIVE_UUID}.db.coll`, paneId: 'pane-1' },
      { type: 'close_tab', tabId: `${LIVE_UUID}.db.coll` },
      { type: 'close_many', tabIds: [`${LIVE_UUID}.db.a`, `${LIVE_UUID}.db.b`] },
      { type: 'move_tab', tabId: `${LIVE_UUID}.db.coll`, targetPaneId: 'pane-2' },
      { type: 'move_tab', tabId: `${LIVE_UUID}.db.coll`, targetPaneId: 'pane-2', index: 1 },
      { type: 'split_pane', paneId: 'pane-1', dir: 'row', side: 'end', moveTabId: `${LIVE_UUID}.db.coll` },
      { type: 'split_pane', paneId: 'pane-1', dir: 'row', side: 'end' },
      { type: 'resize_split', splitId: 'split-1', ratio: 0.5 },
      { type: 'set_active', paneId: 'pane-1', tabId: `${LIVE_UUID}.db.coll` },
      { type: 'focus_pane', paneId: 'pane-1' },
      { type: 'rename_tab', oldId: `${LIVE_UUID}.db.old`, newId: `${LIVE_UUID}.db.new` },
    ];

    // captured-op-stream: every op the mirror would actually send, in order.
    const capturedOps = actions.map((action) => actionToOp(action, undefined, connections));

    for (const op of capturedOps) {
      const wire = JSON.stringify(op);
      expect(wire).not.toMatch(liveUuidPattern);
    }
  });

  it('open_tab: the op-level tab_id and the nested tab payload id agree, both profile-space', () => {
    const tabId = `${LIVE_UUID}.mydb.mycoll`;
    const persisted = toPersistedTab(
      { id: tabId, type: 'collection', connectionId: LIVE_UUID, db: 'mydb', collection: 'mycoll' },
      conn,
      undefined
    )!;
    const op = actionToOp({ type: 'open_tab', tabId }, persisted, connections);
    expect(op.tab_id).toBe('profile:p1.mydb.mycoll');
    expect(op.tab_id).toBe((op.tab as { id: string }).id);
  });

  it('pane/split ids are left untranslated even when they contain a live connection id', () => {
    const paneId = `${LIVE_UUID}-pane`; // contrived, but proves pane_id is never scanned
    const op = actionToOp({ type: 'focus_pane', paneId }, undefined, connections);
    expect(op.pane_id).toBe(paneId);
  });

  it('close_many translates every id in the array', () => {
    const op = actionToOp(
      { type: 'close_many', tabIds: [`${LIVE_UUID}.db.a`, `${LIVE_UUID}.db.b`, 'settings'] },
      undefined,
      connections
    );
    expect(op.tab_ids).toEqual(['profile:p1.db.a', 'profile:p1.db.b', 'settings']);
  });

  it('rename_tab translates both old_id and new_id', () => {
    const op = actionToOp(
      { type: 'rename_tab', oldId: `${LIVE_UUID}.db.old`, newId: `${LIVE_UUID}.db.new` },
      undefined,
      connections
    );
    expect(op).toEqual({ type: 'rename_tab', old_id: 'profile:p1.db.old', new_id: 'profile:p1.db.new', window_id: 'main' });
  });

  it('omitting connections is a passthrough — the raw (untranslated) op shape', () => {
    const op = actionToOp({ type: 'close_tab', tabId: `${LIVE_UUID}.db.coll` });
    expect(op.tab_id).toBe(`${LIVE_UUID}.db.coll`);
  });
});
