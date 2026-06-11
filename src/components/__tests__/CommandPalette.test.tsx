import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette, type PaletteAction } from '../CommandPalette';

const makeActions = (): { actions: PaletteAction[]; ran: string[] } => {
  const ran: string[] = [];
  const actions: PaletteAction[] = [
    { id: 'theme', title: 'Toggle Theme', run: () => ran.push('theme') },
    { id: 'settings', title: 'Open Settings', run: () => ran.push('settings') },
    { id: 'shell', title: 'Open Shell', hint: 'shop.users', keywords: 'mongosh terminal', run: () => ran.push('shell') },
  ];
  return { actions, ran };
};

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { actions } = makeActions();
    render(<CommandPalette open={false} onClose={() => {}} actions={actions} />);
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('lists all actions when open with an empty query', () => {
    const { actions } = makeActions();
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    expect(screen.getByText('Toggle Theme')).toBeTruthy();
    expect(screen.getByText('Open Settings')).toBeTruthy();
    expect(screen.getByText('Open Shell')).toBeTruthy();
  });

  it('filters actions by title', () => {
    const { actions } = makeActions();
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'theme' } });
    expect(screen.getByText('Toggle Theme')).toBeTruthy();
    expect(screen.queryByText('Open Settings')).toBeNull();
  });

  it('matches keywords too', () => {
    const { actions } = makeActions();
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'mongosh' } });
    expect(screen.getByText('Open Shell')).toBeTruthy();
    expect(screen.queryByText('Toggle Theme')).toBeNull();
  });

  it('runs the selected action and closes on Enter', () => {
    const { actions, ran } = makeActions();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} actions={actions} />);
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Enter' });
    expect(ran).toEqual(['theme']);
    expect(onClose).toHaveBeenCalled();
  });

  it('moves the selection with arrow keys', () => {
    const { actions, ran } = makeActions();
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    const input = screen.getByTestId('command-palette-input');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ran).toEqual(['settings']);
  });

  it('closes on Escape without running anything', () => {
    const { actions, ran } = makeActions();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} actions={actions} />);
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(ran).toEqual([]);
  });

  it('runs an action on click', () => {
    const { actions, ran } = makeActions();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} actions={actions} />);
    fireEvent.click(screen.getByText('Open Settings'));
    expect(ran).toEqual(['settings']);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the hint when provided', () => {
    const { actions } = makeActions();
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    expect(screen.getByText('shop.users')).toBeTruthy();
  });
});

describe('CommandPalette ranking', () => {
  it('ranks stronger matches first (prefix beats subsequence)', () => {
    const actions: PaletteAction[] = [
      { id: 'a', title: 'Disconnect server', run: () => {} },
      { id: 'b', title: 'Settings', run: () => {} },
    ];
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'set' } });
    const options = screen.getAllByRole('option');
    expect(options[0].textContent).toContain('Settings');
  });

  it('keeps the original order on an empty query', () => {
    const actions: PaletteAction[] = [
      { id: 'a', title: 'Zeta', run: () => {} },
      { id: 'b', title: 'Alpha', run: () => {} },
    ];
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    const options = screen.getAllByRole('option');
    expect(options[0].textContent).toContain('Zeta');
  });
});
