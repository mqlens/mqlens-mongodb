import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => mockInvoke(...a) }));

// recharts needs layout; stub it to plain divs for jsdom.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div>{children}</div>,
  Line: () => null,
  YAxis: () => null,
}));

import { MonitoringView } from '../MonitoringView';

const STATUS = {
  host: 'h:27017', version: '7.0.0', uptimeSeconds: 3600,
  connections: { current: 5, available: 100, totalCreated: 1 },
  opcounters: { insert: 1, query: 2, update: 0, delete: 0, getmore: 0, command: 3 },
  memory: { residentMb: 200, virtualMb: 2000 },
  network: { bytesIn: 10, bytesOut: 20, numRequests: 5 },
  cache: { bytesInCache: 1024, maxBytes: 4096, dirtyBytes: 0 },
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'server_status': return Promise.resolve(STATUS);
      case 'current_ops': return Promise.resolve([
        { opid: 42, op: 'query', ns: 'sales_db.orders', secsRunning: 3, client: '1.2.3.4', desc: 'conn1', command: '{ find: "orders" }' },
      ]);
      case 'list_databases': return Promise.resolve(['admin', 'sales_db']);
      case 'get_profiling_status': return Promise.resolve({ level: 0, slowMs: 100 });
      case 'read_profile': return Promise.resolve([]);
      case 'kill_op': return Promise.resolve();
      default: return Promise.resolve(null);
    }
  });
});

describe('MonitoringView', () => {
  it('renders server metrics and current operations', async () => {
    render(<MonitoringView connectionId="conn-1" />);
    expect(await screen.findByTestId('monitoring-view')).toBeInTheDocument();
    expect(await screen.findByText('Connections')).toBeInTheDocument();
    // Connection count from server_status.
    expect(await screen.findByText('5')).toBeInTheDocument();
    // Current ops table with the running op.
    expect(await screen.findByTestId('current-ops-table')).toBeInTheDocument();
    expect(screen.getByText('sales_db.orders')).toBeInTheDocument();
  });

  it('kills an operation after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MonitoringView connectionId="conn-1" />);
    const killBtn = await screen.findByTestId('kill-op-42');
    fireEvent.click(killBtn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('kill_op', { id: 'conn-1', opid: 42 });
    });
  });

  it('switches between the Current operations and Profiler tabs', async () => {
    render(<MonitoringView connectionId="conn-1" />);
    // Current operations is the default tab.
    expect(await screen.findByTestId('current-ops-table')).toBeInTheDocument();
    expect(screen.queryByTestId('mon-panel-profiler')).toBeNull();
    // Switch to the Profiler tab.
    fireEvent.click(screen.getByTestId('mon-tab-profiler'));
    expect(await screen.findByTestId('mon-panel-profiler')).toBeInTheDocument();
    expect(screen.queryByTestId('current-ops-table')).toBeNull();
  });

  it('sets the profiling level via the controls (on the Profiler tab)', async () => {
    render(<MonitoringView connectionId="conn-1" />);
    fireEvent.click(await screen.findByTestId('mon-tab-profiler'));
    fireEvent.click(await screen.findByTestId('profiler-level-1'));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('set_profiling_level', expect.objectContaining({ id: 'conn-1', level: 1 }));
    });
  });
});
