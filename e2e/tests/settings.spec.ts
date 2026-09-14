import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';

const settings = (page: Page) => page.getByTestId('settings-view');

async function openSettings(page: Page, section?: string): Promise<void> {
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await expect(settings(page)).toBeVisible();
  if (section) await settings(page).getByTestId(`settings-tab-${section}`).click();
}

/** Pick an option from a Radix select, which lists its options in a portal. */
async function choose(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

/** Every settings patch sent so far, merged in order: what the vault now holds. */
async function patched(app: App): Promise<Record<string, unknown>> {
  const calls = await app.calls('patch_app_settings');
  return Object.assign({}, ...calls.map((call) => (call.args as { patch: Record<string, unknown> }).patch));
}

test.describe('Settings', () => {
  test('every section opens under its own heading', async ({ app, page }) => {
    await app.open();
    await openSettings(page);

    for (const id of ['appearance', 'ai', 'mcp', 'tools', 'updates', 'shortcuts', 'security', 'audit', 'language']) {
      const nav = settings(page).getByTestId(`settings-tab-${id}`);
      await nav.click();
      await expect(settings(page).getByRole('heading', { level: 1 })).toHaveText((await nav.innerText()).trim());
    }
  });

  test('filters the keyboard shortcuts', async ({ app, page }) => {
    await app.open();
    await openSettings(page, 'shortcuts');

    const rows = settings(page).locator('[data-testid^="shortcut-row-"]');
    await expect(rows.first()).toBeVisible();
    await settings(page).getByTestId('shortcuts-filter').fill('no-such-shortcut-anywhere');
    await expect(settings(page).getByTestId('shortcuts-empty')).toBeVisible();
    await expect(rows).toHaveCount(0);
  });

  test('saves the AI provider, its key and model, and custom instructions', async ({ app, page }) => {
    await app.open();
    await openSettings(page, 'ai');
    const view = settings(page);

    await choose(page, view.getByTestId('ai-provider-select'), 'Claude Code (local)');
    await expect(view.getByTestId('agent-availability')).toContainText('2.1.0');
    await expect(view.getByTestId('local-command-input')).toHaveValue('claude -p {prompt}');

    await choose(page, view.getByTestId('ai-provider-select'), 'OpenAI (ChatGPT)');
    await view.getByTestId('openai-key-input').fill('sk-e2e-key');
    await view.getByTestId('openai-model-input').fill('gpt-4.1');
    await view.getByTestId('ai-instructions-input').fill('Prefer aggregation pipelines.');
    await view.getByTestId('settings-save-btn').click();

    await expect(view.getByText('Settings saved')).toBeVisible();
    expect(await patched(app)).toMatchObject({
      ai_provider: 'openai',
      openai_api_key: 'sk-e2e-key',
      openai_model: 'gpt-4.1',
      ai_custom_instructions: 'Prefer aggregation pipelines.',
    });
  });

  test('tests the mongosh path and lists managed tools', async ({ app, page }) => {
    await app.open();
    await openSettings(page, 'tools');
    const view = settings(page);

    await expect(view.getByTestId('settings-managed-tool-mongosh')).toContainText('2.3.2');
    await expect(view.getByTestId('settings-managed-tool-mongodb-database-tools')).toBeVisible();

    const path = view.getByTestId('mongosh-path-input');
    await path.fill('/opt/nothing-here');
    await view.getByRole('button', { name: /test/i }).click();
    await expect(view.locator('footer')).toContainText('Failed to run mongosh: program not found');

    await path.fill('/usr/local/bin/mongosh');
    await view.getByRole('button', { name: /test/i }).click();
    await expect(view.locator('footer')).toContainText('2.3.2');

    // The tools directory is kept on this machine, not in the vault.
    await view.getByTestId('mongo-tools-dir-input').fill('/opt/mongodb-tools/bin');
    expect(await page.evaluate(() => localStorage.getItem('mqlens.mongoToolsDir'))).toBe('/opt/mongodb-tools/bin');

    await view.getByTestId('settings-save-btn').click();
    await expect(view.getByText('Settings saved')).toBeVisible();
    expect(await patched(app)).toMatchObject({ mongosh_path: '/usr/local/bin/mongosh' });
  });

  test('switches the update channel and checks for updates on request', async ({ app, page }) => {
    await app.open();
    await openSettings(page, 'updates');
    const view = settings(page);

    const checksBefore = (await app.calls('update_check')).length;
    await view.getByTestId('check-updates-btn').click();
    await expect.poll(async () => (await app.calls('update_check')).length).toBeGreaterThan(checksBefore);

    await view.getByTestId('update-channel-dev').click();
    await view.getByTestId('settings-save-btn').click();
    await expect(view.getByText('Settings saved')).toBeVisible();
    expect(await patched(app)).toMatchObject({ update_channel: 'dev' });
  });

  test('changes the master password', async ({ app, page }) => {
    await app.open({ vaultPassword: 'old-master-pw' });
    await openSettings(page, 'security');
    const view = settings(page);
    const message = view.getByTestId('sec-msg');
    const change = view.getByTestId('sec-change-pw-btn');

    await change.click();
    await expect(message).toHaveText('Current password is required');

    await view.getByTestId('sec-old-pw').fill('old-master-pw');
    await view.getByTestId('sec-new-pw').fill('new-master-pw');
    await view.getByTestId('sec-new-pw2').fill('something-else');
    await change.click();
    await expect(message).toHaveText('New passwords do not match');

    await view.getByTestId('sec-old-pw').fill('not-the-password');
    await view.getByTestId('sec-new-pw2').fill('new-master-pw');
    await change.click();
    await expect(message).toContainText('Incorrect master password');

    await view.getByTestId('sec-old-pw').fill('old-master-pw');
    await change.click();
    await expect(message).toHaveText('Master password changed');
    await expect(view.getByTestId('sec-old-pw')).toHaveValue('');
    expect(await app.calls('vault_change_password')).toHaveLength(2);
  });

  test('resets the vault only once confirmed', async ({ app, page }) => {
    await app.open();
    await openSettings(page, 'security');
    const reset = settings(page).getByTestId('sec-reset-btn');

    page.once('dialog', (dialog) => void dialog.dismiss());
    await reset.click();
    expect(await app.calls('vault_reset')).toHaveLength(0);

    page.once('dialog', (dialog) => void dialog.accept());
    await reset.click();
    await expect.poll(async () => (await app.calls('vault_reset')).length).toBe(1);
  });

  test('saves audit settings', async ({ app, page }) => {
    await app.open();
    await openSettings(page, 'audit');
    const view = settings(page);

    await choose(page, view.getByTestId('audit-retention-select'), /90/);
    await view.getByTestId('audit-level-select').click();
    await page.getByRole('option').nth(2).click();
    await view.getByTestId('audit-include-payloads-toggle').click();
    await view.getByTestId('audit-enabled-toggle').click();
    // With auditing off, its options can't be changed.
    await expect(view.getByTestId('audit-level-select')).toBeDisabled();

    await view.getByTestId('settings-save-btn').click();
    await expect(view.getByText('Settings saved')).toBeVisible();
    expect(await patched(app)).toMatchObject({
      audit_enabled: false,
      audit_level: 'C',
      audit_retention_days: 90,
      audit_include_payloads: true,
    });
  });

  test('switches the interface language', async ({ app, page }) => {
    await app.open();
    await openSettings(page, 'language');

    await settings(page).getByRole('combobox').click();
    // The first option follows the system; the next is a specific language.
    await page.getByRole('option').nth(1).click();
    await expect
      .poll(async () => (await app.calls('patch_app_settings')).some((call) => 'locale' in (call.args as { patch: object }).patch))
      .toBe(true);
  });

  test('enables the MCP server and shows how to connect a client', async ({ app, page }) => {
    await app.open({
      profiles: [
        { id: 'p-agent', name: 'Agent Prod', uri: 'mongodb://mock', mcp_enabled: true },
        { id: 'p-private', name: 'Private', uri: 'mongodb://mock' },
      ],
    });
    await openSettings(page, 'mcp');
    const view = settings(page);

    // Only profiles opted in from the connection editor are exposed.
    await expect(view.getByTestId('mcp-profile-p-agent')).toHaveText('Agent Prod');
    await expect(view.getByTestId('mcp-profile-p-private')).toHaveCount(0);
    await expect(view.getByTestId('mcp-log-empty')).toBeVisible();
    await expect(view.getByTestId('mcp-agent-prompt')).toContainText('list_connections');

    const port = view.getByTestId('mcp-port-input');
    const toggle = view.getByTestId('mcp-enable-toggle');
    await port.fill('80');
    await toggle.click();
    await expect(view.getByTestId('mcp-error')).toContainText('1024');
    expect(await app.calls('mcp_set_enabled')).toHaveLength(0);

    await port.fill('8800');
    await toggle.click();
    const snippet = view.getByTestId('mcp-claude-snippet');
    await expect(snippet).toContainText('http://127.0.0.1:8800/mcp');
    await expect(snippet).toContainText('Bearer e2e-token-1');
    await expect(view.getByTestId('mcp-cursor-snippet')).toContainText('"url": "http://127.0.0.1:8800/mcp"');
    await expect(port).toBeDisabled();

    const token = view.getByTestId('mcp-token-display');
    await expect(token).not.toContainText('e2e-token');
    await view.getByTestId('mcp-token-reveal').click();
    await expect(token).toHaveText('e2e-token-1');

    await view.getByTestId('mcp-token-regenerate').click();
    await expect(view.getByTestId('mcp-regenerate-note')).toBeVisible();
    await expect(token).toHaveText('e2e-token-2');
    await expect(snippet).toContainText('Bearer e2e-token-2');

    await toggle.click();
    await expect(snippet).toHaveCount(0);
    expect((await app.calls('mcp_set_enabled')).map((call) => call.args)).toEqual([
      { enabled: true, port: 8800 },
      { enabled: false, port: null },
    ]);
  });

  test('lists the MCP call log, newest first', async ({ app, page }) => {
    await app.open({
      mcp: {
        enabled: true,
        log: [
          { tsMs: 1_747_000_000_000, tool: 'list_databases', summary: '4 databases', ok: true },
          { tsMs: 1_747_000_005_000, tool: 'find', summary: 'sales_db.missing', ok: false },
        ],
      },
    });
    await openSettings(page, 'mcp');

    const rows = settings(page).getByTestId('mcp-log-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('find');
    await expect(rows.last()).toContainText('list_databases');
  });
});
