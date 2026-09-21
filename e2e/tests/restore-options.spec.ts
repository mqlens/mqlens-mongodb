import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { connectStaging, dismissHoverCards } from '../helpers';

// Setting up a restore (#396): the flags mongorestore is given, the narrowing
// that rules oplog replay out, and what a drop says it will replace.

const DUMP = {
  dbs: [
    {
      name: 'sales_db',
      collections: [
        { name: 'customers', hasMetadata: true, gzip: false },
        { name: 'products', hasMetadata: true, gzip: false },
      ],
    },
  ],
};

const FLAGS = [
  'restore-opt-keepindexversion',
  'restore-opt-noindexrestore',
  'restore-opt-nooptionsrestore',
  'restore-opt-maintaininsertionorder',
  'restore-opt-stoponerror',
  'restore-opt-bypassvalidation',
  'restore-opt-usersroles',
];

/** Open Restore on the saved connection, with the dialogs seeded from `seed`. */
async function openRestore(app: App, page: Page, seed: Seed): Promise<void> {
  await connectStaging(app, page, seed);
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId('ctx-restore-conn-1').click();
  await dismissHoverCards(page);
}

/** Open Restore on a folder holding `DUMP`. */
async function openFolderRestore(app: App, page: Page): Promise<void> {
  await openRestore(app, page, { dialog: { open: '/backups/staging' }, dumpFolders: { '/backups/staging': DUMP } });
  await page.getByTestId('restore-source-folder').click();
  await page.getByTestId('restore-pick-source-btn').click();
  await expect(page.getByTestId('restore-tree-db-sales_db')).toBeVisible();
}

test.describe('Restore options', () => {
  test('sends every option the run was set up with', async ({ app, page }) => {
    await openFolderRestore(app, page);
    await expect(page.getByTestId('restore-preview-cmd')).toContainText('mongorestore');

    for (const flag of FLAGS) await page.getByTestId(flag).check();
    await page.getByTestId('restore-opt-gzip').check();
    await page.getByTestId('restore-run-btn').click();

    await expect.poll(async () => (await app.calls('start_restore_task')).length).toBe(1);
    const { options } = (await app.calls('start_restore_task'))[0].args as { options: Record<string, unknown> };
    expect(options).toMatchObject({
      source: { kind: 'folder', dir: '/backups/staging' },
      gzip: true,
      drop: false,
      keepIndexVersion: true,
      noIndexRestore: true,
      noOptionsRestore: true,
      maintainInsertionOrder: true,
      stopOnError: true,
      bypassDocumentValidation: true,
      restoreDbUsersAndRoles: true,
      oplogReplay: false,
    });
    // Everything in the dump, so nothing has to be named.
    expect(options.selections).toEqual([]);
  });

  test('narrowing the restore rules out replaying the oplog', async ({ app, page }) => {
    await openFolderRestore(app, page);

    const oplog = page.getByTestId('restore-opt-oplogreplay');
    await oplog.check();
    await expect(oplog).toBeChecked();

    // A restore of part of a dump cannot replay an oplog that covers all of it.
    await page.getByTestId('restore-tree-coll-sales_db.customers').click();
    await expect(oplog).toBeDisabled();
    await expect(oplog).not.toBeChecked();

    // Nothing at all cannot be restored either.
    await page.getByTestId('restore-tree-coll-sales_db.products').click();
    await expect(page.getByTestId('restore-empty-selection-hint')).toBeVisible();
    await expect(page.getByTestId('restore-run-btn')).toBeDisabled();

    // Back to the whole dump, and the oplog is on offer again.
    await page.getByTestId('restore-tree-coll-sales_db.customers').click();
    await page.getByTestId('restore-tree-coll-sales_db.products').click();
    await expect(oplog).toBeEnabled();
  });

  test('a drop with no filter says it replaces the whole archive, and can be called off', async ({ app, page }) => {
    await openRestore(app, page, { dialog: { open: '/backups/staging.archive' } });
    await page.getByTestId('restore-source-archive').click();
    await page.getByTestId('restore-pick-source-btn').click();
    await expect(page.getByTestId('restore-source-path')).toContainText('/backups/staging.archive');
    // Only a .gz archive turns gzip on by itself.
    await expect(page.getByTestId('restore-opt-gzip')).not.toBeChecked();

    await page.getByTestId('restore-opt-drop').check();
    await page.getByTestId('restore-run-btn').click();
    await expect(page.getByTestId('restore-drop-confirm')).toContainText('(entire archive)');

    await page.getByTestId('restore-drop-confirm').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('restore-drop-confirm')).toHaveCount(0);
    expect(await app.calls('start_restore_task')).toHaveLength(0);
  });

  test('a picker the user closes leaves the restore where it was', async ({ app, page }) => {
    await openRestore(app, page, { dialog: { open: null } });

    await page.getByTestId('restore-source-archive').click();
    await page.getByTestId('restore-pick-source-btn').click();
    await expect(page.getByTestId('restore-source-path')).toHaveCount(0);
    await expect(page.getByTestId('restore-run-btn')).toBeDisabled();

    await page.getByTestId('restore-source-folder').click();
    await page.getByTestId('restore-pick-source-btn').click();
    await expect(page.getByTestId('restore-tree')).toHaveCount(0);
    await expect(page.getByTestId('restore-browse-error')).toHaveCount(0);
  });
});
