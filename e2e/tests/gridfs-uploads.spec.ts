import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { connectStaging, dismissHoverCards, view } from '../helpers';

// Putting files into a GridFS bucket and taking them out again (#396): the
// metadata a file can carry, and every way an upload or a download can fail.

const sidebar = (page: Page) => page.getByRole('complementary');
const gridfs = (page: Page) => page.getByTestId('gridfs-view');
const row = (page: Page, name: string) => gridfs(page).locator('tbody tr').filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });
const written = (page: Page, path: string) =>
  page.evaluate((file) => window.__MQLENS_E2E__!.state.writtenFiles[file] ?? null, path);

/** Open the fs bucket of sales_db, on a connection seeded from `seed`. */
async function openBucket(app: App, page: Page, seed: Seed): Promise<void> {
  await connectStaging(app, page, { gridfs: { 'sales_db.fs': [{ filename: 'invoice-001.pdf', content: 'PDF-1.7 fake invoice' }] }, ...seed });
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByTestId('ctx-add-gridfs-bucket-conn-1-sales_db').click();
  // The bucket name defaults to fs.
  await page.getByTestId('dialog-confirm').click();
  await dismissHoverCards(page);
  await expect(row(page, 'invoice-001.pdf')).toBeVisible();
}

test.describe('Uploading to a bucket', () => {
  test('stores metadata with the file, and refuses what is not a JSON object', async ({ app, page }) => {
    await openBucket(app, page, {
      files: { '/uploads/report.csv': 'region,total\nnorth,10' },
      dialog: { open: '/uploads/report.csv' },
    });

    await gridfs(page).getByTestId('gridfs-upload-btn').click();
    // The stored name defaults to the file's own.
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-choice-add').click();

    await page.getByTestId('dialog-input').fill('[1]');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toContainText('Metadata must be a JSON object');
    await page.getByTestId('dialog-input').fill('{ "team": ');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toContainText('Invalid JSON');

    await page.getByTestId('dialog-input').fill('{ "team": "north" }');
    await page.getByTestId('dialog-confirm').click();
    await expect(row(page, 'report.csv')).toBeVisible();
    const upload = (await app.calls('upload_gridfs_file'))[0].args as { metadataJson: string; filename: string };
    expect(upload.filename).toBe('report.csv');
    expect(JSON.parse(upload.metadataJson)).toEqual({ team: 'north' });
  });

  test('a filename the user cancels uploads nothing; cancelled metadata uploads without any', async ({ app, page }) => {
    await openBucket(app, page, {
      files: { '/uploads/report.csv': 'region,total\nnorth,10' },
      dialog: { open: '/uploads/report.csv' },
    });

    await gridfs(page).getByTestId('gridfs-upload-btn').click();
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('upload_gridfs_file')).toHaveLength(0);

    await gridfs(page).getByTestId('gridfs-upload-btn').click();
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-choice-add').click();
    await page.getByTestId('dialog-cancel').click();

    await expect(row(page, 'report.csv')).toBeVisible();
    expect((await app.calls('upload_gridfs_file'))[0].args).toMatchObject({ metadataJson: null });
  });

  test('says which files of a batch could not be uploaded', async ({ app, page }) => {
    await openBucket(app, page, { dialog: { open: ['/uploads/missing-a.csv', '/uploads/missing-b.csv'] } });

    await gridfs(page).getByTestId('gridfs-upload-btn').click();
    // One filename prompt per file, then metadata once for the batch.
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-choice-skip').click();

    await expect(toast(page, 'Upload failed for missing-a.csv')).toBeVisible();
    await expect(toast(page, '2 files failed to upload.')).toBeVisible();
    await expect(row(page, 'missing-a.csv')).toHaveCount(0);
  });

  test('choosing no file uploads nothing, and a picker that fails says so', async ({ app, page }) => {
    await openBucket(app, page, { dialog: { open: [] } });

    await gridfs(page).getByTestId('gridfs-upload-btn').click();
    await expect(page.getByTestId('dialog-title')).toHaveCount(0);

    await page.evaluate(() => {
      window.__MQLENS_E2E__!.state.dialog.open = null;
    });
    await gridfs(page).getByTestId('gridfs-upload-btn').click();
    await expect(page.getByTestId('dialog-title')).toHaveCount(0);

    await app.failNext('plugin:dialog|open', 'the file picker is unavailable');
    await gridfs(page).getByTestId('gridfs-upload-btn').click();
    await expect(toast(page, 'Upload failed: the file picker is unavailable')).toBeVisible();
    expect(await app.calls('upload_gridfs_file')).toHaveLength(0);
  });
});

test.describe('Taking files out of a bucket', () => {
  test('a cancelled save writes nothing, and a failed download says why', async ({ app, page }) => {
    await openBucket(app, page, { dialog: { save: null } });

    await row(page, 'invoice-001.pdf').getByTestId('gridfs-download-btn').click();
    expect(await app.calls('download_gridfs_file')).toHaveLength(0);

    await page.evaluate(() => {
      window.__MQLENS_E2E__!.state.dialog.save = '/downloads/invoice-001.pdf';
    });
    await app.failNext('download_gridfs_file', 'chunk 3 is missing');
    await row(page, 'invoice-001.pdf').getByTestId('gridfs-download-btn').click();
    await expect(toast(page, 'Download failed: chunk 3 is missing')).toBeVisible();
    expect(await written(page, '/downloads/invoice-001.pdf')).toBeNull();
  });

  test('a cancelled or failed delete keeps the file', async ({ app, page }) => {
    await openBucket(app, page, {});

    await row(page, 'invoice-001.pdf').getByTestId('gridfs-delete-btn').click();
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('delete_gridfs_file')).toHaveLength(0);

    await app.failNext('delete_gridfs_file', 'not authorized to remove from fs.files');
    await row(page, 'invoice-001.pdf').getByTestId('gridfs-delete-btn').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'not authorized to remove from fs.files')).toBeVisible();
    await expect(row(page, 'invoice-001.pdf')).toBeVisible();
  });

  test('says why a bucket could not be listed', async ({ app, page }) => {
    await connectStaging(app, page, { gridfs: { 'sales_db.fs': [{ filename: 'invoice-001.pdf', content: 'PDF' }] } });
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByTestId('ctx-add-gridfs-bucket-conn-1-sales_db').click();
    await app.failNext('list_gridfs_files', 'not authorized on sales_db to list fs.files');
    await page.getByTestId('dialog-confirm').click();
    await dismissHoverCards(page);

    await expect(view(page)).toContainText('not authorized on sales_db to list fs.files');
    await expect(gridfs(page)).toHaveCount(0);
  });
});
