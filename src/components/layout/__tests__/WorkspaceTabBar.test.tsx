import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceTabBar, type WorkspaceTab } from '../WorkspaceTabBar';

const tabs: WorkspaceTab[] = [
  { id: 'a', label: 'Alpha', icon: null },
  { id: 'b', label: 'Beta', icon: null },
];

function renderBar() {
  const onSelectTab = vi.fn();
  const onCloseTab = vi.fn();
  render(
    <WorkspaceTabBar tabs={tabs} activeTabId="a" onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
  );
  return { onSelectTab, onCloseTab };
}

describe('WorkspaceTabBar middle-click', () => {
  it('closes the tab on middle-click without selecting it', () => {
    const { onSelectTab, onCloseTab } = renderBar();
    fireEvent(
      screen.getByText('Beta'),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );
    expect(onCloseTab).toHaveBeenCalledExactlyOnceWith('b');
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it('ignores non-middle auxiliary clicks', () => {
    const { onCloseTab } = renderBar();
    fireEvent(
      screen.getByText('Beta'),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }),
    );
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it('does not close on a plain left click', () => {
    const { onSelectTab, onCloseTab } = renderBar();
    fireEvent.click(screen.getByText('Beta'));
    expect(onSelectTab).toHaveBeenCalledExactlyOnceWith('b');
    expect(onCloseTab).not.toHaveBeenCalled();
  });
});
