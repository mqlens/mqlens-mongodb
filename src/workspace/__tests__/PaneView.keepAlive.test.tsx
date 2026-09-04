import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutEffect, useReducer, useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceRoot } from '../WorkspaceRoot';
import { createInitialLayout, workspaceReducer, type PaneNode } from '../model';
import { useTabVisible } from '../tabVisibility';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';

/**
 * #240: a pane used to render only its active tab, so switching tabs unmounted
 * the whole subtree — taking the shell's session, the builder state, the chat
 * transcript and the results view with it. Four caches exist purely to rebuild
 * what that destroyed.
 *
 * These drive the real reducer, because the point is what happens across an
 * actual tab switch rather than what a prop does in isolation.
 */

/** Counts how many times each tab's content has been mounted. */
const mounts = new Map<string, number>();
/** Whether tab a's content was in the document at each commit, as seen by tab c — the one
 *  tab that stays mounted through the switch back to a under a budget of two. */
const aPresentAtCommit: boolean[] = [];

function Content({ tabId }: { tabId: string }) {
  const [typed, setTyped] = useState('');
  useState(() => mounts.set(tabId, (mounts.get(tabId) ?? 0) + 1));
  const tabVisible = useTabVisible();
  const [dialogOpen, setDialogOpen] = useState(false);
  useLayoutEffect(() => {
    if (tabId === 'c') aPresentAtCommit.push(document.querySelector('[data-testid="content-a"]') !== null);
  });
  return (
    <div data-testid={`content-${tabId}`} data-tab-visible={String(tabVisible)}>
      <input
        data-testid={`input-${tabId}`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      <button data-testid={`open-dialog-${tabId}`} onClick={() => setDialogOpen(true)}>
        open
      </button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogTitle>dialog of {tabId}</DialogTitle>
        </DialogContent>
      </Dialog>
      <DropdownMenu>
        <DropdownMenuTrigger data-testid={`open-menu-${tabId}`}>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>menu item of {tabId}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover>
        <PopoverTrigger data-testid={`open-popover-${tabId}`}>popover</PopoverTrigger>
        <PopoverContent>popover of {tabId}</PopoverContent>
      </Popover>
    </div>
  );
}

function Harness({
  tabIds,
  kinds = {},
  limits,
}: {
  tabIds: string[];
  kinds?: Record<string, string>;
  limits?: { shell: number; other: number };
}) {
  const [layout, dispatch] = useReducer(workspaceReducer, createInitialLayout(tabIds, tabIds[0]));
  return (
    <WorkspaceRoot
      layout={layout}
      dispatch={dispatch}
      tabsFor={(pane: PaneNode) =>
        pane.tabIds.map((id) => ({
          id,
          label: id.toUpperCase(),
          icon: null,
          kind: kinds[id] ?? 'collection',
        }))
      }
      renderTabContent={(tabId) => <Content tabId={tabId} />}
      renderEmptyPane={() => <div data-testid="empty-pane" />}
      keepAliveLimits={limits}
    />
  );
}

const switchTo = (id: string) => fireEvent.click(screen.getByText(id.toUpperCase()));
const visible = (id: string) => {
  const el = screen.getByTestId(`content-${id}`);
  return el.closest('[hidden]') === null;
};

describe('PaneView — inactive tabs stay mounted (#240)', () => {
  beforeEach(() => mounts.clear());

  it('keeps a tab’s state across a switch away and back', () => {
    render(<Harness tabIds={['a', 'b']} />);

    fireEvent.change(screen.getByTestId('input-a'), { target: { value: 'half typed' } });
    switchTo('b');
    switchTo('a');

    // The state itself, not a rebuilt copy: mounting once is what makes it the
    // same component instance the user was working in.
    expect((screen.getByTestId('input-a') as HTMLInputElement).value).toBe('half typed');
    expect(mounts.get('a')).toBe(1);
  });

  it('hides the inactive tab rather than removing it', () => {
    render(<Harness tabIds={['a', 'b']} />);
    switchTo('b');

    expect(screen.getByTestId('content-a')).toBeInTheDocument();
    expect(visible('a')).toBe(false);
    expect(visible('b')).toBe(true);
  });

  it('tells a kept tab whether it is on screen, so a polling view can pause', () => {
    // A hidden Monitoring or Watch tab would otherwise keep fetching for a
    // view nobody is looking at; `document.hidden` cannot tell it apart.
    render(<Harness tabIds={['a', 'b']} />);
    expect(screen.getByTestId('content-a').dataset.tabVisible).toBe('true');

    switchTo('b');
    expect(screen.getByTestId('content-a').dataset.tabVisible).toBe('false');
    expect(screen.getByTestId('content-b').dataset.tabVisible).toBe('true');

    switchTo('a');
    expect(screen.getByTestId('content-a').dataset.tabVisible).toBe('true');
  });

  it('closes a hidden tab’s dialog, and reopens it when the tab comes back', () => {
    // A dialog renders through a portal under document.body, outside the
    // hidden wrapper. Left open it would cover the tab the user switched to —
    // overlay, focus trap, and a confirmation acting for a tab nobody can see.
    render(<Harness tabIds={['a', 'b']} />);
    fireEvent.click(screen.getByTestId('open-dialog-a'));
    expect(screen.getByText('dialog of a')).toBeInTheDocument();

    switchTo('b');
    expect(screen.queryByText('dialog of a')).toBeNull();

    // The owner still has it open; showing the tab shows the dialog.
    switchTo('a');
    expect(screen.getByText('dialog of a')).toBeInTheDocument();
  });

  it('closes a hidden tab’s menu and popover, which portal out of the hidden wrapper too', () => {
    // Unlike a dialog these are closed for good: a menu that is gone from
    // under the pointer has no state worth bringing back.
    render(<Harness tabIds={['a', 'b']} />);

    fireEvent.pointerDown(screen.getByTestId('open-menu-a'), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(screen.getByText('menu item of a')).toBeInTheDocument();
    switchTo('b');
    expect(screen.queryByText('menu item of a')).toBeNull();
    switchTo('a');
    expect(screen.queryByText('menu item of a')).toBeNull();

    fireEvent.click(screen.getByTestId('open-popover-a'));
    expect(screen.getByText('popover of a')).toBeInTheDocument();
    switchTo('b');
    expect(screen.queryByText('popover of a')).toBeNull();
  });

  it('shows a tab that had fallen out of its budget on the very first paint', () => {
    // a was visited, then evicted by c under a budget of two. Selecting a again
    // finds it still listed in the pane's recency, further down; budgeting
    // that list as it stands leaves a out, and the pane paints empty once
    // before the effect that reorders recency catches up.
    render(<Harness tabIds={['a', 'b', 'c']} limits={{ shell: 2, other: 2 }} />);
    switchTo('b');
    switchTo('c');
    expect(screen.queryByTestId('content-a')).toBeNull();

    aPresentAtCommit.length = 0;
    switchTo('a');

    expect(screen.getByTestId('content-a')).toBeInTheDocument();
    expect(aPresentAtCommit.length).toBeGreaterThan(0);
    expect(aPresentAtCommit.every(Boolean)).toBe(true);
  });

  it('does not mount a tab until it has been visited', () => {
    render(<Harness tabIds={['a', 'b']} />);
    expect(screen.queryByTestId('content-b')).toBeNull();
    expect(mounts.get('b')).toBeUndefined();
  });

  it('drops the least recently used tab once the budget is full', () => {
    render(<Harness tabIds={['a', 'b', 'c']} limits={{ shell: 2, other: 2 }} />);
    switchTo('b');
    switchTo('c');

    // 'a' is the oldest of three with room for two, so it goes.
    expect(screen.queryByTestId('content-a')).toBeNull();
    expect(screen.getByTestId('content-b')).toBeInTheDocument();
    expect(screen.getByTestId('content-c')).toBeInTheDocument();
  });

  it('budgets shells apart, so opening shells does not evict collection tabs', () => {
    // An idle mongosh session measured ~272 MB against the local replica set —
    // two orders of magnitude more than a collection tab, which is why one
    // shared budget would be the wrong shape.
    render(
      <Harness
        tabIds={['c1', 's1', 's2', 's3']}
        kinds={{ s1: 'shell', s2: 'shell', s3: 'shell' }}
        limits={{ shell: 2, other: 3 }}
      />
    );
    switchTo('s1');
    switchTo('s2');
    switchTo('s3');

    // The collection tab survives three shells being opened after it...
    expect(screen.getByTestId('content-c1')).toBeInTheDocument();
    // ...and the shells are held to their own, smaller budget.
    expect(screen.getByTestId('content-s3')).toBeInTheDocument();
    expect(screen.getByTestId('content-s2')).toBeInTheDocument();
    expect(screen.queryByTestId('content-s1')).toBeNull();
  });
});
