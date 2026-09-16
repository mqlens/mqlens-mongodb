import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { ProfileSeed } from '../harness/seed';
import { connectStaging, dismissHoverCards, expandCollections, openCollection, view } from '../helpers';

// Pinned items, favourites and the sidebar's own listings (#396). Pins and
// favourites live in localStorage and are shared with the app's other windows,
// which reach this one as `storage` events.

const sidebar = (page: Page) => page.getByRole('complementary').first();
const connectionRow = (page: Page) => sidebar(page).getByRole('button', { name: 'Connection Staging' });
const databaseRow = (page: Page, name: string) => sidebar(page).getByRole('button', { name: `Database ${name}` });
const hoverCard = (page: Page) => page.locator('[data-radix-popper-content-wrapper]');

async function rowMenu(page: Page, row: ReturnType<Page['getByRole']>, item: string | RegExp): Promise<void> {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).first().click();
  await dismissHoverCards(page);
}

async function connect(app: App, page: Page, profile: Partial<ProfileSeed> = {}): Promise<void> {
  await connectStaging(app, page, {}, profile);
  await expect(connectionRow(page)).toBeVisible();
}

test.describe('Pins and favourites', () => {
  test('pins a connection, a database and a collection, and opens one again from the list', async ({ app, page }) => {
    await connect(app, page);
    await expandCollections(page, 'sales_db');

    await rowMenu(page, connectionRow(page), 'Pin to sidebar');
    await rowMenu(page, databaseRow(page, 'sales_db'), 'Pin to sidebar');
    await rowMenu(page, sidebar(page).getByText('customers', { exact: true }), 'Pin to sidebar');

    // Pinning opens the Pinned section itself, so the first pin shows the list.
    await expect(sidebar(page).getByTestId('pinned-item-conn::Staging')).toBeVisible();
    await expect(sidebar(page).getByTestId('pinned-item-db::Staging::sales_db')).toBeVisible();
    const pinnedCollection = sidebar(page).getByTestId('pinned-item-coll::Staging::sales_db::customers');
    await expect(pinnedCollection).toBeVisible();

    await pinnedCollection.click();
    await dismissHoverCards(page);
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    // Another window's change arrives as a storage event, and the list follows it.
    await page.evaluate(() => {
      localStorage.setItem('mqlens_pinned_collections', JSON.stringify([{ kind: 'connection', connectionName: 'Staging' }]));
      window.dispatchEvent(new StorageEvent('storage', { key: 'mqlens_pinned_collections' }));
    });
    await expect(sidebar(page).getByTestId('pinned-item-conn::Staging')).toBeVisible();
    await expect(sidebar(page).getByTestId('pinned-item-db::Staging::sales_db')).toHaveCount(0);

    await rowMenu(page, sidebar(page).getByTestId('pinned-item-conn::Staging'), /Unpin/);
    await expect(sidebar(page).getByTestId('pinned-item-conn::Staging')).toHaveCount(0);
  });

  test('favourites a connection and a database, and follows another window', async ({ app, page }) => {
    await connect(app, page);

    await rowMenu(page, connectionRow(page), /favorites/i);
    await rowMenu(page, databaseRow(page, 'sales_db'), /favorites/i);

    // Favouriting opens the Favorites section itself; a connection is labelled as one.
    await expect(sidebar(page).getByText('connection', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('sales_db', { exact: true }).first()).toBeVisible();

    await page.evaluate(() => {
      localStorage.setItem('mqlens_favorites', JSON.stringify([{ kind: 'database', connectionName: 'Staging', db: 'user_analytics' }]));
      window.dispatchEvent(new StorageEvent('storage', { key: 'mqlens_favorites' }));
    });
    await expect(sidebar(page).getByText('connection', { exact: true })).toHaveCount(0);
    await expect(sidebar(page).getByText('user_analytics', { exact: true }).first()).toBeVisible();
  });

  test('a pin saved while nothing can be written says so', async ({ app, page }) => {
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'mqlens_pinned_collections') throw new Error('storage is full');
        return setItem.call(this, key, value);
      };
    });
    await connect(app, page);

    await rowMenu(page, connectionRow(page), 'Pin to sidebar');
    await expect(page.getByTestId('dialog-toast').filter({ hasText: /Could not update pinned/i })).toBeVisible();
  });
});

test.describe('Listing failures', () => {
  test('keeps going when indexes, collections or databases cannot be listed', async ({ app, page }) => {
    await connect(app, page);
    // The collection's own row has to be open before it lists its indexes.
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    // Indexes: the group opens empty rather than breaking the tree.
    await app.failNext('list_indexes', 'not authorized on sales_db to execute listIndexes');
    await sidebar(page).getByText('indexes', { exact: true }).first().click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('customers', { exact: true })).toBeVisible();

    // Collections: the database says so, and the group loads them when asked again.
    await app.failNext('list_collections', 'not authorized on sales_db to execute listCollections');
    await databaseRow(page, 'sales_db').click();
    await dismissHoverCards(page);
    await databaseRow(page, 'sales_db').click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('Collections', { exact: true }).first()).toBeVisible();

    // Databases: refreshing the connection.
    await app.failNext('list_databases', 'not authorized to execute listDatabases');
    await connectionRow(page).getByRole('button', { name: 'Refresh databases' }).click();
    await dismissHoverCards(page);
    await expect(connectionRow(page)).toBeVisible();
  });

  test('the stats card follows the row the pointer is on', async ({ app, page }) => {
    await connect(app, page);

    await connectionRow(page).hover();
    await expect(hoverCard(page)).toBeVisible();
    await databaseRow(page, 'sales_db').hover();
    await expect(hoverCard(page).first()).toContainText('sales_db');
  });
});
