import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DialogProvider } from '../dialogs/DialogProvider';
import { ServerAccountsPanel } from '../ServerAccountsPanel';
import type { ServerAccountView } from '@/lib/serverMode';
import type { ConnectionMode } from '@/lib/connection';

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
  auth: 'password',
  allowInsecureHttp: false,
  signedIn: false,
  ...over,
});

const ssoAccount = (over: Partial<ServerAccountView> = {}) =>
  account({ auth: 'oidc', email: '', ...over });

const OKTA = { id: 'okta-id', name: 'Okta' };
const ENTRA = { id: 'entra-id', name: 'Entra ID' };

const REMOTES = [
  { id: 'c1', name: 'Orders', tags: ['prod'], deploymentKind: 'replica_set', opClasses: ['read', 'write'] },
];

function backend(accounts: ServerAccountView[], over: Record<string, unknown> = {}) {
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd in over) return Promise.resolve(over[cmd]);
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
      case 'server_connect': {
        const stored = accounts.find((a) => a.id === args!.accountId)?.connectionModes?.[args!.remoteId as string];
        return Promise.resolve({ id: 'conn-9', mongoVersion: '8.0.0', opClasses: ['read'], mode: stored ?? 'normal' });
      }
      case 'server_connection_mode_set': {
        accounts = accounts.map((a) =>
          a.id === args!.accountId
            ? { ...a, connectionModes: { ...a.connectionModes, [args!.remoteId as string]: args!.mode as ConnectionMode } }
            : a
        );
        return Promise.resolve(accounts.find((a) => a.id === args!.accountId));
      }
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
        auth: 'password',
        allowInsecureHttp: false,
        extraCaPem: null,
      },
    });
    expect(await screen.findByText('Work')).toBeInTheDocument();
  });

  it('asks an identity provider account for no email', async () => {
    backend([]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add server account' }));
    fireEvent.change(screen.getByLabelText('Sign-in method'), { target: { value: 'oidc' } });
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://mqlens.example.com' } });
    fireEvent.change(screen.getByLabelText('Tenant'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save account' }));

    await waitFor(() => expect(calls('server_account_save')).toHaveLength(1));
    expect(calls('server_account_save')[0][1]).toMatchObject({ account: { auth: 'oidc', email: '' } });
  });

  it('still needs an email for a password account', async () => {
    backend([]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add server account' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://mqlens.example.com' } });
    fireEvent.change(screen.getByLabelText('Tenant'), { target: { value: 'acme' } });

    expect(screen.getByRole('button', { name: 'Save account' })).toBeDisabled();
  });

  it('keeps how an account signs in through an edit', async () => {
    backend([ssoAccount({ email: 'sso.user@example.com' })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Work' }));
    expect(screen.getByLabelText('Sign-in method')).toHaveValue('oidc');
    fireEvent.click(screen.getByRole('button', { name: 'Save account' }));

    await waitFor(() => expect(calls('server_account_save')).toHaveLength(1));
    expect(calls('server_account_save')[0][1]).toMatchObject({ account: { auth: 'oidc' } });
  });

  it('shows an account nobody has signed in to by its server alone', async () => {
    backend([ssoAccount()]);
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    expect(await screen.findByText('https://mqlens.example.com')).toBeInTheDocument();
  });

  it('goes straight to the browser when the tenant has one provider', async () => {
    backend([ssoAccount()], {
      server_oidc_providers: [OKTA],
      server_oidc_sign_in: ssoAccount({ email: 'sso.user@example.com', signedIn: true }),
    });
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Orders')).toBeInTheDocument();
    expect(calls('server_oidc_providers')[0][1]).toEqual({ accountId: 'a1' });
    expect(calls('server_oidc_sign_in')[0][1]).toEqual({
      accountId: 'a1',
      providerId: 'okta-id',
      loginId: expect.any(String),
    });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByText('sso.user@example.com · https://mqlens.example.com')).toBeInTheDocument();
  });

  it('asks which provider when the tenant has several', async () => {
    backend([ssoAccount()], {
      server_oidc_providers: [OKTA, ENTRA],
      server_oidc_sign_in: ssoAccount({ signedIn: true }),
    });
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Entra ID' }));

    await waitFor(() => expect(calls('server_oidc_sign_in')).toHaveLength(1));
    expect(calls('server_oidc_sign_in')[0][1]).toMatchObject({ providerId: 'entra-id' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Sign in with Okta' })).not.toBeInTheDocument()
    );
  });

  it('can back out of choosing a provider', async () => {
    backend([ssoAccount()], { server_oidc_providers: [OKTA, ENTRA] });
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Sign in with Okta' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Sign in with Okta' })).not.toBeInTheDocument();
    expect(calls('server_oidc_sign_in')).toHaveLength(0);
  });

  it('says when the tenant has no identity provider', async () => {
    backend([ssoAccount()], { server_oidc_providers: [] });
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('has no identity provider');
    expect(calls('server_oidc_sign_in')).toHaveLength(0);
  });

  describe('while the browser is open', () => {
    function browserOpen() {
      let settle!: { resolve: (view: ServerAccountView) => void; reject: (reason: unknown) => void };
      const finished = new Promise<ServerAccountView>((resolve, reject) => {
        settle = { resolve, reject };
      });
      backend([ssoAccount()], { server_oidc_providers: [OKTA], server_oidc_sign_in: finished });
      return settle;
    }

    const started = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
      await screen.findByText('Finish signing in in your browser.');
      return calls('server_oidc_sign_in')[0][1].loginId as string;
    };

    it('can send the browser back to the same login', async () => {
      browserOpen();
      render(<ServerAccountsPanel onConnect={vi.fn()} />);
      const loginId = await started();

      fireEvent.click(screen.getByRole('button', { name: 'Open browser again' }));

      expect(calls('reopen_oidc_login')[0][1]).toEqual({ loginId });
    });

    it('cancels without calling that a failure', async () => {
      const settle = browserOpen();
      render(<ServerAccountsPanel onConnect={vi.fn()} />);
      const loginId = await started();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(calls('cancel_oidc_login')[0][1]).toEqual({ loginId });
      settle.reject('auth.oidc.errors.cancelled');

      await waitFor(() =>
        expect(screen.queryByText('Finish signing in in your browser.')).not.toBeInTheDocument()
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    });

    it('stops the login when the panel goes away', async () => {
      browserOpen();
      const { unmount } = render(<ServerAccountsPanel onConnect={vi.fn()} />);
      const loginId = await started();

      unmount();

      expect(calls('cancel_oidc_login')[0][1]).toEqual({ loginId });
    });

    it('says why a sign-in failed, in words', async () => {
      const settle = browserOpen();
      render(<ServerAccountsPanel onConnect={vi.fn()} />);
      await started();

      settle.reject('auth.oidc.errors.timedOut');

      expect(await screen.findByRole('alert')).toHaveTextContent('The browser login expired');
      expect(screen.queryByText('Finish signing in in your browser.')).not.toBeInTheDocument();
    });
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

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith('conn-9', 'Orders', 'server:a1:c1', 'normal'));
    expect(calls('server_connect')[0][1]).toEqual({ accountId: 'a1', remoteId: 'c1' });
  });

  it('connects in the mode chosen for the connection, and remembers a new choice', async () => {
    backend([account({ signedIn: true, connectionModes: { c1: 'read_only' } })]);
    const onConnect = vi.fn();
    render(<ServerAccountsPanel onConnect={onConnect} />);

    const mode = await screen.findByRole('combobox', { name: 'Mode for Orders' });
    expect(mode).toHaveValue('read_only');
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Orders' }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith('conn-9', 'Orders', 'server:a1:c1', 'read_only'));

    fireEvent.change(mode, { target: { value: 'confirm_destructive' } });
    await waitFor(() =>
      expect(calls('server_connection_mode_set')[0]?.[1]).toEqual({
        accountId: 'a1',
        remoteId: 'c1',
        mode: 'confirm_destructive',
      })
    );
    await waitFor(() => expect(mode).toHaveValue('confirm_destructive'));
  });

  it('connects in the mode the accounts file holds, not one this window last showed', async () => {
    // Another window chose read-only after this one loaded the account.
    backend([account({ signedIn: true })], {
      server_connect: { id: 'conn-9', mongoVersion: '8.0.0', opClasses: ['read'], mode: 'read_only' },
    });
    const onConnect = vi.fn();
    render(<ServerAccountsPanel onConnect={onConnect} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect to Orders' }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith('conn-9', 'Orders', 'server:a1:c1', 'read_only'));
  });

  it('does not change the mode of a connection that is open', async () => {
    backend([account({ signedIn: true })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} activeProfileIds={['server:a1:c1']} />);

    expect(await screen.findByRole('combobox', { name: 'Mode for Orders' })).toBeDisabled();
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

  it('shows the warning a save returns', async () => {
    backend([account()], {
      server_account_save: { ...account(), warning: 'The previous server session could not be ended.' },
    });
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save account' }));

    expect(await screen.findByText('The previous server session could not be ended.')).toBeInTheDocument();
  });

  it("warns when a deleted account's session could not be ended", async () => {
    backend([account({ signedIn: true })], { server_account_delete: { deleted: true, sessionRevoked: false } });
    render(<ServerAccountsPanel onConnect={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Work' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText('Deleted, but the server did not confirm the session ended.'),
    ).toBeInTheDocument();
  });

  it('does not connect again to a server connection that is already open', async () => {
    backend([account({ signedIn: true })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} activeProfileIds={['server:a1:c1']} />);

    expect(await screen.findByRole('button', { name: 'Connect to Orders' })).toBeDisabled();
  });

  it('does not delete an account while its connections are open', async () => {
    backend([account({ signedIn: true })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} activeProfileIds={['server:a1:c1']} />);

    const del = await screen.findByRole('button', { name: 'Delete Work' });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', "Disconnect this account's connections first.");
  });

  it('keeps the server identity fixed while its connections are open, but not the name', async () => {
    backend([account({ signedIn: true })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} activeProfileIds={['server:a1:c1']} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Work' }));
    for (const label of ['Server URL', 'Tenant', 'Email']) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByLabelText('Name')).toBeEnabled();
    expect(screen.getByText("Disconnect this account's connections to change its server, tenant, email or sign-in method.")).toBeInTheDocument();
    expect(screen.getByLabelText('Sign-in method')).toBeDisabled();
  });

  it('leaves another account alone', async () => {
    backend([account({ signedIn: true })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} activeProfileIds={['server:a2:c1']} />);

    expect(await screen.findByRole('button', { name: 'Delete Work' })).toBeEnabled();
  });

  it('does not sign out while the account has connections open', async () => {
    backend([account({ signedIn: true })]);
    render(<ServerAccountsPanel onConnect={vi.fn()} activeProfileIds={['server:a1:c1']} />);

    const signOut = await screen.findByRole('button', { name: 'Sign out' });
    expect(signOut).toBeDisabled();
    expect(signOut).toHaveAttribute('title', "Disconnect this account's connections first.");
  });
});
