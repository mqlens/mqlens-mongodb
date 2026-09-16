import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom, connectStaging, dismissHoverCards, openCollection, setEditorText, view } from '../helpers';

// The command palette beyond its fixed actions (#396): the collections and
// saved queries it lists, the sidebar filter that narrows them, and how it closes.

const palette = (page: Page) => page.getByTestId('command-palette');

async function openPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await palette(page).getByTestId('command-palette-input').fill(query);
}

/** Save the query bar's filter under `name`, as the Save query menu does. */
async function saveQuery(app: App, page: Page, name: string): Promise<void> {
  await view(page).getByRole('button', { name: 'Save query', exact: true }).click();
  await page.getByTestId('save-query-item').click();
  await page.getByTestId('dialog-input').fill(name);
  await callFrom(app, 'save_query', () => page.getByTestId('dialog-confirm').click());
}

test.describe('Command palette', () => {
  test('lists collections and saved queries, and runs one', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await saveQuery(app, page, 'Premium customers');

    await openPalette(page, 'transact');
    await expect(palette(page).getByText('transactions', { exact: true })).toBeVisible();
    await expect(palette(page).getByText('Staging · sales_db').first()).toBeVisible();
    await palette(page).getByText('transactions', { exact: true }).click();
    await expect(palette(page)).toHaveCount(0);
    await expect(page.getByTestId('workspace-tab-strip').getByText('transactions', { exact: true })).toBeVisible();

    // The saved query runs on its own collection, with the filter it was saved with.
    await openPalette(page, 'Premium customers');
    const entry = palette(page).getByText('Saved query: Premium customers');
    await expect(entry).toBeVisible();
    const ran = await callFrom(app, 'execute_mql_query', () => entry.click());
    expect(ran).toMatchObject({ database: 'sales_db', collection: 'customers' });
    expect(JSON.parse(String(ran.filter))).toEqual({ tier: 'Premium' });
    await expect(view(page).getByText('Charlie Brown').first()).toBeVisible();
    await expect(view(page).getByText('Bob Johnson')).toHaveCount(0);
  });

  test('narrows what it lists to the sidebar filter', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    // Two characters or more make the sidebar filter the palette's scope.
    await page.getByTestId('sidebar-search').fill('user_analytics');
    await dismissHoverCards(page);

    await openPalette(page, 'e');
    await expect(palette(page).getByText('events', { exact: true })).toBeVisible();
    await expect(palette(page).getByText('Staging · sales_db')).toHaveCount(0);
  });

  test('closes with Escape, and reopens Quick Start once it is closed', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');

    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);

    await page.getByTestId('workspace-tab-strip').getByRole('button', { name: /^Close Quick Start/ }).click();
    await expect(page.getByTestId('quickstart-tab')).toHaveCount(0);

    await openPalette(page, 'Open Quick Start');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
  });
});
