import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, type Seed } from '../harness/seed';
import {
  STAGING_URI,
  connectStaging,
  dismissHoverCards,
  expandCollections,
  loadSample,
  openCollection,
  setEditorText,
  view,
} from '../helpers';

// What the app shows when a backend command fails (#396): the failure is made
// with `app.failNext`, and each test checks the user is told, in the words the
// backend used.

const CONN = 'conn-1';
const sidebar = (page: Page) => page.getByRole('complementary');
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });
const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });

async function openCustomers(app: App, page: Page, seed: Seed = {}): Promise<void> {
  await connectStaging(app, page, seed);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
}

async function connectionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId(item).click();
  await dismissHoverCards(page);
}

test.describe('Connecting', () => {
  test('says when the sample data cannot be loaded', async ({ app, page }) => {
    await app.open();
    await app.failNext('connect_db', 'Server selection timed out');
    await page.getByTestId('qs-load-sample').click();
    await expect(toast(page, 'Server selection timed out')).toBeVisible();
    await expect(toast(page, 'Could not load sample data')).toBeVisible();
  });

  test('says when a saved connection cannot be opened from Quick Start', async ({ app, page }) => {
    await app.open({ profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI }], servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await app.failNext('connect_db', 'Authentication failed');
    await page.getByTestId('conn-card-p-staging').click();
    await expect(toast(page, 'Could not connect to Staging')).toBeVisible();
  });
});

test.describe('Queries', () => {
  test('shows why a collection could not load', async ({ app, page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await app.failNext('execute_mql_query', 'cursor id 42 not found');
    await sidebar(page).getByText('customers', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page).getByText('cursor id 42 not found').first()).toBeVisible();
    if (browserName === 'chromium') {
      await view(page).getByTitle('Copy error message').click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('cursor id 42 not found');
    }
  });

  test('shows why a query, its count or a pipeline failed', async ({ app, page }) => {
    await openCustomers(app, page);
    const filter = view(page).getByTestId('query-filter-input');

    await app.failNext('count_documents', 'count timed out');
    await setEditorText(page, filter, '{ tier: "Premium" }');
    await runButton(page).click();
    await expect(view(page).getByText('Charlie Brown').first()).toBeVisible();

    await app.failNext('execute_mql_query', 'hint provided does not correspond to an existing index');
    await runButton(page).click();
    await expect(view(page).getByText('hint provided does not correspond to an existing index').first()).toBeVisible();

    await view(page).getByTestId('mode-aggregate-tab').click();
    await setEditorText(page, view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0'), '{ tier: "Premium" }');
    await app.failNext('execute_aggregate', 'PlanExecutor error during aggregation');
    await runButton(page).click();
    await expect(view(page).getByText('PlanExecutor error during aggregation').first()).toBeVisible();
  });
});

test.describe('Writes', () => {
  test('reports a document, many documents or an update it could not write', async ({ app, page }) => {
    await openCustomers(app, page);

    await app.failNext('delete_document', 'document is locked');
    await view(page).getByTestId('delete-doc-btn').first().click();
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'Failed to delete document: document is locked')).toBeVisible();

    await app.failNext('delete_many', 'not authorized to remove');
    await view(page).getByTestId('bulk-write-menu-btn').click();
    await view(page).getByTestId('delete-many-btn').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'not authorized to remove')).toBeVisible();

    await view(page).getByTestId('bulk-write-menu-btn').click();
    await view(page).getByTestId('update-many-btn').click();
    await page.getByTestId('dialog-input').fill('[]');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toContainText('Update must be a JSON object');
    await page.getByTestId('dialog-input').fill('{ "tier": "Gold" }');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toContainText('Update must use operators like $set');
    await page.getByTestId('dialog-input').fill('{ "$set": { "tier": "Gold" } }');
    await page.getByTestId('dialog-confirm').click();
    await app.failNext('update_many', 'write conflict');
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'write conflict')).toBeVisible();
  });

  test('keeps the document editor open when a save fails', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('insert-doc-btn').click();
    const modal = page.getByTestId('document-edit-modal');
    await setEditorText(page, modal, '{ "name": "Dana White" }');
    await app.failNext('insert_document', 'E11000 duplicate key error');
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toContainText('E11000 duplicate key error');
  });

  test('will not edit or delete a document shown without its _id', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('projection-query-input'), '{ _id: 0 }');
    await runButton(page).click();
    await expect(view(page)).not.toContainText('603d779f4f102e3a105c3120');

    await view(page).getByTestId('delete-doc-btn').first().click();
    await expect(page.getByText('this document has no _id').first()).toBeVisible();
    expect(await app.calls('delete_document')).toHaveLength(0);
  });

  test('reports an index it could not delete', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('email_1', { exact: true }).click();
    await dismissHoverCards(page);

    await app.failNext('delete_index', 'index is in use by a running query');
    await view(page).getByTestId('delete-index-btn').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'Failed to delete index: index is in use by a running query')).toBeVisible();
  });
});

test.describe('Background tasks', () => {
  const dumpFolder = { dbs: [{ name: 'sales_db', collections: [{ name: 'customers', hasMetadata: true, gzip: false }] }] };

  test('reports a dump or a restore that could not start', async ({ app, page }) => {
    await connectStaging(app, page, { dialog: { open: '/backups/staging' }, dumpFolders: { '/backups/staging': dumpFolder } });

    await connectionMenu(page, `ctx-dump-${CONN}`);
    await page.getByTestId('dump-target-folder').click();
    await page.getByTestId('dump-pick-dest-btn').click();
    await expect(page.getByTestId('dump-dest-path')).toContainText('/backups/staging');
    await app.failNext('start_dump_task', 'mongodump exited with code 1');
    await page.getByTestId('dump-run-btn').click();
    await expect(toast(page, 'Dump failed to start: mongodump exited with code 1')).toBeVisible();

    await connectionMenu(page, `ctx-restore-${CONN}`);
    await page.getByTestId('restore-source-folder').click();
    await page.getByTestId('restore-pick-source-btn').click();
    await expect(page.getByTestId('restore-tree-coll-sales_db.customers')).toBeVisible();
    await app.failNext('start_restore_task', 'mongorestore exited with code 1');
    await page.getByTestId('restore-run-btn').click();
    await expect(toast(page, 'Restore failed to start: mongorestore exited with code 1')).toBeVisible();
  });

  test('offers to install the tools when they cannot be detected', async ({ app, page }) => {
    await connectStaging(app, page);
    await app.failNext('detect_mongo_tools', 'permission denied');
    await connectionMenu(page, `ctx-dump-${CONN}`);
    await expect(page.getByTestId('dump-install-tools-btn')).toBeVisible();
  });

  test('reports generated data that could not start', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Generate Data…' }).click();
    await dismissHoverCards(page);
    const generator = page.getByTestId('generate-view');
    await expect(generator.getByTestId('generate-preview-doc')).toHaveCount(3);

    await generator.getByTestId('generate-run-btn').click();
    await app.failNext('start_generate_task', 'insufficient disk space');
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'Generate failed to start: insufficient disk space')).toBeVisible();
  });

  test('reports an import that could not start, and an export that could not be written', async ({ app, page }) => {
    const file = '/data/more-customers.json';
    await openCustomers(app, page, { dialog: { open: file, save: '/tmp/customers.json' }, files: { [file]: JSON.stringify([{ name: 'Dana White' }]) } });

    await view(page).getByTestId('import-btn').click();
    const importer = page.getByTestId('import-view');
    await importer.getByTestId('import-pick-file-btn').click();
    await expect(importer.getByTestId('import-preview-docs')).toContainText('Dana White');
    await app.failNext('start_import_task', 'target is a view');
    await importer.getByTestId('import-run-btn').click();
    await expect(toast(page, 'Import failed to start: target is a view')).toBeVisible();

    await page.getByTestId('workspace-tab-strip').getByText('customers').first().click();
    await view(page).getByTestId('export-btn').click();
    await app.failNext('format_current_docs', 'could not serialize a value');
    await page.getByTestId('export-view').getByTestId('export-current-btn').click();
    await expect(toast(page, 'Export failed: could not serialize a value')).toBeVisible();
  });
});
