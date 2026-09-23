import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, dismissHoverCards, openCollection, view } from '../helpers';

// Starting a mongosh session takes a while (#396): these cover what happens
// when the user moves on before it lands, and what mongosh itself said as it
// started.

const sidebar = (page: Page) => page.getByRole('complementary');
const strip = (page: Page) => page.getByTestId('workspace-tab-strip');
const shell = (page: Page) => page.getByTestId('mongo-shell');
const transcript = (page: Page) => shell(page).getByTestId('shell-transcript');

async function openDatabaseShell(page: Page): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
  await dismissHoverCards(page);
}

test.describe('Starting a shell session', () => {
  test('keeps the session when the user leaves the tab while it starts', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    const release = await app.hold('start_mongosh_session');
    await openDatabaseShell(page);
    await expect.poll(async () => (await app.calls('start_mongosh_session')).length).toBe(1);

    // Away and back while mongosh is still starting.
    await strip(page).getByText('customers', { exact: true }).click();
    await release();
    await strip(page).getByText('mongosh: sales_db', { exact: true }).click();

    // The session that landed while the tab was away is this tab's, and it says so.
    await expect(transcript(page)).toContainText('mongosh session attached');
    expect(await app.calls('start_mongosh_session')).toHaveLength(1);
    expect(await app.calls('stop_mongosh_session')).toHaveLength(0);
  });

  test('stops a session that lands after its tab has closed', async ({ app, page }) => {
    await connectStaging(app, page);
    const release = await app.hold('start_mongosh_session');
    await openDatabaseShell(page);
    await expect.poll(async () => (await app.calls('start_mongosh_session')).length).toBe(1);

    await strip(page).getByRole('button', { name: /^Close mongosh/ }).click();
    await expect(shell(page)).toHaveCount(0);
    await release();

    await expect.poll(async () => (await app.calls('stop_mongosh_session')).length).toBeGreaterThan(0);
  });

  test('shows what mongosh said as it started', async ({ app, page }) => {
    await connectStaging(app, page);
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        start_mongosh_session: () => ({
          session_id: 'noisy-session',
          stdout: ['Current Mongosh Log ID: 64b0'],
          stderr: ['Warning: server version differs from the shell'],
        }),
      });
    });
    await openDatabaseShell(page);

    await expect(transcript(page)).toContainText('Current Mongosh Log ID: 64b0');
    await expect(transcript(page)).toContainText('Warning: server version differs from the shell');
    await expect(transcript(page)).toContainText('mongosh session attached');
  });

  test('offers the gate again when a session could not start', async ({ app, page }) => {
    await connectStaging(app, page);
    await app.failNext('start_mongosh_session', 'mongosh exited before it was ready');
    await openDatabaseShell(page);

    // Without a session the shell shows its gate, on the mongosh it found.
    const gate = view(page).getByTestId('shell-session-gate');
    await expect(gate).toContainText('MongoShell requires mongosh');
    await expect(gate.getByTestId('shell-detected-mongosh')).toContainText('/usr/local/bin/mongosh');

    // Retrying from the gate starts one.
    await gate.getByTestId('shell-use-detected-btn').click();
    await expect(transcript(page)).toContainText('mongosh session attached');
    expect((await app.calls('start_mongosh_session')).length).toBeGreaterThan(1);
  });
});
