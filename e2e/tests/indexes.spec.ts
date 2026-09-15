import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { dismissHoverCards, loadSample, openCollection } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary');
const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');

/** The key field lists the collection's fields once its schema has loaded, and is a text box before that. */
async function setKeyField(field: Locator, name: string): Promise<void> {
  if ((await field.evaluate((el) => el.tagName)) === 'SELECT') await field.selectOption(name);
  else await field.fill(name);
}

async function openIndex(page: Page, name: string): Promise<void> {
  await sidebar(page).getByText('indexes', { exact: true }).click();
  await dismissHoverCards(page);
  await sidebar(page).getByText(name, { exact: true }).click();
  await dismissHoverCards(page);
}

test.describe('Indexes', () => {
  test.beforeEach(async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
  });

  test('lists a collection\'s indexes and opens one', async ({ app, page }) => {
    await openIndex(page, 'email_1');

    await expect(sidebar(page).getByText('_id_', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('tier_1', { exact: true })).toBeVisible();
    const viewer = view(page).getByTestId('index-viewer');
    await expect(viewer).toContainText('email');
    expect(await app.calls('index_stats')).not.toHaveLength(0);
  });

  test('creates an index from the indexes group context menu', async ({ app, page }) => {
    // The collection's own menu has no Create Index; the indexes group under it does.
    await sidebar(page).getByText('indexes', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Create Index' }).click();

    const modal = page.getByTestId('index-modal');
    await expect(modal).toBeVisible();
    await setKeyField(modal.getByTestId('index-key-field-0'), 'tier');
    await modal.getByTestId('index-key-direction-0').selectOption('-1');
    // The name follows the keys until it's edited. Wait for it to catch up before
    // typing over it, or the two writes can land together.
    const name = modal.getByTestId('index-name-input');
    await expect(name).toHaveValue('tier_-1');
    await name.fill('tier_-1');
    await expect(name).toHaveValue('tier_-1');
    await modal.getByTestId('save-index-btn').click();

    await expect(modal).toHaveCount(0);
    const creates = await app.calls('create_index');
    expect(creates).toHaveLength(1);
    const args = creates[0].args as { indexName: string; keys: unknown; unique: boolean };
    expect(args).toMatchObject({ database: 'sales_db', collection: 'customers', indexName: 'tier_-1', unique: false });
    expect(typeof args.keys === 'string' ? JSON.parse(args.keys) : args.keys).toEqual({ tier: -1 });
  });

  test('deletes an index once confirmed', async ({ app, page }) => {
    await openIndex(page, 'email_1');
    await expect(view(page).getByTestId('index-viewer')).toBeVisible();

    await view(page).getByTestId('delete-index-btn').click();
    await page.getByTestId('dialog-confirm').click();

    await expect(sidebar(page).getByText('email_1', { exact: true })).toHaveCount(0);
    const deletes = await app.calls('delete_index');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args).toMatchObject({ database: 'sales_db', collection: 'customers', indexName: 'email_1' });
  });
});
