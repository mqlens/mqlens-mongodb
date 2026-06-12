import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { UserManagementView } from '../UserManagementView';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

const mockConfirm = vi.fn();
vi.mock('../dialogs/DialogProvider', () => ({
  useDialogs: () => ({ toast: vi.fn(), confirm: mockConfirm, prompt: vi.fn(), choose: vi.fn() }),
}));

const users = [
  {
    user: 'admin',
    db: 'admin',
    roles: [{ role: 'root', db: 'admin' }],
    mechanisms: ['SCRAM-SHA-256'],
  },
  {
    user: 'app_user',
    db: 'sales_db',
    roles: [{ role: 'readWrite', db: 'sales_db' }],
    mechanisms: ['SCRAM-SHA-256'],
  },
];

const roles = [
  { role: 'read', db: 'admin', isBuiltin: true },
  { role: 'readWrite', db: 'admin', isBuiltin: true },
];

// Default backend behavior; individual tests override per command.
const defaultInvoke = (cmd: string) => {
  switch (cmd) {
    case 'list_users':
      return Promise.resolve(users);
    case 'list_databases':
      return Promise.resolve(['admin', 'sales_db']);
    case 'list_roles':
      return Promise.resolve(roles);
    default:
      return Promise.resolve(undefined);
  }
};

describe('UserManagementView (user & role management)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation(defaultInvoke);
  });

  it('lists users as a tree and expands a user to show its roles', async () => {
    render(<UserManagementView connectionId="c1" />);

    const adminRow = await screen.findByTestId('user-row-admin.admin');
    expect(screen.getByText('app_user')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('list_users', { id: 'c1', database: null });

    // Roles are children of the user node, shown on expand.
    expect(screen.queryByText('root@admin')).not.toBeInTheDocument();
    fireEvent.click(adminRow);
    expect(screen.getByText('root@admin')).toBeInTheDocument();
    fireEvent.click(adminRow);
    expect(screen.queryByText('root@admin')).not.toBeInTheDocument();
  });

  it('filters to one database via the scope selector', async () => {
    render(<UserManagementView connectionId="c1" />);
    await screen.findByTestId('user-row-admin.admin');

    mockInvoke.mockImplementation((cmd: string, args: any) =>
      cmd === 'list_users' && args?.database === 'sales_db'
        ? Promise.resolve([users[1]])
        : defaultInvoke(cmd)
    );
    fireEvent.change(screen.getByTestId('user-db-scope'), { target: { value: 'sales_db' } });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('list_users', { id: 'c1', database: 'sales_db' })
    );
    expect(await screen.findByText('app_user')).toBeInTheDocument();
    expect(screen.queryByTestId('user-row-admin.admin')).not.toBeInTheDocument();
  });

  it('falls back to per-database listing when forAllDBs is unauthorized', async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'list_users' && args?.database === null) {
        return Promise.reject('not authorized on admin');
      }
      if (cmd === 'list_users') {
        return Promise.resolve(users.filter((u) => u.db === args.database));
      }
      return defaultInvoke(cmd);
    });
    render(<UserManagementView connectionId="c1" />);

    expect(await screen.findByText('app_user')).toBeInTheDocument();
    expect(screen.getByText(/Not authorized to list users across all databases/)).toBeInTheDocument();
  });

  it('creates a user through the editor modal', async () => {
    render(<UserManagementView connectionId="c1" />);
    await screen.findByTestId('user-row-admin.admin');

    fireEvent.click(screen.getByTestId('create-user-btn'));
    fireEvent.change(screen.getByTestId('user-name-input'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByTestId('user-authdb-input'), { target: { value: 'sales_db' } });
    fireEvent.change(screen.getByTestId('user-password-input'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByTestId('save-user-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('create_user', {
        id: 'c1',
        database: 'sales_db',
        username: 'bob',
        password: 'secret',
        roles: [],
      })
    );
  });

  it('opens scoped to a database when the database prop is set', async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) =>
      cmd === 'list_users' && args?.database === 'sales_db'
        ? Promise.resolve([users[1]])
        : defaultInvoke(cmd)
    );
    render(<UserManagementView connectionId="c1" database="sales_db" />);

    expect(await screen.findByText('app_user')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('list_users', { id: 'c1', database: 'sales_db' });
    expect(mockInvoke).not.toHaveBeenCalledWith('list_users', { id: 'c1', database: null });
  });

  it('keeps the editor modal open on overlay click, closes via the X button', async () => {
    render(<UserManagementView connectionId="c1" />);
    await screen.findByTestId('user-row-admin.admin');

    fireEvent.click(screen.getByTestId('create-user-btn'));
    const overlay = screen.getByTestId('user-editor-modal');

    fireEvent.click(overlay);
    expect(screen.getByTestId('user-editor-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('close-user-editor'));
    expect(screen.queryByTestId('user-editor-modal')).not.toBeInTheDocument();
  });

  it('offers role and database dropdowns populated from the backend', async () => {
    render(<UserManagementView connectionId="c1" />);
    await screen.findByTestId('user-row-admin.admin');

    fireEvent.click(screen.getByTestId('create-user-btn'));
    fireEvent.click(screen.getByTestId('add-role-btn'));

    const roleSelect = (await screen.findByTestId('role-select-0')) as HTMLSelectElement;
    const dbSelect = screen.getByTestId('role-db-select-0') as HTMLSelectElement;
    expect([...roleSelect.options].map((o) => o.value)).toEqual(expect.arrayContaining(['read', 'readWrite']));
    expect([...dbSelect.options].map((o) => o.value)).toEqual(expect.arrayContaining(['admin', 'sales_db']));

    fireEvent.change(roleSelect, { target: { value: 'readWrite' } });
    fireEvent.change(dbSelect, { target: { value: 'sales_db' } });
    fireEvent.change(screen.getByTestId('user-name-input'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByTestId('user-password-input'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByTestId('save-user-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('create_user', {
        id: 'c1',
        database: 'admin',
        username: 'bob',
        password: 'secret',
        roles: [{ role: 'readWrite', db: 'sales_db' }],
      })
    );
  });

  it('rejects saving when a granted role row has no role selected', async () => {
    render(<UserManagementView connectionId="c1" />);
    await screen.findByTestId('user-row-admin.admin');

    fireEvent.click(screen.getByTestId('create-user-btn'));
    fireEvent.change(screen.getByTestId('user-name-input'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByTestId('user-password-input'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByTestId('add-role-btn'));
    // Role left at "Select role…" → save must be blocked with an error.
    fireEvent.click(screen.getByTestId('save-user-btn'));

    expect(await screen.findByText(/Select a role and a database for every granted role/)).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith('create_user', expect.anything());
    expect(screen.getByTestId('user-editor-modal')).toBeInTheDocument();
  });

  it('grants and revokes roles in the editor', async () => {
    render(<UserManagementView connectionId="c1" />);
    await screen.findByTestId('user-row-admin.admin');

    fireEvent.click(screen.getByTestId('create-user-btn'));
    fireEvent.click(screen.getByTestId('add-role-btn'));
    expect(screen.getByTestId('role-row-0')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('revoke-role-0'));
    expect(screen.queryByTestId('role-row-0')).not.toBeInTheDocument();
  });

  it('drops a user via right click after confirmation', async () => {
    mockConfirm.mockResolvedValue(true);
    render(<UserManagementView connectionId="c1" />);
    const row = await screen.findByTestId('user-row-sales_db.app_user');

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Drop User'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('drop_user', {
        id: 'c1',
        database: 'sales_db',
        username: 'app_user',
      })
    );
  });

  it('does not drop when confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false);
    render(<UserManagementView connectionId="c1" />);
    const row = await screen.findByTestId('user-row-sales_db.app_user');

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Drop User'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockInvoke).not.toHaveBeenCalledWith('drop_user', expect.anything());
  });

  it('opens the editor via right click → Edit User', async () => {
    render(<UserManagementView connectionId="c1" />);
    const row = await screen.findByTestId('user-row-sales_db.app_user');

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Edit User'));

    expect(screen.getByTestId('user-editor-modal')).toBeInTheDocument();
    expect((screen.getByTestId('user-name-input') as HTMLInputElement).value).toBe('app_user');
  });

  it('offers Create User on empty-space right click', async () => {
    render(<UserManagementView connectionId="c1" />);
    await screen.findByTestId('user-row-admin.admin');

    fireEvent.contextMenu(screen.getByTestId('users-tree'));
    const ctxMenu = await screen.findByTestId('context-menu');
    expect(within(ctxMenu).queryByText('Edit User')).not.toBeInTheDocument();
    fireEvent.click(within(ctxMenu).getByText('Create User'));

    expect(screen.getByTestId('user-editor-modal')).toBeInTheDocument();
    expect((screen.getByTestId('user-name-input') as HTMLInputElement).value).toBe('');
  });

  it('shows an error state when listing fails entirely', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'list_users' || cmd === 'list_databases'
        ? Promise.reject('connection lost')
        : defaultInvoke(cmd)
    );
    render(<UserManagementView connectionId="c1" />);
    expect(await screen.findByText(/connection lost/)).toBeInTheDocument();
  });
});
