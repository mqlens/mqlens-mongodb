import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections } from '../helpers';

// Tailing changes (#396): the filters that restart the cursor, a stream the
// backend no longer has, and a tab that comes back to what it was left on.

const sidebar = (page: Page) => page.getByRole('complementary');
const events = (page: Page) => page.getByTestId('watch-event');
const strip = (page: Page) => page.getByTestId('workspace-tab-strip');

type Change = Record<string, unknown>;

/** Push `change` onto every open stream, as the backend's buffer would. */
async function pushChange(page: Page, change: Change): Promise<void> {
  await page.evaluate((event) => {
    for (const stream of Object.values(window.__MQLENS_E2E__!.state.changeStreams)) {
      stream.lastSeq += 1;
      stream.events.push({ ...event, seq: stream.lastSeq, atMs: Date.now() });
    }
  }, change);
}

const insertOf = (collection: string, name: string, id: string): Change => ({
  operationType: 'insert',
  database: 'sales_db',
  collection,
  documentKey: { _id: { $oid: id } },
  fullDocument: { _id: { $oid: id }, name },
});

/** Watch sales_db.customers on the saved connection. */
async function watchCustomers(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await expandCollections(page, 'sales_db');
  await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
  await page.getByTestId('ctx-watch-collection').click();
  await dismissHoverCards(page);
  await expect(page.getByTestId('watch-status')).toHaveText('live');
}

test.describe('Filtering a tail', () => {
  test('clearing the filter empties the tail and watches everything again', async ({ app, page }) => {
    await watchCustomers(app, page);
    await pushChange(page, insertOf('customers', 'Dana White', '65a000000000000000000001'));
    await expect(events(page)).toHaveCount(1);

    await page.getByTestId('watch-filter-insert').click();
    await expect(page.getByTestId('watch-filter-insert')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await app.calls('start_change_stream')).length).toBeGreaterThan(1);

    // Everything again: the cursor restarts unfiltered and the tail starts over.
    await page.getByTestId('watch-filter-all').click();
    await expect(events(page)).toHaveCount(0);
    await expect(page.getByTestId('watch-filter-insert')).toHaveAttribute('aria-pressed', 'false');
    const starts = await app.calls('start_change_stream');
    expect(starts[starts.length - 1].args).toMatchObject({ operationTypes: [] });
  });

  test('a database tail narrows to one of the collections it has seen', async ({ app, page }) => {
    await connectStaging(app, page);
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByTestId('ctx-watch-database-conn-1-sales_db').click();
    await dismissHoverCards(page);
    await expect(page.getByTestId('watch-status')).toHaveText('live');

    // One namespace is nothing to choose between; two bring up the filter.
    await pushChange(page, insertOf('customers', 'Dana White', '65a000000000000000000001'));
    await expect(events(page)).toHaveCount(1);
    await expect(page.getByTestId('watch-filter-namespace')).toHaveCount(0);
    await pushChange(page, insertOf('products', 'Standing Desk', '65a000000000000000000002'));
    await expect(events(page)).toHaveCount(2);

    await page.getByTestId('watch-filter-namespace').click();
    await page.getByRole('option', { name: /customers/ }).click();
    await expect(events(page)).toHaveCount(1);
    await expect(events(page)).toContainText('customers');

    // Back to everything the tail has seen.
    await page.getByTestId('watch-filter-namespace').click();
    await page.getByRole('option', { name: 'All collections' }).click();
    await expect(events(page)).toHaveCount(2);
  });
});

test.describe('A tail that loses its stream', () => {
  test('starts a new cursor and forgets what the old one showed', async ({ app, page }) => {
    await watchCustomers(app, page);
    await pushChange(page, insertOf('customers', 'Dana White', '65a000000000000000000001'));
    await expect(events(page)).toHaveCount(1);
    const before = (await app.calls('start_change_stream')).length;

    // Nothing is watching under this id any more.
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.state.changeStreams = {};
    });

    await expect(events(page)).toHaveCount(0);
    await expect.poll(async () => (await app.calls('start_change_stream')).length).toBeGreaterThan(before);
    // The new cursor's own events arrive, counting from zero again.
    await pushChange(page, insertOf('customers', 'Erin Fox', '65a000000000000000000003'));
    await expect(events(page)).toHaveCount(1);
  });

  test('a poll that fails is not the end of the tail', async ({ app, page }) => {
    await watchCustomers(app, page);

    await app.failNext('poll_change_stream', 'the cursor was closed on the server');
    await pushChange(page, insertOf('customers', 'Dana White', '65a000000000000000000001'));

    // The next poll picks the events up, and nothing was logged as a crash.
    await expect(events(page)).toHaveCount(1);
    await expect(page.getByTestId('watch-status')).toHaveText('live');
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});

test.describe('A tail left paused', () => {
  test('stays paused when its filter changes', async ({ app, page }) => {
    await watchCustomers(app, page);
    await page.getByTestId('watch-toggle').click();
    await expect(page.getByTestId('watch-status')).not.toHaveText('live');

    // A filter change is a new cursor, which must not resume what the user stopped.
    await page.getByTestId('watch-filter-insert').click();
    await expect.poll(async () => (await app.calls('pause_change_stream')).length).toBeGreaterThan(1);
    await expect(page.getByTestId('watch-status')).not.toHaveText('live');
  });

  test('comes back paused and filtered after its tab is unmounted', async ({ app, page }) => {
    await watchCustomers(app, page);
    await page.getByTestId('watch-filter-insert').click();
    await page.getByTestId('watch-toggle').click();
    await expect(page.getByTestId('watch-status')).not.toHaveText('live');

    // Six other tabs push the watch tab past what stays mounted.
    for (const coll of ['customers', 'products', 'transactions', 'sensor_readings']) {
      await sidebar(page).getByText(coll, { exact: true }).click();
      await dismissHoverCards(page);
    }
    await page.getByTestId('status-bar-activity').click();
    await page.getByTestId('status-bar-tasks').click();
    await expect(page.getByTestId('watch-panel')).toHaveCount(0);

    await strip(page).getByText('Watch: customers', { exact: true }).click();
    // It adopts what the backend still holds rather than starting afresh.
    await expect(page.getByTestId('watch-filter-insert')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('watch-status')).not.toHaveText('live');
    await expect(page.getByTestId('watch-toggle')).toHaveAccessibleName(/Resume/);
  });
});
