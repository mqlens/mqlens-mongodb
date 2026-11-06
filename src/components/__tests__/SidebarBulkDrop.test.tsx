import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { DialogProvider } from '../dialogs/DialogProvider';

vi.mock('../theme/ThemePicker', () => ({ ThemePicker: () => null }));

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

const seed = (): Record<string, string[]> => ({
  shop: ['carts', 'orders'],
  crm: ['leads', 'notes'],
  logs: ['events'],
  admin: ['system.users'],
});
let COLLS = seed();

let calls: { cmd: string; args: any }[];
let failDrop: (args: any) => string | null;

const drops = () => calls.filter((c) => c.cmd === 'drop_database' || c.cmd === 'drop_collection');

const renderSidebar = (props: Partial<ComponentProps<typeof Sidebar>> = {}) =>
  render(
    <DialogProvider>
      <Sidebar
        onSelectCollection={() => {}}
        onSelectIndex={() => {}}
        activeCollection={null}
        activeConnections={[{ id: 'conn-1', name: 'Prod', uri: 'mongodb://localhost:27017' }]}
        onOpenConnectionManager={() => {}}
        onDisconnect={() => {}}
        onOpenSettings={() => {}}
        {...props}
      />
    </DialogProvider>,
  );

const setPlatform = (platform: string) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);

// `hidden` reaches rows behind an open modal, which marks the tree aria-hidden.
const dbRow = (name: string, hidden = false) =>
  screen.findByRole('button', { name: new RegExp(`^Database ${name}$`, 'i'), hidden });

/** Expand a database and its Collections folder with plain clicks. */
const expandCollections = async (db: string) => {
  fireEvent.click(await dbRow(db));
  const folders = await screen.findAllByText('Collections');
  fireEvent.click(folders[folders.length - 1]);
  await screen.findByText(COLLS[db][0]);
};

const openManage = async (row: HTMLElement) => {
  fireEvent.contextMenu(row);
  fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Manage' }), { key: 'ArrowRight' });
};

const openBulkDialog = async (row: HTMLElement, count: number) => {
  await openManage(row);
  fireEvent.click(await screen.findByRole('menuitem', { name: `Delete selected (${count})` }));
  return screen.findByTestId('bulk-drop-dialog');
};

const typeCountAndConfirm = (count: number) => {
  fireEvent.change(screen.getByTestId('bulk-drop-confirm-input'), { target: { value: String(count) } });
  fireEvent.click(screen.getByTestId('bulk-drop-confirm'));
};

describe('Sidebar: bulk delete of databases and collections (#543)', () => {
  beforeEach(() => {
    calls = [];
    COLLS = seed();
    failDrop = () => null;
    localStorage.clear();
    setPlatform('Win32');
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(Object.keys(COLLS));
      if (cmd === 'list_collections') {
        return Promise.resolve((COLLS[args.db] ?? []).map((name) => ({ name, type: 'collection' })));
      }
      if (cmd === 'drop_database' || cmd === 'drop_collection') {
        const err = failDrop(args);
        return err ? Promise.reject(err) : Promise.resolve();
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('drops two Ctrl+clicked databases after the count is typed, then reloads the tree', async () => {
    renderSidebar();
    const shop = await dbRow('shop');
    const logs = await dbRow('logs');
    fireEvent.click(shop, { ctrlKey: true });
    fireEvent.click(logs, { ctrlKey: true });
    // A modifier click selects; it does not expand the database.
    expect(shop).toHaveAttribute('aria-expanded', 'false');
    expect(shop).toHaveAttribute('data-selected', 'true');

    const dialog = await openBulkDialog(logs, 2);
    expect(within(dialog).getByText('logs')).toBeInTheDocument();
    expect(within(dialog).getByText('shop')).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(drops()).toEqual([]);

    // Disabled until the exact count is typed.
    fireEvent.change(screen.getByTestId('bulk-drop-confirm-input'), { target: { value: '1' } });
    expect(screen.getByTestId('bulk-drop-confirm')).toBeDisabled();
    const listsBefore = calls.filter((c) => c.cmd === 'list_databases').length;
    typeCountAndConfirm(2);

    await waitFor(() => expect(within(dialog).getAllByText('Dropped')).toHaveLength(2));
    expect(drops().map((c) => c.args)).toEqual([
      { id: 'conn-1', database: 'logs', confirmed: false },
      { id: 'conn-1', database: 'shop', confirmed: false },
    ]);
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === 'list_databases').length).toBeGreaterThan(listsBefore),
    );
  });

  it('uses Cmd, not Ctrl, as the toggle on macOS', async () => {
    setPlatform('MacIntel');
    renderSidebar();
    const shop = await dbRow('shop');
    fireEvent.click(shop, { ctrlKey: true });
    // Ctrl+click on a Mac is not a toggle: the row behaved as a plain click.
    expect(shop).toHaveAttribute('data-selected', 'false');
    fireEvent.click(shop, { ctrlKey: true }); // collapse again
    fireEvent.click(shop, { metaKey: true });
    fireEvent.click(await dbRow('logs'), { metaKey: true });
    expect(shop).toHaveAttribute('data-selected', 'true');
    expect(shop).toHaveAttribute('aria-expanded', 'false');
    await openBulkDialog(shop, 2);
  });

  it('ignores Meta as the toggle on Linux', async () => {
    setPlatform('Linux x86_64');
    renderSidebar();
    const shop = await dbRow('shop');
    fireEvent.click(shop, { metaKey: true });
    expect(shop).toHaveAttribute('data-selected', 'false');
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    expect(await dbRow('logs')).toHaveAttribute('data-selected', 'true');
  });

  it('Shift+click selects the visible range of collections, never the databases between', async () => {
    renderSidebar();
    await expandCollections('crm');
    await expandCollections('logs');
    fireEvent.click(screen.getByText('leads')); // plain click: opens, and anchors the range
    fireEvent.click(screen.getByText('events'), { shiftKey: true });
    // Visible order: crm, leads, notes, logs, events. The logs row sits inside
    // the range, but sweeping it in would drop all of logs.
    const selected = (name: string) => screen.getByText(name).closest('[data-selected]');
    expect(selected('leads')).toHaveAttribute('data-selected', 'true');
    expect(selected('notes')).toHaveAttribute('data-selected', 'true');
    expect(selected('events')).toHaveAttribute('data-selected', 'true');
    expect(await dbRow('logs')).toHaveAttribute('data-selected', 'false');
    expect(await dbRow('crm')).toHaveAttribute('data-selected', 'false');

    const dialog = await openBulkDialog(screen.getByText('notes'), 3);
    typeCountAndConfirm(3);
    await waitFor(() => expect(within(dialog).getAllByText('Dropped')).toHaveLength(3));
    expect(drops().map((c) => c.args)).toEqual([
      { id: 'conn-1', database: 'crm', collection: 'leads', confirmed: false },
      { id: 'conn-1', database: 'crm', collection: 'notes', confirmed: false },
      { id: 'conn-1', database: 'logs', collection: 'events', confirmed: false },
    ]);
  });

  it('offers no bulk delete when the selection comes down to one drop', async () => {
    renderSidebar();
    await expandCollections('shop');
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(screen.getByText('orders'), { ctrlKey: true });
    await openManage(await dbRow('shop'));
    expect(await screen.findByRole('menuitem', { name: 'Drop Database' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete selected/ })).toBeNull();
  });

  it('drops a selected database once and does not drop its selected collections separately', async () => {
    renderSidebar();
    await expandCollections('shop');
    await expandCollections('crm');
    fireEvent.click(screen.getByText('orders'), { ctrlKey: true });
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(screen.getByText('leads'), { ctrlKey: true });

    // Three rows selected, two drops: the menu counts drops, like the dialog.
    const dialog = await openBulkDialog(screen.getByText('leads'), 2);
    expect(within(dialog).getByTestId('bulk-drop-covered')).toHaveTextContent('orders');
    typeCountAndConfirm(2);
    await waitFor(() => expect(within(dialog).getAllByText('Dropped')).toHaveLength(2));
    expect(drops().map((c) => c.args)).toEqual([
      { id: 'conn-1', database: 'shop', confirmed: false },
      { id: 'conn-1', database: 'crm', collection: 'leads', confirmed: false },
    ]);
  });

  it('leaves everything untouched on cancel', async () => {
    renderSidebar();
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    await openBulkDialog(await dbRow('shop'), 2);
    fireEvent.click(screen.getByTestId('bulk-drop-cancel'));
    await waitFor(() => expect(screen.queryByTestId('bulk-drop-dialog')).toBeNull());
    expect(drops()).toEqual([]);
  });

  it('deletes the set confirmed at open, whatever the selection does afterwards', async () => {
    renderSidebar();
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    await openBulkDialog(await dbRow('shop'), 2);
    // Behind the modal: deselect one, select another.
    fireEvent.click(await dbRow('logs', true), { ctrlKey: true });
    fireEvent.click(await dbRow('crm', true), { ctrlKey: true });
    expect(await dbRow('crm', true)).toHaveAttribute('data-selected', 'true');
    typeCountAndConfirm(2);
    await waitFor(() => expect(drops()).toHaveLength(2));
    expect(drops().map((c) => c.args.database)).toEqual(['logs', 'shop']);
  });

  it('reports a partial failure per item and keeps the successful drops', async () => {
    failDrop = (args) => (args.database === 'logs' ? 'not authorized on logs to execute command' : null);
    renderSidebar();
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    const dialog = await openBulkDialog(await dbRow('shop'), 2);
    typeCountAndConfirm(2);
    await waitFor(() => expect(within(dialog).getByText(/not authorized on logs/)).toBeInTheDocument());
    expect(within(dialog).getAllByText('Dropped')).toHaveLength(1);
    expect(within(dialog).getByText(/1 of 2 failed/i)).toBeInTheDocument();
    expect(drops()).toHaveLength(2);
  });

  it('lists admin/local/config and system.* as skipped and never drops them', async () => {
    renderSidebar();
    fireEvent.click(await dbRow('admin'), { ctrlKey: true });
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    const dialog = await openBulkDialog(await dbRow('shop'), 2);
    expect(within(dialog).getByTestId('bulk-drop-excluded')).toHaveTextContent('admin');
    typeCountAndConfirm(2);
    await waitFor(() => expect(drops()).toHaveLength(2));
    expect(drops().map((c) => c.args.database)).toEqual(['logs', 'shop']);
  });

  it('offers no bulk delete with fewer than two deletable items selected', async () => {
    renderSidebar();
    fireEvent.click(await dbRow('admin'), { ctrlKey: true });
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    await openManage(await dbRow('shop'));
    expect(await screen.findByRole('menuitem', { name: 'Drop Database' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete selected/ })).toBeNull();
  });

  it('offers no bulk delete on a row outside the selection', async () => {
    renderSidebar();
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    await openManage(await dbRow('crm'));
    expect(await screen.findByRole('menuitem', { name: 'Drop Database' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete selected/ })).toBeNull();
  });

  it('leaves out a selected item that has since been dropped on its own', async () => {
    renderSidebar();
    await expandCollections('crm');
    fireEvent.click(screen.getByText('leads'), { ctrlKey: true });
    fireEvent.click(screen.getByText('notes'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    // Drop `leads` by itself; the server no longer lists it.
    COLLS.crm = ['notes'];
    await openManage(screen.getByText('leads'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Drop Collection' }));
    fireEvent.change(await screen.findByTestId('dialog-input'), { target: { value: 'leads' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.queryByText('leads')).toBeNull());

    const dialog = await openBulkDialog(screen.getByText('notes'), 2);
    expect(within(dialog).queryByText('leads')).toBeNull();
  });

  it('a plain click clears the selection', async () => {
    renderSidebar();
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    fireEvent.click(await dbRow('crm'));
    expect(await dbRow('shop')).toHaveAttribute('data-selected', 'false');
    expect(await dbRow('crm')).toHaveAttribute('aria-expanded', 'true');
  });

  it('sends confirmed: true on a confirm_destructive connection', async () => {
    renderSidebar({
      activeConnections: [
        { id: 'conn-1', name: 'Prod', uri: 'mongodb://localhost:27017', mode: 'confirm_destructive' },
      ],
    });
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    await openBulkDialog(await dbRow('shop'), 2);
    typeCountAndConfirm(2);
    await waitFor(() => expect(drops()).toHaveLength(2));
    expect(drops().every((c) => c.args.confirmed === true)).toBe(true);
  });

  it('refuses on a read-only connection before any dialog', async () => {
    renderSidebar({
      activeConnections: [{ id: 'conn-1', name: 'Prod', uri: 'mongodb://localhost:27017', mode: 'read_only' }],
    });
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    await openManage(await dbRow('shop'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete selected (2)' }));
    expect(await screen.findByText(/This connection is read-only/)).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-drop-dialog')).toBeNull();
    expect(drops()).toEqual([]);
  });

  it('disables bulk delete when the connection cannot drop databases', async () => {
    renderSidebar({ isCommandBlocked: (_id, cmd) => cmd === 'drop_database' });
    fireEvent.click(await dbRow('shop'), { ctrlKey: true });
    fireEvent.click(await dbRow('logs'), { ctrlKey: true });
    await openManage(await dbRow('shop'));
    expect(await screen.findByRole('menuitem', { name: 'Delete selected (2)' })).toHaveAttribute('data-disabled');
  });

  it('fails a collection whose save is still pending, and drops the rest', async () => {
    renderSidebar({
      pendingSaves: [{ connectionId: 'conn-1', db: 'crm', collection: 'leads' }],
    });
    await expandCollections('crm');
    fireEvent.click(screen.getByText('leads'), { ctrlKey: true });
    fireEvent.click(screen.getByText('notes'), { ctrlKey: true });
    const dialog = await openBulkDialog(screen.getByText('notes'), 2);
    typeCountAndConfirm(2);
    await waitFor(() => expect(within(dialog).getAllByText('Dropped')).toHaveLength(1));
    expect(drops().map((c) => c.args.collection)).toEqual(['notes']);
    expect(within(dialog).getByText(/1 of 2 failed/i)).toBeInTheDocument();
  });
});
