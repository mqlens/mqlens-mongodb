import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ActivityPanel } from '../ActivityPanel';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

const sampleEvent = {
  id: 'ev-1',
  ts: 1_700_000_000_000,
  connectionId: 'conn-1',
  profileName: 'Local',
  database: 'sales',
  collection: 'orders',
  op: 'dropCollection',
  source: 'ui',
  ok: true,
  error: null,
  durationMs: 12,
  summary: 'drop sales.orders',
  argsJson: null,
  levelAtRecord: 'A',
  schemaVersion: 1,
};

describe('ActivityPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a locked-vault empty state when audit_list fails', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'audit_list') return Promise.reject('vault is locked');
      if (cmd === 'audit_dropped_count') return Promise.resolve(0);
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);

    expect(await screen.findByTestId('activity-locked')).toBeInTheDocument();
    expect(screen.getByTestId('activity-locked')).toHaveTextContent(/locked/i);
  });

  it('lists events and reloads with filter args when searching', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'audit_list') return Promise.resolve([sampleEvent]);
      if (cmd === 'audit_dropped_count') return Promise.resolve(0);
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);

    expect(await screen.findByTestId('activity-row-ev-1')).toBeInTheDocument();
    expect(screen.getByText('dropCollection')).toBeInTheDocument();
    expect(screen.getByText(/drop sales\.orders/i)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('activity-filter-summary'), {
      target: { value: 'drop' },
    });
    fireEvent.click(screen.getByTestId('activity-refresh-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'audit_list',
        expect.objectContaining({
          filter: expect.objectContaining({ summaryContains: 'drop' }),
        })
      )
    );
  });
});
