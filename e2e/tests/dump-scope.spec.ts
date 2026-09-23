import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { connectStaging, dismissHoverCards } from '../helpers';

// What a dump covers (#396): the scope it is taken at, the options that only
// make sense at one of them, and where it is written.

async function openDump(app: App, page: Page, seed: Seed = {}): Promise<void> {
  await connectStaging(app, page, seed);
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId('ctx-dump-conn-1').click();
  await dismissHoverCards(page);
  await expect(page.getByTestId('dump-view')).toBeVisible();
}

test.describe('The scope of a dump', () => {
  test('drops the options that belong to the scope it leaves', async ({ app, page }) => {
    await openDump(app, page);
    const preview = page.getByTestId('dump-preview-cmd');

    // A whole server can carry the oplog with it.
    await page.getByTestId('dump-opt-oplog').check();
    await expect(preview).toContainText('--oplog');

    // One database can carry its users and roles instead.
    await page.getByTestId('dump-scope-db').click();
    await page.getByTestId('dump-db-select').selectOption('sales_db');
    await expect(page.getByTestId('dump-opt-oplog')).not.toBeChecked();
    await page.getByTestId('dump-opt-usersroles').check();
    await expect(preview).toContainText('--dumpDbUsersAndRoles');

    // Back to the whole server, and the database's own option goes with it.
    await page.getByTestId('dump-scope-server').click();
    await expect(page.getByTestId('dump-opt-usersroles')).not.toBeChecked();
    await expect(preview).not.toContainText('--dumpDbUsersAndRoles');
  });

  test('names the archive after what it holds, and writes it where it is told', async ({ app, page }) => {
    await openDump(app, page, { dialog: { save: '/backups/staging.archive', open: '/backups' } });

    // A whole-server dump is named after the connection.
    await page.getByTestId('dump-target-archive').click();
    await page.getByTestId('dump-pick-dest-btn').click();
    expect(JSON.stringify((await app.calls('plugin:dialog|save')).at(-1)!.args)).toContain('Staging.archive.gz');

    // Without gzip the name loses its .gz, and the command says so.
    await page.getByTestId('dump-opt-gzip').uncheck();
    await expect(page.getByTestId('dump-preview-cmd')).not.toContainText('--gzip');
    await page.getByTestId('dump-pick-dest-btn').click();
    const asked = JSON.stringify((await app.calls('plugin:dialog|save')).at(-1)!.args);
    expect(asked).toContain('Staging.archive');
    expect(asked).not.toContain('.archive.gz');

    // A folder is the other place a dump can go.
    await page.getByTestId('dump-target-folder').click();
    await page.getByTestId('dump-pick-dest-btn').click();
    await expect(page.getByTestId('dump-dest-path')).toContainText('/backups');
    await page.getByTestId('dump-run-btn').click();
    await expect.poll(async () => (await app.calls('start_dump_task')).length).toBe(1);
    expect((await app.calls('start_dump_task'))[0].args).toMatchObject({
      options: { target: { kind: 'folder', out: '/backups' }, gzip: false, oplog: false },
    });
  });

  test('a server with nothing on it still has a name to write', async ({ app, page }) => {
    await openDump(app, page, {
      servers: { 'mongodb://staging.example:27017': { version: '7.0.5', databases: {} } },
    });

    await page.getByTestId('dump-scope-db').click();
    // No database to pick, so the scope has no name of its own.
    await expect(page.getByTestId('dump-db-select')).toBeVisible();
    await expect(page.getByTestId('dump-run-btn')).toBeDisabled();
  });
});
