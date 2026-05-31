import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateViewView } from '../CreateViewView';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

describe('CreateViewView (M7 — view creation)', () => {
  beforeEach(() => vi.clearAllMocks());

  const collections = [
    { name: 'customers', type: 'collection' },
    { name: 'orders', type: 'collection' },
    { name: 'system.views', type: 'collection' },
  ];

  it('populates the source dropdown and creates a view with the pipeline', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_collections') return Promise.resolve(collections);
      if (cmd === 'create_view') return Promise.resolve();
      return Promise.reject(new Error(`unhandled ${cmd}`));
    });
    const onCreated = vi.fn();
    render(
      <CreateViewView connectionId="c1" databaseName="shop" onCreated={onCreated} />
    );

    // Source options come from list_collections (system.* excluded).
    await screen.findByRole('option', { name: 'customers' });
    expect(screen.queryByRole('option', { name: 'system.views' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('view-name-input'), { target: { value: 'vip' } });
    fireEvent.change(screen.getByTestId('view-source-select'), { target: { value: 'customers' } });
    fireEvent.change(screen.getByTestId('view-pipeline-input'), {
      target: { value: '[{ "$match": { "tier": "Premium" } }]' },
    });
    fireEvent.click(screen.getByTestId('view-create-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('create_view', {
        id: 'c1',
        database: 'shop',
        viewName: 'vip',
        sourceCollection: 'customers',
        pipeline: '[{ "$match": { "tier": "Premium" } }]',
      })
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('vip'));
  });

  it('blocks creation and shows an error for invalid pipeline JSON', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'list_collections' ? Promise.resolve(collections) : Promise.resolve()
    );
    render(<CreateViewView connectionId="c1" databaseName="shop" onCreated={() => {}} />);

    await screen.findByRole('option', { name: 'customers' });
    fireEvent.change(screen.getByTestId('view-name-input'), { target: { value: 'vip' } });
    fireEvent.change(screen.getByTestId('view-source-select'), { target: { value: 'customers' } });
    fireEvent.change(screen.getByTestId('view-pipeline-input'), { target: { value: '[{ not json' } });
    fireEvent.click(screen.getByTestId('view-create-btn'));

    expect(await screen.findByTestId('view-error')).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith('create_view', expect.anything());
  });
});
