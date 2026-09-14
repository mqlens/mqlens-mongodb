import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, type Seed } from '../harness/seed';
import { callFrom, dismissHoverCards, expandCollections, loadSample, openCollection, openInNewTab, view } from '../helpers';

const STAGING_URI = 'mongodb://staging.example:27017';
const STAGING = { id: 'p-staging', name: 'Staging', uri: STAGING_URI };

const sidebar = (page: Page) => page.getByRole('complementary');
const strip = (page: Page) => page.getByTestId('workspace-tab-strip');

interface StoredTab {
  id: string;
  type: string;
  profileId: string;
  profileName: string;
  db: string;
  collection: string;
}

/** A saved workspace whose main window shows `tabs` in one pane, as workspace_get returns it. */
function savedWorkspace(tabs: StoredTab[], windows: Array<{ id: string; tabIds: string[] }> = []) {
  const pane = (id: string, tabIds: string[]) => ({ kind: 'pane', id, tabIds, activeTabId: tabIds[0] ?? null });
  return {
    revision: 1,
    windows: [
      { id: 'main', splitTree: pane('pane-1', tabs.map((tab) => tab.id)), focusedPaneId: 'pane-1' },
      ...windows.map((win) => ({ id: win.id, splitTree: pane('pane-1', win.tabIds), focusedPaneId: 'pane-1' })),
    ],
    tabs,
  };
}

const collectionTab = (profileId: string, profileName: string, db: string, collection: string): StoredTab => ({
  id: `profile:${profileId}.${db}.${collection}`,
  type: 'collection',
  profileId,
  profileName,
  db,
  collection,
});

/** Deliver a `workspace-changed` broadcast, as another window's change would. */
const workspaceChanged = (page: Page, payload: Record<string, unknown>) =>
  page.evaluate((event) => window.__MQLENS_E2E__!.emit('workspace-changed', event), payload);

async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await palette.getByTestId('command-palette-input').fill(title);
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
}

async function tabMenu(page: Page, label: string, item: string | RegExp): Promise<void> {
  await strip(page).getByText(label, { exact: true }).first().click({ button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: item }).click();
}

async function openStagingWith(app: App, seed: Seed = {}): Promise<void> {
  await app.open({ profiles: [STAGING], servers: { [STAGING_URI]: SAMPLE_SERVER }, ...seed });
}

test.describe('Session restore', () => {
  test('restores the last session and reconnects to its profile', async ({ app, page }) => {
    await openStagingWith(app, { workspace: savedWorkspace([collectionTab('p-staging', 'Staging', 'sales_db', 'customers')]) });

    const banner = page.getByTestId('reconnect-banner');
    await expect(banner).toContainText('sales_db.customers');
    const connected = await callFrom(app, 'connect_db', () => banner.getByRole('button', { name: 'Reconnect Staging' }).click());
    expect(connected).toMatchObject({ uri: STAGING_URI });

    await expect(banner).toHaveCount(0);
    await expect(view(page)).toContainText('Alice Smith');
  });

  test('says when the restored tab\'s profile no longer exists', async ({ app, page }) => {
    await app.open({ workspace: savedWorkspace([collectionTab('p-gone', 'Gone', 'sales_db', 'customers')]) });

    const banner = page.getByTestId('reconnect-banner');
    await banner.getByRole('button', { name: 'Reconnect Gone' }).click();
    await expect(banner).toContainText('Connection profile no longer exists');
    expect(await app.calls('connect_db')).toHaveLength(0);
  });

  test('shows why a reconnect failed', async ({ app, page }) => {
    await openStagingWith(app, { workspace: savedWorkspace([collectionTab('p-staging', 'Staging', 'sales_db', 'customers')]) });

    await app.failNext('connect_db', 'Server selection timed out');
    await page.getByTestId('reconnect-banner').getByRole('button', { name: 'Reconnect Staging' }).click();
    await expect(page.getByTestId('reconnect-error')).toContainText('Server selection timed out');
  });
});

test.describe('Other windows', () => {
  test('a tab arriving from another window opens here, and one moved away leaves', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await openInNewTab(page, 'products');
    await expect(strip(page).getByText('products', { exact: true })).toBeVisible();

    const customers = collectionTab('__sample__', 'Sample (mqlens_demo)', 'sales_db', 'customers');
    const transactions = collectionTab('__sample__', 'Sample (mqlens_demo)', 'sales_db', 'transactions');
    const products = collectionTab('__sample__', 'Sample (mqlens_demo)', 'sales_db', 'products');
    const workspace = savedWorkspace([customers, transactions], [{ id: 'win-2', tabIds: [products.id] }]);
    workspace.tabs.push(products);

    await workspaceChanged(page, { revision: 50, origin: 'win-2', crossWindow: true, workspace: { ...workspace, revision: 50 } });

    await expect(strip(page).getByText('transactions', { exact: true })).toBeVisible();
    await expect(strip(page).getByText('products', { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => (await app.calls('execute_mql_query')).some((call) => (call.args as { collection: string }).collection === 'transactions'))
      .toBe(true);
  });

  test('closing this window from another clears its tabs and returns to Quick Start', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(strip(page).getByText('customers', { exact: true })).toBeVisible();

    await workspaceChanged(page, { revision: 60, origin: 'win-2', crossWindow: true, workspace: { revision: 60, windows: [], tabs: [] } });

    await expect(strip(page).getByText('customers', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
  });

  test('moves a tab to another window, or detaches it to a new one', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await openInNewTab(page, 'products');
    await expect(strip(page).getByText('products', { exact: true })).toBeVisible();

    // A second window exists: the tab menu offers to move tabs to it.
    const workspace = savedWorkspace([], [{ id: 'win-2', tabIds: [] }]);
    await workspaceChanged(page, { revision: 70, origin: 'win-2', crossWindow: false, workspace: { ...workspace, revision: 70 } });

    await tabMenu(page, 'products', /^Move to win-2/);
    await expect
      .poll(async () => (await app.calls('workspace_apply')).map((call) => (call.args as { op: Record<string, unknown> }).op).find((op) => op.type === 'move_tab_to_window'))
      .toMatchObject({ target_window_id: 'win-2', tab_id: 'profile:__sample__.sales_db.products' });
    await expect.poll(async () => (await app.calls('focus_window')).length).toBeGreaterThan(0);

    const detached = await callFrom(app, 'workspace_detach_tab', () => tabMenu(page, 'customers', 'Detach to New Window'));
    expect(detached.tabId).toBe('profile:__sample__.sales_db.customers');
  });
});

test.describe('App-wide actions', () => {
  test('renaming a collection renames its open collection and shell tabs', async ({ app, page }) => {
    await openStagingWith(app);
    await page.getByTestId('conn-card-p-staging').click();
    await openCollection(page, 'sales_db', 'customers');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
    await dismissHoverCards(page);
    await expect(strip(page).getByText('mongosh: customers')).toBeVisible();

    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('clients');
    await callFrom(app, 'rename_collection', () => page.getByTestId('dialog-confirm').click());

    await expect(strip(page).getByText('mongosh: clients')).toBeVisible();
    await expect(strip(page).getByText('clients', { exact: true })).toBeVisible();
    await expect(strip(page).getByText('customers', { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => (await app.calls('workspace_apply')).filter((call) => (call.args as { op: { type: string } }).op.type === 'rename_tab').length)
      .toBeGreaterThanOrEqual(2);
  });

  test('installs the managed tools from Settings, and reports a failed start', async ({ app, page }) => {
    await app.open();
    await page.getByRole('button', { name: 'Open Settings' }).click();
    await page.getByTestId('settings-tab-tools').click();

    await page.getByTestId('settings-install-tools-btn').click();
    const dialog = page.getByTestId('toolsetup-dialog');
    await expect(dialog.getByTestId('toolsetup-check-mongodb-database-tools')).toBeVisible();

    await app.failNext('start_tool_install_task', 'no network');
    await dialog.getByTestId('toolsetup-install-btn').click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'no network' })).toBeVisible();

    const started = await callFrom(app, 'start_tool_install_task', () => dialog.getByTestId('toolsetup-install-btn').click());
    expect(started).toMatchObject({ tools: ['mongodb-database-tools'], force: false });
    const checksBefore = (await app.calls('managed_tools_status')).length;
    await dialog.getByTestId('toolsetup-done-btn').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await app.calls('managed_tools_status')).length).toBeGreaterThan(checksBefore);
  });

  test('command palette: next and previous tab, Quick Start, and the theme', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await openInNewTab(page, 'products');
    await expect(view(page)).toContainText('SuperBook Pro');

    await runCommand(page, 'Previous Tab');
    await expect(view(page)).toContainText('Alice Smith');
    await runCommand(page, 'Next Tab');
    await expect(view(page)).toContainText('SuperBook Pro');

    await runCommand(page, 'Open Quick Start');
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    const dark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    const before = await dark();
    await runCommand(page, 'Toggle Light/Dark Theme');
    await expect.poll(dark).toBe(!before);
  });

  test('drags the sidebar wider', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    const width = async () => (await sidebar(page).first().boundingBox())?.width ?? 0;
    const before = await width();

    const handle = page.getByTestId('sidebar-resizer');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 200, { steps: 5 });
    await page.mouse.up();

    await expect.poll(width).toBeGreaterThan(before + 60);
  });

  test('copies a collection and pastes it onto a database', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await expandCollections(page, 'sales_db');

    await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'Paste here' })).toBeVisible();
    await dismissHoverCards(page);

    await sidebar(page).getByRole('button', { name: 'Database user_analytics' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Paste here', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start copy' })).toBeVisible();
    await expect(page.locator('#target-collection')).toHaveValue('products');
  });

  test('cancels a running task, and says when the cancel fails', async ({ app, page }) => {
    await app.open();
    await page.evaluate(() => {
      const running = (id: string, label: string) => ({
        id,
        kind: 'dump',
        label,
        status: 'running',
        processed: 1,
        total: 4,
        message: 'Dumping…',
        path: '/backups/nightly',
        error: null,
        createdAtMs: Date.now(),
        finishedAtMs: null,
      });
      window.__MQLENS_E2E__!.state.tasks.unshift(running('dump-a', 'Dump sales_db → nightly'), running('dump-b', 'Dump user_analytics → nightly'));
    });
    await page.getByTestId('status-bar-tasks').click();
    const rows = page.getByTestId('tasks-view').getByTestId('task-row');
    await expect(rows).toHaveCount(2);

    const cancelled = await callFrom(app, 'cancel_task', () =>
      rows.filter({ hasText: 'sales_db' }).getByRole('button', { name: 'Cancel' }).click(),
    );
    expect(cancelled).toEqual({ id: 'dump-a' });
    // Only a running task offers Cancel.
    await expect(rows.filter({ hasText: 'sales_db' }).getByRole('button', { name: 'Cancel' })).toHaveCount(0);

    await app.failNext('cancel_task', 'task already finished');
    await rows.filter({ hasText: 'user_analytics' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'task already finished' })).toBeVisible();
  });

  test('disconnecting closes the tabs that used the connection', async ({ app, page }) => {
    await openStagingWith(app);
    await page.getByTestId('conn-card-p-staging').click();
    await openCollection(page, 'sales_db', 'customers');
    await openInNewTab(page, 'products');
    await expect(strip(page).getByText('products', { exact: true })).toBeVisible();

    await sidebar(page).getByRole('button', { name: 'Connection Staging' }).hover();
    await sidebar(page).getByRole('button', { name: 'Disconnect' }).click();
    await expect(strip(page).getByText('products', { exact: true })).toHaveCount(0);
    await expect(strip(page).getByText('customers', { exact: true })).toHaveCount(0);
  });
});
