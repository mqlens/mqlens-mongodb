import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { updateTabState, resetUpdateTabStateDebounce, workspaceApply, workspaceGet } from '../workspaceStore';

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

  it('workspaceApply fire-and-forgets workspace_apply with the op wrapped', () => {
    workspaceApply({ type: 'focus_pane', pane_id: 'pane-1' });
    expect(invokeMock).toHaveBeenCalledWith('workspace_apply', { op: { type: 'focus_pane', pane_id: 'pane-1' } });
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
    });
    vi.advanceTimersByTime(250);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('workspace_apply', {
      op: { type: 'update_tab_state', tab_id: 't2', last_query: { b: 2 } },
    });
  });
});
