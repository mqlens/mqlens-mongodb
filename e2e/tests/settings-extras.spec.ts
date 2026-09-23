import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';

// Settings when something is missing or refuses (#396): a password change that
// is not filled in, a vault reset the backend refuses, lists that cannot be
// read, and the MCP tab watching the server it started.

const settings = (page: Page) => page.getByTestId('settings-view');

async function openSettings(app: App, page: Page, section: string, seed: Seed = {}): Promise<void> {
  await app.open(seed);
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await expect(settings(page)).toBeVisible();
  await settings(page).getByTestId(`settings-tab-${section}`).click();
}

test.describe('The security tab', () => {
  test('a password change needs both passwords, and a refused reset says why', async ({ app, page }) => {
    await openSettings(app, page, 'security', { vaultPassword: 'old-master-pw' });
    const message = settings(page).getByTestId('sec-msg');

    // The current password on its own is not a change.
    await settings(page).getByTestId('sec-old-pw').fill('old-master-pw');
    await settings(page).getByTestId('sec-change-pw-btn').click();
    await expect(message).toHaveText('New password is required');
    expect(await app.calls('vault_change_password')).toHaveLength(0);

    page.once('dialog', (dialog) => void dialog.accept());
    await app.failNext('vault_reset', 'the vault file is read-only');
    await settings(page).getByTestId('sec-reset-btn').click();
    await expect(message).toContainText('the vault file is read-only');
  });

  test('offers to use the fingerprint reader the machine has', async ({ app, page }) => {
    await openSettings(app, page, 'security', { biometric: { available: true, enrolled: false } });
    const toggle = settings(page).getByTestId('sec-biometric-toggle');

    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect.poll(async () => (await app.calls('biometric_enable')).length).toBe(1);
    await expect(toggle).toBeChecked();
  });
});

test.describe('Lists that cannot be read', () => {
  test('the MCP tab shows no connections when the profiles fail to load', async ({ app, page }) => {
    await app.open({
      mcp: { enabled: true },
      profiles: [{ id: 'p-staging', name: 'Staging', uri: 'mongodb://staging.example:27017' }],
    });
    await app.failNext('load_connection_profiles', 'the vault could not be read');
    await page.getByRole('button', { name: 'Open Settings' }).click();
    await settings(page).getByTestId('settings-tab-mcp').click();

    await expect(settings(page).getByTestId('mcp-profiles-empty')).toBeVisible();
  });

  test('the tools tab shows none when their status fails', async ({ app, page }) => {
    await app.open();
    await app.failNext('managed_tools_status', 'the tools directory could not be read');
    await page.getByRole('button', { name: 'Open Settings' }).click();
    await settings(page).getByTestId('settings-tab-tools').click();

    await expect(settings(page).locator('[data-testid^="settings-managed-tool-"]')).toHaveCount(0);
  });
});

test.describe('The MCP tab', () => {
  test('copies the snippet an editor needs, and follows the server it started', async ({ app, page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard permissions are granted in Chromium only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSettings(app, page, 'mcp', { mcp: { enabled: true } });

    await settings(page).getByTestId('mcp-claude-copy').click();
    await expect(settings(page).getByTestId('mcp-claude-copy')).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('mqlens');

    // The tab keeps asking the server how it is doing.
    const before = (await app.calls('mcp_get_status')).length;
    await expect.poll(async () => (await app.calls('mcp_get_status')).length, { timeout: 10_000 }).toBeGreaterThan(before);
  });
});

test.describe('The AI tab', () => {
  test('an active provider that is removed falls back to the built-in one', async ({ app, page }) => {
    const local = { id: 'local-llama', name: 'Local Llama', kind: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: 'llama3' };
    await openSettings(app, page, 'ai', { settings: { ai_providers: [local], ai_provider: 'local-llama' } });
    await expect(settings(page).getByTestId('ai-provider-select')).toContainText('Local Llama');

    await settings(page).getByTestId('ai-provider-remove-local-llama').click();

    await expect(settings(page).getByTestId('ai-provider-select')).toContainText('Anthropic');
    await expect
      .poll(async () =>
        (await app.calls('patch_app_settings'))
          .map((call) => (call.args as { patch: { ai_provider?: string } }).patch.ai_provider)
          .filter((provider) => provider !== undefined)
          .at(-1),
      )
      .toBe('anthropic');
  });
});
