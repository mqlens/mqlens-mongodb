import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { IndexViewer } from '../IndexViewer';
import { DialogProvider } from '../dialogs/DialogProvider';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

// IndexViewer uses the in-app confirm dialog, so render inside the provider.
const render = (ui: ReactElement) => rtlRender(<DialogProvider>{ui}</DialogProvider>);

describe('IndexViewer (T2)', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseProps = {
    connectionId: 'c1',
    databaseName: 'shop',
    collectionName: 'products',
    indexName: 'city_1',
  };

  it('renders the REAL index spec from list_indexes (C3/H4)', async () => {
    mockInvoke.mockResolvedValue([
      { name: 'city_1', keys: '{"city":1}', unique: true, sparse: false },
    ]);
    render(<IndexViewer {...baseProps} />);

    // Real key field + unique/sparse flags (not guessed from the name).
    expect(await screen.findByText('city')).toBeInTheDocument();
    expect(screen.getAllByText('Unique').length).toBeGreaterThan(0);
    expect(screen.getByText(/Non-sparse/)).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('list_indexes', {
      id: 'c1',
      db: 'shop',
      collection: 'products',
    });
  });

  it('shows an error state when the index cannot be loaded', async () => {
    mockInvoke.mockRejectedValue('boom');
    render(<IndexViewer {...baseProps} />);
    expect(await screen.findByTestId('index-viewer-error')).toBeInTheDocument();
  });

  it('deletes the index after the in-app confirm', async () => {
    mockInvoke.mockResolvedValue([
      { name: 'city_1', keys: '{"city":1}', unique: false, sparse: false },
    ]);
    const onDeleteIndex = vi.fn();
    render(<IndexViewer {...baseProps} onDeleteIndex={onDeleteIndex} />);

    fireEvent.click(await screen.findByTestId('delete-index-btn'));
    fireEvent.click(await screen.findByTestId('dialog-confirm'));

    await waitFor(() => expect(onDeleteIndex).toHaveBeenCalledWith('city_1'));
  });
});
