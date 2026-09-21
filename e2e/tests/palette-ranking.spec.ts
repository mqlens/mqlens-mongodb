import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, openCollection, view } from '../helpers';

// How the command palette ranks what it finds (#396): an exact name beats a
// prefix, a prefix beats a substring, and letters that merely appear in order
// still find a collection nobody can spell.

const palette = (page: Page) => page.getByTestId('command-palette');
const results = (page: Page) => palette(page).locator('[cmdk-item]');

async function search(page: Page, query: string): Promise<void> {
  if ((await palette(page).count()) === 0) await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await palette(page).getByTestId('command-palette-input').fill(query);
}

async function openPaletteOn(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
}

test.describe('What the palette finds', () => {
  test('ranks an exact name first, and still finds one spelled loosely', async ({ app, page }) => {
    await openPaletteOn(app, page);

    // The name typed in full comes before everything else it matches.
    await search(page, 'customers');
    await expect(results(page).first()).toContainText('customers');

    // A prefix of one collection finds that collection.
    await search(page, 'transac');
    await expect(results(page).first()).toContainText('transactions');

    // A substring that starts partway in still finds it.
    await search(page, 'action');
    await expect(results(page).filter({ hasText: 'transactions' })).toHaveCount(1);

    // And so do letters that only appear in order.
    await search(page, 'trncts');
    await expect(results(page).filter({ hasText: 'transactions' })).toHaveCount(1);
  });

  test('says when nothing matches', async ({ app, page }) => {
    await openPaletteOn(app, page);

    await search(page, 'zzzq');
    await expect(palette(page)).toContainText('No matching results');
    await expect(results(page)).toHaveCount(0);

    // Emptying the box brings the commands back.
    await search(page, '');
    await expect(results(page).first()).toBeVisible();
  });
});
