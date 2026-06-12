import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('lists users with roles across all databases by default', async () => {
    render(<UserManagementView connectionId="c1" />);

    expect(await screen.findByTestId('user-row-admin.admin')).toBeInTheDocument();
    expect(screen.getByText('app_user')).toBeInTheDocument();
    expect(screen.getByText('root')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('list_users', { id: 'c1', database: null });
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

  it('drops a user after confirmation', async () => {
    mockConfirm.mockResolvedValue(true);
    render(<UserManagementView connectionId="c1" />);
    await screen.findByText('app_user');

    fireEvent.click(screen.getByTestId('drop-user-app_user'));

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
    await screen.findByText('app_user');

    fireEvent.click(screen.getByTestId('drop-user-app_user'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockInvoke).not.toHaveBeenCalledWith('drop_user', expect.anything());
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
