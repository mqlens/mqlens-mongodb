import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, connectStaging, dismissHoverCards, expandCollections, loadSample, openCollection, setEditorText, view } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary').first();
/** Ask for a manual update check, once the app (and its update prompt) is on screen. */
async function checkForUpdates(page: Page): Promise<void> {
  await expect(page.getByTestId('quickstart-tab')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('mqlens:check-update')));
}

test.describe('Updates', () => {
  test('offers an update with its notes, and installs it with progress', async ({ app, page }) => {
    await app.open();
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        update_check: () => ({
          version: '0.21.0',
          current_version: '0.20.0',
          notes: '## What changed\n- **Faster** `find` results\n- See [the docs](https://mqlens.example/docs)\n\nA plain paragraph.',
          date: null,
        }),
        update_install: async (_args, backend) => {
          await backend.emit('update://progress', { downloaded: 50, total: 100 });
          await new Promise((resolve) => setTimeout(resolve, 500));
          return null;
        },
      });
    });

    await checkForUpdates(page);
    const dialog = page.getByTestId('update-dialog');
    await expect(dialog.getByTestId('update-version')).toContainText('0.21.0');
    await expect(dialog.getByTestId('update-notes')).toContainText('Faster');
    await expect(dialog.getByTestId('update-notes').getByRole('link', { name: 'the docs' })).toBeVisible();

    await dialog.getByTestId('update-now').click();
    await expect(dialog.getByTestId('update-progress')).toBeVisible();
    await expect.poll(async () => (await app.calls('plugin:process|restart')).length).toBe(1);
  });

  test('reports an offline or failed check, and Later dismisses an offer', async ({ app, page }) => {
    await app.open();

    await app.failNext('update_check', 'error sending request: network unreachable');
    await checkForUpdates(page);
    await expect(page.getByTestId('update-toast')).toBeVisible();

    await app.failNext('update_check', 'server responded with 500');
    await checkForUpdates(page);
    await expect(page.getByTestId('update-toast')).toBeVisible();

    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        update_check: () => ({ version: '0.21.0', current_version: '0.20.0', notes: null, date: null }),
      });
    });
    await checkForUpdates(page);
    const dialog = page.getByTestId('update-dialog');
    await dialog.getByTestId('update-later').click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('Dialogs and appearance', () => {
  test('drags a dialog by its header and resizes it from the corner', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('insert-doc-btn').click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toBeVisible();

    const start = (await modal.boundingBox())!;
    const handle = (await modal.locator('[data-dialog-drag-handle]').first().boundingBox())!;
    await page.mouse.move(handle.x + 40, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 100, handle.y + handle.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await modal.boundingBox())!.x).toBeLessThan(start.x - 50);

    const corner = (await modal.getByTestId('dialog-resize-handle').boundingBox())!;
    const width = (await modal.boundingBox())!.width;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 120, corner.y + 80, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await modal.boundingBox())!.width).toBeGreaterThan(width + 60);
  });

  /** Settings → Appearance, with a way to read the appearance saves sent so far. */
  async function openAppearance(app: App, page: Page) {
    await app.open();
    await page.getByRole('button', { name: 'Open Settings' }).click();
    const settings = page.getByTestId('settings-view');
    await settings.getByTestId('settings-tab-appearance').click();
    const saved = async () =>
      (await app.calls('patch_app_settings'))
        .map((call) => (call.args as { patch: { appearance?: { preset_id: string; mode: string } } }).patch.appearance)
        .filter((appearance) => appearance !== undefined);
    return { settings, saved };
  }

  // A fresh install's first change used to be lost (#403).
  test('saves the first appearance change after a fresh start', async ({ app, page }) => {
    const { settings, saved } = await openAppearance(app, page);
    await settings.getByRole('button', { name: /^Nord/ }).click();
    await expect.poll(async () => (await saved()).length, { timeout: 5_000 }).toBeGreaterThan(0);
  });

  test('saves appearance changes, exports a theme and imports it back', async ({ app, page }) => {
    const { settings, saved } = await openAppearance(app, page);
    const saves = async () => (await saved()).length;

    // Each change saves, so wait for the one that carries both.
    await settings.getByRole('button', { name: /^Nord/ }).click();
    await settings.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Light', exact: true }).click();
    await expect
      .poll(async () => (await saved()).at(-1))
      .toMatchObject({ preset_id: expect.stringContaining('nord'), mode: 'light' });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);

    const download = page.waitForEvent('download');
    await settings.getByRole('button', { name: 'Export theme' }).click();
    const theme = await readFile((await (await download).path())!, 'utf8');
    expect(() => JSON.parse(theme)).not.toThrow();

    const afterExport = await saves();
    let chooser = page.waitForEvent('filechooser');
    await settings.getByRole('button', { name: 'Import theme' }).click();
    await (await chooser).setFiles({ name: 'theme.json', mimeType: 'application/json', buffer: Buffer.from(theme) });
    await expect.poll(saves).toBeGreaterThan(afterExport);

    chooser = page.waitForEvent('filechooser');
    await settings.getByRole('button', { name: 'Import theme' }).click();
    await (await chooser).setFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ not a theme') });
    await expect(settings.getByTestId('theme-import-error')).toBeVisible();
  });
});

test.describe('Shell console and hover cards', () => {
  test('finds text in the shell transcript, selects all, and runs driver-backed commands', async ({ app, page }) => {
    // On a saved connection: the backend refuses mongosh and pipelines on the sample server.
    await connectStaging(app, page);
    await expandCollections(page, 'sales_db');
    await sidebar(page).getByText('customers', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
    await dismissHoverCards(page);
    const shell = page.getByTestId('mongo-shell');
    await expect(shell.getByRole('tab', { name: /Data Viewer/ })).toBeVisible();

    const run = async (command: string) => {
      const button = shell.getByRole('button', { name: 'Run', exact: true });
      await expect(button).toBeEnabled();
      await setEditorText(page, shell, command);
      await button.click();
      await expect(button).toBeEnabled();
    };

    const aggregated = await callFrom(app, 'execute_aggregate', () => run('db.customers.aggregate([{ $match: { tier: "Premium" } }])'));
    expect(JSON.parse(String(aggregated.pipeline))).toEqual([{ $match: { tier: 'Premium' } }]);
    const one = await callFrom(app, 'execute_mql_query', () => run('db.customers.findOne()'));
    expect(one).toMatchObject({ limit: 1 });
    const loose = await callFrom(app, 'execute_mql_query', () => run("db.customers.find({tier: 'Premium'}).sort({name: -1}).skip(1)"));
    expect(loose).toMatchObject({ filter: '{"tier":"Premium"}', sort: '{"name":-1}', skip: 1 });
    await callFrom(app, 'list_indexes', () => run('db.customers.getIndexes()'));

    await shell.getByRole('tab', { name: 'Console' }).click();
    const transcript = shell.getByTestId('shell-transcript');
    await transcript.click();
    await page.keyboard.press('ControlOrMeta+f');
    const findBar = shell.getByTestId('results-find-bar');
    await findBar.getByTestId('results-find-input').fill('customers');
    await expect(findBar.getByTestId('results-find-status')).not.toHaveText('No matches');
    await findBar.getByTestId('results-find-next').click();
    await findBar.getByTestId('results-find-close').click();

    await transcript.click();
    await page.keyboard.press('ControlOrMeta+a');
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('db.customers.findOne()');
  });

  test('hovering an index shows its usage', async ({ app, page }) => {
    const uri = 'mongodb://staging.example:27017';
    await app.open({ profiles: [{ id: 'p-staging', name: 'Staging', uri }], servers: { [uri]: SAMPLE_SERVER } });
    await page.getByTestId('conn-card-p-staging').click();
    await openCollection(page, 'sales_db', 'customers');
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);

    await sidebar(page).getByText('email_1', { exact: true }).hover();
    await expect(page.getByTestId('index-stats-card')).toBeVisible();
    await dismissHoverCards(page);
  });
});

test.describe('AI helper images', () => {
  test('attaches a PNG and sends it, and refuses other files', async ({ app, page }) => {
    await app.open({
      settings: { ai_provider: 'openai', openai_model: 'gpt-4.1' },
      aiReplies: [{ query: { explanation: 'Premium customers.', queryType: 'find', filter: { tier: 'Premium' } } }],
    });
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('toggle-ai-helper').click();
    const panel = view(page).getByTestId('ai-helper-panel');
    const attach = panel.getByTestId('chat-attach-input');

    // A 1x1 PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    await attach.setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: png });
    await attach.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await attach.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(6 * 1024 * 1024) });

    await panel.getByTestId('chat-input').fill('customers like this screenshot');
    const sent = await callFrom(app, 'generate_mql_query', () => panel.getByTestId('chat-send-btn').click());
    const images = sent.images as Array<{ media_type: string }>;
    expect(images).toHaveLength(1);
    expect(images[0].media_type).toBe('image/png');
  });
});
