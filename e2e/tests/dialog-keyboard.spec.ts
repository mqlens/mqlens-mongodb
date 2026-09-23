import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections } from '../helpers';

// The app's own prompt dialogs from the keyboard (#396): Enter to answer,
// Escape to call it off, and the longer form that takes several lines.

const sidebar = (page: Page) => page.getByRole('complementary');

test.describe('Answering a prompt', () => {
  test('Enter sends the answer, and Escape leaves it unanswered', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');

    // Escape first: nothing is renamed.
    await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('products_2024');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-input')).toHaveCount(0);
    expect(await app.calls('rename_collection')).toHaveLength(0);

    await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('products_2024');
    await page.getByTestId('dialog-input').press('Enter');

    await expect.poll(async () => (await app.calls('rename_collection')).length).toBe(1);
    expect((await app.calls('rename_collection'))[0].args).toMatchObject({ from: 'products', to: 'products_2024' });
    await dismissHoverCards(page);
  });

  test('a prompt that takes several lines is checked, and Ctrl+Enter sends it', async ({ app, page }) => {
    await app.open();
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
    await page.getByRole('button', { name: 'New...', exact: true }).click();
    await page.getByTestId('import-uri-btn').click();
    await page.getByTestId('import-paste-manually').click();

    // Nothing that reads as a connection string.
    const input = page.getByTestId('dialog-input');
    await input.fill('# just a comment');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toBeVisible();

    // Typing again clears what was wrong with it.
    await input.fill('# Production\nmongodb://prod.example:27017\n# Development\nmongodb://dev.example:27017');
    await expect(page.getByTestId('dialog-error')).toHaveCount(0);

    // Enter on its own is a newline here; Ctrl+Enter sends it.
    await input.press('Enter');
    await expect(input).toBeVisible();
    await input.press('Control+Enter');

    // Several URIs: one more confirmation, then a profile for each.
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(async () => (await app.calls('save_connection_profile')).length).toBe(2);
    const names = (await app.calls('save_connection_profile')).map((call) => (call.args as { profile: { name: string } }).profile.name);
    expect(names).toEqual(['Production', 'Development']);
  });
});
