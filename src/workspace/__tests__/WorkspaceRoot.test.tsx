import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceRoot } from '../WorkspaceRoot';
import { TAB_DRAG_MIME } from '../PaneView';
import {
  createInitialLayout, workspaceReducer, resetLayoutIds,
  type WorkspaceLayout, type PaneNode,
} from '../model';

const tabsFor = (pane: PaneNode) =>
  pane.tabIds.map(id => ({ id, label: id.toUpperCase(), icon: null }));

function renderLayout(layout: WorkspaceLayout, dispatch = vi.fn()) {
  render(
    <WorkspaceRoot
      layout={layout}
      dispatch={dispatch}
      tabsFor={tabsFor}
      renderTabContent={tabId => <div data-testid={`content-${tabId}`} />}
      renderEmptyPane={() => <div data-testid="empty-pane" />}
    />,
  );
  return dispatch;
}

beforeEach(() => resetLayoutIds());

describe('WorkspaceRoot', () => {
  it('renders a single pane with its active tab content', () => {
    renderLayout(createInitialLayout(['a', 'b'], 'a'));
    expect(screen.getByTestId('content-a')).toBeInTheDocument();
    expect(screen.queryByTestId('content-b')).toBeNull();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('renders both panes of a split with their own content simultaneously', () => {
    let l = createInitialLayout(['a', 'b'], 'a');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    renderLayout(l);
    expect(screen.getByTestId('content-a')).toBeInTheDocument();
    expect(screen.getByTestId('content-b')).toBeInTheDocument();
  });

  it('renders the empty-pane slot for an empty root pane', () => {
    renderLayout(createInitialLayout([], null));
    expect(screen.getByTestId('empty-pane')).toBeInTheDocument();
  });

  it('dispatches set_active when a tab is clicked', () => {
    const l = createInitialLayout(['a', 'b'], 'a');
    const dispatch = renderLayout(l);
    fireEvent.click(screen.getByText('B'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'set_active', paneId: l.root.id, tabId: 'b' });
  });

  it('dispatches focus_pane on pane mousedown when multiple panes exist', () => {
    let l = createInitialLayout(['a', 'b'], 'a');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    const dispatch = renderLayout(l);
    fireEvent.mouseDown(screen.getByTestId('content-a'));
    const paneA = (l.root as any).children[0] as PaneNode;
    expect(dispatch).toHaveBeenCalledWith({ type: 'focus_pane', paneId: paneA.id });
  });

  it('dispatches split_pane when a tab is dropped on a pane edge zone', () => {
    const l = createInitialLayout(['a', 'b'], 'a');
    const dispatch = renderLayout(l);
    const pane = screen.getByTestId(`pane-${l.root.id}`);
    const data: Record<string, string> = { [TAB_DRAG_MIME]: 'b' };
    const dt = {
      getData: (k: string) => data[k] ?? '',
      setData: (k: string, v: string) => { data[k] = v; },
      types: [TAB_DRAG_MIME],
    };
    // Right-edge drop: clientX at 95% of the pane width.
    Object.defineProperty(pane, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 }),
    });
    fireEvent.dragOver(pane, { dataTransfer: dt, clientX: 950, clientY: 250 });
    fireEvent.drop(pane, { dataTransfer: dt, clientX: 950, clientY: 250 });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b',
    });
  });

  it('dispatches move_tab when a tab is dropped on the pane center', () => {
    let l = createInitialLayout(['a', 'b'], 'a');
    l = workspaceReducer(l, { type: 'split_pane', paneId: l.root.id, dir: 'row', side: 'end', moveTabId: 'b' });
    const dispatch = renderLayout(l);
    const paneA = (l.root as any).children[0] as PaneNode;
    const paneB = (l.root as any).children[1] as PaneNode;
    const el = screen.getByTestId(`pane-${paneA.id}`);
    const data: Record<string, string> = { [TAB_DRAG_MIME]: 'b' };
    const dt = { getData: (k: string) => data[k] ?? '', setData: () => {}, types: [TAB_DRAG_MIME] };
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 }),
    });
    fireEvent.dragOver(el, { dataTransfer: dt, clientX: 500, clientY: 250 });
    fireEvent.drop(el, { dataTransfer: dt, clientX: 500, clientY: 250 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'move_tab', tabId: 'b', targetPaneId: paneA.id });
    void paneB;
  });

  it('dispatches move_tab exactly once when a tab is dropped on the tab strip, without the drop bubbling into a pane split zone', () => {
    const l = createInitialLayout(['a', 'b'], 'a');
    const dispatch = renderLayout(l);
    const pane = screen.getByTestId(`pane-${l.root.id}`);
    const strip = screen.getByTestId('workspace-tab-strip');
    const data: Record<string, string> = { [TAB_DRAG_MIME]: 'b' };
    const dt = {
      getData: (k: string) => data[k] ?? '',
      setData: (k: string, v: string) => { data[k] = v; },
      types: [TAB_DRAG_MIME],
    };
    // The strip sits in the top ~36px of the pane, which is within the pane's
    // top 20% edge zone at this stubbed size — if the drop were to bubble up
    // to the pane's own onDrop, zoneFor would compute 'top' and dispatch a
    // split_pane in addition to (or instead of) the strip's move_tab.
    Object.defineProperty(pane, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 }),
    });
    fireEvent.dragOver(strip, { dataTransfer: dt, clientX: 500, clientY: 10 });
    fireEvent.drop(strip, { dataTransfer: dt, clientX: 500, clientY: 10 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'move_tab', tabId: 'b', targetPaneId: l.root.id });
  });

  it('ignores foreign (OS file) drags on the tab strip: no preventDefault on dragOver, no dispatch on drop', () => {
    const l = createInitialLayout(['a', 'b'], 'a');
    const dispatch = renderLayout(l);
    const strip = screen.getByTestId('workspace-tab-strip');
    // A real OS file drag: no TAB_DRAG_MIME entry in dataTransfer.types.
    const dt = { getData: () => '', setData: () => {}, types: ['Files'] };
    // dispatchEvent (which fireEvent returns) is true only when the cancelable
    // event was NOT preventDefault()'d — i.e. the strip let this foreign drag pass.
    const notPrevented = fireEvent.dragOver(strip, { dataTransfer: dt, clientX: 500, clientY: 10 });
    expect(notPrevented).toBe(true);
    fireEvent.drop(strip, { dataTransfer: dt, clientX: 500, clientY: 10 });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
