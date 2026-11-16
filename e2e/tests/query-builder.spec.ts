import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom, connectStaging, getEditorText, loadSample, openCollection, setEditorText, view } from '../helpers';

const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });

/** Select the matches of a test-id prefix, leaving out ids that only share the prefix. */
const byPrefix = (page: Page, prefix: string, not: string[] = []) =>
  view(page).locator([`[data-testid^="${prefix}"]`, ...not.map((other) => `:not([data-testid^="${other}"])`)].join(''));
const ruleFields = (page: Page) => byPrefix(page, 'rule-field-', ['rule-field-custom-']);
const ruleOperators = (page: Page) => byPrefix(page, 'rule-operator-');
const ruleValues = (page: Page) => byPrefix(page, 'rule-value-', ['rule-value-exists-']);

/**
 * Open a sales_db collection on the sample server, or on a saved connection for
 * what the sample server refuses or ignores: pipelines, projections, saved queries.
 */
async function openSales(app: App, page: Page, collection: string, where: 'sample' | 'staging' = 'sample'): Promise<void> {
  if (where === 'sample') {
    await app.open();
    await loadSample(page);
  } else {
    await connectStaging(app, page);
  }
  await openCollection(page, 'sales_db', collection);
  await expect(view(page).locator('[data-json-line]').first()).toBeVisible();
}

/** Every mongosh command and script the app has run, as one text. */
const shellInput = async (app: App) => {
  const commands = (await app.calls('run_mongosh_command')).map((call) => (call.args as { command: string }).command);
  const scripts = (await app.calls('run_mongosh_script')).map((call) => (call.args as { script: string }).script);
  return [...commands, ...scripts].join('\n');
};

test.describe('Visual query builder rules', () => {
  test('shows a date as a date input in UTC, and runs the date picked there', async ({ app, page }) => {
    await openSales(app, page, 'transactions', 'staging');
    const filter = view(page).getByTestId('query-filter-input');
    const dateInput = byPrefix(page, 'rule-date-', ['rule-date-toggle-']);

    await setEditorText(page, filter, '{ timestamp: { $gte: ISODate("2025-05-12T00:00:00Z") } }');
    await view(page).getByTestId('toggle-query-builder').click();
    await expect(ruleOperators(page).first()).toHaveValue('$gte');
    // Chromium shortens the text to the minute; WebKit keeps it as set.
    await expect(dateInput).toHaveValue(/^2025-05-12T00:00(:00(\.000)?)?$/);
    // No raw EJSON text box for it.
    await expect(ruleValues(page)).toHaveCount(0);

    await dateInput.fill('2025-05-20T00:00');
    const run = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
    expect(JSON.parse(String(run.filter))).toEqual({ timestamp: { $gte: { $date: '2025-05-20T00:00:00.000Z' } } });

    // The calendar toggle turns a value back into text.
    await byPrefix(page, 'rule-date-toggle-').first().click();
    await expect(dateInput).toHaveCount(0);
    await expect(ruleValues(page)).toHaveCount(1);
  });

  test('reads an operator, an embedded document, plain values and unreadable text into rules', async ({ app, page }) => {
    await openSales(app, page, 'transactions');
    const filter = view(page).getByTestId('query-filter-input');
    const toggle = view(page).getByTestId('toggle-query-builder');
    const builder = view(page).getByTestId('query-builder-panel');

    await setEditorText(page, filter, '{ amount: { $gt: 100 } }');
    await toggle.click();
    await expect(ruleOperators(page).first()).toHaveValue('$gt');
    await expect(ruleValues(page).first()).toHaveValue('100');
    await toggle.click();
    await expect(builder).toBeHidden();

    await setEditorText(page, filter, '{ customer: { name: "Alice Smith" } }');
    await toggle.click();
    await expect(ruleValues(page).first()).toHaveValue(/Alice Smith/);
    await toggle.click();

    await setEditorText(page, filter, '{ status: "Pending", amount: 549.49 }');
    await toggle.click();
    await expect(byPrefix(page, 'query-rule-')).toHaveCount(2);
    await toggle.click();

    // Text that isn't a filter document starts the builder on one blank rule.
    for (const text of ['[1]', '{ status: ']) {
      await setEditorText(page, filter, text);
      await toggle.click();
      await expect(byPrefix(page, 'query-rule-')).toHaveCount(1);
      await expect(ruleValues(page).first()).toHaveValue('');
      await toggle.click();
    }
  });

  test('has no projection or sort rules for text that is not a document', async ({ app, page }) => {
    await openSales(app, page, 'customers');
    await view(page).getByTestId('query-options-toggle').click();
    const toggle = view(page).getByTestId('toggle-query-builder');

    for (const text of ['[1]', '{ name: ']) {
      await setEditorText(page, view(page).getByTestId('projection-query-input'), text);
      await setEditorText(page, view(page).getByTestId('sort-query-input'), text);
      await toggle.click();
      await expect(byPrefix(page, 'projection-rule-')).toHaveCount(0);
      await expect(byPrefix(page, 'sort-rule-')).toHaveCount(0);
      await toggle.click();
    }
  });

  test('merges bounds on one field, checks existence, and takes hex numbers and custom fields', async ({ app, page }) => {
    await openSales(app, page, 'transactions', 'staging');
    await view(page).getByTestId('toggle-query-builder').click();
    const panel = view(page).getByTestId('query-builder-panel');

    await panel.getByTestId('query-add-rule-btn').click();
    await expect(ruleFields(page)).toHaveCount(2);
    await ruleFields(page).nth(0).selectOption('amount');
    await ruleOperators(page).nth(0).selectOption('$gt');
    await ruleValues(page).nth(0).fill('0x10');
    await ruleFields(page).nth(1).selectOption('amount');
    await ruleOperators(page).nth(1).selectOption('$lt');
    await ruleValues(page).nth(1).fill('600');
    const bounded = await callFrom(app, 'execute_mql_query', () => panel.getByRole('button', { name: 'Apply' }).click());
    expect(JSON.parse(String(bounded.filter))).toEqual({ amount: { $gt: 16, $lt: 600 } });

    await ruleOperators(page).nth(1).selectOption('$exists');
    await expect(byPrefix(page, 'rule-value-exists-')).toHaveCount(1);
    await ruleFields(page).nth(1).selectOption({ label: 'Custom field...' });
    await byPrefix(page, 'rule-field-custom-').first().fill('refund');
    await byPrefix(page, 'query-rule-').nth(1).locator('button').last().click();
    await expect(byPrefix(page, 'query-rule-')).toHaveCount(1);
    await panel.getByTestId('query-enable-checkbox').click();
    await panel.getByTestId('query-enable-checkbox').click();

    await panel.getByTestId('projection-dropzone').click();
    await panel.getByTestId('projection-add-rule-btn').click();
    const projectionFields = byPrefix(page, 'projection-field-', ['projection-field-custom-']);
    await expect(projectionFields).toHaveCount(2);
    await projectionFields.nth(0).selectOption('customer_name');
    await projectionFields.nth(1).selectOption({ label: 'Custom field...' });
    await byPrefix(page, 'projection-field-custom-').first().fill('status');
    await byPrefix(page, 'projection-rule-').nth(1).locator('button').last().click();
    await expect(byPrefix(page, 'projection-rule-')).toHaveCount(1);
    await panel.getByTestId('projection-enable-checkbox').click();
    await panel.getByTestId('projection-enable-checkbox').click();

    await panel.getByTestId('sort-dropzone').click();
    await panel.getByTestId('sort-add-rule-btn').click();
    const sortFields = byPrefix(page, 'sort-field-', ['sort-field-custom-']);
    await expect(sortFields).toHaveCount(2);
    await sortFields.nth(0).selectOption('amount');
    await sortFields.nth(1).selectOption({ label: 'Custom field...' });
    await byPrefix(page, 'sort-field-custom-').first().fill('timestamp');
    await byPrefix(page, 'sort-rule-').nth(1).locator('button').last().click();
    await expect(byPrefix(page, 'sort-rule-')).toHaveCount(1);

    const applied = await callFrom(app, 'execute_mql_query', () => panel.getByRole('button', { name: 'Apply' }).click());
    expect(JSON.parse(String(applied.projection))).toEqual({ customer_name: 1 });
    expect(JSON.parse(String(applied.sort))).toEqual({ amount: 1 });

    await view(page).getByTestId('toggle-query-builder').click();
    await expect(panel).toBeHidden();
  });

  test('keeps its rules in step as the projection, sort and filter text is edited and cleared', async ({ app, page }) => {
    await openSales(app, page, 'customers');
    await view(page).getByTestId('query-options-toggle').click();
    await view(page).getByTestId('toggle-query-builder').click();
    const projection = view(page).getByTestId('projection-query-input');
    const sort = view(page).getByTestId('sort-query-input');
    const filter = view(page).getByTestId('query-filter-input');

    await setEditorText(page, projection, '{ name: 1 }');
    await expect(byPrefix(page, 'projection-rule-')).toHaveCount(1);
    await setEditorText(page, projection, '');
    await expect(byPrefix(page, 'projection-rule-')).toHaveCount(0);

    await setEditorText(page, sort, '{ name: -1 }');
    await expect(byPrefix(page, 'sort-rule-')).toHaveCount(1);
    await setEditorText(page, sort, '');
    await expect(byPrefix(page, 'sort-rule-')).toHaveCount(0);

    await setEditorText(page, filter, '{ tier: "Premium", name: "Alice Smith" }');
    await expect(byPrefix(page, 'query-rule-')).toHaveCount(2);
    await setEditorText(page, filter, '');
    await expect.poll(() => byPrefix(page, 'query-rule-').count()).toBeLessThan(2);
  });
});

test.describe('Aggregation stages', () => {
  test('refuses an unreadable stage, collapses one, and reorders them by dragging', async ({ app, page }) => {
    await openSales(app, page, 'customers', 'staging');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    const first = editor.getByTestId('pipeline-stage-0');

    await setEditorText(page, first, '{ tier: ');
    const before = (await app.calls('execute_aggregate')).length;
    await editor.getByRole('button', { name: 'Run pipeline to stage 1' }).click();
    await runButton(page).click();
    await expect(view(page).getByText(/Invalid|Unexpected|Expected/).first()).toBeVisible();
    expect(await app.calls('execute_aggregate')).toHaveLength(before);

    await setEditorText(page, first, '{ tier: "Premium" }');
    await editor.getByRole('button', { name: 'Add Stage' }).click();
    const second = editor.getByTestId('pipeline-stage-1');
    await second.locator('select').selectOption('$sort');
    await setEditorText(page, second, '{ name: -1 }');

    await editor.getByRole('button', { name: 'Collapse stage 1' }).click();
    await editor.getByRole('button', { name: 'Expand stage 1' }).click();
    await expect(editor.getByRole('button', { name: 'Collapse stage 1' })).toBeVisible();

    await first.locator('[draggable="true"]').first().dragTo(second);
    const reordered = await callFrom(app, 'execute_aggregate', () => runButton(page).click());
    expect(JSON.parse(String(reordered.pipeline)).map((stage: object) => Object.keys(stage)[0])).toEqual(['$sort', '$match']);
  });

  test('opens a find query with its projection in mongosh', async ({ app, page }) => {
    await openSales(app, page, 'customers', 'staging');
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('projection-query-input'), '{ name: 1 }');
    await view(page).getByRole('button', { name: 'Open query in...' }).click();
    await page.getByRole('menuitem', { name: 'Open in mongosh' }).click();
    await expect(page.getByTestId('mongo-shell')).toBeVisible();
    await expect.poll(() => shellInput(app)).toContain('.find({"tier":"Premium"}, {"name":1})');
  });

  test('opens a pipeline in mongosh with an unreadable stage as written', async ({ app, page }) => {
    await openSales(app, page, 'customers', 'staging');
    await view(page).getByTestId('mode-aggregate-tab').click();
    await setEditorText(page, view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0'), '{ tier: ');
    await view(page).getByRole('button', { name: 'Open query in...' }).click();
    await page.getByRole('menuitem', { name: 'Open in mongosh' }).click();
    await expect(page.getByTestId('mongo-shell')).toBeVisible();
    await expect.poll(() => shellInput(app)).toContain('"$match": "{ tier: "');
  });

  test('shows why an explain failed', async ({ app, page }) => {
    await openSales(app, page, 'customers');
    await app.failNext('explain_mql_query', 'not authorized to explain on sales_db');
    await view(page).getByTestId('explain-plan-tab').click();
    await expect(view(page).getByText('not authorized to explain on sales_db')).toBeVisible();
  });

  test('a duplicated tab keeps its pipeline', async ({ app, page }) => {
    await openSales(app, page, 'customers', 'staging');
    await view(page).getByTestId('mode-aggregate-tab').click();
    await setEditorText(page, view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0'), '{ tier: "Premium" }');
    await callFrom(app, 'execute_aggregate', () => runButton(page).click());

    const strip = page.getByTestId('workspace-tab-strip');
    await strip.getByText('customers').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate Tab' }).click();
    await expect(strip.getByText('customers')).toHaveCount(2);
    const stage = view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0');
    await expect.poll(() => getEditorText(page, stage)).toContain('Premium');
  });
});

test.describe('Saved queries and the query bar', () => {
  test('favorites a query as it saves it', async ({ app, page }) => {
    await openSales(app, page, 'customers', 'staging');
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await view(page).getByRole('button', { name: 'Save query', exact: true }).click();
    await page.getByTestId('save-favorite-query-item').click();
    await page.getByTestId('dialog-input').fill('Premium customers');
    const saved = await callFrom(app, 'save_query', () => page.getByTestId('dialog-confirm').click());
    const id = (saved.saved as { id: string }).id;
    await expect(toast(page, 'Saved and favorited')).toBeVisible();

    await view(page).getByRole('button', { name: 'Load query', exact: true }).click();
    const star = page.getByTestId(`favorite-saved-${id}`);
    await expect(star).toBeVisible();
    await star.click();
    await page.keyboard.press('Escape');
  });

  test('reports a saved query it could not save, delete, pin or unpin', async ({ app, page }) => {
    await openSales(app, page, 'customers', 'staging');
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    const save = async (name: string) => {
      await view(page).getByRole('button', { name: 'Save query', exact: true }).click();
      await page.getByTestId('save-query-item').click();
      await page.getByTestId('dialog-input').fill(name);
      await page.getByTestId('dialog-confirm').click();
    };

    await app.failNext('save_query', 'disk is full');
    await save('Premium customers');
    await expect(toast(page, "Couldn't save query: disk is full")).toBeVisible();

    const saved = await callFrom(app, 'save_query', () => save('Premium customers'));
    const id = (saved.saved as { id: string }).id;
    await view(page).getByRole('button', { name: 'Load query', exact: true }).click();
    await app.failNext('delete_saved_query', 'query store is locked');
    await page.getByTestId(`delete-saved-${id}`).click();
    await expect(toast(page, "Couldn't delete query: query store is locked")).toBeVisible();
    await page.keyboard.press('Escape');

    await app.failNext('set_default_query', 'read-only store');
    await view(page).getByRole('button', { name: 'Set default query', exact: true }).click();
    await page.getByTestId('set-default-item').click();
    await expect(toast(page, "Couldn't set default: read-only store")).toBeVisible();

    await view(page).getByRole('button', { name: 'Set default query', exact: true }).click();
    await callFrom(app, 'set_default_query', () => page.getByTestId('set-default-item').click());
    await app.failNext('set_default_query', 'read-only store');
    await view(page).getByRole('button', { name: 'Set default query', exact: true }).click();
    await page.getByTestId('clear-default-item').click();
    await expect(toast(page, "Couldn't clear default: read-only store")).toBeVisible();
  });

  test('saves an unreadable filter as an empty one, and loads a saved pipeline back into its stages', async ({ app, page }) => {
    await openSales(app, page, 'customers', 'staging');
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: ');
    await view(page).getByRole('button', { name: 'Save query', exact: true }).click();
    await page.getByTestId('save-query-item').click();
    await page.getByTestId('dialog-input').fill('Everything');
    const unreadable = await callFrom(app, 'save_query', () => page.getByTestId('dialog-confirm').click());
    expect((unreadable.saved as { query: { filter: unknown } }).query.filter).toEqual({});

    await view(page).getByTestId('mode-aggregate-tab').click();
    const stage = view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0');
    await setEditorText(page, stage, '{ tier: "Standard" }');
    await view(page).getByRole('button', { name: 'Save query', exact: true }).click();
    await page.getByTestId('save-query-item').click();
    await page.getByTestId('dialog-input').fill('Standard pipeline');
    const pipeline = await callFrom(app, 'save_query', () => page.getByTestId('dialog-confirm').click());
    const id = (pipeline.saved as { id: string }).id;

    await setEditorText(page, stage, '{}');
    await view(page).getByRole('button', { name: 'Load query', exact: true }).click();
    await page.getByTestId(`saved-query-${id}`).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => getEditorText(page, stage)).toContain('Standard');
  });

  test('clears the filter, projection and sort', async ({ app, page }) => {
    await openSales(app, page, 'customers');
    const filter = view(page).getByTestId('query-filter-input');
    await setEditorText(page, filter, '{ tier: "Premium" }');
    await view(page).getByTestId('query-options-toggle').click();
    const projection = view(page).getByTestId('projection-query-input');
    const sort = view(page).getByTestId('sort-query-input');
    await setEditorText(page, projection, '{ name: 1 }');
    await setEditorText(page, sort, '{ name: -1 }');

    await view(page).getByTestId('query-clear-filter').click();
    await expect(toast(page, 'Cleared filter parameters')).toBeVisible();
    await expect.poll(() => getEditorText(page, filter)).toBe('');

    await view(page).getByTitle('Clear Projection').click();
    await expect(toast(page, 'Cleared projection parameters')).toBeVisible();
    await expect.poll(() => getEditorText(page, projection)).toBe('');

    await view(page).getByTitle('Clear Sort').click();
    await expect(toast(page, 'Cleared sort parameters')).toBeVisible();
    await expect.poll(() => getEditorText(page, sort)).toBe('');
  });
});
