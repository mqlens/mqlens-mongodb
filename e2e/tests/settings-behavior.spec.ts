import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom, connectStaging, dismissHoverCards, getEditorText, openCollection, setEditorText, STAGING_URI, switchTab, view } from '../helpers';

// Settings → Behavior: how the app acts by default. The settings live in
// localStorage and are read at the moment a tab opens, a database expands or a
// query runs, so each test changes one and then does that thing.

const settings = (page: Page) => page.getByTestId('settings-view');
const sidebar = (page: Page) => page.getByRole('complementary');
const filterInput = (page: Page) => view(page).getByTestId('query-filter-input');
const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });

async function openBehavior(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await settings(page).getByTestId('settings-tab-behavior').click();
  await expect(settings(page).getByTestId('behavior-settings')).toBeVisible();
}

/** Pick an option from a Radix select, which lists its options in a portal. */
async function choose(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

/** Run `filter` and return the filter the backend was asked for. */
async function ranFilter(app: App, page: Page, filter: string): Promise<unknown> {
  await setEditorText(page, filterInput(page), filter);
  const call = await callFrom(app, 'execute_mql_query', () => runButton(page).click());
  return JSON.parse(String(call.filter));
}

test.describe('Behavior settings', () => {
  test('a collection opens in the chosen view, with the chosen page size', async ({ app, page }) => {
    // Wider than the viewport, so the table scrolls sideways.
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${String(i).padStart(2, '0')}`, `v${i}`]));
    const docs = Array.from({ length: 40 }, (_, n) => ({ _id: n, ...wide }));
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs } } } } } });

    await openBehavior(page);
    await choose(page, settings(page).getByTestId('behavior-default-view-select'), 'Table');
    await choose(page, settings(page).getByTestId('behavior-page-size-select'), /^25\b/);

    const opened = await callFrom(app, 'execute_mql_query', () => openCollection(page, 'shop', 'things'));
    expect(opened).toMatchObject({ limit: 25, skip: 0 });
    const header = view(page).getByTestId('table-header');
    await expect(header).toContainText(/field_00/i);
    await expect(view(page).getByTestId('pager')).toContainText('40');

    // The tab mounted in table view before its rows had loaded; the header
    // still has to follow the body once they are there.
    await view(page).getByTestId('table-body-scroll').evaluate((wrapper) => {
      const scroller = [wrapper, ...Array.from(wrapper.querySelectorAll<HTMLElement>('*'))].find(
        (el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX !== 'hidden',
      )!;
      scroller.scrollLeft = 300;
    });
    await expect.poll(() => header.evaluate((el) => el.scrollLeft)).toBe(300);
  });

  test('opening a database can go straight to its collections', async ({ app, page }) => {
    await connectStaging(app, page);
    await openBehavior(page);
    await settings(page).getByTestId('behavior-expand-collections-toggle').click();

    await sidebar(page).getByText('sales_db', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(sidebar(page).getByText('customers', { exact: true })).toBeVisible();
  });

  test('ObjectId conveniences apply when a query runs, and can be turned off', async ({ app, page }) => {
    const alice = '603d779f4f102e3a105c3120';
    const bob = '603d779f4f102e3a105c3121';
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');

    // A bare ObjectId is an _id search, and the bar shows the query that ran.
    expect(await ranFilter(app, page, alice)).toEqual({ _id: { $oid: alice } });
    await expect(view(page)).not.toContainText('Bob Johnson');
    await expect.poll(() => getEditorText(page, filterInput(page))).toContain(`ObjectId("${alice}")`);

    // A hex string against a field sampled as ObjectId is sent as one.
    expect(await ranFilter(app, page, `{ _id: "${bob}" }`)).toEqual({ _id: { $oid: bob } });
    await expect(view(page)).toContainText('Bob Johnson');

    await openBehavior(page);
    await settings(page).getByTestId('behavior-auto-convert-objectid-toggle').click();
    await settings(page).getByTestId('behavior-default-id-search-toggle').click();
    await switchTab(page, 'customers');

    // Off: the string is sent as typed, and a bare ObjectId is not a query.
    expect(await ranFilter(app, page, `{ _id: "${bob}" }`)).toEqual({ _id: bob });
    await setEditorText(page, filterInput(page), alice);
    await expect(view(page).getByTestId('query-invalid-badge')).toBeVisible();
  });
});
