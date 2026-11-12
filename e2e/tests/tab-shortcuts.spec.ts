import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, connectStaging, loadSample, openCollection, openInNewTab, setEditorText, STAGING_URI, view } from '../helpers';

const strip = (page: Page) => page.getByTestId('workspace-tab-strip');
// What the macOS app menu sends; the keydown path skips these chords there.
const menu = (app: App, command: string) => app.emit('tab-command', command);

const onPlatform = (page: Page, platform: string) =>
  page.addInitScript((value) => Object.defineProperty(navigator, 'platform', { get: () => value }), platform);

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

  test('closes, reopens and opens tabs and the settings with Ctrl chords off the Mac', async ({ app, page }) => {
    await onPlatform(page, 'Linux x86_64');
    await openThreeTabs(app, page);

    await page.keyboard.press('Control+Shift+W');
    await page.keyboard.press('Alt+Control+W');
    await page.keyboard.press('Control+Shift+1');
    await page.keyboard.press('Control+0');
    await expect(strip(page).getByText('transactions')).toHaveCount(1);
    await expect(view(page)).toHaveAttribute('data-testid', /transactions/);

    await page.keyboard.press('Control+W');
    await expect(strip(page).getByText('transactions')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+T');
    await expect(strip(page).getByText('transactions')).toHaveCount(1);
    await page.keyboard.press('Control+T');
    await expect(strip(page).getByText('transactions')).toHaveCount(2);
    await page.keyboard.press('Control+Comma');
    await expect(page.getByTestId('settings-view')).toBeVisible();
  });

  test('cycles with Cmd+Shift+brackets on the Mac and leaves Cmd+W to the app menu', async ({ app, page }) => {
    await onPlatform(page, 'MacIntel');
    await openThreeTabs(app, page);

    await page.keyboard.press('Meta+W');
    await expect(strip(page).getByText('transactions')).toHaveCount(1);

    await page.keyboard.press('Meta+Shift+BracketRight');
    await expect(view(page)).not.toHaveAttribute('data-testid', /transactions/);
    await page.keyboard.press('Meta+Shift+BracketLeft');
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

  test('brings back a $out pipeline in the builder without running it again', async ({ app, page }) => {
    // A saved connection: the sample server rejects writes, so the pipeline would never be kept.
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await openInNewTab(page, 'products');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const editor = view(page).getByTestId('aggregation-pipeline-editor');
    await editor.getByRole('button', { name: 'Add Stage' }).click();
    await editor.getByTestId('pipeline-stage-1').locator('select').selectOption('$out');
    await setEditorText(page, editor.getByTestId('pipeline-stage-1'), '"products_archive"');
    await callFrom(app, 'execute_aggregate', () => view(page).getByRole('button', { name: 'Run', exact: true }).click());
    expect((await app.calls('execute_aggregate'))[0].error).toBeUndefined();

    await menu(app, 'close-tab');
    await expect(strip(page).getByText('products')).toHaveCount(0);
    await menu(app, 'reopen-closed-tab');
    await expect(view(page)).toHaveAttribute('data-testid', /products/);
    await expect(view(page).getByTestId('pipeline-stage-1').locator('select')).toHaveValue('$out');
    await expect(view(page).getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    expect(await app.calls('execute_aggregate')).toHaveLength(1);
  });

  test('switches to a closed tab that was opened again instead of adding a second one', async ({ app, page }) => {
    await openThreeTabs(app, page);
    await menu(app, 'close-tab');
    await openInNewTab(page, 'transactions');
    await page.keyboard.press('ControlOrMeta+1');

    await menu(app, 'reopen-closed-tab');
    await expect(view(page)).toHaveAttribute('data-testid', /transactions/);
    await expect(strip(page).getByText('transactions')).toHaveCount(1);
  });

  test('reopens a restored tab that has not reconnected yet', async ({ app, page }) => {
    const restored = (collection: string) => ({
      id: `profile:p-staging.sales_db.${collection}`,
      type: 'collection',
      profileId: 'p-staging',
      profileName: 'Staging',
      db: 'sales_db',
      collection,
    });
    const tabs = [restored('customers'), restored('products')];
    await app.open({
      profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI }],
      servers: { [STAGING_URI]: SAMPLE_SERVER },
      workspace: {
        revision: 1,
        windows: [{
          id: 'main',
          splitTree: { kind: 'pane', id: 'pane-1', tabIds: tabs.map(t => t.id), activeTabId: tabs[1].id },
          focusedPaneId: 'pane-1',
        }],
        tabs,
      },
    });
    const banner = () => view(page).getByTestId('reconnect-banner');
    await expect(banner()).toContainText('sales_db.products');

    await menu(app, 'close-tab');
    await expect(strip(page).getByText('products')).toHaveCount(0);
    await menu(app, 'reopen-closed-tab');
    await expect(strip(page).getByText('products').first()).toBeVisible();
    await expect(banner()).toContainText('sales_db.products');
    expect(await app.calls('connect_db')).toHaveLength(0);
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
