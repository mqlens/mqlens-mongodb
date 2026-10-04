import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { callFrom, confirmTypedName, connectStaging, dismissHoverCards, expandCollections, loadSample } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary').first();
const databaseRow = (page: Page, name: string) => sidebar(page).getByRole('button', { name: `Database ${name}` });
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });

async function answer(page: Page, value: string): Promise<void> {
  await page.getByTestId('dialog-input').fill(value);
  await page.getByTestId('dialog-confirm').click();
}

async function menu(page: Page, row: Locator, item: string): Promise<void> {
  await row.click({ button: 'right' });
  if (item.startsWith('Drop ') || item === 'Delete Index') {
    await page.getByRole('menuitem', { name: 'Manage', exact: true }).press('ArrowRight');
  }
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test.describe('Sidebar confirmations and failures', () => {
  test('changes nothing when a drop or a rename is cancelled', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');

    await menu(page, sidebar(page).getByText('products', { exact: true }), 'Drop Collection');
    await page.getByTestId('dialog-cancel').click();
    await dismissHoverCards(page);

    await menu(page, databaseRow(page, 'user_analytics'), 'Drop Database');
    await page.getByTestId('dialog-cancel').click();
    await dismissHoverCards(page);

    await menu(page, databaseRow(page, 'user_analytics'), 'Rename Database');
    await answer(page, 'analytics');
    await page.getByTestId('dialog-cancel').click();

    for (const command of ['drop_collection', 'drop_database', 'rename_database']) {
      expect(await app.calls(command), command).toHaveLength(0);
    }
    await expect(sidebar(page).getByText('products', { exact: true })).toBeVisible();
    await expect(databaseRow(page, 'user_analytics')).toBeVisible();
  });

  test('reports a rename or a drop the server refused', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');

    await app.failNext('rename_collection', 'target namespace exists');
    await menu(page, sidebar(page).getByText('products', { exact: true }), 'Rename Collection');
    await answer(page, 'items');
    await expect(toast(page, 'Failed to rename collection: target namespace exists')).toBeVisible();
    await dismissHoverCards(page);

    await app.failNext('drop_database', 'database is in use');
    await menu(page, databaseRow(page, 'user_analytics'), 'Drop Database');
    await confirmTypedName(page, 'user_analytics');
    await expect(toast(page, 'Failed to drop database: database is in use')).toBeVisible();
  });

  test('asks for the name before dropping a database on a confirm-destructive connection', async ({ app, page }) => {
    await connectStaging(app, page, {}, { connection_mode: 'confirm_destructive' });
    await menu(page, databaseRow(page, 'user_analytics'), 'Drop Database');
    await page.getByTestId('dialog-input').fill('user_analytics');
    const dropped = await callFrom(app, 'drop_database', () => page.getByTestId('dialog-confirm').click());
    expect(dropped).toMatchObject({ database: 'user_analytics', confirmed: true });
    await expect(databaseRow(page, 'user_analytics')).toHaveCount(0);
  });

  test('refuses to drop a database on a read-only connection', async ({ app, page }) => {
    await connectStaging(app, page, {}, { connection_mode: 'read_only' });
    await menu(page, databaseRow(page, 'user_analytics'), 'Drop Database');
    await expect(toast(page, /read-only/)).toBeVisible();
    expect(await app.calls('drop_database')).toHaveLength(0);
  });

  test('adds a collection on the sample connection without asking the backend', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await expandCollections(page, 'user_analytics');
    await menu(page, databaseRow(page, 'user_analytics'), 'Add Collection');
    await answer(page, 'scratch');
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('scratch', { exact: true })).toBeVisible();
    expect(await app.calls('create_collection')).toHaveLength(0);
  });
});
