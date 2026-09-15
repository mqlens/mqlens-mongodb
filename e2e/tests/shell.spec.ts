import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { connectStaging, dismissHoverCards, expandCollections, setEditorText } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary');
const shell = (page: Page) => page.getByTestId('mongo-shell');
const transcript = (page: Page) => shell(page).getByTestId('shell-transcript');

/** Open a shell from the context menu of a collection, or of sales_db when no collection is given. */
async function openShell(page: Page, collection?: string): Promise<void> {
  if (collection) {
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText(collection, { exact: true }).click({ button: 'right' });
  } else {
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  }
  await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
  await dismissHoverCards(page);
}

/** Type a command into the shell's editor and run it. */
async function run(page: Page, command: string): Promise<void> {
  const button = shell(page).getByRole('button', { name: 'Run', exact: true });
  await expect(button).toBeEnabled();
  await setEditorText(page, shell(page), command);
  await button.click();
  await expect(button).toBeEnabled();
}

// On a saved connection: the backend runs mongosh only against a real server.
test.describe('mongosh shell', () => {
  test('opens on a collection and runs its opening query', async ({ app, page }) => {
    await connectStaging(app, page);
    await openShell(page, 'customers');

    // A find goes to the Data Viewer as documents.
    await expect(shell(page).getByRole('tab', { name: /Data Viewer/ })).toBeVisible();
    await expect(shell(page)).toContainText('Alice Smith');

    await shell(page).getByRole('tab', { name: 'Console' }).click();
    await expect(transcript(page)).toContainText('sales_db> db.customers.find({}).limit(50)');
    await expect(transcript(page)).toContainText('mongosh session attached');

    expect((await app.calls('start_mongosh_session'))[0].args).toMatchObject({ database: 'sales_db' });
    expect((await app.calls('run_mongosh_command')).map((call) => (call.args as { command: string }).command)).toEqual([
      'db.customers.find({}).limit(50)',
    ]);
    expect((await app.calls('execute_mql_query')).at(-1)?.args).toMatchObject({ collection: 'customers', limit: 50 });
  });

  test('runs commands in the session', async ({ app, page }) => {
    await connectStaging(app, page);
    await openShell(page);

    // Opened on a database, the shell lists its collections.
    await expect(transcript(page)).toContainText('sales_db> show collections');
    await expect(transcript(page)).toContainText('transactions');

    await run(page, 'use user_analytics');
    await expect(transcript(page)).toContainText('switched to db user_analytics');

    await run(page, 'db.events.countDocuments()');
    await expect(transcript(page)).toContainText('user_analytics> db.events.countDocuments()');
    expect((await app.calls('count_documents')).at(-1)?.args).toMatchObject({ database: 'user_analytics', collection: 'events' });

    await run(page, 'print("hello from e2e")');
    await expect(transcript(page)).toContainText('hello from e2e');

    await run(page, 'nosuchthing');
    await expect(transcript(page)).toContainText('ReferenceError: nosuchthing is not defined');

    // help is answered by the app itself.
    const commandsBefore = (await app.calls('run_mongosh_command')).length;
    await run(page, 'help');
    expect(await app.calls('run_mongosh_command')).toHaveLength(commandsBefore);

    // More than one line runs as a script, not in the session.
    await run(page, 'print("first line")\nprint("second line")');
    await expect(transcript(page)).toContainText('second line');
    expect(await app.calls('run_mongosh_script')).toHaveLength(1);

  });

  test('cls clears the console', async ({ app, page }) => {
    await connectStaging(app, page);
    await openShell(page);
    await expect(transcript(page)).toContainText('transactions');

    await run(page, 'print("before clearing")');
    await expect(transcript(page)).toContainText('before clearing');
    await run(page, 'cls');
    await expect(transcript(page)).not.toContainText('before clearing', { timeout: 5_000 });
  });

  test('stops a command that won\'t finish by restarting the session', async ({ app, page }) => {
    await connectStaging(app, page);
    await openShell(page);
    await expect(transcript(page)).toContainText('transactions');

    await setEditorText(page, shell(page), 'sleep(600000)');
    await shell(page).getByRole('button', { name: 'Run', exact: true }).click();
    await shell(page).getByTestId('shell-stop-command').click();

    await expect(transcript(page)).toContainText('Command stopped.');
    await expect.poll(async () => (await app.calls('start_mongosh_session')).length).toBe(2);
    expect((await app.calls('stop_mongosh_session'))[0].args).toMatchObject({ sessionId: 'mongosh-1' });

    // The new session answers.
    await run(page, 'db');
    await expect(transcript(page)).toContainText('sales_db> db');
  });

  test('restarts the session on request', async ({ app, page }) => {
    await connectStaging(app, page);
    await openShell(page);
    await expect(transcript(page)).toContainText('transactions');

    await shell(page).getByTestId('shell-restart-session').click();
    await expect.poll(async () => (await app.calls('start_mongosh_session')).length).toBe(2);
    await expect(shell(page)).toBeVisible();
    await run(page, 'print("after restart")');
    await expect(transcript(page)).toContainText('after restart');
  });

  test('without mongosh, offers the binary it found and starts once it\'s chosen', async ({ app, page }) => {
    await connectStaging(app, page, { mongosh: { available: false } });
    await openShell(page);

    const gate = page.getByTestId('shell-session-gate');
    await expect(gate).toContainText('requires mongosh');
    await expect(gate.getByTestId('shell-detected-mongosh')).toContainText('2.3.2');
    await gate.getByTestId('shell-use-detected-btn').click();

    await expect(transcript(page)).toContainText('transactions');
    const patches = await app.calls('patch_app_settings');
    expect(patches.at(-1)?.args).toEqual({ patch: { mongosh_path: '/usr/local/bin/mongosh' } });
  });

  test('without mongosh, retries and takes a binary picked from disk', async ({ app, page }) => {
    await connectStaging(app, page, {
      mongosh: { available: false, detection: null, binaries: ['/opt/mongosh/bin/mongosh'] },
      dialog: { open: '/opt/mongosh/bin/mongosh' },
    });
    await openShell(page);

    const gate = page.getByTestId('shell-session-gate');
    await expect(gate).toContainText('requires mongosh');
    await expect(gate.getByTestId('shell-detected-mongosh')).toHaveCount(0);

    await gate.getByTestId('gate-retry').click();
    await expect.poll(async () => (await app.calls('start_mongosh_session')).length).toBe(2);
    await expect(gate).toContainText('requires mongosh');

    await gate.getByTestId('shell-browse-mongosh-btn').click();
    await expect(transcript(page)).toContainText('transactions');
    expect((await app.calls('start_mongosh_session')).at(-1)?.args).toMatchObject({ mongoshPath: '/opt/mongosh/bin/mongosh' });
  });

  test('suggests collection names after db.', async ({ page, app }) => {
    await connectStaging(app, page);
    await openShell(page);
    await expect(transcript(page)).toContainText('transactions');

    await setEditorText(page, shell(page), '');
    // The list is virtualized: only its first rows are drawn. Typing on narrows it
    // to the collection, so the check doesn't depend on where it sorts.
    await page.keyboard.type('db.cus', { delay: 50 });
    await expect(shell(page).locator('.suggest-widget')).toContainText('customers');
  });
});
