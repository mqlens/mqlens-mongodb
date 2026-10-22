import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, type ServerAccountSeed } from '../harness/seed';
import { callFrom, confirmTypedName, connectStaging, dismissHoverCards, loadSample, openCollection, STAGING_URI } from '../helpers';

// The consolidated Indexes view of a collection (#512).

const sidebar = (page: Page) => page.getByRole('complementary');
const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');
const overview = (page: Page) => view(page).getByTestId('collection-indexes');
const row = (page: Page, name: string) => overview(page).getByTestId(`index-row-${name}`);
const strip = (page: Page) => page.getByTestId('workspace-tab-strip');
const rowNames = (page: Page) =>
  overview(page).locator('[data-index-name]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-index-name')));

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

  test('names each kind of index and sorts the table', async ({ page }) => {
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        list_indexes: () => [
          { name: '_id_', keys: '{"_id":1}', unique: true, sparse: false },
          { name: 'bio_text', keys: '{"_fts":"text","_ftsx":1}', unique: false, sparse: false },
          { name: 'loc_2dsphere', keys: '{"loc":"2dsphere"}', unique: false, sparse: true },
          { name: 'pt_2d', keys: '{"pt":"2d"}', unique: false, sparse: false },
          { name: 'uid_hashed', keys: '{"uid":"hashed"}', unique: false, sparse: false },
          { name: 'all_wild', keys: '{"$**":1}', unique: false, sparse: false },
          { name: 'garbled', keys: 'not json at all', unique: false, sparse: false },
        ],
        index_stats: () => [
          { name: '_id_', sizeBytes: 4096, ops: 9, sinceMs: 0 },
          { name: 'bio_text', sizeBytes: 65536, ops: 1, sinceMs: 0 },
          { name: 'loc_2dsphere', sizeBytes: 8192, ops: 30, sinceMs: 0 },
        ],
      });
    });
    await openOverview(page);

    await expect(row(page, 'bio_text')).toContainText('Text');
    await expect(row(page, 'loc_2dsphere')).toContainText('2dsphere');
    await expect(row(page, 'pt_2d')).toContainText('2d');
    await expect(row(page, 'uid_hashed')).toContainText('Hashed');
    await expect(row(page, 'all_wild')).toContainText('Wildcard');
    // Keys the app cannot read leave the row with no chips, not a crash.
    await expect(row(page, 'garbled')).toContainText('Regular');
    // Editing re-creates from ±1 keys, so special types offer no edit.
    await expect(overview(page).getByTestId('edit-index-loc_2dsphere')).toHaveCount(0);

    await overview(page).getByRole('button', { name: 'Name', exact: true }).click();
    expect((await rowNames(page))[0]).toBe('_id_');
    await overview(page).getByRole('button', { name: 'Size', exact: true }).click();
    expect((await rowNames(page)).slice(0, 3)).toEqual(['bio_text', 'loc_2dsphere', '_id_']);
    await overview(page).getByRole('button', { name: 'Usage', exact: true }).click();
    expect((await rowNames(page)).slice(0, 3)).toEqual(['loc_2dsphere', '_id_', 'bio_text']);
  });

  test('says when a collection has no indexes', async ({ page }) => {
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({ list_indexes: () => [] });
    });
    await openOverview(page);
    await expect(overview(page).getByTestId('collection-indexes-empty')).toBeVisible();
  });

  test('opens one tab per collection, from the label or the folder menu', async ({ page }) => {
    await openOverview(page);
    await strip(page).getByText('customers', { exact: true }).click();
    await sidebar(page).getByText('indexes', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open Indexes View' }).click();
    await dismissHoverCards(page);
    await expect(overview(page)).toBeVisible();
    await expect(strip(page).getByText('Indexes: customers')).toHaveCount(1);
  });

  test('shows usage as unavailable when index stats cannot be read', async ({ app, page }) => {
    await app.failNext('index_stats', 'not authorized on sales_db to run $indexStats');
    await openOverview(page);

    await expect(overview(page).getByTestId('index-stats-unavailable')).toContainText('not authorized on sales_db to run $indexStats');
    await expect(row(page, 'email_1').getByTestId('index-usage')).toHaveText('—');
  });
});

test.describe('Indexes view after a rename', () => {
  test('follows its collection to the new name', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await openOverview(page);

    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('clients');
    await callFrom(app, 'rename_collection', () => page.getByTestId('dialog-confirm').click());

    await expect(strip(page).getByText('Indexes: clients')).toBeVisible();
    await expect(strip(page).getByText('Indexes: customers')).toHaveCount(0);
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
