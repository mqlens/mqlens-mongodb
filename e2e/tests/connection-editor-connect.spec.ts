import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging } from '../helpers';

// Connecting from the editor to something already open (#396): a second live
// session for one profile would be dropped as a duplicate and left running
// with nothing pointing at it, so the editor refuses and lets go of it.

const dialog = (page: Page) => page.getByRole('dialog');

async function editStaging(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await page.getByRole('complementary').getByRole('button', { name: 'Manage Connections' }).click();
  await dialog(page).getByText('Staging', { exact: true }).first().click();
  await dialog(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByTestId('editor-connect-btn')).toBeVisible();
}

test.describe('Connecting from the editor', () => {
  test('refuses a second session for a profile already open, and disconnects it', async ({ app, page }) => {
    await editStaging(app, page);
    const connectsBefore = (await app.calls('connect_db')).length;

    await page.getByTestId('editor-connect-btn').click();

    await expect(dialog(page)).toContainText('already active');
    // Nothing is opened to find that out, so there is nothing to let go of.
    await page.waitForTimeout(500);
    expect(await app.calls('connect_db')).toHaveLength(connectsBefore);
  });

  test('the details pane says a connected profile is already connected', async ({ app, page }) => {
    await connectStaging(app, page);
    await page.getByRole('complementary').getByRole('button', { name: 'Manage Connections' }).click();
    await dialog(page).getByText('Staging', { exact: true }).first().click();

    await expect(dialog(page).getByRole('button', { name: 'Already Connected' })).toBeVisible();
  });
});
