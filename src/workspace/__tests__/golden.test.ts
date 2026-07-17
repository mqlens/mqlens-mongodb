import { describe, it, expect } from 'vitest';
import goldenFixture from '../../../fixtures/workspace-golden.json';
import {
  workspaceReducer,
  type WorkspaceLayout,
  type WorkspaceAction,
  type LayoutNode,
  type SplitDir,
  type SplitSide,
} from '../model';

// Golden parity vectors shared with the Rust reducer (src-tauri/src/workspace.rs,
// `mod tests` — the `golden_*` tests read the same fixture). This runner
// asserts the LAYOUT half only (splitTree + focusedPaneId): `revision` and
// `tabs[]` are Rust-only bookkeeping with no TS equivalent (the frontend
// keeps QueryTab[] in App, not in this reducer) — the Rust runner asserts
// those against the same fixture's `expected`.

interface RawOp {
  type: string;
  pane_id?: string;
  tab_id?: string;
  tab_ids?: string[];
  target_pane_id?: string;
  index?: number;
  dir?: SplitDir;
  side?: SplitSide;
  move_tab_id?: string;
  split_id?: string;
  ratio?: number;
  old_id?: string;
  new_id?: string;
  // `tab` (open_tab's TabModel payload) and `last_query`/`last_aggregate`/
  // `builder_state` (update_tab_state) are Rust-only tabs[] bookkeeping with
  // no TS reducer field — deliberately untyped/unused here.
}

interface FixtureWindow {
  id: string;
  focusedPaneId: string;
  splitTree: LayoutNode;
}

interface FixtureDoc {
  revision: number;
  windows: FixtureWindow[];
  tabs: unknown[];
}

interface Vector {
  name: string;
  initial: FixtureDoc;
  ops: RawOp[];
  expected: FixtureDoc;
}

const { vectors } = goldenFixture as unknown as { vectors: Vector[] };

function layoutOf(doc: FixtureDoc): WorkspaceLayout {
  const win = doc.windows[0];
  return { root: win.splitTree, focusedPaneId: win.focusedPaneId };
}

/** Maps a fixture op (snake_case type + keys, matching the Rust `WorkspaceOp`
 *  wire format exactly) to the TS reducer's camelCase action. `update_tab_state`
 *  has no TS equivalent — it only mutates Rust's tabs[] — so it maps to `null`,
 *  meaning "layout unchanged"; the Rust runner asserts its effects separately. */
function opToAction(op: RawOp): WorkspaceAction | null {
  switch (op.type) {
    case 'open_tab':
      return { type: 'open_tab', tabId: op.tab_id!, paneId: op.pane_id };
    case 'close_tab':
      return { type: 'close_tab', tabId: op.tab_id! };
    case 'close_many':
      return { type: 'close_many', tabIds: op.tab_ids! };
    case 'move_tab':
      return { type: 'move_tab', tabId: op.tab_id!, targetPaneId: op.target_pane_id!, index: op.index };
    case 'split_pane':
      return { type: 'split_pane', paneId: op.pane_id!, dir: op.dir!, side: op.side!, moveTabId: op.move_tab_id };
    case 'resize_split':
      return { type: 'resize_split', splitId: op.split_id!, ratio: op.ratio! };
    case 'set_active':
      return { type: 'set_active', paneId: op.pane_id!, tabId: op.tab_id! };
    case 'focus_pane':
      return { type: 'focus_pane', paneId: op.pane_id! };
    case 'rename_tab':
      return { type: 'rename_tab', oldId: op.old_id!, newId: op.new_id! };
    case 'update_tab_state':
      return null;
    default:
      throw new Error(`golden.test.ts: unhandled op type "${op.type}"`);
  }
}

describe('workspace golden parity vectors (layout half)', () => {
  it('fixture parses into an array of vectors', () => {
    expect(Array.isArray(vectors)).toBe(true);
  });

  for (const vector of vectors) {
    it(vector.name, () => {
      let layout = layoutOf(vector.initial);
      for (const op of vector.ops) {
        const action = opToAction(op);
        if (action) layout = workspaceReducer(layout, action);
      }
      expect(layout).toEqual(layoutOf(vector.expected));
    });
  }
});
