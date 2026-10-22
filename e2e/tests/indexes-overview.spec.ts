import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, type ServerAccountSeed } from '../harness/seed';
import { confirmTypedName, dismissHoverCards, loadSample, openCollection, STAGING_URI } from '../helpers';

// The consolidated Indexes view of a collection (#512).

const sidebar = (page: Page) => page.getByRole('complementary');
const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');
const overview = (page: Page) => view(page).getByTestId('collection-indexes');
const row = (page: Page, name: string) => overview(page).getByTestId(`index-row-${name}`);

async function openOverview(page: Page): Promise<void> {
  await sidebar(page).getByText('indexes', { exact: true }).click();
  await dismissHoverCards(page);
  await expect(overview(page)).toBeVisible();
}

test.describe('Indexes view', () => {
  test.beforeEach(async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
  });

  test('lists every index and drops one from the table', async ({ app, page }) => {
    await openOverview(page);

    await expect(row(page, '_id_')).toContainText('DEFAULT');
    await expect(row(page, 'email_1')).toContainText('email ↑');
    await expect(row(page, 'email_1')).toContainText('4 KB');
    await expect(row(page, 'email_1')).toContainText('0 ops');
    await expect(row(page, 'tier_1')).toBeVisible();
    await expect(overview(page).getByTestId('drop-index-_id_')).toHaveCount(0);

    await overview(page).getByTestId('drop-index-email_1').click();
    await confirmTypedName(page, 'email_1');

    await expect(row(page, 'email_1')).toHaveCount(0);
    await expect(row(page, 'tier_1')).toBeVisible();
    await expect(sidebar(page).getByText('email_1', { exact: true })).toHaveCount(0);
    const deletes = await app.calls('delete_index');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args).toMatchObject({ database: 'sales_db', collection: 'customers', indexName: 'email_1' });
  });

  test('opens an index from its row', async ({ page }) => {
    await openOverview(page);
    await row(page, 'tier_1').click();
    await expect(view(page).getByTestId('index-viewer')).toContainText('tier_1');
  });

  test('shows usage as unavailable when index stats cannot be read', async ({ app, page }) => {
    await app.failNext('index_stats', 'not authorized on sales_db to run $indexStats');
    await openOverview(page);

    await expect(overview(page).getByTestId('index-stats-unavailable')).toContainText('not authorized on sales_db to run $indexStats');
    await expect(row(page, 'email_1').getByTestId('index-usage')).toHaveText('—');
  });
});

test.describe('Indexes view on an MQLens Server connection', () => {
  const ORDERS = { id: 'orders', name: 'Orders', server: STAGING_URI, opClasses: ['read', 'write', 'ddl', 'admin'] };
  const WORK: ServerAccountSeed = {
    id: 'acct-w',
    name: 'Work',
    url: 'https://mqlens.example.com',
    tenant: 'acme',
    email: 'dev@example.com',
    password: 'right',
    signedIn: true,
    connections: [ORDERS],
  };

  async function connectOrders(app: App, page: Page): Promise<void> {
    await app.open({ servers: { [STAGING_URI]: SAMPLE_SERVER }, serverAccounts: [WORK] });
    await page.getByRole('button', { name: 'Manage Connections', exact: true }).click();
    await page.getByRole('button', { name: 'MQLens Server', exact: true }).click();
    await page.getByRole('button', { name: 'Connect to Orders', exact: true }).click();
    await openCollection(page, 'sales_db', 'customers');
  }

  test('lists the indexes through the server', async ({ app, page }) => {
    await connectOrders(app, page);
    await openOverview(page);
    await expect(row(page, 'email_1')).toContainText('email ↑');
    await expect(row(page, 'email_1')).toContainText('4 KB');
  });

  test('shows the server refusing to list them', async ({ app, page }) => {
    await connectOrders(app, page);
    await app.failNext('list_indexes', 'not authorized on sales_db to execute listIndexes');
    await openOverview(page);
    await expect(overview(page).getByTestId('collection-indexes-error')).toContainText(
      'not authorized on sales_db to execute listIndexes'
    );
  });
});
