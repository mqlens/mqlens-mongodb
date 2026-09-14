import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { loadSample, openCollection, openInNewTab } from '../helpers';

const strip = (page: Page) => page.getByTestId('workspace-tab-strip');

/** The workspace operations the app has sent, by type. */
async function opTypes(app: App): Promise<string[]> {
  return (await app.calls('workspace_apply')).map((call) => String((call.args as { op: { type: string } }).op.type));
}

async function openThreeTabs(app: App, page: Page): Promise<void> {
  await app.open();
  await loadSample(page);
  await openCollection(page, 'sales_db', 'customers');
  await openInNewTab(page, 'products');
  await openInNewTab(page, 'transactions');
  await expect(strip(page).getByText('transactions').first()).toBeVisible();
}

async function tabMenu(page: Page, label: string, item: string): Promise<void> {
  await strip(page).getByText(label).first().click({ button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: item, exact: true }).click();
}

async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await palette.getByTestId('command-palette-input').fill(title);
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
}

test.describe('Workspace tabs and panes', () => {
  test('duplicates a tab and closes the others', async ({ app, page }) => {
    await openThreeTabs(app, page);

    await tabMenu(page, 'products', 'Duplicate Tab');
    await expect(strip(page).getByText('products')).toHaveCount(2);

    await tabMenu(page, 'customers', 'Close Other Tabs');
    await expect(strip(page).getByText('products')).toHaveCount(0);
    await expect(strip(page).getByText('customers').first()).toBeVisible();
    expect(await opTypes(app)).toContain('close_many');
  });

  test('closes the tabs to the right of one', async ({ app, page }) => {
    await openThreeTabs(app, page);

    await tabMenu(page, 'customers', 'Close Tabs to the Right');
    await expect(strip(page).getByText('transactions')).toHaveCount(0);
    await expect(strip(page).getByText('products')).toHaveCount(0);
    await expect(strip(page).getByText('customers').first()).toBeVisible();
  });

  test('splits the workspace into panes from the command palette', async ({ app, page }) => {
    await openThreeTabs(app, page);

    await runCommand(page, 'Split Right');
    // Each pane has its own tab strip.
    await expect(strip(page)).toHaveCount(2);
    expect(await opTypes(app)).toContain('split_pane');

    await runCommand(page, 'Focus Next Pane');
    await expect.poll(() => opTypes(app)).toContain('focus_pane');
  });

  test('closes a tab from its close button', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await openInNewTab(page, 'products');

    await strip(page).getByRole('button', { name: 'Close products' }).click();
    await expect(strip(page).getByText('products')).toHaveCount(0);
    expect(await opTypes(app)).toContain('close_tab');
  });
});
