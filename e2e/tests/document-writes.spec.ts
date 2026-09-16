import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { ProfileSeed } from '../harness/seed';
import { callFrom, connectStaging, dismissHoverCards, getEditorText, openCollection, setEditorText, view } from '../helpers';

// Writes to documents past the happy path (#396): the typed-name confirmations
// a guarded connection asks for, cancelled confirmations, duplicates, and the
// refresh that follows a write. On a saved connection: the backend drops every
// write to the sample server.

const sidebar = (page: Page) => page.getByRole('complementary');
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });
const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });
const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();

async function openCustomers(app: App, page: Page, profile: Partial<ProfileSeed> = {}): Promise<void> {
  await connectStaging(app, page, {}, profile);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
}

test.describe('Bulk writes', () => {
  test('a guarded connection asks for the collection name before Delete Many and Update Many', async ({ app, page }) => {
    await openCustomers(app, page, { connection_mode: 'confirm_destructive' });

    await view(page).getByTestId('delete-many-btn').click();
    await page.getByTestId('dialog-input').fill('customers');
    const deleted = await callFrom(app, 'delete_many', () => page.getByTestId('dialog-confirm').click());
    expect(deleted.confirmed).toBe(true);
    await expect(toast(page, 'Deleted')).toBeVisible();

    await view(page).getByTestId('update-many-btn').click();
    await page.getByTestId('dialog-input').fill('{ "$set": { "tier": "Gold" } }');
    await page.getByTestId('dialog-confirm').click();
    // A second prompt, for the name.
    await expect(page.getByTestId('dialog-input')).toHaveValue('');
    await page.getByTestId('dialog-input').fill('customers');
    const updated = await callFrom(app, 'update_many', () => page.getByTestId('dialog-confirm').click());
    expect(updated.confirmed).toBe(true);
  });

  test('cancelling the last confirmation writes nothing', async ({ app, page }) => {
    await openCustomers(app, page);

    await view(page).getByTestId('delete-many-btn').click();
    await page.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('dialog-title')).toHaveCount(0);

    await view(page).getByTestId('update-many-btn').click();
    await page.getByTestId('dialog-input').fill('{ "$set": { "tier": "Gold" } }');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-input')).toHaveCount(0);
    await page.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('dialog-title')).toHaveCount(0);

    expect(await app.calls('delete_many')).toHaveLength(0);
    expect(await app.calls('update_many')).toHaveLength(0);
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
  });

  test('a guarded connection runs an $out stage once its target is typed', async ({ app, page }) => {
    await openCustomers(app, page, { connection_mode: 'confirm_destructive' });
    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    await editor.getByRole('button', { name: 'Add Stage' }).click();
    await editor.getByTestId('pipeline-stage-1').locator('select').selectOption('$out');
    await setEditorText(page, editor.getByTestId('pipeline-stage-1'), '"customers_archive"');

    await runButton(page).click();
    await page.getByTestId('dialog-input').fill('customers_archive');
    const ran = await callFrom(app, 'execute_aggregate', () => page.getByTestId('dialog-confirm').click());
    expect(ran.confirmed).toBe(true);
  });
});

test.describe('Single documents', () => {
  test('Duplicate document opens the insert editor without the _id', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'JSON', exact: true }).click();
    await jsonLine(page, 'Alice Smith').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate document' }).click();

    const modal = page.getByTestId('document-edit-modal');
    await expect.poll(() => getEditorText(page, modal)).toContain('Alice Smith');
    expect(await getEditorText(page, modal)).not.toContain('_id');
    const inserted = await callFrom(app, 'insert_document', () => modal.getByTestId('document-save-btn').click());
    const document = JSON.parse(String(inserted.document));
    expect(document).toMatchObject({ name: 'Alice Smith', email: 'alice@example.com' });
    expect(document._id).toBeUndefined();
    await expect(modal).toHaveCount(0);
  });

  test('will not save an edit to a document shown without its _id', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('projection-query-input'), '{ _id: 0 }');
    await runButton(page).click();
    await expect(view(page)).not.toContainText('603d779f4f102e3a105c3120');

    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect.poll(() => getEditorText(page, modal)).toContain('Alice Smith');
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toContainText('Cannot update: this document has no _id.');
    expect(await app.calls('update_document')).toHaveLength(0);
  });

  test('a delete from a pipeline re-runs it', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('mode-aggregate-tab').click();
    await setEditorText(page, view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0'), '{ tier: "Premium" }');
    await runButton(page).click();
    await expect(view(page).getByText('Bob Johnson')).toHaveCount(0);

    const runs = (await app.calls('execute_aggregate')).length;
    await view(page).getByTestId('delete-doc-btn').first().click();
    await page.getByTestId('dialog-confirm').click();
    await expect(view(page).getByText('Alice Smith')).toHaveCount(0);
    await expect(view(page).getByText('Charlie Brown').first()).toBeVisible();
    expect((await app.calls('execute_aggregate')).length).toBeGreaterThan(runs);
  });

  test('says why the results could not refresh after a delete', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('delete-doc-btn').first().click();
    await app.failNext('execute_mql_query', 'cursor killed by the server');
    await page.getByTestId('dialog-confirm').click();
    await expect(view(page).getByText('cursor killed by the server').first()).toBeVisible();
    expect(await app.calls('delete_document')).toHaveLength(1);
  });

  test('Create Index closes on Cancel without creating one', async ({ app, page }) => {
    await openCustomers(app, page);
    await sidebar(page).getByText('indexes', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Create Index' }).click();
    await dismissHoverCards(page);

    const modal = page.getByTestId('index-modal');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(await app.calls('create_index')).toHaveLength(0);
  });
});

test.describe('Export', () => {
  test('copies the current results, and says when the copy fails', async ({ app, page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard permissions are granted in Chromium only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openCustomers(app, page);
    await view(page).getByTestId('export-btn').click();
    const copy = page.getByTestId('export-view').getByTestId('export-copy-current-btn');

    await copy.click();
    await expect(toast(page, 'Copied 3 document(s) as JSON')).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Alice Smith');

    await app.failNext('format_current_docs', 'unsupported BSON type');
    await copy.click();
    await expect(toast(page, 'Copy failed: unsupported BSON type')).toBeVisible();
  });
});
