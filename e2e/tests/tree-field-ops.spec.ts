import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom, connectStaging, openCollection, setEditorText, view } from '../helpers';

// Rename, add and remove a field from the Tree view's context menu or a
// focused row's keys (Shift+F2, Ctrl+K, Del). Each goes through the same
// field-level update_document as an in-place value edit.

const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });
// The key cell of Alice's field: the first document in the tree.
const key = (page: Page, name: string) => view(page).locator(`span[title="${name}"]`).first();
const dialogInput = (page: Page) => page.getByTestId('dialog-input');
const edited = (call: Record<string, unknown>) => JSON.parse(String(call.edited));

async function openCustomersTree(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
  await expect(key(page, 'tier')).toBeVisible();
}

test.describe('Tree field operations', () => {
  test('renames a field from the context menu and with Shift+F2', async ({ app, page }) => {
    await openCustomersTree(app, page);

    await key(page, 'tier').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Rename field/ }).click();
    await expect(dialogInput(page)).toHaveValue('tier');
    await dialogInput(page).fill(' ');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toHaveText('Enter a field name.');
    await dialogInput(page).fill('email');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toHaveText('A field with this name is already here.');

    // A refused write leaves the field as it was.
    await dialogInput(page).fill('plan');
    await app.failNext('update_document', 'Document failed validation');
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'Document failed validation')).toBeVisible();
    await expect(key(page, 'tier')).toBeVisible();

    await key(page, 'tier').click();
    await page.keyboard.press('Shift+F2');
    await dialogInput(page).fill('plan');
    const call = await callFrom(app, 'update_document', () => page.getByTestId('dialog-confirm').click());

    expect(JSON.parse(String(call.filter))).toEqual({ _id: { $oid: '603d779f4f102e3a105c3120' } });
    expect(edited(call).plan).toBe('Premium');
    expect(edited(call)).not.toHaveProperty('tier');
    await expect(toast(page, 'Saved')).toBeVisible();
    await expect(key(page, 'plan')).toBeVisible();
  });

  test('removes a nested field with Delete after the confirm dialog', async ({ app, page }) => {
    await openCustomersTree(app, page);

    await key(page, 'state').click();
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('dialog-title')).toHaveText('Remove field');
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('update_document')).toHaveLength(0);

    await key(page, 'state').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Remove field/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Remove the field "address.state" from this document?');
    const call = await callFrom(app, 'update_document', () => page.getByTestId('dialog-confirm').click());

    expect(edited(call).address).toEqual({ city: 'New York' });
    await expect(toast(page, 'Saved')).toBeVisible();
    // Bob's and Charlie's are still there.
    await expect(view(page).locator('span[title="state"]')).toHaveCount(2);
  });

  test('adds a typed field inside a sub-document with Ctrl+K', async ({ app, page }) => {
    await openCustomersTree(app, page);

    await key(page, 'address').click();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('dialog-title')).toHaveText('Add field');
    // Ctrl+K is the command palette's too; the focused row takes it.
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toContainText('Inside address');
    await dialogInput(page).fill('a.b');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toHaveText('A field name cannot contain a dot.');
    await dialogInput(page).fill('zip');
    await page.getByTestId('dialog-confirm').click();

    // Backing out of the type leaves the document alone.
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('update_document')).toHaveLength(0);

    await key(page, 'address').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Add field/ }).click();
    await dialogInput(page).fill('zip');
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-choice-number').click();
    await dialogInput(page).fill('ten');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('dialog-error')).toHaveText('Not a valid Number value.');
    await dialogInput(page).fill('10001');
    const call = await callFrom(app, 'update_document', () => page.getByTestId('dialog-confirm').click());

    expect(edited(call).address).toEqual({ city: 'New York', state: 'NY', zip: 10001 });
    await expect(toast(page, 'Saved')).toBeVisible();
    await expect(key(page, 'zip')).toBeVisible();
  });

  test('adds a null field next to a top-level one, asking no value', async ({ app, page }) => {
    await openCustomersTree(app, page);

    await key(page, 'tier').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Add field/ }).click();
    await dialogInput(page).fill('referrer');
    await page.getByTestId('dialog-confirm').click();
    const call = await callFrom(app, 'update_document', () => page.getByTestId('dialog-choice-null').click());

    expect(edited(call).referrer).toBeNull();
    await expect(key(page, 'referrer')).toBeVisible();
  });

  test('refuses a rename to a name the projection hid', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('projection-query-input'), '{ name: 1 }');
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();
    await expect(key(page, 'tier')).toHaveCount(0);

    // The stored document may already have an `email`, which a $set would overwrite.
    await key(page, 'name').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Rename field/ }).click();
    await dialogInput(page).fill('email');
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, /cannot add field\(s\) email/)).toBeVisible();
    await expect(key(page, 'name')).toBeVisible();
  });

  test('offers nothing inside an array, and nothing writable on a read-only connection', async ({ app, page }) => {
    await connectStaging(app, page, {}, { connection_mode: 'read_only' });
    await openCollection(page, 'sales_db', 'transactions');
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();

    await key(page, '0').click({ button: 'right' }); // items[0]
    await expect(page.getByRole('menuitem', { name: /Copy value/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /(Rename|Add|Remove) field/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await key(page, 'status').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /Remove field/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await key(page, 'status').click();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('writes each type the picker offers, as that type', async ({ app, page }) => {
    await openCustomersTree(app, page);
    const cases: [type: string, value: string | null, stored: string][] = [
      ['string', 'pro', '"pro"'],
      ['long', '9007199254740993', '{"$numberLong":"9007199254740993"}'],
      ['decimal', '19.99', '{"$numberDecimal":"19.99"}'],
      ['boolean', 'TRUE', 'true'],
      ['date', '2024-01-01T00:00:00Z', '"$date"'],
      ['objectId', '603d779f4f102e3a105c3999', '{"$oid":"603d779f4f102e3a105c3999"}'],
      ['object', null, '{}'],
      ['array', null, '[]'],
    ];
    for (const [type, value, stored] of cases) {
      const name = `f_${type}`;
      await key(page, 'tier').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /Add field/ }).click();
      await dialogInput(page).fill(name);
      await page.getByTestId('dialog-confirm').click();
      const choose = () => page.getByTestId(`dialog-choice-${type}`).click();
      const call = value === null
        ? await callFrom(app, 'update_document', choose)
        : (await choose(), await dialogInput(page).fill(value), await callFrom(app, 'update_document', () => page.getByTestId('dialog-confirm').click()));
      expect(JSON.stringify(edited(call)[name])).toContain(stored);
      await expect(key(page, name)).toBeVisible();
    }

    // Backing out of the name or the value writes nothing.
    await key(page, 'tier').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Add field/ }).click();
    await page.getByTestId('dialog-cancel').click();
    await key(page, 'tier').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Add field/ }).click();
    await dialogInput(page).fill('later');
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-choice-string').click();
    await expect(dialogInput(page)).toHaveValue('');
    await page.getByTestId('dialog-cancel').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Keeping the name is not a rename, and other keys on a row do nothing.
    const writes = (await app.calls('update_document')).length;
    await key(page, 'tier').click();
    await page.keyboard.press('a');
    await page.keyboard.press('Shift+F2');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await app.calls('update_document')).toHaveLength(writes);
  });
});
