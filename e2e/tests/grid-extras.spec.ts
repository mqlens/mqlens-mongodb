import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Doc } from '../harness/seed';
import { callFrom, connectStaging, openCollection, setEditorText, STAGING_URI, view } from '../helpers';

// The results grid past its everyday use (#396): plans of every shape, copying
// values and long results, typed values in each view, and where Ctrl+F goes.

const viewButton = (page: Page, name: 'JSON' | 'Tree' | 'Table') => view(page).getByRole('button', { name, exact: true });
const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const findInput = (page: Page) => view(page).getByTestId('results-find-input');

/** Open shop.things on a saved connection whose server holds only `docs`. */
async function openThings(app: App, page: Page, docs: Doc[]): Promise<void> {
  await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs } } } } } });
  await openCollection(page, 'shop', 'things');
  await expect(view(page).locator('[data-json-line]').first()).toBeVisible();
}

/** Open find over the results with Ctrl+F from inside `target`, and search for `text`. */
async function findInResults(page: Page, target: Locator, text: string): Promise<void> {
  await target.click();
  await page.keyboard.press('ControlOrMeta+f');
  await findInput(page).fill(text);
}

/** Right-click `target` in the results and copy its value; returns what the clipboard then holds. */
async function copyValueOf(page: Page, target: Locator, expected: string): Promise<void> {
  await target.dispatchEvent('contextmenu');
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  // The menu opens at the pointer, which a dispatched event puts at (0, 0); click it as the user's click does.
  await menu.getByRole('menuitem', { name: 'Copy value' }).dispatchEvent('click');
  await expect.poll(() => clipboard(page)).toBe(expected);
}

test.describe('Explain plans', () => {
  test('names each stage of a plan, and shows a collection scan when the plan has none', async ({ app, page }) => {
    await openThings(app, page, [{ _id: 1, name: 'one' }]);
    const plans = [
      {
        queryPlanner: {
          namespace: 'shop.things',
          winningPlan: {
            stage: 'LIMIT',
            inputStage: {
              stage: 'SKIP',
              inputStage: {
                stage: 'PROJECTION_SIMPLE',
                inputStage: {
                  stage: 'FETCH',
                  inputStage: {
                    stage: 'OR',
                    inputStages: [
                      { stage: 'IXSCAN', indexName: 'name_1', keyPattern: { name: 1 } },
                      { stage: 'AND_HASH', inputStages: [{ stage: 'IXSCAN', indexName: 'tag_1' }] },
                      { stage: 'SHARDING_FILTER' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      { queryPlanner: { namespace: 'shop.things' } },
    ].map((plan) => JSON.stringify(plan));
    await page.evaluate((replies) => {
      const queue = [...replies];
      window.__MQLENS_E2E__!.register({ explain_mql_query: () => (queue.length > 1 ? queue.shift() : queue[0]) });
    }, plans);

    const panel = view(page).getByTestId('explain-panel');
    await callFrom(app, 'explain_mql_query', () => view(page).getByTestId('explain-plan-tab').click());
    for (const label of ['Limit', 'Skip', 'Projection', 'Fetch documents', 'OR Merge', 'Index Intersection', 'Sharding_filter']) {
      await expect(panel).toContainText(label);
    }

    // Asked again, the plan has no winning plan at all.
    await callFrom(app, 'explain_mql_query', () => view(page).getByTestId('explain-plan-tab').click());
    await expect(panel).not.toContainText('OR Merge');
    await expect(panel).toContainText('Collection scan');
  });

  test('shows a pipeline plan from its cursor stage up', async ({ app, page }) => {
    await openThings(app, page, [{ _id: 1, name: 'one' }]);
    const plan = JSON.stringify({
      stages: [
        { $cursor: { queryPlanner: { namespace: 'shop.things', winningPlan: { stage: 'COLLSCAN' } } } },
        {},
        { $group: { _id: '$name' } },
      ],
    });
    await page.evaluate((reply) => window.__MQLENS_E2E__!.register({ explain_aggregate_query: () => reply }), plan);

    await view(page).getByTestId('mode-aggregate-tab').click();
    await callFrom(app, 'explain_aggregate_query', () => view(page).getByTestId('explain-plan-tab').click());
    const panel = view(page).getByTestId('explain-panel');
    await expect(panel).toContainText('$group');
    await expect(panel).toContainText('$cursor');
    await expect(panel).toContainText('Collection scan');
  });
});

test.describe('Copying', () => {
  test.beforeEach(async ({ context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard permissions are granted in Chromium only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Copy value takes each BSON type as its bare value, in the table and in JSON', async ({ app, page }) => {
    await openThings(app, page, [
      {
        _id: { $oid: '64b0000000000000000000a1' },
        name: 'widget',
        when: { $date: '2025-05-01T12:00:00Z' },
        since: { $date: { $numberLong: '1714564800000' } },
        big: { $numberLong: '9007199254740993' },
        price: { $numberDecimal: '19.99' },
        ratio: { $numberDouble: 'NaN' },
        gone: null,
      },
    ]);

    await viewButton(page, 'Table').click();
    await expect(view(page).getByTestId('table-header')).toContainText(/ratio/i);
    const cell = (text: string) => view(page).getByText(text).first();
    await copyValueOf(page, cell('widget'), 'widget');
    await copyValueOf(page, cell('64b0000000000000000000a1'), '64b0000000000000000000a1');
    await copyValueOf(page, cell('2025-05-01'), '2025-05-01T12:00:00Z');
    await copyValueOf(page, cell('2024-05-01'), '2024-05-01T12:00:00.000Z');
    await copyValueOf(page, cell('9007199254740993'), '9007199254740993');
    await copyValueOf(page, cell('19.99'), '19.99');
    await copyValueOf(page, cell('NaN'), 'NaN');

    // The JSON view parses documents into BSON values, which copy the same way.
    await viewButton(page, 'JSON').click();
    await copyValueOf(page, jsonLine(page, '"price"'), '19.99');
    await copyValueOf(page, jsonLine(page, '"when"'), '2025-05-01T12:00:00.000Z');
    await copyValueOf(page, jsonLine(page, '"_id"'), '64b0000000000000000000a1');
  });

  test('copying everything in JSON takes every loaded document, folded parts as shown', async ({ app, page }) => {
    const docs = Array.from({ length: 80 }, (_, i) => ({ _id: i, name: `doc-${i}`, nested: { n: i } }));
    await openThings(app, page, docs);

    // Far more lines than are on screen; fold the first document's nested object.
    await jsonLine(page, '"nested"').getByTestId('json-fold-btn').click();
    await expect(jsonLine(page, '"nested"')).toContainText('…');

    await jsonLine(page, '"doc-0"').click();
    await page.keyboard.press('ControlOrMeta+a');
    // The view learns of the select-all from `selectionchange`, which the browser
    // fires a task later. A copy pressed before that is the browser's own, of the
    // rows on screen, so copy again until the view's rebuilt copy lands.
    await expect(async () => {
      await page.keyboard.press('ControlOrMeta+c');
      expect(await clipboard(page)).toContain('"doc-49"');
    }).toPass({ timeout: 15_000 });
    const copied = await clipboard(page);
    expect(copied).toContain('"doc-0"');
    expect(copied).toContain('… }');

    // A copy from the query editor is the editor's, not the results'.
    const filter = view(page).getByTestId('query-filter-input');
    await setEditorText(page, filter, '{ name: "doc-1" }');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => clipboard(page)).toBe('{ name: "doc-1" }');
  });
});

test.describe('Typed values and find', () => {
  test('shows null, booleans and dates in each view, and finds them', async ({ app, page }) => {
    await openThings(app, page, [
      { _id: 1, flag: true, none: null, empty: {}, deep: { inner: { leaf: 'x' } } },
      { _id: 2, when: { $date: '2025-05-01T12:00:00Z' }, big: { $numberLong: '9007199254740993' }, ratio: { $numberDouble: 'NaN' }, ok: false, ref: { $oid: '64b0000000000000000000a1' } },
    ]);

    await findInResults(page, jsonLine(page, '"flag"'), 'null');
    await expect(view(page).getByTestId('results-find-status')).toContainText('1');
    await page.keyboard.press('Escape');

    await viewButton(page, 'Tree').click();
    await expect(view(page).getByTestId('tree-view')).toContainText('null');
    await expect(view(page).getByTestId('tree-view')).toContainText('true');

    await viewButton(page, 'Table').click();
    await expect(view(page).getByTestId('table-header')).toContainText(/ref/i);
    for (const text of ['9007199254740993', 'NaN', '2025-05-01', '64b0000000000000000000a1', 'false']) {
      await findInResults(page, view(page).getByTestId('table-header'), text);
      await expect(view(page).getByTestId('results-find-status'), `a match for ${text}`).toContainText('1');
      await page.keyboard.press('Escape');
    }
  });

  test('find brings a match in an off-screen column into view, and back', async ({ app, page }) => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${String(i).padStart(2, '0')}`, `value-${i}-${'x'.repeat(40)}`]));
    await openThings(app, page, [{ _id: 1, ...wide }]);
    await viewButton(page, 'Table').click();
    const header = view(page).getByTestId('table-header');
    await expect(header).toContainText(/field_00/i);

    await findInResults(page, header, 'value-19-');
    await expect.poll(() => header.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    const far = await header.evaluate((el) => el.scrollLeft);
    await findInput(page).fill('value-0-');
    await expect.poll(() => header.evaluate((el) => el.scrollLeft)).toBeLessThan(far);
  });

  test('Ctrl+F opens results find from the results only', async ({ app, page }) => {
    await openThings(app, page, [
      { _id: 1, name: 'alpha' },
      { _id: 2, name: 'beta' },
    ]);
    const sidebarSearch = page.getByTestId('sidebar-search');

    // In the query editor, the key belongs to the editor.
    await view(page).getByTestId('query-filter-input').locator('.monaco-editor').first().click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).not.toBeVisible();
    await page.keyboard.press('Escape');

    // In the sidebar's filter, it stays with the sidebar.
    await sidebarSearch.click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).not.toBeVisible();
    await expect(sidebarSearch).toBeFocused();

    // After pointing at the results, it opens their find bar, and pressing it
    // again with the caret already there keeps the bar.
    await viewButton(page, 'JSON').click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).toBeVisible();
    await findInput(page).fill('alpha');
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(findInput(page)).not.toBeVisible();

    // Pointing at the sidebar forgets the pane, but a lone results pane is still
    // the only thing the key could mean, so it opens.
    await page.getByRole('button', { name: 'Connection Staging' }).click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).toBeVisible();
    await page.keyboard.press('Escape');

    // The plan has no find bar.
    await view(page).getByTestId('explain-plan-tab').click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findInput(page)).not.toBeVisible();
  });
});
