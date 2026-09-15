import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, loadSample, openCollection, setEditorText } from '../helpers';

const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');

async function runFilter(page: Page, filter: string): Promise<void> {
  await setEditorText(page, view(page).getByTestId('query-filter-input'), filter);
  await view(page).getByRole('button', { name: 'Run', exact: true }).click();
}

// On a saved connection: the backend drops every write to the sample server.
test.describe('Documents in a collection', () => {
  test.beforeEach(async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
  });

  test('a shell-syntax filter narrows the results', async ({ app, page }) => {
    await runFilter(page, '{ tier: "Premium" }');

    await expect(view(page).getByText('Bob Johnson')).toHaveCount(0);
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    await expect(view(page).getByText('Charlie Brown').first()).toBeVisible();
    const lastQuery = (await app.calls('execute_mql_query')).at(-1)!;
    expect(JSON.parse((lastQuery.args as { filter: string }).filter)).toEqual({ tier: 'Premium' });
  });

  test('Explain Plan shows the winning plan', async ({ app, page }) => {
    await view(page).getByTestId('explain-plan-tab').click();

    const panel = view(page).getByTestId('explain-panel');
    await expect(panel).toContainText('COLLSCAN');
    await expect(panel).toContainText('sales_db.customers');
    expect(await app.calls('explain_mql_query')).not.toHaveLength(0);
  });

  test('Query Code shows the query as mongosh code', async ({ page }) => {
    await view(page).getByTestId('query-code-tab').click();

    await expect(view(page).getByTestId('query-code-panel')).toContainText('db.customers.find({}).limit(50)');
  });

  test('switches between the table, tree and JSON views', async ({ page }) => {
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    // Header labels are uppercased by CSS only; the text itself is the field name.
    await expect(view(page).getByTestId('table-header')).toContainText(/name/i);
    await expect(view(page).getByTestId('table-header')).toContainText(/email/i);

    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await expect(view(page).getByTestId('tree-view')).toContainText('Alice Smith');
    await expect(view(page).getByTestId('tree-view')).toContainText('ObjectId');

    await view(page).getByRole('button', { name: 'JSON', exact: true }).click();
    await expect(view(page).getByTestId('json-view')).toContainText('alice@example.com');
  });

  test('inserts a document', async ({ app, page }) => {
    await view(page).getByTestId('insert-doc-btn').click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toBeVisible();

    await setEditorText(page, modal, '{ "name": "Dana White", "email": "dana@example.com", "tier": "Standard" }');
    await modal.getByTestId('document-save-btn').click();

    await expect(modal).toHaveCount(0);
    const inserts = await app.calls('insert_document');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args).toMatchObject({ database: 'sales_db', collection: 'customers' });
    expect(JSON.parse((inserts[0].args as { document: string }).document)).toMatchObject({ name: 'Dana White' });
    // The results list only renders rows near the viewport, so a fourth document
    // can sit below it. The pager counts it; a filter brings it into view.
    await expect(view(page).getByTestId('pager')).toContainText(/1\D4/);
    await runFilter(page, '{ name: "Dana White" }');
    await expect(view(page).getByText('Dana White').first()).toBeVisible();
  });

  test('edits a document, sending it as loaded and as edited', async ({ app, page }) => {
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toBeVisible();

    // The editor's own format: JSON with quoted keys, plus shell types such as ObjectId(...).
    await setEditorText(
      page,
      modal,
      '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Cooper", "email": "alice@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }',
    );
    await modal.getByTestId('document-save-btn').click();

    await expect(modal).toHaveCount(0);
    const updates = await app.calls('update_document');
    expect(updates).toHaveLength(1);
    const args = updates[0].args as { filter: string; original: string; edited: string };
    expect(JSON.parse(args.filter)).toEqual({ _id: { $oid: '603d779f4f102e3a105c3120' } });
    expect(JSON.parse(args.original)).toMatchObject({ name: 'Alice Smith' });
    expect(JSON.parse(args.edited)).toMatchObject({ name: 'Alice Cooper' });
    await expect(view(page).getByText('Alice Cooper').first()).toBeVisible();
    await expect(view(page).getByText('Alice Smith')).toHaveCount(0);
  });

  test('deletes a document once confirmed', async ({ app, page }) => {
    await view(page).getByTestId('delete-doc-btn').first().click();
    await page.getByTestId('dialog-confirm').click();

    await expect(view(page).getByText('Alice Smith')).toHaveCount(0);
    const deletes = await app.calls('delete_document');
    expect(deletes).toHaveLength(1);
    expect(JSON.parse((deletes[0].args as { filter: string }).filter)).toEqual({ _id: { $oid: '603d779f4f102e3a105c3120' } });
  });

  test('keeps the document when the delete is cancelled', async ({ app, page }) => {
    await view(page).getByTestId('delete-doc-btn').first().click();
    await page.getByTestId('dialog-cancel').click();

    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    expect(await app.calls('delete_document')).toHaveLength(0);
  });

  test('Update Many applies an update to the documents the filter matches, once confirmed', async ({ app, page }) => {
    await runFilter(page, '{ tier: "Premium" }');
    await expect(view(page).getByText('Bob Johnson')).toHaveCount(0);

    await view(page).getByTestId('update-many-btn').click();
    await page.getByTestId('dialog-input').fill('{ "$set": { "tier": "Gold" } }');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-input')).toHaveCount(0);
    // Then the destructive confirmation, which states how many documents match.
    await expect(page.getByTestId('dialog-title')).toBeVisible();
    await page.getByTestId('dialog-confirm').click();

    // The filter still asks for Premium, and nothing is Premium any more.
    await expect(view(page).getByText('Alice Smith')).toHaveCount(0);
    await expect(view(page).getByText('Charlie Brown')).toHaveCount(0);
    const updates = await app.calls('update_many');
    expect(updates).toHaveLength(1);
    const args = updates[0].args as { filter: string; update: string; confirmed: boolean };
    expect(JSON.parse(args.filter)).toEqual({ tier: 'Premium' });
    expect(JSON.parse(args.update)).toEqual({ $set: { tier: 'Gold' } });
    expect(args.confirmed).toBe(false);
  });

  test('Update Many rejects an update that is not valid JSON, without writing', async ({ app, page }) => {
    await view(page).getByTestId('update-many-btn').click();
    await page.getByTestId('dialog-input').fill('{ $set: ');
    await page.getByTestId('dialog-confirm').click();

    await expect(page.getByTestId('dialog-error')).toBeVisible();
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('update_many')).toHaveLength(0);
  });

  test('Delete Many removes the documents the filter matches, once confirmed', async ({ app, page }) => {
    await runFilter(page, '{ tier: "Standard" }');
    await expect(view(page).getByText('Alice Smith')).toHaveCount(0);
    await expect(view(page).getByText('Bob Johnson').first()).toBeVisible();

    await view(page).getByTestId('delete-many-btn').click();
    await page.getByTestId('dialog-confirm').click();

    await expect(view(page).getByText('Bob Johnson')).toHaveCount(0);
    const deletes = await app.calls('delete_many');
    expect(deletes).toHaveLength(1);
    const args = deletes[0].args as { filter: string; confirmed: boolean };
    expect(JSON.parse(args.filter)).toEqual({ tier: 'Standard' });
    expect(args.confirmed).toBe(false);
  });
});

test.describe('Documents on the sample connection', () => {
  test('Explain Plan shows the sample server\'s canned index scan', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    await view(page).getByTestId('explain-plan-tab').click();
    const panel = view(page).getByTestId('explain-panel');
    await expect(panel).toContainText('IXSCAN');
    await expect(panel).toContainText('category_1');
  });
});
