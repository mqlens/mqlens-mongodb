import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, type Seed } from '../harness/seed';
import { connectStaging, dismissHoverCards, STAGING_URI, view } from '../helpers';

// Creating a view (#396): the collections it offers as a source, and every
// reason a view is not created.

const sidebar = (page: Page) => page.getByRole('complementary');
const error = (page: Page) => page.getByTestId('view-error');

/** Open Create View on `database`, with the connection seeded from `seed`. */
async function openCreateView(app: App, page: Page, database: string, seed: Seed = {}): Promise<void> {
  await connectStaging(app, page, seed);
  await sidebar(page).getByRole('button', { name: `Database ${database}` }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Create View', exact: true }).click();
  await dismissHoverCards(page);
}

test.describe('Creating a view', () => {
  test('says why the source collections could not be listed', async ({ app, page }) => {
    await connectStaging(app, page);
    await app.failNext('list_collections', 'not authorized on sales_db to list collections');
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Create View', exact: true }).click();
    await dismissHoverCards(page);

    await expect(error(page)).toContainText('not authorized on sales_db to list collections');
    // The form is still there, with nothing to pick from.
    await expect(page.getByTestId('create-view')).toBeVisible();
    await expect(page.getByTestId('view-source-select')).toContainText('(no collections)');
  });

  test('a database with nothing in it has no source to offer', async ({ app, page }) => {
    await openCreateView(app, page, 'blank_db', {
      servers: { [STAGING_URI]: { ...SAMPLE_SERVER, databases: { ...SAMPLE_SERVER.databases, blank_db: {} } } },
    });

    await expect(page.getByTestId('view-source-select')).toContainText('(no collections)');
    await page.getByTestId('view-name-input').fill('nothing_much');
    await page.getByTestId('view-create-btn').click();

    await expect(error(page)).toHaveText('Select a source collection.');
    expect(await app.calls('create_view')).toHaveLength(0);
  });

  test('refuses a pipeline that is not an array, and says what the server refused', async ({ app, page }) => {
    await openCreateView(app, page, 'sales_db');

    // Valid JSON, but a single stage rather than a list of them.
    await page.getByTestId('view-name-input').fill('premium_customers');
    await page.getByTestId('view-pipeline-input').fill('{ "$match": { "tier": "Premium" } }');
    await page.getByTestId('view-create-btn').click();
    await expect(error(page)).toHaveText('Pipeline must be a JSON array of stages.');
    expect(await app.calls('create_view')).toHaveLength(0);

    // A name the database already holds is refused by the server, not the form.
    await page.getByTestId('view-name-input').fill('customers');
    await page.getByTestId('view-pipeline-input').fill('[]');
    await page.getByTestId('view-create-btn').click();
    await expect(error(page)).toContainText('Collection already exists: sales_db.customers');
    await expect(page.getByTestId('create-view')).toBeVisible();
  });

  test('a form closed while its collections load leaves nothing behind', async ({ app, page }) => {
    await connectStaging(app, page);
    const release = await app.hold('list_collections');
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Create View', exact: true }).click();
    await dismissHoverCards(page);
    await expect(page.getByTestId('create-view')).toContainText('Loading collections…');

    await page.getByTestId('workspace-tab-strip').getByRole('button', { name: /^Close New View/ }).click();
    await expect(page.getByTestId('create-view')).toHaveCount(0);
    await release();

    // The list lands with no form to fill, and the app carries on.
    await expect(view(page)).toBeVisible();
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
