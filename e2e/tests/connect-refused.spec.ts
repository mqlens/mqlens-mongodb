import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { STAGING_URI } from '../helpers';

// A connection a saved profile can no longer make (#396): from the manager's
// own details pane, and from a pinned collection that has to reconnect first.

const STAGING = { id: 'p-staging', name: 'Staging', uri: STAGING_URI };
const sidebar = (page: Page) => page.getByRole('complementary').first();

test.describe('When a saved profile will not connect', () => {
  test('the manager says why, where it was asked', async ({ app, page }) => {
    await app.open({ profiles: [STAGING], servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'New...', exact: true })).toBeVisible();

    await app.failNext('connect_db', 'server selection timeout');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(page.getByText('server selection timeout')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connection Staging' })).toHaveCount(0);
  });

  test('a pin that has to reconnect first says it could not', async ({ app, page }) => {
    await app.open({ profiles: [STAGING], servers: { [STAGING_URI]: SAMPLE_SERVER } });
    // Written after the app is up, then reloaded, so the pin is there from the
    // sidebar's first render without stacking an init script per test.
    await page.evaluate(() => {
      localStorage.setItem(
        'mqlens_pinned_collections',
        JSON.stringify([
          { kind: 'collection', connectionName: 'Staging', db: 'sales_db', collection: 'customers' },
        ]),
      );
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sidebar(page).getByRole('button', { name: 'Pinned', exact: true }).click();

    await app.failNext('connect_db', 'server selection timeout');
    await sidebar(page).getByTestId('pinned-item-coll::Staging::sales_db::customers').click();

    // Twice over: the connection itself reports why, and the sidebar says the
    // pin it was following could not be opened.
    const toasts = page.getByTestId('dialog-toast');
    await expect(toasts.filter({ hasText: 'server selection timeout' })).toBeVisible();
    await expect(toasts.filter({ hasText: /^ErrorCould not connect to Staging$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connection Staging' })).toHaveCount(0);
  });
});
