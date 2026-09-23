import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections, openCollection, setEditorText, view } from '../helpers';

// Dropping and renaming from the sidebar (#396): what it refuses while a
// document is still being saved there, what it asks for on a connection that
// confirms destructive work, and what it clears afterwards.

const sidebar = (page: Page) => page.getByRole('complementary');
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });

const collectionMenu = async (page: Page, name: string, item: string) => {
  await sidebar(page).getByText(name, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};

const databaseMenu = async (page: Page, name: string, item: string) => {
  await sidebar(page).getByRole('button', { name: `Database ${name}` }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};

test.describe('While a document is being saved', () => {
  test('neither the collection nor its database can be dropped or renamed', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    // A save on its way, and still out.
    await view(page).getByTestId('insert-doc-btn').click();
    await setEditorText(page, page.getByTestId('document-edit-modal'), '{ "name": "Dana White" }');
    const release = await app.hold('insert_document');
    await page.getByTestId('document-edit-modal').getByTestId('document-save-btn').click();
    await expect.poll(async () => (await app.calls('insert_document')).length).toBe(1);

    const busy = toast(page, 'A document is being saved here');
    for (const item of ['Drop Collection', 'Rename Collection']) {
      await collectionMenu(page, 'customers', item);
      await expect(busy.first()).toBeVisible();
      await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    }
    for (const item of ['Drop Database', 'Rename Database']) {
      await databaseMenu(page, 'sales_db', item);
      await expect(busy.first()).toBeVisible();
      await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    }
    expect(await app.calls('drop_collection')).toHaveLength(0);
    expect(await app.calls('drop_database')).toHaveLength(0);

    await release();
    await expect(page.getByTestId('document-edit-modal')).toHaveCount(0);
  });
});

test.describe('On a connection that confirms destructive work', () => {
  test('every drop and rename asks for the name, and stops when it is not given', async ({ app, page }) => {
    await connectStaging(app, page, {}, { connection_mode: 'confirm_destructive' });
    await expandCollections(page, 'sales_db');

    for (const item of ['Drop Collection', 'Rename Collection']) {
      await collectionMenu(page, 'products', item);
      await expect(page.getByTestId('dialog-input')).toBeVisible();
      await page.getByTestId('dialog-cancel').click();
      await dismissHoverCards(page);
    }
    for (const item of ['Drop Database', 'Rename Database']) {
      await databaseMenu(page, 'sales_db', item);
      await expect(page.getByTestId('dialog-input')).toBeVisible();
      await page.getByTestId('dialog-cancel').click();
      await dismissHoverCards(page);
    }

    expect(await app.calls('drop_collection')).toHaveLength(0);
    expect(await app.calls('rename_collection')).toHaveLength(0);
    expect(await app.calls('drop_database')).toHaveLength(0);
    expect(await app.calls('rename_database')).toHaveLength(0);
    await expect(sidebar(page).getByText('products', { exact: true })).toBeVisible();
  });
});

test.describe('After a drop', () => {
  test('the collection leaves the tree, and a dropped database takes the rest of it', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    // The indexes of the open collection are on screen too.
    await sidebar(page).getByText('indexes', { exact: true }).first().click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('email_1', { exact: true })).toBeVisible();

    await collectionMenu(page, 'customers', 'Drop Collection');
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(async () => (await app.calls('drop_collection')).length).toBe(1);
    await expect(sidebar(page).getByText('customers', { exact: true })).toHaveCount(0);
    // The tab it was open in keeps what it had loaded; closing it is the user's move.
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    // And the whole database goes the same way, indexes and all.
    await databaseMenu(page, 'sales_db', 'Drop Database');
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(async () => (await app.calls('drop_database')).length).toBe(1);
    await expect(sidebar(page).getByRole('button', { name: 'Database sales_db' })).toHaveCount(0);
    await expect(sidebar(page).getByText('email_1', { exact: true })).toHaveCount(0);
  });
});
