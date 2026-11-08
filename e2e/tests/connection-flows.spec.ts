import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, type ProfileSeed, type Seed } from '../harness/seed';
import { callFrom, STAGING_URI } from '../helpers';

// The Connection Manager past its everyday flows (#396): connecting a saved
// profile from its editor, imports in every format, saved auth settings read
// back, colour tags, and the profile tree.

const STAGING: ProfileSeed = { id: 'p-staging', name: 'Staging', uri: STAGING_URI };

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const editorTab = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
/** The manager's profile tree. */
const tree = (page: Page) => page.getByRole('dialog').getByRole('complementary');
const importError = (page: Page) => page.getByTestId('import-uri-error').last();
/** Every value typed or loaded into the open dialogs' inputs. */
const inputValues = (page: Page) =>
  page.getByRole('dialog').locator('input').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
/** The profiles the manager saved, leaving out attempts that failed. */
const savedProfiles = async (app: App) =>
  (await app.calls('save_connection_profile')).filter((call) => !call.error).map((call) => (call.args as { profile: Record<string, unknown> }).profile);

/** Quick Start → Connection Manager. */
async function openManager(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await expect(button(page, 'New...')).toBeVisible();
}

async function openWithProfiles(app: App, page: Page, profiles: ProfileSeed[], seed: Seed = {}): Promise<void> {
  await app.open({ profiles, servers: { [STAGING_URI]: SAMPLE_SERVER }, ...seed });
  await openManager(page);
}

async function editProfile(page: Page, name: string): Promise<void> {
  await tree(page).getByText(name, { exact: true }).click();
  await button(page, 'Edit').click();
  await expect(page.getByRole('heading', { name: 'Edit Connection' })).toBeVisible();
}

async function importMenu(page: Page, item: 'import-from-file' | 'import-from-clipboard' | 'import-paste-manually'): Promise<void> {
  await page.getByTestId('import-uri-btn').click();
  await page.getByTestId(item).click();
}

test.describe('Connecting from the editor', () => {
  test('connects an untouched saved profile as itself, and not a second time', async ({ app, page }) => {
    await openWithProfiles(app, page, [STAGING]);
    await editProfile(page, 'Staging');

    const connected = await callFrom(app, 'connect_db', () => page.getByTestId('editor-connect-btn').click());
    expect(connected.uri).toBe(STAGING_URI);
    await expect(page.getByRole('button', { name: 'Connection Staging' })).toBeVisible();
    await expect(page.getByTestId('connect-save-offer')).toHaveCount(0);
    expect(await app.calls('save_connection_profile')).toHaveLength(0);

    await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Manage Connections' }).click();
    // Its Connect button is disabled while it is connected; a double-click on the row still asks.
    await tree(page).getByText('Staging', { exact: true }).dblclick();
    await expect(page.getByRole('dialog').getByText(/already/i).first()).toBeVisible();
    await button(page, 'Edit').click();
    await page.getByTestId('editor-connect-btn').click();
    await expect(page.getByTestId('editor-error')).toContainText(/already/i);
    expect(await app.calls('connect_db')).toHaveLength(1);
  });

  test('releases a connection that lands after the editor was closed', async ({ app, page }) => {
    await openWithProfiles(app, page, [STAGING]);
    await editProfile(page, 'Staging');

    const release = await app.hold('connect_db');
    await page.getByTestId('editor-connect-btn').click();
    await expect.poll(async () => (await app.calls('connect_db')).length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('editor-connect-btn')).toHaveCount(0);

    await release();
    await expect.poll(async () => (await app.calls('disconnect_db')).length).toBe(1);
    await expect(page.getByRole('button', { name: 'Connection Staging' })).toHaveCount(0);
  });

  test('closing the editor over the save offer keeps the connection, unsaved', async ({ app, page }) => {
    await app.open({ servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await openManager(page);
    await button(page, 'New...').click();
    await page.getByLabel('Display Name').fill('Staging');
    await page.getByTestId('host-list').fill('staging.example:27017');

    await page.getByTestId('editor-connect-btn').click();
    await expect(page.getByTestId('connect-save-offer')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('button', { name: 'Connection Staging' })).toBeVisible();
    expect(await app.calls('save_connection_profile')).toHaveLength(0);
  });

  test('names a new connection after its Atlas cluster once it connects', async ({ app, page }) => {
    await app.open({ servers: { 'mongodb://cluster0.ab12c.mongodb.net:27017': SAMPLE_SERVER } });
    await openManager(page);
    await button(page, 'New...').click();
    await page.getByTestId('host-list').fill('cluster0.ab12c.mongodb.net:27017');

    await page.getByTestId('editor-connect-btn').click();
    await expect(page.getByTestId('connect-save-offer')).toBeVisible();
    await expect(page.getByLabel('Display Name')).toHaveValue('cluster0');
  });

  test('a ping that fails marks the test connection as failed', async ({ app, page }) => {
    await app.open();
    await openManager(page);
    await button(page, 'New...').click();
    await page.getByTestId('host-list').fill('nowhere.example:27017');

    await button(page, 'Test Connection').click();
    await expect(page.getByTestId('test-result-summary')).toBeVisible();
    await expect(page.getByTestId('test-result-summary')).not.toHaveText('Connection test successful');
    // Only a failed test offers its error details.
    await expect(page.getByTestId('test-error-details-toggle')).toBeVisible();
    expect(await app.calls('test_connection_uri')).not.toHaveLength(0);
  });
});

test.describe('A connection saved without its password', () => {
  test('asks for it, whatever the encoding of the mechanism name, and connects with what was typed', async ({ app, page }) => {
    await openWithProfiles(app, page, [
      { id: 'p-odd', name: 'Odd', uri: 'mongodb://bob@staging.example:27017/?authMechanism=GSSAPI%' },
      { id: 'p-scram', name: 'Scram', uri: 'mongodb://alice@staging.example:27017/?authMechanism=SCRAM%2DSHA%2D256' },
    ]);

    await tree(page).getByText('Odd', { exact: true }).dblclick();
    await expect(page.getByTestId('dialog-title')).toHaveText('Password for Odd');
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('connect_db')).toHaveLength(0);

    await tree(page).getByText('Scram', { exact: true }).dblclick();
    await expect(page.getByTestId('dialog-title')).toHaveText('Password for Scram');
    await page.getByTestId('dialog-input').fill(' pw ');
    const connected = await callFrom(app, 'connect_db', () => page.getByTestId('dialog-confirm').click());
    expect(connected.uri).toBe('mongodb://alice:%20pw%20@staging.example:27017/?authMechanism=SCRAM%2DSHA%2D256');
  });
});

test.describe('Importing connections', () => {
  test('reads a URI from each kind of file, and says why a file could not be used', async ({ app, page }) => {
    await app.open({
      files: {
        '/imports/workspace.json': JSON.stringify({ workspace: { connections: [{ name: 'Nested', uri: 'mongodb://nested.example:27017' }] } }),
        '/imports/list.json': JSON.stringify(['mongodb://listed.example:27017']),
        '/imports/app.env': '# MONGO_URL=mongodb://env.example:27017',
        '/imports/notes.txt': 'nothing to connect to here',
      },
    });
    await openManager(page);
    await button(page, 'New...').click();
    const importFile = async (path: string) => {
      await page.evaluate((file) => {
        window.__MQLENS_E2E__!.state.dialog.open = file;
      }, path);
      await importMenu(page, 'import-from-file');
    };

    await importFile('/imports/workspace.json');
    await expect(page.getByTestId('host-list')).toHaveValue(/nested\.example/);
    await importFile('/imports/list.json');
    await expect(page.getByTestId('host-list')).toHaveValue(/listed\.example/);
    // A commented-out variable is skipped line by line, and still found as a last resort.
    await importFile('/imports/app.env');
    await expect(page.getByTestId('host-list')).toHaveValue(/env\.example/);

    await importFile('/imports/missing.json');
    await expect(importError(page)).toBeVisible();
    await importFile('/imports/notes.txt');
    await expect(importError(page)).toContainText(/URI found/i);
  });

  test('pasted URIs keep their labels and folder, and a failed save is reported', async ({ app, page }) => {
    await app.open();
    await openManager(page);
    await button(page, 'New...').click();
    const paste = async (text: string) => {
      await importMenu(page, 'import-paste-manually');
      await page.getByTestId('dialog-input').fill(text);
      await page.getByTestId('dialog-confirm').click();
      // Several URIs: confirm a profile for each.
      await page.getByTestId('dialog-confirm').click();
    };
    const pasted = '# folder: Prod\n// Reporting\nmongodb://reporting.example:27017\nmongodb://audit.example:27017';

    await app.failNext('save_connection_profile', 'profile store is read-only');
    await paste(pasted);
    await expect(importError(page)).toContainText('profile store is read-only');

    await paste(pasted);
    await expect.poll(async () => (await savedProfiles(app)).map((profile) => profile.name)).toEqual(['Reporting', 'audit.example']);
    // Both profiles are filed under the Prod folder the paste named.
    const stored = await page.evaluate(() => ({
      folders: JSON.parse(localStorage.getItem('mqlens_folders') ?? '[]') as Array<{ id: string; name: string }>,
      placement: JSON.parse(localStorage.getItem('mqlens_profile_folders') ?? '{}') as Record<string, string>,
    }));
    const prod = stored.folders.find((folder) => folder.name === 'Prod');
    expect(prod).toBeDefined();
    const ids = (await savedProfiles(app)).map((profile) => String(profile.id));
    expect(ids.map((id) => stored.placement[id])).toEqual([prod!.id, prod!.id]);
  });

  test('imports from the clipboard, and says when it holds no URI', async ({ app, page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard permissions are granted in Chromium only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await app.open();
    await openManager(page);
    await button(page, 'New...').click();
    const clip = (text: string) => page.evaluate((value) => navigator.clipboard.writeText(value), text);

    await clip('   ');
    await importMenu(page, 'import-from-clipboard');
    await expect(importError(page)).toBeVisible();

    await clip('see the notes in mongodb://clip.example:27018/app');
    await importMenu(page, 'import-from-clipboard');
    await expect(page.getByTestId('host-list')).toHaveValue(/clip\.example:27018/);

    await clip('no connection here');
    await importMenu(page, 'import-from-clipboard');
    await expect(importError(page)).toContainText(/URI found/i);
  });
});

test.describe('Saved connection settings', () => {
  test('reads TLS, AWS and Kerberos settings back from saved URIs, and saves them the same', async ({ app, page }) => {
    await openWithProfiles(app, page, [
      { id: 'p-tls', name: 'TLS', uri: 'mongodb://reader:secret@tls.example:27017/sales?tls=true' },
      { id: 'p-aws', name: 'AWS', uri: 'mongodb://aws.example:27017/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:tok-123' },
      { id: 'p-krb', name: 'Kerberos', uri: 'mongodb://alice@krb.example:27017/?authMechanism=GSSAPI&authMechanismProperties=SERVICE_NAME:mongosvc' },
      { id: 'p-plain', name: 'Plaintext', uri: 'mongodb://plain.example:27017/?tls=false' },
    ]);
    const save = async () => ((await callFrom(app, 'save_connection_profile', () => button(page, 'Save').click())).profile as { uri: string }).uri;

    await editProfile(page, 'TLS');
    await editorTab(page, 'Authentication').click();
    await expect.poll(() => inputValues(page)).toContain('sales');
    await editorTab(page, 'TLS / SSL').click();
    await expect(page.getByRole('combobox').filter({ hasText: /System/i })).toBeVisible();
    expect(await save()).toContain('tls=true');

    await editProfile(page, 'AWS');
    await editorTab(page, 'Authentication').click();
    await expect.poll(() => inputValues(page)).toContain('tok-123');
    const aws = await save();
    expect(aws).toContain('MONGODB-AWS');
    expect(aws).toMatch(/authSource=(\$|%24)external/);
    expect(decodeURIComponent(aws)).toContain('AWS_SESSION_TOKEN:tok-123');

    await editProfile(page, 'Kerberos');
    await editorTab(page, 'Authentication').click();
    await expect.poll(() => inputValues(page)).toContain('mongosvc');
    expect(decodeURIComponent(await save())).toContain('SERVICE_NAME:mongosvc');

    // An explicit tls=false is kept, so a host whose default is TLS stays plaintext.
    await editProfile(page, 'Plaintext');
    expect(await save()).toContain('tls=false');
  });

  test('tags a connection with a preset or custom colour, and reads short and named tags back', async ({ app, page }) => {
    await openWithProfiles(app, page, [
      { id: 'p-short', name: 'Short hex', uri: 'mongodb://a.example:27017', color_tag: '#abc' },
      { id: 'p-named', name: 'Named', uri: 'mongodb://b.example:27017', color_tag: 'red' },
    ]);
    const colorOf = async () => ((await callFrom(app, 'save_connection_profile', () => button(page, 'Save').click())).profile as { color_tag: string }).color_tag;

    await editProfile(page, 'Short hex');
    await expect(page.getByTestId('color-picker-custom-preview')).toBeVisible();
    expect(await colorOf()).toBe('#aabbcc');

    // A tag that isn't hex shows the picker's default, and is saved back as it was.
    await editProfile(page, 'Named');
    await expect(page.getByTestId('color-picker-custom')).toHaveValue('#3b82f6');
    expect(await colorOf()).toBe('red');

    await button(page, 'New...').click();
    await page.getByLabel('Display Name').fill('Tagged');
    await page.getByTestId('host-list').fill('c.example:27017');
    await page.getByTestId('color-swatch-green').click();
    await expect(page.getByTestId('color-swatch-green')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('color-picker-custom').fill('#123456');
    await expect(page.getByTestId('color-picker-custom-preview')).toBeVisible();
    expect(await colorOf()).toBe('#123456');
  });
});

test.describe('Profile tree', () => {
  test('selects a profile, folds a folder, and filters to profiles outside any folder', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mqlens_folders', JSON.stringify([{ id: 'f-prod', name: 'Prod', parentId: null }]));
      localStorage.setItem('mqlens_profile_folders', JSON.stringify({ 'p-alpha': 'f-prod' }));
    });
    await openWithProfiles(app, page, [
      { id: 'p-alpha', name: 'Alpha', uri: 'mongodb://alpha.example:27017' },
      { id: 'p-beta', name: 'Beta', uri: 'mongodb://beta.example:27017' },
    ]);

    await tree(page).getByText('Beta', { exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('beta.example');

    const alpha = tree(page).getByText('Alpha', { exact: true });
    const shown = await alpha.count();
    await tree(page).getByText('Prod', { exact: true }).click();
    await expect(alpha).toHaveCount(shown > 0 ? 0 : 1);

    await page.getByTestId('folder-filter-select').click();
    await page.getByRole('option', { name: /root/i }).click();
    await expect(tree(page).getByText('Beta', { exact: true })).toBeVisible();
    await expect(tree(page).getByText('Alpha', { exact: true })).toHaveCount(0);
  });

  test('shows an empty list when profiles cannot load, and keeps one that could not be deleted', async ({ app, page }) => {
    await app.open({ profiles: [STAGING], servers: { [STAGING_URI]: SAMPLE_SERVER } });
    // Quick Start lists the saved connections first; the failure is for the manager's own load.
    await expect.poll(async () => (await app.calls('load_connection_profiles')).length).toBeGreaterThan(0);
    await app.failNext('load_connection_profiles', 'vault is locked');
    await openManager(page);
    await expect(tree(page).getByText('Staging', { exact: true })).toHaveCount(0);

    await page.keyboard.press('Escape');
    await openManager(page);
    await expect(tree(page).getByText('Staging', { exact: true })).toBeVisible();
    await app.failNext('delete_connection_profile', 'profile store is read-only');
    await button(page, 'Delete').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(async () => (await app.calls('delete_connection_profile')).length).toBe(1);
    await expect(tree(page).getByText('Staging', { exact: true })).toBeVisible();
  });
});

test.describe('Folders from their menus', () => {
  const storedFolders = (page: Page) =>
    page.evaluate(() => ({
      folders: (JSON.parse(localStorage.getItem('mqlens_folders') ?? '[]') as Array<{ name: string }>).map((folder) => folder.name),
      placement: JSON.parse(localStorage.getItem('mqlens_profile_folders') ?? '{}') as Record<string, string>,
    }));

  test('moves and drags connections into a folder, renames it, and deleting it keeps them', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mqlens_folders', JSON.stringify([{ id: 'f-prod', name: 'Prod', parentId: null }]));
    });
    await openWithProfiles(app, page, [
      { id: 'p-alpha', name: 'Alpha', uri: 'mongodb://alpha.example:27017' },
      { id: 'p-beta', name: 'Beta', uri: 'mongodb://beta.example:27017' },
    ]);

    await tree(page).getByText('Alpha', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to folder' }).hover();
    await page.getByRole('menuitem', { name: 'Prod', exact: true }).click();
    await expect.poll(async () => (await storedFolders(page)).placement).toEqual({ 'p-alpha': 'f-prod' });

    await tree(page).getByText('Beta', { exact: true }).dragTo(tree(page).getByText('Prod', { exact: true }));
    await expect.poll(async () => (await storedFolders(page)).placement).toEqual({ 'p-alpha': 'f-prod', 'p-beta': 'f-prod' });

    // Open the folder to reach Beta inside it.
    await tree(page).getByText('Prod', { exact: true }).click();
    await tree(page).getByText('Beta', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to folder' }).hover();
    await page.getByRole('menuitem', { name: '(root)', exact: true }).click();
    await expect.poll(async () => (await storedFolders(page)).placement).toEqual({ 'p-alpha': 'f-prod' });

    await tree(page).getByText('Prod', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByTestId('dialog-input').fill('Production');
    await page.getByTestId('dialog-input').press('Enter');
    await expect.poll(async () => (await storedFolders(page)).folders).toEqual(['Production']);

    await tree(page).getByText('Production', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(() => storedFolders(page)).toEqual({ folders: [], placement: {} });
    await expect(tree(page).getByText('Alpha', { exact: true })).toBeVisible();
    await expect(tree(page).getByText('Beta', { exact: true })).toBeVisible();
  });
});

test.describe('Connection table sorting', () => {
  test('a header sorts by its column, and a second click reverses it', async ({ app, page }) => {
    await openWithProfiles(app, page, [
      { id: 'p-alpha', name: 'Alpha', uri: 'mongodb://zulu.example:27017' },
      { id: 'p-beta', name: 'Beta', uri: 'mongodb://alpha.example:27017' },
    ]);
    await button(page, 'Table view').click();
    const table = page.getByTestId('connection-table');
    const names = () => table.getByRole('row').evaluateAll((rows) => rows.slice(1).map((row) => row.querySelector('td')?.textContent?.trim()));
    await expect.poll(names).toEqual(['Alpha', 'Beta']);

    await table.getByRole('button', { name: 'Server' }).click();
    await expect.poll(names).toEqual(['Beta', 'Alpha']);
    await table.getByRole('button', { name: 'Server' }).click();
    await expect.poll(names).toEqual(['Alpha', 'Beta']);
  });
});

test.describe('Editor settings added for parity', () => {
  const BASTION = { enabled: true, host: 'bastion.example', port: 2222, user: 'ops', auth: { type: 'key', path: '/keys/ops' } };

  test('saves a client key passphrase, read preference tags, other mechanism properties and a reused tunnel', async ({ app, page }) => {
    await openWithProfiles(app, page, [
      {
        id: 'p-krb',
        name: 'Kerberos',
        uri: 'mongodb://alice@krb.example:27017/?authMechanism=GSSAPI&authMechanismProperties=SERVICE_NAME:mongosvc,CANONICALIZE_HOST_NAME:forward&readPreference=secondary&readPreferenceTags=dc:ny&readPreferenceTags=',
      },
      { id: 'p-bastion', name: 'Bastion', uri: 'mongodb://10.0.0.5:27017', ssh: BASTION },
    ]);
    await editProfile(page, 'Kerberos');

    await editorTab(page, 'TLS / SSL').click();
    await page.getByRole('combobox').filter({ hasText: 'Off (Insecure Plaintext)' }).click();
    await page.getByRole('option', { name: 'System Root CA Certificates' }).click();
    await page.getByLabel(/client certificate/i).fill('/certs/client.pem');
    await page.getByLabel(/key passphrase/i).fill("it's(secret)");

    await editorTab(page, 'SSH Tunnel').click();
    await page.getByLabel(/enable ssh tunnel/i).check();
    await page.getByTestId('ssh-reuse-select').click();
    await page.getByRole('option', { name: /Bastion/ }).click();

    const saved = (await callFrom(app, 'save_connection_profile', () => button(page, 'Save').click())).profile as {
      uri: string;
      ssh: { host: string; port: number; user: string };
    };
    expect(saved.uri).toContain('tlsCertificateKeyFile=%2Fcerts%2Fclient.pem');
    expect(saved.uri).toContain('tlsCertificateKeyFilePassword=it%27s%28secret%29');
    expect(saved.uri).toContain('readPreferenceTags=dc:ny&readPreferenceTags=');
    expect(decodeURIComponent(saved.uri)).toContain('CANONICALIZE_HOST_NAME:forward');
    expect(saved.ssh).toMatchObject({ host: 'bastion.example', port: 2222, user: 'ops' });
  });

  test('says when an SRV record cannot be resolved for a seed list', async ({ app, page }) => {
    await openWithProfiles(app, page, [{ id: 'p-atlas', name: 'Atlas', uri: 'mongodb+srv://cluster0.example.net/app' }]);
    await app.failNext('resolve_srv_seed_list', 'no SRV records');
    await page.getByTestId('export-uri-btn').click();
    await page.getByTestId('export-seed-list').click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not resolve the SRV record: no SRV records' })).toBeVisible();
  });
});
