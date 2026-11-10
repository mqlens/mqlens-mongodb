import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, getEditorText, setEditorText } from '../helpers';

// What the shell editor knows about (#396): the fields of what it last
// printed, and the collections of the database it is pointed at.

const sidebar = (page: Page) => page.getByRole('complementary');
const shell = (page: Page) => page.getByTestId('mongo-shell');
const suggestions = (page: Page) => page.locator('.suggest-widget.visible');

async function openShell(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
  await dismissHoverCards(page);
  await expect(shell(page).getByTestId('shell-transcript')).toContainText('transactions');
}

/** Type a command into the shell's editor and run it. */
async function run(page: Page, command: string): Promise<void> {
  const button = shell(page).getByRole('button', { name: 'Run', exact: true });
  await expect(button).toBeEnabled();
  await setEditorText(page, shell(page), command);
  await button.click();
  await expect(button).toBeEnabled();
}

/** Ask for completions after typing `text` into the shell editor. */
async function typeInto(page: Page, text: string): Promise<void> {
  await setEditorText(page, shell(page), '');
  await shell(page).locator('.monaco-editor').first().click();
  await page.keyboard.type(text, { delay: 40 });
  await page.keyboard.press('Control+Space');
}

test.describe('Completions in the shell', () => {
  test('offer the fields of what it last showed', async ({ app, page }) => {
    await openShell(app, page);
    // The fields come from the documents in the viewer, so it needs some first.
    await run(page, 'db.customers.find({})');
    await expect(shell(page).getByRole('tab', { name: /Data Viewer/ })).toBeVisible();

    await typeInto(page, 'db.customers.find({ ti');
    await expect(async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+Space');
      await expect(suggestions(page)).toContainText('tier', { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press('Escape');
  });

  test('offer the sampled fields of the collection being queried, nested paths too, while typing', async ({ app, page }) => {
    await openShell(app, page);
    // Nothing has run yet, and Ctrl+Space is never pressed. Under load the JS
    // service's parameter hint can win the race for the first quick suggestion,
    // so retype the last character, which asks again the way typing does.
    const typeAndSee = async (text: string, label: string) => {
      await setEditorText(page, shell(page), '');
      await shell(page).locator('.monaco-editor').first().click();
      await page.keyboard.type(text, { delay: 40 });
      await expect(async () => {
        if (!(await suggestions(page).isVisible())) {
          await page.keyboard.press('Backspace');
          await page.keyboard.type(text.slice(-1));
        }
        await expect(suggestions(page)).toContainText(label, { timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
    };

    await typeAndSee('db.customers.find({ ti', 'tier');
    expect(await app.calls('analyze_schema')).not.toHaveLength(0);

    await page.keyboard.press('Escape');
    await typeAndSee('db.customers.find({ "address.ci', 'address.city');
    await page.keyboard.press('Enter');
    await expect.poll(() => getEditorText(page, shell(page))).toBe('db.customers.find({ "address.city": "value"})');
  });

  test('do not wait for a slow schema sample before offering methods', async ({ app, page }) => {
    await openShell(app, page);
    const release = await app.hold('analyze_schema');

    await setEditorText(page, shell(page), '');
    await shell(page).locator('.monaco-editor').first().click();
    await page.keyboard.type('db.customers.fin', { delay: 40 });
    await expect(async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+Space');
      await expect(suggestions(page)).toContainText('find', { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    // The sample is still held while the methods are already on offer.
    expect(await app.calls('analyze_schema')).toHaveLength(1);
    await page.keyboard.press('Escape');
    await release();

    await typeInto(page, 'db.customers.find({ ti');
    await expect(async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+Space');
      await expect(suggestions(page)).toContainText('tier', { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  });

  test('carry on when the collections of a database cannot be listed', async ({ app, page }) => {
    await openShell(app, page);

    await app.failNext('list_collections', 'not authorized on user_analytics to list collections');
    await run(page, 'use user_analytics');
    await expect(shell(page).getByTestId('shell-transcript')).toContainText('user_analytics');

    // Nothing to suggest after `db.`, and the shell still takes commands.
    await typeInto(page, 'db.');
    await page.keyboard.press('Escape');
    await run(page, 'print("still here")');
    await expect(shell(page).getByTestId('shell-transcript')).toContainText('still here');
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
