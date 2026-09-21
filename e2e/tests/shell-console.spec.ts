import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, setEditorText } from '../helpers';

// The shell's console, beyond running commands (#396): the divider between the
// transcript and the editor, finding text that is not there yet, and the
// install note on a machine nobody recognises.

const sidebar = (page: Page) => page.getByRole('complementary');
const shell = (page: Page) => page.getByTestId('mongo-shell');
const transcript = (page: Page) => shell(page).getByTestId('shell-transcript');

async function openShell(app: App, page: Page, seed = {}): Promise<void> {
  await connectStaging(app, page, seed);
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
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

test.describe('The shell console', () => {
  test('is divided by a handle the user can drag', async ({ app, page }) => {
    await openShell(app, page);
    await expect(transcript(page)).toContainText('transactions');

    const handle = shell(page).locator('.cursor-row-resize');
    const before = (await transcript(page).boundingBox())!.height;
    const box = (await handle.boundingBox())!;

    // Down the screen: the transcript gives its room to the pane above it.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await transcript(page).boundingBox())!.height).toBeLessThan(before - 50);

    // And back up again.
    const shrunk = (await transcript(page).boundingBox())!.height;
    const moved = (await handle.boundingBox())!;
    await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
    await page.mouse.down();
    await page.mouse.move(moved.x + moved.width / 2, moved.y - 100, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await transcript(page).boundingBox())!.height).toBeGreaterThan(shrunk);
  });

  test('counts the matches for text as it appears', async ({ app, page }) => {
    await openShell(app, page);
    await expect(transcript(page)).toContainText('transactions');

    // Nothing matches yet.
    await transcript(page).click();
    await page.keyboard.press('Control+f');
    await shell(page).getByTestId('results-find-input').fill('needle2');
    await expect(shell(page).getByTestId('results-find-status')).toContainText('No matches');
    await page.keyboard.press('Escape');

    await run(page, 'print("needle2")');
    await expect(transcript(page)).toContainText('needle2');
    await transcript(page).click();
    await page.keyboard.press('Control+f');
    await shell(page).getByTestId('results-find-input').fill('needle2');
    // The command is echoed above its output, so one print leaves two matches.
    await expect(shell(page).getByTestId('results-find-status')).toContainText('1 of 2');

    // What the next one prints is counted with them.
    await page.keyboard.press('Escape');
    await run(page, 'print("needle2")');
    await transcript(page).click();
    await page.keyboard.press('Control+f');
    await shell(page).getByTestId('results-find-input').fill('needle2');
    await expect(shell(page).getByTestId('results-find-status')).toContainText('1 of 4');
  });

  test('says nothing was detected when the search for mongosh fails', async ({ app, page }) => {
    await connectStaging(app, page, { mongosh: { available: false, detection: null } });
    await app.failNext('detect_mongosh_binary', 'the search for mongosh failed');
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
    await dismissHoverCards(page);

    await expect(page.getByTestId('shell-session-gate')).toContainText('MongoShell requires mongosh');
    await expect(page.getByTestId('shell-detected-mongosh')).toHaveCount(0);
  });
});

test.describe('The shell on an unfamiliar machine', () => {
  test.use({ userAgent: 'MQLens/1.0 (Unknown OS)' });

  test('points at mongodb.com when it cannot name a package manager', async ({ app, page }) => {
    await openShell(app, page, { mongosh: { available: false, detection: null } });

    await expect(page.getByTestId('shell-install-hint')).toContainText('install mongosh from mongodb.com');
  });
});
