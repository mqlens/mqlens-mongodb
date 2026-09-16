import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { connectStaging, dismissHoverCards, openCollection, STAGING_URI, view } from '../helpers';

// Tabs themselves (#396): the colour a tab is given, a tab whose content
// crashes, and a workspace split inside a split.

const strips = (page: Page) => page.getByTestId('workspace-tab-strip');
const sidebar = (page: Page) => page.getByRole('complementary').first();

async function tabMenu(page: Page, label: string, item: string | RegExp): Promise<void> {
  await strips(page).first().getByText(label, { exact: true }).click({ button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: item }).click();
}

const storedTab = (collection: string) => ({
  id: `profile:p-staging.sales_db.${collection}`,
  type: 'collection',
  profileId: 'p-staging',
  profileName: 'Staging',
  db: 'sales_db',
  collection,
});

/** Drag a tab onto `target`, dropping at a fraction of its box, as the strip's own drag does. */
async function dragTab(page: Page, label: string, target: Locator, x: number, y: number): Promise<void> {
  const tab = await strips(page).locator('[draggable="true"]').filter({ hasText: label }).first().elementHandle();
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

test.describe('Tab colours', () => {
  test('colours a tab, and clears it again', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    const colours = () => page.evaluate(() => localStorage.getItem('mqlens-tab-colors'));

    await tabMenu(page, 'customers', 'Tab color: Blue');
    await expect.poll(colours).toContain('blue');
    expect(await colours()).toContain('customers');

    await tabMenu(page, 'customers', 'Tab color: Default');
    await expect.poll(colours).not.toContain('blue');
  });
});

test.describe('A tab that crashes', () => {
  test('shows the crash in its own tab, and Retry brings it back', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    // A schema report with no fields at all: the view reads them while rendering.
    await page.evaluate(() => {
      let first = true;
      window.__MQLENS_E2E__!.register({
        analyze_schema: () => {
          if (first) {
            first = false;
            return JSON.stringify({ sampled: 3 });
          }
          return JSON.stringify({
            sampled: 3,
            fields: [{ path: 'name', types: [{ type: 'string', count: 3 }], presence: 3, coverage: 1 }],
          });
        },
      });
    });

    await sidebar(page).getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Analyze Schema', exact: true }).click();
    await dismissHoverCards(page);

    const crashed = view(page).getByTestId('tab-error-boundary');
    await expect(crashed).toBeVisible();
    await expect(view(page).getByTestId('tab-error-message')).toContainText(/undefined|null|fields/i);

    // The rest of the workspace is unharmed.
    await strips(page).first().getByText('customers', { exact: true }).click();
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    await strips(page).first().getByText(/^Schema: customers/).click();
    await view(page).getByTestId('tab-error-retry').click();
    await expect(view(page).getByTestId('schema-view')).toBeVisible();
    await expect(view(page).getByTestId('tab-error-boundary')).toHaveCount(0);

    // The crash was reported, as it would be for a user; this test expects it.
    const reported = await app.takeFrontendErrors();
    expect(reported.join('\n')).toContain('TabErrorBoundary:');
  });
});

test.describe('Splits inside splits', () => {
  test('restores a nested split, reorders a tab in the inner pane, and closes it', async ({ app, page }) => {
    const [customers, products, transactions, readings] = ['customers', 'products', 'transactions', 'sensor_readings'].map(storedTab);
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
                { kind: 'pane', id: 'pane-1', tabIds: [customers.id], activeTabId: customers.id },
                {
                  kind: 'split',
                  id: 'split-2',
                  dir: 'column',
                  ratio: 0.5,
                  children: [
                    { kind: 'pane', id: 'pane-2', tabIds: [products.id, transactions.id], activeTabId: products.id },
                    { kind: 'pane', id: 'pane-3', tabIds: [readings.id], activeTabId: readings.id },
                  ],
                },
              ],
            },
            focusedPaneId: 'pane-2',
          },
        ],
        tabs: [customers, products, transactions, readings],
      },
    });

    await expect(strips(page)).toHaveCount(3);
    const inner = strips(page).nth(1);
    await expect(inner.getByText('products', { exact: true })).toBeVisible();

    // A tab dropped on its own pane's strip moves to the end of that pane.
    const order = async () => {
      const labels = await inner.locator('[draggable="true"]').allTextContents();
      return [labels.findIndex((label) => label.includes('products')), labels.findIndex((label) => label.includes('transactions'))];
    };
    expect(await order()).toEqual([0, 1]);
    await dragTab(page, 'products', inner, 0.5, 0.5);
    await expect.poll(order).toEqual([1, 0]);

    // Closing the last tab of the third pane leaves the two others.
    await strips(page).nth(2).getByRole('button', { name: /^Close / }).first().click();
    await expect(strips(page)).toHaveCount(2);
  });
});
