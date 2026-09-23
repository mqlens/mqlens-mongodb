import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, getEditorText, loadSample, openCollection, setEditorText, view } from '../helpers';

// Completions outside the query bar (#396): the pipeline an export writes, the
// documents inside $elemMatch, and the editors that spell their keys in JSON.

const sidebar = (page: Page) => page.getByRole('complementary');
const suggestions = (page: Page) => page.locator('.suggest-widget.visible');

/** Empty the editor in `container`, type as a person would, and ask for suggestions. */
async function typeInto(page: Page, container: Locator, text: string): Promise<void> {
  await setEditorText(page, container, '');
  await container.locator('.monaco-editor').first().click();
  await page.keyboard.type(text, { delay: 40 });
  await page.keyboard.press('Control+Space');
}

/** The suggestions include `label`, once the collection's schema has arrived. */
async function expectSuggestion(app: App, page: Page, label: string): Promise<void> {
  try {
    await expect(async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+Space');
      await expect(suggestions(page)).toContainText(label, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  } catch (error) {
    const schema = (await app.calls('analyze_schema')).map((call) => ({ args: call.args, error: call.error }));
    throw new Error(`${String(error)}\nanalyze_schema calls: ${JSON.stringify(schema)}`);
  }
}

test.describe('Completions in an export pipeline', () => {
  test('suggests the stages, and the accumulators inside a $group', async ({ app, page }) => {
    // A saved connection: the sample server refuses pipelines, so no aggregate would run.
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'transactions');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const stage = view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0');
    await setEditorText(page, stage, '{ status: "Completed" }');
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await view(page).getByTestId('export-btn').click();
    const pipeline = page.getByTestId('export-view').getByTestId('export-filtered-pipeline-input');

    await typeInto(page, pipeline, '[{ $ma');
    await expectSuggestion(app, page, '$match');
    await page.keyboard.press('Escape');

    // Inside a $group, the keys are accumulators and the fields of the collection.
    await typeInto(page, pipeline, '[{ $group: { total: { $s');
    await expectSuggestion(app, page, '$sum');
    await page.keyboard.press('Escape');
  });
});

test.describe('Completions inside a matched element', () => {
  test('offers the fields of the element, in a filter and in a projection', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'transactions');

    await typeInto(page, view(page).getByTestId('query-filter-input'), '{ items: { $elemMatch: { ');
    await expectSuggestion(app, page, 'status');
    await page.keyboard.press('Escape');

    await view(page).getByTestId('query-options-toggle').click();
    const projection = view(page).getByTestId('projection-query-input');
    await typeInto(page, projection, '{ items: { $elemMatch: { ');
    await expectSuggestion(app, page, 'amount');
    await page.keyboard.press('Escape');
  });

  test('a $sortByCount stage takes a field path', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const stage = view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0');

    await stage.locator('select').selectOption('$sortByCount');
    await typeInto(page, stage, '"$ti');
    await expectSuggestion(app, page, '$tier');
    await page.keyboard.press('Escape');
  });
});

test.describe('Completions in a JSON editor', () => {
  test('quotes the key it inserts, and does not quote it twice', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Validation Rules' }).click();
    await dismissHoverCards(page);
    const editor = page.getByTestId('validation-editor');
    await expect(editor).toBeVisible();

    // This editor is JSON, not the shell, so the key it inserts is quoted.
    await typeInto(page, editor, '{ _i');
    await expect(suggestions(page)).toContainText('_id');
    await page.keyboard.press('Tab');
    await expect.poll(() => getEditorText(page, editor)).toContain('"_id"');

    // A quote the user opened is closed, not doubled.
    await typeInto(page, editor, '{ "_i');
    await expect(suggestions(page)).toContainText('_id');
    await page.keyboard.press('Tab');
    await expect.poll(() => getEditorText(page, editor)).toContain('"_id"');
    expect(await getEditorText(page, editor)).not.toContain('""');

    // An operator is quoted the same way.
    await typeInto(page, editor, '{ $an');
    await expect(suggestions(page)).toContainText('$and');
    await page.keyboard.press('Tab');
    await expect.poll(() => getEditorText(page, editor)).toContain('"$and"');
  });
});
