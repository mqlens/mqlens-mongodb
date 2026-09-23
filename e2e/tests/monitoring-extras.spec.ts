import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { connectStaging, dismissHoverCards, openCollection } from '../helpers';

// Monitoring beyond the numbers (#396): how a command reads in the detail
// panel, and when the view polls the server at all.

const monitor = (page: Page) => page.getByTestId('monitoring-view');
const strip = (page: Page) => page.getByTestId('workspace-tab-strip');
const statusCalls = (app: App) => app.calls('server_status').then((calls) => calls.length);

async function openMonitoring(app: App, page: Page, seed: Seed = {}): Promise<void> {
  await connectStaging(app, page, seed);
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId('ctx-monitor').click();
  await dismissHoverCards(page);
  await expect(monitor(page)).toBeVisible();
}

test.describe('The operation detail', () => {
  test('colours a command the way a shell writes it', async ({ app, page }) => {
    await openMonitoring(app, page, {
      monitoring: {
        currentOps: [
          {
            opid: 101,
            op: 'query',
            ns: 'sales_db.customers',
            secsRunning: 7,
            client: '127.0.0.1:52001',
            desc: 'conn12',
            // As mongosh prints it: bare keys, a quote inside a string, and a
            // wrapper around the id.
            command: '{ find: "customers", filter: { note: "say \\"hi\\"", gone: null, ok: false }, limit: -5, "$db": "sales_db", _id: ObjectId ("65a") }',
          },
        ],
      },
    });

    await monitor(page).getByTestId('op-row-101').click();
    const cmd = page.getByTestId('monitoring-detail-cmd');

    // A quoted word before a colon is a key; one anywhere else is a string.
    await expect(cmd.locator('.text-syntax-key')).toHaveText('"$db"');
    await expect(cmd.locator('.text-syntax-string')).toContainText(['"customers"', '"say \\"hi\\""', '"sales_db"']);
    await expect(cmd.locator('.text-syntax-null')).toHaveText('null');
    // `false` is a literal; a word before a bracket is the call it opens.
    await expect(cmd.locator('.text-syntax-boolean')).toHaveText(['false', 'ObjectId']);
    await expect(cmd.locator('.text-syntax-number')).toHaveText('-5');
    await expect(cmd).toContainText('limit');
  });

  test('a profiled operation with no time says so', async ({ app, page }) => {
    await openMonitoring(app, page, {
      monitoring: {
        profile: [
          { op: 'query', ns: 'sales_db.customers', millis: 180, tsMs: 0, planSummary: '', command: '{"find":"customers"}' },
        ],
      },
    });

    await monitor(page).getByTestId('mon-tab-profiler').click();
    await monitor(page).getByTestId('profile-row-0').click();
    const detail = page.getByTestId('monitoring-detail');
    // Neither the plan nor the time is known.
    await expect(detail.locator('div').filter({ hasText: /^time—$/ })).toBeVisible();
    await expect(detail.locator('div').filter({ hasText: /^plan—$/ })).toBeVisible();
  });
});

test.describe('When monitoring polls', () => {
  test('polls on the chosen rhythm, out of sight or not at all', async ({ app, page }) => {
    await openMonitoring(app, page);
    await monitor(page).getByTestId('monitoring-refresh-interval').click();
    await page.getByRole('option', { name: '5s' }).click();

    // Out of sight: the interval keeps its rhythm but fetches nothing.
    await openCollection(page, 'sales_db', 'customers');
    const away = await statusCalls(app);
    await page.waitForTimeout(6_000);
    expect(await statusCalls(app)).toBe(away);

    // Back on screen it fetches at once, rather than waiting out the interval.
    await strip(page).getByText('Monitor: Staging', { exact: true }).click();
    await expect.poll(() => statusCalls(app)).toBeGreaterThan(away);
    await expect.poll(() => statusCalls(app), { timeout: 12_000 }).toBeGreaterThan(away + 1);

    // A window the user cannot see is the same as a tab they cannot see.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    });
    const hidden = await statusCalls(app);
    await page.waitForTimeout(6_000);
    expect(await statusCalls(app)).toBe(hidden);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    });

    // Off stops the interval altogether, after the one fetch the change itself makes.
    await monitor(page).getByTestId('monitoring-refresh-interval').click();
    await page.getByRole('option', { name: 'Off' }).click();
    await expect.poll(() => statusCalls(app)).toBeGreaterThan(hidden);
    const off = await statusCalls(app);
    await page.waitForTimeout(6_000);
    expect(await statusCalls(app)).toBe(off);

    // Refresh still fetches by hand.
    await monitor(page).getByTestId('monitoring-refresh-now').click();
    await expect.poll(() => statusCalls(app)).toBe(off + 1);
  });

  test('the profiler carries on when the databases cannot be listed', async ({ app, page }) => {
    await openMonitoring(app, page);

    await app.failNext('list_databases', 'not authorized on admin to execute command { listDatabases: 1 }');
    await monitor(page).getByTestId('mon-tab-profiler').click();
    await expect(monitor(page).getByTestId('mon-panel-profiler')).toBeVisible();
    await expect(monitor(page).getByTestId('profile-table')).toHaveCount(0);

    // The cluster tab asks the server as soon as it is opened.
    const before = (await app.calls('repl_set_status')).length;
    await monitor(page).getByTestId('mon-tab-cluster').click();
    await expect.poll(async () => (await app.calls('repl_set_status')).length).toBeGreaterThan(before);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
