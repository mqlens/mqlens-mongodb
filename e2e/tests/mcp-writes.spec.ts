import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom } from '../helpers';

// A write an outside client asked MQLens to make (#396): nobody's conversation
// asked for it, so the app asks — wherever the user happens to be.

const confirm = (page: Page) => page.getByTestId('mcp-write-confirm');

/** Deliver a write request that belongs to no conversation. */
const requestWrite = (app: App, id: string, tool: string, summary: string) =>
  app.emit('mcp-write-request', { id, tool, summary, requester: null });

test.describe('A write nobody asked for', () => {
  test('is put to the user, and refused when they say no', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await requestWrite(app, 'w1', 'delete_many', 'Delete 3 documents from sales_db.customers');
    await expect(confirm(page)).toBeVisible();
    await expect(confirm(page).getByTestId('mcp-write-confirm-tool')).toContainText('delete_many');
    await expect(confirm(page).getByTestId('mcp-write-confirm-summary')).toContainText('sales_db.customers');

    const answered = await callFrom(app, 'mcp_resolve_write', () =>
      confirm(page).getByTestId('mcp-write-confirm-refuse').click(),
    );
    expect(answered).toMatchObject({ id: 'w1', approved: false });
    await expect(confirm(page)).toHaveCount(0);
  });

  test('is worked through one at a time, oldest first', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await requestWrite(app, 'w1', 'delete_many', 'Delete 3 documents');
    await requestWrite(app, 'w2', 'drop_collection', 'Drop sales_db.archive');
    await expect(confirm(page).getByTestId('mcp-write-confirm-tool')).toContainText('delete_many');

    await callFrom(app, 'mcp_resolve_write', () => confirm(page).getByTestId('mcp-write-confirm-allow').click());
    // The next one takes its place rather than stacking behind it.
    await expect(confirm(page).getByTestId('mcp-write-confirm-tool')).toContainText('drop_collection');
    expect((await app.calls('mcp_resolve_write'))[0].args).toMatchObject({ id: 'w1', approved: true });
  });

  test('goes away when another window answers it', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();

    await requestWrite(app, 'w1', 'update_many', 'Update 12 documents');
    await expect(confirm(page)).toBeVisible();

    await app.emit('mcp-write-settled', { id: 'w1' });
    await expect(confirm(page)).toHaveCount(0);
    // Answered elsewhere: this window has nothing to say about it.
    expect(await app.calls('mcp_resolve_write')).toHaveLength(0);
  });
});
