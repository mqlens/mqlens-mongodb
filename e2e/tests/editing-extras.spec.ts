import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections, openCollection, setEditorText, view } from '../helpers';

// Smaller corners of editing (#396): validation rules that cannot be read or
// written, documents that are not documents, a write stage with no collection
// to name, the menus a right-click opens, and Ctrl+Enter to run.

const sidebar = (page: Page) => page.getByRole('complementary');
const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();

async function openValidation(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await expandCollections(page, 'sales_db');
  await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Validation Rules' }).click();
  await dismissHoverCards(page);
}

test.describe('Validation rules', () => {
  test('says why they could not be read', async ({ app, page }) => {
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await app.failNext('get_collection_options', 'not authorized on sales_db to run listCollections');
    await page.getByRole('menuitem', { name: 'Validation Rules' }).click();
    await dismissHoverCards(page);

    await expect(page.getByTestId('validation-rules-view')).toContainText('not authorized on sales_db');
  });

  test('checks the rules before sending them, and says why they were refused', async ({ app, page }) => {
    await openValidation(app, page);
    const rules = page.getByTestId('validation-rules-view');

    await setEditorText(page, rules.getByTestId('validation-editor'), '{ "$jsonSchema": ');
    await rules.getByTestId('validation-apply-btn').click();
    await expect(rules.getByTestId('validation-error')).toContainText('Invalid validator JSON');
    expect(await app.calls('set_validator')).toHaveLength(0);

    await setEditorText(page, rules.getByTestId('validation-editor'), '{ "tier": { "$exists": true } }');
    await app.failNext('set_validator', 'not authorized on sales_db to run collMod');
    await rules.getByTestId('validation-apply-btn').click();
    await expect(rules.getByTestId('validation-error')).toContainText('not authorized on sales_db to run collMod');
  });
});

test.describe('A document that is not a document', () => {
  test('is refused before it is sent', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('insert-doc-btn').click();
    const modal = page.getByTestId('document-edit-modal');
    const save = modal.getByTestId('document-save-btn');

    await setEditorText(page, modal, '{ "name": ');
    await expect(modal.getByTestId('document-edit-error')).toContainText('Invalid document');
    await expect(save).toBeDisabled();

    // A list of documents is not one document.
    await setEditorText(page, modal, '[{ "name": "Dana White" }]');
    await expect(modal.getByTestId('document-edit-error')).toContainText('must be an object');
    await expect(save).toBeDisabled();

    await setEditorText(page, modal, '   ');
    await expect(modal.getByTestId('document-edit-error')).toContainText('empty');
    expect(await app.calls('insert_document')).toHaveLength(0);
  });
});

test.describe('A write stage with no collection named', () => {
  test('asks to confirm without a name to type', async ({ app, page }) => {
    await connectStaging(app, page, {}, { connection_mode: 'confirm_destructive' });
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    await editor.getByRole('button', { name: 'Add Stage' }).click();
    const write = editor.getByTestId('pipeline-stage-1');
    const run = view(page).getByRole('button', { name: 'Run', exact: true });

    // A database with no collection beside it: there is no target name to ask for.
    await write.locator('select').selectOption('$out');
    await setEditorText(page, write, '{ db: "archive" }');
    await run.click();
    await expect(page.getByTestId('dialog-input')).toBeVisible();
    await page.getByTestId('dialog-cancel').click();

    await write.locator('select').selectOption('$merge');
    await setEditorText(page, write, '{ into: { db: "archive" } }');
    await run.click();
    await expect(page.getByTestId('dialog-input')).toBeVisible();
    await page.getByTestId('dialog-cancel').click();

    expect(await app.calls('execute_aggregate')).toHaveLength(0);
  });
});

test.describe('The menu a right-click opens', () => {
  test('closes on Escape, on a click elsewhere, and when the tab is left', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).locator('[data-json-line]').first()).toBeVisible();
    const menu = page.getByTestId('context-menu');

    await jsonLine(page, 'Alice Smith').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    await jsonLine(page, 'Alice Smith').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await view(page).getByTestId('query-filter-input').click();
    await expect(menu).toHaveCount(0);

    // A menu left open belongs to the tab it was opened in, not the next one.
    await jsonLine(page, 'Alice Smith').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await sidebar(page).getByText('products', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(menu).toHaveCount(0);
  });
});

test.describe('Running from the editor', () => {
  test('Ctrl+Enter runs the query from wherever it is typed', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');
    const before = (await app.calls('execute_mql_query')).length;

    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await view(page).getByTestId('query-filter-input').locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+Enter');

    await expect.poll(async () => (await app.calls('execute_mql_query')).length).toBeGreaterThan(before);
    await expect(view(page)).not.toContainText('Bob Johnson');
  });
});
