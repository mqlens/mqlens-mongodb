import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Doc } from '../harness/seed';
import { STAGING_URI, connectStaging, loadSample, openCollection, view } from '../helpers';

const viewButton = (page: Page, name: 'JSON' | 'Tree' | 'Table' | 'Chart') => view(page).getByRole('button', { name, exact: true });
const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();

/** Open shop.things on a saved connection whose server holds only `docs`. */
async function openThings(app: App, page: Page, docs: Doc[]): Promise<void> {
  await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs } } } } } });
  await openCollection(page, 'shop', 'things');
  await expect(view(page).locator('[data-json-line]').first()).toBeVisible();
}

/** Open find over the results with Ctrl+F, from inside `target`, and search for `text`. */
async function findInResults(page: Page, target: ReturnType<Page['locator']>, text: string): Promise<void> {
  await target.click();
  await page.keyboard.press('Control+f');
  await view(page).getByTestId('results-find-input').fill(text);
}

test.describe('Results views', () => {
  test('shows an empty array or document on one line', async ({ app, page }) => {
    await openThings(app, page, [{ _id: 1, name: 'empty', tags: [], meta: {} }]);
    await expect(jsonLine(page, '"tags"')).toContainText('[]');
    await expect(jsonLine(page, '"meta"')).toContainText('{}');
  });

  test('finds text in the tree, inside collapsed levels too, and in the table', async ({ app, page }) => {
    await openThings(app, page, [{ _id: 1, name: 'outer', a: { b: { c: 'deep value' } }, list: [1, 2, 3] }]);

    await viewButton(page, 'Tree').click();
    await expect(view(page)).toContainText('3 elements');
    await findInResults(page, view(page).getByText('outer').first(), 'deep value');
    await expect(view(page).getByTestId('results-find-status')).toContainText('1');
    await page.keyboard.press('Escape');

    await viewButton(page, 'Table').click();
    await findInResults(page, view(page).getByText('outer').first(), 'outer');
    await expect(view(page).getByTestId('results-find-status')).toContainText('1');
  });

  test('resizes a table column with the mouse and with the keyboard', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await viewButton(page, 'Table').click();
    const handle = view(page).getByRole('separator', { name: 'Resize name column' });
    await expect(handle).toBeVisible();

    const start = (await handle.boundingBox())!;
    await handle.focus();
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await handle.boundingBox())!.x).toBeGreaterThan(start.x);

    const after = (await handle.boundingBox())!;
    // Hovering first puts the press on the handle itself, not a neighbour under its edge.
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(after.x + 80, after.y + after.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await handle.boundingBox())!.x).toBeGreaterThan(after.x + 40);
  });

  test('labels the stages of a sorted collection scan', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'transactions');
    await view(page).getByTestId('explain-plan-tab').click();
    await expect(view(page).getByTestId('explain-panel')).toContainText('Sort');
  });

  test('copies a document, the query code and the plan', async ({ app, page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard permissions are granted in Chromium only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    const copy = view(page).getByTestId('copy-doc-btn').first();
    const label = await copy.getAttribute('aria-label');
    await copy.click();
    await expect(copy).not.toHaveAttribute('aria-label', label ?? '');
    await expect.poll(clipboard).toContain('Alice Smith');

    await jsonLine(page, 'Alice Smith').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Compare with/ }).click();
    await jsonLine(page, 'Alice Smith').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Cancel compare selection' }).click();

    await view(page).getByTestId('query-code-tab').click();
    await view(page).getByTestId('copy-query-code-btn').click();
    await expect(view(page).getByTestId('copy-query-code-btn')).toContainText('Copied');
    await expect.poll(clipboard).toContain('customers');

    await view(page).getByTestId('explain-plan-tab').click();
    await view(page).getByRole('button', { name: 'Copy Plan' }).click();
    await expect.poll(clipboard).toContain('queryPlanner');
  });
});

test('plain JSON converts BSON for display and copy and restores the shell view', async ({ app, page, context, browserName }) => {
  const doc = { _id: { $oid: '603d779f4f102e3a185c3220' }, createdAt: { $date: '2026-06-15T15:48:03.793Z' }, n: { $numberLong: '9007199254740993' } };
  await openThings(app, page, [doc]);
  await expect(jsonLine(page, '"_id"')).toContainText('ObjectId(');
  const toggle = view(page).getByRole('checkbox', { name: 'Plain JSON' });
  await toggle.check();
  await expect(jsonLine(page, '"_id"')).toContainText('"603d779f4f102e3a185c3220"');
  await expect(jsonLine(page, '"_id"')).not.toContainText('ObjectId(');
  await expect(jsonLine(page, '"createdAt"')).toContainText('"2026-06-15T15:48:03.793Z"');
  await expect(jsonLine(page, '"n"')).toContainText('"9007199254740993"');
  await expect(toggle.locator('..')).toHaveAttribute('title', /BSON type information may be lost/);
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await view(page).getByTestId('copy-doc-btn').click();
    await expect.poll(async () => JSON.parse(await page.evaluate(() => navigator.clipboard.readText())))
      .toEqual({ _id: '603d779f4f102e3a185c3220', createdAt: '2026-06-15T15:48:03.793Z', n: '9007199254740993' });
  }
  await toggle.uncheck();
  await expect(jsonLine(page, '"_id"')).toContainText('ObjectId(');
});

test('plain JSON exports the remaining BSON scalars as JSON-safe values', async ({ app, page, context, browserName }) => {
  const doc = {
    _id: 1, values: [
      { $numberInt: '42' }, { $numberDouble: '1.5' }, { $numberDouble: 'NaN' },
      { $numberDecimal: '123.450' }, { $timestamp: { t: 2, i: 3 } },
      { $binary: { base64: 'AQID', subType: '00' } },
      { $regularExpression: { pattern: 'a.*', options: 'im' } },
      { $code: 'return x', $scope: { x: 1 } }, { $symbol: 's' }, { $minKey: 1 }, { $maxKey: 1 },
      { $ref: 'users', $id: { $oid: '603d779f4f102e3a185c3220' }, $db: 'shop' },
      { $ref: 'users', $id: { $oid: '603d779f4f102e3a185c3220' } },
      {}, null, true,
    ],
  };
  await openThings(app, page, [doc]);
  await view(page).getByRole('checkbox', { name: 'Plain JSON' }).check();
  await expect(jsonLine(page, '123.450')).toBeVisible();
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await view(page).getByTestId('copy-doc-btn').click();
    await expect.poll(async () => JSON.parse(await page.evaluate(() => navigator.clipboard.readText())))
      .toEqual({ _id: 1, values: [42, 1.5, 'NaN', '123.450', '8589934595', 'AQID', '/a.*/im', 'return x', 's', 'MinKey', 'MaxKey',
        { $ref: 'users', $id: '603d779f4f102e3a185c3220', $db: 'shop' },
        { $ref: 'users', $id: '603d779f4f102e3a185c3220' }, {}, null, true] });
  }
});
