import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CopyToDialog } from '../CopyToDialog';

const baseProps = {
  open: true,
  onOpenChange: () => {},
  activeConnections: [{ id: 'c1', name: 'Local', uri: 'mongodb://x' }],
  listDatabases: vi.fn(async () => ['app', 'other']),
  listCollections: vi.fn(async () => ['orders']),
  preflight: vi.fn(async () => ({ conflicts: [], selfOverwrite: false })),
};

describe('CopyToDialog', () => {
  it('defaults the target collection name to the source name', async () => {
    render(<CopyToDialog {...baseProps}
      source={{ connectionId: 'c1', db: 'app', collections: ['orders'] }}
      onConfirm={vi.fn(async () => {})} />);
    const input = await screen.findByLabelText(/target collection/i) as HTMLInputElement;
    expect(input.value).toBe('orders');
  });

  it('disables Start when preflight reports self-overwrite', async () => {
    render(<CopyToDialog {...baseProps}
      preflight={vi.fn(async () => ({ conflicts: [], selfOverwrite: true }))}
      source={{ connectionId: 'c1', db: 'app', collections: ['orders'] }}
      onConfirm={vi.fn(async () => {})} />);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /start copy/i }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('treats a pre-filled db that is missing on the target as a new database', async () => {
    // Paste a database whose name does not exist on the chosen target connection.
    render(<CopyToDialog {...baseProps}
      listDatabases={vi.fn(async () => ['app', 'other'])}
      source={{ connectionId: 'c1', db: 'cidaas-management-test', collections: [] }}
      presetTargetId="c1"
      presetTargetDb="cidaas-management-test"
      onConfirm={vi.fn(async () => {})} />);
    // It should fall into the "new database" input pre-filled with the pasted name…
    const input = await screen.findByPlaceholderText(/new database name/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('cidaas-management-test'));
    // …and explain that it will be created.
    expect(screen.getByText(/will be created/i)).toBeInTheDocument();
  });

  it('requires Overwrite confirmation before Start enables', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<CopyToDialog {...baseProps}
      preflight={vi.fn(async () => ({ conflicts: [{ db: 'app', collection: 'orders', targetExists: true, targetDocCount: 3 }], selfOverwrite: false }))}
      source={{ connectionId: 'c1', db: 'app', collections: ['orders'] }}
      onConfirm={onConfirm} />);
    fireEvent.click(await screen.findByLabelText(/overwrite/i));
    const start = screen.getByRole('button', { name: /start copy/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(true); // confirm checkbox not yet checked
    fireEvent.click(screen.getByLabelText(/i understand/i));
    await waitFor(() => expect(start.disabled).toBe(false));
  });
});
