import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => mockInvoke(...a) }));

import { ClusterHealthCard } from '../ClusterHealthCard';

const CLUSTER = {
  isReplicaSet: true,
  clusterType: 'replicaSet',
  set: 'rs0',
  myStateStr: 'PRIMARY',
  mongoVersion: '7.0.0',
  members: [
    { name: 'db1:27017', stateStr: 'PRIMARY', health: 1, self: true, uptimeSecs: 86400, optimeDateMs: 1749427200000, pingMs: null, syncSource: '', lagSecs: null },
    { name: 'db2:27017', stateStr: 'SECONDARY', health: 1, self: false, uptimeSecs: 86300, optimeDateMs: 1749427199200, pingMs: 1, syncSource: 'db1:27017', lagSecs: 0.8 },
    { name: 'db3:27017', stateStr: 'SECONDARY', health: 1, self: false, uptimeSecs: 4200, optimeDateMs: 1749427158000, pingMs: 3, syncSource: 'db1:27017', lagSecs: 42 },
    { name: 'db4:27017', stateStr: '(not reachable/healthy)', health: 0, self: false, uptimeSecs: 0, optimeDateMs: 0, pingMs: null, syncSource: '', lagSecs: null },
  ],
};

beforeEach(() => mockInvoke.mockReset());

describe('ClusterHealthCard', () => {
  it('renders the connection header, member rows, read-pref and version', async () => {
    mockInvoke.mockResolvedValue(CLUSTER);
    render(
      <ClusterHealthCard
        connectionId="conn-1"
        connectionName="Mock DB"
        connectionUri="mongodb://root:pw@h1:27017,h2:27017/?readPreference=primary"
      />
    );
    const card = await screen.findByTestId('cluster-health-card');
    expect(mockInvoke).toHaveBeenCalledWith('repl_set_status', { id: 'conn-1' });

    expect(screen.getByTestId('cluster-card-connection')).toHaveTextContent('Mock DB');
    expect(screen.getByTestId('cluster-card-connection')).toHaveTextContent('replica set: rs0');
    expect(screen.getByTestId('cluster-card-user')).toHaveTextContent('root');
    expect(screen.getByTestId('cluster-card-read-pref')).toHaveTextContent('Primary');
    expect(screen.getByTestId('cluster-card-version')).toHaveTextContent('7.0.0');

    expect(screen.getByTestId('cluster-card-member-db1:27017')).toHaveTextContent('PRIMARY');
    expect(screen.getByTestId('cluster-card-member-db2:27017')).toHaveTextContent('Online [SECONDARY]');
    expect(screen.getByTestId('cluster-card-member-db2:27017')).toHaveTextContent('lag 0.8s');
    // 42s >= 10s threshold: amber class somewhere inside the row.
    expect(screen.getByTestId('cluster-card-member-db3:27017').innerHTML).toMatch(/amber/);
    // Unhealthy member: destructive styling + Offline instead of lag.
    const down = screen.getByTestId('cluster-card-member-db4:27017');
    expect(down.className).toMatch(/destructive/);
    expect(down).toHaveTextContent('Offline');
    expect(down).toHaveTextContent('(not reachable/healthy)');
    expect(card).toBeInTheDocument();
  });

  it('refetches when Refresh is clicked', async () => {
    mockInvoke.mockResolvedValue(CLUSTER);
    render(<ClusterHealthCard connectionId="conn-1" />);
    await screen.findByTestId('cluster-health-card');
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    screen.getByTestId('cluster-card-refresh').click();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'repl_set_status', { id: 'conn-1' });
  });

  it('shows the standalone one-liner for non-replica-set servers, without header lines when props are omitted', async () => {
    mockInvoke.mockResolvedValue({ isReplicaSet: false, clusterType: 'standalone', set: '', myStateStr: '', mongoVersion: '', members: [] });
    render(<ClusterHealthCard connectionId="conn-1" />);
    expect(await screen.findByTestId('cluster-card-standalone')).toBeInTheDocument();
    expect(screen.queryByTestId('cluster-card-connection')).toBeNull();
    expect(screen.queryByTestId('cluster-card-user')).toBeNull();
    expect(screen.queryByTestId('cluster-card-read-pref')).toBeNull();
  });

  it('shows the sharded one-liner for mongos connections', async () => {
    mockInvoke.mockResolvedValue({ isReplicaSet: false, clusterType: 'sharded', set: '', myStateStr: '', mongoVersion: '', members: [] });
    render(<ClusterHealthCard connectionId="conn-1" />);
    expect(await screen.findByTestId('cluster-card-sharded')).toBeInTheDocument();
    expect(screen.queryByTestId('cluster-card-standalone')).toBeNull();
  });

  it('renders errors quietly and fires onOpenMonitoring from the footer link', async () => {
    mockInvoke.mockRejectedValueOnce('Not authorized to run replSetGetStatus');
    const { unmount } = render(<ClusterHealthCard connectionId="conn-1" />);
    expect(await screen.findByText(/not authorized/i)).toBeInTheDocument();
    unmount();

    mockInvoke.mockResolvedValue(CLUSTER);
    const onOpen = vi.fn();
    render(<ClusterHealthCard connectionId="conn-2" onOpenMonitoring={onOpen} />);
    (await screen.findByTestId('cluster-card-open-monitoring')).click();
    expect(onOpen).toHaveBeenCalledWith('conn-2');
  });
});
