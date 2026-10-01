import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { AiReplySeed } from '../harness/seed';
import { callFrom, connectStaging, dismissHoverCards, expandCollections, getEditorText, setEditorText } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary');
const shell = (page: Page) => page.getByTestId('mongo-shell');
const transcript = (page: Page) => shell(page).getByTestId('shell-transcript');

/** Open a shell from the context menu of a collection, or of a database when no collection is given. */
async function openShell(page: Page, collection?: string, database = 'sales_db'): Promise<void> {
  if (collection) {
    await expandCollections(page, database);
    await sidebar(page).getByText(collection, { exact: true }).click({ button: 'right' });
  } else {
    await sidebar(page).getByRole('button', { name: `Database ${database}` }).click({ button: 'right' });
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
test.describe('mongosh commands', () => {
  test('sends a find with a projection to the Data Viewer, and shows commands that fail', async ({ app, page }) => {
    await connectStaging(app, page);
    await openShell(page);
    await expect(transcript(page)).toContainText('sales_db> show collections');

    const found = await callFrom(app, 'execute_mql_query', () =>
      run(page, "db.customers.find({ tier: 'Premium' }).skip(0).limit(50).projection({ name: 1 })")
    );
    expect(JSON.parse(String(found.filter))).toEqual({ tier: 'Premium' });
    expect(JSON.parse(String(found.projection))).toEqual({ name: 1 });
    expect(found).toMatchObject({ skip: 0, limit: 50 });

    await shell(page).getByRole('tab', { name: 'Console' }).click();
    const positional = await callFrom(app, 'execute_mql_query', () =>
      run(page, "db.customers.find({ tier: 'Premium' }, { name: 1 })")
    );
    expect(JSON.parse(String(positional.projection))).toEqual({ name: 1 });

    await shell(page).getByRole('tab', { name: 'Console' }).click();
    const one = await callFrom(app, 'execute_mql_query', () =>
      run(page, 'db.customers.findOne().projection({ name: 1 })')
    );
    expect(JSON.parse(String(one.projection))).toEqual({ name: 1 });
    expect(one).toMatchObject({ limit: 1 });

    await shell(page).getByRole('tab', { name: 'Console' }).click();
    const onePositional = await callFrom(app, 'execute_mql_query', () =>
      run(page, 'db.customers.findOne({}, { name: 1 })')
    );
    expect(JSON.parse(String(onePositional.projection))).toEqual({ name: 1 });
    expect(onePositional).toMatchObject({ limit: 1 });

    await shell(page).getByRole('tab', { name: 'Console' }).click();
    await run(page, 'db.customers.find({ tier: ObjectId("x") })');
    await expect(transcript(page)).toContainText('Invalid mongosh JSON literal');

    await app.failNext('run_mongosh_command', 'mongosh process exited unexpectedly');
    await run(page, 'db.customers.stats()');
    await expect(transcript(page)).toContainText('mongosh process exited unexpectedly');

    await run(page, 'show dbs');
    await expect(transcript(page)).toContainText('user_analytics');
  });

  test('finds text in the console, and runs a command with Ctrl+Enter', async ({ app, page }) => {
    await connectStaging(app, page);
    await openShell(page);
    await expect(transcript(page)).toContainText('transactions');
    await run(page, 'print("needle")');
    await expect(transcript(page)).toContainText('needle');

    await transcript(page).click();
    await page.keyboard.press('Control+f');
    await shell(page).getByTestId('results-find-input').fill('needle');
    await expect(shell(page).getByTestId('results-find-status')).toBeVisible();
    await page.keyboard.press('Escape');

    await setEditorText(page, shell(page), 'print("from the keyboard")');
    await shell(page).locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+Enter');
    await expect(transcript(page)).toContainText('from the keyboard');
  });

  test('inserts or runs what the AI helper writes, and Escape cancels a destructive command', async ({ app, page }) => {
    const find: AiReplySeed = { query: { explanation: 'Premium customers.', queryType: 'script', script: 'db.customers.find({ tier: "Premium" })' } };
    const wipe: AiReplySeed = { query: { explanation: 'Removes every customer.', queryType: 'script', script: 'db.customers.deleteMany({})' } };
    await connectStaging(app, page, { settings: { ai_provider: 'openai', openai_model: 'gpt-4.1' }, aiReplies: [find, find, wipe] });
    await openShell(page, 'customers');
    await expect(shell(page)).toContainText('Alice Smith');
    await expect(shell(page).getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    const panel = page.getByTestId('ai-helper-panel');
    const ask = async (prompt: string) => {
      // The toggle flips the panel, which can close again while the shell settles: open it and type in one step.
      await expect(async () => {
        if (!(await panel.getByTestId('chat-input').isVisible())) await shell(page).getByTestId('shell-ai-toggle').click();
        await panel.getByTestId('chat-input').fill(prompt, { timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await panel.getByTestId('chat-send-btn').click();
      await expect(panel.getByTestId('chat-query-card').last()).toBeVisible();
    };

    await ask('premium customers');
    const ran = (await app.calls('run_mongosh_command')).length;
    await panel.getByTestId('chat-insert-btn').last().click();
    await expect.poll(() => getEditorText(page, shell(page))).toContain('Premium');
    expect(await app.calls('run_mongosh_command')).toHaveLength(ran);

    await ask('premium customers again');
    await callFrom(app, 'run_mongosh_command', () => panel.getByTestId('chat-insert-run-btn').last().click());

    await ask('remove every customer');
    await panel.getByTestId('chat-insert-run-btn').last().click();
    await expect(page.getByTestId('destructive-confirm')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('destructive-confirm')).toHaveCount(0);
    // The find that ran before left the Data Viewer in front; the note is in the console.
    await shell(page).getByRole('tab', { name: 'Console' }).click();
    await expect(transcript(page)).toContainText('Destructive command cancelled.');
  });

  test("restarts the session in a renamed database, and stops it when the tab closes", async ({ app, page }) => {
    await connectStaging(app, page);
    await openShell(page, undefined, 'user_analytics');
    await expect(transcript(page)).toContainText('mongosh session attached');

    await sidebar(page).getByRole('button', { name: 'Database user_analytics' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Database', exact: true }).click();
    await page.getByTestId('dialog-input').fill('analytics');
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-confirm').click();
    await expect
      .poll(async () => (await app.calls('start_mongosh_session')).some((call) => (call.args as { database: string }).database === 'analytics'))
      .toBe(true);
    expect((await app.calls('stop_mongosh_session')).length).toBeGreaterThan(0);

    const stops = (await app.calls('stop_mongosh_session')).length;
    await page.getByTestId('workspace-tab-strip').getByRole('button', { name: /^Close / }).last().click();
    await expect.poll(async () => (await app.calls('stop_mongosh_session')).length).toBeGreaterThan(stops);
  });
});

test.describe('mongosh setup on Linux', () => {
  test.use({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });

  test('suggests the Linux package when mongosh cannot be found', async ({ app, page }) => {
    await connectStaging(app, page, { mongosh: { available: false, detection: null } });
    await openShell(page);
    await expect(page.getByTestId('shell-install-hint')).toContainText('apt install mongodb-mongosh');
    await expect(page.getByTestId('shell-detected-mongosh')).toHaveCount(0);
  });
});
