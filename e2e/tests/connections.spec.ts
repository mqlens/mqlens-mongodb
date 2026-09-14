import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';

const STAGING_URI = 'mongodb://staging.example:27017';

/** Quick Start → Connection Manager → a blank connection editor. */
async function openNewConnectionEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await page.getByRole('button', { name: 'New...', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Connection' })).toBeVisible();
}

async function describeServer(page: Page, name: string, hosts: string): Promise<void> {
  await page.getByLabel('Display Name').fill(name);
  await page.getByTestId('host-list').fill(hosts);
}

test.describe('Connections', () => {
  test('saves a new connection profile', async ({ app, page }) => {
    await app.open();
    await openNewConnectionEditor(page);
    await describeServer(page, 'Staging', 'staging.example:27017');

    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => app.calls('save_connection_profile')).toHaveLength(1);
    const [save] = await app.calls('save_connection_profile');
    const profile = (save.args as { profile: { name: string; uri: string } }).profile;
    expect(profile.name).toBe('Staging');
    expect(profile.uri).toContain('staging.example:27017');
    await expect(page.getByText('Staging').first()).toBeVisible();
  });

  test('connects before saving, then saves from the offer', async ({ app, page }) => {
    await app.open({ servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await openNewConnectionEditor(page);
    await describeServer(page, 'Staging', 'staging.example:27017');

    await page.getByTestId('editor-connect-btn').click();
    await expect(page.getByTestId('connect-save-offer')).toBeVisible();
    await page.getByTestId('connect-save-btn').click();

    await expect(page.getByRole('button', { name: 'Connection Staging' })).toBeVisible();
    expect(await app.calls('connect_db')).toHaveLength(1);
    expect(await app.calls('save_connection_profile')).toHaveLength(1);
  });

  test('shows the error when the server cannot be reached', async ({ app, page }) => {
    await app.open();
    await openNewConnectionEditor(page);
    await describeServer(page, 'Nowhere', 'nowhere.example:27017');

    await page.getByTestId('editor-connect-btn').click();

    await expect(page.getByTestId('connect-error')).toBeVisible();
    expect(await app.calls('set_connection_meta')).toHaveLength(0);
  });

  test('Test Connection reports a reachable server', async ({ app, page }) => {
    await app.open({ servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await openNewConnectionEditor(page);
    await describeServer(page, 'Staging', 'staging.example:27017');

    await page.getByRole('button', { name: 'Test Connection', exact: true }).click();

    await expect(page.getByTestId('test-result-summary')).toBeVisible();
    expect(await app.calls('test_connection_uri')).toHaveLength(1);
    expect(await app.calls('connect_db')).toHaveLength(0);
  });

  test('a saved connection on Quick Start opens it', async ({ app, page }) => {
    await app.open({
      profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI }],
      servers: { [STAGING_URI]: SAMPLE_SERVER },
    });

    await page.getByTestId('conn-card-p-staging').click();

    await expect(page.getByRole('button', { name: 'Connection Staging' })).toBeVisible();
    const connects = await app.calls('connect_db');
    expect(connects).toHaveLength(1);
    expect(connects[0].args).toMatchObject({ uri: STAGING_URI });
  });
});
