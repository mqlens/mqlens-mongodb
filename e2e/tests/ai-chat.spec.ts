import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { AiReplySeed } from '../harness/seed';
import { callFrom, loadSample, openCollection, view } from '../helpers';

/** Settings with OpenAI as the default provider, so the picker starts on it. */
const OPENAI_DEFAULT = { ai_provider: 'openai', openai_model: 'gpt-4.1' };

const PREMIUM_QUERY: AiReplySeed = {
  query: { explanation: 'Customers on the Premium tier.', queryType: 'find', filter: { tier: 'Premium' } },
};
const COUNT_BY_TIER: AiReplySeed = {
  query: {
    explanation: 'Counts customers per tier.',
    queryType: 'aggregate',
    pipeline: [{ $group: { _id: '$tier', customers: { $sum: 1 } } }],
  },
};

async function openHelper(app: App, page: Page, aiReplies: AiReplySeed[]) {
  await app.open({ settings: OPENAI_DEFAULT, aiModels: ['gpt-4.1', 'gpt-4o-mini'], aiReplies });
  await loadSample(page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
  await view(page).getByTestId('toggle-ai-helper').click();
  const panel = view(page).getByTestId('ai-helper-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function ask(panel: ReturnType<Page['getByTestId']>, prompt: string): Promise<void> {
  await panel.getByTestId('chat-input').fill(prompt);
  await panel.getByTestId('chat-send-btn').click();
}

test.describe('AI helper chat', () => {
  test('generates a query and runs it in the collection', async ({ app, page }) => {
    const panel = await openHelper(app, page, [PREMIUM_QUERY]);
    await expect(panel.getByTestId('ai-chat-provider-picker')).toBeVisible();

    const generated = await callFrom(app, 'generate_mql_query', () => ask(panel, 'premium customers'));
    expect(generated).toMatchObject({ prompt: 'premium customers', collection: 'customers', database: 'sales_db', providerId: 'openai' });
    await expect(panel.getByTestId('chat-msg-user')).toContainText('premium customers');
    await expect(panel.getByTestId('chat-query-card')).toContainText('Premium');

    const run = await callFrom(app, 'execute_mql_query', () => panel.getByTestId('chat-insert-run-btn').click());
    expect(JSON.parse(String(run.filter))).toEqual({ tier: 'Premium' });
    await expect(view(page)).not.toContainText('Bob Johnson');
  });

  test('shows a provider error as a reply, then inserts an aggregation', async ({ app, page }) => {
    const panel = await openHelper(app, page, [{ error: 'rate limited, try again in 20s' }, COUNT_BY_TIER]);

    await ask(panel, 'count customers by tier');
    await expect(panel.getByTestId('chat-msg-assistant').last()).toContainText('rate limited');

    await ask(panel, 'count customers by tier');
    await expect(panel.getByTestId('chat-query-card')).toContainText('$group');
    await panel.getByTestId('chat-insert-btn').click();
    await expect(view(page).getByTestId('aggregation-pipeline-editor')).toBeVisible();
  });

  test('starts a new chat and returns to an earlier one from history', async ({ app, page }) => {
    const panel = await openHelper(app, page, [PREMIUM_QUERY]);
    await ask(panel, 'premium customers');
    await expect(panel.getByTestId('chat-query-card')).toBeVisible();

    await panel.getByTestId('ai-chat-new-btn').click();
    await expect(panel.getByTestId('chat-msg-user')).toHaveCount(0);

    await panel.getByTestId('ai-chat-history-btn').click();
    const history = page.getByTestId('ai-chat-history-dropdown');
    await history.getByTestId('ai-chat-history-item-0').click();
    await expect(panel.getByTestId('chat-msg-user')).toContainText('premium customers');

    await panel.getByTestId('ai-chat-history-btn').click();
    await callFrom(app, 'delete_chat', () => history.getByTestId('ai-chat-history-delete-0').click());
  });
});

test.describe('AI providers in Settings', () => {
  test('adds a custom provider after its checks pass, then removes it', async ({ app, page }) => {
    await app.open();
    await page.getByRole('button', { name: 'Open Settings' }).click();
    const settings = page.getByTestId('settings-view');
    await settings.getByTestId('settings-tab-ai').click();
    const manager = settings.getByTestId('ai-provider-manager');

    await manager.getByTestId('ai-provider-add').click();
    const form = manager.getByTestId('ai-provider-form');
    await form.getByTestId('ai-provider-save').click();
    await expect(form.getByTestId('ai-provider-error')).toContainText('needs a display name');

    await form.getByTestId('ai-provider-name-input').fill('Local Llama');
    await form.getByTestId('ai-provider-save').click();
    await expect(form.getByTestId('ai-provider-error')).toContainText('has no endpoint URL');

    await form.getByTestId('ai-provider-url-input').fill('http://localhost:11434/v1');
    await form.getByTestId('ai-provider-model-input').fill('llama3');
    const saved = await callFrom(app, 'patch_app_settings', () => form.getByTestId('ai-provider-save').click());
    expect((saved.patch as { ai_providers: unknown[] }).ai_providers).toEqual([
      expect.objectContaining({ id: 'local-llama', name: 'Local Llama', base_url: 'http://localhost:11434/v1', model: 'llama3' }),
    ]);
    await expect(manager.getByTestId('ai-provider-row-local-llama')).toBeVisible();

    const removed = await callFrom(app, 'patch_app_settings', () => manager.getByTestId('ai-provider-remove-local-llama').click());
    expect((removed.patch as { ai_providers: unknown[] }).ai_providers).toEqual([]);
    await expect(manager.getByTestId('ai-provider-row-local-llama')).toHaveCount(0);
  });
});
