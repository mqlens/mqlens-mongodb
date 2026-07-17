import { describe, it, expect } from 'vitest';
import {
  toPersistedTab,
  toDisconnectedSnapshot,
  rebindConnection,
  type PersistableTab,
  type PersistableConnection,
  type PersistedWorkspace,
} from '../persistence';
import { actionToOp } from '../workspaceStore';
import type { WorkspaceAction } from '../model';
import goldenFixture from '../../../fixtures/workspace-golden.json';

const conn: PersistableConnection = { id: 'conn-uuid', profileId: 'p1', name: 'Profile 1' };

const collectionTab: PersistableTab = {
  id: 'conn-uuid.mydb.mycoll',
  type: 'collection',
  connectionId: 'conn-uuid',
  db: 'mydb',
  collection: 'mycoll',
};

describe('toPersistedTab', () => {
  it('returns null for export tabs — in-flight task state does not survive a restart', () => {
    const tab: PersistableTab = { ...collectionTab, id: 'export.conn-uuid.mydb.mycoll', type: 'export' };
    expect(toPersistedTab(tab, conn, undefined)).toBeNull();
  });

  it('returns null for import tabs', () => {
    const tab: PersistableTab = { ...collectionTab, id: 'import.conn-uuid.mydb.mycoll', type: 'import' };
    expect(toPersistedTab(tab, conn, undefined)).toBeNull();
  });

  it('substitutes the leading connectionId segment with profile:<profileId> at save time', () => {
    const persisted = toPersistedTab(collectionTab, conn, undefined);
    expect(persisted?.id).toBe('profile:p1.mydb.mycoll');
    expect(persisted?.profileId).toBe('p1');
    expect(persisted?.profileName).toBe('Profile 1');
  });

  it('substitutes the connection segment inside a type-prefixed id (shell)', () => {
    const tab: PersistableTab = {
      id: 'shell.conn-uuid.mydb.x',
      type: 'shell',
      connectionId: 'conn-uuid',
      db: 'mydb',
      collection: 'x',
    };
    const persisted = toPersistedTab(tab, conn, undefined);
    expect(persisted?.id).toBe('shell.profile:p1.mydb.x');
  });

  it('passes settings/quickstart/tasks tabs through unchanged with empty profile fields', () => {
    for (const type of ['settings', 'quickstart', 'tasks'] as const) {
      const tab: PersistableTab = { id: type, type, connectionId: '', db: '', collection: '' };
      const persisted = toPersistedTab(tab, undefined, undefined);
      expect(persisted).toEqual({
        id: type,
        type,
        profileId: '',
        profileName: '',
        db: '',
        collection: '',
        indexName: undefined,
        lastQuery: undefined,
        lastAggregate: undefined,
        builderState: undefined,
      });
    }
  });

  it('carries builderState and lastQuery/lastAggregate through untouched', () => {
    const tab: PersistableTab = { ...collectionTab, lastQuery: { filter: '{}' } };
    const persisted = toPersistedTab(tab, conn, { queryMode: 'find' });
    expect(persisted?.lastQuery).toEqual({ filter: '{}' });
    expect(persisted?.builderState).toEqual({ queryMode: 'find' });
  });
});

describe('toDisconnectedSnapshot', () => {
  const ws: PersistedWorkspace = {
    revision: 3,
    windows: [
      {
        id: 'main',
        focusedPaneId: 'pane-1',
        splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.mydb.mycoll'], activeTabId: 'profile:p1.mydb.mycoll' },
      },
    ],
    tabs: [
      {
        id: 'profile:p1.mydb.mycoll',
        type: 'collection',
        profileId: 'p1',
        profileName: 'Profile 1',
        db: 'mydb',
        collection: 'mycoll',
        lastQuery: { filter: '{}' },
        builderState: { queryMode: 'find' },
      },
    ],
  };

  it('produces empty-results tabs with profile: connectionIds', () => {
    const snapshot = toDisconnectedSnapshot(ws);
    expect(snapshot.tabs).toHaveLength(1);
    const tab = snapshot.tabs[0];
    expect(tab.id).toBe('profile:p1.mydb.mycoll'); // no id surgery — already in profile: form
    expect(tab.connectionId).toBe('profile:p1');
    expect(tab.results).toEqual([]);
    expect(tab.loading).toBe(false);
    expect(tab.error).toBeNull();
    expect(tab.explainResult).toBeNull();
  });

  it('seeds builderStates from persisted tabs that have one', () => {
    const snapshot = toDisconnectedSnapshot(ws);
    expect(snapshot.builderStates.get('profile:p1.mydb.mycoll')).toEqual({ queryMode: 'find' });
    expect(snapshot.builderStates.size).toBe(1);
  });

  it('reconstructs the layout tree as-is when every layout tab id has a matching persisted tab', () => {
    const snapshot = toDisconnectedSnapshot(ws);
    expect(snapshot.layout).toEqual({
      root: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.mydb.mycoll'], activeTabId: 'profile:p1.mydb.mycoll' },
      focusedPaneId: 'pane-1',
    });
  });

  it('drops a layout tab id (and folds the layout) that has no matching persisted tab', () => {
    // Simulates legacy/corrupt data: the layout references an id absent from
    // tabs[] (the case a never-mirrored export/import tab would be in, were
    // it ever to end up in the tree). The reducer's close_tab must fold the
    // pane exactly like a normal close would.
    const dangling: PersistedWorkspace = {
      revision: 1,
      windows: [
        {
          id: 'main',
          focusedPaneId: 'pane-1',
          splitTree: {
            kind: 'split',
            id: 'split-1',
            dir: 'row',
            ratio: 0.5,
            children: [
              { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.mydb.mycoll'], activeTabId: 'profile:p1.mydb.mycoll' },
              { kind: 'pane', id: 'pane-2', tabIds: ['export.conn-uuid.mydb.mycoll'], activeTabId: 'export.conn-uuid.mydb.mycoll' },
            ],
          },
        },
      ],
      tabs: ws.tabs,
    };
    const snapshot = toDisconnectedSnapshot(dangling);
    expect(snapshot.tabs.map((t) => t.id)).toEqual(['profile:p1.mydb.mycoll']);
    // pane-2 held only the dangling id, so it folds away entirely.
    expect(snapshot.layout).toEqual({
      root: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.mydb.mycoll'], activeTabId: 'profile:p1.mydb.mycoll' },
      focusedPaneId: 'pane-1',
    });
  });

  it('falls back to a fresh empty pane when there are no windows', () => {
    const empty: PersistedWorkspace = { revision: 0, windows: [], tabs: [] };
    const snapshot = toDisconnectedSnapshot(empty);
    expect(snapshot.tabs).toEqual([]);
    expect(snapshot.layout.root).toEqual({ kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null });
  });
});

describe('rebindConnection', () => {
  it('maps every id containing the old profile prefix to the new connection id', () => {
    const pairs = rebindConnection('profile:p1', 'new-uuid', [
      'profile:p1.mydb.mycoll',
      'shell.profile:p1.mydb.x',
      'settings',
    ]);
    expect(pairs).toEqual([
      { oldId: 'profile:p1.mydb.mycoll', newId: 'new-uuid.mydb.mycoll' },
      { oldId: 'shell.profile:p1.mydb.x', newId: 'shell.new-uuid.mydb.x' },
    ]);
  });

  it('leaves ids without the prefix out of the result entirely', () => {
    const pairs = rebindConnection('profile:p1', 'new-uuid', ['profile:p2.mydb.mycoll', 'tasks']);
    expect(pairs).toEqual([]);
  });
});

describe('actionToOp', () => {
  // Ground truth: reuse a handful of ops from the golden parity fixture
  // (fixtures/workspace-golden.json) that the Rust backend's WorkspaceOp
  // deserializer was built and tested against.
  const opsByType = new Map<string, Record<string, unknown>>();
  for (const vector of goldenFixture.vectors) {
    for (const op of vector.ops) {
      if (!opsByType.has(op.type)) opsByType.set(op.type, op as Record<string, unknown>);
    }
  }

  it('open_tab without a pane_id or tab payload', () => {
    const expected = opsByType.get('open_tab'); // { type: 'open_tab', tab_id: 'b' }
    const action: WorkspaceAction = { type: 'open_tab', tabId: 'b' };
    expect(actionToOp(action)).toEqual(expected);
  });

  it('open_tab with an explicit pane_id', () => {
    const action: WorkspaceAction = { type: 'open_tab', tabId: 'c', paneId: 'pane-2' };
    expect(actionToOp(action)).toEqual({ type: 'open_tab', tab_id: 'c', pane_id: 'pane-2' });
  });

  it('open_tab enriched with a persisted tab payload keeps TabModel camelCase fields', () => {
    const vector = goldenFixture.vectors.find((v) => v.name === 'open_tab_with_tab_payload_upserts_tabs_array')!;
    const expected = vector.ops[0] as Record<string, unknown>; // { type: 'open_tab', tab_id: 'b', tab: {...camelCase...} }
    const persisted = expected.tab as Record<string, unknown>;
    const action: WorkspaceAction = { type: 'open_tab', tabId: expected.tab_id as string };
    expect(actionToOp(action, persisted as any)).toEqual(expected);
  });

  it('close_tab', () => {
    const action: WorkspaceAction = { type: 'close_tab', tabId: 'nope' };
    expect(actionToOp(action)).toEqual({ type: 'close_tab', tab_id: 'nope' });
  });

  it('close_many', () => {
    const expected = opsByType.get('close_many'); // { type: 'close_many', tab_ids: [...] }
    const action: WorkspaceAction = { type: 'close_many', tabIds: expected!.tab_ids as string[] };
    expect(actionToOp(action)).toEqual(expected);
  });

  it('move_tab with an explicit index', () => {
    const expected = opsByType.get('move_tab'); // { type: 'move_tab', tab_id, target_pane_id, index }
    const action: WorkspaceAction = {
      type: 'move_tab',
      tabId: expected!.tab_id as string,
      targetPaneId: expected!.target_pane_id as string,
      index: expected!.index as number,
    };
    expect(actionToOp(action)).toEqual(expected);
  });

  it('move_tab without an index omits the key rather than sending undefined', () => {
    const action: WorkspaceAction = { type: 'move_tab', tabId: 'a', targetPaneId: 'nope' };
    const op = actionToOp(action);
    expect(op).toEqual({ type: 'move_tab', tab_id: 'a', target_pane_id: 'nope' });
    expect('index' in op).toBe(false);
  });

  it('split_pane with a move_tab_id', () => {
    const expected = opsByType.get('split_pane'); // { type, pane_id, dir, side, move_tab_id }
    const action: WorkspaceAction = {
      type: 'split_pane',
      paneId: expected!.pane_id as string,
      dir: expected!.dir as 'row' | 'col',
      side: expected!.side as 'start' | 'end',
      moveTabId: expected!.move_tab_id as string,
    };
    expect(actionToOp(action)).toEqual(expected);
  });

  it('split_pane without a move_tab_id', () => {
    const action: WorkspaceAction = { type: 'split_pane', paneId: 'pane-1', dir: 'row', side: 'end' };
    const op = actionToOp(action);
    expect(op).toEqual({ type: 'split_pane', pane_id: 'pane-1', dir: 'row', side: 'end' });
    expect('move_tab_id' in op).toBe(false);
  });

  it('resize_split', () => {
    const expected = opsByType.get('resize_split'); // { type, split_id, ratio }
    const action: WorkspaceAction = { type: 'resize_split', splitId: expected!.split_id as string, ratio: expected!.ratio as number };
    expect(actionToOp(action)).toEqual(expected);
  });

  it('set_active', () => {
    const expected = opsByType.get('set_active'); // { type, pane_id, tab_id }
    const action: WorkspaceAction = { type: 'set_active', paneId: expected!.pane_id as string, tabId: expected!.tab_id as string };
    expect(actionToOp(action)).toEqual(expected);
  });

  it('focus_pane', () => {
    const expected = opsByType.get('focus_pane'); // { type, pane_id }
    const action: WorkspaceAction = { type: 'focus_pane', paneId: expected!.pane_id as string };
    expect(actionToOp(action)).toEqual(expected);
  });

  it('rename_tab', () => {
    const expected = opsByType.get('rename_tab'); // { type, old_id, new_id }
    const action: WorkspaceAction = { type: 'rename_tab', oldId: expected!.old_id as string, newId: expected!.new_id as string };
    expect(actionToOp(action)).toEqual(expected);
  });
});
