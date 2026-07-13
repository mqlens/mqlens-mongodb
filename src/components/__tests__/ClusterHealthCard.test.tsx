import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => mockInvoke(...a) }));

import { ClusterHealthCard } from '../ClusterHealthCard';

const CLUSTER = {
  isReplicaSet: true,
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
  it('renders the set summary and members with lag styling', async () => {
    mockInvoke.mockResolvedValue(CLUSTER);
    render(<ClusterHealthCard connectionId="conn-1" />);
    const card = await screen.findByTestId('cluster-health-card');
    expect(card).toHaveTextContent('rs0');
    expect(card).toHaveTextContent('you: PRIMARY');
    expect(mockInvoke).toHaveBeenCalledWith('repl_set_status', { id: 'conn-1' });
    expect(screen.getByTestId('cluster-card-member-db1:27017')).toHaveTextContent('PRIMARY');
    expect(screen.getByTestId('cluster-card-member-db2:27017')).toHaveTextContent('lag 0.8s');
    // 42s >= 10s threshold: amber class somewhere inside the row.
    expect(screen.getByTestId('cluster-card-member-db3:27017').innerHTML).toMatch(/amber/);
    // Unhealthy member: destructive styling + stateStr instead of lag.
    const down = screen.getByTestId('cluster-card-member-db4:27017');
    expect(down.className).toMatch(/destructive/);
    expect(down).toHaveTextContent('(not reachable/healthy)');
  });

  it('shows the standalone one-liner for non-replica-set servers', async () => {
    mockInvoke.mockResolvedValue({ isReplicaSet: false, set: '', myStateStr: '', mongoVersion: '', members: [] });
    render(<ClusterHealthCard connectionId="conn-1" />);
    expect(await screen.findByTestId('cluster-card-standalone')).toBeInTheDocument();
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
