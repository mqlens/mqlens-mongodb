import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom, connectStaging, dismissHoverCards, openCollection, setEditorText, view } from '../helpers';

// A saved query kept as a favourite (#396): clicking it opens the collection
// it belongs to with the query it was saved with — and says so when the query
// is no longer there to run.

const sidebar = (page: Page) => page.getByRole('complementary');
const favourites = (page: Page) =>
  sidebar(page).getByRole('button', { name: 'Favorites' }).locator('xpath=..');

/** Open the Favorites section if it is folded away. */
async function openFavourites(page: Page): Promise<void> {
  const section = favourites(page);
  if ((await section.getByText('Premium customers', { exact: true }).count()) === 0) {
    await sidebar(page).getByRole('button', { name: 'Favorites' }).click();
  }
  await expect(section.getByText('Premium customers', { exact: true })).toBeVisible();
}

/** Save the query bar's filter under `name`, as a favourite. */
async function favouriteQuery(app: App, page: Page, name: string): Promise<void> {
  await view(page).getByRole('button', { name: 'Save query', exact: true }).click();
  await page.getByTestId('save-favorite-query-item').click();
  await page.getByTestId('dialog-input').fill(name);
  await callFrom(app, 'save_query', () => page.getByTestId('dialog-confirm').click());
}

test.describe('A favourite saved query', () => {
  test('opens its collection with the query it was saved with', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await favouriteQuery(app, page, 'Premium customers');

    // Somewhere else entirely, then back through the favourite.
    await sidebar(page).getByText('products', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page)).toContainText('SuperBook Pro');

    await openFavourites(page);
    const ran = await callFrom(app, 'execute_mql_query', async () => {
      await favourites(page).getByText('Premium customers', { exact: true }).click();
      await dismissHoverCards(page);
    });
    expect(ran).toMatchObject({ database: 'sales_db', collection: 'customers' });
    expect(JSON.parse(String(ran.filter))).toEqual({ tier: 'Premium' });
    await expect(view(page)).toContainText('Charlie Brown');
    await expect(view(page)).not.toContainText('Bob Johnson');
  });

  test('says so when the query behind it is gone', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await favouriteQuery(app, page, 'Premium customers');

    // The catalogue no longer has it: the favourite is a pointer, not a copy.
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({ list_all_saved_queries: () => [] });
    });
    await sidebar(page).getByText('products', { exact: true }).click();
    await dismissHoverCards(page);
    await openFavourites(page);
    await favourites(page).getByText('Premium customers', { exact: true }).click();

    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'Saved query' })).toBeVisible();
  });
});
