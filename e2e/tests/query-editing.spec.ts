import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, SAMPLE_URI, type Seed } from '../harness/seed';
import {
  callFrom,
  connectStaging,
  getEditorText,
  loadSample,
  openCollection,
  setEditorText,
  view,
} from '../helpers';

const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });
const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();

/** Select the nth match of a test-id prefix, leaving out ids that only share the prefix. */
const byPrefix = (page: Page, prefix: string, not: string[] = []) =>
  view(page).locator([`[data-testid^="${prefix}"]`, ...not.map((other) => `:not([data-testid^="${other}"])`)].join(''));

async function openCustomers(app: App, page: Page, seed: Seed = {}): Promise<void> {
  await app.open(seed);
  await loadSample(page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
}

const lastFilter = async (app: App) => JSON.parse(String(((await app.calls('execute_mql_query')).at(-1)!.args as { filter: string }).filter));

test.describe('Visual query builder', () => {
  test('builds query, projection and sort rules, matches any, and clears them', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('toggle-query-builder').click();
    const panel = view(page).getByTestId('query-builder-panel');

    await panel.getByTestId('query-add-rule-btn').click();
    const fields = byPrefix(page, 'rule-field-', ['rule-field-custom-']);
    const operators = byPrefix(page, 'rule-operator-');
    const values = byPrefix(page, 'rule-value-', ['rule-value-exists-']);
    await expect(fields).toHaveCount(2);
    await fields.nth(0).selectOption('tier');
    await operators.nth(0).selectOption('$eq');
    await values.nth(0).fill('Premium');
    await fields.nth(1).selectOption('name');
    await operators.nth(1).selectOption('$regex');
    await values.nth(1).fill('Brown');
    await panel.getByTestId('query-match-type').selectOption({ label: 'Match Any ($or)' });

    await panel.getByTestId('projection-dropzone').click();
    await byPrefix(page, 'projection-field-', ['projection-field-custom-']).first().selectOption('name');
    await panel.getByTestId('sort-dropzone').click();
    await byPrefix(page, 'sort-field-', ['sort-field-custom-']).first().selectOption('name');
    await byPrefix(page, 'sort-direction-').first().selectOption('-1');

    // Turning a section off leaves it out of the query; on again puts it back.
    await panel.getByTestId('sort-enable-checkbox').click();
    await panel.getByTestId('sort-enable-checkbox').click();

    const applied = await callFrom(app, 'execute_mql_query', () => panel.getByRole('button', { name: 'Apply' }).click());
    expect(JSON.parse(String(applied.filter))).toEqual({ $or: [{ tier: 'Premium' }, { name: { $regex: 'Brown' } }] });
    expect(JSON.parse(String(applied.projection))).toEqual({ name: 1 });
    expect(JSON.parse(String(applied.sort))).toEqual({ name: -1 });

    await panel.getByRole('button', { name: 'Clear All' }).click();
    await expect(byPrefix(page, 'query-rule-')).toHaveCount(0);
  });

  test('opens on the query already typed, and follows edits to it', async ({ app, page }) => {
    await openCustomers(app, page);
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ $or: [{ tier: "Premium" }, { name: "Bob Johnson" }] }');
    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('projection-query-input'), '{ name: 1 }');
    await setEditorText(page, view(page).getByTestId('sort-query-input'), '{ name: -1 }');

    await view(page).getByTestId('toggle-query-builder').click();
    await expect(byPrefix(page, 'query-rule-')).toHaveCount(2);
    await expect(byPrefix(page, 'projection-rule-')).toHaveCount(1);
    await expect(byPrefix(page, 'sort-rule-')).toHaveCount(1);

    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Standard" }');
    await expect(byPrefix(page, 'query-rule-')).toHaveCount(1);
  });
});

test.describe('Query bar', () => {
  test('notes regex flags it drops, and rejects ones it cannot run', async ({ app, page }) => {
    await openCustomers(app, page);
    const filter = view(page).getByTestId('query-filter-input');

    await setEditorText(page, filter, '{ name: /smith/gi }');
    await expect(view(page).getByTestId('query-notice-badge')).toBeVisible();

    await setEditorText(page, filter, '{ name: /a/y }');
    await expect(view(page).getByTestId('query-invalid-badge')).toBeVisible();
    await expect(runButton(page)).toBeDisabled();

    await setEditorText(page, filter, '5');
    await expect(view(page).getByTestId('query-invalid-badge')).toBeVisible();
  });

  test('accepts smart quotes, comments, big integers and a filter without braces', async ({ app, page }) => {
    await openCustomers(app, page);
    const filter = view(page).getByTestId('query-filter-input');

    await setEditorText(page, filter, '{ tier: “Premium” }');
    await runButton(page).click();
    await expect.poll(() => lastFilter(app)).toEqual({ tier: 'Premium' });

    await setEditorText(page, filter, 'tier: "Standard"');
    await runButton(page).click();
    await expect.poll(() => lastFilter(app)).toEqual({ tier: 'Standard' });

    await setEditorText(page, filter, '{ visits: /* all time */ 9007199254740993 }');
    await runButton(page).click();
    await expect.poll(async () => JSON.stringify(await lastFilter(app))).toContain('9007199254740993');
  });
});

test.describe('Aggregation builder', () => {
  test('undoes and redoes, reorders stages, fills a $lookup, explains and opens in mongosh', async ({ app, page }) => {
    // On a saved connection: the backend refuses pipelines and mongosh on the sample server.
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    await setEditorText(page, editor.getByTestId('pipeline-stage-0'), '{ tier: "Premium" }');
    await editor.getByRole('button', { name: 'Add Stage' }).click();
    const second = editor.getByTestId('pipeline-stage-1');
    await second.locator('select').selectOption('$sort');
    await setEditorText(page, second, '{ name: -1 }');

    await editor.getByRole('button', { name: 'Undo pipeline change' }).click();
    await editor.getByRole('button', { name: 'Redo pipeline change' }).click();
    await expect(second).toBeVisible();

    await editor.getByRole('button', { name: 'Move stage 2 up' }).click();
    const moved = await callFrom(app, 'execute_aggregate', () => runButton(page).click());
    expect(JSON.parse(String(moved.pipeline)).map((stage: object) => Object.keys(stage)[0])).toEqual(['$sort', '$match']);
    await editor.getByRole('button', { name: 'Move stage 1 down' }).click();

    await editor.getByRole('button', { name: 'Add Stage' }).click();
    const third = editor.getByTestId('pipeline-stage-2');
    await third.locator('select').selectOption('$lookup');
    const lookup = editor.getByTestId('lookup-form-2');
    await lookup.getByLabel('$lookup from').fill('transactions');
    await lookup.getByLabel('$lookup localField').fill('name');
    await lookup.getByLabel('$lookup foreignField').fill('customer_name');
    await lookup.getByLabel('$lookup as').fill('orders');
    await expect.poll(() => getEditorText(page, third)).toContain('transactions');
    // The fake backend doesn't run $lookup; take the stage out again.
    await editor.getByRole('button', { name: 'Remove stage 3' }).click();

    await callFrom(app, 'explain_aggregate_query', () => view(page).getByTestId('explain-plan-tab').click());

    await view(page).getByRole('button', { name: 'Open query in...' }).click();
    await page.getByRole('menuitem', { name: 'Open in mongosh' }).click();
    await expect(page.getByTestId('mongo-shell')).toBeVisible();
    // The command it builds spans lines, so it may run as a script.
    await expect
      .poll(async () => {
        const commands = (await app.calls('run_mongosh_command')).map((call) => (call.args as { command: string }).command);
        const scripts = (await app.calls('run_mongosh_script')).map((call) => (call.args as { script: string }).script);
        return [...commands, ...scripts].join('\n');
      })
      .toContain('aggregate');
  });

  test('a confirm-destructive connection asks for the name before an $out stage writes', async ({ app, page }) => {
    await connectStaging(app, page, {}, { connection_mode: 'confirm_destructive' });
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    await editor.getByRole('button', { name: 'Add Stage' }).click();
    await editor.getByTestId('pipeline-stage-1').locator('select').selectOption('$out');

    const before = (await app.calls('execute_aggregate')).length;
    await runButton(page).click();
    await expect(page.getByTestId('dialog-input')).toBeVisible();
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('execute_aggregate')).toHaveLength(before);
  });
});

test.describe('Results', () => {
  test('charts with a measure, as a line, in raw mode, and exports a PNG', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'products');
    await view(page).getByRole('button', { name: 'Chart' }).click();
    const chart = view(page).getByTestId('chart-view');

    await chart.getByRole('combobox', { name: 'X axis' }).click();
    await page.getByRole('option', { name: 'category' }).click();
    await chart.getByRole('combobox', { name: 'Measure', exact: true }).click();
    await page.getByRole('option', { name: /sum/i }).click();
    await chart.getByRole('combobox', { name: 'Measure field' }).click();
    await page.getByRole('option', { name: 'price' }).click();
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(2);

    await chart.getByRole('combobox', { name: 'Chart type' }).click();
    await page.getByRole('option', { name: /line/i }).click();
    await expect(chart.locator('.recharts-line')).toHaveCount(1);

    await chart.getByRole('tab', { name: 'Raw' }).click();
    await chart.getByRole('combobox', { name: 'Y axis' }).click();
    await page.getByRole('option', { name: 'stock' }).click();

    const download = page.waitForEvent('download');
    await chart.getByRole('button', { name: 'Export PNG' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.png$/);
  });

  test('folds documents in the JSON and tree views, and selects all results', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'JSON', exact: true }).click();

    const lines = view(page).locator('[data-json-line]');
    const before = await lines.count();
    await view(page).getByTestId('json-fold-btn').first().click();
    await expect.poll(() => lines.count()).toBeLessThan(before);

    await jsonLine(page, 'Charlie Brown').click();
    await page.keyboard.press('ControlOrMeta+a');
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Charlie Brown');

    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    const treeFold = view(page).getByTestId('tree-fold-btn').first();
    await treeFold.click();
    await expect(treeFold).toBeVisible();
  });

  test('compares documents with nested, one-sided and typed values', async ({ app, page }) => {
    const lab = {
      pairs: {
        docs: [
          {
            _id: { $oid: '650000000000000000000001' },
            label: 'first',
            meta: { x: [1, { y: 2 }] },
            at: { $date: { $numberLong: '1700000000000' } },
            price: { $numberDecimal: '1.10' },
          },
          {
            _id: { $oid: '650000000000000000000002' },
            label: 'second',
            tags: ['t', { k: 1 }],
            at: { $date: { $numberLong: '1700000100000' } },
            price: { $numberDecimal: '2.20' },
          },
        ],
      },
    };
    await app.open({ servers: { [SAMPLE_URI]: { ...SAMPLE_SERVER, databases: { ...SAMPLE_SERVER.databases, lab } } } });
    await loadSample(page);
    await openCollection(page, 'lab', 'pairs');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await expect(view(page)).toContainText('second');
    await view(page).getByRole('button', { name: 'JSON', exact: true }).click();

    await jsonLine(page, '"first"').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare with…', exact: true }).click();
    await jsonLine(page, '"second"').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare with selected' }).click();

    const summary = page.getByTestId('document-diff-modal').getByTestId('diff-summary');
    await expect(summary).toContainText('added');
    await expect(summary).toContainText('removed');
  });
});
