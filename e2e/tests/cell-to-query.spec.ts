import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { callFrom, connectStaging, getEditorText, openCollection, view } from '../helpers';

// The results' context menu sends a cell to the find query bar: its value to
// the filter, its field to the projection or the sort. Nothing runs until Run.

const menu = (page: Page) => page.getByTestId('context-menu');
const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });
const editorText = (page: Page, testId: string) => getEditorText(page, view(page).getByTestId(testId));
/** The query bar field's text parsed as the JSON the menu writes. */
const field = async (page: Page, testId: string) => JSON.parse((await editorText(page, testId)) || '{}');

async function fromCell(page: Page, cellText: string, entry: string): Promise<void> {
  await view(page).getByText(cellText, { exact: true }).first().click({ button: 'right' });
  await menu(page).getByText(entry, { exact: true }).click();
}

test.describe('A result cell sent to the query', () => {
  test('filters by and excludes a value, without running until Run', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await expect(view(page).getByTestId('table-header')).toContainText(/tier/i);

    const before = (await app.calls('execute_mql_query')).length;
    await fromCell(page, 'Premium', 'Filter by this value');
    await expect.poll(() => field(page, 'query-filter-input')).toEqual({ tier: 'Premium' });
    // A second cell narrows the same filter.
    await fromCell(page, 'Alice Smith', 'Exclude this value');
    await expect.poll(() => field(page, 'query-filter-input')).toEqual({ tier: 'Premium', name: { $ne: 'Alice Smith' } });
    expect(await app.calls('execute_mql_query')).toHaveLength(before);

    const ran = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
    expect(JSON.parse(String(ran.filter))).toEqual({ tier: 'Premium', name: { $ne: 'Alice Smith' } });
    // The rows only: the filter above them names Alice too.
    const rows = view(page).getByTestId('table-body-scroll');
    await expect(rows).toContainText('Charlie Brown');
    await expect(rows).not.toContainText('Bob Johnson');
    await expect(rows).not.toContainText('Alice Smith');
  });

  test('keeps an ObjectId an ObjectId, and takes a nested field by its path', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');

    // JSON view: the city sits inside `address`.
    await view(page).locator('[data-json-line]').filter({ hasText: 'Seattle' }).first().click({ button: 'right' });
    await menu(page).getByText('Filter by this value', { exact: true }).click();
    await expect.poll(() => field(page, 'query-filter-input')).toEqual({ 'address.city': 'Seattle' });

    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await fromCell(page, '603d779f4f102e3a105c3122', 'Filter by this value');
    await expect.poll(() => editorText(page, 'query-filter-input')).toContain('ObjectId("603d779f4f102e3a105c3122")');
    const ran = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
    expect(JSON.parse(String(ran.filter))).toEqual({
      'address.city': 'Seattle',
      _id: { $oid: '603d779f4f102e3a105c3122' },
    });
  });

  test('adds a field to the projection and sorts by one, opening the options row', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await expect(view(page).getByTestId('table-header')).toContainText(/tier/i);
    const options = view(page).getByTestId('query-options-section');
    await expect(options).toBeHidden();

    await fromCell(page, 'Alice Smith', 'Add field to projection');
    await expect(options).toBeVisible();
    await expect.poll(() => field(page, 'projection-query-input')).toEqual({ name: 1 });
    await fromCell(page, 'Premium', 'Add field to projection');
    await expect.poll(() => field(page, 'projection-query-input')).toEqual({ name: 1, tier: 1 });

    await fromCell(page, 'Alice Smith', 'Sort ascending by this field');
    await expect.poll(() => field(page, 'sort-query-input')).toEqual({ name: 1 });
    await fromCell(page, 'Alice Smith', 'Sort descending by this field');
    await expect.poll(() => field(page, 'sort-query-input')).toEqual({ name: -1 });

    const ran = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
    expect(ran).toMatchObject({ projection: '{"name":1,"tier":1}', sort: '{"name":-1}' });
  });

  test('leaves a filter it cannot parse alone, and is not offered for an aggregation', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await expect(view(page).getByTestId('table-header')).toContainText(/tier/i);

    await view(page).getByTestId('query-filter-input').locator('.monaco-editor').first().click();
    await page.keyboard.type('{ tier: ');
    await fromCell(page, 'Premium', 'Filter by this value');
    await expect(page.getByText('Fix the query text before adding to it')).toBeVisible();
    expect(await editorText(page, 'query-filter-input')).toContain('{ tier: ');

    await view(page).getByTestId('mode-aggregate-tab').click();
    await view(page).getByText('Premium', { exact: true }).first().click({ button: 'right' });
    await expect(menu(page).getByText('Copy value', { exact: true })).toBeVisible();
    await expect(menu(page).getByText('Filter by this value', { exact: true })).toHaveCount(0);
  });
});
