import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, expandCollections } from '../helpers';

// Corners of the app that are one control each (#396): a toast dismissed by
// hand, a shortcut list narrowed to one group, and Quick Start with no saved
// connections to offer.

const sidebar = (page: Page) => page.getByRole('complementary');
const settings = (page: Page) => page.getByTestId('settings-view');

test.describe('A toast', () => {
  test('goes when it is dismissed, without waiting out its timer', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');

    // A failed drop is reported as a toast.
    await app.failNext('drop_collection', 'not authorized on sales_db to drop products');
    await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Drop Collection' }).click();
    await page.getByTestId('dialog-confirm').click();

    const toast = page.getByTestId('dialog-toast').filter({ hasText: 'not authorized on sales_db' });
    await expect(toast).toBeVisible();
    await toast.getByTestId('dialog-toast-close').click();
    await expect(toast).toHaveCount(0);
  });
});

test.describe('The keyboard shortcut list', () => {
  test('keeps only the groups something matches', async ({ app, page }) => {
    await app.open();
    await page.getByRole('button', { name: 'Open Settings' }).click();
    await settings(page).getByTestId('settings-tab-shortcuts').click();
    await expect(settings(page).getByTestId('shortcuts-group-zoom')).toBeVisible();
    await expect(settings(page).getByTestId('shortcuts-group-sidebar')).toBeVisible();

    await settings(page).getByTestId('shortcuts-filter').fill('zoom');
    await expect(settings(page).getByTestId('shortcuts-group-zoom')).toBeVisible();
    // A group with nothing left in it is not an empty heading.
    await expect(settings(page).getByTestId('shortcuts-group-sidebar')).toHaveCount(0);
    await expect(settings(page).getByTestId('shortcuts-empty')).toHaveCount(0);
  });
});

test.describe('Quick Start', () => {
  test('shows no saved connection rather than a stale one it could not re-read', async ({ app, page }) => {
    await app.open({ profiles: [{ id: 'p-staging', name: 'Staging', uri: 'mongodb://staging.example:27017' }] });
    await expect(page.getByTestId('conn-card-p-staging')).toBeVisible();

    // Closing the connection manager is what asks for the list again.
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'New...', exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        load_connection_profiles: () => {
          throw 'the vault could not be read';
        },
      });
    });
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('conn-card-p-staging')).toHaveCount(0);
    // The rest of Quick Start is still there to work with.
    await expect(page.getByTestId('qs-load-sample')).toBeVisible();
  });
});
