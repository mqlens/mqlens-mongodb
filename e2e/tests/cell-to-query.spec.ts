import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { callFrom, connectStaging, getEditorText, openCollection, setEditorText, STAGING_URI, view } from '../helpers';

// The results' context menu sends a cell to the find query bar: its value to
// the filter, its field to the projection or the sort. Nothing runs until Run.

const menu = (page: Page) => page.getByTestId('context-menu');
const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });
const editorText = (page: Page, testId: string) => getEditorText(page, view(page).getByTestId(testId));
/** The query bar field's text parsed as the JSON the menu writes. */
const field = async (page: Page, testId: string) => JSON.parse((await editorText(page, testId)) || '{}');
const setField = (page: Page, testId: string, text: string) => setEditorText(page, view(page).getByTestId(testId), text);
const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();

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

  test('collects excluded values, and keeps the conditions already on the field', async ({ app, page }) => {
    const docs = [
      { _id: 1, name: 'Ada', tier: 'Gold' },
      { _id: 2, name: 'Ben', tier: 'Silver' },
      { _id: 3, name: 'Cy', tier: 'Bronze' },
    ];
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs } } } } } });
    await openCollection(page, 'shop', 'things');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await expect(view(page).getByTestId('table-header')).toContainText(/tier/i);
    const filter = () => field(page, 'query-filter-input');

    // One excluded value is `$ne`, a second turns it into `$nin`, a third joins the list.
    await fromCell(page, 'Gold', 'Exclude this value');
    await expect.poll(filter).toEqual({ tier: { $ne: 'Gold' } });
    await fromCell(page, 'Silver', 'Exclude this value');
    await expect.poll(filter).toEqual({ tier: { $nin: ['Gold', 'Silver'] } });
    await fromCell(page, 'Bronze', 'Exclude this value');
    await expect.poll(filter).toEqual({ tier: { $nin: ['Gold', 'Silver', 'Bronze'] } });
    // Excluding a listed value again changes nothing.
    await fromCell(page, 'Silver', 'Exclude this value');
    await expect.poll(filter).toEqual({ tier: { $nin: ['Gold', 'Silver', 'Bronze'] } });

    // An equality with another value stays beside the exclusion; with the same value it gives way.
    await setField(page, 'query-filter-input', '{ tier: "Gold" }');
    await fromCell(page, 'Silver', 'Exclude this value');
    await expect.poll(filter).toEqual({ tier: { $eq: 'Gold', $ne: 'Silver' } });
    await setField(page, 'query-filter-input', '{ tier: "Gold" }');
    await fromCell(page, 'Gold', 'Exclude this value');
    await expect.poll(filter).toEqual({ tier: { $ne: 'Gold' } });

    // Another operator on the field is kept.
    await setField(page, 'query-filter-input', '{ tier: { $exists: true } }');
    await fromCell(page, 'Gold', 'Exclude this value');
    await expect.poll(filter).toEqual({ tier: { $exists: true, $ne: 'Gold' } });
  });

  test('keeps a regex in the filter: as typed beside another field, as $regex beside an exclusion', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await expect(view(page).getByTestId('table-header')).toContainText(/tier/i);

    await setField(page, 'query-filter-input', '{ email: /^a.*\\/x$/i }');
    await fromCell(page, 'Premium', 'Filter by this value');
    await expect.poll(() => editorText(page, 'query-filter-input')).toBe('{ "email" : /^a.*\\/x$/i, "tier" : "Premium" }');

    await setField(page, 'query-filter-input', '{ name: /^A/i }');
    await fromCell(page, 'Alice Smith', 'Exclude this value');
    await expect.poll(() => field(page, 'query-filter-input')).toEqual({ name: { $regex: '^A', $options: 'i', $ne: 'Alice Smith' } });

    // A pattern JavaScript cannot read back as a literal stays in its Extended JSON form.
    await setField(page, 'query-filter-input', '{ name: { $regularExpression: { pattern: "(?i)^a", options: "" } } }');
    await fromCell(page, 'Premium', 'Filter by this value');
    await expect.poll(() => field(page, 'query-filter-input')).toEqual({
      name: { $regularExpression: { pattern: '(?i)^a', options: '' } },
      tier: 'Premium',
    });
  });

  test('un-hides a field in a projection that hides fields', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await expect(view(page).getByTestId('table-header')).toContainText(/tier/i);

    // The first entry opens the options row, where the projection can be typed.
    await fromCell(page, 'Alice Smith', 'Add field to projection');
    await expect(view(page).getByTestId('query-options-section')).toBeVisible();
    await setField(page, 'projection-query-input', '{ name: 0, tier: 0 }');
    await fromCell(page, 'Premium', 'Add field to projection');
    await expect.poll(() => field(page, 'projection-query-input')).toEqual({ name: 0 });

    const ran = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
    expect(ran).toMatchObject({ projection: '{"name":0}' });
  });

  test('takes typed and empty values from the JSON view', async ({ app, page }) => {
    const docs = [{ _id: { $oid: '603d779f4f102e3a105c3120' }, name: 'Ada', tags: [], meta: {} }];
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs } } } } } });
    await openCollection(page, 'shop', 'things');
    await expect(jsonLine(page, 'Ada')).toBeVisible();

    // The JSON view holds the id as an ObjectId; the filter keeps it one.
    await jsonLine(page, '603d779f4f102e3a105c3120').click({ button: 'right' });
    await menu(page).getByText('Filter by this value', { exact: true }).click();
    await expect.poll(() => editorText(page, 'query-filter-input')).toBe('{ "_id" : ObjectId("603d779f4f102e3a105c3120") }');

    // An empty array has no value to filter by, but its field can be projected.
    await jsonLine(page, 'tags').click({ button: 'right' });
    await expect(menu(page).getByText('Add field to projection', { exact: true })).toBeVisible();
    await expect(menu(page).getByText('Filter by this value', { exact: true })).toHaveCount(0);
    await menu(page).getByText('Add field to projection', { exact: true }).click();
    await expect.poll(() => field(page, 'projection-query-input')).toEqual({ tags: 1 });
  });
});
