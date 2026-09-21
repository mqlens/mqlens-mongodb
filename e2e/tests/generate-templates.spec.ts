import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections, getEditorText, setEditorText } from '../helpers';

// The generator template (#396): every shape the field builder cannot show,
// and the options each kind of field offers.

const sidebar = (page: Page) => page.getByRole('complementary');
const generateView = (page: Page) => page.getByTestId('generate-view');

/** Templates the builder has no rows for: raw JSON editing only. */
const UNREPRESENTABLE = [
  // A generator at the root is not a document shape.
  '{ "$int": { "min": 1, "max": 2 } }',
  // Options that are not an object, or not of the type the generator takes.
  '{ "a": { "$int": 5 } }',
  '{ "a": { "$int": { "min": "x" } } }',
  '{ "a": { "$float": { "min": 1 } } }',
  '{ "a": { "$float": { "min": 1, "max": 2, "decimals": "two" } } }',
  '{ "a": { "$date": { "past_days": "x" } } }',
  '{ "a": { "$date": { "from": 1, "to": "2024-02-01" } } }',
  '{ "a": { "$date": {} } }',
  '{ "a": { "$lorem": {} } }',
  '{ "a": { "$pick": "one" } }',
  '{ "a": { "$pick": [{ "not": "scalar" }] } }',
  '{ "a": { "$array": { "min": 1, "max": 2 } } }',
  '{ "a": { "$array": { "min": 1, "max": 2, "of": "$nope" } } }',
  // Two generators in one field, and a generator nobody knows.
  '{ "a": { "$int": { "min": 1, "max": 2 }, "$lorem": { "words": 1 } } }',
  '{ "a": { "$foo": 1 } }',
  // Unknown, one level down.
  '{ "a": { "b": "$foo" } }',
];

/** Templates the builder shows as rows. */
const REPRESENTABLE = [
  '{ "a": { "$literal": { "kept": 1 } } }',
  '{ "a": [1, 2] }',
  '{ "a": { "$date": { "from": "2024-01-01", "to": "2024-02-01" } } }',
  '{ "a": { "$lorem": { "words": 3 } } }',
];

async function openGenerate(page: Page, collection: string): Promise<void> {
  await expandCollections(page, 'sales_db');
  await sidebar(page).getByText(collection, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Generate Data…' }).click();
  await dismissHoverCards(page);
  await expect(generateView(page)).toBeVisible();
}

/** The builder's id for the row whose field is named `name`. */
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

test.describe('Templates the builder cannot show', () => {
  test('falls back to raw JSON for every shape it has no row for', async ({ app, page }) => {
    await connectStaging(app, page);
    await openGenerate(page, 'customers');
    const view = generateView(page);
    await view.getByTestId('generate-mode-raw').click();
    const editor = view.getByTestId('generate-raw-editor');
    const notice = view.getByTestId('generate-custom-notice');
    await expect.poll(() => getEditorText(page, editor)).toContain('"address"');

    for (const template of UNREPRESENTABLE) {
      // A template it can show, so the notice below is this template's own.
      await setEditorText(page, editor, '{ "a": "$uuid" }');
      await expect(notice).toHaveCount(0);

      await setEditorText(page, editor, template);
      await expect(notice, template).toBeVisible();
      await expect(view.getByTestId('generate-mode-builder'), template).toBeDisabled();
    }

    for (const template of REPRESENTABLE) {
      await setEditorText(page, editor, template);
      await expect(notice, template).toHaveCount(0);
      await expect(view.getByTestId('generate-mode-builder'), template).toBeEnabled();
    }
  });
});

test.describe('The options a field offers', () => {
  test('edits each kind of generated field', async ({ app, page }) => {
    await connectStaging(app, page);
    await openGenerate(page, 'customers');
    const view = generateView(page);

    await view.getByTestId('generate-mode-raw').click();
    const editor = view.getByTestId('generate-raw-editor');
    await expect.poll(() => getEditorText(page, editor)).toContain('"address"');
    await setEditorText(
      page,
      editor,
      '{ "ratio": { "$float": { "min": 0, "max": 1, "decimals": 2 } }, "blurb": { "$lorem": { "words": 2 } },' +
        ' "seen": { "$date": { "past_days": 30 } }, "tags": { "$array": { "min": 1, "max": 2, "of": "$uuid" } },' +
        ' "tier": { "$pick": ["gold", "silver"] } }',
    );
    await view.getByTestId('generate-mode-builder').click();
    const preview = view.getByTestId('generate-preview-doc').first();
    await expect(preview).toContainText('"ratio"');

    // A float pinned to one value, with no decimals to spare.
    const ratio = view.getByTestId(`generate-row-${await rowId(view, 'ratio')}`);
    await ratio.getByLabel('Minimum', { exact: true }).fill('5');
    await ratio.getByLabel('Maximum', { exact: true }).fill('5');
    await ratio.getByLabel('Decimals', { exact: true }).fill('1');
    await expect(preview).toContainText('"ratio":5');

    // One word of lorem, and one day of history.
    const blurb = view.getByTestId(`generate-row-${await rowId(view, 'blurb')}`);
    await blurb.getByLabel('Words', { exact: true }).fill('1');
    const seen = view.getByTestId(`generate-row-${await rowId(view, 'seen')}`);
    await seen.getByLabel('Past days', { exact: true }).fill('1');

    // An array of exactly two integers, both 7.
    const tags = view.getByTestId(`generate-row-${await rowId(view, 'tags')}`);
    await tags.getByLabel('Array minimum length').fill('2');
    await tags.getByLabel('Array maximum length').fill('2');
    await tags.getByTestId(/generate-row-kind-/).last().click();
    await page.getByRole('option', { name: /\$int\b/ }).click();
    await tags.getByLabel('Minimum', { exact: true }).fill('7');
    await tags.getByLabel('Maximum', { exact: true }).fill('7');
    await expect(preview).toContainText('"tags":[7,7]');

    // Its options sent as the builder holds them.
    await view.getByTestId('generate-mode-raw').click();
    const text = await getEditorText(page, editor);
    expect(JSON.parse(text)).toMatchObject({
      ratio: { $float: { min: 5, max: 5, decimals: 1 } },
      blurb: { $lorem: { words: 1 } },
      seen: { $date: { past_days: 1 } },
      tags: { $array: { min: 2, max: 2, of: { $int: { min: 7, max: 7 } } } },
    });

    // A pick with nothing left to pick from cannot generate anything.
    await view.getByTestId('generate-mode-builder').click();
    const tier = view.getByTestId(`generate-row-${await rowId(view, 'tier')}`);
    await tier.getByLabel('Remove pick value 2').click();
    await tier.getByLabel('Remove pick value 1').click();
    await expect(view.getByTestId('generate-pick-empty')).toBeVisible();
    await expect(view.getByTestId('generate-run-btn')).toBeDisabled();
  });
});
