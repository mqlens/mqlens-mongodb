import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import {
  connectStaging,
  dismissHoverCards,
  expandCollections,
  loadSample,
  openCollection,
  setEditorText,
  STAGING_URI,
} from '../helpers';

/** The id the fake backend gives the first connection. */
const CONN = 'conn-1';

const sidebar = (page: Page) => page.getByRole('complementary');
const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');
const tasks = (page: Page) => page.getByTestId('tasks-view');

/** What the app wrote to `path`, as the fake backend recorded it. */
const written = (page: Page, path: string) =>
  page.evaluate((file) => window.__MQLENS_E2E__!.state.writtenFiles[file] ?? null, path);

const docCount = (page: Page, uri: string, db: string, coll: string) =>
  page.evaluate(
    ([server, database, collection]) =>
      window.__MQLENS_E2E__!.state.servers[server].databases[database]?.[collection]?.docs.length ?? 0,
    [uri, db, coll] as const,
  );

async function lastArgs(app: App, cmd: string): Promise<Record<string, unknown>> {
  await expect.poll(async () => (await app.calls(cmd)).length, `a ${cmd} call`).toBeGreaterThan(0);
  return (await app.calls(cmd)).at(-1)!.args as Record<string, unknown>;
}

async function connectionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId(item).click();
  await dismissHoverCards(page);
}

test.describe('Export and import', () => {
  test('exports current results, then a filtered query, with a preview and a field scan', async ({ app, page }) => {
    await app.open({ dialog: { save: '/tmp/premium.json' } });
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(view(page)).not.toContainText('Bob Johnson');

    await view(page).getByTestId('export-btn').click();
    const exporter = page.getByTestId('export-view');

    await exporter.getByTestId('export-current-btn').click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: '/tmp/premium.json' })).toBeVisible();
    expect(JSON.parse((await written(page, '/tmp/premium.json')) ?? 'null')).toHaveLength(2);

    await exporter.getByTestId('export-filtered-count-btn').click();
    await expect(exporter.getByTestId('export-filtered-count')).toContainText('2');

    await exporter.getByTestId('export-scan-fields-btn').click();
    await expect(exporter.getByTestId('export-field-email')).toBeVisible();

    await exporter.getByTestId('export-format-csv').click();
    await exporter.getByTestId('export-preview-btn').click();
    await expect(exporter.getByTestId('export-preview-output')).toContainText('Alice Smith');
    await expect(exporter.getByTestId('export-preview-output')).not.toContainText('Bob Johnson');

    await exporter.getByTestId('export-filtered-btn').click();
    await expect(tasks(page).getByTestId('task-row').first()).toContainText('Export sales_db.customers');
    expect(await lastArgs(app, 'start_filtered_export')).toMatchObject({
      database: 'sales_db',
      collection: 'customers',
      format: 'csv',
      filter: '{"tier":"Premium"}',
      path: '/tmp/premium.json',
    });
    expect(await written(page, '/tmp/premium.json')).toContain('Charlie Brown');
  });

  test('exports a whole collection as a background task', async ({ app, page }) => {
    await app.open({ dialog: { save: '/tmp/products.full.json' } });
    await loadSample(page);
    await openCollection(page, 'sales_db', 'products');
    await view(page).getByTestId('export-btn').click();

    await page.getByTestId('export-view').getByTestId('export-full-btn').click();
    const row = tasks(page).getByTestId('task-row').first();
    await expect(row).toContainText('Export sales_db.products as JSON');
    await expect(row).toContainText('Export complete');
    expect(JSON.parse((await written(page, '/tmp/products.full.json')) ?? 'null')).toHaveLength(3);
  });

  // Imports run on a saved connection: on the sample server the backend counts the rows and writes none.
  test('imports a file, updating documents that already exist', async ({ app, page }) => {
    const file = '/data/customers-update.json';
    await connectStaging(app, page, {
      dialog: { open: file },
      files: {
        [file]: JSON.stringify([
          { _id: { $oid: '603d779f4f102e3a105c3120' }, name: 'Alice Smith', tier: 'Gold' },
          { name: 'Dana White', tier: 'Standard' },
        ]),
      },
    });
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('import-btn').click();
    const importer = page.getByTestId('import-view');

    await importer.getByTestId('import-pick-file-btn').click();
    await expect(importer.getByTestId('import-file-path')).toContainText(file);
    await expect(importer.getByTestId('import-preview-docs')).toContainText('Dana White');

    await importer.getByTestId('import-mode-update').click();
    await importer.getByTestId('import-run-btn').click();
    const row = tasks(page).getByTestId('task-row').first();
    await expect(row).toContainText('customers-update.json');
    await expect(row).toContainText('Import complete: 1 inserted, 1 updated, 0 skipped');
    expect(await docCount(page, STAGING_URI, 'sales_db', 'customers')).toBe(4);
    expect(await lastArgs(app, 'start_import_task')).toMatchObject({ mode: 'update', format: 'json', source: { path: file } });
  });

  test('imports pasted CSV', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('import-btn').click();
    const importer = page.getByTestId('import-view');

    await importer.getByTestId('import-source-paste').click();
    await importer.getByTestId('import-format-select').selectOption('csv');
    // A quoted field keeps the delimiter and a doubled quote inside it, and a
    // cell in an untyped column that reads as JSON imports as that value.
    await importer
      .getByTestId('import-paste-textarea')
      .fill('name,tier,visits,vip,note\nEve Adams,Standard,7,true,"likes, commas"\nFrank Hill,Premium,12,false,"says ""hi"""');
    await expect(importer.getByTestId('import-preview-grid')).toContainText('Frank Hill');
    await expect(importer.getByTestId('import-preview-grid')).toContainText('likes, commas');

    await importer.getByTestId('import-run-btn').click();
    await expect(tasks(page).getByTestId('task-row').first()).toContainText('Import complete: 2 inserted, 0 updated, 0 skipped');
    expect(await docCount(page, STAGING_URI, 'sales_db', 'customers')).toBe(5);
    const imported = await page.evaluate(
      (uri) =>
        window.__MQLENS_E2E__!.state.servers[uri].databases.sales_db.customers.docs
          .filter((doc) => 'note' in doc)
          .map(({ visits, vip, note }) => ({ visits, vip, note })),
      STAGING_URI,
    );
    expect(imported).toEqual([
      { visits: 7, vip: true, note: 'likes, commas' },
      { visits: 12, vip: false, note: 'says "hi"' },
    ]);
  });
});

// Dump, Restore and Watch are hidden for the sample connection, and the backend refuses the tools there.
test.describe('mongodump and mongorestore', () => {
  test('dumps the server to a folder, then restores from it', async ({ app, page }) => {
    await connectStaging(app, page, { dialog: { open: '/backups/staging' } });

    await connectionMenu(page, `ctx-dump-${CONN}`);
    await expect(page.getByText(/mongodump 100\.10\.0/)).toBeVisible();
    await page.getByTestId('dump-target-folder').click();
    await page.getByTestId('dump-pick-dest-btn').click();
    await expect(page.getByTestId('dump-dest-path')).toContainText('/backups/staging');
    // gzip starts on; a table scan starts off.
    await page.getByTestId('dump-opt-forcetablescan').click();
    await expect(page.getByTestId('dump-preview-cmd')).toContainText('--out=/backups/staging');
    await expect(page.getByTestId('dump-preview-cmd')).toContainText('--forceTableScan');

    await page.getByTestId('dump-run-btn').click();
    await expect(tasks(page).getByTestId('task-row').first()).toContainText('Dump server');
    expect((await lastArgs(app, 'start_dump_task')).options).toMatchObject({
      scope: { kind: 'server' },
      target: { kind: 'folder', out: '/backups/staging' },
      gzip: true,
      forceTableScan: true,
    });

    await connectionMenu(page, `ctx-restore-${CONN}`);
    await expect(page.getByTestId('restore-tools-status')).toContainText('mongorestore 100.10.0');
    await page.getByTestId('restore-source-folder').click();
    await page.getByTestId('restore-pick-source-btn').click();
    await expect(page.getByTestId('restore-tree-coll-sales_db.customers')).toBeVisible();

    await page.getByTestId('restore-run-btn').click();
    await expect(tasks(page).getByTestId('task-row').first()).toContainText('Restore staging');
    // Every collection is checked, which the app sends as no selection: restore everything.
    expect((await lastArgs(app, 'start_restore_task')).options).toMatchObject({
      source: { kind: 'folder', dir: '/backups/staging' },
      selections: [],
    });
  });

  test('says when mongodump and mongorestore are missing', async ({ app, page }) => {
    await connectStaging(app, page, { mongoTools: { mongodump: null, mongorestore: null } });

    await connectionMenu(page, `ctx-dump-${CONN}`);
    await expect(page.getByTestId('dump-tools-missing')).toBeVisible();

    await connectionMenu(page, `ctx-restore-${CONN}`);
    await expect(page.getByTestId('restore-tools-missing')).toBeVisible();
  });
});

test.describe('Copy to', () => {
  test('copies a collection under a new name', async ({ app, page }) => {
    // On a saved connection: a copy involving the sample server is simulated and writes nothing.
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('products', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy to…' }).click();
    await dismissHoverCards(page);

    const start = page.getByRole('button', { name: 'Start copy' });
    await page.locator('#target-collection').fill('products_archive');
    await expect(start).toBeEnabled();
    await start.click();

    await expect(tasks(page).getByTestId('task-row').first()).toContainText('Copy sales_db.products → sales_db.products_archive');
    expect(await docCount(page, STAGING_URI, 'sales_db', 'products_archive')).toBe(3);
    expect(await lastArgs(app, 'start_collection_copy')).toMatchObject({
      sourceCollection: 'products',
      targetCollection: 'products_archive',
      conflictMode: 'merge',
    });
  });
});

test.describe('Tasks and activity', () => {
  test('clears finished tasks', async ({ app, page }) => {
    await app.open({ dialog: { save: '/tmp/products.full.json' } });
    await loadSample(page);
    await openCollection(page, 'sales_db', 'products');
    await view(page).getByTestId('export-btn').click();
    await page.getByTestId('export-view').getByTestId('export-full-btn').click();
    await expect(tasks(page).getByTestId('task-row')).toHaveCount(1);

    await tasks(page).getByRole('button', { name: 'Clear finished tasks' }).click();
    await expect(tasks(page).getByTestId('task-empty')).toBeVisible();
  });

  const EVENTS = [
    {
      id: 'e1',
      ts: 1_747_000_000_000,
      connectionId: CONN,
      profileName: 'Staging',
      database: 'sales_db',
      collection: 'customers',
      op: 'delete_document',
      source: 'ui',
      ok: true,
      error: null,
      durationMs: 4,
      summary: 'deleted 1 document',
      argsJson: null,
      levelAtRecord: 'A',
      schemaVersion: 1,
    },
    {
      id: 'e2',
      ts: 1_747_000_060_000,
      connectionId: CONN,
      profileName: 'Staging',
      database: 'sales_db',
      collection: 'products',
      op: 'update_many',
      source: 'ui',
      ok: false,
      error: 'not authorized on sales_db',
      durationMs: 9,
      summary: 'update 12 documents',
      argsJson: null,
      levelAtRecord: 'A',
      schemaVersion: 1,
    },
  ];

  test('lists, filters, opens and exports the activity log', async ({ app, page }) => {
    await app.open({ audit: { events: EVENTS }, dialog: { save: '/tmp/audit.jsonl' } });
    await page.getByTestId('status-bar-activity').click();
    const panel = page.getByTestId('activity-panel');

    await expect(panel.getByTestId('activity-row-e1')).toContainText('deleted 1 document');
    await expect(panel.getByTestId('activity-row-e2')).toContainText('sales_db.products');

    await panel.getByTestId('activity-filter-summary').fill('deleted');
    await expect(panel.getByTestId('activity-row-e2')).toHaveCount(0);
    await panel.getByTestId('activity-filter-summary').fill('');

    await panel.getByTestId('activity-row-e2').click();
    await expect(panel.getByTestId('activity-detail-e2')).toContainText('not authorized on sales_db');

    // Export asks to confirm, then reports the count, both as browser dialogs.
    page.on('dialog', (dialog) => void dialog.accept());
    await panel.getByTestId('activity-export-btn').click();
    await expect.poll(() => written(page, '/tmp/audit.jsonl')).not.toBeNull();
    expect(((await written(page, '/tmp/audit.jsonl')) ?? '').split('\n')).toHaveLength(2);
  });

  test('offers to discard a damaged activity log', async ({ app, page }) => {
    await app.open({ audit: { status: { integrityError: 'checksum mismatch at record 7' }, events: EVENTS } });
    await page.getByTestId('status-bar-activity').click();
    const panel = page.getByTestId('activity-panel');

    await expect(panel.getByTestId('activity-integrity-banner')).toBeVisible();
    page.on('dialog', (dialog) => void dialog.accept());
    await panel.getByTestId('activity-discard-btn').click();
    await expect.poll(async () => (await app.calls('audit_discard_damaged_log')).length).toBe(1);
  });
});
