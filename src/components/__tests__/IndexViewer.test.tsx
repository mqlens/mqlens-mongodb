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

  const CITY_INDEX = { name: 'city_1', keys: '{"city":1}', unique: true, sparse: false };

  // Routes invoke calls by command name so list_indexes and index_stats can
  // each return their own shape (a single mockResolvedValue would make
  // index_stats resolve with the list_indexes payload and vice versa).
  const mockInvokeByCommand = (handlers: Record<string, any>) => {
    mockInvoke.mockImplementation((cmd: string) => {
      const handler = handlers[cmd];
      if (handler === undefined) return Promise.resolve([]);
      if (handler instanceof Error || handler === 'reject') return Promise.reject(handler);
      return Promise.resolve(handler);
    });
  };

  it('renders the REAL index spec from list_indexes (C3/H4)', async () => {
    mockInvokeByCommand({ list_indexes: [CITY_INDEX], index_stats: [] });
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
    mockInvokeByCommand({ list_indexes: [{ ...CITY_INDEX, unique: false }], index_stats: [] });
    const onDeleteIndex = vi.fn();
    render(<IndexViewer {...baseProps} onDeleteIndex={onDeleteIndex} />);

    fireEvent.click(await screen.findByTestId('delete-index-btn'));
    fireEvent.click(await screen.findByTestId('dialog-confirm'));

    await waitFor(() => expect(onDeleteIndex).toHaveBeenCalledWith('city_1'));
  });

  it('fetches index_stats and renders Size + Usage cards for the matching index', async () => {
    mockInvokeByCommand({
      list_indexes: [CITY_INDEX],
      index_stats: [
        { name: 'city_1', sizeBytes: 16_384, ops: 4_200, sinceMs: 1_749_427_200_000 },
        { name: 'other_1', sizeBytes: 999, ops: 1, sinceMs: 1_749_427_200_000 },
      ],
    });
    render(<IndexViewer {...baseProps} />);

    expect(mockInvoke).toHaveBeenCalledWith('index_stats', {
      id: 'c1',
      db: 'shop',
      collection: 'products',
    });

    const sizeCard = await screen.findByTestId('index-size-card');
    expect(sizeCard).toHaveTextContent('16 KB');

    const usageCard = await screen.findByTestId('index-usage-card');
    expect(usageCard).toHaveTextContent('4,200');
    expect(usageCard).not.toHaveTextContent(/unused/i);
  });

  it('shows an "unused" badge when the matching index has zero ops', async () => {
    mockInvokeByCommand({
      list_indexes: [CITY_INDEX],
      index_stats: [{ name: 'city_1', sizeBytes: 8_192, ops: 0, sinceMs: 0 }],
    });
    render(<IndexViewer {...baseProps} />);

    const usageCard = await screen.findByTestId('index-usage-card');
    expect(usageCard).toHaveTextContent('0');
    expect(usageCard).toHaveTextContent(/unused/i);
  });

  it('still renders the definition when index_stats fails', async () => {
    mockInvokeByCommand({ list_indexes: [CITY_INDEX], index_stats: new Error('stats down') });
    render(<IndexViewer {...baseProps} />);

    expect(await screen.findByText('city')).toBeInTheDocument();
    expect(screen.queryByTestId('index-size-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('index-usage-card')).not.toBeInTheDocument();
  });
});
