// Pure workspace layout tree: panes hold tab IDs (the flat QueryTab[] stays in
// App). Action names mirror the future backend workspace_apply ops (see
// docs/superpowers/specs/2026-07-16-multi-panel-workspace-design.md) so Phase 2
// can lift this reducer server-side without renaming anything.

export type SplitDir = 'row' | 'col';
export type SplitSide = 'start' | 'end';

export interface PaneNode {
  kind: 'pane';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SplitNode {
  kind: 'split';
  id: string;
  dir: SplitDir;
  ratio: number; // share of the first child, clamped to [0.15, 0.85]
  children: [LayoutNode, LayoutNode];
}

export type LayoutNode = PaneNode | SplitNode;

export interface WorkspaceLayout {
  root: LayoutNode;
  focusedPaneId: string;
}

export type WorkspaceAction =
  | { type: 'open_tab'; tabId: string; paneId?: string }
  | { type: 'close_tab'; tabId: string }
  | { type: 'close_many'; tabIds: string[] }
  | { type: 'move_tab'; tabId: string; targetPaneId: string; index?: number }
  | { type: 'split_pane'; paneId: string; dir: SplitDir; side: SplitSide; moveTabId?: string }
  | { type: 'resize_split'; splitId: string; ratio: number }
  | { type: 'set_active'; paneId: string; tabId: string }
  | { type: 'focus_pane'; paneId: string }
  | { type: 'rename_tab'; oldId: string; newId: string }
  // Frontend-only: replaces the whole layout wholesale (Phase 2 Task 6 restore-
  // on-boot). There is no backend `workspace_apply` op for this — App.tsx MUST
  // dispatch it via raw `dispatchLayout`, never through the mirrored
  // `dispatchWorkspace` choke point (see App.tsx's restore effect for why).
  | { type: 'hydrate'; layout: WorkspaceLayout };

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

/** Port of Rust's `max_numeric_suffix` (workspace.rs): the highest numeric
 *  suffix among ids sharing `prefix` (e.g. `"pane-"` or `"split-"`) anywhere
 *  in the tree, regardless of node kind — ids of the other kind never share
 *  a prefix so they simply don't match. */
function maxNumericSuffix(node: LayoutNode, prefix: string): number {
  const suffix = node.id.startsWith(prefix) ? node.id.slice(prefix.length) : '';
  const parsed = /^\d+$/.test(suffix) ? Number(suffix) : NaN;
  let best = Number.isNaN(parsed) ? 0 : parsed;
  if (node.kind === 'split') {
    for (const child of node.children) best = Math.max(best, maxNumericSuffix(child, prefix));
  }
  return best;
}

/**
 * Mint `pane-N` / `split-N` ids by scanning the live tree for the current max
 * suffix at call time, rather than keeping module-level counters. Port of
 * Rust's `next_pane_id`/`next_split_id` (workspace.rs) — deliberately
 * stateless, by construction identical to the backend (#197).
 *
 * WHY stateless: a mutable counter mints a *new* id on every call, so
 * calling the reducer twice with the same input (React 18 StrictMode's
 * double-invoke of reducers/effects in dev, or App.tsx's `dispatchWorkspace`
 * no-op mirror gate running a discardable "trial" reducer call before the
 * real render-time one) used to mint two different ids from one logical
 * action — the trial's mint got thrown away, but the counter didn't know
 * that, so the real application minted one generation ahead of what a
 * single reducer call would have produced, desyncing from the backend's own
 * single mint per op. Scanning the tree instead makes minting a pure
 * function of the input layout: the same (layout, action) pair always mints
 * the same id, no matter how many times or in what order it's evaluated, so
 * double-invokes and trial runs are naturally idempotent with no bracketing
 * needed. Nothing to seed on load or reset between tests either, since
 * there's no state to seed or reset.
 */
function nextPaneId(root: LayoutNode): string {
  return `pane-${maxNumericSuffix(root, 'pane-') + 1}`;
}

function nextSplitId(root: LayoutNode): string {
  return `split-${maxNumericSuffix(root, 'split-') + 1}`;
}

export function createInitialLayout(tabIds: string[], activeTabId: string | null): WorkspaceLayout {
  // No tree to scan yet — this call builds the very first node. Hardcoded
  // like Rust's `default_window()`, which likewise hardcodes `"pane-1"`
  // rather than scanning an empty tree.
  const pane: PaneNode = { kind: 'pane', id: 'pane-1', tabIds: [...tabIds], activeTabId };
  return { root: pane, focusedPaneId: pane.id };
}

export function allPanes(node: LayoutNode): PaneNode[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap(allPanes);
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  return allPanes(node).find(p => p.id === paneId) ?? null;
}

export function paneOfTab(node: LayoutNode, tabId: string): PaneNode | null {
  return allPanes(node).find(p => p.tabIds.includes(tabId)) ?? null;
}

export function allTabIds(layout: WorkspaceLayout): string[] {
  return allPanes(layout.root).flatMap(p => p.tabIds);
}

/** Replace the pane with the given id via fn; fn returning null folds the pane
 *  (its parent split collapses into the sibling). Root panes never fold. */
function mapPane(node: LayoutNode, paneId: string, fn: (p: PaneNode) => PaneNode | null): LayoutNode {
  if (node.kind === 'pane') {
    if (node.id !== paneId) return node;
    return fn(node) ?? node; // root-level fold is ignored: root pane persists
  }
  const [a, b] = node.children;
  const paneIn = (n: LayoutNode): boolean => findPane(n, paneId) !== null;
  if (paneIn(a)) {
    if (a.kind === 'pane' && a.id === paneId) {
      const next = fn(a);
      if (next === null) return b; // fold: parent split replaced by sibling
      return { ...node, children: [next, b] };
    }
    return { ...node, children: [mapPane(a, paneId, fn), b] };
  }
  if (paneIn(b)) {
    if (b.kind === 'pane' && b.id === paneId) {
      const next = fn(b);
      if (next === null) return a;
      return { ...node, children: [a, next] };
    }
    return { ...node, children: [a, mapPane(b, paneId, fn)] };
  }
  return node;
}

function withFocusRepaired(layout: WorkspaceLayout): WorkspaceLayout {
  if (findPane(layout.root, layout.focusedPaneId)) return layout;
  return { ...layout, focusedPaneId: allPanes(layout.root)[0].id };
}

function removeTabFromPane(pane: PaneNode, tabId: string): PaneNode | null {
  const idx = pane.tabIds.indexOf(tabId);
  if (idx === -1) return pane;
  const tabIds = pane.tabIds.filter(id => id !== tabId);
  if (tabIds.length === 0) return null; // request fold (ignored at root)
  const activeTabId =
    pane.activeTabId === tabId ? tabIds[Math.min(idx, tabIds.length - 1)] : pane.activeTabId;
  return { ...pane, tabIds, activeTabId };
}

function closeTab(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const pane = paneOfTab(layout.root, tabId);
  if (!pane) return layout;
  let root = mapPane(layout.root, pane.id, p => removeTabFromPane(p, tabId));
  if (root === layout.root && pane.tabIds.length === 1 && pane.tabIds[0] === tabId) {
    // Root pane emptied: keep the pane, clear it.
    root = { ...pane, tabIds: [], activeTabId: null };
  }
  return withFocusRepaired({ ...layout, root });
}

export function workspaceReducer(layout: WorkspaceLayout, action: WorkspaceAction): WorkspaceLayout {
  switch (action.type) {
    case 'open_tab': {
      const existing = paneOfTab(layout.root, action.tabId);
      if (existing) {
        const root = mapPane(layout.root, existing.id, p => ({ ...p, activeTabId: action.tabId }));
        return { root, focusedPaneId: existing.id };
      }
      const targetId =
        (action.paneId && findPane(layout.root, action.paneId)?.id) || layout.focusedPaneId;
      const root = mapPane(layout.root, targetId, p => ({
        ...p,
        tabIds: [...p.tabIds, action.tabId],
        activeTabId: action.tabId,
      }));
      return { root, focusedPaneId: targetId };
    }

    case 'close_tab':
      return closeTab(layout, action.tabId);

    case 'close_many':
      return action.tabIds.reduce(closeTab, layout);

    case 'move_tab': {
      const source = paneOfTab(layout.root, action.tabId);
      const target = findPane(layout.root, action.targetPaneId);
      if (!source || !target) return layout;
      if (source.id === target.id) {
        // Reorder within the pane.
        const without = source.tabIds.filter(id => id !== action.tabId);
        const at = Math.min(action.index ?? without.length, without.length);
        const tabIds = [...without.slice(0, at), action.tabId, ...without.slice(at)];
        const root = mapPane(layout.root, source.id, p => ({ ...p, tabIds }));
        return { ...layout, root };
      }
      let root = mapPane(layout.root, source.id, p => removeTabFromPane(p, action.tabId));
      // Source may have folded; the target pane still exists (folding only
      // removes the emptied pane itself).
      root = mapPane(root, target.id, p => {
        const at = Math.min(action.index ?? p.tabIds.length, p.tabIds.length);
        return {
          ...p,
          tabIds: [...p.tabIds.slice(0, at), action.tabId, ...p.tabIds.slice(at)],
          activeTabId: action.tabId,
        };
      });
      return withFocusRepaired({ root, focusedPaneId: target.id });
    }

    case 'split_pane': {
      const pane = findPane(layout.root, action.paneId);
      if (!pane) return layout;
      if (action.moveTabId && pane.tabIds.length === 1 && pane.tabIds[0] === action.moveTabId) {
        return layout; // would empty the source pane — pointless split
      }
      const moving = action.moveTabId && pane.tabIds.includes(action.moveTabId) ? action.moveTabId : undefined;
      // Both ids are minted up front from the pristine, pre-split `layout.root`
      // — not lazily inside the `mapPane` callback below — so the split-id
      // scan can never observe the pane just minted a line above (or vice
      // versa). Matches Rust's `apply` (workspace.rs), which computes
      // `next_pane_id(root)` then `next_split_id(root)` the same way, both
      // before `map_pane` runs. The two ids can never collide with each
      // other regardless of order since they scan disjoint prefixes
      // (`pane-` vs `split-`), but minting from the same untouched tree
      // keeps this obviously correct rather than incidentally correct.
      const freshId = nextPaneId(layout.root);
      const splitId = nextSplitId(layout.root);
      const fresh: PaneNode = {
        kind: 'pane',
        id: freshId,
        tabIds: moving ? [moving] : [],
        activeTabId: moving ?? null,
      };
      const root = mapPane(layout.root, pane.id, p => {
        const remaining = moving ? (removeTabFromPane(p, moving) as PaneNode) : p;
        const children: [LayoutNode, LayoutNode] =
          action.side === 'start' ? [fresh, remaining] : [remaining, fresh];
        // mapPane expects a PaneNode return; widen through a split wrapper:
        return { kind: 'split', id: splitId, dir: action.dir, ratio: 0.5, children } as unknown as PaneNode;
      });
      return { root, focusedPaneId: fresh.id };
    }

    case 'resize_split': {
      const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, action.ratio));
      let found = false;
      const visit = (node: LayoutNode): LayoutNode => {
        if (node.kind === 'pane') return node;
        if (node.id === action.splitId) {
          found = true;
          return { ...node, ratio: clamped };
        }
        return { ...node, children: [visit(node.children[0]), visit(node.children[1])] };
      };
      const root = visit(layout.root);
      return found ? { ...layout, root } : layout;
    }

    case 'set_active': {
      const pane = findPane(layout.root, action.paneId);
      if (!pane || !pane.tabIds.includes(action.tabId)) return layout;
      const root = mapPane(layout.root, action.paneId, p => ({ ...p, activeTabId: action.tabId }));
      return { root, focusedPaneId: action.paneId };
    }

    case 'focus_pane':
      return findPane(layout.root, action.paneId) ? { ...layout, focusedPaneId: action.paneId } : layout;

    case 'rename_tab': {
      const pane = paneOfTab(layout.root, action.oldId);
      if (!pane) return layout;
      const root = mapPane(layout.root, pane.id, p => ({
        ...p,
        tabIds: p.tabIds.map(id => (id === action.oldId ? action.newId : id)),
        activeTabId: p.activeTabId === action.oldId ? action.newId : p.activeTabId,
      }));
      return { ...layout, root };
    }

    case 'hydrate':
      // Nothing to seed: minting scans the live tree at call time (see
      // nextPaneId/nextSplitId above), so a later split_pane/open_tab after
      // this restore mints past whatever the incoming layout already
      // contains with no setup step required here.
      return action.layout;
  }
}
