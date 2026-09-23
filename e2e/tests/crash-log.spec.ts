import { test, expect } from '../fixtures';

// What the app writes down when something escapes (#396): the crash log is the
// only record a release build keeps, so every shape of uncaught failure has to
// reach it.

test.describe('The crash log', () => {
  test('writes down an error nothing caught, with its stack', async ({ app, page, browserName }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('the grid fell over');
      }, 0);
    });

    await expect.poll(async () => (await app.calls('log_frontend_error')).length).toBe(1);
    const logged = await app.takeFrontendErrors();
    expect(logged[0]).toContain('window.onerror:');
    expect(logged[0]).toContain('Error: the grid fell over');
    // The stack is what makes the entry worth keeping, where the browser gives one.
    if (browserName === 'chromium') expect(logged[0]).toContain('at ');
  });

  test('writes down a promise nobody handled, whatever it was rejected with', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await page.evaluate(() => {
      void Promise.reject(new Error('the save never landed'));
    });
    await expect.poll(async () => (await app.calls('log_frontend_error')).length).toBe(1);

    // Not every rejection carries an Error: a string is written as it is.
    await page.evaluate(() => {
      void Promise.reject('vault is locked');
    });
    await expect.poll(async () => (await app.calls('log_frontend_error')).length).toBe(2);

    // A value JSON cannot describe is written as the runtime spells it.
    await page.evaluate(() => {
      void Promise.reject(BigInt(42));
    });
    await expect.poll(async () => (await app.calls('log_frontend_error')).length).toBe(3);

    const logged = await app.takeFrontendErrors();
    expect(logged[0]).toContain('unhandledrejection: Error: the save never landed');
    expect(logged[1]).toBe('unhandledrejection: vault is locked');
    expect(logged[2]).toBe('unhandledrejection: 42');
  });
});
