import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections, openCollection, view } from '../helpers';

// The last corners of the transfer views (#396): a field put back, a template
// that cannot be read, and a preview line that is not a document at all.

const sidebar = (page: Page) => page.getByRole('complementary');

async function openExport(app: App, page: Page): Promise<Locator> {
  await connectStaging(app, page, { dialog: { save: '/tmp/customers.csv' } });
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
  await view(page).getByTestId('export-btn').click();
  return page.getByTestId('export-view');
}

test.describe('Choosing what to export', () => {
  test('a field taken out can be put back', async ({ app, page }) => {
    const exporter = await openExport(app, page);
    await exporter.getByTestId('export-format-csv').click();
    await exporter.getByTestId('export-scan-fields-btn').click();
    await expect(exporter.getByTestId('export-field-caption')).toContainText('selected');

    await exporter.getByTestId('export-field-email').uncheck();
    await exporter.getByTestId('export-field-email').check();
    await exporter.getByTestId('export-field-joined').uncheck();
    await exporter.getByTestId('export-current-btn').click();

    const { options } = (await app.calls('format_current_docs'))[0].args as { options: { fields: string[] } };
    expect(options.fields).toContain('email');
    expect(options.fields).not.toContain('joined');
  });
});

test.describe('Generating documents', () => {
  test('falls back to raw editing for a template it cannot read', async ({ app, page }) => {
    await connectStaging(app, page);
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({ infer_generate_template: () => '{ "name": ' });
    });
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Generate Data…' }).click();
    await dismissHoverCards(page);

    const generate = page.getByTestId('generate-view');
    await expect(generate.getByTestId('generate-custom-notice')).toBeVisible();
    await expect(generate.getByTestId('generate-mode-builder')).toBeDisabled();
  });
});

test.describe('Previewing an import', () => {
  test('shows a line it cannot read as it came, and puts a column type back to auto', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('import-btn').click();
    const imp = page.getByTestId('import-view');

    // A preview line the app cannot parse is shown rather than dropped.
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        preview_import: () => ({ docs: ['not a document at all'], columns: [], totalHint: 1, error: null }),
      });
    });
    await imp.getByTestId('import-source-paste').click();
    await imp.getByTestId('import-paste-textarea').fill('[{ "name": "Eve" }]');
    await expect(imp.getByTestId('import-preview-docs')).toContainText('not a document at all');

    // A column typed by hand, then left to the reader again.
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        preview_import: () => ({
          docs: ['{"name":"Eve","visits":"7"}'],
          columns: ['name', 'visits'],
          totalHint: 1,
          error: null,
        }),
      });
    });
    await imp.getByTestId('import-format-select').selectOption('csv');
    await expect(imp.getByTestId('import-preview-grid')).toContainText('Eve');
    await imp.getByTestId('import-coltype-visits').selectOption('string');
    await imp.getByTestId('import-coltype-visits').selectOption('auto');
    await imp.getByTestId('import-run-btn').click();

    const args = (await app.calls('start_import_task'))[0].args as { csvOptions: { columnTypes: Record<string, string> } };
    expect(args.csvOptions.columnTypes).toEqual({});
  });
});
