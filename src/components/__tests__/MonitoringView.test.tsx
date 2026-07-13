import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => mockInvoke(...a) }));

import { MonitoringView } from '../MonitoringView';

const STATUS = {
  host: 'h:27017', version: '7.0.0', uptimeSeconds: 3600,
  connections: { current: 5, available: 100, totalCreated: 1 },
  opcounters: { insert: 1, query: 2, update: 0, delete: 0, getmore: 0, command: 3 },
  memory: { residentMb: 200, virtualMb: 2000 },
  network: { bytesIn: 10, bytesOut: 20, numRequests: 5 },
  cache: { bytesInCache: 1024, maxBytes: 4096, dirtyBytes: 0 },
};

const CLUSTER = {
  isReplicaSet: true,
  set: 'rs0',
  myStateStr: 'PRIMARY',
  mongoVersion: '7.0.0',
  members: [
    { name: 'db1:27017', stateStr: 'PRIMARY', health: 1, self: true, uptimeSecs: 86400, optimeDateMs: 1749427200000, pingMs: null, syncSource: '', lagSecs: null },
    { name: 'db2:27017', stateStr: 'SECONDARY', health: 1, self: false, uptimeSecs: 86300, optimeDateMs: 1749427199200, pingMs: 1, syncSource: 'db1:27017', lagSecs: 0.8 },
    { name: 'db3:27017', stateStr: 'SECONDARY', health: 1, self: false, uptimeSecs: 4200, optimeDateMs: 1749427158000, pingMs: 3, syncSource: 'db1:27017', lagSecs: 42 },
  ],
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
      case 'repl_set_status': return Promise.resolve(CLUSTER);
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

  it('shows "Access required" when serverStatus is unauthorized, but still lists ops', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'server_status') return Promise.reject('serverStatus failed: not authorized on admin (Unauthorized)');
      if (cmd === 'current_ops') return Promise.resolve([
        { opid: 1, op: 'command', ns: 'admin.$cmd', secsRunning: 0, client: 'x', desc: '', command: '{}' },
      ]);
      if (cmd === 'list_databases') return Promise.resolve(['admin']);
      if (cmd === 'get_profiling_status') return Promise.resolve({ level: 0, slowMs: 100 });
      if (cmd === 'read_profile') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<MonitoringView connectionId="conn-1" />);
    expect(await screen.findByTestId('access-required')).toBeInTheDocument();
    // Metric cards are hidden behind the access notice.
    expect(screen.queryByText('Connections')).toBeNull();
    // Current operations still work (independent privilege).
    expect(await screen.findByTestId('current-ops-table')).toBeInTheDocument();
  });

  it('filters the current-operations list by search text', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'server_status') return Promise.resolve(STATUS);
      if (cmd === 'current_ops') return Promise.resolve([
        { opid: 1, op: 'query', ns: 'sales_db.orders', secsRunning: 1, client: 'a', desc: '', command: '{}' },
        { opid: 2, op: 'command', ns: 'admin.$cmd', secsRunning: 0, client: 'b', desc: '', command: '{}' },
      ]);
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'get_profiling_status') return Promise.resolve({ level: 0, slowMs: 100 });
      if (cmd === 'read_profile') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<MonitoringView connectionId="conn-1" />);
    expect(await screen.findByText('sales_db.orders')).toBeInTheDocument();
    expect(screen.getByText('admin.$cmd')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('ops-search'), { target: { value: 'orders' } });
    expect(screen.getByText('sales_db.orders')).toBeInTheDocument();
    expect(screen.queryByText('admin.$cmd')).toBeNull();
  });

  it('filters current ops by minimum duration (secs)', async () => {
    render(<MonitoringView connectionId="conn-1" />);
    expect(await screen.findByTestId('current-ops-table')).toBeInTheDocument();
    // The seeded op runs for 3s; require ≥ 5s and it drops out.
    fireEvent.change(screen.getByTestId('ops-min-secs'), { target: { value: '5' } });
    expect(screen.queryByTestId('current-ops-table')).toBeNull();
    expect(screen.getByText('No operations match the filter.')).toBeInTheDocument();
  });

  it('opens a detail modal when an operation row is clicked', async () => {
    render(<MonitoringView connectionId="conn-1" />);
    fireEvent.click(await screen.findByTestId('op-row-42'));
    const modal = await screen.findByTestId('monitoring-detail');
    expect(modal).toBeInTheDocument();
    expect(screen.getByText('Operation details')).toBeInTheDocument();
    // The detail modal shows the full command in its own code block.
    expect(modal.querySelector('[data-testid="monitoring-detail-cmd"]')).toBeTruthy();
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

  it('does not fetch replica-set status until the Cluster tab is active', async () => {
    render(<MonitoringView connectionId="conn-1" />);
    expect(await screen.findByTestId('current-ops-table')).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith('repl_set_status', expect.anything());
    fireEvent.click(screen.getByTestId('mon-tab-cluster'));
    expect(await screen.findByTestId('mon-panel-cluster')).toBeInTheDocument();
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('repl_set_status', { id: 'conn-1' });
    });
  });

  it('renders replica-set members with roles and lag warning styling', async () => {
    render(<MonitoringView connectionId="conn-1" />);
    fireEvent.click(await screen.findByTestId('mon-tab-cluster'));

    const summary = await screen.findByTestId('cluster-summary');
    expect(summary).toHaveTextContent('rs0');
    expect(summary).toHaveTextContent('3 members');
    expect(summary).toHaveTextContent('7.0.0');
    expect(summary).toHaveTextContent('PRIMARY');

    expect(screen.getByTestId('cluster-member-db1:27017')).toHaveTextContent('PRIMARY');
    // Healthy secondary: sub-threshold lag, no warning class.
    const okLag = screen.getByTestId('cluster-lag-db2:27017');
    expect(okLag).toHaveTextContent('0.8s');
    expect(okLag.className).not.toMatch(/amber|red/);
    // Lagging secondary (42s >= 10s): amber warning.
    const warnLag = screen.getByTestId('cluster-lag-db3:27017');
    expect(warnLag).toHaveTextContent('42');
    expect(warnLag.className).toMatch(/amber/);
  });

  it('shows a friendly empty state for standalone (non-replica-set) servers', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'server_status') return Promise.resolve(STATUS);
      if (cmd === 'current_ops') return Promise.resolve([]);
      if (cmd === 'repl_set_status')
        return Promise.resolve({ isReplicaSet: false, set: '', myStateStr: '', mongoVersion: '', members: [] });
      return Promise.resolve(null);
    });
    render(<MonitoringView connectionId="conn-1" />);
    fireEvent.click(await screen.findByTestId('mon-tab-cluster'));
    expect(await screen.findByTestId('cluster-not-replset')).toBeInTheDocument();
    expect(screen.queryByTestId('cluster-members-table')).toBeNull();
  });
});
