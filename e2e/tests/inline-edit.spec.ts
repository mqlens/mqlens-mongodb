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
});
