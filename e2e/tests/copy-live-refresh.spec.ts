import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections } from '../helpers';

// A copy that takes a while (#396). Collections trickle into the destination
// as it runs, so the sidebar keeps re-reading it rather than showing what was
// there when the copy started.

const sidebar = (page: Page) => page.getByRole('complementary');
const dialog = (page: Page) => page.getByRole('dialog');

/** Start a collection copy whose task never finishes. */
async function startSlowCopy(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await page.evaluate(() => {
    const e2e = window.__MQLENS_E2E__!;
    e2e.register({
      start_collection_copy: () => {
        const task = {
          id: 'copy-1',
          kind: 'collection_copy',
          label: 'Copy products',
          status: 'running',
          processed: 0,
          total: 100,
          message: 'Copying',
          path: null,
          error: null,
          createdAtMs: Date.now(),
          finishedAtMs: null,
        };
        e2e.state.tasks.unshift(task);
        return task;
      },
    });
  });

  await expandCollections(page, 'sales_db');
  await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy to…' }).click();
  await dismissHoverCards(page);
  await dialog(page).locator('#target-database').click();
  await page.getByRole('option', { name: 'user_analytics', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Start copy' }).click();
}

test.describe('While a copy is running', () => {
  test('the destination is read again so what arrives shows up', async ({ app, page }) => {
    await startSlowCopy(app, page);
    await expect(dialog(page)).toHaveCount(0);

    const reads = async () => (await app.calls('list_collections')).length;
    const afterStart = await reads();

    // The re-read is on a four-second timer, so this waits for one to land.
    await expect.poll(reads, { timeout: 15_000 }).toBeGreaterThan(afterStart);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
