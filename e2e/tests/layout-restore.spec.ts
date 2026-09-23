import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, openCollection, view } from '../helpers';

// The width a dragged panel comes back at (#396): a saved layout is restored
// only when it still fits the panels on screen, because one that does not
// either crashes the group or leaves a panel too thin to drag (#379).

const LAYOUT_KEY = 'react-resizable-panels:document-viewer-workspace';
const PANELS = 'document-main,ai-helper';

/**
 * Start with `layout` remembered for the document/AI-helper split.
 *
 * Written once per case and then reloaded into, rather than seeded with an
 * init script each time: those accumulate, and every earlier one runs again on
 * the next navigation in no guaranteed order — so a later case could be shown
 * an earlier case's layout.
 */
async function openWithLayout(app: App, page: Page, layout: unknown[]): Promise<void> {
  if (!app.isOpen) await connectStaging(app, page);
  await page.evaluate(
    ({ key, panels, saved }) => {
      localStorage.setItem(key, JSON.stringify({ [panels]: { layout: saved } }));
    },
    { key: LAYOUT_KEY, panels: PANELS, saved: layout },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The fake backend starts over with the reload, so the connection is opened again.
  await page.getByTestId('conn-card-p-staging').click();
  await page.getByRole('button', { name: 'Connection Staging' }).waitFor();
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
  // The helper remembers whether it was open, so only open it when it is not.
  if ((await view(page).getByTestId('ai-helper-panel').count()) === 0) {
    await view(page).getByTestId('toggle-ai-helper').click();
  }
  await expect(view(page).getByTestId('ai-helper-panel')).toBeVisible();
}

/** The AI helper's share of the workspace, in percent. */
async function helperShare(page: Page): Promise<number> {
  const panel = await view(page).getByTestId('ai-helper-panel').boundingBox();
  const whole = await view(page).boundingBox();
  return Math.round((panel!.width / whole!.width) * 100);
}

test.describe('A saved panel layout', () => {
  test('comes back when it still fits', async ({ app, page }) => {
    await openWithLayout(app, page, [60, 40]);
    expect(await helperShare(page)).toBeGreaterThan(35);
  });

  test('is left alone when it would leave a panel unusable', async ({ app, page }) => {
    // The document area below its floor.
    await openWithLayout(app, page, [10, 90]);
    const fallback = await helperShare(page);
    expect(fallback).toBeLessThan(45);

    // A side panel wider than it is allowed to be.
    await openWithLayout(app, page, [45, 55]);
    expect(await helperShare(page)).toBe(fallback);

    // Sizes that do not add up to a whole group.
    await openWithLayout(app, page, [70, 48]);
    expect(await helperShare(page)).toBe(fallback);

    // Something that is not a size at all.
    await openWithLayout(app, page, [70, '30']);
    expect(await helperShare(page)).toBe(fallback);
  });
});
