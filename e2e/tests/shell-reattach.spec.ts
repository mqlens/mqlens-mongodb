import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards } from '../helpers';

// A shell tab the backend still holds (#396): after a reload, or when the tab
// arrives from another window, the shell takes the session back rather than
// starting a second one for the same tab.

const sidebar = (page: Page) => page.getByRole('complementary');
const shell = (page: Page) => page.getByTestId('mongo-shell');
const transcript = (page: Page) => shell(page).getByTestId('shell-transcript');
const runButton = (page: Page) => shell(page).getByRole('button', { name: 'Run', exact: true });

/** The key the shell of sales_db on the first connection is stored under. */
const STORED_TAB = 'shell.conn-1.sales_db.database';

/** Hand the app a stored shell for that tab, with `activeCommand` as its state. */
async function storedShell(page: Page, activeCommand: unknown): Promise<void> {
  await page.evaluate(
    ({ tab, command }) => {
      window.__MQLENS_E2E__!.register({
        claim_shell_tab_state: ({ tabId }) =>
          tabId === tab
            ? {
                sessionId: 'restored-session',
                entries: [
                  { kind: 'note', text: 'mongosh session attached' },
                  { kind: 'input', db: 'sales_db', text: 'db.customers.countDocuments()' },
                ],
                currentDb: 'sales_db',
                autoRanCommand: true,
                aiOpen: false,
                aiMessages: [],
                activeCommand: command,
              }
            : null,
      });
    },
    { tab: STORED_TAB, command: activeCommand },
  );
}

async function openDatabaseShell(page: Page): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
  await dismissHoverCards(page);
}

async function connectedShell(app: App, page: Page, activeCommand: unknown): Promise<void> {
  await connectStaging(app, page);
  await storedShell(page, activeCommand);
  await openDatabaseShell(page);
  await expect(transcript(page)).toContainText('db.customers.countDocuments()');
}

test.describe('A shell the backend still holds', () => {
  test('waits for a mongosh command still running, and starts no second session', async ({ app, page }) => {
    await connectStaging(app, page);
    await storedShell(page, { since: Date.now(), phase: 'mongosh', stopRequested: false });
    const release = await app.hold('await_mongosh_idle');
    await openDatabaseShell(page);

    // The scrollback comes back with it, and it says the command is still running.
    await expect(transcript(page)).toContainText('db.customers.countDocuments()');
    await expect(transcript(page)).toContainText('A command was still running when this shell reopened here');
    await expect(shell(page).getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect.poll(async () => (await app.calls('await_mongosh_idle')).length).toBe(1);
    expect(await app.calls('start_mongosh_session')).toHaveLength(0);

    // The backend says the command has finished, and the shell takes commands again.
    await release();
    await expect(runButton(page)).toBeEnabled();
  });

  test('takes back a command already past mongosh without waiting on it', async ({ app, page }) => {
    await connectedShell(app, page, { since: Date.now(), phase: 'driver', stopRequested: false });

    await expect(runButton(page)).toBeEnabled();
    await expect(transcript(page)).not.toContainText('A command was still running');
    expect(await app.calls('await_mongosh_idle')).toHaveLength(0);
    expect(await app.calls('start_mongosh_session')).toHaveLength(0);
  });

  test('treats a command it cannot read as nothing running', async ({ app, page }) => {
    await connectedShell(app, page, { since: 'a while ago', phase: 'mongosh' });

    await expect(runButton(page)).toBeEnabled();
    await expect(transcript(page)).not.toContainText('A command was still running');
    expect(await app.calls('await_mongosh_idle')).toHaveLength(0);
  });

  test('gives the tab up when its state arrives after the tab has closed', async ({ app, page }) => {
    await connectStaging(app, page);
    await storedShell(page, null);
    const release = await app.hold('claim_shell_tab_state');
    await openDatabaseShell(page);
    await expect.poll(async () => (await app.calls('claim_shell_tab_state')).length).toBe(1);

    await page.getByTestId('workspace-tab-strip').getByRole('button', { name: /^Close mongosh/ }).click();
    await release();

    await expect.poll(async () => (await app.calls('disown_shell_tab_state')).length).toBeGreaterThan(0);
  });
});
