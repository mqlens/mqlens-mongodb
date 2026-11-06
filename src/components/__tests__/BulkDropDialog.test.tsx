import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BulkDropDialog } from '../BulkDropDialog';
import { planBulkDrop } from '@/lib/bulkDrop';
import { itemKey } from '@/lib/treeSelection';

describe('BulkDropDialog', () => {
  const longName = `orders_${'archive_'.repeat(12)}2024`;
  const renderPlan = () =>
    render(
      <BulkDropDialog
        connectionName="Prod"
        plan={planBulkDrop([itemKey('shop'), itemKey('shop', 'carts'), itemKey('admin'), itemKey('crm', longName)])}
        run={() => Promise.resolve([])}
        onClose={() => {}}
      />,
    );

  it('keeps the covered and skipped notes inside the scrolling list, so the controls stay on screen', () => {
    renderPlan();
    const list = screen.getByTestId('bulk-drop-list');
    expect(list).toHaveClass('overflow-y-auto');
    expect(within(list).getByTestId('bulk-drop-covered')).toBeInTheDocument();
    expect(within(list).getByTestId('bulk-drop-excluded')).toBeInTheDocument();
  });

  it('wraps long names in full rather than cutting them off', () => {
    renderPlan();
    const name = screen.getByText(longName);
    expect(name).not.toHaveClass('truncate');
    expect(name).toHaveClass('break-all');
  });

  it('can still be closed when the run itself throws', async () => {
    const onClose = vi.fn();
    render(
      <BulkDropDialog
        connectionName="Prod"
        plan={planBulkDrop([itemKey('a'), itemKey('b')])}
        run={() => Promise.reject(new Error('boom'))}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByTestId('bulk-drop-confirm-input'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('bulk-drop-confirm'));
    await waitFor(() => expect(screen.getByTestId('bulk-drop-close')).toBeEnabled());
    // Nothing is reported as dropped that may not have been.
    expect(screen.getByTestId('bulk-drop-summary')).toHaveTextContent('2 of 2 failed');
    expect(screen.getAllByText('Error: boom')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('bulk-drop-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
