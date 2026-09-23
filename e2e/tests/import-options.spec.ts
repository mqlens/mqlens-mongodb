import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { connectStaging, openCollection, view } from '../helpers';

// Reading a file into a collection (#396): the CSV options the reader is
// given, the format taken from the file's name, and previews that fail.

const importer = (page: Page) => page.getByTestId('import-view');

/** Open Import on sales_db.customers, seeded from `seed`. */
async function openImport(app: App, page: Page, seed: Seed = {}): Promise<Locator> {
  await connectStaging(app, page, seed);
  await openCollection(page, 'sales_db', 'customers');
  await view(page).getByTestId('import-btn').click();
  await expect(importer(page)).toBeVisible();
  return importer(page);
}

/** Paste `text` as CSV. */
async function pasteCsv(imp: Locator, text: string): Promise<void> {
  await imp.getByTestId('import-source-paste').click();
  await imp.getByTestId('import-format-select').selectOption('csv');
  await imp.getByTestId('import-paste-textarea').fill(text);
}

test.describe('Reading a CSV', () => {
  test('reads it the way the options say, and types a column by hand', async ({ app, page }) => {
    const imp = await openImport(app, page);
    await pasteCsv(imp, "# exported by hand\nname'tier'visits\nEve Adams'Standard'7");

    // A delimiter of its own, and a first line that is not part of the data.
    await imp.getByTestId('import-csv-delimiter').selectOption('custom');
    await imp.getByTestId('import-csv-delimiter-custom').fill("'");
    await imp.getByTestId('import-csv-skiplines').fill('1');
    const grid = imp.getByTestId('import-preview-grid');
    await expect(grid).toContainText('Eve Adams');

    // A number kept as the text it was written as.
    await imp.getByTestId('import-coltype-visits').selectOption('string');
    await imp.getByTestId('import-run-btn').click();

    await expect.poll(async () => (await app.calls('start_import_task')).length).toBe(1);
    const args = (await app.calls('start_import_task'))[0].args as { csvOptions: Record<string, unknown> };
    expect(args.csvOptions).toMatchObject({
      delimiter: "'",
      quote: '"',
      skipLines: 1,
      hasHeaders: true,
      columnTypes: { visits: 'string' },
    });
  });

  test('a CSV with no header row names its columns by position', async ({ app, page }) => {
    const imp = await openImport(app, page);
    await pasteCsv(imp, 'Eve Adams,Standard\nFrank Hill,Premium');
    await expect(imp.getByTestId('import-preview-grid')).toContainText('Eve Adams');

    await imp.getByTestId('import-csv-headers').uncheck();
    const grid = imp.getByTestId('import-preview-grid');
    await expect(grid).toContainText('field1');
    await expect(grid).toContainText('field2');
    // The line that was the header is a row of its own now.
    await expect(grid.locator('tbody tr')).toHaveCount(2);
  });

  test('refuses a delimiter or a text qualifier that is not one ASCII character', async ({ app, page }) => {
    const imp = await openImport(app, page);
    await pasteCsv(imp, 'name,tier\nEve Adams,Standard');
    await expect(imp.getByTestId('import-preview-grid')).toBeVisible();

    await imp.getByTestId('import-csv-delimiter').selectOption('custom');
    await imp.getByTestId('import-csv-delimiter-custom').fill('||');
    await expect(imp).toContainText('Delimiter must be a single ASCII character');
    await expect(imp.getByTestId('import-run-btn')).toBeDisabled();

    await imp.getByTestId('import-csv-delimiter-custom').fill('|');
    await imp.getByTestId('import-csv-quote').fill('“');
    await expect(imp).toContainText('Quote must be a single ASCII character');
    await expect(imp.getByTestId('import-run-btn')).toBeDisabled();

    await imp.getByTestId('import-csv-quote').fill('"');
    await expect(imp.getByTestId('import-run-btn')).toBeEnabled();
    expect(await app.calls('start_import_task')).toHaveLength(0);
  });
});

test.describe('The file to read', () => {
  test('takes its format from the file name, and a closed picker changes nothing', async ({ app, page }) => {
    const imp = await openImport(app, page, {
      files: {
        '/data/rows.csv': 'name,tier\nEve Adams,Standard',
        '/data/docs.ndjson': '{"name":"Frank Hill"}',
      },
      dialog: { open: '/data/rows.csv' },
    });

    await imp.getByTestId('import-pick-file-btn').click();
    await expect(imp.getByTestId('import-file-path')).toContainText('/data/rows.csv');
    await expect(imp.getByTestId('import-format-select')).toHaveValue('csv');

    await page.evaluate(() => {
      window.__MQLENS_E2E__!.state.dialog.open = '/data/docs.ndjson';
    });
    await imp.getByTestId('import-pick-file-btn').click();
    await expect(imp.getByTestId('import-format-select')).toHaveValue('ndjson');
    await expect(imp.getByTestId('import-preview-docs')).toContainText('Frank Hill');

    // Nothing chosen leaves the file that was chosen before.
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.state.dialog.open = null;
    });
    await imp.getByTestId('import-pick-file-btn').click();
    await expect(imp.getByTestId('import-file-path')).toContainText('/data/docs.ndjson');
  });

  test('says why a preview could not be read', async ({ app, page }) => {
    const imp = await openImport(app, page);

    // Text that is not what the format says it is.
    await imp.getByTestId('import-source-paste').click();
    await imp.getByTestId('import-paste-textarea').fill('{ "name": "Eve" ');
    await expect(imp.getByTestId('import-preview-error')).toContainText('Invalid JSON');
    await expect(imp.getByTestId('import-run-btn')).toBeDisabled();

    // A reader that fails outright says so in the same place.
    await app.failNext('preview_import', 'the file is no longer there');
    await imp.getByTestId('import-paste-textarea').fill('[{ "name": "Eve" }]');
    await expect(imp.getByTestId('import-preview-error')).toContainText('the file is no longer there');

    // The next keystroke previews again, and an import can be aborted on the first duplicate.
    await imp.getByTestId('import-paste-textarea').fill('[{ "name": "Eve Adams" }]');
    await expect(imp.getByTestId('import-preview-docs')).toContainText('Eve Adams');
    await imp.getByTestId('import-mode-abort').click();
    await imp.getByTestId('import-run-btn').click();
    expect((await app.calls('start_import_task'))[0].args).toMatchObject({ mode: 'abort', format: 'json' });
  });
});
