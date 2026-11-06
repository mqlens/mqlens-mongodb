import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkDropDialog } from '../BulkDropDialog';
import { planBulkDrop } from '@/lib/bulkDrop';
import { itemKey } from '@/lib/treeSelection';

describe('BulkDropDialog', () => {
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
