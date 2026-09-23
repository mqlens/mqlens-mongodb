import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, openCollection, view } from '../helpers';

// The options an export is written with (#396): the JSON dialect, the shape
// of a CSV or a spreadsheet, and the fields that go into it.

const written = (page: Page, path: string) =>
  page.evaluate((file) => window.__MQLENS_E2E__!.state.writtenFiles[file] ?? null, path);

/** Open Export on sales_db.customers, with somewhere to write it. */
async function openExport(app: App, page: Page, path: string): Promise<Locator> {
  await connectStaging(app, page, { dialog: { save: path } });
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
  await view(page).getByTestId('export-btn').click();
  const exporter = page.getByTestId('export-view');
  await expect(exporter).toBeVisible();
  return exporter;
}

test.describe('Export options', () => {
  test('writes canonical Extended JSON when it is asked to', async ({ app, page }) => {
    const exporter = await openExport(app, page, '/tmp/customers.json');

    await exporter.getByRole('radio', { name: /Canonical/ }).check();
    await exporter.getByTestId('export-current-btn').click();

    await expect.poll(() => written(page, '/tmp/customers.json')).not.toBeNull();
    // Canonical spells an ObjectId out; relaxed would too, but a number would be $numberInt.
    expect(String(await written(page, '/tmp/customers.json'))).toContain('$oid');
    const { options } = (await app.calls('format_current_docs'))[0].args as { options: Record<string, unknown> };
    expect(options).toMatchObject({ jsonMode: 'canonical' });
  });

  test('writes a CSV the way the options say, and refuses a delimiter of two characters', async ({ app, page }) => {
    const exporter = await openExport(app, page, '/tmp/customers.csv');
    await exporter.getByTestId('export-format-csv').click();

    await exporter.getByTestId('export-options-csv-delimiter').selectOption('custom');
    await exporter.getByTestId('export-options-csv-delimiter-custom').fill(';;');
    await expect(exporter.getByTestId('export-current-btn')).toBeDisabled();

    await exporter.getByTestId('export-options-csv-delimiter-custom').fill(';');
    await exporter.getByTestId('export-options-csv-quote').fill("'");
    await exporter.getByTestId('export-options-csv-headers').uncheck();
    await exporter.getByTestId('export-options-csv-nullempty').check();
    await exporter.getByTestId('export-current-btn').click();

    await expect.poll(() => written(page, '/tmp/customers.csv')).not.toBeNull();
    const csv = String(await written(page, '/tmp/customers.csv'));
    expect(csv).toContain(';');
    expect(csv).not.toContain('_id;name');
    const { options } = (await app.calls('format_current_docs'))[0].args as { options: { csv: Record<string, unknown> } };
    expect(options.csv).toMatchObject({ delimiter: ';', quote: "'", includeHeaders: false, nullAsEmpty: true });
  });

  test('carries the spreadsheet options into the workbook', async ({ app, page }) => {
    const exporter = await openExport(app, page, '/tmp/customers.xlsx');
    await exporter.getByTestId('export-format-xlsx').click();

    await exporter.getByTestId('export-options-xlsx-headers').uncheck();
    await exporter.getByTestId('export-options-xlsx-bold').uncheck();
    await exporter.getByTestId('export-options-xlsx-autosize').uncheck();
    await exporter.getByTestId('export-options-xlsx-align').selectOption('center');
    await exporter.getByTestId('export-current-btn').click();

    await expect.poll(async () => (await app.calls('format_current_docs')).length).toBe(1);
    const { options } = (await app.calls('format_current_docs'))[0].args as { options: { xlsx: Record<string, unknown> } };
    expect(options.xlsx).toMatchObject({
      includeHeaders: false,
      boldHeaders: false,
      autoSize: false,
      alignment: 'center',
    });
  });

  test('picks the fields to write, all of them or none', async ({ app, page }) => {
    const exporter = await openExport(app, page, '/tmp/customers.csv');
    await exporter.getByTestId('export-format-csv').click();
    await exporter.getByTestId('export-scan-fields-btn').click();
    await expect(exporter.getByTestId('export-field-caption')).toContainText('selected');

    // The filter narrows the boxes on offer, not what is selected.
    await exporter.getByTestId('export-field-filter-input').fill('emai');
    await expect(exporter.getByTestId('export-field-email')).toBeVisible();
    await expect(exporter.getByTestId('export-field-name')).toHaveCount(0);
    await exporter.getByTestId('export-field-filter-input').fill('');

    await exporter.getByTestId('export-field-deselect-all').click();
    await expect(exporter.getByTestId('export-current-btn')).toBeDisabled();

    await exporter.getByTestId('export-field-select-all').click();
    await exporter.getByTestId('export-field-email').uncheck();
    await exporter.getByTestId('export-current-btn').click();

    const { options } = (await app.calls('format_current_docs'))[0].args as { options: { fields: string[] } };
    expect(options.fields).toContain('name');
    expect(options.fields).not.toContain('email');
  });

  test('exports a page of the query, skipping the first documents', async ({ app, page }) => {
    const exporter = await openExport(app, page, '/tmp/page.json');

    await exporter.getByTestId('export-filtered-skip').fill('1');
    await exporter.getByTestId('export-filtered-limit').fill('1');
    await exporter.getByTestId('export-filtered-count-btn').click();
    await expect(exporter.getByTestId('export-filtered-count')).toContainText('3');

    await exporter.getByTestId('export-filtered-btn').click();
    await expect.poll(async () => (await app.calls('start_filtered_export')).length).toBe(1);
    expect((await app.calls('start_filtered_export'))[0].args).toMatchObject({ skip: 1, limit: 1 });
  });
});
