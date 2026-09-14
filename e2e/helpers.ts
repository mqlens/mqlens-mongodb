// UI steps shared by specs (#396). Selectors follow what a user sees: sidebar
// rows are plain clickable rows named by their text, not buttons.
import { expect, type Locator, type Page } from '@playwright/test';
import type { App } from './fixtures';

/**
 * Known bug, in Chromium. When several lines reach a single-line query editor (the
 * visual builder's filter, a loaded saved query, a history entry, an AI query
 * inserted and run), QueryEditor flattens them with setValue from inside Monaco's
 * content-change event, and the events recurse until the stack overflows. WebKit
 * isn't affected. Tests that hit it are marked `test.fail` with this reason.
 */
export const MULTILINE_QUERY_BUG = 'single-line query editor recurses on multi-line text (Maximum call stack size exceeded)';
export const hitsMultilineQueryBug = (browserName: string) => browserName === 'chromium';

/** The workspace tab on screen. */
export const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');

/** Do `action`, then return the arguments of the first `cmd` call it caused. */
export async function callFrom(app: App, cmd: string, action: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const before = (await app.calls(cmd)).length;
  await action();
  await expect.poll(async () => (await app.calls(cmd)).length, `a ${cmd} call`).toBeGreaterThan(before);
  return (await app.calls(cmd))[before].args as Record<string, unknown>;
}

/**
 * Replace the text of the Monaco editor inside `container`.
 *
 * Typing into Monaco goes through its auto-closing of brackets and quotes, so a
 * typed `{` gains a `}` the test never meant. Setting the model's value is what
 * a paste amounts to, and fires the same model-change events the app listens
 * to. It then waits two frames, so React has rendered the new value before the
 * test clicks anything that reads it.
 */
export async function setEditorText(page: Page, container: Locator, text: string): Promise<void> {
  const node = await container.locator('.monaco-editor').first().elementHandle();
  await page.evaluate(
    async ({ target, value }) => {
      type Editor = { getDomNode(): HTMLElement | null; setValue(v: string): void; focus(): void };
      const monaco = (await window.__MQLENS_E2E_MONACO__!()) as { editor: { getEditors(): Editor[] } };
      const editor = monaco.editor.getEditors().find((candidate) => {
        const dom = candidate.getDomNode();
        return dom !== null && (dom === target || dom.contains(target) || target.contains(dom));
      });
      if (!editor) throw new Error('No Monaco editor inside the given element');
      editor.setValue(value);
      editor.focus();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    { target: node!, value: text },
  );
}

/** Connect to the built-in sample server from Quick Start. */
export async function loadSample(page: Page): Promise<void> {
  await page.getByTestId('qs-load-sample').click();
  await page.getByRole('button', { name: 'Connection Sample (mqlens_demo)' }).waitFor();
}

/**
 * Move the pointer off the sidebar and let hover cards close.
 *
 * Hovering a sidebar row opens its stats card, which can sit on top of the rows
 * below it. A user's pointer leaves the row and the card closes; a click that
 * aims straight through the card would keep it open and never land.
 */
export async function dismissHoverCards(page: Page): Promise<void> {
  const size = page.viewportSize();
  if (size) await page.mouse.move(size.width - 5, size.height - 5);
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
}

const sidebar = (page: Page) => page.getByRole('complementary');

/** Expand a database and its Collections group in the sidebar. */
export async function expandCollections(page: Page, database: string): Promise<void> {
  await sidebar(page).getByText(database, { exact: true }).click();
  await dismissHoverCards(page);
  await sidebar(page).getByText('Collections', { exact: true }).first().click();
  await dismissHoverCards(page);
}

/** Open a collection from the sidebar in the current tab. */
export async function openCollection(page: Page, database: string, collection: string): Promise<void> {
  await expandCollections(page, database);
  await sidebar(page).getByText(collection, { exact: true }).click();
  await dismissHoverCards(page);
}

/** Open an already-listed collection in a new tab, from its sidebar context menu. */
export async function openInNewTab(page: Page, collection: string): Promise<void> {
  await sidebar(page).getByText(collection, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in New Tab' }).click();
  await dismissHoverCards(page);
}

/** Bring a workspace tab to the front by its label. */
export async function switchTab(page: Page, label: string): Promise<void> {
  await page.getByTestId('workspace-tab-strip').getByText(label).first().click();
}
