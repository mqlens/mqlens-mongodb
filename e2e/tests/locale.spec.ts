import { test, expect } from '../fixtures';

// The language the app speaks (#396): the one the settings hold, when the
// vault has to be opened first, and what it makes of the languages the
// machine reports.

test.describe('The language the app starts in', () => {
  test('comes from the settings', async ({ app, page }) => {
    await app.open({ settings: { locale: 'de' } });

    await expect(page.getByTestId('qs-load-sample')).toContainText('Beispieldaten laden');
  });

  test('stays English when the settings say so, whatever the machine speaks', async ({ app, page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['de-DE', 'de'] });
    });
    await app.open({ settings: { locale: 'en' } });

    await expect(page.getByTestId('qs-load-sample')).toContainText('Load sample data');
  });

  test('waits for the vault, then speaks what it holds', async ({ app, page }) => {
    await app.open({ vault: 'locked', vaultPassword: 's3cret', settings: { locale: 'de' } });
    await expect(page.getByTestId('vault-unlock')).toBeVisible();

    await page.getByTestId('vault-password').fill('s3cret');
    await page.getByTestId('vault-unlock-btn').click();
    await expect(page.getByTestId('qs-load-sample')).toContainText('Beispieldaten laden');
  });
});

test.describe('The languages the machine reports', () => {
  test('follows the system when the settings name no language', async ({ app, page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['de-AT', 'en-GB'] });
    });
    await app.open();

    await expect(page.getByTestId('qs-load-sample')).toContainText('Beispieldaten laden');
  });

  test('skips a language it cannot read, and one that names nothing', async ({ app, page }) => {
    await page.addInitScript(() => {
      // A tag that is not a tag, then "undetermined", then a real preference.
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['!!not a tag', 'und-CH', 'de-DE'] });
    });
    await app.open();

    await expect(page.getByTestId('qs-load-sample')).toContainText('Beispieldaten laden');
  });

  test('falls back to English when the machine reports nothing usable', async ({ app, page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => [] });
      Object.defineProperty(navigator, 'language', { configurable: true, get: () => '' });
    });
    await app.open();

    await expect(page.getByTestId('qs-load-sample')).toContainText('Load sample data');
  });
});
