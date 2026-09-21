import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { callFrom } from '../helpers';

// The provider form's slower moments (#396): a model list that lands after a
// newer one, a provider edited rather than added, and a local command that
// has no endpoint to ask.

const settings = (page: Page) => page.getByTestId('settings-view');

async function choose(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

/** Open Settings on its AI tab, and return the provider manager. */
async function openProviders(app: App, page: Page, seed: Seed = {}): Promise<Locator> {
  await app.open(seed);
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await settings(page).getByTestId('settings-tab-ai').click();
  return settings(page).getByTestId('ai-provider-manager');
}

test.describe('Listing a provider\'s models', () => {
  test('a list that lands after a newer one is dropped', async ({ app, page }) => {
    const manager = await openProviders(app, page, { aiModels: ['first-model'] });
    await manager.getByTestId('ai-provider-add').click();
    const form = manager.getByTestId('ai-provider-form');
    // The first list is still on its way when the endpoint changes.
    await page.evaluate(() => {
      let calls = 0;
      const held = window as unknown as { releaseFirstList?: () => void };
      window.__MQLENS_E2E__!.register({
        list_ai_models: () => {
          calls += 1;
          return calls === 1
            ? new Promise((resolve) => {
                held.releaseFirstList = () => resolve(['first-model']);
              })
            : ['newer-model'];
        },
      });
    });
    await form.getByTestId('ai-provider-url-input').fill('http://localhost:11434/v1');
    await expect.poll(async () => (await app.calls('list_ai_models')).length).toBe(1);

    await form.getByTestId('ai-provider-url-input').fill('http://127.0.0.1:11435/v1');
    await expect.poll(async () => (await app.calls('list_ai_models')).length).toBeGreaterThan(1);
    await expect(form.getByTestId('ai-provider-models-status')).toContainText('available');

    // The older reply arrives last, and is ignored for the newer one.
    await page.evaluate(() => (window as unknown as { releaseFirstList?: () => void }).releaseFirstList?.());
    await expect(form.getByTestId('ai-provider-models-status')).toContainText('1 model');
    await form.getByTestId('ai-provider-model-select').click();
    await expect(page.getByTestId('ai-provider-model-options')).toContainText('newer-model');
    await expect(page.getByTestId('ai-provider-model-options')).not.toContainText('first-model');
  });
});

test.describe('Editing a saved provider', () => {
  test('keeps its id and saves what changed', async ({ app, page }) => {
    const local = {
      id: 'local-llama',
      name: 'Local Llama',
      kind: 'openai-compatible',
      base_url: 'http://localhost:11434/v1',
      model: 'llama3',
    };
    const manager = await openProviders(app, page, { settings: { ai_providers: [local] } });

    await manager.getByTestId('ai-provider-edit-local-llama').click();
    const form = manager.getByTestId('ai-provider-form');
    await expect(form.getByTestId('ai-provider-name-input')).toHaveValue('Local Llama');
    await form.getByTestId('ai-provider-model-input').fill('llama3.1');

    await callFrom(app, 'patch_app_settings', () => form.getByTestId('ai-provider-save').click());
    const providers = (await app.calls('patch_app_settings'))
      .map((call) => (call.args as { patch: { ai_providers?: { id: string; model: string }[] } }).patch.ai_providers)
      .filter((list) => list !== undefined)
      .at(-1)!;
    // Edited in place: one provider, same id, new model.
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: 'local-llama', model: 'llama3.1' });
    await expect(manager.getByTestId('ai-provider-row-local-llama')).toContainText('llama3.1');
  });

  test('a local command asks nothing until it is told how to list models', async ({ app, page }) => {
    const manager = await openProviders(app, page);
    await manager.getByTestId('ai-provider-add').click();
    const form = manager.getByTestId('ai-provider-form');

    await choose(page, form.getByTestId('ai-provider-kind-select'), 'Local command');
    await form.getByTestId('ai-provider-name-input').fill('My CLI');
    await form.getByTestId('ai-provider-command-input').fill('my-cli --json');
    // A command has no endpoint to ask, so nothing is fetched on its own.
    await page.waitForTimeout(1_000);
    expect(await app.calls('list_ai_models')).toHaveLength(0);

    await form.getByTestId('ai-provider-models-command-input').fill('my-cli models');
    await form.getByTestId('ai-provider-model-input').fill('my-model');
    await callFrom(app, 'patch_app_settings', () => form.getByTestId('ai-provider-save').click());
    await expect(manager.getByTestId('ai-provider-list')).toContainText('My CLI');
  });
});
