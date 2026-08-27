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

const activeStatus = { active: true, degradedReason: null, droppedCount: 0 };

describe('ActivityPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a locked-vault empty state when audit_list fails', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'audit_list') return Promise.reject('vault is locked');
      if (cmd === 'audit_status') return Promise.resolve(activeStatus);
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);

    expect(await screen.findByTestId('activity-locked')).toBeInTheDocument();
    expect(screen.getByTestId('activity-locked')).toHaveTextContent(/locked/i);
  });

  it('lists events and reloads with filter args when searching', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'audit_list') return Promise.resolve([sampleEvent]);
      if (cmd === 'audit_status') return Promise.resolve(activeStatus);
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

  it('shows a degraded banner instead of "locked" when the session failed to open', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      // A failed audit session reports the same error as a locked vault.
      if (cmd === 'audit_list') return Promise.reject('vault is locked');
      if (cmd === 'audit_status')
        return Promise.resolve({
          active: false,
          degradedReason: 'read audit.log.enc: unrecognized header',
          droppedCount: 0,
        });
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);

    const banner = await screen.findByTestId('activity-degraded-banner');
    expect(banner).toHaveTextContent(/unrecognized header/i);
    expect(screen.queryByTestId('activity-locked')).not.toBeInTheDocument();
  });

  it('still shows the locked state when the vault really is locked', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'audit_list') return Promise.reject('vault is locked');
      if (cmd === 'audit_status') return Promise.resolve(activeStatus);
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);

    expect(await screen.findByTestId('activity-locked')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-degraded-banner')).not.toBeInTheDocument();
  });

  it('reports dropped events from audit_status', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'audit_list') return Promise.resolve([sampleEvent]);
      if (cmd === 'audit_status')
        return Promise.resolve({ active: true, degradedReason: null, droppedCount: 3 });
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);

    expect(await screen.findByTestId('activity-dropped-banner')).toHaveTextContent('3');
  });

  it('shows an integrity banner and hides the degraded one when the log is sealed', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      // A sealed log still reads back its verified prefix.
      if (cmd === 'audit_list') return Promise.resolve([sampleEvent]);
      if (cmd === 'audit_status')
        return Promise.resolve({
          active: false,
          degradedReason: null,
          integrityError: 'hash chain broken at record 2',
          droppedCount: 0,
        });
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);

    const banner = await screen.findByTestId('activity-integrity-banner');
    expect(banner).toHaveTextContent(/hash chain broken/i);
    // Only one explanation, not two competing banners.
    expect(screen.queryByTestId('activity-degraded-banner')).not.toBeInTheDocument();
    // The verified prefix is still listed so the history stays inspectable.
    expect(screen.getByTestId('activity-row-ev-1')).toBeInTheDocument();
  });

  it('shows the full summary in the expanded detail, not just the truncated cell', async () => {
    const longSummary =
      'copy cidaas-management-test.Rating_SingleRating → cidaas-management-test.Rating_SingleRating11 (completed)';
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'audit_list')
        return Promise.resolve([{ ...sampleEvent, summary: longSummary }]);
      if (cmd === 'audit_status') return Promise.resolve(activeStatus);
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);

    const row = await screen.findByTestId('activity-row-ev-1');
    // The row cell carries the full text as a tooltip even while truncated.
    expect(row).toHaveTextContent(/Rating_SingleRating11/);

    fireEvent.click(row);

    const detail = await screen.findByTestId('activity-detail-ev-1');
    expect(detail).toHaveTextContent(longSummary);
    expect(detail).toHaveTextContent('sales.orders');
  });

  it('offers no way to erase an intact log', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'audit_list') return Promise.resolve([sampleEvent]);
      if (cmd === 'audit_status') return Promise.resolve(activeStatus);
      return Promise.resolve(undefined);
    });

    render(<ActivityPanel />);
    await screen.findByTestId('activity-row-ev-1');

    // Retention is the only thing that removes events from a healthy log.
    expect(screen.queryByTestId('activity-discard-btn')).not.toBeInTheDocument();
  });

  it('offers discard only for a damaged log, and reports what it removed', async () => {
    const invoked: string[] = [];
    mockInvoke.mockImplementation((cmd: string) => {
      invoked.push(cmd);
      if (cmd === 'audit_list') return Promise.resolve([]);
      if (cmd === 'audit_status')
        return Promise.resolve({
          active: false,
          degradedReason: null,
          integrityError: 'hash chain broken at record 2',
          droppedCount: 0,
        });
      if (cmd === 'audit_discard_damaged_log') return Promise.resolve(7);
      return Promise.resolve(undefined);
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    render(<ActivityPanel />);
    const btn = await screen.findByTestId('activity-discard-btn');
    fireEvent.click(btn);

    await waitFor(() => expect(invoked).toContain('audit_discard_damaged_log'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('7')));

    confirmSpy.mockRestore();
    alertSpy.mockRestore();
  });
});
