import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, loadSample, openCollection, setEditorText, view } from '../helpers';

// The index a slow query asks for, the modal that writes one, and the viewer
// that shows one (#396).

const sidebar = (page: Page) => page.getByRole('complementary');
const banner = (page: Page) => view(page).getByTestId('index-suggestion-banner');
const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });

/** Run `filter` on the open collection and open its explain plan. */
async function explain(page: Page, filter: string): Promise<void> {
  await setEditorText(page, view(page).getByTestId('query-filter-input'), filter);
  await runButton(page).click();
  await view(page).getByTestId('explain-plan-tab').click();
}

/** Open customers on the saved connection, whose explain is a collection scan. */
async function openCustomers(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
}

test.describe('Suggesting an index', () => {
  test('puts the equality fields first and the range fields last', async ({ app, page }) => {
    await openCustomers(app, page);

    // Two equality fields, in the order the query names them.
    await explain(page, '{ tier: "Premium", "address.state": "NY" }');
    await expect(banner(page)).toContainText('{"tier":1,"address.state":1}');

    // A range on its own still wants an index.
    await view(page).getByRole('button', { name: 'Results', exact: true }).click();
    await explain(page, '{ joined: { $gte: "2024-01-01" } }');
    await expect(banner(page)).toContainText('{"joined":1}');

    // An $or is not a field of its own, so only tier is suggested.
    await view(page).getByRole('button', { name: 'Results', exact: true }).click();
    await explain(page, '{ $or: [{ tier: "Premium" }, { tier: "Standard" }], "address.city": "New York" }');
    await expect(banner(page)).toContainText('{"address.city":1}');
  });

  test('suggests nothing for a query no single index would serve', async ({ app, page }) => {
    await openCustomers(app, page);

    // A regex is neither equality nor a range, and it is the only condition.
    await explain(page, '{ name: { $regex: "^A" } }');
    await expect(view(page).getByTestId('explain-panel')).toBeVisible();
    await expect(banner(page)).toHaveCount(0);

    // A plan the app cannot read suggests nothing either.
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        explain_mql_query: () => JSON.stringify({ executionStats: { nReturned: 0 } }),
      });
    });
    await view(page).getByRole('button', { name: 'Results', exact: true }).click();
    await explain(page, '{ tier: "Premium" }');
    await expect(banner(page)).toHaveCount(0);
  });

  test('reads a plan that scans several branches at once', async ({ app, page }) => {
    await openCustomers(app, page);
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        explain_mql_query: () =>
          JSON.stringify({
            queryPlanner: {
              namespace: 'sales_db.customers',
              parsedQuery: { $and: [{ tier: { $eq: 'Premium' } }, { $or: [{ a: 1 }, { b: 2 }] }] },
              // One branch per $or clause, neither of them served by an index.
              winningPlan: {
                stage: 'SUBPLAN',
                inputStage: {
                  stage: 'OR',
                  inputStages: [{ stage: 'COLLSCAN' }, { stage: 'COLLSCAN' }],
                },
              },
            },
          }),
      });
    });

    await explain(page, '{ tier: "Premium" }');
    await expect(banner(page)).toContainText('{"tier":1}');
  });

  test('a scan that is sorted wants the sort key too', async ({ app, page }) => {
    // The sample server explains sales_db.transactions with a sorted collection scan.
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'transactions');
    await expect(view(page)).toContainText('Alice Smith');

    await explain(page, '{ status: "Completed" }');
    // Equality first, then the sort, in the direction the sort asked for.
    await expect(banner(page)).toContainText('{"status":1,"timestamp":-1}');
  });
});

test.describe('The index modal', () => {
  test.beforeEach(async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await sidebar(page).getByText('indexes', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Create Index' }).click();
  });

  test('refuses raw keys that are not an object, or a direction that is not 1 or -1', async ({ app, page }) => {
    const modal = page.getByTestId('index-modal');
    await modal.getByRole('tab', { name: 'Raw JSON' }).click();
    const raw = modal.getByPlaceholder('{ "email": 1 }');
    const name = modal.getByTestId('index-name-input');
    const save = modal.getByTestId('save-index-btn');

    // The name follows the keys, and keys it cannot read name nothing.
    await raw.fill('[1]');
    await expect(name).toHaveValue('');
    await raw.fill('{ "tier"');
    await expect(name).toHaveValue('');
    await raw.fill('{ "tier": 2 }');
    await expect(name).toHaveValue('tier_2');

    // Every direction is 1 or -1.
    await name.fill('tier_idx');
    await save.click();
    await expect(modal).toContainText('Index direction for "tier" must be 1 (Ascending) or -1 (Descending)');

    // A list of keys is not an index definition.
    await raw.fill('[1]');
    await save.click();
    await expect(modal).toContainText('Index keys must be a JSON object');

    // Nor is JSON that does not parse.
    await raw.fill('{ "tier"');
    await save.click();
    await expect(modal).toBeVisible();
    expect(await app.calls('create_index')).toHaveLength(0);

    await raw.fill('{ "tier": -1 }');
    await save.click();
    await expect(modal).toHaveCount(0);
    const args = (await app.calls('create_index'))[0].args as { indexName: string; keys: unknown };
    expect(args.indexName).toBe('tier_idx');
    expect(typeof args.keys === 'string' ? JSON.parse(args.keys) : args.keys).toEqual({ tier: -1 });
  });

  test('every key needs a field, and the index needs a name', async ({ app, page }) => {
    const modal = page.getByTestId('index-modal');
    const name = modal.getByTestId('index-name-input');
    const field = modal.getByTestId('index-key-field-0');
    const save = modal.getByTestId('save-index-btn');

    await name.fill('hand_written');
    // A field typed by hand rather than picked from the collection's own.
    await field.selectOption('__custom__');
    await modal.getByTestId('index-key-field-0').fill('   ');
    await save.click();
    await expect(modal).toContainText('All index key fields must have a name');

    // Back to the collection's fields, and a name of nothing but spaces.
    await modal.getByRole('button', { name: 'List' }).click();
    await name.fill('   ');
    await save.click();
    await expect(modal).toContainText('Index name is required');
    expect(await app.calls('create_index')).toHaveLength(0);
  });

  test('Escape closes the modal without writing an index', async ({ app, page }) => {
    const modal = page.getByTestId('index-modal');
    await expect(modal).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    expect(await app.calls('create_index')).toHaveLength(0);
  });
});

test.describe('The index viewer', () => {
  test('says why an index cannot be shown', async ({ app, page }) => {
    await openCustomers(app, page);
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('tier_1', { exact: true })).toBeVisible();

    // The viewer lists the indexes itself, and says when that fails.
    await app.failNext('list_indexes', 'not authorized on sales_db to run listIndexes');
    await sidebar(page).getByText('_id_', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page).getByTestId('index-viewer-error')).toContainText(
      'not authorized on sales_db to run listIndexes',
    );

    // Keys the app cannot read leave the index with no fields to name.
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        list_indexes: () => [
          { name: '_id_', keys: '{"_id":1}', unique: true, sparse: false },
          { name: 'email_1', keys: 'not json at all', unique: false, sparse: false },
        ],
      });
    });
    await sidebar(page).getByText('email_1', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page).getByTestId('index-viewer')).toContainText('User-created index on (unknown fields).');

    // An index the server no longer has is named in full.
    await sidebar(page).getByText('tier_1', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page).getByTestId('index-viewer-error')).toContainText(
      'Index "tier_1" was not found on sales_db.customers.',
    );
  });

  test('copies the definition of the index it shows', async ({ app, page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard permissions are granted in Chromium only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openCustomers(app, page);
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('_id_', { exact: true }).click();
    await dismissHoverCards(page);

    const viewer = view(page).getByTestId('index-viewer');
    await expect(viewer).toContainText('System primary key index.');
    await expect(viewer).toContainText('"unique": true');

    const copy = viewer.getByRole('button', { name: 'Copy JSON' });
    await copy.click();
    await expect(viewer.getByRole('button', { name: 'Copied!' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"name": "_id_"');
  });
});
