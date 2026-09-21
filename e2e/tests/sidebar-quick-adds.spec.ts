import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, STAGING_URI } from '../helpers';

// The plus buttons a database's folders carry (#396), and what the bucket name
// they ask for is allowed to be.

const sidebar = (page: Page) => page.getByRole('complementary');
const folder = (page: Page, label: string) => sidebar(page).getByText(label, { exact: true }).first();

const SHOP = {
  databases: {
    shop: {
      orders: { docs: [{ _id: 1, total: 10 }] },
      'fs.files': { docs: [] },
      'fs.chunks': { docs: [] },
    },
  },
};

async function openShop(app: App, page: Page): Promise<void> {
  await connectStaging(app, page, { servers: { [STAGING_URI]: SHOP } });
  await sidebar(page).getByText('shop', { exact: true }).click();
  await dismissHoverCards(page);
}

test.describe('Adding from the tree', () => {
  test('a collection straight from the folder that holds them', async ({ app, page }) => {
    await openShop(app, page);

    await sidebar(page).getByTestId('collections-new-conn-1-shop').click();
    await page.getByTestId('dialog-input').fill('refunds');
    await page.getByTestId('dialog-confirm').click();

    await expect.poll(async () => (await app.calls('create_collection')).map((call) => call.args)).toEqual([
      { id: 'conn-1', database: 'shop', collection: 'refunds' },
    ]);
    await folder(page, 'Collections').click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('refunds', { exact: true })).toBeVisible();
  });

  test('a bucket, once it is named something GridFS would accept', async ({ app, page }) => {
    await openShop(app, page);
    await folder(page, 'GridFS Buckets').click();
    await dismissHoverCards(page);

    await sidebar(page).getByTestId('gridfs-new-bucket-conn-1-shop').click();
    const input = page.getByTestId('dialog-input');
    const error = page.getByTestId('dialog-error');

    // A bucket prefixes its two collections, so a name with a dot in it would
    // make them something else entirely, and `system` is the server's own.
    await input.fill('  ');
    await page.getByTestId('dialog-confirm').click();
    await expect(error).toBeVisible();

    await input.fill('my.bucket');
    await page.getByTestId('dialog-confirm').click();
    await expect(error).toContainText(/\./);

    await input.fill('system_files');
    await page.getByTestId('dialog-confirm').click();
    await expect(error).toContainText(/system/i);

    await input.fill('attachments');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('gridfs-view')).toBeVisible();
  });

  test('a database whose first collection the server refuses', async ({ app, page }) => {
    await openShop(app, page);
    await sidebar(page).getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add Database', exact: true }).click();
    await page.getByTestId('dialog-input').fill('inventory');
    await page.getByTestId('dialog-confirm').click();

    await app.failNext('create_collection', 'not authorized to create a collection');
    await page.getByTestId('dialog-confirm').click();

    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'not authorized' })).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: 'Database inventory' })).toHaveCount(0);
  });
});
