import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { callFrom } from '../helpers';

const quickStart = (page: Page) => page.getByTestId('quickstart-tab');
const dispatchCheck = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('mqlens:check-update')));

/** Answer update checks with an offer of 0.21.0, whose notes link to the docs. */
const offerUpdate = (page: Page) =>
  page.evaluate(() => {
    window.__MQLENS_E2E__!.register({
      update_check: () => ({
        version: '0.21.0',
        current_version: '0.20.0',
        notes: 'See [the docs](https://mqlens.example/docs) for what changed.',
        date: null,
      }),
    });
  });

test.describe('Update checks', () => {
  test('says it is offline instead of checking', async ({ app, page, context }) => {
    await app.open();
    await expect(quickStart(page)).toBeVisible();
    await context.setOffline(true);
    await dispatchCheck(page);
    await expect(page.getByTestId('update-toast')).toContainText(/offline/i);
    expect(await app.calls('update_check')).toHaveLength(0);
    await context.setOffline(false);
  });

  test('checks the stable channel when the saved channel cannot be read', async ({ app, page }) => {
    await app.open({ settings: { update_channel: 'dev' } });
    await expect(quickStart(page)).toBeVisible();
    await app.failNext('load_app_settings', 'vault is locked');
    const checked = await callFrom(app, 'update_check', () => dispatchCheck(page));
    expect(checked).toMatchObject({ channel: 'stable' });
  });

  test('opens the notes link, closes the offer with Escape, and reports an install that fails', async ({ app, page }) => {
    await app.open();
    await expect(quickStart(page)).toBeVisible();
    await offerUpdate(page);
    await dispatchCheck(page);
    const dialog = page.getByTestId('update-dialog');
    await expect(dialog.getByTestId('update-version')).toContainText('0.21.0');

    const opened = await callFrom(app, 'plugin:opener|open_url', () => dialog.getByRole('link', { name: 'the docs' }).click());
    expect(JSON.stringify(opened)).toContain('https://mqlens.example/docs');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await dispatchCheck(page);
    await expect(dialog).toBeVisible();
    await app.failNext('update_install', 'connection reset by peer');
    await dialog.getByTestId('update-now').click();
    // The check had reached the server, so the toast must not blame it.
    await expect(page.getByTestId('update-toast')).toContainText(/install the update/);
    await expect(page.getByTestId('update-toast')).not.toContainText(/reach the update server/);
  });

  test('retries a startup check that could not reach the server', async ({ app, page }) => {
    await page.clock.install();
    await app.open();
    await expect(quickStart(page)).toBeVisible();
    await app.failNext('update_check', 'error sending request: network unreachable');
    await page.clock.runFor(5_000);
    await expect.poll(async () => (await app.calls('update_check')).length).toBe(1);
    await expect(page.getByTestId('update-toast')).toHaveCount(0);

    await page.clock.runFor(60_000);
    await expect.poll(async () => (await app.calls('update_check')).length).toBeGreaterThan(1);
  });
});
