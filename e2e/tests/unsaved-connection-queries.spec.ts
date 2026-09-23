import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, openCollection, setEditorText, STAGING_URI, view } from '../helpers';

// A connection made but never saved (#396). Its queries can still be saved —
// they are kept under the connection's own name — but a favourite outlives the
// session, and there would be nothing left to point it at.

const button = (page: Page, name: string) => view(page).getByRole('button', { name, exact: true });

/** Connect without saving the profile, and open a collection on it. */
async function openUnsaved(app: App, page: Page): Promise<void> {
  await app.open({ servers: { [STAGING_URI]: SAMPLE_SERVER } });
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await page.getByRole('button', { name: 'New...', exact: true }).click();
  await page.getByLabel('Display Name').fill('Staging');
  await page.getByTestId('host-list').fill('staging.example:27017');
  await page.getByTestId('editor-connect-btn').click();
  await expect(page.getByTestId('connect-save-offer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Connection Staging' })).toBeVisible();

  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
}

test.describe('Queries on a connection that was never saved', () => {
  test('are saved, but cannot be made favourites', async ({ app, page }) => {
    await openUnsaved(app, page);
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');

    // Naming nothing saves nothing.
    await button(page, 'Save query').click();
    await page.getByTestId('save-favorite-query-item').click();
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('save_query')).toEqual([]);

    // Saved and favourited: the saving half works, the favourite does not.
    await button(page, 'Save query').click();
    await page.getByTestId('save-favorite-query-item').click();
    await page.getByTestId('dialog-input').fill('Premium customers');
    await callFrom(app, 'save_query', () => page.getByTestId('dialog-confirm').click());
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'saved connection' })).toBeVisible();

    // And the heart beside the saved query says the same.
    await button(page, 'Load query').click();
    await page.getByTestId(/^favorite-saved-/).first().click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'saved connection' })).toHaveCount(2);
    expect(await page.evaluate(() => localStorage.getItem('mqlens_favorites'))).toBeFalsy();
  });
});
