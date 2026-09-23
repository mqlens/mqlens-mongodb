import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, setEditorText } from '../helpers';

// `getIndexes()` in the shell (#396). The shell answers this one from the
// driver and prints it the way mongosh does, so it also has to hold up when
// what comes back is not the key pattern it expects.

const sidebar = (page: Page) => page.getByRole('complementary');
const shell = (page: Page) => page.getByTestId('mongo-shell');
const transcript = (page: Page) => shell(page).getByTestId('shell-transcript');

async function openShell(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
  await dismissHoverCards(page);
}

async function run(page: Page, command: string): Promise<void> {
  const button = shell(page).getByRole('button', { name: 'Run', exact: true });
  await expect(button).toBeEnabled();
  await setEditorText(page, shell(page), command);
  await button.click();
  await expect(button).toBeEnabled();
}

test.describe('Asking the shell for a collection\'s indexes', () => {
  test('prints them as mongosh would', async ({ app, page }) => {
    await openShell(app, page);
    await run(page, 'db.customers.getIndexes()');

    await expect.poll(async () => (await app.calls('list_indexes')).at(-1)!.args).toMatchObject({
      db: 'sales_db',
      collection: 'customers',
    });
    // The key pattern, the name, and `unique` only where it is set.
    await expect(transcript(page)).toContainText("name: '_id_'");
    await expect(transcript(page)).toContainText('unique: true');
  });

  test('prints a key pattern that is not one at all', async ({ app, page }) => {
    await openShell(app, page);
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        list_indexes: () => [
          { name: 'empty_pattern', keys: '{}', unique: false, sparse: false },
          { name: 'list_pattern', keys: '[]', unique: false, sparse: false },
          { name: 'nothing_at_all', keys: 'null', unique: false, sparse: false },
        ],
      });
    });
    await run(page, 'db.customers.getIndexes()');

    // Each is printed as what it is rather than dropped or crashed on.
    await expect(transcript(page)).toContainText('key: {}');
    await expect(transcript(page)).toContainText('key: []');
    await expect(transcript(page)).toContainText('key: null');
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
