import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { connectStaging, openCollection, openInNewTab, STAGING_URI, view } from '../helpers';

// Workspace work the backend refuses (#396): detaching a tab and recording a
// connection are both fire-and-forget, so a refusal must leave the window it
// was asked from exactly as it was rather than half-moved.

const strip = (page: Page) => page.getByTestId('workspace-tab-strip');
const STAGING = { id: 'p-staging', name: 'Staging', uri: STAGING_URI };

async function twoTabs(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
  await openInNewTab(page, 'products');
  await expect(strip(page).getByText('products', { exact: true })).toBeVisible();
}

test.describe('When the backend refuses', () => {
  test('a tab that cannot be detached stays where it is', async ({ app, page }) => {
    await twoTabs(app, page);

    await app.failNext('workspace_detach_tab', 'no window could be opened');
    await strip(page).getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Detach to New Window' }).click();

    await expect.poll(async () => (await app.calls('workspace_detach_tab')).length).toBe(1);
    // The window it was asked from carries on with both tabs.
    await expect(strip(page).getByText('customers', { exact: true })).toBeVisible();
    await expect(strip(page).getByText('products', { exact: true })).toBeVisible();
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('a connection whose details could not be recorded is still usable', async ({ app, page }) => {
    // Opened first: the failure has to be set up on a backend that exists.
    await app.open({ profiles: [STAGING], servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await app.failNext('set_connection_meta', 'the workspace store is locked');
    await page.getByTestId('conn-card-p-staging').click();
    await page.getByRole('button', { name: 'Connection Staging' }).waitFor();

    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
