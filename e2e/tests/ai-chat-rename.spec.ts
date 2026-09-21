import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { AiReplySeed } from '../harness/seed';
import { connectStaging, dismissHoverCards, openCollection, view } from '../helpers';

// A conversation whose collection is renamed under it (#396): the tab gets a
// new id, so the claim on the conversation has to move with it rather than
// leaving the old owner holding it.

const sidebar = (page: Page) => page.getByRole('complementary');
const PREMIUM: AiReplySeed = {
  query: { explanation: 'Customers on the Premium tier.', queryType: 'find', filter: { tier: 'Premium' } },
};

async function chatOnCustomers(app: App, page: Page): Promise<Locator> {
  await connectStaging(app, page, {
    aiReplies: [PREMIUM],
    settings: { ai_provider: 'openai', openai_model: 'gpt-4.1' },
  });
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
  await view(page).getByTestId('toggle-ai-helper').click();
  const panel = view(page).getByTestId('ai-helper-panel');
  await panel.getByTestId('chat-input').fill('premium customers');
  await panel.getByTestId('chat-send-btn').click();
  await expect(panel.getByTestId('chat-query-card')).toBeVisible();
  return panel;
}

test.describe('A renamed collection', () => {
  test('takes its conversation with it, and the claim on it', async ({ app, page }) => {
    const panel = await chatOnCustomers(app, page);
    const chatId = ((await app.calls('claim_chat')).at(-1)!.args as { chatId: string }).chatId;
    const claimsBefore = (await app.calls('claim_chat')).length;

    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('clients');
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(async () => (await app.calls('rename_collection')).length).toBe(1);
    await dismissHoverCards(page);

    // The conversation is still on screen under the new name.
    await expect(page.getByTestId('workspace-tab-strip').getByText('clients', { exact: true })).toBeVisible();
    await expect(view(page).getByTestId('ai-helper-panel').getByTestId('chat-msg-user')).toContainText('premium customers');

    // The old owner gives the conversation up and the new one claims it.
    await expect.poll(async () => (await app.calls('release_chat')).length).toBeGreaterThan(0);
    const released = (await app.calls('release_chat')).at(-1)!.args as { chatId: string; owner: string };
    expect(released.chatId).toBe(chatId);
    await expect.poll(async () => (await app.calls('claim_chat')).length).toBeGreaterThan(claimsBefore);
    const claimed = (await app.calls('claim_chat')).at(-1)!.args as { chatId: string; owner: string };
    expect(claimed.chatId).toBe(chatId);
    expect(claimed.owner).not.toBe(released.owner);

    // Conversations about the collection are re-targeted at its new name.
    await expect.poll(async () => (await app.calls('retarget_chat_scope')).length).toBeGreaterThan(0);
    expect((await app.calls('retarget_chat_scope')).at(-1)!.args).toMatchObject({ newCollection: 'clients' });
  });
});
