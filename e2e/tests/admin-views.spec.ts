import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, dismissHoverCards, expandCollections, loadSample } from '../helpers';

const STAGING_URI = 'mongodb://staging.example:27017';
const sidebar = (page: Page) => page.getByRole('complementary');

const written = (page: Page, path: string) =>
  page.evaluate((file) => window.__MQLENS_E2E__!.state.writtenFiles[file] ?? null, path);

/** Pick an option from a Radix select, which lists its options in a portal. */
async function choose(page: Page, trigger: ReturnType<Page['getByTestId']>, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

test.describe('User management', () => {
  test.beforeEach(async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await page.getByRole('button', { name: 'Connection Sample (mqlens_demo)' }).click({ button: 'right' });
    await page.getByTestId('ctx-users').click();
    await dismissHoverCards(page);
  });

  test('lists users and creates one with a role', async ({ app, page }) => {
    const users = page.getByTestId('user-management-view');
    await expect(users.getByTestId('user-row-admin.admin')).toBeVisible();
    await expect(users.getByTestId('user-row-sales_db.app_user')).toBeVisible();

    await users.getByTestId('create-user-btn').click();
    const editor = page.getByTestId('user-editor-modal');
    await editor.getByTestId('user-name-input').fill('reporter');
    await editor.getByTestId('user-password-input').fill('s3cret-pass');
    await choose(page, editor.getByTestId('user-authdb-input'), 'sales_db');
    await editor.getByTestId('add-role-btn').click();
    await choose(page, editor.getByTestId('role-select-0'), /^read$/);

    const created = await callFrom(app, 'create_user', () => editor.getByTestId('save-user-btn').click());
    expect(created).toMatchObject({ database: 'sales_db', username: 'reporter', password: 's3cret-pass' });
    expect((created.roles as Array<{ role: string }>)[0].role).toBe('read');
    await expect(editor).toHaveCount(0);
    await expect(users.getByTestId('user-row-sales_db.reporter')).toBeVisible();
  });

  test('grants a role to an existing user', async ({ app, page }) => {
    const users = page.getByTestId('user-management-view');
    await users.getByTestId('user-row-sales_db.analyst').dblclick();
    const editor = page.getByTestId('user-editor-modal');
    await expect(editor).toContainText('analyst');

    await editor.getByTestId('add-role-btn').click();
    await choose(page, editor.getByTestId('role-select-1'), /^dbAdmin$/);
    const updated = await callFrom(app, 'update_user', () => editor.getByTestId('save-user-btn').click());
    expect(updated).toMatchObject({ database: 'sales_db', username: 'analyst' });
    expect((updated.roles as Array<{ role: string }>).map((role) => role.role)).toEqual(['read', 'dbAdmin']);
  });

  test('drops a user once confirmed', async ({ app, page }) => {
    const users = page.getByTestId('user-management-view');
    await users.getByTestId('user-row-sales_db.analyst').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Drop User' }).click();
    const dropped = await callFrom(app, 'drop_user', () => page.getByTestId('dialog-confirm').click());
    expect(dropped).toMatchObject({ database: 'sales_db', username: 'analyst' });
    await expect(users.getByTestId('user-row-sales_db.analyst')).toHaveCount(0);
  });
});

test.describe('GridFS', () => {
  test('lists, downloads, uploads and deletes files in a bucket', async ({ app, page }) => {
    await app.open({
      gridfs: { 'sales_db.fs': [{ filename: 'invoice-001.pdf', content: 'PDF-1.7 fake invoice', contentType: 'application/pdf' }] },
      files: { '/uploads/report.csv': 'region,total\nnorth,10' },
      dialog: { open: '/uploads/report.csv', save: '/downloads/invoice-001.pdf' },
    });
    await loadSample(page);
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByTestId('ctx-add-gridfs-bucket-conn-1-sales_db').click();
    // The bucket name defaults to fs.
    await page.getByTestId('dialog-confirm').click();
    await dismissHoverCards(page);

    const gridfs = page.getByTestId('gridfs-view');
    const row = (name: string) => gridfs.locator('tbody tr').filter({ hasText: name });
    await expect(row('invoice-001.pdf')).toBeVisible();

    await row('invoice-001.pdf').getByTestId('gridfs-download-btn').click();
    await expect.poll(() => written(page, '/downloads/invoice-001.pdf')).toBe('PDF-1.7 fake invoice');

    await gridfs.getByTestId('gridfs-upload-btn').click();
    // The stored name defaults to the file's; then no metadata.
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-choice-skip').click();
    await expect(row('report.csv')).toBeVisible();

    await row('invoice-001.pdf').getByTestId('gridfs-delete-btn').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(row('invoice-001.pdf')).toHaveCount(0);
    await expect(row('report.csv')).toBeVisible();
  });
});

test.describe('Watch', () => {
  /** Hand a change event to every open stream, as the server would. */
  const pushChange = (page: Page, change: Record<string, unknown>) =>
    page.evaluate((event) => {
      for (const stream of Object.values(window.__MQLENS_E2E__!.state.changeStreams)) {
        stream.lastSeq += 1;
        stream.events.push({ ...event, seq: stream.lastSeq, atMs: Date.now() });
      }
    }, change);

  test('shows changes as they arrive, opens one, filters, pauses and clears', async ({ app, page }) => {
    // Watching needs a real server: the menu item is hidden for the mock connection.
    await app.open({
      profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI }],
      servers: { [STAGING_URI]: SAMPLE_SERVER },
    });
    await page.getByTestId('conn-card-p-staging').click();
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByTestId('ctx-watch-collection').click();
    await dismissHoverCards(page);

    await expect(page.getByTestId('watch-status')).toHaveText('live');
    await pushChange(page, {
      operationType: 'insert',
      database: 'sales_db',
      collection: 'customers',
      documentKey: { _id: { $oid: '65a000000000000000000001' } },
      fullDocument: { _id: { $oid: '65a000000000000000000001' }, name: 'Dana White', tier: 'Standard' },
    });
    await pushChange(page, {
      operationType: 'delete',
      database: 'sales_db',
      collection: 'customers',
      documentKey: { _id: { $oid: '603d779f4f102e3a105c3121' } },
    });
    const events = page.getByTestId('watch-event');
    await expect(events).toHaveCount(2);
    await expect(page.getByTestId('watch-count')).toContainText('2');

    await events.filter({ hasText: 'insert' }).click();
    // The detail renders in two places; one of them shows the inserted document.
    await expect(page.getByTestId('watch-detail').filter({ hasText: 'Dana White' }).first()).toBeVisible();

    const restarted = await callFrom(app, 'start_change_stream', () => page.getByTestId('watch-filter-insert').click());
    expect(restarted.operationTypes).toEqual(['insert']);

    // The toggle follows the stream's status as the next poll reports it.
    const status = page.getByTestId('watch-status');
    await callFrom(app, 'pause_change_stream', () => page.getByTestId('watch-toggle').click());
    await expect(status).not.toHaveText('live');
    await callFrom(app, 'resume_change_stream', () => page.getByTestId('watch-toggle').click());
    await expect(status).toHaveText('live');

    await page.getByTestId('watch-clear').click();
    await expect(events).toHaveCount(0);
  });
});
