import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER, type ServerAccountSeed } from '../harness/seed';
import { callFrom, dismissHoverCards, STAGING_URI, view } from '../helpers';

// MQLens Server accounts, and the connections made through them (#396).

// Every op class, so the empty blocked list the fake reports by default is what the backend would report.
const ORDERS = { id: 'orders', name: 'Orders', server: STAGING_URI, opClasses: ['read', 'write', 'ddl', 'admin'] };

const WORK = (over: Partial<ServerAccountSeed> = {}): ServerAccountSeed => ({
  id: 'acct-w',
  name: 'Work',
  url: 'https://mqlens.example.com',
  tenant: 'acme',
  email: 'dev@example.com',
  password: 'right',
  connections: [ORDERS],
  ...over,
});

const servers = { [STAGING_URI]: SAMPLE_SERVER };
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');

/** The connection manager, on its MQLens Server accounts. */
async function openServerAccounts(page: Page): Promise<void> {
  await button(page, 'Manage Connections').click();
  await button(page, 'MQLens Server').click();
  await expect(button(page, 'Add server account')).toBeVisible();
}

/** Sign in to Work from the accounts panel. */
async function signIn(page: Page, password: string): Promise<void> {
  await page.getByRole('listitem').filter({ hasText: 'dev@example.com' }).getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await button(page, 'Sign in to Work').click();
}

test.describe('MQLens Server accounts', () => {
  test('adds an account, signs in and connects through it', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [WORK()] });
    await openServerAccounts(page);

    await button(page, 'Add server account').click();
    await page.getByLabel('Name', { exact: true }).fill('Lab');
    await page.getByLabel('Server URL').fill('http://localhost:8080');
    await page.getByLabel('Tenant').fill('lab');
    await page.getByLabel('Email').fill('lab@example.com');
    await page.getByLabel(/Allow plain http/).click();
    const saved = await callFrom(app, 'server_account_save', () => button(page, 'Save account').click());
    expect(saved.account).toMatchObject({ name: 'Lab', url: 'http://localhost:8080', allowInsecureHttp: true, extraCaPem: null });
    await expect(page.getByText('Lab', { exact: true })).toBeVisible();

    // Starting a sign-in and thinking better of it leaves nothing behind.
    await page.getByRole('listitem').filter({ hasText: 'dev@example.com' }).getByRole('button', { name: 'Sign in', exact: true }).click();
    await button(page, 'Cancel').click();
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);

    await signIn(page, 'wrong');
    await expect(page.getByRole('alert')).toContainText('Wrong email or password');
    await page.getByLabel('Password', { exact: true }).fill('right');
    await button(page, 'Sign in to Work').click();
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);

    const connected = await callFrom(app, 'server_connect', () => button(page, 'Connect to Orders').click());
    expect(connected).toEqual({ accountId: 'acct-w', remoteId: 'orders' });
    await expect(sidebar(page).getByTestId('connection-server-badge')).toHaveAttribute('title', 'Through the MQLens Server account Work');
    await sidebar(page).getByText('sales_db', { exact: true }).click();
    await dismissHoverCards(page);
  });

  test('keeps an account with open connections pointing where they do', async ({ app, page }) => {
    await app.open({
      servers,
      serverAccounts: [WORK({ signedIn: true, signOutUnconfirmed: true, saveWarning: 'The previous server session could not be ended.' })],
    });
    await openServerAccounts(page);
    await button(page, 'Connect to Orders').click();
    await openServerAccounts(page);

    await expect(button(page, 'Connect to Orders')).toBeDisabled();
    await expect(button(page, 'Connect to Orders')).toHaveText('Already Connected');
    await expect(button(page, 'Delete Work')).toBeDisabled();
    await expect(button(page, 'Sign out')).toBeDisabled();
    await button(page, 'Edit Work').click();
    await expect(page.getByLabel('Server URL')).toBeDisabled();
    await expect(page.getByText("Disconnect this account's connections to change its server, tenant, email or sign-in method.")).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Work (EU)');
    await button(page, 'Save account').click();
    // Only the name changed, so the session stays and nothing was displaced.
    await expect(page.getByText('Work (EU)', { exact: true })).toBeVisible();
    await expect(page.getByText('The previous server session could not be ended.')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await sidebar(page).getByText('Orders', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Disconnect' }).click();
    await openServerAccounts(page);
    await button(page, 'Sign out').click();
    await expect(page.getByText('Signed out here, but the server did not confirm the session ended.')).toBeVisible();
    await button(page, 'Delete Work (EU)').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('No MQLens Server accounts yet.')).toBeVisible();
  });
});

test.describe('An account that signs in through an identity provider', () => {
  const OKTA = { id: 'okta-id', name: 'Okta' };
  const SSO = (over: Partial<ServerAccountSeed> = {}) => WORK({ auth: 'oidc', email: '', password: undefined, oidcProviders: [OKTA], ...over });
  const row = (page: Page) => page.getByRole('listitem').filter({ hasText: 'https://mqlens.example.com' });
  const WAITING = 'Finish signing in in your browser.';

  test('needs no email to be added', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [] });
    await openServerAccounts(page);

    await button(page, 'Add server account').click();
    await page.getByLabel('Sign-in method').selectOption('oidc');
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await page.getByLabel('Name', { exact: true }).fill('Work');
    await page.getByLabel('Server URL').fill('https://mqlens.example.com');
    await page.getByLabel('Tenant').fill('acme');
    const saved = await callFrom(app, 'server_account_save', () => button(page, 'Save account').click());

    expect(saved.account).toMatchObject({ auth: 'oidc', email: '' });
    await expect(row(page).getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });

  test('signs in as who the server names, and connects', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [SSO({ oidcEmail: 'sso.user@example.com' })] });
    await openServerAccounts(page);

    await row(page).getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(row(page).getByText('sso.user@example.com · https://mqlens.example.com')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await button(page, 'Connect to Orders').click();
    await expect(sidebar(page).getByText('Orders')).toBeVisible();
  });

  test('asks which provider when the tenant has several', async ({ app, page }) => {
    const providers = [OKTA, { id: 'entra-id', name: 'Entra ID' }];
    await app.open({ servers, serverAccounts: [SSO({ oidcProviders: providers, oidcEmail: 'sso.user@example.com' })] });
    await openServerAccounts(page);

    await row(page).getByRole('button', { name: 'Sign in', exact: true }).click();
    const started = await callFrom(app, 'server_oidc_sign_in', () => button(page, 'Sign in with Entra ID').click());

    expect(started.providerId).toBe('entra-id');
    await expect(row(page).getByText('sso.user@example.com')).toBeVisible();
  });

  test('says when the tenant has no provider', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [SSO({ oidcProviders: [] })] });
    await openServerAccounts(page);

    await row(page).getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByRole('alert')).toHaveText('This tenant has no identity provider to sign in with.');
  });

  test('can reopen or abandon the browser', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [SSO()] });
    await openServerAccounts(page);

    await row(page).getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText(WAITING)).toBeVisible();

    const reopened = await callFrom(app, 'reopen_oidc_login', () => button(page, 'Open browser again').click());
    expect(reopened.loginId).toEqual(expect.any(String));
    await expect(page.getByText(WAITING)).toBeVisible();

    await button(page, 'Cancel').click();
    await expect(page.getByText(WAITING)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(row(page).getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  });

  test('stops the login when the connection manager closes', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [SSO()] });
    await openServerAccounts(page);

    await row(page).getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText(WAITING)).toBeVisible();

    await callFrom(app, 'cancel_oidc_login', () => page.keyboard.press('Escape'));
  });
});

test.describe('Editing an account', () => {
  test('signs it out when it points somewhere else', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [WORK({ signedIn: true, saveWarning: 'The previous server session could not be ended.' })] });
    await openServerAccounts(page);
    await expect(button(page, 'Sign out')).toBeVisible();

    await button(page, 'Edit Work').click();
    await page.getByLabel('Server URL').fill('https://other.example.com');
    await button(page, 'Save account').click();

    await expect(button(page, 'Sign in')).toBeVisible();
    await expect(button(page, 'Connect to Orders')).toHaveCount(0);
    await expect(page.getByText('The previous server session could not be ended.')).toBeVisible();
  });

  test('treats an explicit port as another server', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [WORK({ signedIn: true })] });
    await openServerAccounts(page);

    await button(page, 'Edit Work').click();
    await page.getByLabel('Server URL').fill('https://mqlens.example.com:443');
    await button(page, 'Save account').click();

    await expect(button(page, 'Sign in')).toBeVisible();
  });

  test('keeps it signed in when only how it is written changes', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [WORK({ signedIn: true })] });
    await openServerAccounts(page);

    await button(page, 'Edit Work').click();
    await page.getByLabel('Email').fill('Dev@Example.com');
    await page.getByLabel('Server URL').fill('https://MQLENS.Example.com/');
    await button(page, 'Save account').click();

    await expect(button(page, 'Sign out')).toBeVisible();
  });

  test('refuses what the backend would refuse, saying why', async ({ app, page }) => {
    await app.open({ servers });
    await openServerAccounts(page);
    await button(page, 'Add server account').click();
    await page.getByLabel('Name', { exact: true }).fill('Lab');
    await page.getByLabel('Tenant').fill('lab');

    for (const [url, email, why] of [
      ['http://lab.example.com', 'me@example.com', 'must use https:// unless the server runs on this computer'],
      ['https://lab.example.com/api', 'me@example.com', 'must not include a path'],
      ['http://127.0.0.1.example.com', 'me@example.com', 'must use https:// unless the server runs on this computer'],
      ['https://@lab.example.com', 'me@example.com', 'must not include a user name or password'],
      ['https://lab.example.com/#settings', 'me@example.com', 'Invalid MQLens Server URL'],
      ['https://lab.example.com', 'not an email', 'Enter the email address'],
    ]) {
      await page.getByLabel('Server URL').fill(url);
      await page.getByLabel('Email').fill(email);
      await button(page, 'Save account').click();
      await expect(page.getByRole('alert')).toContainText(why);
    }
    expect(await app.calls('server_account_list')).toHaveLength(1);
  });

  test('does not connect where the user may do nothing', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [WORK({ signedIn: true, connections: [{ ...ORDERS, opClasses: [] }] })] });
    await openServerAccounts(page);

    await button(page, 'Connect to Orders').click();

    await expect(page.getByRole('alert')).toContainText('not available to you');
    expect((await app.calls('server_connect'))[0].error).toContain('not available to you');
  });

  test('keeps a new account apart from one already stored', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [WORK({ id: 'acct-1', name: 'Lab' })] });
    await openServerAccounts(page);

    await button(page, 'Add server account').click();
    await page.getByLabel('Name', { exact: true }).fill('Home');
    await page.getByLabel('Server URL').fill('https://home.example.com');
    await page.getByLabel('Tenant').fill('home');
    await page.getByLabel('Email').fill('me@example.com');
    await button(page, 'Save account').click();
    await button(page, 'Delete Home').click();
    await page.getByTestId('dialog-confirm').click();

    await expect(page.getByText('Home', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Lab', { exact: true })).toBeVisible();
  });
});

test.describe('A server connection', () => {
  const BLOCKED = [
    'drop_database',
    'insert_document',
    'update_document',
    'update_many',
    'delete_document',
    'delete_many',
    'start_collection_export',
    'start_filtered_export',
    'start_import_task',
    'start_mongosh_session',
    'explain_mql_query',
    'explain_aggregate_query',
    'execute_aggregate',
    'analyze_schema',
    'list_users',
  ];

  test('offers only what it can run', async ({ app, page }) => {
    await app.open({
      servers,
      serverAccounts: [WORK({ signedIn: true, connections: [{ ...ORDERS, blockedCommands: BLOCKED }] })],
    });
    await openServerAccounts(page);
    await button(page, 'Connect to Orders').click();

    const db = sidebar(page).getByText('sales_db', { exact: true });
    await db.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /Manage Users/ })).toHaveAttribute('data-disabled', '');
    await page.getByRole('menuitem', { name: 'Manage', exact: true }).press('ArrowRight');
    await expect(page.getByRole('menuitem', { name: 'Drop Database' })).toHaveAttribute('data-disabled', '');
    await page.keyboard.press('Escape');

    await db.click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('Collections', { exact: true }).first().click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('customers', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page)).toContainText('Alice Smith');

    await expect(view(page).getByTestId('insert-doc-btn')).toBeDisabled();
    await expect(view(page).getByTestId('mode-aggregate-tab')).toBeDisabled();
    await expect(view(page).getByTestId('explain-plan-tab')).toBeDisabled();
    await expect(view(page).getByTestId('export-btn')).toHaveCount(0);
    await expect(view(page).getByTestId('import-btn')).toHaveCount(0);
    await expect(view(page).getByTestId('analyze-schema-btn')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('command-palette-input').fill('Export Collection');
    await expect(page.getByTestId('command-palette').getByText('Export Collection…')).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(await app.calls('execute_aggregate')).toHaveLength(0);
  });

  test('analyzes the schema without offering rules it may not set', async ({ app, page }) => {
    await app.open({
      servers,
      serverAccounts: [WORK({ signedIn: true, connections: [{ ...ORDERS, blockedCommands: ['set_validator'] }] })],
    });
    await openServerAccounts(page);
    await button(page, 'Connect to Orders').click();
    await sidebar(page).getByText('sales_db', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('Collections', { exact: true }).first().click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('customers', { exact: true }).click();
    await dismissHoverCards(page);

    await view(page).getByTestId('analyze-schema-btn').click();
    await expect(view(page).getByTestId('schema-tab-fields')).toBeVisible();
    await expect(view(page).getByTestId('schema-tab-validation')).toHaveCount(0);
    expect(await app.calls('get_collection_options')).toHaveLength(0);
  });

  test('edits validation rules without offering to generate them from a sample it may not take', async ({ app, page }) => {
    await app.open({
      servers,
      serverAccounts: [WORK({ signedIn: true, connections: [{ ...ORDERS, blockedCommands: ['analyze_schema'] }] })],
    });
    await openServerAccounts(page);
    await button(page, 'Connect to Orders').click();
    await sidebar(page).getByText('sales_db', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('Collections', { exact: true }).first().click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Validation Rules' }).click();
    await dismissHoverCards(page);

    await expect(view(page).getByTestId('validation-apply-btn')).toBeVisible();
    await expect(view(page).getByTestId('validation-generate-btn')).toHaveCount(0);
  });

  test('monitors what it can, and says what it cannot', async ({ app, page }) => {
    const blocked = ['current_ops', 'kill_op', 'read_profile', 'set_profiling_level'];
    await app.open({
      servers,
      serverAccounts: [WORK({ signedIn: true, connections: [{ ...ORDERS, blockedCommands: blocked }] })],
    });
    await openServerAccounts(page);
    await button(page, 'Connect to Orders').click();

    await sidebar(page).getByText('Orders', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Monitor cluster' }).click();
    await expect(view(page).getByTestId('mon-panel-ops')).toContainText('Not available on MQLens Server yet');
    await view(page).getByTestId('mon-tab-profiler').click();
    await expect(view(page).getByTestId('profiler-level-1')).toBeDisabled();
    await expect(view(page).getByTestId('mon-panel-profiler')).toContainText('Not available on MQLens Server yet');
    for (const command of blocked) expect(await app.calls(command)).toHaveLength(0);
  });

  test('opens a server connection in the mode chosen for it', async ({ app, page }) => {
    await app.open({ servers, serverAccounts: [WORK({ signedIn: true, connections: [ORDERS] })] });
    await openServerAccounts(page);

    await page.getByRole('combobox', { name: 'Mode for Orders' }).selectOption('read_only');
    await expect(page.getByRole('combobox', { name: 'Mode for Orders' })).toHaveValue('read_only');
    await button(page, 'Connect to Orders').click();

    await sidebar(page).getByText('sales_db', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('Collections', { exact: true }).first().click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('customers', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page)).toContainText('Alice Smith');
    await expect(view(page).getByTestId('insert-doc-btn')).toBeDisabled();
    expect(await app.calls('server_connection_mode_set')).toHaveLength(1);
  });

  test('says when the role, not the server, rules an action out', async ({ app, page }) => {
    const ROLE = 'Your role on this MQLens Server connection does not allow this';
    const blocked = ['drop_database', 'current_ops', 'kill_op', 'read_profile', 'set_profiling_level'];
    await app.open({
      servers,
      serverAccounts: [
        WORK({
          signedIn: true,
          connections: [{ ...ORDERS, opClasses: ['read'], blockedCommands: blocked, roleBlockedCommands: blocked }],
        }),
      ],
    });
    await openServerAccounts(page);
    await button(page, 'Connect to Orders').click();

    await sidebar(page).getByText('sales_db', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Manage', exact: true }).press('ArrowRight');
    await expect(page.getByRole('menuitem', { name: 'Drop Database' })).toHaveAttribute('title', ROLE);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await sidebar(page).getByText('Orders', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Monitor cluster' }).click();
    await expect(view(page).getByTestId('mon-panel-ops')).toContainText(ROLE);
    await view(page).getByTestId('mon-tab-profiler').click();
    await expect(view(page).getByTestId('mon-panel-profiler')).toContainText(ROLE);
  });

  test('reconnects a restored tab, offering a sign-in when it needs one', async ({ app, page }) => {
    const tab = {
      id: 'profile:server:acct-w:orders.sales_db.customers',
      type: 'collection',
      profileId: 'server:acct-w:orders',
      profileName: 'Orders',
      db: 'sales_db',
      collection: 'customers',
    };
    await app.open({
      servers,
      serverAccounts: [WORK()],
      workspace: {
        revision: 1,
        windows: [{ id: 'main', splitTree: { kind: 'pane', id: 'pane-1', tabIds: [tab.id], activeTabId: tab.id }, focusedPaneId: 'pane-1' }],
        tabs: [tab],
      },
    });

    const banner = page.getByTestId('reconnect-banner');
    await banner.getByRole('button', { name: 'Reconnect Orders' }).click();
    await expect(page.getByTestId('reconnect-error')).toContainText('Sign in to the MQLens Server account "Work" first');
    await banner.getByRole('button', { name: 'Sign in…' }).click();
    await expect(button(page, 'Add server account')).toBeVisible();
    await signIn(page, 'right');
    await expect(button(page, 'Connect to Orders')).toBeVisible();
    await page.keyboard.press('Escape');

    const reconnected = await callFrom(app, 'server_connect', () => banner.getByRole('button', { name: 'Reconnect Orders' }).click());
    expect(reconnected).toEqual({ accountId: 'acct-w', remoteId: 'orders' });
    await expect(banner).toHaveCount(0);
    await expect(view(page)).toContainText('Alice Smith');
  });
});
