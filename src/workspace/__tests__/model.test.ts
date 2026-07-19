import { describe, it, expect } from 'vitest';
import {
  createInitialLayout, workspaceReducer, findPane, paneOfTab, allPanes,
  allTabIds, mapLayoutTabIds,
  type WorkspaceLayout, type SplitNode, type PaneNode,
} from '../model';

const layoutWith = (...tabIds: string[]): WorkspaceLayout =>
  createInitialLayout(tabIds, tabIds[0] ?? null);

describe('createInitialLayout', () => {
  it('creates a single root pane holding the tabs', () => {
    const l = layoutWith('a', 'b');
    expect(l.root.kind).toBe('pane');
    expect((l.root as PaneNode).tabIds).toEqual(['a', 'b']);
    expect((l.root as PaneNode).activeTabId).toBe('a');
    expect(l.focusedPaneId).toBe(l.root.id);
  });
});

describe('open_tab', () => {
  it('appends a new tab to the focused pane and activates it', () => {
    const l = workspaceReducer(layoutWith('a'), { type: 'open_tab', tabId: 'b' });
    const pane = l.root as PaneNode;
    expect(pane.tabIds).toEqual(['a', 'b']);
    expect(pane.activeTabId).toBe('b');
  });
  it('focuses + activates an already-open tab instead of duplicating (namespace dedupe)', () => {
    let l = layoutWith('a', 'b');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    const paneA = paneOfTab(l.root, 'a')!;
    l = workspaceReducer(l, { type: 'focus_pane', paneId: paneA.id });
    l = workspaceReducer(l, { type: 'open_tab', tabId: 'b' });
    expect(paneOfTab(l.root, 'b')!.tabIds).toEqual(['b']); // still exactly one 'b'
    expect(l.focusedPaneId).toBe(paneOfTab(l.root, 'b')!.id);
    expect(allTabIds(l).filter(id => id === 'b')).toHaveLength(1);
  });
});

describe('split_pane', () => {
  it('splits into a row with ratio 0.5 and focuses the new pane', () => {
    const l0 = layoutWith('a', 'b');
    const l = workspaceReducer(l0, { type: 'split_pane', paneId: l0.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    const root = l.root as SplitNode;
    expect(root.kind).toBe('split');
    expect(root.dir).toBe('row');
    expect(root.ratio).toBe(0.5);
    const [left, right] = root.children as [PaneNode, PaneNode];
    expect(left.tabIds).toEqual(['a']);
    expect(right.tabIds).toEqual(['b']);
    expect(right.activeTabId).toBe('b');
    expect(l.focusedPaneId).toBe(right.id);
  });
  it("side 'start' puts the new pane first", () => {
    const l0 = layoutWith('a', 'b');
    const l = workspaceReducer(l0, { type: 'split_pane', paneId: l0.root.id, dir: 'col', side: 'start', moveTabId: 'b' });
    const [first] = (l.root as SplitNode).children as [PaneNode, PaneNode];
    expect(first.tabIds).toEqual(['b']);
  });
  it('is a no-op when moving the only tab of a pane (split would leave it empty)', () => {
    const l0 = layoutWith('a');
    const l = workspaceReducer(l0, { type: 'split_pane', paneId: l0.root.id, dir: 'row', side: 'end', moveTabId: 'a' });
    expect(l).toBe(l0);
  });
  it('splits without moving a tab (empty new pane) when moveTabId is omitted', () => {
    const l0 = layoutWith('a');
    const l = workspaceReducer(l0, { type: 'split_pane', paneId: l0.root.id, dir: 'row', side: 'end' });
    const [, right] = (l.root as SplitNode).children as [PaneNode, PaneNode];
    expect(right.tabIds).toEqual([]);
    expect(right.activeTabId).toBeNull();
  });
});

describe('close_tab', () => {
  it('activates the last remaining tab of the pane', () => {
    let l = layoutWith('a', 'b', 'c');
    l = workspaceReducer(l, { type: 'set_active', paneId: l.root.id, tabId: 'c' });
    l = workspaceReducer(l, { type: 'close_tab', tabId: 'c' });
    expect((l.root as PaneNode).tabIds).toEqual(['a', 'b']);
    expect((l.root as PaneNode).activeTabId).toBe('b');
  });
  it('folds an emptied non-root pane back into its sibling', () => {
    let l = layoutWith('a', 'b');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    l = workspaceReducer(l, { type: 'close_tab', tabId: 'b' });
    expect(l.root.kind).toBe('pane');
    expect((l.root as PaneNode).tabIds).toEqual(['a']);
    expect(l.focusedPaneId).toBe(l.root.id);
  });
  it("leaves an empty root pane in place (quickstart resurrection is the caller's job)", () => {
    const l = workspaceReducer(layoutWith('a'), { type: 'close_tab', tabId: 'a' });
    expect(l.root.kind).toBe('pane');
    expect((l.root as PaneNode).tabIds).toEqual([]);
    expect((l.root as PaneNode).activeTabId).toBeNull();
  });
  it('folds nested splits correctly (close in a 3-pane tree)', () => {
    let l = layoutWith('a', 'b', 'c');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    const paneB = paneOfTab(l.root, 'b')!;
    // 'c' must belong to paneB before it can be split off from it.
    l = workspaceReducer(l, { type: 'move_tab', tabId: 'c', targetPaneId: paneB.id });
    l = workspaceReducer(l, { type: 'split_pane', paneId: paneB.id, dir: 'col', side: 'end', moveTabId: 'c' });
    expect(allPanes(l.root)).toHaveLength(3);
    l = workspaceReducer(l, { type: 'close_tab', tabId: 'c' }); // pane empties → depth-2 fold
    expect(allPanes(l.root)).toHaveLength(2);
    expect(paneOfTab(l.root, 'b')).not.toBeNull();
    expect(paneOfTab(l.root, 'a')).not.toBeNull();
  });
  it('empty panes created by split_pane persist across unrelated tab closes', () => {
    // Create empty pane via split without moveTabId
    let l = layoutWith('a', 'b');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end' });
    expect(allPanes(l.root)).toHaveLength(2);
    const emptyPaneId = allPanes(l.root).find(p => p.tabIds.length === 0)!.id;
    // Close a tab in the other pane — empty pane should still exist
    l = workspaceReducer(l, { type: 'close_tab', tabId: 'b' });
    expect(allPanes(l.root)).toHaveLength(2);
    expect(findPane(l.root, emptyPaneId)).not.toBeNull();
  });
  it('closing a middle active tab activates its right-hand neighbor', () => {
    let l = layoutWith('a', 'b', 'c');
    l = workspaceReducer(l, { type: 'set_active', paneId: l.root.id, tabId: 'b' });
    l = workspaceReducer(l, { type: 'close_tab', tabId: 'b' });
    expect((l.root as PaneNode).tabIds).toEqual(['a', 'c']);
    expect((l.root as PaneNode).activeTabId).toBe('c');
  });
});

describe('close_many', () => {
  it('closes all listed tabs and folds emptied panes', () => {
    let l = layoutWith('a', 'b', 'c');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'c' });
    l = workspaceReducer(l, { type: 'close_many', tabIds: ['b', 'c'] });
    expect(l.root.kind).toBe('pane');
    expect(allTabIds(l)).toEqual(['a']);
  });
});

describe('move_tab', () => {
  it('moves a tab to another pane, activates and focuses it there', () => {
    let l = layoutWith('a', 'b', 'c');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'c' });
    const target = paneOfTab(l.root, 'c')!;
    l = workspaceReducer(l, { type: 'move_tab', tabId: 'b', targetPaneId: target.id });
    expect(paneOfTab(l.root, 'b')!.id).toBe(target.id);
    expect(findPane(l.root, target.id)!.tabIds).toEqual(['c', 'b']);
    expect(findPane(l.root, target.id)!.activeTabId).toBe('b');
    expect(l.focusedPaneId).toBe(target.id);
  });
  it('folds the source pane when the move empties it', () => {
    let l = layoutWith('a', 'b');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    const sourceB = paneOfTab(l.root, 'b')!;
    const targetA = paneOfTab(l.root, 'a')!;
    l = workspaceReducer(l, { type: 'move_tab', tabId: 'b', targetPaneId: targetA.id });
    expect(l.root.kind).toBe('pane');
    expect((l.root as PaneNode).tabIds).toEqual(['a', 'b']);
    expect(findPane(l.root, sourceB.id)).toBeNull();
  });
  it('reorders within the same pane using index', () => {
    let l = layoutWith('a', 'b', 'c');
    l = workspaceReducer(l, { type: 'move_tab', tabId: 'c', targetPaneId: l.root.id, index: 0 });
    expect((l.root as PaneNode).tabIds).toEqual(['c', 'a', 'b']);
  });
});

describe('resize_split', () => {
  it('sets and clamps the ratio to [0.15, 0.85]', () => {
    let l = layoutWith('a', 'b');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    const splitId = (l.root as SplitNode).id;
    expect((workspaceReducer(l, { type: 'resize_split', splitId, ratio: 0.3 }).root as SplitNode).ratio).toBe(0.3);
    expect((workspaceReducer(l, { type: 'resize_split', splitId, ratio: 0.01 }).root as SplitNode).ratio).toBe(0.15);
    expect((workspaceReducer(l, { type: 'resize_split', splitId, ratio: 0.99 }).root as SplitNode).ratio).toBe(0.85);
  });
});

describe('rename_tab', () => {
  it('rewrites the id everywhere including activeTabId', () => {
    let l = layoutWith('conn.db.old');
    l = workspaceReducer(l, { type: 'rename_tab', oldId: 'conn.db.old', newId: 'conn.db.new' });
    expect((l.root as PaneNode).tabIds).toEqual(['conn.db.new']);
    expect((l.root as PaneNode).activeTabId).toBe('conn.db.new');
  });
});

describe('stateless id minting (#197)', () => {
  it('mints ids by scanning the tree, not filling gaps: closing pane-3 in a tree that still has pane-7 mints pane-8', () => {
    // A tree "loaded" from a fixture already containing pane-7 / split-2.
    // pane-3 (a leaf under split-2) gets closed down to nothing and folds
    // away, leaving a gap at 3 — the next mint must still skip past the
    // highest surviving suffix (7), not reuse the gap.
    const layout: WorkspaceLayout = {
      focusedPaneId: 'pane-3',
      root: {
        kind: 'split',
        id: 'split-2',
        dir: 'row',
        ratio: 0.5,
        children: [
          { kind: 'pane', id: 'pane-3', tabIds: ['x'], activeTabId: 'x' },
          { kind: 'pane', id: 'pane-7', tabIds: ['a', 'b'], activeTabId: 'b' },
        ],
      },
    };
    const closed = workspaceReducer(layout, { type: 'close_tab', tabId: 'x' });
    // pane-3 emptied and folded into its sibling: only pane-7 remains.
    expect(closed.root).toEqual({ kind: 'pane', id: 'pane-7', tabIds: ['a', 'b'], activeTabId: 'b' });
    const l = workspaceReducer(closed, {
      type: 'split_pane', paneId: 'pane-7', dir: 'row', side: 'end', moveTabId: 'b',
    });
    const paneIds = allPanes(l.root).map(p => p.id);
    expect(paneIds).toContain('pane-8'); // max-scan past pane-7, NOT a reused pane-3/pane-4 gap
    // split-2 folded away along with pane-3 — the tree holds no split node at
    // all once pane-3 empties, so this new split starts a fresh sequence.
    expect((l.root as SplitNode).id).toBe('split-1');
  });

  it('a single split on a fresh tree mints pane-2 AND split-1 from one scan, without the two mints colliding', () => {
    // Edge case: split_pane mints a pane id AND a split id within the same
    // reducer call. Both must be computed from the SAME pristine tree — if
    // the split-id scan ran against a tree that already contained the
    // freshly-minted pane, or ignored the id-kind prefix, it could
    // misfire (e.g. minting split-2/split-3 instead of split-1).
    const layout = layoutWith('a', 'b'); // root is pane-1
    const l = workspaceReducer(layout, {
      type: 'split_pane', paneId: layout.root.id, dir: 'row', side: 'end', moveTabId: 'b',
    });
    const root = l.root as SplitNode;
    expect(root.id).toBe('split-1');
    const paneIds = allPanes(root).map(p => p.id);
    expect(paneIds).toEqual(['pane-1', 'pane-2']);
  });

  it('reducing the same (layout, action) twice from the same input yields deep-equal results, including minted ids', () => {
    // Shape of React 18 StrictMode's double-invoke of a reducer, and of
    // App.tsx's dispatchWorkspace no-op mirror gate running a discardable
    // "trial" reducer call ahead of the real render-time one — both call
    // the reducer more than once against the identical starting layout and
    // must get back identical results each time, ids included.
    const layout = layoutWith('a', 'b');
    const action = {
      type: 'split_pane' as const, paneId: layout.root.id, dir: 'row' as const, side: 'end' as const, moveTabId: 'b',
    };
    const first = workspaceReducer(layout, action);
    const second = workspaceReducer(layout, action);
    expect(second).toEqual(first);
  });
});

describe('hydrate', () => {
  it('replaces the layout wholesale', () => {
    const incoming: WorkspaceLayout = {
      focusedPaneId: 'pane-7',
      root: { kind: 'pane', id: 'pane-7', tabIds: ['a', 'b'], activeTabId: 'a' },
    };
    const l = workspaceReducer(layoutWith('placeholder'), { type: 'hydrate', layout: incoming });
    expect(l).toEqual(incoming);
  });

  it('a later split after hydrate mints past the incoming layout, never colliding with it', () => {
    const incoming: WorkspaceLayout = {
      focusedPaneId: 'pane-7',
      root: { kind: 'pane', id: 'pane-7', tabIds: ['a', 'b'], activeTabId: 'a' },
    };
    let l = workspaceReducer(layoutWith('placeholder'), { type: 'hydrate', layout: incoming });
    l = workspaceReducer(l, { type: 'split_pane', paneId: 'pane-7', dir: 'row', side: 'end', moveTabId: 'b' });
    const paneIds = allPanes(l.root).map(p => p.id);
    expect(paneIds).toContain('pane-8'); // scanned past the incoming pane-7
    expect(paneIds).not.toContain('pane-1'); // would collide if minting had reset to a fresh counter
  });
});

describe('robustness', () => {
  it('unknown ids are no-ops returning the same reference', () => {
    const l = layoutWith('a');
    expect(workspaceReducer(l, { type: 'close_tab', tabId: 'nope' })).toBe(l);
    expect(workspaceReducer(l, { type: 'set_active', paneId: 'nope', tabId: 'a' })).toBe(l);
    expect(workspaceReducer(l, { type: 'move_tab', tabId: 'a', targetPaneId: 'nope' })).toBe(l);
    expect(workspaceReducer(l, { type: 'resize_split', splitId: 'nope', ratio: 0.5 })).toBe(l);
  });
});

// Phase 3 Task 4: used to translate a FOREIGN window's tree (received
// profile-space over `workspace-changed`) into this window's live id space
// before hydrating it locally.
describe('mapLayoutTabIds', () => {
  const upper = (id: string) => id.toUpperCase();

  it('rewrites every tab id in a single pane, leaving the pane id untouched', () => {
    const l = layoutWith('a', 'b');
    const mapped = mapLayoutTabIds(l, upper);
    expect((mapped.root as PaneNode).tabIds).toEqual(['A', 'B']);
    expect((mapped.root as PaneNode).activeTabId).toBe('A');
    expect(mapped.root.id).toBe(l.root.id); // pane id untouched
    expect(mapped.focusedPaneId).toBe(l.focusedPaneId);
  });

  it('rewrites tab ids in both children of a split, leaving split/pane ids and structure untouched', () => {
    let l = layoutWith('a', 'b');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    const mapped = mapLayoutTabIds(l, upper);
    const [left, right] = (mapped.root as SplitNode).children as [PaneNode, PaneNode];
    expect(left.tabIds).toEqual(['A']);
    expect(right.tabIds).toEqual(['B']);
    expect(right.activeTabId).toBe('B');
    expect(mapped.root.id).toBe(l.root.id);
    expect((left as PaneNode).id).toBe(((l.root as SplitNode).children[0] as PaneNode).id);
  });

  it('a null activeTabId (empty pane) stays null, never passed through fn', () => {
    const empty: WorkspaceLayout = { root: { kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null }, focusedPaneId: 'pane-1' };
    const mapped = mapLayoutTabIds(empty, upper);
    expect((mapped.root as PaneNode).activeTabId).toBeNull();
    expect((mapped.root as PaneNode).tabIds).toEqual([]);
  });

  it('an identity fn produces a structurally-equal (but not reference-equal) layout', () => {
    const l = layoutWith('a', 'b');
    const mapped = mapLayoutTabIds(l, (id) => id);
    expect(mapped).toEqual(l);
    expect(mapped).not.toBe(l);
  });
});
