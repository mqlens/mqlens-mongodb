import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, openCollection, view } from '../helpers';

// The stats cards the sidebar shows on hover, and the schema view's own
// failures (#396): each says what went wrong and offers to ask again.
//
// One card per test: a card that is up covers the rows beneath it, so hovering
// the next row in the same test would land on the card instead.

const sidebar = (page: Page) => page.getByRole('complementary').first();

async function openCustomers(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
}

test.describe('Stats cards', () => {
  test('a database card says why its stats could not be read, and reads them again', async ({ app, page }) => {
    await openCustomers(app, page);

    await app.failNext('db_stats', 'not authorized to run dbStats');
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).hover();
    const card = page.getByTestId('db-stats-card');
    await expect(card).toContainText('not authorized to run dbStats');

    await card.getByTestId('stats-refresh').click();
    await expect(card).toContainText('Collections');
  });

  test('a collection card says why its stats could not be read, and reads them again', async ({ app, page }) => {
    await openCustomers(app, page);

    await app.failNext('coll_stats', 'not authorized to run collStats');
    await sidebar(page).getByText('customers', { exact: true }).first().hover();
    const card = page.getByTestId('coll-stats-card');
    await expect(card).toContainText('not authorized to run collStats');

    await card.getByTestId('stats-refresh').click();
    await expect(card).toContainText('Documents');
  });

  test('an index card says why its stats could not be read, and reads them again', async ({ app, page }) => {
    await openCustomers(app, page);
    await sidebar(page).getByText('indexes', { exact: true }).first().click();
    await dismissHoverCards(page);

    await app.failNext('index_stats', 'not authorized to run $indexStats');
    await sidebar(page).getByText('email_1', { exact: true }).hover();
    const card = page.getByTestId('index-stats-card');
    await expect(card).toContainText('not authorized to run $indexStats');

    await card.getByTestId('stats-refresh').click();
    await expect(card).toContainText('email_1');
  });
});

test.describe('Schema analysis failures', () => {
  test('says why a schema could not be analyzed', async ({ app, page }) => {
    await openCustomers(app, page);

    // The first analysis works; the next one fails.
    await view(page).getByTestId('analyze-schema-btn').click();
    await expect(view(page).getByTestId('schema-view')).toBeVisible();
    // Closed and opened again, so the view analyses afresh.
    await page.getByTestId('workspace-tab-strip').getByRole('button', { name: /^Close Schema: customers/ }).click();
    await page.getByTestId('workspace-tab-strip').getByText('customers', { exact: true }).click();
    await app.failNext('analyze_schema', 'not authorized to sample sales_db.customers');
    await view(page).getByTestId('analyze-schema-btn').click();

    await expect(view(page)).toContainText('not authorized to sample sales_db.customers');
    await expect(view(page).getByTestId('schema-view')).toHaveCount(0);
  });

  test('an empty collection has nothing to analyze, and coverage sorts the fields', async ({ app, page }) => {
    await connectStaging(app, page, {
      servers: {
        'mongodb://staging.example:27017': {
          databases: {
            shop: {
              empty: { docs: [] },
              mixed: {
                docs: [
                  { _id: 1, always: 'here', rarely: 'once' },
                  { _id: 2, always: 'here' },
                  { _id: 3, always: 'here' },
                ],
              },
            },
          },
        },
      },
    });

    await openCollection(page, 'shop', 'empty');
    await view(page).getByTestId('analyze-schema-btn').click();
    await expect(view(page)).toContainText('Collection is empty — nothing to analyze.');

    await sidebar(page).getByText('mixed', { exact: true }).click();
    await dismissHoverCards(page);
    await view(page).getByTestId('analyze-schema-btn').click();
    const schema = view(page).getByTestId('schema-view');
    await expect(schema.getByTestId('schema-row-rarely')).toContainText('33%');

    // Sorted by coverage, the field only one document has comes last.
    await schema.getByTestId('schema-sort-coverage').click();
    const rows = schema.locator('[data-testid^="schema-row-"]');
    await expect.poll(async () => (await rows.last().getAttribute('data-testid')) ?? '').toBe('schema-row-rarely');
  });
});
