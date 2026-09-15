import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, dismissHoverCards, loadSample } from '../helpers';

const monitor = (page: Page) => page.getByTestId('monitoring-view');

/** Open the monitoring tab from a connection's context menu. */
async function openMonitoring(page: Page, connection = 'Staging'): Promise<void> {
  await page.getByRole('button', { name: `Connection ${connection}` }).click({ button: 'right' });
  await page.getByTestId('ctx-monitor').click();
  await dismissHoverCards(page);
  await expect(monitor(page)).toBeVisible();
}

const REPLICA_SET = {
  isReplicaSet: true,
  clusterType: 'replicaSet',
  set: 'rs0',
  myStateStr: 'PRIMARY',
  mongoVersion: '7.0.5',
  members: [
    { name: 'mock-a:27017', stateStr: 'PRIMARY', health: 1, self: true, uptimeSecs: 7_200, optimeDateMs: 1_747_000_000_000, pingMs: null, syncSource: '', lagSecs: null },
    { name: 'mock-b:27017', stateStr: 'SECONDARY', health: 1, self: false, uptimeSecs: 7_100, optimeDateMs: 1_746_999_998_000, pingMs: 3, syncSource: 'mock-a:27017', lagSecs: 2 },
    { name: 'mock-c:27017', stateStr: '(not reachable/healthy)', health: 0, self: false, uptimeSecs: 0, optimeDateMs: 0, pingMs: null, syncSource: '', lagSecs: null },
  ],
};

// On a saved connection, whose server reports what the test seeds. The sample
// server answers with fixed values and ignores kills and profiling changes.
test.describe('Monitoring', () => {
  test('shows server metrics and the operations in flight', async ({ app, page }) => {
    await connectStaging(app, page);
    await openMonitoring(page);
    const view = monitor(page);

    await expect(view).toContainText('mock:27017');
    await expect(view).toContainText('128 MB');
    await expect(view.getByTestId('op-row-101')).toContainText('sales_db.customers');
    await expect(view.getByTestId('op-row-102')).toContainText('user_analytics.events');

    await view.getByTestId('op-row-101').click();
    const detail = page.getByTestId('monitoring-detail');
    await expect(detail).toContainText('conn12');
    await expect(detail.getByTestId('monitoring-detail-cmd')).toContainText('"tier"');
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);

    await view.getByTestId('ops-search').fill('events');
    await expect(view.getByTestId('op-row-101')).toHaveCount(0);
    await expect(view.getByTestId('op-row-102')).toBeVisible();
    await view.getByTestId('ops-search').fill('');

    await view.getByTestId('ops-min-secs').fill('5');
    await expect(view.getByTestId('op-row-102')).toHaveCount(0);
    await expect(view.getByTestId('op-row-101')).toBeVisible();
    await view.getByTestId('ops-min-secs').fill('0');

    await view.getByTestId('ops-type-filter').click();
    await page.getByRole('option', { name: 'insert' }).click();
    await expect(view.getByTestId('op-row-101')).toHaveCount(0);
    await view.getByTestId('ops-db-filter').click();
    await page.getByRole('option', { name: 'sales_db' }).click();
    // An insert in sales_db: no operation matches both.
    await expect(view.getByTestId('current-ops-table')).toHaveCount(0);
  });

  test('kills an operation only once confirmed', async ({ app, page }) => {
    await connectStaging(app, page);
    await openMonitoring(page);
    const view = monitor(page);

    page.once('dialog', (dialog) => void dialog.dismiss());
    await view.getByTestId('kill-op-102').click();
    await expect(view.getByTestId('op-row-102')).toBeVisible();
    expect(await app.calls('kill_op')).toHaveLength(0);

    page.once('dialog', (dialog) => void dialog.accept());
    await view.getByTestId('kill-op-101').click();
    await expect(view.getByTestId('op-row-101')).toHaveCount(0);
    const kills = await app.calls('kill_op');
    expect(kills).toHaveLength(1);
    expect(kills[0].args).toMatchObject({ opid: 101 });
  });

  test('profiler: lists a database\'s slow operations and sets the level', async ({ app, page }) => {
    await connectStaging(app, page);
    await openMonitoring(page);
    const view = monitor(page);

    await view.getByTestId('mon-tab-profiler').click();
    // The first database that isn't admin, config or local.
    await expect(view.getByTestId('profiler-db-select')).toContainText('sales_db');
    await expect(view.getByTestId('profile-row-0')).toContainText('COLLSCAN');
    await expect(view.getByTestId('profile-row-1')).toContainText('sales_db.products');

    await view.getByTestId('profiler-min-ms').fill('100');
    await expect(view.getByTestId('profile-row-1')).toHaveCount(0);
    await view.getByTestId('profiler-search').fill('products');
    await expect(view.getByTestId('profile-table')).toHaveCount(0);
    await view.getByTestId('profiler-search').fill('');
    await view.getByTestId('profiler-min-ms').fill('0');

    await view.getByTestId('profile-row-0').click();
    const detail = page.getByTestId('monitoring-detail');
    await expect(detail).toContainText('180 ms');
    await detail.getByRole('button', { name: 'Close' }).click();
    await expect(detail).toHaveCount(0);

    await view.getByTestId('profiler-level-1').click();
    await expect.poll(async () => (await app.calls('set_profiling_level')).length).toBe(1);
    expect((await app.calls('set_profiling_level'))[0].args).toMatchObject({ database: 'sales_db', level: 1, slowMs: 100 });

    await view.getByTestId('profiler-db-select').click();
    await page.getByRole('option', { name: 'user_analytics' }).click();
    await expect(view.getByTestId('profile-table')).toHaveCount(0);
    await expect
      .poll(async () => (await app.calls('read_profile')).some((call) => (call.args as { database: string }).database === 'user_analytics'))
      .toBe(true);
  });

  test('cluster: a standalone server has no replica set to show', async ({ app, page }) => {
    await connectStaging(app, page);
    await openMonitoring(page);

    await monitor(page).getByTestId('mon-tab-cluster').click();
    await expect(monitor(page).getByTestId('cluster-not-replset')).toBeVisible();
  });

  test('cluster: a sharded cluster points to its shards', async ({ app, page }) => {
    await connectStaging(app, page, { monitoring: { replSet: { ...REPLICA_SET, isReplicaSet: false, clusterType: 'sharded', members: [] } } });
    await openMonitoring(page);

    await monitor(page).getByTestId('mon-tab-cluster').click();
    await expect(monitor(page).getByTestId('cluster-sharded')).toBeVisible();
  });

  test('cluster: lists replica set members with their state and lag', async ({ app, page }) => {
    await connectStaging(app, page, { monitoring: { replSet: REPLICA_SET } });
    await openMonitoring(page);
    const view = monitor(page);

    await view.getByTestId('mon-tab-cluster').click();
    await expect(view.getByTestId('cluster-summary')).toContainText('rs0');
    await expect(view.getByTestId('cluster-member-mock-a:27017')).toContainText('PRIMARY');
    await expect(view.getByTestId('cluster-lag-mock-a:27017')).toHaveText('—');
    await expect(view.getByTestId('cluster-member-mock-b:27017')).toContainText('SECONDARY');
    await expect(view.getByTestId('cluster-member-mock-c:27017')).toContainText('(not reachable/healthy)');
  });

  test('explains the role needed when the server refuses, and shows other errors', async ({ app, page }) => {
    await connectStaging(app, page);
    await app.failNext('server_status', 'not authorized on admin to execute command { serverStatus: 1 } (13)');
    await app.failNext('current_ops', 'not authorized on admin to execute command { currentOp: 1 } (13)');
    await openMonitoring(page);
    const view = monitor(page);

    await expect(view.getByTestId('access-required')).toHaveCount(2);

    await view.getByTestId('monitoring-refresh-now').click();
    await expect(view.getByTestId('access-required')).toHaveCount(0);
    await expect(view.getByTestId('op-row-101')).toBeVisible();

    await app.failNext('server_status', 'connection reset by peer');
    await view.getByTestId('monitoring-refresh-now').click();
    await expect(view.getByTestId('monitoring-error')).toContainText('connection reset by peer');
  });

  test('on the sample connection, shows the demo server\'s fixed status and operation', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openMonitoring(page, 'Sample (mqlens_demo)');
    const view = monitor(page);

    await expect(view).toContainText('mqlens-demo:27017');
    await expect(view.getByTestId('op-row-10241')).toContainText('sales_db.orders');
  });
});
