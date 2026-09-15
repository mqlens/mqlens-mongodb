import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, connectStaging, dismissHoverCards, expandCollections, loadSample, STAGING_URI } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary').first();
const databaseRow = (page: Page, name: string) => sidebar(page).getByRole('button', { name: `Database ${name}` });
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });

async function answer(page: Page, value: string): Promise<void> {
  await page.getByTestId('dialog-input').fill(value);
  await page.getByTestId('dialog-confirm').click();
}

async function menu(page: Page, row: ReturnType<Page['getByRole']>, item: string): Promise<void> {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test.describe('Sidebar on the sample connection', () => {
  test('adds, renames and drops without calling the backend', async ({ app, page }) => {
    await app.open();
    await loadSample(page);

    await menu(page, sidebar(page).getByRole('button', { name: 'Connection Sample (mqlens_demo)' }), 'Add Database');
    // The sample connection creates the database without asking for a first collection.
    await answer(page, 'scratch');
    await expect(databaseRow(page, 'scratch')).toBeVisible();

    await expandCollections(page, 'sales_db');
    await menu(page, sidebar(page).getByText('products', { exact: true }), 'Rename Collection');
    await answer(page, 'items');
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('items', { exact: true })).toBeVisible();
    await menu(page, sidebar(page).getByText('items', { exact: true }), 'Drop Collection');
    await page.getByTestId('dialog-confirm').click();
    await expect(sidebar(page).getByText('items', { exact: true })).toHaveCount(0);

    await dismissHoverCards(page);
    await menu(page, databaseRow(page, 'scratch'), 'Rename Database');
    await answer(page, 'scratch2');
    await page.getByTestId('dialog-confirm').click();
    await expect(databaseRow(page, 'scratch2')).toBeVisible();
    await dismissHoverCards(page);
    await menu(page, databaseRow(page, 'scratch2'), 'Drop Database');
    await page.getByTestId('dialog-confirm').click();
    await expect(databaseRow(page, 'scratch2')).toHaveCount(0);

    for (const command of ['create_collection', 'rename_collection', 'drop_collection', 'rename_database', 'drop_database']) {
      expect(await app.calls(command), command).toHaveLength(0);
    }
  });
});

test.describe('Sidebar on a saved connection', () => {
  test('renames a collection with the tree expanded to its indexes, and a database without a time-series collection', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('email_1', { exact: true })).toBeVisible();

    await menu(page, sidebar(page).getByText('customers', { exact: true }).first(), 'Rename Collection');
    await callFrom(app, 'rename_collection', () => answer(page, 'clients'));
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('clients', { exact: true }).first()).toBeVisible();

    // sales_db holds sensor_readings, a time-series collection, which the backend won't move.
    await menu(page, databaseRow(page, 'sales_db'), 'Rename Database');
    await answer(page, 'sales');
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'is time-series')).toBeVisible();
    await dismissHoverCards(page);

    await menu(page, databaseRow(page, 'user_analytics'), 'Rename Database');
    await answer(page, 'analytics');
    await callFrom(app, 'rename_database', () => page.getByTestId('dialog-confirm').click());
    await expect(databaseRow(page, 'analytics')).toBeVisible();
  });

  test('reports sidebar commands that fail', async ({ app, page }) => {
    await connectStaging(app, page);

    await app.failNext('list_collections', 'not authorized to list collections');
    await databaseRow(page, 'user_analytics').click();
    await expect(toast(page, 'not authorized to list collections')).toBeVisible();
    await dismissHoverCards(page);

    await app.failNext('create_collection', 'collection limit reached');
    await menu(page, databaseRow(page, 'user_analytics'), 'Add Collection');
    await answer(page, 'extra');
    await expect(toast(page, 'collection limit reached')).toBeVisible();
    await dismissHoverCards(page);

    await expandCollections(page, 'sales_db');
    await app.failNext('drop_collection', 'collection is locked');
    await menu(page, sidebar(page).getByText('products', { exact: true }), 'Drop Collection');
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'collection is locked')).toBeVisible();
    await dismissHoverCards(page);

    await app.failNext('rename_database', 'rename not permitted');
    await menu(page, databaseRow(page, 'user_analytics'), 'Rename Database');
    await answer(page, 'analytics');
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'rename not permitted')).toBeVisible();
  });

  test('Ctrl+F searches, double-click opens another tab, Ctrl+click selects several', async ({ app, page, browserName }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await dismissHoverCards(page);

    await page.getByTestId('workspace-tab-strip').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+f');
    await expect(sidebar(page).getByTestId('sidebar-search')).toBeFocused();
    await page.keyboard.press('Escape');

    const customers = sidebar(page).getByText('customers', { exact: true });
    await customers.click();
    await dismissHoverCards(page);
    await customers.dblclick();
    // Tabs on a saved connection are labelled with the profile: Staging / sales_db:customers.
    await expect(page.getByTestId('workspace-tab-strip').getByText(/sales_db:customers$/)).toHaveCount(2);

    await dismissHoverCards(page);
    // WebKit takes Ctrl+click as a right-click; the multi-select modifier there is Meta.
    const select: Array<'Control' | 'Meta'> = browserName === 'webkit' ? ['Meta'] : ['Control'];
    await sidebar(page).getByText('products', { exact: true }).click({ modifiers: select });
    // The row's stats card opens under a resting pointer and would cover the next row.
    await dismissHoverCards(page);
    await sidebar(page).getByText('transactions', { exact: true }).click({ modifiers: select });
    await dismissHoverCards(page);
    await menu(page, sidebar(page).getByText('transactions', { exact: true }), 'Copy to…');
    await expect(page.getByText(/Copy 2 collections/)).toBeVisible();
  });

  test('the connection hover card shows replica set health and opens monitoring', async ({ app, page }) => {
    const replSet = {
      isReplicaSet: true,
      clusterType: 'replicaSet',
      set: 'rs0',
      myStateStr: 'PRIMARY',
      mongoVersion: '7.0.5',
      members: [
        { name: 'staging-a:27017', stateStr: 'PRIMARY', health: 1, self: true, uptimeSecs: 900, optimeDateMs: 1_747_000_000_000, pingMs: null, syncSource: '', lagSecs: null },
        { name: 'staging-b:27017', stateStr: 'SECONDARY', health: 1, self: false, uptimeSecs: 900, optimeDateMs: 1_746_999_990_000, pingMs: 4, syncSource: 'staging-a:27017', lagSecs: 10 },
        { name: 'staging-c:27017', stateStr: '(not reachable/healthy)', health: 0, self: false, uptimeSecs: 0, optimeDateMs: 0, pingMs: null, syncSource: '', lagSecs: null },
      ],
    };
    await connectStaging(
      app,
      page,
      { monitoring: { replSet } },
      { uri: 'mongodb://reporter@staging.example:27017/?readPreference=secondaryPreferred' },
    );

    await sidebar(page).getByRole('button', { name: 'Connection Staging' }).hover();
    const cluster = page.getByTestId('cluster-health-card');
    await expect(cluster.getByTestId('cluster-card-member-staging-b:27017')).toBeVisible();
    await expect(cluster.getByTestId('cluster-card-user')).toContainText('reporter');
    await expect(cluster.getByTestId('cluster-card-read-pref')).toContainText('SecondaryPreferred');
    const before = (await app.calls('repl_set_status')).length;
    await cluster.getByTestId('cluster-card-refresh').click();
    await expect.poll(async () => (await app.calls('repl_set_status')).length).toBeGreaterThan(before);

    await page.getByTestId('cluster-card-open-monitoring').click();
    await expect(page.getByTestId('monitoring-view')).toBeVisible();
  });

  test('an unsaved connection cannot be pinned or favorited, and a bucket needs a valid name', async ({ app, page }) => {
    await app.open({ servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
    await page.getByRole('button', { name: 'New...', exact: true }).click();
    await page.getByLabel('Display Name').fill('Staging');
    await page.getByTestId('host-list').fill('staging.example:27017');
    await page.getByTestId('editor-connect-btn').click();
    await page.getByTestId('connect-skip-save-btn').click();

    const connection = sidebar(page).getByRole('button', { name: 'Connection Staging' });
    await expect(connection).toBeVisible();
    await connection.click({ button: 'right' });
    await page.getByTestId('ctx-pin-conn-conn-1').click();
    await expect(toast(page, /Save the connection/)).toBeVisible();
    await menu(page, connection, 'Add to favorites');
    await expect(toast(page, /Save the connection/).last()).toBeVisible();

    await databaseRow(page, 'sales_db').click({ button: 'right' });
    await page.getByTestId('ctx-add-gridfs-bucket-conn-1-sales_db').click();
    await answer(page, 'bad name!');
    await expect(page.getByTestId('dialog-error')).toBeVisible();
    await page.getByTestId('dialog-cancel').click();
  });
});
