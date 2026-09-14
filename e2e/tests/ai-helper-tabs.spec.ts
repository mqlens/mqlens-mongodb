import { test, expect } from '../fixtures';
import { dismissHoverCards, loadSample, openCollection, openInNewTab, switchTab } from '../helpers';

// #392: recently used tabs stay mounted, and every collection tab gave its
// resizable split the same group id. Opening the AI helper in one tab while
// another mounted tab showed only the document area threw "Invalid 2 panel
// layout: 100%" (the tab error screen), or left the helper as a sliver that
// could not be dragged wider.
test.describe('AI helper with several collection tabs open (#392)', () => {
  test('opens as a usable panel and survives switching tabs', async ({ app, page }) => {
    await app.open();
    await loadSample(page);

    await openCollection(page, 'sales_db', 'customers');
    await expect(page.getByText('Alice Smith').first()).toBeVisible();

    // A second collection in its own tab, so two collection views are mounted at once.
    await openInNewTab(page, 'products');
    await expect(page.getByText('SuperBook Pro').first()).toBeVisible();

    // Open the helper in the visible tab while the other stays mounted without it.
    await page.getByTestId('toggle-ai-helper').filter({ visible: true }).click();
    await dismissHoverCards(page);

    await expect(page.getByTestId('tab-error-boundary'), 'the tab error screen must not appear').toHaveCount(0);
    const chatInput = page.getByTestId('chat-input').filter({ visible: true });
    await expect(chatInput).toBeVisible();
    // Usable, not a sliver: the panel's floor is 18% of the workspace.
    expect((await chatInput.boundingBox())!.width).toBeGreaterThan(150);

    // Showing a hidden tab lays its split out again; both directions must hold.
    await switchTab(page, 'customers');
    await expect(page.getByText('Alice Smith').first()).toBeVisible();
    await expect(page.getByTestId('tab-error-boundary')).toHaveCount(0);

    await switchTab(page, 'products');
    await expect(page.getByTestId('chat-input').filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId('tab-error-boundary')).toHaveCount(0);
  });
});
