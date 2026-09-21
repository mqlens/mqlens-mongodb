import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import {
  connectStaging,
  dismissHoverCards,
  expandCollections,
  getEditorText,
  loadSample,
  openCollection,
  openInNewTab,
  setEditorText,
} from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary');
const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');
const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });
/** The line of the results' JSON view that shows `text`. */
const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();

/** Do `action`, then return the arguments of the first `cmd` call it caused. */
async function callFrom(app: App, cmd: string, action: () => Promise<void>): Promise<Record<string, unknown>> {
  const before = (await app.calls(cmd)).length;
  await action();
  await expect.poll(async () => (await app.calls(cmd)).length, `a ${cmd} call`).toBeGreaterThan(before);
  return (await app.calls(cmd))[before].args as Record<string, unknown>;
}

/**
 * Open customers on a saved connection. The sample server ignores projections,
 * refuses pipelines and always explains with an index scan, so queries here run
 * the way they do against a real server.
 */
async function openCustomers(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
}

async function runFilter(page: Page, filter: string): Promise<void> {
  await setEditorText(page, view(page).getByTestId('query-filter-input'), filter);
  await runButton(page).click();
}

test.describe('Query tools', () => {
  test('find options: projection, sort, skip and limit, then paging', async ({ app, page }) => {
    await openCustomers(app, page);

    await view(page).getByTestId('query-options-toggle').click();
    const options = view(page).getByTestId('query-options-section');
    await setEditorText(page, options.getByTestId('projection-query-input'), '{ name: 1, tier: 1 }');
    await setEditorText(page, options.getByTestId('sort-query-input'), '{ name: -1 }');
    await options.getByRole('spinbutton').nth(1).fill('2');

    const first = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
    expect(first).toMatchObject({ projection: '{"name":1,"tier":1}', sort: '{"name":-1}', limit: 2, skip: 0 });
    await expect(view(page)).toContainText('Charlie Brown');
    await expect(view(page)).not.toContainText('Alice Smith');
    // The projection leaves email out.
    await expect(view(page)).not.toContainText('charlie@example.com');

    const second = await callFrom(app, 'execute_mql_query', () => view(page).getByTestId('pager-next').click());
    expect(second).toMatchObject({ skip: 2, limit: 2 });
    await expect(view(page)).toContainText('Alice Smith');

    const resized = await callFrom(app, 'execute_mql_query', async () => {
      await view(page).getByTestId('pager-size').selectOption('25');
    });
    expect(resized).toMatchObject({ skip: 0, limit: 25 });
  });

  test('aggregation pipeline builder: stages, disabling, running to a stage, removing', async ({ app, page }) => {
    await openCustomers(app, page);

    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    await setEditorText(page, editor.getByTestId('pipeline-stage-0'), '{ tier: "Premium" }');
    await editor.getByRole('button', { name: 'Add Stage' }).click();
    const second = editor.getByTestId('pipeline-stage-1');
    await second.locator('select').selectOption('$sort');
    await setEditorText(page, second, '{ name: -1 }');

    const run = await callFrom(app, 'execute_aggregate', () => runButton(page).click());
    expect(JSON.parse(String(run.pipeline))).toEqual([{ $match: { tier: 'Premium' } }, { $sort: { name: -1 } }]);
    await expect(view(page)).toContainText('Charlie Brown');
    await expect(view(page)).not.toContainText('Bob Johnson');

    await editor.getByRole('button', { name: 'Disable stage 2' }).click();
    const disabled = await callFrom(app, 'execute_aggregate', () => runButton(page).click());
    expect(JSON.parse(String(disabled.pipeline))).toEqual([{ $match: { tier: 'Premium' } }]);

    await editor.getByRole('button', { name: 'Enable stage 2' }).click();
    const toFirst = await callFrom(app, 'execute_aggregate', () =>
      editor.getByRole('button', { name: 'Run pipeline to stage 1' }).click(),
    );
    expect(JSON.parse(String(toFirst.pipeline))).toEqual([{ $match: { tier: 'Premium' } }]);

    await editor.getByRole('button', { name: 'Remove stage 2' }).click();
    await expect(second).toHaveCount(0);
  });

  test('visual query builder writes and applies the filter', async ({ app, page }) => {
    await openCustomers(app, page);

    await view(page).getByTestId('toggle-query-builder').click();
    const panel = view(page).getByTestId('query-builder-panel');
    await panel.locator('[data-testid^="rule-field-"]:not([data-testid^="rule-field-custom-"])').first().selectOption('tier');
    await panel.locator('[data-testid^="rule-operator-"]').first().selectOption('$eq');
    await panel.locator('[data-testid^="rule-value-"]:not([data-testid^="rule-value-exists-"])').first().fill('Premium');

    const applied = await callFrom(app, 'execute_mql_query', () => panel.getByRole('button', { name: 'Apply' }).click());
    expect(JSON.parse(String(applied.filter))).toEqual({ tier: 'Premium' });
    await expect(view(page)).not.toContainText('Bob Johnson');
  });

  test('saves, loads and deletes a query, and pins a default', async ({ app, page }) => {
    await openCustomers(app, page);
    await runFilter(page, '{ tier: "Premium" }');
    await expect(view(page)).not.toContainText('Bob Johnson');

    await view(page).getByRole('button', { name: 'Save query', exact: true }).click();
    await page.getByTestId('save-query-item').click();
    await page.getByTestId('dialog-input').fill('Premium customers');
    const saved = await callFrom(app, 'save_query', () => page.getByTestId('dialog-confirm').click());
    expect(saved).toMatchObject({
      db: 'sales_db',
      collection: 'customers',
      saved: { name: 'Premium customers', query: { queryType: 'find', filter: { tier: 'Premium' } } },
    });
    const id = (saved.saved as { id: string }).id;

    // Loading fills the editor; running then uses it.
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '');
    await view(page).getByRole('button', { name: 'Load query', exact: true }).click();
    // Picking a saved query keeps the menu open, so close it before running.
    await page.getByTestId(`saved-query-${id}`).click();
    await page.keyboard.press('Escape');
    const loaded = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
    expect(JSON.parse(String(loaded.filter))).toEqual({ tier: 'Premium' });

    await view(page).getByRole('button', { name: 'Load query', exact: true }).click();
    const deleted = await callFrom(app, 'delete_saved_query', () => page.getByTestId(`delete-saved-${id}`).click());
    expect(deleted).toMatchObject({ collection: 'customers', id });
    await page.keyboard.press('Escape');

    await view(page).getByRole('button', { name: 'Set default query', exact: true }).click();
    const pinned = await callFrom(app, 'set_default_query', () => page.getByTestId('set-default-item').click());
    expect(pinned.default).toMatchObject({ queryType: 'find', filter: { tier: 'Premium' } });

    await view(page).getByRole('button', { name: 'Set default query', exact: true }).click();
    const cleared = await callFrom(app, 'set_default_query', () => page.getByTestId('clear-default-item').click());
    expect(cleared.default).toBeNull();
  });

  test('query history lists earlier queries and applies one', async ({ app, page }) => {
    await openCustomers(app, page);
    await runFilter(page, '{ tier: "Standard" }');
    await expect(view(page)).not.toContainText('Alice Smith');

    // History loads when a collection tab mounts.
    await openInNewTab(page, 'customers');
    await view(page).getByTestId('history-btn').click();
    const item = page.getByTestId('history-dropdown').getByText(/Standard/).first();
    await expect(item).toBeVisible();
    await item.click();
    const applied = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
    expect(JSON.parse(String(applied.filter))).toEqual({ tier: 'Standard' });
  });

  test('query code is generated for every language', async ({ app, page }) => {
    await openCustomers(app, page);
    await runFilter(page, '{ tier: "Premium" }');

    await view(page).getByTestId('query-code-tab').click();
    const code = view(page).getByTestId('query-code-content');
    const seen = new Set<string>();
    for (const language of ['mongosh', 'Node.js', 'Python', 'Java', 'C#', 'Go']) {
      await view(page).getByTestId('query-code-lang').selectOption(language);
      await expect
        .poll(async () => {
          const text = await getEditorText(page, code);
          return text.includes('Premium') && !seen.has(text);
        }, `${language} code for the query`)
        .toBe(true);
      seen.add(await getEditorText(page, code));
    }
  });

  test('query code carries the projection, sort and skip of a find', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    const options = view(page).getByTestId('query-options-section');
    await setEditorText(page, options.getByTestId('projection-query-input'), '{ name: 1 }');
    await setEditorText(page, options.getByTestId('sort-query-input'), '{ name: -1 }');
    await options.getByRole('spinbutton').first().fill('1');
    await runButton(page).click();
    await expect(view(page)).not.toContainText('Charlie Brown');

    await view(page).getByTestId('query-code-tab').click();
    const code = view(page).getByTestId('query-code-content');
    // What each driver calls the same three options.
    const expected: Record<string, string[]> = {
      mongosh: ['{"name":1}', '.sort({"name":-1})', '.skip(1)'],
      'Node.js': ['.project(', '.sort(', '.skip(1)'],
      Python: [', loads(', '.sort(list(', '.skip(1)'],
      Java: ['.projection(Document.parse(', '.sort(Document.parse(', '.skip(1)'],
      'C#': ['.Project(BsonDocument.Parse(', '.Sort(BsonDocument.Parse(', '.Skip(1)'],
      Go: ['SetProjection(projection)', 'SetSort(sort)', 'SetSkip(1)'],
    };
    for (const [language, fragments] of Object.entries(expected)) {
      await view(page).getByTestId('query-code-lang').selectOption(language);
      for (const fragment of fragments) {
        await expect.poll(() => getEditorText(page, code), `${language} code contains ${fragment}`).toContain(fragment);
      }
    }
  });

  test('query code of an aggregate tab is its pipeline, in every language', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('mode-aggregate-tab').click();
    await setEditorText(page, view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0'), '{ tier: "Premium" }');
    await runButton(page).click();
    await expect(view(page)).not.toContainText('Bob Johnson');

    await view(page).getByTestId('query-code-tab').click();
    const code = view(page).getByTestId('query-code-content');
    const expected: Record<string, string> = {
      mongosh: '.aggregate(',
      'Node.js': 'collection.aggregate(pipeline)',
      Python: 'collection.aggregate(pipeline)',
      Java: 'collection.aggregate(Arrays.asList(',
      'C#': 'collection.Aggregate<BsonDocument>(pipeline)',
      Go: 'collection.Aggregate(ctx, pipeline)',
    };
    for (const [language, fragment] of Object.entries(expected)) {
      await view(page).getByTestId('query-code-lang').selectOption(language);
      await expect.poll(() => getEditorText(page, code), `${language} code for the pipeline`).toContain(fragment);
      expect(await getEditorText(page, code)).toContain('Premium');
    }
  });

  test('compares two documents', async ({ app, page }) => {
    await openCustomers(app, page);

    await jsonLine(page, 'Alice Smith').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare with…', exact: true }).click();
    await jsonLine(page, 'Bob Johnson').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare with selected' }).click();

    const modal = page.getByTestId('document-diff-modal');
    await expect(modal.getByTestId('diff-summary')).toContainText('changed');
    await expect(modal.getByTestId('diff-left')).toContainText('Alice Smith');
    await expect(modal.getByTestId('diff-right')).toContainText('Bob Johnson');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('charts the loaded documents', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'products');
    await expect(view(page)).toContainText('SuperBook Pro');

    await view(page).getByRole('button', { name: 'Chart' }).click();
    const chart = view(page).getByTestId('chart-view');
    await chart.getByRole('combobox', { name: 'X axis' }).click();
    await page.getByRole('option', { name: 'category' }).click();
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(2);
  });

  test('finds text in the loaded results', async ({ app, page }) => {
    await openCustomers(app, page);

    await jsonLine(page, 'Alice Smith').click();
    await page.keyboard.press('ControlOrMeta+f');
    const bar = view(page).getByTestId('results-find-bar');
    await bar.getByTestId('results-find-input').fill('Premium');
    await expect(bar.getByTestId('results-find-status')).toHaveText('1 of 2');
    await page.keyboard.press('Enter');
    await expect(bar.getByTestId('results-find-status')).toHaveText('2 of 2');
    await bar.getByTestId('results-find-input').fill('no such text');
    await expect(bar.getByTestId('results-find-status')).toHaveText('No matches');
    await bar.getByTestId('results-find-close').click();
    await expect(bar).toHaveCount(0);
  });

  test('hovering the sidebar shows database and collection stats', async ({ app, page }) => {
    await app.open();
    await loadSample(page);

    await sidebar(page).getByText('sales_db', { exact: true }).hover();
    const dbCard = page.getByTestId('db-stats-card');
    await expect(dbCard).toContainText('Objects');
    const before = (await app.calls('db_stats')).length;
    await dbCard.getByTestId('stats-refresh').click();
    await expect.poll(async () => (await app.calls('db_stats')).length).toBeGreaterThan(before);
    // Clicking inside the card keeps it open; Escape closes it.
    await page.keyboard.press('Escape');
    await dismissHoverCards(page);

    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).hover();
    await expect(page.getByTestId('coll-stats-card')).toContainText('Documents');
    await dismissHoverCards(page);
  });

  test('explain on a collection scan suggests an index and creates it', async ({ app, page }) => {
    await openCustomers(app, page);
    await runFilter(page, '{ tier: "Premium" }');

    await view(page).getByTestId('explain-plan-tab').click();
    await expect(view(page).getByTestId('index-suggestion-banner')).toBeVisible();
    await view(page).getByTestId('create-suggested-index-btn').click();
    const modal = page.getByTestId('index-modal');
    await expect(modal).toBeVisible();
    const created = await callFrom(app, 'create_index', () => modal.getByTestId('save-index-btn').click());
    expect(typeof created.keys === 'string' ? JSON.parse(created.keys) : created.keys).toEqual({ tier: 1 });
  });

  test('creates a view from a pipeline and opens it', async ({ app, page }) => {
    // The backend checks a view on the sample server and then creates nothing.
    await connectStaging(app, page);

    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Create View' }).click();
    await dismissHoverCards(page);
    const create = page.getByTestId('view-create-btn');

    await create.click();
    await expect(page.getByTestId('view-error')).toHaveText('View name is required.');

    await page.getByTestId('view-name-input').fill('premium_customers');
    await page.getByTestId('view-pipeline-input').fill('{ "$match": 1');
    await create.click();
    await expect(page.getByTestId('view-error')).toContainText('Invalid pipeline JSON');

    await page.getByTestId('view-pipeline-input').fill('[{ "$match": { "tier": "Premium" } }]');
    const created = await callFrom(app, 'create_view', () => create.click());
    expect(created).toMatchObject({ database: 'sales_db', viewName: 'premium_customers', sourceCollection: 'customers' });

    await expect(view(page)).toContainText('Alice Smith');
    await expect(view(page)).not.toContainText('Bob Johnson');
  });

  test('edits a collection\'s validation rules', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Validation Rules' }).click();
    await dismissHoverCards(page);

    const rules = page.getByTestId('validation-rules-view');
    const editor = rules.getByTestId('validation-editor');
    await expect(editor.locator('.monaco-editor')).toBeVisible();

    await setEditorText(page, editor, '[1, 2]');
    await rules.getByTestId('validation-apply-btn').click();
    await expect(rules.getByTestId('validation-error')).toContainText('JSON object');

    await setEditorText(page, editor, '{ "$jsonSchema": { "required": ["email"] } }');
    await rules.getByTestId('validation-level-select').click();
    await page.getByRole('option', { name: 'strict' }).click();
    await rules.getByTestId('validation-action-select').click();
    await page.getByRole('option', { name: 'warn' }).click();
    const applied = await callFrom(app, 'set_validator', () => rules.getByTestId('validation-apply-btn').click());
    expect(applied).toMatchObject({ collection: 'customers', validationLevel: 'strict', validationAction: 'warn' });
    expect(JSON.parse(String(applied.validator))).toEqual({ $jsonSchema: { required: ['email'] } });
    await expect(rules.getByTestId('validation-success')).toBeVisible();
  });
});
