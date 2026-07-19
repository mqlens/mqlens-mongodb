import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from '../ContextMenu';

describe('ContextMenu', () => {
  it('renders items and fires onClick then onClose', () => {
    const onClose = vi.fn();
    const edit = vi.fn();
    render(
      <ContextMenu
        x={10}
        y={10}
        items={[{ label: 'Edit', onClick: edit }, { label: 'Delete', onClick: () => {}, danger: true }]}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit'));
    expect(edit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={[{ label: 'X', onClick: () => {} }]} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('marks destructive items with the danger class', () => {
    render(<ContextMenu x={0} y={0} items={[{ label: 'Delete', onClick: () => {}, danger: true }]} onClose={() => {}} />);
    expect(screen.getByText('Delete').closest('button')).toHaveClass('is-danger');
  });

  it('renders an item\'s title as the native HTML tooltip attribute (Phase 3 Task 5)', () => {
    render(
      <ContextMenu
        x={0}
        y={0}
        items={[{ label: 'Can\'t move', onClick: () => {}, disabled: true, title: 'Explanation text' }]}
        onClose={() => {}}
      />,
    );
    const button = screen.getByText('Can\'t move').closest('button');
    expect(button).toHaveAttribute('title', 'Explanation text');
    expect(button).toBeDisabled();
  });
});
