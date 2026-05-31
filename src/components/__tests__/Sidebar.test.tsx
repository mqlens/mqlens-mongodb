import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { DialogProvider } from '../dialogs/DialogProvider';

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
        theme="dark"
        onToggleTheme={() => {}}
        onOpenSettings={() => {}}
      />
    );
    
    const connectBtn = screen.getByRole('button', { name: /connect to database/i });
    expect(connectBtn).toBeInTheDocument();
    
    fireEvent.click(connectBtn);
    expect(handleOpenModal).toHaveBeenCalledTimes(1);
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
        theme="dark"
        onToggleTheme={() => {}}
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
        theme="dark"
        onToggleTheme={() => {}}
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
        theme="dark"
        onToggleTheme={() => {}}
        onOpenSettings={() => {}}
      />
    );
    const sidebarEl = container.querySelector('.sidebar');
    expect(sidebarEl).toHaveStyle({ width: '350px' });
  });

  it('calls onToggleTheme when the theme button is clicked', () => {
    const handleToggleTheme = vi.fn();
    render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        theme="dark"
        onToggleTheme={handleToggleTheme}
        onOpenSettings={() => {}}
      />
    );
    const themeBtn = screen.getByRole('button', { name: /toggle theme/i });
    fireEvent.click(themeBtn);
    expect(handleToggleTheme).toHaveBeenCalledTimes(1);
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
        theme="dark"
        onToggleTheme={() => {}}
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
        theme="dark"
        onToggleTheme={() => {}}
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
        theme="dark"
        onToggleTheme={() => {}}
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
    const handleToggleTheme = vi.fn();

    const { container } = render(
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[]}
        onOpenConnectionManager={handleOpenModal}
        onDisconnect={() => {}}
        theme="dark"
        onToggleTheme={handleToggleTheme}
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
    const toggleThemeOption = screen.getByText('Toggle Theme');

    expect(newConnOption).toBeInTheDocument();
    expect(settingsOption).toBeInTheDocument();
    expect(toggleThemeOption).toBeInTheDocument();

    // Click "New Connection"
    fireEvent.click(newConnOption);
    expect(handleOpenModal).toHaveBeenCalledTimes(1);

    // Re-open context menu and click "Settings"
    fireEvent.contextMenu(sidebarEl!);
    fireEvent.click(screen.getByText('Settings'));
    expect(handleOpenSettings).toHaveBeenCalledTimes(1);

    // Re-open context menu and click "Toggle Theme"
    fireEvent.contextMenu(sidebarEl!);
    fireEvent.click(screen.getByText('Toggle Theme'));
    expect(handleToggleTheme).toHaveBeenCalledTimes(1);
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
        theme="dark"
        onToggleTheme={() => {}}
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
        theme="dark"
        onToggleTheme={() => {}}
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
});
