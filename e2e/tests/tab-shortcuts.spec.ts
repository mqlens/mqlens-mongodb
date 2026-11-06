import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { loadSample, openCollection, openInNewTab, view } from '../helpers';

const strip = (page: Page) => page.getByTestId('workspace-tab-strip');
// What the macOS app menu sends; the keydown path skips these chords there.
const menu = (app: App, command: string) => app.emit('tab-command', command);

async function openThreeTabs(app: App, page: Page): Promise<void> {
  await app.open();
  await loadSample(page);
  await openCollection(page, 'sales_db', 'customers');
  await openInNewTab(page, 'products');
  await openInNewTab(page, 'transactions');
  await expect(view(page)).toHaveAttribute('data-testid', /transactions/);
}

test.describe('Tab shortcuts', () => {
  test('cycles and jumps between tabs from the keyboard', async ({ app, page }) => {
    await openThreeTabs(app, page);

    await page.keyboard.press('Control+Tab');
    await expect(view(page)).not.toHaveAttribute('data-testid', /transactions/);
    await page.keyboard.press('Control+Shift+Tab');
    await expect(view(page)).toHaveAttribute('data-testid', /transactions/);

    await page.keyboard.press('ControlOrMeta+1');
    const first = await view(page).getAttribute('data-testid');
    await page.keyboard.press('Control+PageDown');
    await expect(view(page)).not.toHaveAttribute('data-testid', first!);
    await page.keyboard.press('Control+PageUp');
    await expect(view(page)).toHaveAttribute('data-testid', first!);

    await page.keyboard.press('ControlOrMeta+9');
    await expect(view(page)).toHaveAttribute('data-testid', /transactions/);
  });

  test('closes a tab and brings it back with its query', async ({ app, page }) => {
    await openThreeTabs(app, page);

    await menu(app, 'close-tab');
    await expect(strip(page).getByText('transactions')).toHaveCount(0);

    await menu(app, 'reopen-closed-tab');
    await expect(strip(page).getByText('transactions').first()).toBeVisible();
    await expect(view(page)).toHaveAttribute('data-testid', /transactions/);

    // Nothing left to reopen: a no-op, not an error.
    await menu(app, 'reopen-closed-tab');
    await expect(strip(page).getByText('transactions')).toHaveCount(1);
  });

  test('reopens every tab that Close Other Tabs closed', async ({ app, page }) => {
    await openThreeTabs(app, page);

    await strip(page).getByText('customers').first().click({ button: 'right' });
    await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Close Other Tabs', exact: true }).click();
    await expect(strip(page).getByText('products')).toHaveCount(0);

    await menu(app, 'reopen-closed-tab');
    await menu(app, 'reopen-closed-tab');
    await expect(strip(page).getByText('products').first()).toBeVisible();
    await expect(strip(page).getByText('transactions').first()).toBeVisible();
  });

  test('opens a new tab and the settings from the menu', async ({ app, page }) => {
    await openThreeTabs(app, page);

    await menu(app, 'new-tab');
    await expect(strip(page).getByText('transactions')).toHaveCount(2);

    await menu(app, 'open-settings');
    await expect(page.getByTestId('settings-view')).toBeVisible();

    // From a tab with no collection, a new tab is Quick Start.
    await menu(app, 'new-tab');
    await expect(view(page)).toHaveAttribute('data-testid', /quick/i);

    // Unknown payloads are ignored.
    await menu(app, 'close-window');
    await expect(view(page)).toHaveAttribute('data-testid', /quick/i);
  });

  test('keeps the lone Quick Start tab open', async ({ app, page }) => {
    await app.open();
    await expect(view(page)).toHaveAttribute('data-testid', /quick/i);
    await menu(app, 'close-tab');
    await expect(view(page)).toHaveAttribute('data-testid', /quick/i);
  });
});
