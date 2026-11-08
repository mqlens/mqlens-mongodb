import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

// What a brand-new install shows on its way to the first connection.

const LAST_SEEN_KEY = 'mqlens-last-seen-version';

test.describe('First run: vault setup', () => {
  test('Enter in the confirm field creates the vault', async ({ app, page }) => {
    await app.open({ vault: 'uninitialized' });

    await expect(page.getByTestId('vault-password')).toBeFocused();
    await page.getByTestId('vault-password').fill('correct horse');
    await page.getByTestId('vault-confirm').fill('correct horse');
    await page.getByTestId('vault-confirm').press('Enter');

    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    expect(await app.calls('vault_initialize')).toHaveLength(1);
  });

  test('offers biometric unlock right after setup', async ({ app, page }) => {
    await app.open({ vault: 'uninitialized', biometric: { available: true, biometryType: 1, enrolled: false } });

    await page.getByTestId('vault-password').fill('correct horse');
    await page.getByTestId('vault-confirm').fill('correct horse');
    await page.getByTestId('vault-setup-btn').click();

    await expect(page.getByTestId('vault-biometric-offer')).toBeVisible();
    await page.getByTestId('vault-biometric-enable').click();

    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    expect(await app.calls('biometric_enable')).toHaveLength(1);
  });

  test('the biometric offer can be skipped', async ({ app, page }) => {
    await app.open({ vault: 'uninitialized', biometric: { available: true, biometryType: 2, enrolled: false } });

    await page.getByTestId('vault-password').fill('correct horse');
    await page.getByTestId('vault-confirm').fill('correct horse');
    await page.getByTestId('vault-setup-btn').click();
    await page.getByTestId('vault-biometric-skip').click();

    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    expect(await app.calls('biometric_enable')).toHaveLength(0);
  });
});

test.describe('First run: Quick Start', () => {
  test('the empty Connection Manager names the button that adds a connection', async ({ app, page }) => {
    await app.open();
    await page.getByTestId('quickstart-tab').getByRole('button', { name: 'Add connection' }).click();

    const newButton = page.getByRole('dialog').getByRole('button', { name: /^New/ }).first();
    const label = (await newButton.textContent())!.trim();
    await expect(page.getByRole('dialog')).toContainText(`"${label}"`);
    await expect(page.getByRole('dialog')).not.toContainText('from the sidebar');
  });

  test('docs and shortcuts stay reachable in a narrow window', async ({ app, page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await app.open();

    const docs = page.getByTestId('quickstart-tab').getByRole('link', { name: 'Documentation' });
    await docs.scrollIntoViewIfNeeded();
    await expect(docs).toBeVisible();
    await page.getByTestId('qs-view-all-shortcuts').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('qs-view-all-shortcuts')).toBeVisible();
  });
});

const theme = (page: Page) =>
  page.evaluate(() => ({
    preset: document.documentElement.getAttribute('data-theme'),
    mode: document.documentElement.classList.contains('light') ? 'light' : 'dark',
  }));

test.describe('First run: theme', () => {
  test('follows a light system', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    expect(await theme(page)).toEqual({ preset: 'mqlens-light', mode: 'light' });
  });

  test('follows a dark system', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    expect(await theme(page)).toEqual({ preset: 'mqlens-dark', mode: 'dark' });
  });
});

test.describe("What's New", () => {
  const seenBefore = (page: Page, version: string) =>
    page.addInitScript(([key, value]) => {
      // Only before the app has written its own, so a reload sees what the app stored.
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem(key, value);
        sessionStorage.setItem('seeded', '1');
      }
    }, [LAST_SEEN_KEY, version] as const);

  test('shows once after an update, and not again', async ({ app, page }) => {
    await seenBefore(page, '0.20.0');
    await app.open({ appVersion: '0.21.0' });

    const notice = page.getByTestId('whats-new');
    await expect(notice).toContainText('0.21.0');
    await expect(notice.getByRole('link')).toBeVisible();
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toBeHidden();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(notice).toBeHidden();
  });

  test('stays quiet on a fresh install', async ({ app, page }) => {
    await app.open({ appVersion: '0.21.0' });
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), LAST_SEEN_KEY)).toBe('0.21.0');
    await expect(page.getByTestId('whats-new')).toBeHidden();
  });
});
