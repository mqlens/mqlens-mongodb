import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';

// Importing a connection from the clipboard (#396): what it makes of what is
// on it, and what it says when there is nothing there to use.

const dialog = (page: Page) => page.getByRole('dialog');

/** Open the connection manager's import menu, over a fresh app. */
async function openImportMenu(app: App, page: Page): Promise<void> {
  if (!app.isOpen) await app.open();
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await page.getByRole('button', { name: 'New...', exact: true }).click();
  await page.getByTestId('import-uri-btn').click();
}

const writeClipboard = (page: Page, text: string) =>
  page.evaluate((value) => navigator.clipboard.writeText(value), text);

test.describe('Importing from the clipboard', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Clipboard permissions are granted in Chromium only');

  test('takes a connection string off it', async ({ app, page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await app.open();
    await writeClipboard(page, 'mongodb://reporting.example:27018/sales_db');
    await openImportMenu(app, page);

    await page.getByTestId('import-from-clipboard').click();

    // One URI fills the editor rather than saving anything.
    await expect(page.getByTestId('host-list')).toHaveValue(/reporting\.example:27018/);
  });

  test('says when there is nothing on it, and when it holds no connection', async ({ app, page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await app.open();
    await writeClipboard(page, '   ');
    await openImportMenu(app, page);

    await page.getByTestId('import-from-clipboard').click();
    await expect(dialog(page)).toContainText('Clipboard is empty');

    // Text, but nothing in it that reads as a connection.
    await writeClipboard(page, 'just some notes about the database');
    await page.getByTestId('import-uri-btn').click();
    await page.getByTestId('import-from-clipboard').click();
    await expect(dialog(page)).toContainText('No mongodb:// or mongodb+srv:// URI found');
  });
});
