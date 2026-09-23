import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, openCollection, STAGING_URI, view } from '../helpers';

// How much room the grid gives a row (#396). Each of the three views has its
// own heights, and each of those bends with the spacing density — a row is
// taller when roomy and shorter when compact, in the table, the JSON and the
// tree alike.

const ORDERS = [
  {
    _id: 1,
    ref: 'ord-1',
    tags: ['express', 'gift'],
    shipping: { city: 'Lisbon', code: '1000-001' },
  },
  { _id: 2, ref: 'ord-2', tags: [], shipping: { city: 'Porto', code: '4000-001' } },
];

async function openOrders(app: App, page: Page): Promise<void> {
  await connectStaging(app, page, {
    servers: { [STAGING_URI]: { databases: { shop: { orders: { docs: ORDERS } } } } },
  });
  await openCollection(page, 'shop', 'orders');
  await expect(view(page)).toContainText('ord-1');
}

/** Run a command-palette action by its title. */
async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await palette.getByTestId('command-palette-input').fill(title);
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
}

/** The height of the first row the grid is currently drawing. */
async function rowHeight(page: Page): Promise<number> {
  const row = view(page).locator('[style*="height"]').filter({ hasText: 'ord-1' }).last();
  await expect(row).toBeVisible();
  return (await row.boundingBox())!.height;
}

test.describe('Row height', () => {
  test('follows the density in every view', async ({ app, page }) => {
    await openOrders(app, page);

    for (const viewName of ['Table', 'JSON', 'Tree']) {
      await view(page).getByRole('button', { name: viewName, exact: true }).click();
      await expect(view(page)).toContainText('ord-1');

      await runCommand(page, 'Density: Roomy');
      const roomy = await rowHeight(page);
      await runCommand(page, 'Density: Compact');
      const compact = await rowHeight(page);

      expect(compact, `${viewName} rows should be shorter when compact`).toBeLessThan(roomy);
      await runCommand(page, 'Density: Cozy');
    }
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('the tree names the type of every value it shows', async ({ app, page }) => {
    await openOrders(app, page);
    await view(page).getByRole('button', { name: 'Tree', exact: true }).click();

    // A list and a nested document are named as what they are, not as their
    // contents — that is what the rows underneath them are for.
    await expect(view(page).getByText('Array', { exact: true }).first()).toBeVisible();
    await expect(view(page).getByText('Object', { exact: true }).first()).toBeVisible();
    await expect(view(page).getByText('String', { exact: true }).first()).toBeVisible();
  });
});
