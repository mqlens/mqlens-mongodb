import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom, confirmTypedName, connectStaging, openCollection, openInNewTab, setEditorText, switchTab, view } from '../helpers';

// Editing one value in place in the Table and Tree views: double-click, type in
// shell syntax, Enter. Only the changed field is written, through the same
// update_document the document editor uses.

const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });
const editor = (page: Page) => view(page).getByTestId('cell-editor');

/** Drags the non-modal document dialog down by its title, off the top rows. */
async function dragAside(page: Page, modal: Locator): Promise<void> {
  const box = (await modal.getByText('Edit Document', { exact: true }).boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 10, box.y + 600, { steps: 5 });
  await page.mouse.up();
}

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

  test('a document dialog opened before an Undo landed saves with no Undo of its own', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    // The dialog is opened on the row as saved, with b@.
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('b@example.com');
    await setEditorText(
      page,
      modal,
      '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "c@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }',
    );

    // The Undo finishes before the dialog is saved: alice@ is back underneath it.
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);

    // Its Undo would put back the b@ the dialog was opened on, which was undone.
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('a document dialog saved after another save to its document has no Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('alice@example.com');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "c@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }');

    // With the dialog dragged aside, the same field is saved in place as d@.
    await dragAside(page, modal);
    await view(page).getByText('"alice@example.com"', { exact: true }).dblclick();
    await editor(page).fill('"d@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('"d@example.com"', { exact: true })).toBeVisible();

    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);
    // Its Undo would put back the alice@ it was opened on, erasing the d@ save.
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(2);
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('a document dialog save that adds a dotted field name has no Undo, as a filter cannot guard it', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('alice@example.com');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "alice@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" }, "a.b": 1 }');
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('an Undo on another document leaves a document dialog its Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('bob@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b2@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b2@example.com', { exact: true })).toBeVisible();

    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('alice@example.com');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "c@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }');

    // Bob's edit is undone; Alice's row, which the dialog holds, is untouched.
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);

    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(1);
  });

  test('a document dialog saved after an Update Many has no Undo, which would write over the update', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('alice@example.com');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "c@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }');
    await dragAside(page, modal);

    await view(page).getByTestId('bulk-write-menu-btn').click();
    await page.getByTestId('update-many-btn').click();
    await setEditorText(page, page.getByTestId('update-many-editor'), '{ $set: { tier: "Gold" } }');
    await callFrom(app, 'update_many', () => page.getByTestId('update-many-submit').click());

    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('a document dialog opened while an Undo refreshes the grid has no Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    // The undo is written, and the grid, still showing b@, is being refreshed.
    const release = await app.hold('execute_mql_query');
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(2);
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('b@example.com');
    await release();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();

    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "c@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }');
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);
    // Its Undo would put back the b@ the dialog was opened on, which was undone.
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('a document dialog opened while a save to its row refreshes has no Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    // b@ is written, and the grid, still showing alice@, is being refreshed.
    const release = await app.hold('execute_mql_query');
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(1);

    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('alice@example.com');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "c@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }');
    await callFrom(app, 'update_document', () => modal.getByTestId('document-save-btn').click());
    await expect(modal).toHaveCount(0);
    // Its Undo would put back the alice@ it was opened on, erasing the b@ save.
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
    await release();
  });

  test('an Update Many in another collection leaves a document dialog its Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('alice@example.com');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "c@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }');

    await page.getByRole('complementary').getByText('products', { exact: true }).click();
    await expect(page.getByTestId('workspace-tab-strip').getByText('products', { exact: true })).toBeVisible();
    await view(page).getByTestId('bulk-write-menu-btn').click();
    await page.getByTestId('update-many-btn').click();
    await setEditorText(page, page.getByTestId('update-many-editor'), '{ $set: { stock: 0 } }');
    await callFrom(app, 'update_many', () => page.getByTestId('update-many-submit').click());

    await page.getByTestId('workspace-tab-strip').getByText('customers', { exact: true }).click();
    await expect(modal).toBeVisible();
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(1);
  });

  test('a value saved in place while a dialog save to its row refreshes has no Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('alice@example.com');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "b@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }');
    // b@ is written, and the grid, still showing alice@, is being refreshed.
    const release = await app.hold('execute_mql_query');
    await callFrom(app, 'update_document', () => modal.getByTestId('document-save-btn').click());
    await expect(modal).toHaveCount(0);

    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"c@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    // Its Undo would put back the alice@ it was edited from, erasing the b@ save.
    const saved = toast(page, 'Saved');
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
    await release();
  });

  test('a document dialog saved after an Update Many and a rename of its collection has no Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toContainText('alice@example.com');
    await setEditorText(page, modal, '{ "_id": ObjectId("603d779f4f102e3a105c3120"), "name": "Alice Smith", "email": "c@example.com", "tier": "Premium", "joined": "2024-01-10", "address": { "city": "New York", "state": "NY" } }');
    await dragAside(page, modal);

    await view(page).getByTestId('bulk-write-menu-btn').click();
    await page.getByTestId('update-many-btn').click();
    await setEditorText(page, page.getByTestId('update-many-editor'), '{ $set: { tier: "Gold" } }');
    await callFrom(app, 'update_many', () => page.getByTestId('update-many-submit').click());
    await page.getByRole('complementary').getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('clients');
    await callFrom(app, 'rename_collection', () => page.getByTestId('dialog-confirm').click());

    // Under the new name nothing has been counted yet, but the dialog still
    // holds the row from before the update.
    await callFrom(app, 'update_document', () => modal.getByTestId('document-save-btn').click());
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('a value saved in place on a row left stale by a failed refresh has no Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    // b@ is written, but the refresh after it fails: the grid keeps alice@.
    await app.failNext('execute_mql_query', 'connection reset');
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    await expect(toast(page, 'Saved')).toBeVisible();

    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"c@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    // Its Undo would put back the alice@ it was edited from, erasing the b@ save.
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('a value saved in place in a second tab, not refreshed after a save in the first, has no Undo', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await openInNewTab(page, 'customers');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    // The first tab still shows alice@.
    await switchTab(page, 'customers');
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"c@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    // Its Undo would put back alice@, erasing the b@ save.
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('a value saved in place after an Update Many failed has no Undo, as the rows may be stale', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByTestId('bulk-write-menu-btn').click();
    await page.getByTestId('update-many-btn').click();
    await setEditorText(page, page.getByTestId('update-many-editor'), '{ $set: { email: "z@example.com" } }');
    await app.failNext('update_many', 'write conflict');
    await page.getByTestId('update-many-submit').click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'write conflict' })).toBeVisible();

    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"c@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    const saved = toast(page, 'Saved');
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('rows loaded again after a failed refresh give edits their Undo back', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await app.failNext('execute_mql_query', 'connection reset');
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    await expect(toast(page, 'Saved')).toBeVisible();

    // This save's own refresh succeeds, so the grid is current again.
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"c@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    await expect(view(page).getByText('c@example.com', { exact: true })).toBeVisible();

    await view(page).getByText('c@example.com', { exact: true }).dblclick();
    await editor(page).fill('"d@example.com"');
    await callFrom(app, 'update_document', () => editor(page).press('Enter'));
    const saved = toast(page, 'Saved').last();
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(1);
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

  test('an Undo after its document was deleted writes nothing and says so', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    await view(page).getByTestId('delete-doc-btn').first().click();
    await callFrom(app, 'delete_document', () => page.getByTestId('dialog-confirm').click());
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    // Deleting the document retired its Undo: nothing is written.
    expect(await app.calls('update_document')).toHaveLength(1);
  });

  test('an Undo after a Delete Many removed its document says so too', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();

    await view(page).getByTestId('bulk-write-menu-btn').click();
    await page.getByTestId('delete-many-btn').click();
    await callFrom(app, 'delete_many', () => page.getByTestId('dialog-confirm').click());
    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    // Deleting the document retired its Undo: nothing is written.
    expect(await app.calls('update_document')).toHaveLength(1);
  });

  const saveB = async (app: App, page: Page) => {
    await openCustomers(app, page);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await editor(page).fill('"b@example.com"');
    await editor(page).press('Enter');
    await expect(view(page).getByText('b@example.com', { exact: true })).toBeVisible();
  };

  test('a delete the server refuses gives the Undo back, as nothing was deleted', async ({ app, page }) => {
    await saveB(app, page);
    await view(page).getByTestId('delete-doc-btn').first().click();
    await app.failNext('delete_document', 'not authorized');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-toast').filter({ hasText: 'not authorized' })).toBeVisible();

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
  });

  test('an Undo after its database was dropped says so', async ({ app, page }) => {
    await saveB(app, page);
    await page.getByRole('complementary').getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    // Drops sit in the Manage submenu.
    await page.getByRole('menuitem', { name: 'Manage', exact: true }).press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Drop Database', exact: true }).click();
    await callFrom(app, 'drop_database', () => confirmTypedName(page, 'sales_db'));

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    // The undo was sent, conditioned on the saved value, and matched nothing.
    expect(await app.calls('update_document')).toHaveLength(2);
  });

  test('an Undo after its collection was dropped says so', async ({ app, page }) => {
    await saveB(app, page);
    await page.getByRole('complementary').getByText('customers', { exact: true }).first().click({ button: 'right' });
    // Drops sit in the Manage submenu.
    await page.getByRole('menuitem', { name: 'Manage', exact: true }).press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Drop Collection', exact: true }).click();
    await callFrom(app, 'drop_collection', () => confirmTypedName(page, 'customers'));

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    // The undo was sent, conditioned on the saved value, and matched nothing.
    expect(await app.calls('update_document')).toHaveLength(2);
  });

  test('an Undo after another window changed the value writes nothing and says so', async ({ app, page }) => {
    await saveB(app, page);
    const [save] = await app.calls('update_document');
    // Another window, whose writes this one does not see, saves c@ over b@.
    await page.evaluate((connection) => {
      const _id = { $oid: '603d779f4f102e3a105c3120' };
      return window.__MQLENS_E2E__!.handle('update_document', {
        id: connection,
        database: 'sales_db',
        collection: 'customers',
        filter: JSON.stringify({ _id }),
        original: JSON.stringify({ _id, email: 'b@example.com' }),
        edited: JSON.stringify({ _id, email: 'c@example.com' }),
        projection: '{}',
      });
    }, String(save.args.id));

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(view(page).getByText('c@example.com', { exact: true })).toBeVisible();
  });

  /** What another window, whose writes this one does not see, sends to the backend. */
  const writeElsewhere = (page: Page, connection: string, cmd: string, args: Record<string, unknown>) =>
    page.evaluate(([c, a]) => window.__MQLENS_E2E__!.handle(c, a as never), [cmd, { id: connection, database: 'sales_db', collection: 'customers', ...args }] as const);
  const aliceId = { $oid: '603d779f4f102e3a105c3120' };

  test('an Undo after another window made the saved value an array says so', async ({ app, page }) => {
    await saveB(app, page);
    const [save] = await app.calls('update_document');
    // ["b@", "c@"] holds b@, but is not the b@ the save wrote.
    await writeElsewhere(page, String(save.args.id), 'update_document', {
      filter: JSON.stringify({ _id: aliceId }),
      original: JSON.stringify({ _id: aliceId, email: 'b@example.com' }),
      edited: JSON.stringify({ _id: aliceId, email: ['b@example.com', 'c@example.com'] }),
      projection: '{}',
    });

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
  });

  test('an Undo after its document was deleted and inserted again says so', async ({ app, page }) => {
    await saveB(app, page);
    const [save] = await app.calls('update_document');
    await view(page).getByTestId('delete-doc-btn').first().click();
    await callFrom(app, 'delete_document', () => page.getByTestId('dialog-confirm').click());
    // A different document, with the same _id and the saved value.
    await writeElsewhere(page, String(save.args.id), 'insert_document', {
      document: JSON.stringify({ _id: aliceId, name: 'Alice Again', email: 'b@example.com' }),
    });

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(1);
  });

  test('deleting another document leaves the Undo working', async ({ app, page }) => {
    await saveB(app, page);
    await view(page).getByTestId('delete-doc-btn').nth(1).click();
    await callFrom(app, 'delete_document', () => page.getByTestId('dialog-confirm').click());

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
  });

  test('dropping another collection leaves the Undo working', async ({ app, page }) => {
    await saveB(app, page);
    await page.getByRole('complementary').getByText('products', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Manage', exact: true }).press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Drop Collection', exact: true }).click();
    await callFrom(app, 'drop_collection', () => confirmTypedName(page, 'products'));

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Edit undone in customers')).toBeVisible();
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
