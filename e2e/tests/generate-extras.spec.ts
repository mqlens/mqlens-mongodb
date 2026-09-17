import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections, getEditorText, setEditorText } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary');
const generateView = (page: Page) => page.getByTestId('generate-view');

async function openGenerate(page: Page, collection: string): Promise<void> {
  await expandCollections(page, 'sales_db');
  await sidebar(page).getByText(collection, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Generate Data…' }).click();
  await dismissHoverCards(page);
  await expect(generateView(page)).toBeVisible();
}

function fieldNames(view: Locator): Promise<string[]> {
  return view
    .locator('[data-testid^="generate-row-name-"]')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
}

async function rowId(view: Locator, name: string): Promise<string> {
  const ids = await view
    .locator('[data-testid^="generate-row-name-"]')
    .evaluateAll(
      (inputs, wanted) =>
        inputs
          .filter((input) => (input as HTMLInputElement).value === wanted)
          .map((input) => input.getAttribute('data-testid')!.slice('generate-row-name-'.length)),
      name,
    );
  expect(ids, `builder rows named ${name}`).toHaveLength(1);
  return ids[0];
}

// On a saved connection: the backend only validates what it generates for the sample server.
test.describe('Generate templates', () => {
  test.beforeEach(async ({ app, page }) => {
    await connectStaging(app, page);
  });

  test('infers an array of words from the transactions', async ({ page }) => {
    await openGenerate(page, 'transactions');
    const view = generateView(page);
    await expect(view.getByTestId('generate-preview-doc').first()).toContainText('"items":[');
    await expect(view.getByTestId(`generate-row-kind-${await rowId(view, 'items')}`)).toContainText('$array');
  });

  test('reads a raw template into rows, and writes rows back with literals kept literal', async ({ page }) => {
    await openGenerate(page, 'customers');
    const view = generateView(page);
    await expect(view.getByTestId('generate-preview-doc')).toHaveCount(3);
    await view.getByTestId('generate-mode-raw').click();
    const editor = view.getByTestId('generate-raw-editor');
    // It fills in the template itself as it opens; text typed before that would be replaced.
    await expect.poll(() => getEditorText(page, editor)).toContain('"name"');
    await setEditorText(
      page,
      editor,
      JSON.stringify({
        status: 'active',
        visits: 5,
        tags: ['a'],
        nothing: null,
        score: { $float: { min: 1, max: 2 } },
        joined: { $date: { from: '2024-01-01T00:00:00Z', to: '2024-02-01T00:00:00Z' } },
        code: { $literal: '$abc' },
        ref: { $literal: { a: { $oid: 'x' } } },
        who: '$name',
        first: '$firstName',
        last: '$lastName',
        oid: '$objectId',
        key: '$uuid',
        vip: '$bool',
      }),
    );
    await expect(view.getByTestId('generate-mode-builder')).toBeEnabled();
    await view.getByTestId('generate-mode-builder').click();
    await expect.poll(() => fieldNames(view)).toEqual(expect.arrayContaining(['status', 'visits', 'tags', 'score', 'joined', 'code', 'who', 'vip']));

    // An edit in the builder writes the template again from the rows.
    await view.getByTestId('generate-add-field-root').click();
    await view.getByTestId('generate-mode-raw').click();
    await expect.poll(() => getEditorText(page, editor)).toContain('"$literal": "$abc"');
    expect(await getEditorText(page, editor)).toContain('"$firstName"');
    await expect(view.getByTestId('generate-preview-doc').first()).toContainText('"code":"$abc"');
  });

  test('says what a raw template cannot use', async ({ page }) => {
    await openGenerate(page, 'customers');
    const view = generateView(page);
    await expect(view.getByTestId('generate-preview-doc')).toHaveCount(3);
    await view.getByTestId('generate-mode-raw').click();
    const editor = view.getByTestId('generate-raw-editor');
    // It fills in the template itself as it opens; text typed before that would be replaced.
    await expect.poll(() => getEditorText(page, editor)).toContain('"name"');

    await setEditorText(page, editor, '{ "x": { "$foo": {} } }');
    await expect(view.getByTestId('generate-custom-notice')).toBeVisible();
    await expect(view.getByTestId('generate-preview-error')).toContainText('unknown generator "$foo"');

    await setEditorText(page, editor, '{ "d": { "$date": {} } }');
    await expect(view.getByTestId('generate-preview-error')).toContainText('past_days');

    await setEditorText(page, editor, '{ "p": { "$float": { "min": 1 } } }');
    await expect(view.getByTestId('generate-custom-notice')).toBeVisible();

    await setEditorText(page, editor, '{ "sku": ');
    await expect(view.getByTestId('generate-preview-error')).toContainText('Invalid JSON');
  });

  test('switches a row between kinds, and reads literal and pick values as JSON when they are', async ({ page }) => {
    await openGenerate(page, 'customers');
    const view = generateView(page);
    const previews = view.getByTestId('generate-preview-doc');
    await expect(previews).toHaveCount(3);

    await view.getByTestId('generate-add-field-root').click();
    const id = await rowId(view, 'field6');
    const row = view.getByTestId(`generate-row-${id}`);
    const kind = async (label: string) => {
      await view.getByTestId(`generate-row-kind-${id}`).click();
      await page.getByRole('option', { name: label, exact: true }).click();
    };

    await kind('Literal value');
    const literal = row.getByRole('textbox', { name: 'Literal value' });
    await literal.fill('42');
    await expect(previews.first()).toContainText('"field6":42');
    await literal.fill('hello');
    await expect(previews.first()).toContainText('"field6":"hello"');

    await kind('Lorem text ($lorem)');
    await expect(row.getByText(/words/i).first()).toBeVisible();
    await kind('Date ($date)');
    await kind('UUID ($uuid)');
    await kind('Array of… ($array)');
    await expect(previews.first()).toContainText('"field6":[');
    await kind('Nested object');
    await expect(view.getByTestId(`generate-add-field-${id}`)).toBeVisible();
    await expect(previews.first()).toContainText('"field6":{');

    const tier = view.getByTestId(`generate-row-${await rowId(view, 'tier')}`);
    await tier.getByRole('textbox', { name: 'Pick value 1' }).fill('7');
    await tier.getByRole('textbox', { name: 'Pick value 2' }).fill('7');
    await expect(previews.first()).toContainText('"tier":7');
  });

  test('says why the template could not be inferred', async ({ app, page }) => {
    await app.failNext('infer_generate_template', 'schema sampling failed');
    await openGenerate(page, 'customers');
    await expect(generateView(page).getByTestId('generate-error')).toContainText('schema sampling failed');
    await expect(generateView(page).getByTestId('generate-run-btn')).toHaveCount(0);
  });
});
