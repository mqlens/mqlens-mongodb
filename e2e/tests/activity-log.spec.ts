import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';

// The activity log when it cannot be read (#396): a locked vault, an audit
// writer that stopped, and every way exporting or discarding a log can fail.

const panel = (page: Page) => page.getByTestId('activity-panel');

const EVENTS = [
  {
    id: 'e1',
    ts: 1_747_000_000_000,
    connectionId: 'conn-1',
    profileName: 'Staging',
    database: 'sales_db',
    collection: 'customers',
    op: 'delete_document',
    source: 'ui',
    ok: true,
    error: null,
    durationMs: 4,
    summary: 'deleted 1 document',
    argsJson: null,
    levelAtRecord: 'A',
    schemaVersion: 1,
  },
  {
    id: 'e2',
    ts: 1_747_000_060_000,
    connectionId: 'conn-1',
    profileName: 'Staging',
    // A database-wide operation has no collection of its own.
    database: 'sales_db',
    op: 'drop_database',
    source: 'shell',
    ok: false,
    error: 'not authorized on sales_db',
    durationMs: 9,
    summary: 'drop database sales_db',
    argsJson: null,
    levelAtRecord: 'A',
    schemaVersion: 1,
  },
];

/** Open the Activity tab, on an app seeded from `seed`. */
async function openActivity(app: App, page: Page, seed: Seed = {}): Promise<void> {
  await app.open({ audit: { events: EVENTS }, ...seed });
  await page.getByTestId('status-bar-activity').click();
}

test.describe('An activity log that cannot be read', () => {
  test('says the vault is locked', async ({ app, page }) => {
    await app.open({ audit: { events: EVENTS } });
    await app.failNext('audit_list', 'vault is locked');
    await page.getByTestId('status-bar-activity').click();

    await expect(page.getByTestId('activity-locked')).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test('an audit writer that stopped is not a locked vault', async ({ app, page }) => {
    await app.open({
      audit: { status: { active: false, degradedReason: 'the audit log could not be opened' }, events: EVENTS },
    });
    // The store reports the same error as a locked vault would.
    await app.failNext('audit_list', 'vault is locked');
    await page.getByTestId('status-bar-activity').click();

    await expect(panel(page).getByTestId('activity-degraded-banner')).toContainText(
      'the audit log could not be opened',
    );
    await expect(page.getByTestId('activity-locked')).toHaveCount(0);
    await expect(panel(page).getByTestId('activity-empty')).toBeVisible();
  });

  test('shows any other failure, and reads the log again', async ({ app, page }) => {
    await app.open({ audit: { events: EVENTS } });
    await app.failNext('audit_list', 'the activity log is corrupt at record 7');
    await page.getByTestId('status-bar-activity').click();

    await expect(panel(page)).toContainText('the activity log is corrupt at record 7');
    await panel(page).getByTestId('activity-refresh-btn').click();
    await expect(panel(page).getByTestId('activity-row-e1')).toBeVisible();
    await expect(panel(page)).not.toContainText('the activity log is corrupt at record 7');
  });
});

test.describe('Reading the log', () => {
  test('filters by operation and by status, and names a database-wide event', async ({ app, page }) => {
    await openActivity(app, page);

    // A database operation with no collection shows the database alone.
    const rows = panel(page).locator('[data-testid^="activity-row-"]');
    await expect(panel(page).getByTestId('activity-row-e2')).toContainText('sales_db');
    await expect(panel(page).getByTestId('activity-row-e1')).toContainText('sales_db.customers');

    await panel(page).getByTestId('activity-filter-op').fill('drop_database');
    await expect(rows).toHaveCount(1);
    await expect(panel(page).getByTestId('activity-row-e2')).toBeVisible();
    await panel(page).getByTestId('activity-filter-op').fill('');

    // Only the ones that failed, then only the ones that worked.
    await panel(page).getByTestId('activity-filter-status').click();
    await page.getByRole('option', { name: 'Failed' }).click();
    await expect(rows).toHaveCount(1);
    await expect(panel(page).getByTestId('activity-row-e2')).toBeVisible();

    await panel(page).getByTestId('activity-filter-status').click();
    await page.getByRole('option', { name: 'Succeeded' }).click();
    await expect(rows).toHaveCount(1);
    await expect(panel(page).getByTestId('activity-row-e1')).toBeVisible();
  });
});

test.describe('Exporting the log', () => {
  test('writes nothing when the save is cancelled or the warning declined', async ({ app, page }) => {
    await openActivity(app, page, { dialog: { save: null } });

    await panel(page).getByTestId('activity-export-btn').click();
    expect(await app.calls('audit_export')).toHaveLength(0);

    // With somewhere to write it, the plaintext warning still has to be accepted.
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.state.dialog.save = '/tmp/audit.jsonl';
    });
    page.on('dialog', (dialog) => void dialog.dismiss());
    await panel(page).getByTestId('activity-export-btn').click();
    await expect(panel(page).getByTestId('activity-export-btn')).toBeEnabled();
    expect(await app.calls('audit_export')).toHaveLength(0);
  });

  test('says why an export failed, and locks when the vault does', async ({ app, page }) => {
    await openActivity(app, page, { dialog: { save: '/tmp/audit.jsonl' } });
    page.on('dialog', (dialog) => void dialog.accept());

    await app.failNext('audit_export', 'no space left on device');
    await panel(page).getByTestId('activity-export-btn').click();
    await expect(panel(page)).toContainText('no space left on device');

    await app.failNext('audit_export', 'vault is locked');
    await panel(page).getByTestId('activity-export-btn').click();
    await expect(page.getByTestId('activity-locked')).toBeVisible();
  });
});

test.describe('Discarding a damaged log', () => {
  const DAMAGED = { status: { integrityError: 'checksum mismatch at record 7' }, events: EVENTS };

  test('keeps the log when the confirmation is declined', async ({ app, page }) => {
    await openActivity(app, page, { audit: DAMAGED });
    page.on('dialog', (dialog) => void dialog.dismiss());

    await panel(page).getByTestId('activity-discard-btn').click();
    expect(await app.calls('audit_discard_damaged_log')).toHaveLength(0);
    await expect(panel(page).getByTestId('activity-row-e1')).toBeVisible();
  });

  test('says why a discard failed, and locks when the vault does', async ({ app, page }) => {
    await openActivity(app, page, { audit: DAMAGED });
    page.on('dialog', (dialog) => void dialog.accept());

    await app.failNext('audit_discard_damaged_log', 'the audit store is read-only');
    await panel(page).getByTestId('activity-discard-btn').click();
    await expect(panel(page)).toContainText('the audit store is read-only');

    await app.failNext('audit_discard_damaged_log', 'vault is locked');
    await panel(page).getByTestId('activity-discard-btn').click();
    await expect(page.getByTestId('activity-locked')).toBeVisible();
  });
});
