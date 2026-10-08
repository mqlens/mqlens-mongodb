import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DialogProvider } from '../dialogs/DialogProvider';
import { ServerAccountsPanel } from '../ServerAccountsPanel';
import type { ServerAccountView } from '@/lib/serverMode';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const render = (ui: ReactElement) => rtlRender(<DialogProvider>{ui}</DialogProvider>);

const account = (over: Partial<ServerAccountView> = {}): ServerAccountView => ({
  id: 'a1',
  name: 'Work',
  url: 'https://mqlens.example.com',
  tenant: 'acme',
  email: 'dev@example.com',
  allowInsecureHttp: false,
  signedIn: false,
  ...over,
});

const REMOTES = [
  { id: 'c1', name: 'Orders', tags: ['prod'], deploymentKind: 'replica_set', opClasses: ['read', 'write'] },
];

function backend(accounts: ServerAccountView[]) {
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'server_account_list':
        return Promise.resolve(accounts);
      case 'server_account_save': {
        const input = args!.account as ServerAccountView;
        const saved = { ...input, id: input.id ?? 'new1', signedIn: false };
        accounts = [...accounts.filter((a) => a.id !== saved.id), saved];
        return Promise.resolve(saved);
      }
      case 'server_sign_in':
        if (args!.password !== 'right') return Promise.reject('Wrong email or password');
        accounts = accounts.map((a) => (a.id === args!.accountId ? { ...a, signedIn: true } : a));
        return Promise.resolve(accounts.find((a) => a.id === args!.accountId));
      case 'server_sign_out':
        accounts = accounts.map((a) => (a.id === args!.accountId ? { ...a, signedIn: false } : a));
        return Promise.resolve({ endedOnServer: true });
      case 'server_account_delete':
        accounts = accounts.filter((a) => a.id !== args!.id);
        return Promise.resolve({ deleted: true });
      case 'server_list_connections':
        return Promise.resolve(REMOTES);
      case 'server_connect':
        return Promise.resolve({ id: 'conn-9', mongoVersion: '8.0.0', opClasses: ['read'] });
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (cmd: string) => mockInvoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => mockInvoke.mockReset());

describe('ServerAccountsPanel', () => {
  it('lists the accounts and whether each is signed in', async () => {
    backend([account(), account({ id: 'a2', name: 'Lab', signedIn: true })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    expect(await screen.findByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Lab')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
  });

  it('saves a new account from the form', async () => {
    backend([]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add server account' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://mqlens.example.com' } });
    fireEvent.change(screen.getByLabelText('Tenant'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dev@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save account' }));

    await waitFor(() => expect(calls('server_account_save')).toHaveLength(1));
    expect(calls('server_account_save')[0][1]).toEqual({
      account: {
        name: 'Work',
        url: 'https://mqlens.example.com',
        tenant: 'acme',
        email: 'dev@example.com',
        allowInsecureHttp: false,
        extraCaPem: null,
      },
    });
    expect(await screen.findByText('Work')).toBeInTheDocument();
  });

  it('signs in with the password, forgets it, and lists the connections', async () => {
    backend([account()]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    const password = screen.getByLabelText('Password');
    fireEvent.change(password, { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Work' }));

    expect(await screen.findByText('Orders')).toBeInTheDocument();
    expect(calls('server_sign_in')[0][1]).toEqual({ accountId: 'a1', password: 'right' });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('shows why a sign-in failed', async () => {
    backend([account()]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Work' }));

    expect(await screen.findByText('Wrong email or password')).toBeInTheDocument();
    expect(calls('server_list_connections')).toHaveLength(0);
  });

  it('connects to a server connection under its server profile id', async () => {
    backend([account({ signedIn: true })]);
    const onConnect = vi.fn();
    render(<ServerAccountsPanel onConnect={onConnect} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect to Orders' }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith('conn-9', 'Orders', 'server:a1:c1'));
    expect(calls('server_connect')[0][1]).toEqual({ accountId: 'a1', remoteId: 'c1' });
  });

  it('signs out', async () => {
    backend([account({ signedIn: true })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Orders')).not.toBeInTheDocument();
  });

  it('deletes an account once confirmed', async () => {
    backend([account()]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Work' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Work')).not.toBeInTheDocument());
    expect(calls('server_account_delete')[0][1]).toEqual({ id: 'a1' });
  });
});
