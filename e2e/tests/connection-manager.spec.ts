import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, view } from '../helpers';

const STAGING_URI = 'mongodb://staging.example:27017';
const STAGING = { id: 'p-staging', name: 'Staging', uri: STAGING_URI };

/** Quick Start → Connection Manager. */
async function openManager(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'New...', exact: true })).toBeVisible();
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('Connection Manager', () => {
  test('imports a JSON connections file with folders', async ({ app, page }) => {
    const file = '/exports/connections.json';
    const connections = {
      folders: [
        {
          name: 'Prod',
          connections: [
            { connectionName: 'Prod primary', connectionString: 'mongodb://prod-a.example:27017' },
            { connectionName: 'Prod reporting', uri: 'mongodb://prod-b.example:27017' },
          ],
        },
      ],
      connections: ['mongodb://dev.example:27017', { name: 'Not MongoDB', uri: 'https://example.com' }],
      items: [{ title: 'Staging', url: 'mongodb://staging.example:27017' }],
    };
    await app.open({ dialog: { open: file }, files: { [file]: JSON.stringify(connections) } });
    await openManager(page);
    await button(page, 'New...').click();

    await page.getByTestId('import-uri-btn').click();
    await page.getByTestId('import-from-file').click();
    await page.getByTestId('dialog-confirm').click();

    await expect.poll(async () => (await app.calls('save_connection_profile')).length).toBe(4);
    const saved = (await app.calls('save_connection_profile')).map((call) => (call.args as { profile: { name: string; uri: string } }).profile);
    expect(saved.map((profile) => profile.name)).toEqual(['Prod primary', 'Prod reporting', 'dev.example', 'Staging']);
  });

  test('edits, duplicates and deletes a saved profile', async ({ app, page }) => {
    await app.open({
      profiles: [
        {
          id: 'p-analytics',
          name: 'Analytics',
          uri: 'mongodb://reporter:hunter2@analytics.example:27017/sales?authSource=reports&authMechanism=SCRAM-SHA-256&tls=true&tlsCAFile=%2Fcerts%2Fca.pem',
        },
      ],
    });
    await openManager(page);

    await button(page, 'Edit').click();
    await expect(page.getByRole('heading', { name: 'Edit Connection' })).toBeVisible();
    await expect(page.getByLabel('Display Name')).toHaveValue('Analytics');
    await page.getByLabel('Display Name').fill('Analytics EU');
    const edited = await callFrom(app, 'save_connection_profile', () => button(page, 'Save').click());
    expect(edited.profile).toMatchObject({ id: 'p-analytics', name: 'Analytics EU' });
    expect((edited.profile as { uri: string }).uri).toContain('authSource=reports');

    await button(page, 'Duplicate').click();
    await expect(page.getByRole('heading', { name: 'Duplicate Connection' })).toBeVisible();
    const duplicated = await callFrom(app, 'save_connection_profile', () => button(page, 'Save').click());
    expect((duplicated.profile as { id: string }).id).not.toBe('p-analytics');

    await button(page, 'Delete').click();
    await expect(page.getByTestId('dialog-title')).toHaveText('Delete connection profile');
    await callFrom(app, 'delete_connection_profile', () => page.getByTestId('dialog-confirm').click());
  });

  test('New Folder requires a unique name', async ({ app, page }) => {
    await app.open();
    await openManager(page);

    await button(page, 'New Folder').click();
    const name = page.getByTestId('new-folder-name-input');
    await button(page, 'Create').click();
    await expect(page.getByText('Folder name is required')).toBeVisible();

    await name.fill('Local resources');
    await button(page, 'Create').click();
    await expect(page.getByText('A folder with this name already exists')).toBeVisible();

    await name.fill('Production');
    await name.press('Enter');
    await expect(name).toHaveCount(0);
    await expect(page.getByText('Production', { exact: true }).first()).toBeVisible();
  });

  test('connects a saved profile from its details', async ({ app, page }) => {
    await app.open({ profiles: [STAGING], servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await openManager(page);

    const connected = await callFrom(app, 'connect_db', () => button(page, 'Connect').click());
    expect(connected).toMatchObject({ uri: STAGING_URI });
    await expect(page.getByRole('button', { name: 'Connection Staging' })).toBeVisible();
  });

  test('Test Connection explains why a server cannot be reached', async ({ app, page }) => {
    await app.open({ servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await openManager(page);
    await button(page, 'New...').click();
    await page.getByLabel('Display Name').fill('Staging');
    await page.getByTestId('host-list').fill('staging.example:27017');

    for (const failure of ['authentication failed', 'connection refused', 'server selection timeout', 'invalid peer certificate']) {
      await app.failNext('test_connection_uri', failure);
      await button(page, 'Test Connection').click();
      await expect(page.getByTestId('test-result-summary')).toBeVisible();
      await page.getByTestId('test-dismiss').click();
      await expect(page.getByTestId('test-result-summary')).toHaveCount(0);
    }
  });
});

test.describe('Pinned and favorite items', () => {
  test('open their saved connection, and say when there is none', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'mqlens_pinned_collections',
        JSON.stringify([
          { kind: 'collection', connectionName: 'Staging', db: 'sales_db', collection: 'customers' },
          // A pin from before pins had kinds.
          { connectionName: 'Ghost', db: 'gone', collection: 'away' },
        ]),
      );
      localStorage.setItem(
        'mqlens_favorites',
        JSON.stringify([{ kind: 'collection', connectionName: 'Staging', db: 'sales_db', collection: 'products' }]),
      );
    });
    await app.open({ profiles: [STAGING], servers: { [STAGING_URI]: SAMPLE_SERVER } });
    const sidebar = page.getByRole('complementary').first();
    // Both sections start collapsed.
    await sidebar.getByRole('button', { name: 'Pinned', exact: true }).click();
    await sidebar.getByRole('button', { name: 'Favorites', exact: true }).click();

    await sidebar.getByTestId('pinned-item-coll::Ghost::gone::away').click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'Ghost' })).toBeVisible();
    expect(await app.calls('connect_db')).toHaveLength(0);

    // Favorites come after the connection tree, which lists products too once connected.
    const favorite = sidebar.getByText('products', { exact: true }).last();
    await favorite.click();
    await expect(page.getByRole('button', { name: 'Connection Staging' })).toBeVisible();
    await expect(view(page)).toContainText('SuperBook Pro');
    await favorite.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove from favorites' }).click();
    expect(await page.evaluate(() => localStorage.getItem('mqlens_favorites'))).toBe('[]');

    await sidebar.getByTestId('pinned-item-coll::Staging::sales_db::customers').click();
    await expect(view(page)).toContainText('Alice Smith');
  });
});
