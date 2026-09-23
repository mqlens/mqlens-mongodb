import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections, view } from '../helpers';

// Renaming a database under the tabs that are open on it (#396): an index tab
// and a watch tab both belong to a database by name, so both have to be aimed
// at the new one rather than left pointing at a database that is gone.

const sidebar = (page: Page) => page.getByRole('complementary');
const strip = (page: Page) => page.getByTestId('workspace-tab-strip');

test.describe('Renaming a database', () => {
  test('carries the index and watch tabs open on it across', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'user_analytics');

    // An index tab on events, opened through the collection's own tree...
    await sidebar(page).getByText('events', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page)).toContainText('page_view');
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('event_type_1', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page).getByTestId('index-viewer')).toBeVisible();

    // ...and a watch tab beside it.
    await sidebar(page).getByText('events', { exact: true }).click({ button: 'right' });
    await page.getByTestId('ctx-watch-collection').click();
    await dismissHoverCards(page);
    await expect(page.getByTestId('watch-status')).toHaveText('live');

    await sidebar(page).getByRole('button', { name: 'Database user_analytics' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Database', exact: true }).click();
    await page.getByTestId('dialog-input').fill('analytics');
    await page.getByTestId('dialog-confirm').click();
    // Renaming copies the database, so it asks again before dropping the source.
    await page.getByTestId('dialog-confirm').click();
    await expect(sidebar(page).getByRole('button', { name: 'Database analytics' })).toBeVisible();

    // The tail followed the database rather than stopping on a name that has gone.
    await expect(page.getByText('analytics.events', { exact: true })).toBeVisible();
    await expect(page.getByTestId('watch-status')).toHaveText('live');

    // And so did the index tab, which asks the renamed database for its index.
    await strip(page).getByText('events.event_type_1', { exact: true }).click();
    await expect(view(page).getByTestId('index-viewer')).toBeVisible();
    await expect
      .poll(async () =>
        (await app.calls('list_indexes')).some((call) => {
          const args = call.args as { db?: string; collection?: string };
          return args.db === 'analytics' && args.collection === 'events';
        }),
      )
      .toBe(true);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
