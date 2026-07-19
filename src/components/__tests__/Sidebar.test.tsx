import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { DialogProvider } from '../dialogs/DialogProvider';

vi.mock('../theme/ThemePicker', () => ({
  ThemePicker: () => <div data-testid="theme-picker">Theme presets</div>,
}));

// Sidebar now uses the in-app dialog system, so it must render inside a provider.
const render = (ui: ReactElement) => rtlRender(<DialogProvider>{ui}</DialogProvider>);

// Mock Tauri invoke function
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

describe('Sidebar Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'list_all_saved_queries') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });
  });

  it('renders connect button initially when no connections are active', () => {
    const handleOpenModal = vi.fn();
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[]}
        onOpenConnectionManager={handleOpenModal}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );
    
    const connectBtn = screen.getByRole('button', { name: /connect to database/i });
    expect(connectBtn).toBeInTheDocument();
    
    fireEvent.click(connectBtn);
    expect(handleOpenModal).toHaveBeenCalledTimes(1);
  });

  it('filters the tree by the search box (database names)', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases') {
        if (args.id === 'conn-1') return Promise.resolve(['sales_db', 'user_analytics']);
      }
      if (cmd === 'list_collections') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB 1', uri: 'mongodb://mock1' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    // Both databases visible before filtering.
    expect(await screen.findByText('sales_db')).toBeInTheDocument();
    expect(await screen.findByText('user_analytics')).toBeInTheDocument();

    // Typing "sales" hides the non-matching database.
    fireEvent.change(screen.getByTestId('sidebar-search'), { target: { value: 'sales' } });
    expect(screen.getByText('sales_db')).toBeInTheDocument();
    expect(screen.queryByText('user_analytics')).toBeNull();

    // Clearing restores everything.
    fireEvent.click(screen.getByRole('button', { name: /clear search/i }));
    expect(screen.getByText('user_analytics')).toBeInTheDocument();
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Command', { metaKey: true }],
  ])('focuses sidebar search with %s+F', async (_label, modifier) => {
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    const search = screen.getByTestId('sidebar-search');
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ...modifier,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(search).toHaveFocus();
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not steal Ctrl+F from Monaco editors', () => {
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const textarea = document.createElement('textarea');
    monaco.appendChild(textarea);
    document.body.appendChild(monaco);
    textarea.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(textarea).toHaveFocus();
    expect(screen.getByTestId('sidebar-search')).not.toHaveFocus();
    expect(event.defaultPrevented).toBe(false);

    monaco.remove();
  });

  it('handles rendering multiple connections, databases, collections, and indexes', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases') {
        if (args.id === 'conn-1') {
          return Promise.resolve(['sales_db']);
        }
        if (args.id === 'conn-2') {
          return Promise.resolve(['user_analytics']);
        }
      }
      if (cmd === 'list_collections') {
        if (args.id === 'conn-1' && args.db === 'sales_db') {
          return Promise.resolve([{ name: 'customers', type: 'collection' }]);
        }
      }
      if (cmd === 'list_indexes') {
        if (args.id === 'conn-1' && args.db === 'sales_db' && args.collection === 'customers') {
          return Promise.resolve([
            { name: '_id_', keys: '{"_id":1}', unique: true, sparse: false },
            { name: 'email_1', keys: '{"email":1}', unique: false, sparse: false },
          ]);
        }
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const activeConnections = [
      { id: 'conn-1', name: 'Mock DB 1', uri: 'mongodb://mock1' },
      { id: 'conn-2', name: 'Mock DB 2', uri: 'mongodb://mock2' },
    ];

    const handleSelectCollection = vi.fn();
    const handleDisconnect = vi.fn();

    const handleSelectIndex = vi.fn();

    render(
      <Sidebar
        onSelectCollection={handleSelectCollection}
        onSelectIndex={handleSelectIndex}
        activeCollection={null}
        activeConnections={activeConnections}
        onOpenConnectionManager={() => {}}
        onDisconnect={handleDisconnect}
        onOpenSettings={() => {}}
      />
    );

    // Verify both connection names are rendered
    const conn1Node = await screen.findByText('Mock DB 1');
    const conn2Node = await screen.findByText('Mock DB 2');
    expect(conn1Node).toBeInTheDocument();
    expect(conn2Node).toBeInTheDocument();

    // Verify databases are fetched automatically and connection is expanded
    const dbNode = await screen.findByText('sales_db');
    const db2Node = await screen.findByText('user_analytics');
    expect(dbNode).toBeInTheDocument();
    expect(db2Node).toBeInTheDocument();

    // Click database "sales_db" to expand it and reveal "collections" virtual folder
    fireEvent.click(dbNode);

    // Wait for "collections" virtual folder to appear
    const collectionsFolder = await screen.findByText('Collections');
    expect(collectionsFolder).toBeInTheDocument();

    // Expand "collections" virtual folder
    fireEvent.click(collectionsFolder);

    // Wait for collection "customers" to appear
    const collectionNode = await screen.findByText('customers');
    expect(collectionNode).toBeInTheDocument();

    // Click on collection to trigger select and expand indexes
    fireEvent.click(collectionNode);

    expect(handleSelectCollection).toHaveBeenCalledWith('conn-1', 'sales_db', 'customers');

    // Find and expand "indexes" virtual folder
    const indexesFolder = await screen.findByText('indexes');
    expect(indexesFolder).toBeInTheDocument();
    fireEvent.click(indexesFolder);

    // Wait for indexes to appear
    await waitFor(() => {
      expect(screen.getByText('email_1')).toBeInTheDocument();
      expect(screen.getByText('_id_')).toBeInTheDocument();
    });

    // Test clicking an index node triggers onSelectIndex
    const indexNode = screen.getByText('email_1');
    fireEvent.click(indexNode);
    expect(handleSelectIndex).toHaveBeenCalledWith('conn-1', 'sales_db', 'customers', 'email_1');

    // Test disconnect click
    const disconnectBtns = screen.getAllByRole('button', { name: /disconnect/i });
    fireEvent.click(disconnectBtns[0]);
    expect(handleDisconnect).toHaveBeenCalledWith('conn-1');
  });

  it('renders a distinct icon for time-series collections (#137)', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections' && args.db === 'sales_db') {
        return Promise.resolve([
          { name: 'customers', type: 'collection' },
          { name: 'sensor_readings', type: 'timeseries' },
          { name: 'active_users', type: 'view' },
        ]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    fireEvent.click(await screen.findByText('sales_db'));
    fireEvent.click(await screen.findByText('Collections'));
    await screen.findByText('sensor_readings');
    expect(screen.getByText('customers')).toBeInTheDocument();

    // Views live in their own folder — expand it so the view row is actually
    // rendered; otherwise the "views unaffected" check below is vacuous.
    fireEvent.click(screen.getByText('Views'));
    await screen.findByText('active_users');

    // Exactly one row gets the time-series icon — the regular collection
    // (and anything else in the tree, including the view row) keeps the
    // generic Layers icon.
    const tsIcons = screen.getAllByTestId('coll-icon-timeseries');
    expect(tsIcons).toHaveLength(1);
    expect(tsIcons[0]).toHaveAttribute('aria-label', 'Time-series collection');
    expect(tsIcons[0].closest('div')).toHaveTextContent('sensor_readings');
  });

  it('shows a cluster-health popover when hovering a connection (#114)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([]);
      if (cmd === 'repl_set_status')
        return Promise.resolve({
          isReplicaSet: true, clusterType: 'replicaSet', set: 'rs0', myStateStr: 'PRIMARY', mongoVersion: '7.0.0',
          members: [
            { name: 'db1:27017', stateStr: 'PRIMARY', health: 1, self: true, uptimeSecs: 1, optimeDateMs: 1, pingMs: null, syncSource: '', lagSecs: null },
          ],
        });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        clusterHoverDelayMs={0}
      />
    );
    const row = await screen.findByLabelText('Connection Mock DB');
    expect(mockInvoke).not.toHaveBeenCalledWith('repl_set_status', expect.anything());
    fireEvent.mouseEnter(row);
    expect(await screen.findByTestId('cluster-health-card')).toBeInTheDocument();
    expect(await screen.findByText('rs0')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('repl_set_status', { id: 'conn-1' });
    // #114 follow-up: connection name is passed through; the fixture's
    // auth-less uri ('mongodb://mock') means no user line.
    expect(screen.getByTestId('cluster-card-connection')).toHaveTextContent('Mock DB');
    expect(screen.queryByTestId('cluster-card-user')).toBeNull();
  });

  it('closes the cluster-health popover on Escape (#114)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([]);
      if (cmd === 'repl_set_status')
        return Promise.resolve({
          isReplicaSet: true, clusterType: 'replicaSet', set: 'rs0', myStateStr: 'PRIMARY', mongoVersion: '7.0.0',
          members: [
            { name: 'db1:27017', stateStr: 'PRIMARY', health: 1, self: true, uptimeSecs: 1, optimeDateMs: 1, pingMs: null, syncSource: '', lagSecs: null },
          ],
        });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        clusterHoverDelayMs={0}
      />
    );
    const row = await screen.findByLabelText('Connection Mock DB');
    fireEvent.mouseEnter(row);
    expect(await screen.findByTestId('cluster-health-card')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('cluster-health-card')).toBeNull());
  });

  it('refetches cluster health once per open when closed then reopened (#114)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([]);
      if (cmd === 'repl_set_status')
        return Promise.resolve({
          isReplicaSet: true, clusterType: 'replicaSet', set: 'rs0', myStateStr: 'PRIMARY', mongoVersion: '7.0.0',
          members: [
            { name: 'db1:27017', stateStr: 'PRIMARY', health: 1, self: true, uptimeSecs: 1, optimeDateMs: 1, pingMs: null, syncSource: '', lagSecs: null },
          ],
        });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        clusterHoverDelayMs={0}
      />
    );
    const row = await screen.findByLabelText('Connection Mock DB');

    fireEvent.mouseEnter(row);
    expect(await screen.findByTestId('cluster-health-card')).toBeInTheDocument();

    fireEvent.mouseLeave(row);
    // Grace close is 150ms of real time before the popover actually closes.
    await waitFor(() => expect(screen.queryByTestId('cluster-health-card')).toBeNull());

    fireEvent.mouseEnter(row);
    expect(await screen.findByTestId('cluster-health-card')).toBeInTheDocument();

    const replSetStatusCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'repl_set_status');
    expect(replSetStatusCalls).toHaveLength(2);
  });

  it('shows a database stats popover when hovering a database row (#178)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([]);
      if (cmd === 'db_stats')
        return Promise.resolve({
          collections: 3, views: 0, objects: 100, avgObjSize: 128,
          dataSize: 12800, storageSize: 20000, indexes: 4, totalIndexSize: 4096,
        });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        clusterHoverDelayMs={0}
      />
    );

    const dbRow = await screen.findByLabelText('Database sales_db');
    fireEvent.mouseEnter(dbRow);
    expect(await screen.findByTestId('db-stats-card')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('db_stats', { id: 'conn-1', db: 'sales_db' });
  });

  it('shows a collection stats popover when hovering a collection row (#178)', async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections' && args.db === 'sales_db') {
        return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      }
      if (cmd === 'coll_stats')
        return Promise.resolve({
          count: 500, avgObjSize: 256, size: 128000, storageSize: 150000,
          nindexes: 2, totalIndexSize: 8192, capped: false,
        });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        clusterHoverDelayMs={0}
      />
    );

    const dbNode = await screen.findByText('sales_db');
    fireEvent.click(dbNode);
    const collectionsFolder = await screen.findByText('Collections');
    fireEvent.click(collectionsFolder);
    const collText = await screen.findByText('customers');
    const collRow = collText.closest('div')!;
    fireEvent.mouseEnter(collRow);
    expect(await screen.findByTestId('coll-stats-card')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('coll_stats', { id: 'conn-1', db: 'sales_db', collection: 'customers' });
  });

  it('shows an index stats popover when hovering an index row (#178)', async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections' && args.db === 'sales_db') {
        return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      }
      if (cmd === 'list_indexes') {
        return Promise.resolve([
          { name: '_id_', keys: '{"_id":1}', unique: true, sparse: false },
          { name: 'email_1', keys: '{"email":1}', unique: false, sparse: false },
        ]);
      }
      if (cmd === 'index_stats')
        return Promise.resolve([
          { name: '_id_', sizeBytes: 4096, ops: 10, sinceMs: 0 },
          { name: 'email_1', sizeBytes: 2048, ops: 5, sinceMs: 0 },
        ]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        clusterHoverDelayMs={0}
      />
    );

    const dbNode = await screen.findByText('sales_db');
    fireEvent.click(dbNode);
    const collectionsFolder = await screen.findByText('Collections');
    fireEvent.click(collectionsFolder);
    const collNode = await screen.findByText('customers');
    fireEvent.click(collNode);
    const indexesFolder = await screen.findByText('indexes');
    fireEvent.click(indexesFolder);
    const indexText = await screen.findByText('email_1');
    const indexRow = indexText.closest('div')!;
    fireEvent.mouseEnter(indexRow);
    expect(await screen.findByTestId('index-stats-card')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('index_stats', { id: 'conn-1', db: 'sales_db', collection: 'customers' });
  });

  it('closes the db popover and opens the health popover moving from a database row to the connection row (#178)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([]);
      if (cmd === 'db_stats')
        return Promise.resolve({
          collections: 1, views: 0, objects: 1, avgObjSize: 1,
          dataSize: 1, storageSize: 1, indexes: 1, totalIndexSize: 1,
        });
      if (cmd === 'repl_set_status')
        return Promise.resolve({
          isReplicaSet: true, clusterType: 'replicaSet', set: 'rs0', myStateStr: 'PRIMARY', mongoVersion: '7.0.0',
          members: [
            { name: 'db1:27017', stateStr: 'PRIMARY', health: 1, self: true, uptimeSecs: 1, optimeDateMs: 1, pingMs: null, syncSource: '', lagSecs: null },
          ],
        });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        clusterHoverDelayMs={0}
      />
    );

    const connRow = await screen.findByLabelText('Connection Mock DB');
    const dbRow = await screen.findByLabelText('Database sales_db');

    fireEvent.mouseEnter(dbRow);
    expect(await screen.findByTestId('db-stats-card')).toBeInTheDocument();

    fireEvent.mouseEnter(connRow);
    await waitFor(() => expect(screen.queryByTestId('db-stats-card')).toBeNull());
    expect(await screen.findByTestId('cluster-health-card')).toBeInTheDocument();
  });

  it('sorts collections by name before rendering', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases') {
        return Promise.resolve(['sales_db']);
      }
      if (cmd === 'list_collections' && args.db === 'sales_db') {
        return Promise.resolve([
          { name: 'zeta', type: 'collection' },
          { name: 'alpha', type: 'collection' },
          { name: 'orders10', type: 'collection' },
          { name: 'orders2', type: 'collection' },
        ]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    fireEvent.click(await screen.findByText('sales_db'));
    fireEvent.click(await screen.findByText('Collections'));

    const alpha = await screen.findByText('alpha');
    const orders2 = await screen.findByText('orders2');
    const orders10 = await screen.findByText('orders10');
    const zeta = await screen.findByText('zeta');

    expect(alpha.compareDocumentPosition(orders2)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(orders2.compareDocumentPosition(orders10)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(orders10.compareDocumentPosition(zeta)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('refreshes and expands a copy destination when the refresh nonce bumps', async () => {
    let collections: { name: string; type: string }[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'list_all_saved_queries') return Promise.resolve([]);
      if (cmd === 'list_databases') return Promise.resolve(['shop']);
      if (cmd === 'list_collections' && args.db === 'shop') return Promise.resolve(collections);
      if (cmd === 'list_collections') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const sidebar = (nonce: number) => (
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        refreshTarget={{ connectionId: 'conn-1', db: 'shop', expand: true }}
        refreshTargetNonce={nonce}
      />
    );

    const { rerender } = render(sidebar(0));
    await screen.findByText('shop');

    // The copy lands a new collection; bumping the nonce surfaces it without any
    // manual expansion, because the destination db + Collections folder auto-open.
    collections = [{ name: 'copied_orders', type: 'collection' }];
    rerender(<DialogProvider>{sidebar(1)}</DialogProvider>);

    expect(await screen.findByText('copied_orders')).toBeInTheDocument();
  });

  it('applies custom width inline style if width prop is provided', () => {
    const { container } = render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        width={350}
        onOpenSettings={() => {}}
      />
    );
    const sidebarEl = container.querySelector('.sidebar');
    expect(sidebarEl).toHaveStyle({ width: '350px' });
  });

  it('renders theme picker in footer', () => {
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );
    expect(screen.getByTestId('theme-picker')).toBeInTheDocument();
  });

  it('calls onOpenSettings when the Settings button is clicked', () => {
    const handleOpenSettings = vi.fn();
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={handleOpenSettings}
      />
    );
    const settingsBtn = screen.getByRole('button', { name: /open settings/i });
    fireEvent.click(settingsBtn);
    expect(handleOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('displays collection count badge next to collections folder when database is expanded', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'list_databases') {
        return Promise.resolve(['analytics']);
      }
      if (cmd === 'list_collections') {
        return Promise.resolve([
          { name: 'events', type: 'collection' },
          { name: 'users', type: 'collection' },
        ]);
      }
      return Promise.reject(new Error(`Unhandled: ${cmd}`));
    });

    const activeConnections = [{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }];

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={activeConnections}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    // Find and expand Database
    const dbNode = await screen.findByText('analytics');
    fireEvent.click(dbNode);

    // Verify collections folder contains count "2"
    const collectionsFolder = await screen.findByText('Collections');
    expect(collectionsFolder).toBeInTheDocument();
    
    const countBadge = await screen.findByText('(2)');
    expect(countBadge).toBeInTheDocument();
  });

  it('displays indexes folder count badge next to indexes folder when collection is expanded', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'list_databases') {
        return Promise.resolve(['analytics']);
      }
      if (cmd === 'list_collections') {
        return Promise.resolve([{ name: 'users', type: 'collection' }]);
      }
      if (cmd === 'list_indexes') {
        return Promise.resolve([
          { name: '_id_', keys: '{"_id":1}', unique: true, sparse: false },
          { name: 'email_1', keys: '{"email":1}', unique: false, sparse: false },
          { name: 'status_1', keys: '{"status":1}', unique: false, sparse: false },
        ]);
      }
      return Promise.reject(new Error(`Unhandled: ${cmd}`));
    });

    const activeConnections = [{ id: 'conn-1', name: 'Mock DB', uri: 'mongodb://mock' }];

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={activeConnections}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    // Expand Database
    const dbNode = await screen.findByText('analytics');
    fireEvent.click(dbNode);

    // Expand Collections virtual folder
    const collectionsFolder = await screen.findByText('Collections');
    fireEvent.click(collectionsFolder);

    // Click on collection to expand indexes
    const collectionNode = await screen.findByText('users');
    fireEvent.click(collectionNode);

    // Verify indexes folder contains count "3"
    const indexesFolder = await screen.findByText('indexes');
    expect(indexesFolder).toBeInTheDocument();
    
    const countBadge = await screen.findByTestId('indexes-count');
    expect(countBadge).toHaveTextContent('(3)');
  });

  it('triggers context menu on empty space and handles selections', () => {
    const handleOpenModal = vi.fn();
    const handleOpenSettings = vi.fn();

    const { container } = render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[]}
        onOpenConnectionManager={handleOpenModal}
        onDisconnect={() => {}}
        onOpenSettings={handleOpenSettings}
      />
    );

    // Trigger right click on empty space container
    const sidebarEl = container.querySelector('.sidebar');
    expect(sidebarEl).toBeInTheDocument();
    fireEvent.contextMenu(sidebarEl!);

    // Check menu options
    const newConnOption = screen.getByText('New Connection');
    const settingsOption = screen.getByText('Settings');

    expect(newConnOption).toBeInTheDocument();
    expect(settingsOption).toBeInTheDocument();

    // Click "New Connection"
    fireEvent.click(newConnOption);
    expect(handleOpenModal).toHaveBeenCalledTimes(1);

    // Re-open context menu and click "Settings"
    fireEvent.contextMenu(sidebarEl!);
    fireEvent.click(screen.getByText('Settings'));
    expect(handleOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('triggers context menu on connection node and handles actions', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'list_databases') {
        return Promise.resolve(['existing_db']);
      }
      if (cmd === 'list_collections') {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const activeConnections = [
      { id: 'uuid-1234', name: 'Mock DB Server', uri: 'mongodb://mock' },
    ];
    const handleOpenModal = vi.fn();
    const handleDisconnect = vi.fn();

    // Submit the in-app prompt modal with the given value.
    const submitPrompt = async (value: string) => {
      const input = await screen.findByTestId('dialog-input');
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    };

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={activeConnections}
        onOpenConnectionManager={handleOpenModal}
        onDisconnect={handleDisconnect}
        onOpenSettings={() => {}}
      />
    );

    // Wait for connection node to render
    const serverNode = await screen.findByText('Mock DB Server');
    expect(serverNode).toBeInTheDocument();

    // Right-click connection node
    const connectionHeader = serverNode.closest('div');
    expect(connectionHeader).toBeInTheDocument();
    fireEvent.contextMenu(connectionHeader!);

    // Verify context menu items
    const addDbOption = screen.getByText('Add Database');
    const manageOption = screen.getByText('Manage Connections');
    const disconnectOption = screen.getByText('Disconnect');

    expect(addDbOption).toBeInTheDocument();
    expect(manageOption).toBeInTheDocument();
    expect(disconnectOption).toBeInTheDocument();

    // Click Add Database, fill the in-app prompt, verify new db node renders
    fireEvent.click(addDbOption);
    await submitPrompt('created_db');
    const newDbNode = await screen.findByText('created_db');
    expect(newDbNode).toBeInTheDocument();

    // Now expand database "created_db" to reveal "collections" virtual folder
    fireEvent.click(newDbNode);
    
    // Wait for "collections" virtual folder to appear (waits for async toggleDb call)
    const collectionsFolder = await screen.findByText('Collections');
    expect(collectionsFolder).toBeInTheDocument();
    
    // Right-click database node
    fireEvent.contextMenu(newDbNode);
    const addCollOption = screen.getByText('Add Collection');
    expect(addCollOption).toBeInTheDocument();

    // Click Add Collection, fill the in-app prompt, verify collection node renders
    fireEvent.click(addCollOption);
    await submitPrompt('created_collection');

    // Expand collections folder
    fireEvent.click(collectionsFolder);

    const newCollNode = await screen.findByText('created_collection');
    expect(newCollNode).toBeInTheDocument();

    // Right-click collection to drop it
    fireEvent.contextMenu(newCollNode);
    const dropCollOption = screen.getByText('Drop Collection');
    expect(dropCollOption).toBeInTheDocument();
    fireEvent.click(dropCollOption);

    // Confirm the drop via the in-app dialog; collection node is removed
    fireEvent.click(await screen.findByTestId('dialog-confirm'));
    await waitFor(() => {
      expect(screen.queryByText('created_collection')).not.toBeInTheDocument();
    });

    // Re-trigger connection node context menu
    fireEvent.contextMenu(connectionHeader!);
    fireEvent.click(screen.getByText('Manage Connections'));
    expect(handleOpenModal).toHaveBeenCalledTimes(1);

    // Re-trigger connection node context menu
    fireEvent.contextMenu(connectionHeader!);
    fireEvent.click(screen.getByText('Disconnect'));
    expect(handleDisconnect).toHaveBeenCalledWith('uuid-1234');
  });

  it('opens Dump/Restore from the connection, database, and collection context menus', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases' && args.id === 'conn-1') {
        return Promise.resolve(['sales_db']);
      }
      if (cmd === 'list_collections' && args.id === 'conn-1' && args.db === 'sales_db') {
        return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const handleOpenDump = vi.fn();
    const handleOpenRestore = vi.fn();

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Prod DB Server', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onOpenDump={handleOpenDump}
        onOpenRestore={handleOpenRestore}
      />
    );

    // Connection-level: Dump (server scope) and Restore.
    const serverNode = await screen.findByText('Prod DB Server');
    fireEvent.contextMenu(serverNode.closest('div')!);
    fireEvent.click(screen.getByTestId('ctx-dump-conn-1'));
    expect(handleOpenDump).toHaveBeenCalledWith('conn-1');

    fireEvent.contextMenu(serverNode.closest('div')!);
    fireEvent.click(screen.getByTestId('ctx-restore-conn-1'));
    expect(handleOpenRestore).toHaveBeenCalledWith('conn-1');

    // Database-level: Dump scoped to the database.
    const dbNode = await screen.findByText('sales_db');
    fireEvent.contextMenu(dbNode);
    fireEvent.click(screen.getByTestId('ctx-dump-db-conn-1-sales_db'));
    expect(handleOpenDump).toHaveBeenCalledWith('conn-1', 'sales_db');

    // Collection-level: Dump scoped to the collection.
    fireEvent.click(dbNode);
    const collectionsFolder = await screen.findByText('Collections');
    fireEvent.click(collectionsFolder);
    const collectionNode = await screen.findByText('customers');
    fireEvent.contextMenu(collectionNode);
    fireEvent.click(screen.getByTestId('ctx-dump-coll-conn-1-sales_db-customers'));
    expect(handleOpenDump).toHaveBeenCalledWith('conn-1', 'sales_db', 'customers');
  });

  it('opens Validation Rules from the collection context menu', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases' && args.id === 'conn-1') {
        return Promise.resolve(['sales_db']);
      }
      if (cmd === 'list_collections' && args.id === 'conn-1' && args.db === 'sales_db') {
        return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const handleEditValidation = vi.fn();

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Prod DB Server', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onEditValidation={handleEditValidation}
      />
    );

    const dbNode = await screen.findByText('sales_db');
    fireEvent.click(dbNode);
    const collectionsFolder = await screen.findByText('Collections');
    fireEvent.click(collectionsFolder);
    const collectionNode = await screen.findByText('customers');
    fireEvent.contextMenu(collectionNode);
    fireEvent.click(screen.getByText('Validation Rules'));
    expect(handleEditValidation).toHaveBeenCalledWith('conn-1', 'sales_db', 'customers');
  });

  it('hides Validation Rules for views but shows it for regular collections (#93)', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases' && args.id === 'conn-1') {
        return Promise.resolve(['sales_db']);
      }
      if (cmd === 'list_collections' && args.id === 'conn-1' && args.db === 'sales_db') {
        return Promise.resolve([
          { name: 'customers', type: 'collection' },
          { name: 'active_users', type: 'view' },
        ]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Prod DB Server', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onEditValidation={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByText('sales_db'));

    // Views live in their own folder — expand it and right-click the view row.
    fireEvent.click(await screen.findByText('Views'));
    const viewNode = await screen.findByText('active_users');
    fireEvent.contextMenu(viewNode);
    expect(screen.queryByText('Validation Rules')).not.toBeInTheDocument();
    expect(screen.getByText('Analyze Schema')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // Regular collection still offers it.
    fireEvent.click(await screen.findByText('Collections'));
    const collectionNode = await screen.findByText('customers');
    fireEvent.contextMenu(collectionNode);
    expect(screen.getByText('Validation Rules')).toBeInTheDocument();
  });

  it('hides Validation Rules for time-series collections but shows it for regular collections (#93)', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases' && args.id === 'conn-1') {
        return Promise.resolve(['sales_db']);
      }
      if (cmd === 'list_collections' && args.id === 'conn-1' && args.db === 'sales_db') {
        return Promise.resolve([
          { name: 'customers', type: 'collection' },
          { name: 'sensor_readings', type: 'timeseries' },
        ]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Prod DB Server', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onEditValidation={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByText('sales_db'));
    fireEvent.click(await screen.findByText('Collections'));

    // Time-series collection: MongoDB rejects collMod validators on these.
    const tsNode = await screen.findByText('sensor_readings');
    fireEvent.contextMenu(tsNode);
    expect(screen.queryByText('Validation Rules')).not.toBeInTheDocument();
    expect(screen.getByText('Analyze Schema')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // Regular collection still offers it.
    const collectionNode = screen.getByText('customers');
    fireEvent.contextMenu(collectionNode);
    expect(screen.getByText('Validation Rules')).toBeInTheDocument();
  });

  it('hides Dump/Restore context-menu items for mock connections', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'list_databases' && args.id === 'conn-1') {
        return Promise.resolve(['sales_db']);
      }
      if (cmd === 'list_collections' && args.id === 'conn-1' && args.db === 'sales_db') {
        return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Sample (mqlens_demo)', uri: 'mongodb://mock' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onOpenDump={vi.fn()}
        onOpenRestore={vi.fn()}
      />
    );

    // Connection-level: neither Dump nor Restore is offered.
    const serverNode = await screen.findByText('Sample (mqlens_demo)');
    fireEvent.contextMenu(serverNode.closest('div')!);
    expect(screen.queryByTestId('ctx-dump-conn-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ctx-restore-conn-1')).not.toBeInTheDocument();
    // Close the menu before opening the next one.
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // Database-level: no Dump item.
    const dbNode = await screen.findByText('sales_db');
    fireEvent.contextMenu(dbNode);
    expect(screen.queryByTestId('ctx-dump-db-conn-1-sales_db')).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // Collection-level: no Dump item.
    fireEvent.click(dbNode);
    const collectionsFolder = await screen.findByText('Collections');
    fireEvent.click(collectionsFolder);
    const collectionNode = await screen.findByText('customers');
    fireEvent.contextMenu(collectionNode);
    expect(screen.queryByTestId('ctx-dump-coll-conn-1-sales_db-customers')).not.toBeInTheDocument();
  });

  it('creates, renames, and drops collections/databases via the backend for a real connection (C6/H6)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['shop']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'orders', type: 'collection' }]);
      if (
        cmd === 'create_collection' ||
        cmd === 'rename_collection' ||
        cmd === 'drop_collection' ||
        cmd === 'rename_database' ||
        cmd === 'drop_database'
      ) return Promise.resolve();
      if (cmd === 'list_indexes') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    // Drive the in-app dialog system instead of native prompt/confirm.
    const submitPrompt = async (value: string) => {
      const input = await screen.findByTestId('dialog-input');
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    };
    const clickConfirm = async () => {
      fireEvent.click(await screen.findByTestId('dialog-confirm'));
    };

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-real', name: 'Prod', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    // Connection auto-expands and loads its databases; expand the db → Collections folder.
    const dbNode = await screen.findByText('shop');
    fireEvent.click(dbNode);
    await screen.findByText('Collections');

    // Add Collection (real → create_collection invoke).
    fireEvent.contextMenu(dbNode);
    fireEvent.click(screen.getByText('Add Collection'));
    await submitPrompt('orders');
    await waitFor(() => {
      const c = calls.find((x) => x.cmd === 'create_collection');
      expect(c).toBeTruthy();
      expect(c.args).toMatchObject({ id: 'conn-real', database: 'shop', collection: 'orders' });
    });

    // Drop Collection (real → drop_collection invoke).
    fireEvent.click(screen.getByText('Collections'));
    const ordersNode = await screen.findByText('orders');
    fireEvent.contextMenu(ordersNode);
    fireEvent.click(screen.getByText('Rename Collection'));
    await submitPrompt('archived_orders');
    await waitFor(() => {
      const r = calls.find((x) => x.cmd === 'rename_collection');
      expect(r).toBeTruthy();
      expect(r.args).toMatchObject({
        id: 'conn-real',
        database: 'shop',
        from: 'orders',
        to: 'archived_orders',
      });
    });

    fireEvent.contextMenu(ordersNode);
    fireEvent.click(screen.getByText('Drop Collection'));
    await clickConfirm();
    await waitFor(() => {
      const d = calls.find((x) => x.cmd === 'drop_collection');
      expect(d).toBeTruthy();
      expect(d.args).toMatchObject({ id: 'conn-real', database: 'shop', collection: 'orders' });
    });

    // Rename Database: in-app prompt for the new name, then a confirm dialog.
    fireEvent.contextMenu(dbNode);
    fireEvent.click(screen.getByText('Rename Database'));
    await submitPrompt('shop_archive');
    await clickConfirm();
    await waitFor(() => {
      const r = calls.find((x) => x.cmd === 'rename_database');
      expect(r).toBeTruthy();
      expect(r.args).toMatchObject({
        id: 'conn-real',
        from: 'shop',
        to: 'shop_archive',
        dropSource: true,
      });
    });

    fireEvent.contextMenu(dbNode);
    fireEvent.click(screen.getByText('Drop Database'));
    await clickConfirm();
    await waitFor(() => {
      const d = calls.find((x) => x.cmd === 'drop_database');
      expect(d).toBeTruthy();
      expect(d.args).toMatchObject({ id: 'conn-real', database: 'shop' });
    });
  });

  it('shows pinned collections from storage in the Pinned section', async () => {
    localStorage.setItem(
      'mqlens_pinned_collections',
      JSON.stringify([
        { kind: 'collection', connectionName: 'Local', db: 'sales_db', collection: 'orders' },
      ]),
    );

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /pinned/i }));
    expect(await screen.findByText('orders')).toBeInTheDocument();
    expect(screen.getByText('sales_db')).toBeInTheDocument();
  });

  it('(Phase 3 Task 6c) a storage event for the pins key refreshes pinned items from another window; an unrelated key is ignored', async () => {
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /pinned/i }));
    expect(screen.queryByText('orders')).not.toBeInTheDocument();

    // A DIFFERENT window wrote to an UNRELATED localStorage key — jsdom only
    // fires `storage` via a manual dispatch (real browsers fire it natively
    // on every OTHER window; never on the window that made the write, which
    // is what the in-window PINNED_CHANGED_EVENT already covers). Must not
    // force a reload.
    localStorage.setItem('some_other_key', 'x');
    window.dispatchEvent(new StorageEvent('storage', { key: 'some_other_key', newValue: 'x' }));
    expect(screen.queryByText('orders')).not.toBeInTheDocument();

    // Another window pinned something and wrote the pins key.
    localStorage.setItem(
      'mqlens_pinned_collections',
      JSON.stringify([
        { kind: 'collection', connectionName: 'Local', db: 'sales_db', collection: 'orders' },
      ]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'mqlens_pinned_collections' }));

    expect(await screen.findByText('orders')).toBeInTheDocument();
  });

  it('pins a connection from the context menu and shows a toast', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      return Promise.resolve([]);
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    const serverNode = await screen.findByText('Local');
    fireEvent.contextMenu(serverNode.closest('div')!);
    fireEvent.click(screen.getByText('Pin to sidebar'));

    expect(await screen.findByTestId('pinned-item-conn::Local')).toBeInTheDocument();
    expect(screen.getByText('Pinned to sidebar')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('mqlens_pinned_collections')!)).toEqual([
      { kind: 'connection', connectionName: 'Local' },
    ]);
  });

  it('shows empty-state hint when pinned section has no items', async () => {
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /pinned/i }));
    expect(
      screen.getByText('Right-click a connection, database, or collection → Pin to sidebar'),
    ).toBeInTheDocument();
  });

  it('auto-connects when opening a pinned collection while offline', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([
          { id: 'prof-1', name: 'Local', uri: 'mongodb://localhost:27017' },
        ]);
      }
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      return Promise.resolve([]);
    });

    localStorage.setItem(
      'mqlens_pinned_collections',
      JSON.stringify([
        {
          kind: 'collection',
          connectionName: 'Local',
          db: 'sales_db',
          collection: 'orders',
        },
      ]),
    );

    const onSelectCollection = vi.fn();
    const onConnectProfile = vi.fn().mockResolvedValue('conn-new');

    render(
      <Sidebar
        onSelectCollection={onSelectCollection}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onConnectProfile={onConnectProfile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /pinned/i }));
    fireEvent.click(await screen.findByTestId('pinned-item-coll::Local::sales_db::orders'));

    // The auto-connect chain (connect profile → select collection) crosses two
    // awaits; under CI's coverage instrumentation the default 1s can flake.
    await waitFor(
      () => {
        expect(onConnectProfile).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'prof-1', name: 'Local' }),
        );
        expect(onSelectCollection).toHaveBeenCalledWith('conn-new', 'sales_db', 'orders');
      },
      { timeout: 5000 },
    );
  });

  it('shows a color dot for tagged active connections', async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'list_all_saved_queries') return Promise.resolve([]);
      if (cmd === 'list_databases') {
        if (args.id === 'conn-1') return Promise.resolve(['sales_db']);
      }
      if (cmd === 'list_collections') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Staging', uri: 'mongodb://staging', color_tag: '#3b82f6' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    expect(await screen.findByLabelText('Connection color')).toBeInTheDocument();
    expect(screen.getByText('Staging')).toBeInTheDocument();
  });

  it('opens a new GridFS bucket from the sidebar when none exist', async () => {
    const onOpenGridfs = vi.fn();
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'list_databases') {
        if (args.id === 'conn-1') return Promise.resolve(['demo']);
      }
      if (cmd === 'list_collections') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onOpenGridfs={onOpenGridfs}
      />
    );

    fireEvent.click(await screen.findByText('demo'));
    fireEvent.click(await screen.findByText('GridFS Buckets'));

    fireEvent.click(screen.getByTestId('gridfs-open-bucket-conn-1-demo'));
    const input = await screen.findByTestId('dialog-input');
    fireEvent.change(input, { target: { value: 'uploads' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));

    await waitFor(() => {
      expect(onOpenGridfs).toHaveBeenCalledWith('conn-1', 'demo', 'uploads');
    });
  });

  it('shows New Bucket on GridFS Buckets context menu, not empty-space items', async () => {
    const onOpenGridfs = vi.fn();
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'list_databases') {
        if (args.id === 'conn-1') return Promise.resolve(['demo']);
      }
      if (cmd === 'list_collections') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onOpenGridfs={onOpenGridfs}
      />
    );

    fireEvent.click(await screen.findByText('demo'));
    const gridfsRow = await screen.findByText('GridFS Buckets');
    fireEvent.contextMenu(gridfsRow);

    expect(screen.getByText('New Bucket')).toBeInTheDocument();
    expect(screen.queryByText('New Connection')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('shows New Collection on Collections context menu, not empty-space items', async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'list_databases') {
        if (args.id === 'conn-1') return Promise.resolve(['demo']);
      }
      if (cmd === 'list_collections') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    fireEvent.click(await screen.findByText('demo'));
    fireEvent.contextMenu(await screen.findByText('Collections'));

    expect(screen.getByText('New Collection')).toBeInTheDocument();
    expect(screen.queryByText('New Connection')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('shows Create View on Views context menu, not empty-space items', async () => {
    const onCreateView = vi.fn();
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'list_databases') {
        if (args.id === 'conn-1') return Promise.resolve(['demo']);
      }
      if (cmd === 'list_collections') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        onCreateView={onCreateView}
      />
    );

    fireEvent.click(await screen.findByText('demo'));
    fireEvent.contextMenu(await screen.findByText('Views'));

    expect(screen.getByText('Create View')).toBeInTheDocument();
    expect(screen.queryByText('New Connection')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('shows Refresh Database on System context menu, not empty-space items', async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'list_databases') {
        if (args.id === 'conn-1') return Promise.resolve(['demo']);
      }
      if (cmd === 'list_collections') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Local', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
      />
    );

    fireEvent.click(await screen.findByText('demo'));
    fireEvent.contextMenu(await screen.findByText('System'));

    expect(screen.getByText('Refresh Database')).toBeInTheDocument();
    expect(screen.queryByText('New Connection')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
  });
});
