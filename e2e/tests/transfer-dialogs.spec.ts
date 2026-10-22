import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import {
  connectStaging,
  dismissHoverCards,
  expandCollections,
  getEditorText,
  loadSample,
  openCollection,
  setEditorText,
  view,
} from '../helpers';

/** The id the fake backend gives the first connection. */
const CONN = 'conn-1';
const sidebar = (page: Page) => page.getByRole('complementary');
const tasks = (page: Page) => page.getByTestId('tasks-view');

async function connectionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId(item).click();
  await dismissHoverCards(page);
}

async function lastArgs(app: App, cmd: string): Promise<Record<string, unknown>> {
  await expect.poll(async () => (await app.calls(cmd)).length, `a ${cmd} call`).toBeGreaterThan(0);
  return (await app.calls(cmd)).at(-1)!.args as Record<string, unknown>;
}

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

test.describe('Restore', () => {
  test('says when the chosen folder holds no dump', async ({ app, page }) => {
    await connectStaging(app, page, { dialog: { open: '/backups/nothing-here' } });
    await connectionMenu(page, `ctx-restore-${CONN}`);
    await page.getByTestId('restore-source-folder').click();
    await page.getByTestId('restore-pick-source-btn').click();
    await expect(page.getByTestId('restore-browse-error')).toContainText('Failed to browse dump folder');
    await expect(page.getByTestId('restore-run-btn')).toBeDisabled();
  });

  test('narrows the collections, renames one, and lists what a drop replaces', async ({ app, page }) => {
    await connectStaging(app, page, { dialog: { open: '/backups/staging' }, dumpFolders: { '/backups/staging': DUMP } });
    await connectionMenu(page, `ctx-restore-${CONN}`);
    await page.getByTestId('restore-source-folder').click();
    await app.failNext('preview_restore_command', 'preview unavailable');
    await page.getByTestId('restore-pick-source-btn').click();
    await expect(page.getByTestId('restore-preview-cmd')).toContainText('preview unavailable');

    await page.getByTestId('restore-tree-coll-sales_db.customers').click();
    await page.getByTestId('restore-rename-sales_db.products').fill('products_2024');
    await expect(page.getByTestId('restore-opt-oplogreplay')).toBeDisabled();

    await page.getByTestId('restore-opt-drop').click();
    await page.getByTestId('restore-run-btn').click();
    const confirm = page.getByTestId('restore-drop-confirm');
    await expect(confirm).toContainText('sales_db.products');
    await expect(confirm).not.toContainText('sales_db.customers');
    await page.getByTestId('restore-opt-drop').click();
    await expect(confirm).toHaveCount(0);

    await page.getByTestId('restore-opt-drop').click();
    await page.getByTestId('restore-run-btn').click();
    await page.getByTestId('restore-drop-confirm-btn').click();
    const { options } = await lastArgs(app, 'start_restore_task');
    expect(JSON.stringify(options)).toContain('products_2024');
    expect(options).toMatchObject({ drop: true });
  });

  test('restores a gzipped archive filtered to one database', async ({ app, page }) => {
    await connectStaging(app, page, { dialog: { open: '/backups/staging.archive.gz' } });
    await connectionMenu(page, `ctx-restore-${CONN}`);
    await page.getByTestId('restore-source-archive').click();
    await page.getByTestId('restore-pick-source-btn').click();
    await expect(page.getByTestId('restore-source-path')).toContainText('/backups/staging.archive.gz');
    await expect(page.getByTestId('restore-opt-gzip')).toBeChecked();

    await page.getByTestId('restore-archive-filter-db').fill('sales_db');
    await page.getByTestId('restore-opt-drop').click();
    await page.getByTestId('restore-run-btn').click();
    await expect(page.getByTestId('restore-drop-confirm')).toContainText('sales_db');
    await page.getByTestId('restore-drop-confirm-btn').click();
    expect((await lastArgs(app, 'start_restore_task')).options).toMatchObject({ source: { kind: 'archive' }, gzip: true, drop: true });
  });
});

test.describe('Dump', () => {
  test('picks a database and a collection, names the archive after them, and checks the query', async ({ app, page }) => {
    await connectStaging(app, page, { dialog: { save: '/backups/products.archive.gz' } });
    await connectionMenu(page, `ctx-dump-${CONN}`);

    await page.getByTestId('dump-scope-db').click();
    await page.getByTestId('dump-scope-collection').click();
    await page.getByTestId('dump-db-select').selectOption('sales_db');
    await page.getByTestId('dump-coll-select').selectOption('products');
    await expect(page.getByTestId('dump-preview-cmd')).toContainText('--db=sales_db');
    await expect(page.getByTestId('dump-preview-cmd')).toContainText('--collection=products');

    await page.getByTestId('dump-target-archive').click();
    await page.getByTestId('dump-pick-dest-btn').click();
    await expect(page.getByTestId('dump-dest-path')).toContainText('/backups/products.archive.gz');
    expect(JSON.stringify((await app.calls('plugin:dialog|save')).at(-1)!.args)).toContain('sales_db.products.archive.gz');

    await setEditorText(page, page.getByTestId('dump-query-input'), '{ tier: 1');
    await expect(page.getByTestId('dump-query-error')).toContainText('Not valid JSON');
    await expect(page.getByTestId('dump-run-btn')).toBeDisabled();

    // Let the debounced query preview finish before arming the next failure.
    await expect(page.getByTestId('dump-preview-cmd')).toContainText('--query={ tier: 1');
    await app.failNext('preview_dump_command', 'preview unavailable');
    await page.getByTestId('dump-opt-forcetablescan').click();
    await expect(page.getByTestId('dump-preview-cmd')).toContainText('preview unavailable');
  });
});

test.describe('Copy to', () => {
  test('copies a database into a new one', async ({ app, page }) => {
    await connectStaging(app, page);
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy database to…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Copy database "sales_db"');
    await expect(dialog).toContainText('copy is not allowed');
    await expect(dialog.getByRole('button', { name: 'Start copy' })).toBeDisabled();

    await dialog.locator('#target-database').click();
    await page.getByRole('option', { name: /New database/ }).click();
    await dialog.getByRole('textbox').last().fill('sales_archive');
    await expect(dialog).toContainText('will be created');
    await dialog.getByRole('button', { name: 'Start copy' }).click();
    expect(await lastArgs(app, 'start_database_copy')).toMatchObject({ collections: null, includeViews: true });
    await expect(tasks(page).getByTestId('task-row').first()).toContainText('sales_archive');
  });

  test('copies several collections at once', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    // Ctrl/Cmd-click selects; a plain click would open the collection instead.
    await sidebar(page).getByText('products', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
    await dismissHoverCards(page);
    await sidebar(page).getByText('transactions', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
    await dismissHoverCards(page);
    await sidebar(page).getByText('transactions', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy to…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Copy 2 collections');
    await dialog.locator('#target-database').click();
    await page.getByRole('option', { name: /New database/ }).click();
    await dialog.getByRole('textbox').last().fill('sales_copy');
    await dialog.getByRole('button', { name: 'Start copy' }).click();
    await expect.poll(async () => (await app.calls('start_collection_copy')).length).toBe(2);
    const targets = (await app.calls('start_collection_copy')).map((call) => (call.args as { targetDb: string }).targetDb);
    expect(targets).toEqual(['sales_copy', 'sales_copy']);
  });

  test('asks before overwriting a collection, and only while overwrite is chosen', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy to…' }).click();
    await page.locator('#target-collection').fill('customers');
    await page.locator('input[name="conflictMode"][value="overwrite"]').check();
    const start = page.getByRole('dialog').getByRole('button', { name: 'Start copy' });
    await expect(start).toBeDisabled();
    await page.locator('#overwrite-confirm').check();
    await page.locator('input[name="conflictMode"][value="merge"]').check();
    await expect(page.locator('#overwrite-confirm')).toHaveCount(0);
    await page.locator('input[name="conflictMode"][value="overwrite"]').check();
    await page.locator('#overwrite-confirm').check();
    await start.click();
    expect(await lastArgs(app, 'start_collection_copy')).toMatchObject({ targetCollection: 'customers', conflictMode: 'overwrite' });
  });

  test('takes a database name typed in when the databases cannot be listed', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
    await app.failNext('list_databases', 'not authorized to list databases');
    await page.getByRole('menuitem', { name: 'Copy to…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('input#target-database')).toHaveValue('sales_db');
  });
});

test.describe('Export', () => {
  test('checks the filter it exports, and leaves out a field', async ({ app, page }) => {
    // On a saved connection: the sample server matches filters exactly, so a regex finds nothing to scan.
    await connectStaging(app, page, { dialog: { save: '/tmp/customers.json' } });
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('export-btn').click();
    const exporter = page.getByTestId('export-view');
    const filter = exporter.getByTestId('export-filtered-card').getByTestId('query-filter-input');

    for (const unreadable of ['5', '{ tier: ']) {
      await setEditorText(page, filter, unreadable);
      await expect(exporter.getByTestId('export-filtered-btn')).toBeDisabled();
    }
    await setEditorText(page, filter, '{ tier: /Prem/ }');
    await expect(exporter.getByTestId('export-filtered-btn')).toBeEnabled();

    await app.failNext('sample_export_fields', 'sampling failed');
    await exporter.getByTestId('export-scan-fields-btn').click();
    await expect(exporter.getByTestId('export-field-caption')).toContainText('No documents to scan');

    await exporter.getByTestId('export-scan-fields-btn').click();
    await exporter.getByTestId('export-field-email').click();
    await expect(exporter.getByTestId('export-field-caption')).toContainText('selected');
    await exporter.getByTestId('export-filtered-btn').click();
    const exported = await lastArgs(app, 'start_filtered_export');
    // Sent as Extended JSON, where a shell regex is a $regularExpression.
    expect(JSON.parse(String(exported.filter))).toEqual({ tier: { $regularExpression: { pattern: 'Prem', options: '' } } });
    expect((exported.options as { fields: string[] }).fields).not.toContain('email');
  });

  test('says the count has not run when it failed', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await expandCollections(page, 'sales_db');
    await app.failNext('count_documents', 'count timed out');
    await sidebar(page).getByText('customers', { exact: true }).click();
    await dismissHoverCards(page);
    await view(page).getByTestId('export-btn').click();
    await expect(page.getByTestId('export-view').getByTestId('export-filtered-count')).toContainText('Count not run yet');
  });

  test('exports the pipeline of an aggregate tab, and checks it is a list of stages', async ({ app, page }) => {
    await connectStaging(app, page, { dialog: { save: '/tmp/premium.json' } });
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('mode-aggregate-tab').click();
    await setEditorText(page, view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0'), '{ tier: "Premium" }');
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(view(page)).not.toContainText('Bob Johnson');

    await view(page).getByTestId('export-btn').click();
    const exporter = page.getByTestId('export-view');
    const pipeline = exporter.getByTestId('export-filtered-pipeline-input');
    await expect.poll(() => getEditorText(page, pipeline)).toContain('Premium');

    await setEditorText(page, pipeline, '{ $match: {} }');
    await expect(exporter).toContainText('Pipeline must be an array of stages');
    await setEditorText(page, pipeline, '[{ $match: { tier: "Premium" } }]');
    await exporter.getByTestId('export-filtered-btn').click();
    expect(String((await lastArgs(app, 'start_filtered_export')).pipeline)).toContain('Premium');
  });
});
