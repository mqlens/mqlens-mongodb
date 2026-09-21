import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards } from '../helpers';

// Closing the tool installer rather than finishing it (#396): an install that
// has already landed counts, however the dialog is dismissed.

const sidebar = (page: Page) => page.getByRole('complementary');

/** Open the installer from the shell's gate, with installs that always succeed. */
async function openInstaller(app: App, page: Page): Promise<void> {
  await connectStaging(app, page, { mongosh: { available: false, detection: null } });
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
  await dismissHoverCards(page);

  await page.evaluate(() => {
    const e2e = window.__MQLENS_E2E__!;
    e2e.register({
      start_tool_install_task: () => {
        const now = Date.now();
        const task = {
          id: 'install-1',
          kind: 'tool_install',
          label: 'Install tools',
          status: 'completed',
          processed: 1,
          total: 1,
          message: 'Installed',
          path: null,
          error: null,
          createdAtMs: now,
          finishedAtMs: now,
        };
        e2e.state.tasks.unshift(task);
        return task;
      },
    });
  });
  await page.getByTestId('shell-install-tools-btn').click();
  await expect(page.getByTestId('toolsetup-dialog')).toBeVisible();
}

test.describe('The tool installer', () => {
  test('counts an install that has landed when the dialog is closed with Escape', async ({ app, page }) => {
    await openInstaller(app, page);
    const dialog = page.getByTestId('toolsetup-dialog');
    await dialog.getByTestId('toolsetup-install-btn').click();
    await expect.poll(async () => (await app.calls('start_tool_install_task')).length).toBe(1);

    // Dismissed rather than finished: the install still has to be taken up.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The tools are looked at again, so the shell can use what was installed.
    await expect.poll(async () => (await app.calls('managed_tools_status')).length).toBeGreaterThan(1);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
