import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards } from '../helpers';

// Closing the tool installer rather than finishing it (#396): an install that
// has already landed counts, however the dialog is dismissed.

const sidebar = (page: Page) => page.getByRole('complementary');

/** Open the installer from the shell's gate, with an install that ends in `status`. */
async function openInstaller(app: App, page: Page, status = 'completed'): Promise<void> {
  await connectStaging(app, page, { mongosh: { available: false, detection: null } });
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
  await dismissHoverCards(page);

  await page.evaluate((taskStatus) => {
    const e2e = window.__MQLENS_E2E__!;
    e2e.register({
      start_tool_install_task: () => {
        const now = Date.now();
        const task = {
          id: 'install-1',
          kind: 'tool_install',
          label: 'Install tools',
          status: taskStatus,
          processed: 1,
          total: 1,
          message: 'Installed',
          path: null,
          error: null,
          createdAtMs: now,
          finishedAtMs: taskStatus === 'running' ? null : now,
        };
        e2e.state.tasks.unshift(task);
        return task;
      },
    });
  }, status);
  await page.getByTestId('shell-install-tools-btn').click();
  await expect(page.getByTestId('toolsetup-dialog')).toBeVisible();
}

test.describe('The tool installer', () => {
  test('counts an install that has landed when the dialog is closed with Escape', async ({ app, page }) => {
    await openInstaller(app, page);
    const dialog = page.getByTestId('toolsetup-dialog');
    await dialog.getByTestId('toolsetup-install-btn').click();
    await expect.poll(async () => (await app.calls('start_tool_install_task')).length).toBe(1);

    // Dismissed rather than finished: the install still has to be taken up. The
    // look at the tools that follows is refused, which is not fatal either.
    await app.failNext('managed_tools_status', 'tool directory is unreadable');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => (await app.calls('managed_tools_status')).length).toBeGreaterThan(1);
    expect((await app.calls('managed_tools_status')).some((call) => call.error)).toBe(true);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('installs only the tools that are still ticked', async ({ app, page }) => {
    await openInstaller(app, page);
    const dialog = page.getByTestId('toolsetup-dialog');
    const mongosh = dialog.getByTestId('toolsetup-check-mongosh');
    const tools = dialog.getByTestId('toolsetup-check-mongodb-database-tools');

    // Only what is missing is ticked to begin with — mongosh is already
    // installed here, so reinstalling it is a choice the user makes.
    await expect(tools).toBeChecked();
    await expect(mongosh).not.toBeChecked();

    await mongosh.check();
    await expect(mongosh).toBeChecked();
    await tools.uncheck();
    await expect(tools).not.toBeChecked();
    await dialog.getByTestId('toolsetup-install-btn').click();
    await expect
      .poll(async () => (await app.calls('start_tool_install_task')).map((call) => call.args))
      .toEqual([expect.objectContaining({ tools: ['mongosh'] })]);
  });

  test('cancels an install that is still running', async ({ app, page }) => {
    await openInstaller(app, page, 'running');
    const dialog = page.getByTestId('toolsetup-dialog');
    await dialog.getByTestId('toolsetup-install-btn').click();

    // Cancel belongs to the running install, and asks the backend to end it.
    await dialog.getByTestId('toolsetup-cancel-btn').click();
    await expect.poll(async () => (await app.calls('cancel_task')).map((call) => call.args)).toEqual([
      { id: 'install-1' },
    ]);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
