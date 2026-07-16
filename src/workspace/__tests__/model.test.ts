import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInitialLayout, workspaceReducer, findPane, paneOfTab, allPanes,
  allTabIds, resetLayoutIds, type WorkspaceLayout, type SplitNode, type PaneNode,
} from '../model';

const layoutWith = (...tabIds: string[]): WorkspaceLayout =>
  createInitialLayout(tabIds, tabIds[0] ?? null);

beforeEach(() => resetLayoutIds());

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

describe('robustness', () => {
  it('unknown ids are no-ops returning the same reference', () => {
    const l = layoutWith('a');
    expect(workspaceReducer(l, { type: 'close_tab', tabId: 'nope' })).toBe(l);
    expect(workspaceReducer(l, { type: 'set_active', paneId: 'nope', tabId: 'a' })).toBe(l);
    expect(workspaceReducer(l, { type: 'move_tab', tabId: 'a', targetPaneId: 'nope' })).toBe(l);
    expect(workspaceReducer(l, { type: 'resize_split', splitId: 'nope', ratio: 0.5 })).toBe(l);
  });
});
