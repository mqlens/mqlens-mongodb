import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, STAGING_URI, view } from '../helpers';

// The rest of a database's tree (#396): the views, the GridFS buckets and the
// system collections each have their own folder, their own count and their own
// way in.

const sidebar = (page: Page) => page.getByRole('complementary');
const folder = (page: Page, label: string) => sidebar(page).getByText(label, { exact: true }).first();

/** A database with a view, a bucket and a system collection beside its data. */
const SHOP = {
  databases: {
    shop: {
      orders: { docs: [{ _id: 1, total: 10 }] },
      recent_orders: { type: 'view' as const, docs: [{ _id: 1, total: 10 }] },
      'fs.files': { docs: [] },
      'fs.chunks': { docs: [] },
      'system.profile': { docs: [] },
    },
  },
};

async function openShop(app: App, page: Page): Promise<void> {
  await connectStaging(app, page, { servers: { [STAGING_URI]: SHOP } });
  await sidebar(page).getByText('shop', { exact: true }).click();
  await dismissHoverCards(page);
}

test.describe('A database tree', () => {
  test('keeps views, buckets and system collections in folders of their own', async ({ app, page }) => {
    await openShop(app, page);

    // Each folder counts what it holds, and the data collections are not in them.
    await expect(sidebar(page).getByTestId('views-count')).toHaveText('(1)');
    await expect(sidebar(page).getByTestId('gridfs-count')).toHaveText('(1)');
    await expect(sidebar(page).getByTestId('system-count')).toHaveText('(1)');

    await folder(page, 'Views').click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('recent_orders', { exact: true })).toBeVisible();

    await folder(page, 'System').click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('system.profile', { exact: true })).toBeVisible();
  });

  test('opens a bucket from its own row', async ({ app, page }) => {
    await connectStaging(app, page, {
      servers: { [STAGING_URI]: SHOP },
      gridfs: { 'shop.fs': [{ filename: 'invoice-001.pdf', content: 'PDF-1.7' }] },
    });
    await sidebar(page).getByText('shop', { exact: true }).click();
    await dismissHoverCards(page);

    await folder(page, 'GridFS Buckets').click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('fs', { exact: true }).click();
    await dismissHoverCards(page);

    await expect(view(page).getByTestId('gridfs-view')).toBeVisible();
    await expect(view(page)).toContainText('invoice-001.pdf');
  });

  test('offers a new view and a new bucket from the folders themselves', async ({ app, page }) => {
    await openShop(app, page);

    // The Views folder's own menu opens the Create View form.
    await folder(page, 'Views').click({ button: 'right' });
    await page.getByTestId('ctx-views-create-conn-1-shop').click();
    await dismissHoverCards(page);
    await expect(view(page).getByTestId('create-view')).toBeVisible();

    // And the GridFS folder's asks for a bucket name.
    await folder(page, 'GridFS Buckets').click({ button: 'right' });
    await page.getByTestId('ctx-gridfs-new-bucket-conn-1-shop').click();
    await expect(page.getByTestId('dialog-input')).toBeVisible();
    await page.getByTestId('dialog-cancel').click();
  });
});
