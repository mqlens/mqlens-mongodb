import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import {
  callFrom,
  connectStaging,
  dismissHoverCards,
  expandCollections,
  loadSample,
  openCollection,
  openInNewTab,
  setEditorText,
  STAGING_URI,
} from '../helpers';

const strip = (page: Page) => page.getByTestId('workspace-tab-strip');
const sidebar = (page: Page) => page.getByRole('complementary').first();

const opTypes = async (app: App) =>
  (await app.calls('workspace_apply')).map((call) => String((call.args as { op: { type: string } }).op.type));

/**
 * Drag a tab onto `target` with HTML5 drag events, dropping at a fraction of
 * its width and height, as the tab strip's own drag and drop does.
 */
async function dragTab(page: Page, label: string, target: Locator, x: number, y: number): Promise<void> {
  const tab = await strip(page).locator('[draggable="true"]').filter({ hasText: label }).first().elementHandle();
  const drop = await target.elementHandle();
  await page.evaluate(
    ([source, destination, fx, fy]) => {
      const data = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      const box = destination.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + box.width * fx, clientY: box.top + box.height * fy };
      destination.dispatchEvent(new DragEvent('dragover', at));
      destination.dispatchEvent(new DragEvent('drop', at));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
    },
    [tab!, drop!, x, y] as const,
  );
}

const storedTab = (collection: string) => ({
  id: `profile:p-staging.sales_db.${collection}`,
  type: 'collection',
  profileId: 'p-staging',
  profileName: 'Staging',
  db: 'sales_db',
  collection,
});

test.describe('Panes', () => {
  test('restores a split workspace and moves tabs between panes by dragging', async ({ app, page }) => {
    await app.open({
      profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI }],
      servers: { [STAGING_URI]: SAMPLE_SERVER },
      workspace: {
        revision: 1,
        windows: [
          {
            id: 'main',
            splitTree: {
              kind: 'split',
              id: 'split-1',
              dir: 'row',
              ratio: 0.5,
              children: [
                { kind: 'pane', id: 'pane-1', tabIds: [storedTab('customers').id], activeTabId: storedTab('customers').id },
                { kind: 'pane', id: 'pane-2', tabIds: [storedTab('products').id, 'profile:p-staging.sales_db.gone'], activeTabId: storedTab('products').id },
              ],
            },
            focusedPaneId: 'pane-2',
          },
        ],
        tabs: [storedTab('customers'), storedTab('products')],
      },
    });

    await expect(page.getByTestId('reconnect-banner')).toHaveCount(2);
    await page.getByRole('button', { name: 'Reconnect Staging' }).first().click();
    await expect(page.getByTestId('reconnect-banner')).toHaveCount(0);
    await expect(strip(page)).toHaveCount(2);

    // Onto the middle of the other pane: the tab moves and its old pane folds away.
    await dragTab(page, 'products', page.getByTestId('pane-pane-1'), 0.5, 0.6);
    await expect(strip(page)).toHaveCount(1);
    expect(await opTypes(app)).toContain('move_tab');

    // Onto a pane's right edge: the pane splits with the tab on that side.
    await dragTab(page, 'products', page.getByTestId('pane-pane-1'), 0.95, 0.6);
    await expect(strip(page)).toHaveCount(2);
    expect(await opTypes(app)).toContain('split_pane');

    // Onto the other pane's tab strip.
    await dragTab(page, 'customers', strip(page).last(), 0.5, 0.5);
    await expect(strip(page)).toHaveCount(1);
  });

  test('a pane whose last tab closes folds away', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await openInNewTab(page, 'products');

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('command-palette-input').fill('Split Right');
    await page.keyboard.press('Enter');
    await expect(strip(page)).toHaveCount(2);

    await strip(page).last().getByRole('button', { name: /^Close / }).first().click();
    await expect(strip(page)).toHaveCount(1);
  });
});

test.describe('Vault biometrics', () => {
  test('offers Touch ID, reports a cancelled unlock, and unlocks on retry', async ({ app, page }) => {
    await app.open({
      vault: 'locked',
      vaultPassword: 'correct horse',
      biometric: { available: true, enrolled: true, biometryType: 2, unlockError: 'Touch ID was cancelled' },
    });

    const button = page.getByTestId('vault-biometric-btn');
    await expect(button).toContainText('Touch ID');
    await button.click();
    await expect(page.getByTestId('vault-error')).toContainText('Touch ID was cancelled');

    await page.evaluate(() => {
      window.__MQLENS_E2E__!.state.biometric.unlockError = null;
    });
    await button.click();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await page.getByRole('button', { name: 'Open Settings' }).click();
    await page.getByTestId('settings-tab-security').click();
    await callFrom(app, 'biometric_disable', () => page.getByTestId('sec-biometric-toggle').click());
  });
});

// On a saved connection: the backend runs mongosh only against a real server.
test.describe('Shell AI and tool setup', () => {
  test('asks before running a destructive script from the shell AI panel', async ({ app, page }) => {
    const script = { query: { explanation: 'Removes every customer.', queryType: 'script', script: 'db.customers.deleteMany({})' } };
    await connectStaging(app, page, {
      settings: { ai_provider: 'openai', openai_model: 'gpt-4.1' },
      aiReplies: [script, script],
    });
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
    await dismissHoverCards(page);
    const shell = page.getByTestId('mongo-shell');
    await expect(shell.getByRole('tab', { name: /Data Viewer/ })).toBeVisible();

    const askAndRun = async () => {
      await shell.getByTestId('shell-ai-toggle').click();
      const panel = page.getByTestId('ai-helper-panel');
      await panel.getByTestId('chat-input').fill('remove every customer');
      await panel.getByTestId('chat-send-btn').click();
      await panel.getByTestId('chat-insert-run-btn').last().click();
      await expect(page.getByTestId('destructive-confirm')).toBeVisible();
    };

    await askAndRun();
    await page.getByTestId('destructive-cancel').click();
    await expect(page.getByTestId('destructive-confirm')).toHaveCount(0);

    await askAndRun();
    const ran = await callFrom(app, 'run_mongosh_command', () => page.getByTestId('destructive-run').click());
    expect(String(ran.command)).toContain('deleteMany');
  });

  test('installs tools from the shell gate, and retries a failed install', async ({ app, page }) => {
    await connectStaging(app, page, { mongosh: { available: false, detection: null } });
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
    await dismissHoverCards(page);

    await page.evaluate(() => {
      const e2e = window.__MQLENS_E2E__!;
      let attempts = 0;
      e2e.register({
        start_tool_install_task: () => {
          attempts += 1;
          const now = Date.now();
          const task = { id: `install-${attempts}`, kind: 'tool_install', label: 'Install tools', status: 'running', processed: 0, total: 1, message: 'Downloading…', path: null, error: null, createdAtMs: now, finishedAtMs: null };
          e2e.state.tasks.unshift(
            attempts === 1
              ? { ...task, status: 'failed', message: 'download failed', error: 'checksum mismatch', finishedAtMs: now }
              : { ...task, status: 'completed', processed: 1, message: 'Installed', finishedAtMs: now },
          );
          return task;
        },
      });
    });

    await page.getByTestId('shell-install-tools-btn').click();
    const dialog = page.getByTestId('toolsetup-dialog');
    await dialog.getByTestId('toolsetup-install-btn').click();
    await expect(dialog.getByTestId('toolsetup-error')).toBeVisible();

    await dialog.getByTestId('toolsetup-retry-btn').first().click();
    await dialog.getByTestId('toolsetup-done-btn').click();
    await expect(dialog).toHaveCount(0);
    expect(await app.calls('start_tool_install_task')).toHaveLength(2);
  });
});

test.describe('Text editor helper', () => {
  test('setEditorText is safe on an editor that just mounted', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await setEditorText(page, page.locator('[data-testid^="tab-content-"]:not([hidden])').getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await page.locator('[data-testid^="tab-content-"]:not([hidden])').getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(async () => (await app.calls('execute_mql_query')).at(-1)?.args).toMatchObject({ filter: '{"tier":"Premium"}' });
  });
});
