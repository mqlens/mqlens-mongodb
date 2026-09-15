import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, dismissHoverCards, loadSample, openCollection, setEditorText, view } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary').first();
const suggestions = (page: Page) => page.locator('.suggest-widget.visible');

/** Empty the Monaco editor inside `container`, click into it, and type as a person would. */
async function typeInto(page: Page, container: Locator, text: string): Promise<void> {
  await setEditorText(page, container, '');
  await container.locator('.monaco-editor').first().click();
  await page.keyboard.type(text, { delay: 40 });
  // Ask for suggestions outright, as Ctrl+Space does, rather than depending on
  // the trigger character's timing.
  await page.keyboard.press('Control+Space');
}

/**
 * The suggestions include `label`. Field names arrive with the collection's
 * schema, so the list can first open on only the language's own words; close
 * it and ask again until they're in. When they never come, the failure lists
 * the schema requests the app made, which is where field names come from.
 */
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
  await page.keyboard.press('Escape');
}

async function openCustomers(app: App, page: Page): Promise<void> {
  await app.open();
  await loadSample(page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
}

test.describe('Editor completions', () => {
  test('suggest fields and operators in the filter, projection and sort editors', async ({ app, page }) => {
    await openCustomers(app, page);

    await typeInto(page, view(page).getByTestId('query-filter-input'), '{ tie');
    await expectSuggestion(app, page, 'tier');
    await typeInto(page, view(page).getByTestId('query-filter-input'), '{ tier: { $e');
    await expectSuggestion(app, page, '$eq');

    await view(page).getByTestId('query-options-toggle').click();
    await typeInto(page, view(page).getByTestId('projection-query-input'), '{ ema');
    await expectSuggestion(app, page, 'email');
    await typeInto(page, view(page).getByTestId('sort-query-input'), '{ joi');
    await expectSuggestion(app, page, 'joined');
  });

  test('suggest stage bodies in the aggregation builder', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    const stage = editor.getByTestId('pipeline-stage-0');

    await stage.locator('select').selectOption('$group');
    await typeInto(page, stage, '{ _id: null, total: { $su');
    await expectSuggestion(app, page, '$sum');

    await stage.locator('select').selectOption('$project');
    await typeInto(page, stage, '{ ti');
    await expectSuggestion(app, page, 'tier');

    await stage.locator('select').selectOption('$lookup');
    await typeInto(page, stage, '{ fr');
    await expectSuggestion(app, page, 'from');
  });
});

test.describe('Index modal', () => {
  test('edits an index through raw JSON and the key builder, checking what it accepts', async ({ app, page }) => {
    await openCustomers(app, page);
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('email_1', { exact: true }).click();
    await dismissHoverCards(page);
    await view(page).getByTestId('index-viewer').getByTestId('edit-index-btn').click();

    const modal = page.getByTestId('index-modal');
    await expect(modal).toContainText('Edit Index definition');
    const save = modal.getByTestId('save-index-btn');

    await modal.getByRole('tab', { name: 'Raw JSON' }).click();
    const raw = modal.locator('textarea');
    await raw.fill('[1]');
    await save.click();
    await expect(modal).toContainText('Index keys must be a JSON object');
    await raw.fill('{ bad');
    await save.click();
    // The parser's own message, which differs by browser.
    await expect(modal).toContainText(/Unexpected|Expected|Parse error|token/i);
    await raw.fill('{ "email": -1 }');

    await modal.getByRole('tab', { name: 'Key Builder' }).click();
    await expect(modal.getByTestId('index-key-direction-0')).toHaveValue('-1');
    await modal.getByRole('button', { name: 'Add Index Key' }).click();
    await expect(modal.getByTestId('index-key-field-1')).toBeVisible();
    await modal.getByTitle('Remove key').last().click();
    await expect(modal.getByTestId('index-key-field-1')).toHaveCount(0);

    await modal.getByTestId('index-name-input').fill('   ');
    await save.click();
    await expect(modal).toContainText('Index name is required');
    await modal.getByTestId('index-name-input').fill('email_-1');
    const created = await callFrom(app, 'create_index', () => save.click());
    expect(typeof created.keys === 'string' ? JSON.parse(created.keys) : created.keys).toEqual({ email: -1 });
  });
});

test.describe('Data generation builder', () => {
  test('switches fields between generators and shows their options', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Generate Data…' }).click();
    await dismissHoverCards(page);
    const generate = page.getByTestId('generate-view');
    const previews = generate.getByTestId('generate-preview-doc');
    await expect(previews.first()).toBeVisible();

    const row = async (name: string) => {
      const ids = await generate
        .locator('[data-testid^="generate-row-name-"]')
        .evaluateAll((inputs, wanted) => inputs.filter((i) => (i as HTMLInputElement).value === wanted).map((i) => i.getAttribute('data-testid')!.slice('generate-row-name-'.length)), name);
      return generate.getByTestId(`generate-row-${ids[0]}`);
    };
    const kind = async (field: string, option: RegExp) => {
      await (await row(field)).locator('[data-testid^="generate-row-kind-"]').click();
      await page.getByRole('option', { name: option }).click();
    };

    await kind('name', /\$float/);
    const floatRow = await row('name');
    await floatRow.getByRole('spinbutton').nth(2).fill('1');
    await expect(previews.first()).toContainText('"name":');

    await kind('email', /\$pick/);
    const pickRow = await row('email');
    await pickRow.getByRole('button', { name: /add value/i }).click();
    await pickRow.getByRole('textbox').last().fill('vip');
    await expect(previews.first()).toContainText('"email":');

    await kind('createdAt', /\$date/);
    const dateRow = await row('createdAt');
    await dateRow.getByRole('combobox').nth(1).click();
    await page.getByRole('option', { name: 'From / to' }).click();
    await dateRow.getByPlaceholder('from (ISO)').fill('2024-01-01T00:00:00Z');
    await dateRow.getByPlaceholder('to (ISO)').fill('2024-12-31T00:00:00Z');
    await expect(previews.first()).toContainText('2024');
  });
});

test.describe('Write stages on a confirm-destructive connection', () => {
  test('$merge and $out variants ask for the name; a pipeline without one runs', async ({ app, page }) => {
    const uri = 'mongodb://staging.example:27017';
    await app.open({
      profiles: [{ id: 'p-staging', name: 'Staging', uri, connection_mode: 'confirm_destructive' }],
      servers: { [uri]: SAMPLE_SERVER },
    });
    await page.getByTestId('conn-card-p-staging').click();
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    await editor.getByRole('button', { name: 'Add Stage' }).click();
    const write = editor.getByTestId('pipeline-stage-1');
    const run = view(page).getByRole('button', { name: 'Run', exact: true });

    const expectPrompt = async () => {
      await run.click();
      await expect(page.getByTestId('dialog-input')).toBeVisible();
      await page.getByTestId('dialog-cancel').click();
    };

    await write.locator('select').selectOption('$merge');
    await expectPrompt();
    await setEditorText(page, write, '{ into: { db: "archive", coll: "customers" } }');
    await expectPrompt();
    await setEditorText(page, write, '"archive_customers"');
    await expectPrompt();

    await write.locator('select').selectOption('$out');
    await setEditorText(page, write, '{ db: "archive", coll: "customers" }');
    await expectPrompt();

    expect(await app.calls('execute_aggregate')).toHaveLength(0);
    await editor.getByRole('button', { name: 'Remove stage 2' }).click();
    await callFrom(app, 'execute_aggregate', () => run.click());
  });
});
