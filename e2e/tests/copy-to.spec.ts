import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections } from '../helpers';

// Copying a collection or a database somewhere else (#396): the target it is
// given, the options it carries, and the checks it runs before it starts.

const ARCHIVE_URI = 'mongodb://archive.example:27017';

const sidebar = (page: Page) => page.getByRole('complementary');
const dialog = (page: Page) => page.getByRole('dialog');
const startButton = (page: Page) => dialog(page).getByRole('button', { name: 'Start copy' });

async function copyDatabase(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy database to…' }).click();
  await dismissHoverCards(page);
}

async function copyProducts(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await expandCollections(page, 'sales_db');
  await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy to…' }).click();
  await dismissHoverCards(page);
}

/** Pick "New database" and name it `name`. */
async function newDatabase(page: Page, name: string): Promise<void> {
  await dialog(page).locator('#target-database').click();
  await page.getByRole('option', { name: /New database/ }).click();
  await dialog(page).locator('#target-database').fill(name);
}

test.describe('Copying a database', () => {
  test('carries the options it was given, and needs a name to copy into', async ({ app, page }) => {
    await copyDatabase(app, page);
    await newDatabase(page, 'sales_archive');
    await expect(dialog(page)).toContainText('will be created');

    // Neither the indexes nor the views this time.
    await dialog(page).locator('#include-indexes').uncheck();
    await dialog(page).locator('#include-views').uncheck();

    // A name of nothing is no target at all.
    await dialog(page).locator('#target-database').fill('   ');
    await expect(startButton(page)).toBeDisabled();
    await dialog(page).locator('#target-database').fill('sales_archive');

    await startButton(page).click();
    await expect.poll(async () => (await app.calls('start_database_copy')).length).toBe(1);
    expect((await app.calls('start_database_copy'))[0].args).toMatchObject({
      targetDb: 'sales_archive',
      includeIndexes: false,
      includeViews: false,
      collections: null,
    });
  });

  test('copies nothing when it is closed', async ({ app, page }) => {
    await copyDatabase(app, page);
    await newDatabase(page, 'sales_archive');

    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await app.calls('start_database_copy')).toHaveLength(0);
  });

  test('opens even when the source collections cannot be listed', async ({ app, page }) => {
    await connectStaging(app, page);
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await app.failNext('list_collections', 'not authorized on sales_db to list collections');
    await page.getByRole('menuitem', { name: 'Copy database to…' }).click();
    await dismissHoverCards(page);

    await newDatabase(page, 'sales_archive');
    await startButton(page).click();
    await expect.poll(async () => (await app.calls('start_database_copy')).length).toBe(1);
  });
});

test.describe('Copying a collection', () => {
  test('another connection is a target of its own', async ({ app, page }) => {
    await connectStaging(app, page, {
      profiles: [{ id: 'p-archive', name: 'Archive', uri: ARCHIVE_URI }],
      servers: {
        [ARCHIVE_URI]: {
          version: '7.0.5',
          databases: { sales_db: { orders: { docs: [] } }, archive_db: { old_products: { docs: [] } } },
        },
      },
    });
    await connectArchive(page);
    await copyProductsFromStaging(page);

    // The target starts on the connection the collection came from.
    await expect(dialog(page).locator('#target-connection')).toContainText('Staging');
    await dialog(page).locator('#target-connection').click();
    await page.getByRole('option', { name: 'Archive', exact: true }).click();
    // The database goes back to the source's own name on the new connection.
    await expect(dialog(page).locator('#target-database')).toContainText('sales_db');

    await dialog(page).locator('#target-database').click();
    await page.getByRole('option', { name: 'archive_db', exact: true }).click();
    await dialog(page).locator('#target-collection').fill('products_copy');
    await dialog(page).locator('#filter-input').fill('{"category": "Electronics"}');
    await startButton(page).click();

    expect((await app.calls('start_collection_copy'))[0].args).toMatchObject({
      targetDb: 'archive_db',
      targetCollection: 'products_copy',
      filter: '{"category": "Electronics"}',
    });
  });

  test('a target that already exists can be left alone', async ({ app, page }) => {
    await copyProducts(app, page);
    await dialog(page).locator('#target-collection').fill('customers');

    // The preflight found the collection, so it asks what to do about it.
    await expect(dialog(page)).toContainText('Conflict resolution');
    await page.locator('input[name="conflictMode"][value="skip"]').check();
    await dialog(page).locator('#include-indexes').uncheck();
    await startButton(page).click();

    expect((await app.calls('start_collection_copy'))[0].args).toMatchObject({
      targetCollection: 'customers',
      conflictMode: 'skip',
      includeIndexes: false,
    });
  });

  test('starts even when it could not be checked beforehand', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
    await app.failNext('preflight_copy', 'not authorized to check the target');
    await page.getByRole('menuitem', { name: 'Copy to…' }).click();
    await dismissHoverCards(page);

    await dialog(page).locator('#target-collection').fill('products_archive');
    await expect(startButton(page)).toBeEnabled();
    await startButton(page).click();
    await expect.poll(async () => (await app.calls('start_collection_copy')).length).toBe(1);
  });
});

/** Connect the saved Archive profile from the connection manager. */
async function connectArchive(page: Page): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'Manage Connections' }).click();
  await dialog(page).getByText('Archive', { exact: true }).first().click();
  await dialog(page).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Connection Archive' })).toBeVisible();
}

/** Copy sales_db.products of the Staging connection, with two connections open. */
async function copyProductsFromStaging(page: Page): Promise<void> {
  // Both connections have a sales_db, so this walks the Staging one's own subtree.
  const tree = sidebar(page)
    .getByRole('button', { name: 'Connection Staging' })
    .locator('xpath=following-sibling::*[1]');
  await tree.getByRole('button', { name: 'Database sales_db' }).click();
  await dismissHoverCards(page);
  await tree.getByText('Collections', { exact: true }).click();
  await dismissHoverCards(page);
  await tree.getByText('products', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy to…' }).click();
  await dismissHoverCards(page);
}
