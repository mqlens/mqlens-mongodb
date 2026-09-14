import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { callFrom } from '../helpers';

/** Quick Start → Connection Manager. */
async function openManager(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'New...', exact: true })).toBeVisible();
}

/** Pick an option from the Radix select currently showing `current`. */
async function chooseIn(page: Page, current: string, option: string): Promise<void> {
  await page.getByRole('combobox').filter({ hasText: current }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const editorTab = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('Connection editor', () => {
  test('saves authentication, TLS and SSH settings with the profile', async ({ app, page }) => {
    await app.open({ dialog: { open: '/certs/staging-ca.pem' } });
    await openManager(page);
    await page.getByRole('button', { name: 'New...', exact: true }).click();
    await page.getByLabel('Display Name').fill('Staging (secured)');
    await page.getByTestId('host-list').fill('staging.example:27017');

    await editorTab(page, 'Authentication').click();
    await chooseIn(page, 'None (Guest Access)', 'SCRAM-SHA-256 (Default)');
    await page.getByPlaceholder('admin').nth(0).fill('reporter');
    await page.getByPlaceholder('admin').nth(1).fill('reports');
    await page.getByPlaceholder('••••••••').fill('hunter2');

    await editorTab(page, 'TLS / SSL').click();
    await chooseIn(page, 'Off (Insecure Plaintext)', 'Custom CA File Upload');
    await page.getByTestId('ca-file-browse').click();
    await expect(page.getByPlaceholder('/path/to/ca.pem')).toHaveValue('/certs/staging-ca.pem');
    await page.getByLabel('Allow invalid hostnames').check();

    await editorTab(page, 'SSH Tunnel').click();
    await page.getByLabel('Enable SSH Tunnel Proxy Gateway').check();
    await page.getByPlaceholder('ssh.server.com').fill('bastion.example');
    await page.getByPlaceholder('deploy').fill('deploy');
    await page.getByTestId('ssh-auth-select').click();
    await page.getByRole('option', { name: 'SSH Agent', exact: true }).click();
    await expect(page.getByTestId('ssh-agent-note')).toBeVisible();

    const saved = await callFrom(app, 'save_connection_profile', () =>
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    );
    const profile = saved.profile as { name: string; uri: string };
    expect(profile.name).toBe('Staging (secured)');
    expect(profile.uri).toContain('reporter:hunter2@staging.example:27017');
    expect(profile.uri).toContain('authSource=reports');
    expect(profile.uri).toContain('authMechanism=SCRAM-SHA-256');
    expect(profile.uri).toContain('tls=true');
    expect(profile.uri).toContain(`tlsCAFile=${encodeURIComponent('/certs/staging-ca.pem')}`);
    expect(JSON.stringify(profile)).toContain('bastion.example');
  });

  test('imports several pasted URIs as saved profiles', async ({ app, page }) => {
    await app.open();
    await openManager(page);

    // The import menu sits in the editor, next to Test Connection.
    await page.getByRole('button', { name: 'New...', exact: true }).click();
    await page.getByTestId('import-uri-btn').click();
    await page.getByTestId('import-paste-manually').click();
    await page.getByTestId('dialog-input').fill('# Production\nmongodb://prod.example:27017\n\n# Development\nmongodb://dev.example:27017');
    await page.getByTestId('dialog-confirm').click();
    // Several URIs: confirm creating a profile for each.
    await page.getByTestId('dialog-confirm').click();

    await expect.poll(async () => (await app.calls('save_connection_profile')).length).toBe(2);
    const names = (await app.calls('save_connection_profile')).map((call) => (call.args as { profile: { name: string } }).profile.name);
    expect(names).toEqual(['Production', 'Development']);
  });

  test('imports a URI from a file into a new connection', async ({ app, page }) => {
    await app.open({ dialog: { open: '/exports/reporting.txt' }, files: { '/exports/reporting.txt': 'mongodb://reporting.example:27018/sales_db' } });
    await openManager(page);

    // The import menu sits in the editor, next to Test Connection.
    await page.getByRole('button', { name: 'New...', exact: true }).click();
    await page.getByTestId('import-uri-btn').click();
    await page.getByTestId('import-from-file').click();
    await expect(page.getByRole('heading', { name: 'New Connection' })).toBeVisible();
    await expect(page.getByTestId('host-list')).toHaveValue(/reporting\.example:27018/);
  });

  test('exports every saved URI, with passwords only when asked', async ({ app, page }) => {
    await app.open({
      profiles: [{ id: 'p-reporting', name: 'Reporting', uri: 'mongodb://reporter:hunter2@reporting.example:27017/?authSource=admin' }],
    });
    await openManager(page);

    await page.getByTestId('export-all-uris-btn').click();
    const dialog = page.getByTestId('export-uri-dialog');
    const preview = dialog.getByTestId('export-uri-preview');
    await expect(preview).toContainText('reporting.example:27017');
    await expect(preview).not.toContainText('hunter2');

    await dialog.getByTestId('export-include-password').click();
    await expect(preview).toContainText('hunter2');
  });
});
