import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';

// What the Updates tab remembers between runs (#396): the last check is kept
// locally, so the tab says what happened even before it asks again.

const settings = (page: Page) => page.getByTestId('settings-view');

/**
 * Start the app with `snapshot` as the last update check it remembers.
 *
 * Written once per case and then reloaded into, rather than seeded with an
 * init script each time: those accumulate, and every earlier one runs again on
 * the next navigation in no guaranteed order — so a later case could read an
 * earlier case's snapshot.
 */
async function openUpdatesWith(app: App, page: Page, snapshot: string): Promise<void> {
  if (!app.isOpen) await app.open();
  await page.evaluate((value) => localStorage.setItem('mqlens.update-check.snapshot', value), snapshot);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await settings(page).getByTestId('settings-tab-updates').click();
}

const snapshot = (result: string) => JSON.stringify({ checkedAt: '2026-05-24T22:00:00.000Z', result });

test.describe('The last update check', () => {
  test('is remembered, whatever it was', async ({ app, page }) => {
    await openUpdatesWith(app, page, snapshot('available'));
    await expect(settings(page).getByTestId('update-last-checked')).toContainText('Update available');

    await openUpdatesWith(app, page, snapshot('offline'));
    await expect(settings(page).getByTestId('update-last-checked')).toContainText('Offline');

    await openUpdatesWith(app, page, snapshot('check-failed'));
    await expect(settings(page).getByTestId('update-last-checked')).toContainText('Server error');

    await openUpdatesWith(app, page, snapshot('uptodate'));
    await expect(settings(page).getByTestId('update-last-checked')).toContainText('Up to date');
    // The time it was checked at reads as a time, not as the text it was stored as.
    await expect(settings(page).getByTestId('update-last-checked')).not.toContainText('2026-05-24T22:00:00.000Z');
  });

  test('is ignored when it cannot be read, or says nothing', async ({ app, page }) => {
    await openUpdatesWith(app, page, '{ not json');
    await expect(settings(page).getByTestId('update-last-checked')).not.toContainText('Update available');

    await openUpdatesWith(app, page, JSON.stringify({ result: 'available' }));
    await expect(settings(page).getByTestId('update-last-checked')).not.toContainText('Update available');
  });
});
