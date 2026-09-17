import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, connectStaging, dismissHoverCards, openCollection, STAGING_URI, view } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary').first();
const strip = (page: Page) => page.getByTestId('workspace-tab-strip');

async function connectionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId(item).click();
  await dismissHoverCards(page);
}

/**
 * Staging with a GridFS bucket in sales_db and its customers open. Returns a
 * function that opens a view twice, each time from the customers tab, and
 * checks there is still one tab for it and that its content comes forward.
 */
async function reopening(app: App, page: Page) {
  const sales = { ...SAMPLE_SERVER.databases.sales_db, 'fs.files': {}, 'fs.chunks': {} };
  await connectStaging(app, page, {
    servers: { [STAGING_URI]: { ...SAMPLE_SERVER, databases: { ...SAMPLE_SERVER.databases, sales_db: sales } } },
    gridfs: { 'sales_db.fs': [{ filename: 'invoice.pdf', content: 'PDF' }] },
  });
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

  return async (label: string, shown: string, open: () => Promise<void>) => {
    for (let i = 0; i < 2; i += 1) {
      await strip(page).getByText('customers', { exact: true }).click();
      await open();
      await expect(strip(page).getByText(label, { exact: true })).toHaveCount(1);
      await expect(view(page).getByTestId(shown)).toBeVisible();
    }
  };
}

const fromCollectionTab = (page: Page, button: string) => async () => {
  await strip(page).getByText('customers', { exact: true }).click();
  await view(page).getByTestId(button).click();
};
const collectionMenu = (page: Page, item: string) => async () => {
  await sidebar(page).getByText('customers', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await dismissHoverCards(page);
};
const databaseMenu = (page: Page, item: string) => async () => {
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await dismissHoverCards(page);
};
const sidebarRow = (page: Page, text: string) => async () => {
  await sidebar(page).getByText(text, { exact: true }).click();
  await dismissHoverCards(page);
};

test.describe('Workspace tabs', () => {
  test('opening a view that is already open brings its tab forward instead of adding another', async ({ app, page }) => {
    await connectStaging(app, page);

    for (let i = 0; i < 2; i += 1) await connectionMenu(page, 'ctx-monitor');
    await expect(page.getByTestId('monitoring-view')).toHaveCount(1);

    for (let i = 0; i < 2; i += 1) await connectionMenu(page, 'ctx-users');
    await expect(page.getByTestId('user-management-view')).toHaveCount(1);

    for (let i = 0; i < 2; i += 1) await page.getByRole('button', { name: 'Open Settings' }).click();
    await expect(page.getByTestId('settings-view')).toHaveCount(1);
    await expect(page.getByTestId('settings-view')).toBeVisible();
  });

  test('views opened from a collection, opened again, bring back their one tab', async ({ app, page }) => {
    const openTwice = await reopening(app, page);
    await openTwice('Export: customers', 'export-view', fromCollectionTab(page, 'export-btn'));
    await openTwice('Import: customers', 'import-view', fromCollectionTab(page, 'import-btn'));
    await openTwice('Watch: customers', 'watch-panel', collectionMenu(page, 'Watch changes…'));
    // The collection menu's shell comes with a find to run; a second open hands it to the open tab.
    await openTwice('mongosh: customers', 'mongo-shell', collectionMenu(page, 'Open mongosh Shell'));
    await openTwice('Schema: customers', 'schema-view', collectionMenu(page, 'Analyze Schema'));
    await openTwice('Validation: customers', 'validation-rules-view', collectionMenu(page, 'Validation Rules'));
    await openTwice('Generate: customers', 'generate-view', collectionMenu(page, 'Generate Data…'));
  });

  test('views opened from a database, the connection and the status bar, opened again, bring back their one tab', async ({ app, page }) => {
    const openTwice = await reopening(app, page);
    await openTwice('Dump: sales_db', 'dump-view', databaseMenu(page, 'Dump (mongodump)…'));
    await openTwice('New View: sales_db', 'create-view', databaseMenu(page, 'Create View'));
    // Scoped to a database, the Users tab takes that database each time it's opened.
    await openTwice('Users: Staging', 'user-management-view', databaseMenu(page, 'Manage Users'));
    await openTwice('Restore: Staging', 'restore-view', () => connectionMenu(page, 'ctx-restore-conn-1'));
    await openTwice('Activity', 'activity-panel', () => page.getByTestId('status-bar-activity').click());
  });

  test('an index and a GridFS bucket, opened again, bring back their one tab', async ({ app, page }) => {
    const openTwice = await reopening(app, page);
    await sidebar(page).getByText('indexes', { exact: true }).first().click();
    await dismissHoverCards(page);
    await openTwice('customers.email_1', 'index-viewer', sidebarRow(page, 'email_1'));

    await sidebar(page).getByText('GridFS Buckets', { exact: true }).click();
    await dismissHoverCards(page);
    await openTwice('GridFS: fs', 'gridfs-view', sidebarRow(page, 'fs'));
  });
});

test.describe('Renames with tabs open', () => {
  test('a renamed collection takes its export, watch and index tabs with it', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    await view(page).getByTestId('export-btn').click();
    await expect(page.getByTestId('export-view')).toBeVisible();

    await sidebar(page).getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByTestId('ctx-watch-collection').click();
    await dismissHoverCards(page);
    await expect(page.getByTestId('watch-status')).toHaveText('live');

    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('email_1', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page).getByTestId('index-viewer')).toBeVisible();

    await sidebar(page).getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('clients');
    await callFrom(app, 'rename_collection', () => page.getByTestId('dialog-confirm').click());

    await expect(strip(page).getByText(/clients/).first()).toBeVisible();
    await expect(strip(page).getByText(/customers/)).toHaveCount(0);
  });

  test('a renamed database takes its collection and export tabs with it', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'user_analytics', 'events');
    await view(page).getByTestId('export-btn').click();
    await expect(page.getByTestId('export-view')).toBeVisible();

    await sidebar(page).getByRole('button', { name: 'Database user_analytics' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Database', exact: true }).click();
    await page.getByTestId('dialog-input').fill('analytics');
    await page.getByTestId('dialog-confirm').click();
    await callFrom(app, 'rename_database', () => page.getByTestId('dialog-confirm').click());

    await expect(sidebar(page).getByRole('button', { name: 'Database analytics' })).toBeVisible();
    await expect(strip(page).getByText(/events/).first()).toBeVisible();
    await expect(strip(page).getByText(/user_analytics/)).toHaveCount(0);
  });
});

test.describe('Zoom', () => {
  test('zooms in, out and back with the keyboard, and saves the level', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    const saved = async () => JSON.stringify((await app.calls('patch_app_settings')).map((call) => call.args));

    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    await expect.poll(saved).toContain('zoom');

    const patches = (await app.calls('patch_app_settings')).length;
    await page.keyboard.press('Control+-');
    await page.keyboard.press('Control+0');
    await expect.poll(async () => (await app.calls('patch_app_settings')).length).toBeGreaterThan(patches);
  });
});
