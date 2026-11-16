import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom, connectStaging, openCollection, setEditorText, view } from '../helpers';

// Editing one value in place in the Table and Tree views: double-click, type in
// shell syntax, Enter. Only the changed field is written, through the same
// update_document the document editor uses.

const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });
const editor = (page: Page) => view(page).getByTestId('cell-editor');

async function openCustomers(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
}

test.describe('In-place cell edit', () => {
  test('a table cell saves on Enter and the grid shows the new value', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();

    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await expect(editor(page)).toHaveValue('"alice@example.com"');
    await editor(page).fill('"ada@example.com"');
    const call = await callFrom(app, 'update_document', () => editor(page).press('Enter'));

    expect(JSON.parse(String(call.filter))).toEqual({ _id: { $oid: '603d779f4f102e3a105c3120' } });
    expect(JSON.parse(String(call.edited)).email).toBe('ada@example.com');
    await expect(toast(page, 'Saved')).toBeVisible();
    await expect(editor(page)).toHaveCount(0);
    await expect(view(page).getByText('ada@example.com', { exact: true })).toBeVisible();
  });

  test('will not save a value from a document shown without its _id', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('projection-query-input'), '{ _id: 0 }');
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(view(page)).not.toContainText('603d779f4f102e3a105c3120');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();

    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"ada@example.com"');
    await editor(page).press('Enter');
    await expect(editor(page)).toHaveAttribute('title', 'Cannot update: this document has no _id.');
    expect(await app.calls('update_document')).toHaveLength(0);
  });

  test('a nested tree value keeps the editor open on a bad value or a refused write, and Escape cancels', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();

    await view(page).getByText('"New York"', { exact: true }).first().dblclick();
    await editor(page).fill('Boston');
    await editor(page).press('Enter');
    await expect(editor(page)).toHaveAttribute('aria-invalid', 'true');

    await editor(page).fill('"Boston"');
    await app.failNext('update_document', 'Document failed validation');
    await editor(page).press('Enter');
    await expect(editor(page)).toHaveAttribute('title', /Document failed validation/);
    await expect(toast(page, 'Document failed validation')).toBeVisible();

    await editor(page).press('Escape');
    await expect(editor(page)).toHaveCount(0);

    await view(page).getByText('"New York"', { exact: true }).first().dblclick();
    await editor(page).fill('"Boston"');
    const call = await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    expect(JSON.parse(String(call.edited)).address).toEqual({ city: 'Boston', state: 'NY' });
    await expect(view(page).getByText('"Boston"', { exact: true })).toBeVisible();
  });

  test('Undo on the saved toast writes the old value back, and says so when it cannot', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();

    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"ada@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('ada@example.com', { exact: true })).toBeVisible();

    const undo = await callFrom(app, 'update_document', () => toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click());
    expect(JSON.parse(String(undo.original)).email).toBe('ada@example.com');
    expect(JSON.parse(String(undo.edited)).email).toBe('alice@example.com');
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
    await expect(view(page).getByText('alice@example.com', { exact: true })).toBeVisible();

    // A refused undo leaves the saved value and reports why.
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"ada@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('ada@example.com', { exact: true })).toBeVisible();
    await app.failNext('update_document', 'Document failed validation');
    await toast(page, 'Saved').last().getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, /Could not undo the edit: .*Document failed validation/)).toBeVisible();
    await expect(view(page).getByText('ada@example.com', { exact: true })).toBeVisible();
  });

  test('Undo refreshes the query now in the tab, not the one the edit was made under', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"ada@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('ada@example.com', { exact: true })).toBeVisible();

    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Standard" }');
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(view(page).getByText('bob@example.com', { exact: true })).toBeVisible();
    await expect(view(page).getByText('ada@example.com', { exact: true })).toHaveCount(0);

    const rerun = await callFrom(app, 'execute_mql_query', () => toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click());
    expect(String(rerun.filter)).toContain('Standard');
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
    await expect(view(page).getByText('alice@example.com', { exact: true })).toHaveCount(0);
  });

  test('only the latest edit can be undone, so an older Undo cannot overwrite a newer save', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    for (const [from, to] of [['alice@example.com', 'b@example.com'], ['b@example.com', 'c@example.com']]) {
      await view(page).getByText(from, { exact: true }).dblclick();
      await editor(page).fill(JSON.stringify(to));
      await editor(page).press('Enter');
      await expect(view(page).getByText(to, { exact: true })).toBeVisible();
    }
    const writes = (await app.calls('update_document')).length;

    await toast(page, 'Saved').first().getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(writes);
    await expect(view(page).getByText('c@example.com', { exact: true })).toBeVisible();
  });

  test('a save still being written already retires the Undo before it', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    const release = await app.hold('update_document');
    await view(page).getByText('b@example.com', { exact: true }).dblclick();
    await editor(page).fill('"c@example.com"');
    await editor(page).press('Enter');
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(2);

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    await release();
    await expect(view(page).getByText('c@example.com', { exact: true })).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(2);
  });

  test('Undo writes under the projection the save was made under, not one run while it was out', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith" }');
    const release = await app.hold('update_document');
    await modal.getByTestId('document-save-btn').click();
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(1);

    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('projection-query-input'), '{ name: 1 }');
    const run = await callFrom(app, 'execute_mql_query', () => view(page).getByRole('button', { name: 'Run', exact: true }).click());
    expect(String(run.projection)).toContain('name');
    await release();
    await expect(toast(page, 'Saved')).toBeVisible();

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
    const [, undo] = await app.calls('update_document');
    expect(String(undo.args.projection ?? '{}')).not.toContain('name');
  });

  test('a save the server refuses leaves the Undo before it working', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    await app.failNext('update_document', 'Document failed validation');
    await view(page).getByText('b@example.com', { exact: true }).dblclick();
    await editor(page).fill('"c@example.com"');
    await editor(page).press('Enter');
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'Document failed validation' })).toBeVisible();
    await editor(page).press('Escape');

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
    await expect(view(page).getByText('alice@example.com', { exact: true })).toBeVisible();
  });

  test('a save made while an Undo is still writing waits for it, so the save lands last', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    const release = await app.hold('update_document');
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(2);
    await view(page).getByText('b@example.com', { exact: true }).dblclick();
    await editor(page).fill('"c@example.com"');
    await editor(page).press('Enter');
    // The new save is not sent while the undo is out.
    await page.waitForTimeout(500);
    expect(await app.calls('update_document')).toHaveLength(2);

    await release();
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(3);
    await expect(view(page).getByText('c@example.com', { exact: true })).toBeVisible();
    // Its Undo would put back the b@ it was edited from, but the undo had
    // already restored alice@ underneath it, so it offers none.
    await expect(toast(page, 'Saved')).toBeVisible();
    // Checked at once: a toast with an action goes away by itself after 10 s.
    expect(await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('a collection is not renamed while an Undo is writing to it', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    const release = await app.hold('update_document');
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(2);
    await page.getByRole('complementary').getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'A document is being saved here' })).toBeVisible();
    expect(await app.calls('rename_collection')).toHaveLength(0);

    await release();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
  });

  test('renaming the collection retires its Undo, which would write to the old name', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    await page.getByRole('complementary').getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('clients');
    await callFrom(app, 'rename_collection', () => page.getByTestId('dialog-confirm').click());

    const writes = (await app.calls('update_document')).length;
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(writes);
  });

  const editThenUpdateMany = async (app: App, page: Page) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();
    await view(page).getByTestId('bulk-write-menu-btn').click();
    await page.getByTestId('update-many-btn').click();
    await setEditorText(page, page.getByTestId('update-many-editor'), '{ $set: { email: "z@example.com" } }');
  };

  test('an Update Many after the edit retires its Undo, which would write over the update', async ({ app, page }) => {
    await editThenUpdateMany(app, page);
    await callFrom(app, 'update_many', () => page.getByTestId('update-many-submit').click());

    const writes = (await app.calls('update_document')).length;
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(writes);
  });

  test('an Update Many that fails keeps the Undo retired, as it may have written some documents first', async ({ app, page }) => {
    await editThenUpdateMany(app, page);
    await app.failNext('update_many', 'write conflict');
    await page.getByTestId('update-many-submit').click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'write conflict' })).toBeVisible();

    const writes = (await app.calls('update_document')).length;
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(writes);
  });

  test('an Update Many waits for an Undo still writing, so the update lands last', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    const release = await app.hold('update_document');
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(2);
    await view(page).getByTestId('bulk-write-menu-btn').click();
    await page.getByTestId('update-many-btn').click();
    await setEditorText(page, page.getByTestId('update-many-editor'), '{ $set: { email: "z@example.com" } }');
    await page.getByTestId('update-many-submit').click();
    await page.waitForTimeout(500);
    expect(await app.calls('update_many')).toHaveLength(0);

    await release();
    await expect.poll(async () => (await app.calls('update_many')).length).toBe(1);
  });

  test('undoes the removal of a sub-document the projection showed only part of', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('projection-query-input'), '{ name: 1, "address.city": 1 }');
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(view(page)).not.toContainText('alice@example.com');

    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith" }');
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);
    await expect(toast(page, 'Saved')).toBeVisible();

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
    await expect(view(page).getByText('New York').first()).toBeVisible();
  });
});
