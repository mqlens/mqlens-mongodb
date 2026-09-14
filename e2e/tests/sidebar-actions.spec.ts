import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, type ProfileSeed } from '../harness/seed';
import { callFrom, dismissHoverCards, expandCollections } from '../helpers';

const STAGING_URI = 'mongodb://staging.example:27017';

const sidebar = (page: Page) => page.getByRole('complementary');
const connectionRow = (page: Page) => sidebar(page).getByRole('button', { name: 'Connection Staging' });
const databaseRow = (page: Page, name: string) => sidebar(page).getByRole('button', { name: `Database ${name}` });

/**
 * Connect to a saved profile on a server that isn't the built-in mock: for the
 * mock connection the sidebar changes its own tree and calls no command.
 */
async function connectStaging(app: App, page: Page, profile: Partial<ProfileSeed> = {}): Promise<void> {
  await app.open({
    profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI, ...profile }],
    servers: { [STAGING_URI]: SAMPLE_SERVER },
  });
  await page.getByTestId('conn-card-p-staging').click();
  await expect(connectionRow(page)).toBeVisible();
}

async function menu(page: Page, row: ReturnType<Page['getByRole']>, item: string): Promise<void> {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function answerPrompt(page: Page, value: string): Promise<void> {
  await page.getByTestId('dialog-input').fill(value);
  await page.getByTestId('dialog-confirm').click();
}

test.describe('Sidebar actions', () => {
  test('adds a database with its first collection', async ({ app, page }) => {
    await connectStaging(app, page);

    await menu(page, connectionRow(page), 'Add Database');
    await answerPrompt(page, 'inventory');
    const created = await callFrom(app, 'create_collection', () => answerPrompt(page, 'items'));
    expect(created).toMatchObject({ database: 'inventory', collection: 'items' });
    await expect(databaseRow(page, 'inventory')).toBeVisible();
  });

  test('adds, renames and drops a collection', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');

    await menu(page, databaseRow(page, 'sales_db'), 'Add Collection');
    const created = await callFrom(app, 'create_collection', () => answerPrompt(page, 'archive'));
    expect(created).toMatchObject({ database: 'sales_db', collection: 'archive' });
    await dismissHoverCards(page);
    const archive = sidebar(page).getByText('archive', { exact: true });
    await expect(archive).toBeVisible();

    await menu(page, archive, 'Rename Collection');
    const renamed = await callFrom(app, 'rename_collection', () => answerPrompt(page, 'archive_2024'));
    expect(renamed).toMatchObject({ database: 'sales_db', from: 'archive', to: 'archive_2024' });
    await dismissHoverCards(page);
    const archive2024 = sidebar(page).getByText('archive_2024', { exact: true });
    await expect(archive2024).toBeVisible();

    await menu(page, archive2024, 'Drop Collection');
    const dropped = await callFrom(app, 'drop_collection', () => page.getByTestId('dialog-confirm').click());
    expect(dropped).toMatchObject({ database: 'sales_db', collection: 'archive_2024' });
    await expect(archive2024).toHaveCount(0);
  });

  test('renames and drops a database', async ({ app, page }) => {
    await connectStaging(app, page);

    await menu(page, databaseRow(page, 'user_analytics'), 'Rename Database');
    await answerPrompt(page, 'analytics');
    // Renaming copies the database, so it asks again before dropping the source.
    const renamed = await callFrom(app, 'rename_database', () => page.getByTestId('dialog-confirm').click());
    expect(renamed).toMatchObject({ from: 'user_analytics', to: 'analytics', dropSource: true });
    await expect(databaseRow(page, 'analytics')).toBeVisible();

    await dismissHoverCards(page);
    await menu(page, databaseRow(page, 'analytics'), 'Drop Database');
    const dropped = await callFrom(app, 'drop_database', () => page.getByTestId('dialog-confirm').click());
    expect(dropped).toMatchObject({ database: 'analytics' });
    await expect(databaseRow(page, 'analytics')).toHaveCount(0);
  });

  test('a confirm-destructive connection asks for the name before dropping', async ({ app, page }) => {
    await connectStaging(app, page, { connection_mode: 'confirm_destructive' });
    await expandCollections(page, 'sales_db');

    await menu(page, sidebar(page).getByText('products', { exact: true }), 'Drop Collection');
    await answerPrompt(page, 'nope');
    await expect(page.getByTestId('dialog-error')).toHaveText('Name does not match');
    const dropped = await callFrom(app, 'drop_collection', () => answerPrompt(page, 'products'));
    expect(dropped).toMatchObject({ collection: 'products', confirmed: true });
  });

  test('a read-only connection refuses to drop', async ({ app, page }) => {
    await connectStaging(app, page, { connection_mode: 'read_only' });
    await expandCollections(page, 'sales_db');

    await menu(page, sidebar(page).getByText('products', { exact: true }), 'Drop Collection');
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'read-only' })).toBeVisible();
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    expect(await app.calls('drop_collection')).toHaveLength(0);
  });

  test('pins a collection and unpins it', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');

    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByTestId('ctx-pin-conn-1-sales_db-customers').click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'Pinned to sidebar' })).toBeVisible();
    const pinned = sidebar(page).getByTestId('pinned-item-coll::Staging::sales_db::customers');
    await expect(pinned).toBeVisible();

    await dismissHoverCards(page);
    await pinned.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
    await expect(pinned).toHaveCount(0);
  });

  test('adds a collection to favorites', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');

    await menu(page, sidebar(page).getByText('customers', { exact: true }), 'Add to favorites');
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'Added to favorites' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('mqlens_favorites'))).toContain('customers');
  });

  test('searches the tree and clears the search', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await dismissHoverCards(page);

    await sidebar(page).getByTestId('sidebar-search').fill('trans');
    await expect(sidebar(page).getByText('transactions', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('customers', { exact: true })).toHaveCount(0);

    await sidebar(page).getByRole('button', { name: 'Clear search' }).click();
    await expect(sidebar(page).getByText('customers', { exact: true })).toBeVisible();
  });

  test('refreshes the databases and disconnects', async ({ app, page }) => {
    await connectStaging(app, page);

    await connectionRow(page).hover();
    await callFrom(app, 'list_databases', () => sidebar(page).getByRole('button', { name: 'Refresh databases' }).click());
    await dismissHoverCards(page);

    await connectionRow(page).hover();
    await callFrom(app, 'disconnect_db', () => sidebar(page).getByRole('button', { name: 'Disconnect' }).click());
    await expect(connectionRow(page)).toHaveCount(0);
  });
});
