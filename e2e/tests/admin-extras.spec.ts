import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_MONITORING } from '../harness/seed';
import { connectStaging, dismissHoverCards } from '../helpers';

const monitor = (page: Page) => page.getByTestId('monitoring-view');
const settings = (page: Page) => page.getByTestId('settings-view');
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });

async function choose(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

async function connectionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId(item).click();
  await dismissHoverCards(page);
}

async function openSettings(page: Page, section: string): Promise<void> {
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await expect(settings(page)).toBeVisible();
  await settings(page).getByTestId(`settings-tab-${section}`).click();
}

test.describe('Monitoring details', () => {
  test('shortens a long command, samples twice, and opens operation and profile details', async ({ app, page }) => {
    const [first, second] = SAMPLE_MONITORING.currentOps;
    const longCommand = JSON.stringify({ find: 'customers', filter: { note: 'x'.repeat(150) } });
    const { cache: _cache, ...withoutCache } = SAMPLE_MONITORING.serverStatus as Record<string, unknown>;
    await connectStaging(app, page, { monitoring: { serverStatus: withoutCache, currentOps: [{ ...first, command: longCommand }, second] } });
    await connectionMenu(page, 'ctx-monitor');
    const view = monitor(page);

    await expect(view.getByTestId('op-row-101')).toContainText('…');
    const sampled = (await app.calls('server_status')).length;
    await view.getByTestId('monitoring-refresh-now').click();
    await expect.poll(async () => (await app.calls('server_status')).length).toBeGreaterThan(sampled);

    await view.getByTestId('op-row-102').click();
    await expect(page.getByTestId('monitoring-detail')).toContainText('conn13');
    await page.keyboard.press('Escape');

    await view.getByTestId('mon-tab-profiler').click();
    await view.getByTestId('profile-row-1').click();
    await expect(page.getByTestId('monitoring-detail')).toContainText('sales_db.products');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('monitoring-detail')).toHaveCount(0);
  });

  test('reports a failed kill, cluster status, profile and profiling level', async ({ app, page }) => {
    await connectStaging(app, page);
    await connectionMenu(page, 'ctx-monitor');
    const view = monitor(page);
    await expect(view.getByTestId('op-row-101')).toBeVisible();

    await app.failNext('kill_op', 'operation 101 already finished');
    await view.getByTestId('kill-op-101').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('operation 101 already finished').first()).toBeVisible();

    await app.failNext('repl_set_status', 'not running with --replSet');
    await view.getByTestId('mon-tab-cluster').click();
    await expect(view.getByText('not running with --replSet').first()).toBeVisible();

    // The profiler has already read sales_db's profile; picking another database reads again.
    await view.getByTestId('mon-tab-profiler').click();
    await expect(view.getByTestId('profiler-db-select')).toContainText('sales_db');
    // Not an authorization error: those show which role is needed instead of the message.
    await app.failNext('read_profile', 'system.profile is being rebuilt');
    await view.getByTestId('profiler-db-select').click();
    await page.getByRole('option', { name: 'user_analytics' }).click();
    await expect(view.getByText('system.profile is being rebuilt').first()).toBeVisible();

    await app.failNext('set_profiling_level', 'profiling is not allowed on this server');
    await view.getByTestId('profiler-level-1').click();
    await expect(page.getByText('profiling is not allowed on this server').first()).toBeVisible();
  });
});

test.describe('User management checks', () => {
  test('checks a new user before sending it, and reports users it could not create or drop', async ({ app, page }) => {
    await connectStaging(app, page);
    await connectionMenu(page, 'ctx-users');
    const users = page.getByTestId('user-management-view');
    await users.getByTestId('create-user-btn').click();
    const editor = page.getByTestId('user-editor-modal');

    await editor.getByTestId('user-name-input').fill('   ');
    await editor.getByTestId('user-password-input').fill('s3cret-pass');
    await editor.getByTestId('save-user-btn').click();
    await expect(editor.getByTestId('user-editor-error')).toContainText('Username is required');

    await editor.getByTestId('user-name-input').fill('reporter');
    await editor.getByTestId('add-role-btn').click();
    await editor.getByTestId('save-user-btn').click();
    await expect(editor.getByTestId('user-editor-error')).toContainText('Select a role and a database');

    await choose(page, editor.getByTestId('role-select-0'), /^read$/);
    await app.failNext('create_user', 'not authorized on admin to execute command { createUser: "reporter" }');
    await editor.getByTestId('save-user-btn').click();
    await expect(editor.getByTestId('user-editor-error')).toContainText('not authorized on admin');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);

    await users.getByTestId('user-row-sales_db.analyst').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Drop User' }).click();
    await app.failNext('drop_user', 'user analyst is in use');
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'Failed to drop user: user analyst is in use')).toBeVisible();
  });

  test('says when the users cannot be listed', async ({ app, page }) => {
    await connectStaging(app, page);
    await app.failNext('list_users', 'not authorized on admin to execute command { usersInfo: 1 }');
    await connectionMenu(page, 'ctx-users');
    await expect(page.getByTestId('user-management-view')).toContainText('Not authorized to list users');
  });
});

test.describe('Settings failures', () => {
  test('MCP: reports a status it could not get, and no connections to share', async ({ app, page }) => {
    await app.open({ mcp: { enabled: true } });
    await app.failNext('mcp_get_status', 'port 8765 is already in use');
    await app.failNext('load_connection_profiles', 'vault is locked');
    await openSettings(page, 'mcp');
    await expect(settings(page).getByTestId('mcp-error')).toContainText('port 8765 is already in use');
    await expect(settings(page).getByTestId('mcp-profiles-empty')).toBeVisible();
  });

  test('MCP: reports a token or a switch it could not change', async ({ app, page }) => {
    await app.open({ mcp: { enabled: true } });
    await openSettings(page, 'mcp');
    const view = settings(page);
    await expect(view.getByTestId('mcp-token-regenerate')).toBeVisible();

    await app.failNext('mcp_regenerate_token', 'keychain unavailable');
    await view.getByTestId('mcp-token-regenerate').click();
    await expect(view.getByTestId('mcp-error')).toContainText('keychain unavailable');

    await app.failNext('mcp_set_enabled', 'could not stop the server');
    await view.getByTestId('mcp-enable-toggle').click();
    await expect(view.getByTestId('mcp-error')).toContainText('could not stop the server');
  });

  test('Security: reports a biometric unlock it could not turn on', async ({ app, page }) => {
    await app.open({ biometric: { available: true, enrolled: false, biometryType: 1 } });
    await openSettings(page, 'security');
    await app.failNext('biometric_enable', 'the user cancelled Touch ID');
    await settings(page).getByTestId('sec-biometric-toggle').click();
    await expect(settings(page).getByTestId('sec-msg')).toContainText('the user cancelled Touch ID');
  });

  test('reports settings it could not load or save', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    await app.failNext('load_app_settings', 'settings file is corrupt');
    await openSettings(page, 'updates');
    await expect(settings(page)).toContainText('settings file is corrupt');

    await settings(page).getByTestId('update-channel-dev').click();
    await app.failNext('patch_app_settings', 'disk is full');
    await settings(page).getByTestId('settings-save-btn').click();
    await expect(settings(page)).toContainText('disk is full');
  });
});
