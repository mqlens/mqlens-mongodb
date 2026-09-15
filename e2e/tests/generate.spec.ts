import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_URI } from '../harness/seed';
import { connectStaging, dismissHoverCards, expandCollections, getEditorText, loadSample, setEditorText, STAGING_URI } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary');
const generateView = (page: Page) => page.getByTestId('generate-view');

/** Open Generate Data from a collection's context menu, or the database's when no collection is given. */
async function openGenerate(page: Page, collection?: string): Promise<void> {
  if (collection) {
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText(collection, { exact: true }).click({ button: 'right' });
  } else {
    await sidebar(page).getByText('sales_db', { exact: true }).click({ button: 'right' });
  }
  await page.getByRole('menuitem', { name: 'Generate Data…' }).click();
  await dismissHoverCards(page);
  await expect(generateView(page)).toBeVisible();
}

/** The field names in the builder, top to bottom. */
function fieldNames(view: Locator): Promise<string[]> {
  return view
    .locator('[data-testid^="generate-row-name-"]')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
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

const docCount = (page: Page, uri: string, db: string, coll: string) =>
  page.evaluate(
    ([server, database, collection]) =>
      window.__MQLENS_E2E__!.state.servers[server].databases[database]?.[collection]?.docs.length ?? 0,
    [uri, db, coll] as const,
  );

// On a saved connection: the backend only validates what it generates for the sample server.
test.describe('Generate data', () => {
  test.beforeEach(async ({ app, page }) => {
    await connectStaging(app, page);
  });

  test('seeds the builder from the collection\'s schema and previews documents', async ({ app, page }) => {
    await openGenerate(page, 'customers');
    const view = generateView(page);

    await expect(view.locator('[data-testid^="generate-row-name-"]').first()).toBeVisible();
    expect(await fieldNames(view)).toEqual(['address', 'city', 'state', 'email', 'joined', 'name', 'tier']);

    const previews = view.getByTestId('generate-preview-doc');
    await expect(previews).toHaveCount(3);
    await expect(previews.first()).toContainText('@example.com');

    await view.getByTestId('generate-seed-input').fill('42');
    await expect
      .poll(async () => (await app.calls('preview_generated_documents')).some((call) => (call.args as { seed?: number }).seed === 42))
      .toBe(true);
  });

  test('builds a template field by field', async ({ page }) => {
    await openGenerate(page, 'customers');
    const view = generateView(page);
    const previews = view.getByTestId('generate-preview-doc');
    await expect(previews).toHaveCount(3);

    await view.getByTestId('generate-add-field-root').click();
    const id = await rowId(view, 'field6');
    await view.getByTestId(`generate-row-kind-${id}`).click();
    await page.getByRole('option', { name: /\$int\b/ }).click();
    const bounds = view.getByTestId(`generate-row-${id}`).locator('input[type="number"]');
    await bounds.nth(0).fill('5');
    await bounds.nth(1).fill('5');
    await view.getByTestId(`generate-row-name-${id}`).fill('score');
    await expect(previews.first()).toContainText('"score":5');

    await view.getByTestId(`generate-row-remove-${await rowId(view, 'tier')}`).click();
    await expect(previews.first()).not.toContainText('"tier"');

    // A new row is named after the count of its siblings: five are left, so field6.
    await view.getByTestId('generate-add-object-root').click();
    const objectId = await rowId(view, 'field6');
    await view.getByTestId(`generate-add-field-${objectId}`).click();
    await expect(previews.first()).toContainText('"field6":{"field1":');

    await view.getByTestId('generate-add-array-root').click();
    await expect(previews.first()).toContainText('"field7":[');
  });

  test('edits the raw template, and says what is wrong with one it can\'t use', async ({ page }) => {
    await openGenerate(page, 'customers');
    const view = generateView(page);
    await view.getByTestId('generate-mode-raw').click();
    const editor = view.getByTestId('generate-raw-editor');
    const run = view.getByTestId('generate-run-btn');
    // The raw editor opens on the template inferred from the collection.
    await expect.poll(() => getEditorText(page, editor)).toContain('"address"');

    await setEditorText(page, editor, '{ "sku": "$uuid", "tags": { "$pick": [] } }');
    await expect(view.getByTestId('generate-footer-empty-pick')).toContainText('tags');
    await expect(view.getByTestId('generate-preview-error')).toContainText('tags');
    await expect(run).toBeDisabled();

    await setEditorText(page, editor, '{ "sku": "$nope" }');
    await expect(view.getByTestId('generate-custom-notice')).toBeVisible();
    await expect(view.getByTestId('generate-mode-builder')).toBeDisabled();
    await expect(view.getByTestId('generate-preview-error')).toContainText('unknown generator "$nope"');

    await setEditorText(page, editor, '{ "sku": ');
    await expect(view.getByTestId('generate-preview-error')).toBeVisible();
    await expect(view.getByTestId('generate-preview-doc')).toHaveCount(0);

    await setEditorText(page, editor, '{ "sku": "$uuid", "qty": { "$int": { "min": 1, "max": 1 } } }');
    await expect(view.getByTestId('generate-custom-notice')).toHaveCount(0);
    await expect(view.getByTestId('generate-preview-doc').first()).toContainText('"qty":1');
    await view.getByTestId('generate-mode-builder').click();
    expect(await fieldNames(view)).toEqual(['sku', 'qty']);
  });

  test('generates documents into the collection once confirmed', async ({ app, page }) => {
    await openGenerate(page, 'customers');
    const view = generateView(page);
    await expect(view.getByTestId('generate-preview-doc')).toHaveCount(3);
    await view.getByTestId('generate-count-input').fill('5');

    await view.getByTestId('generate-run-btn').click();
    await expect(page.getByTestId('dialog-title')).toHaveText('Generate documents');
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('start_generate_task')).toHaveLength(0);

    await view.getByTestId('generate-run-btn').click();
    await page.getByTestId('dialog-confirm').click();

    await expect(view.getByTestId('generate-task-message')).toHaveText('Inserted 5 documents');
    const starts = await app.calls('start_generate_task');
    expect(starts).toHaveLength(1);
    expect(starts[0].args).toMatchObject({ database: 'sales_db', collection: 'customers', count: 5, seed: null });
    expect(await docCount(page, STAGING_URI, 'sales_db', 'customers')).toBe(8);
  });

  test('checks the count and seed, and asks for a large count to be typed', async ({ app, page }) => {
    await openGenerate(page, 'customers');
    const view = generateView(page);
    const count = view.getByTestId('generate-count-input');
    const seed = view.getByTestId('generate-seed-input');
    const run = view.getByTestId('generate-run-btn');
    await expect(view.getByTestId('generate-preview-doc')).toHaveCount(3);

    for (const bad of ['', '2.5', '50001']) {
      await count.fill(bad);
      await expect(view.getByTestId('generate-count-error')).toBeVisible();
      await expect(run).toBeDisabled();
    }
    await count.fill('2000');
    await expect(view.getByTestId('generate-count-error')).toHaveCount(0);

    for (const bad of ['-3', '1.5']) {
      await seed.fill(bad);
      await expect(view.getByTestId('generate-seed-error')).toBeVisible();
      await expect(run).toBeDisabled();
    }
    await seed.fill('7');
    await expect(view.getByTestId('generate-seed-error')).toHaveCount(0);

    await run.click();
    await page.getByTestId('dialog-confirm').click();
    // Over a thousand documents, the count has to be typed to go ahead.
    await expect(page.getByTestId('dialog-title')).toHaveText('Confirm count');
    await page.getByTestId('dialog-input').fill('2000');
    await page.getByTestId('dialog-confirm').click();

    await expect.poll(async () => (await app.calls('start_generate_task')).length).toBe(1);
    expect((await app.calls('start_generate_task'))[0].args).toMatchObject({ count: 2000, seed: 7 });
  });

  test('from a database, asks for a target collection and creates it', async ({ page }) => {
    await openGenerate(page);
    const view = generateView(page);
    const run = view.getByTestId('generate-run-btn');

    expect(await fieldNames(view)).toEqual(['name', 'email', 'createdAt']);
    await expect(run).toBeDisabled();
    await view.getByTestId('generate-target-collection-input').fill('leads');
    await expect(run).toBeEnabled();

    await view.getByTestId('generate-count-input').fill('3');
    await run.click();
    await page.getByTestId('dialog-confirm').click();

    await expect(view.getByTestId('generate-task-message')).toHaveText('Inserted 3 documents');
    expect(await docCount(page, STAGING_URI, 'sales_db', 'leads')).toBe(3);
  });
});

test.describe('Generate data on the sample connection', () => {
  test('validates the documents without writing them', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openGenerate(page, 'customers');
    const view = generateView(page);
    await expect(view.getByTestId('generate-preview-doc')).toHaveCount(3);
    await view.getByTestId('generate-count-input').fill('5');

    await view.getByTestId('generate-run-btn').click();
    await page.getByTestId('dialog-confirm').click();

    await expect(view.getByTestId('generate-task-message')).toHaveText('Validated 5 documents (mock connection — not written)');
    expect(await docCount(page, SAMPLE_URI, 'sales_db', 'customers')).toBe(3);
  });
});
