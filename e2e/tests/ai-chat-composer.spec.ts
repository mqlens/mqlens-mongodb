import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { connectStaging, dismissHoverCards, loadSample, openCollection, view } from '../helpers';

// The AI helper's composer and the panel around it (#396): the edge it is
// dragged by, what a paste puts in it, and what it refuses to send.

/** Settings with OpenAI as the default provider, so the picker starts on it. */
const OPENAI_DEFAULT = { ai_provider: 'openai', openai_model: 'gpt-4.1' };

async function choose(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

/** Open the AI helper on sales_db.customers of the sample server. */
async function openHelper(app: App, page: Page, seed: Seed = {}): Promise<Locator> {
  await app.open({ ...seed, settings: { ...OPENAI_DEFAULT, ...seed.settings } });
  await loadSample(page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
  await view(page).getByTestId('toggle-ai-helper').click();
  const panel = view(page).getByTestId('ai-helper-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Paste `items` into the composer, as a clipboard would deliver them. */
async function paste(panel: Locator, items: { type: string; name?: string }[]): Promise<void> {
  await panel.getByTestId('chat-input').evaluate((el, entries) => {
    const data = new DataTransfer();
    for (const entry of entries) {
      if (entry.name) data.items.add(new File([new Uint8Array([1, 2, 3])], entry.name, { type: entry.type }));
      else data.setData(entry.type, 'pasted text');
    }
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, items);
}

/** The width of the AI helper panel, in pixels. */
const panelWidth = async (panel: Locator) => (await panel.boundingBox())!.width;

/** Open the mongosh shell's AI panel, which has an edge of its own to drag. */
async function openShellHelper(app: App, page: Page): Promise<Locator> {
  await connectStaging(app, page, { settings: OPENAI_DEFAULT });
  await page.getByRole('complementary').getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
  await dismissHoverCards(page);
  const shell = page.getByTestId('mongo-shell');
  await shell.getByTestId('shell-ai-toggle').click();
  const panel = page.getByTestId('ai-helper-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('The edge of the AI helper', () => {
  test('drags wider and narrower, and no further than it should', async ({ app, page }) => {
    const panel = await openShellHelper(app, page);
    const resizer = page.getByTestId('ai-helper-resizer');
    const before = await panelWidth(panel);

    // Dragging the edge to the left makes the panel wider.
    const drag = async (toX: number) => {
      const box = (await resizer.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(toX, box.y + 20, { steps: 8 });
      await page.mouse.up();
    };
    const first = (await resizer.boundingBox())!;
    await drag(first.x - 120);
    await expect.poll(() => panelWidth(panel)).toBeGreaterThan(before);

    // Far past the left edge: it stops at the widest it is allowed to be.
    await drag(2);
    expect(await panelWidth(panel)).toBeLessThanOrEqual(600);

    // And far past the right edge: it stops at the narrowest.
    await drag(page.viewportSize()!.width - 2);
    expect(await panelWidth(panel)).toBeGreaterThanOrEqual(240);
  });
});

test.describe('Pasting into the composer', () => {
  test('an image pasted for a local command is refused, and text is left alone', async ({ app, page }) => {
    const panel = await openHelper(app, page);
    await choose(page, panel.getByTestId('ai-chat-provider-select'), 'Claude Code (local)');

    await paste(panel, [{ type: 'image/png', name: 'screenshot.png' }]);
    await expect(panel.getByTestId('chat-image-note')).toContainText('local command');
    await expect(panel.getByTestId('chat-pending-images')).toHaveCount(0);

    // Text is not the composer's business to intercept: nothing is said about it.
    await panel.getByTestId('chat-input').fill('');
    await paste(panel, [{ type: 'text/plain' }]);
    await expect(panel.getByTestId('chat-pending-images')).toHaveCount(0);
  });

  test('an image pasted for a provider that takes one attaches it', async ({ app, page }) => {
    const panel = await openHelper(app, page);

    await paste(panel, [{ type: 'image/png', name: 'screenshot.png' }]);
    await expect(panel.getByTestId('chat-pending-images').locator('img')).toHaveCount(1);
    await expect(panel.getByTestId('chat-image-note')).toHaveCount(0);
  });
});

test.describe('What the composer will not send', () => {
  test('Enter on an empty composer, and a file picker closed with nothing picked', async ({ app, page }) => {
    const panel = await openHelper(app, page);

    await panel.getByTestId('chat-input').click();
    await panel.getByTestId('chat-input').press('Enter');
    await expect(panel.getByTestId('chat-input')).toHaveValue('');
    expect(await app.calls('generate_mql_query')).toHaveLength(0);

    await panel.getByTestId('chat-attach-input').setInputFiles([]);
    await expect(panel.getByTestId('chat-pending-images')).toHaveCount(0);
    await expect(panel.getByTestId('chat-image-note')).toHaveCount(0);
  });
});
