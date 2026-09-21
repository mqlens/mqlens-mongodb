import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { loadSample, openCollection, view } from '../helpers';

// The appearance the app starts in (#396): what it reads from the settings,
// from its own cache while the vault is still locked, from the operating
// system, and from the size and sharpness of the screen.

const NORD_LIGHT = {
  preset_id: 'nord',
  mode: 'light',
  overrides: {},
  font_sans: 'Inter',
  font_mono: 'JetBrains Mono',
  font_size: 13,
  spacing_density: 'cozy',
};

const theme = (page: Page) =>
  page.evaluate(() => ({
    preset: document.documentElement.getAttribute('data-theme'),
    mode: document.documentElement.classList.contains('light') ? 'light' : 'dark',
    scale: Number(document.documentElement.style.getPropertyValue('--ui-scale') || '1'),
  }));

/** The appearances written back to the settings so far. */
const savedAppearances = async (app: App) =>
  (await app.calls('patch_app_settings'))
    .map((call) => (call.args as { patch: { appearance?: unknown } }).patch.appearance)
    .filter((appearance) => appearance !== undefined);

/**
 * Start with `cached` in the appearance cache, behind a locked vault.
 *
 * Written once per case and then reloaded into, rather than seeded with an
 * init script each time: those accumulate, and every earlier one runs again on
 * the next navigation in no guaranteed order.
 */
async function cachedAppearance(app: App, page: Page, cached: unknown): Promise<void> {
  if (!app.isOpen) await app.open({ vault: 'locked', vaultPassword: 's3cret' });
  await page.evaluate(
    (value) => localStorage.setItem('mqlens-appearance', typeof value === 'string' ? value : JSON.stringify(value)),
    cached,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vault-unlock')).toBeVisible();
}

test.describe('The appearance the app starts in', () => {
  test('comes from the settings, and is not written straight back', async ({ app, page }) => {
    await app.open({ settings: { appearance: NORD_LIGHT } });
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await expect.poll(async () => (await theme(page)).preset).toBe('nord');
    expect((await theme(page)).mode).toBe('light');
    // Loading an appearance is not a change, so nothing is saved for it.
    await page.waitForTimeout(1_000);
    expect(await savedAppearances(app)).toHaveLength(0);
  });

  test('waits for the vault, then takes what it holds', async ({ app, page }) => {
    await app.open({ vault: 'locked', vaultPassword: 's3cret', settings: { appearance: NORD_LIGHT } });
    await expect(page.getByTestId('vault-unlock')).toBeVisible();
    // Nothing has been read yet, so this is the default theme.
    expect((await theme(page)).mode).toBe('dark');

    await page.getByTestId('vault-password').fill('s3cret');
    await page.getByTestId('vault-unlock-btn').click();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await expect.poll(async () => (await theme(page)).preset).toBe('nord');
    expect((await theme(page)).mode).toBe('light');
  });

  test('uses its own cache before the settings can be read', async ({ app, page }) => {
    // Written on the last run, and read before anything is unlocked.
    await cachedAppearance(app, page, {
      preset_id: 'github-light',
      mode: 'light',
      overrides: {},
      font_size: 13,
      spacing_density: 'cozy',
    });

    expect(await theme(page)).toMatchObject({ preset: 'github-light', mode: 'light' });
  });

  test('ignores a cache it cannot read, or one that names no theme', async ({ app, page }) => {
    await cachedAppearance(app, page, '{ not json');
    expect((await theme(page)).mode).toBe('dark');

    await cachedAppearance(app, page, { mode: 'light' });
    expect((await theme(page)).mode).toBe('dark');
  });
});

test.describe('An appearance that follows the system', () => {
  test('starts light when the system is light, and the editors follow a change', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.open({ settings: { appearance: { ...NORD_LIGHT, mode: 'system' } } });
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    await expect.poll(async () => (await theme(page)).mode).toBe('light');

    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    const editor = view(page).getByTestId('query-filter-input').locator('.monaco-editor').first();
    const editorClass = async () => (await editor.getAttribute('class')) ?? '';
    await expect.poll(editorClass).toContain('vs');
    expect(await editorClass()).not.toContain('vs-dark');

    // The system turning dark turns the editors dark with it.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(editorClass).toContain('vs-dark');
  });

  test('starts dark when the system is dark', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await app.open({ settings: { appearance: { ...NORD_LIGHT, mode: 'system' } } });
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await expect.poll(async () => (await theme(page)).mode).toBe('dark');
    expect((await theme(page)).preset).toBe('nord');
  });
});

test.describe('The scale of the interface', () => {
  test('grows with the size of the window', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    const small = (await theme(page)).scale;

    // A window no bigger than the one before it changes nothing.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect.poll(async () => (await theme(page)).scale).toBe(small);

    await page.setViewportSize({ width: 1500, height: 1500 });
    await expect.poll(async () => (await theme(page)).scale).toBeGreaterThan(small);
    const medium = (await theme(page)).scale;

    await page.setViewportSize({ width: 2200, height: 2200 });
    await expect.poll(async () => (await theme(page)).scale).toBeGreaterThan(medium);
  });
});

test.describe('The scale on a sharp screen', () => {
  test.use({ deviceScaleFactor: 3, viewport: { width: 1280, height: 800 } });

  test('accounts for the pixels the screen packs in', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    // Three device pixels per CSS pixel is the top step.
    await expect.poll(async () => (await theme(page)).scale).toBeCloseTo(1.12, 2);
  });
});

test.describe('The scale on a screen of ordinary sharpness', () => {
  test.use({ deviceScaleFactor: 1.5, viewport: { width: 1280, height: 800 } });

  test('takes the smallest step up', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await expect.poll(async () => (await theme(page)).scale).toBeCloseTo(1.03, 2);
  });
});
