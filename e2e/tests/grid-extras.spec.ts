import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Doc } from '../harness/seed';
import { callFrom, connectStaging, openCollection, openInNewTab, setEditorText, STAGING_URI, switchTab, view } from '../helpers';

// The results grid past its everyday use (#396): plans of every shape, copying
// values and long results, typed values in each view, and where Ctrl+F goes.

const viewButton = (page: Page, name: 'JSON' | 'Tree' | 'Table') => view(page).getByRole('button', { name, exact: true });
const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const findInput = (page: Page) => view(page).getByTestId('results-find-input');

/** The text of one table cell, by its row number (1-based, as shown) and column name. */
async function tableCellText(page: Page, row: number, column: string): Promise<string> {
  return view(page).getByTestId('table-header').evaluate((header, [row, column]) => {
    const headings = Array.from(header.children);
    const index = headings.findIndex((h) => h.textContent === column);
    if (index < 0) throw new Error(`No column ${column}`);
    const body = header.parentElement!.querySelector('[data-testid="table-body-scroll"]')!;
    // A row lines up with the header: the row number, then a cell per column.
    const line = Array.from(body.querySelectorAll('div')).find(
      (d) => d.children.length === headings.length && d.firstElementChild?.textContent === String(row),
    );
    if (!line) throw new Error(`No row ${row}`);
    return line.children[index].textContent ?? '';
  }, [row, column] as const);
}

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
  test('names each stage of a plan, and says so when the plan has none', async ({ app, page }) => {
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

    // Asked again, the plan has no winning plan at all: say so rather than
    // draw a collection scan the server never reported.
    await callFrom(app, 'explain_mql_query', () => view(page).getByTestId('explain-plan-tab').click());
    await expect(panel).not.toContainText('OR Merge');
    await expect(panel).toContainText('Plan unavailable');
    await expect(panel).not.toContainText('Collection scan');
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

  test('the table tells null from missing, and opens embedded fields into columns', async ({ app, page }) => {
    await openThings(app, page, [
      {
        _id: 1,
        email: null,
        address: { city: 'Berlin', geo: { lat: 52.5 } },
        since: { $date: '2025-05-01T12:00:00Z' },
        meta: { $schema: 'v1' },
      },
      { _id: 2, address: { city: 'Lima' }, meta: ['x', 'y', 'z'] },
    ]);
    await viewButton(page, 'Table').click();
    const header = view(page).getByTestId('table-header');
    await expect(header).toContainText(/email/i);

    // The first has a null email, the second none at all: one marker, which find matches.
    await expect(view(page).getByTestId('table-null')).toHaveCount(1);
    await findInResults(page, header, 'null');
    await expect(view(page).getByTestId('results-find-status')).toContainText('1');
    await page.keyboard.press('Escape');

    await view(page).getByRole('checkbox', { name: 'Embedded fields' }).check();
    for (const col of [/address\.city/i, /address\.geo\.lat/i, /meta\.\$schema/i]) await expect(header).toContainText(col);
    // A date is one value, not a document to open.
    await expect(header).not.toContainText('$date');
    await expect(view(page).getByText('Lima')).toBeVisible();
    await expect(view(page).getByText('52.5')).toBeVisible();
    // Lima has no geo, and its `meta` is an array: blank, not null or anything else.
    await expect(view(page).getByTestId('table-null')).toHaveCount(1);
    expect(await tableCellText(page, 2, 'address.geo.lat')).toBe('');
    expect(await tableCellText(page, 2, 'meta.$schema')).toBe('');
    expect(await tableCellText(page, 2, 'address.city')).toBe('Lima');
    await findInResults(page, header, 'Berlin');
    await expect(view(page).getByTestId('results-find-status')).toContainText('1');
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

  test('the table body scrolls both ways in one box, its vertical bar on screen', async ({ app, page }) => {
    // Wider and taller than the viewport, so both axes overflow.
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${String(i).padStart(2, '0')}`, `v${i}`]));
    await openThings(app, page, Array.from({ length: 200 }, (_, n) => ({ _id: n, ...wide })));
    await viewButton(page, 'Table').click();
    const header = view(page).getByTestId('table-header');
    await expect(header).toContainText(/field_00/i);

    const body = view(page).getByTestId('table-body-scroll');
    const scrollers = () =>
      body.evaluate((wrapper) =>
        [wrapper, ...Array.from(wrapper.querySelectorAll<HTMLElement>('*'))]
          .filter((el) => {
            const cs = getComputedStyle(el);
            const scrolls = (o: string) => o === 'auto' || o === 'scroll';
            return (
              (scrolls(cs.overflowX) && el.scrollWidth > el.clientWidth) ||
              (scrolls(cs.overflowY) && el.scrollHeight > el.clientHeight)
            );
          })
          .map((el) => {
            const box = el.getBoundingClientRect();
            return {
              x: el.scrollWidth > el.clientWidth,
              y: el.scrollHeight > el.clientHeight,
              rightOverflow: box.right - wrapper.getBoundingClientRect().right,
            };
          }),
      );
    // One box scrolls both ways, and it is no wider than what is on screen, so
    // its vertical scroll bar is at the visible right edge, not off past the columns.
    const found = await scrollers();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ x: true, y: true });
    expect(found[0].rightOverflow).toBeLessThanOrEqual(1);

    // Scrolling it sideways carries the header along.
    await body.evaluate((wrapper) => {
      const scroller = [wrapper, ...Array.from(wrapper.querySelectorAll<HTMLElement>('*'))].find(
        (el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX !== 'hidden',
      )!;
      scroller.scrollLeft = 300;
    });
    await expect.poll(() => header.evaluate((el) => el.scrollLeft)).toBe(300);
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

test.describe('Table columns', () => {
  const columnOrder = (page: Page) =>
    view(page).getByTestId('table-header').locator('[data-column]').evaluateAll((els) => els.map((e) => e.getAttribute('data-column')));
  async function headerMenu(page: Page, column: string, item: string): Promise<void> {
    await view(page).locator(`[data-testid="table-header"] [data-column="${column}"]`).dispatchEvent('contextmenu');
    await page.getByTestId('context-menu').getByRole('menuitem', { name: item }).dispatchEvent('click');
  }

  test('sorts the page by a header, hides and moves columns, and keeps that when the tab is unmounted', async ({ app, page }) => {
    const others = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    await connectStaging(app, page, {
      servers: {
        [STAGING_URI]: {
          databases: {
            shop: {
              things: { docs: [{ _id: 1, name: 'b', price: 30 }, { _id: 2, name: 'a', price: 10 }, { _id: 3, name: 'c', price: 20 }] },
              ...Object.fromEntries(others.map((c) => [c, { docs: [{ _id: 1 }] }])),
            },
          },
        },
      },
    });
    await openCollection(page, 'shop', 'things');
    await viewButton(page, 'Table').click();
    await expect.poll(() => columnOrder(page)).toEqual(['_id', 'name', 'price']);

    await view(page).getByTestId('table-header').getByRole('button', { name: 'price' }).click();
    expect(await tableCellText(page, 1, 'name')).toBe('a');
    await view(page).getByTestId('table-header').getByRole('button', { name: 'price' }).click();
    expect(await tableCellText(page, 1, 'name')).toBe('b');

    await headerMenu(page, 'price', 'Move left');
    await expect.poll(() => columnOrder(page)).toEqual(['_id', 'price', 'name']);
    await headerMenu(page, '_id', 'Hide column');
    await expect.poll(() => columnOrder(page)).toEqual(['price', 'name']);

    // Six more tabs push this one out of the pane's keep-alive budget (#345),
    // which unmounts its grid; the layout has to come back from the tab.
    for (const c of others) await openInNewTab(page, c);
    await switchTab(page, 'things');
    await expect.poll(() => columnOrder(page)).toEqual(['price', 'name']);
    expect(await tableCellText(page, 1, 'name')).toBe('b');

    await headerMenu(page, 'name', 'Show all columns (1 hidden)');
    await expect.poll(() => columnOrder(page)).toEqual(['_id', 'price', 'name']);
  });

  test('sorts the edges of the BSON order: MinKey and MaxKey, exact decimals, code points, field types, binary, regexes', async ({ app, page }) => {
    // In ascending order; seeded backwards so the sort has work to do.
    const values: unknown[] = [
      { $minKey: 1 }, null,
      // Equal as doubles: ordered exactly, the double 0.1 by its binary value.
      { $numberDecimal: '0.100000000000000001' }, 0.1,
      { $numberDecimal: '1.0000000000000000' }, { $numberDecimal: '1.0000000000000001' },
      // By code point, not by locale: capitals first, U+1F600 after U+FF5E.
      'B', 'a', '～', '😀',
      // A field's value type before its name.
      { z: 1 }, { a: 'x' },
      // Binary by length, then subtype.
      { $binary: { base64: 'AQ==', subType: '00' } }, { $binary: { base64: 'AQ==', subType: '80' } },
      { $binary: { base64: 'AQI=', subType: '00' } },
      // Regexes by pattern, then options.
      { $regularExpression: { pattern: 'a', options: '' } }, { $regularExpression: { pattern: 'a', options: 'i' } },
      { $regularExpression: { pattern: 'z', options: '' } }, { $maxKey: 1 },
    ];
    const docs = values.map((v, i) => ({ _id: i + 1, v })).reverse();
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs: docs as Doc[] } } } } } });
    await openCollection(page, 'shop', 'things');
    await viewButton(page, 'Table').click();
    await expect.poll(() => columnOrder(page)).toEqual(['_id', 'v']);

    await headerMenu(page, 'v', 'Sort ascending');
    await expect(view(page).locator('[data-column="v"]')).toHaveAttribute('aria-sort', 'ascending');
    const out: string[] = [];
    for (let row = 1; row <= values.length; row++) out.push(await tableCellText(page, row, '_id'));
    expect(out).toEqual(values.map((_, i) => String(i + 1)));
  });

  test('sorts a column of mixed BSON types in MongoDB order, by value within each type', async ({ app, page }) => {
    // In ascending order; seeded backwards so the sort has work to do.
    const values: unknown[] = [
      undefined, null, { $numberDouble: 'NaN' }, { $numberDecimal: '1.5' }, { $numberLong: '3' }, 10,
      'a', 'b', { n: 2 }, { n: 10 }, [2], [10], { $binary: { base64: 'AQ==', subType: '00' } },
      { $oid: '64b000000000000000000001' }, { $oid: '64b000000000000000000002' }, false, true,
      { $date: '2020-01-01T00:00:00Z' }, { $date: '2024-01-01T00:00:00Z' },
      { $timestamp: { t: 1, i: 1 } }, { $timestamp: { t: 2, i: 1 } },
    ];
    const docs = values.map((v, i) => (v === undefined ? { _id: i + 1 } : { _id: i + 1, v })).reverse();
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs: docs as Doc[] } } } } } });
    await openCollection(page, 'shop', 'things');
    await viewButton(page, 'Table').click();
    await expect.poll(() => columnOrder(page)).toEqual(['_id', 'v']);
    const ids = async () => {
      const out: string[] = [];
      for (let row = 1; row <= values.length; row++) out.push(await tableCellText(page, row, '_id'));
      return out;
    };

    await headerMenu(page, 'v', 'Sort ascending');
    await expect(view(page).locator('[data-column="v"]')).toHaveAttribute('aria-sort', 'ascending');
    // Missing and null tie, so they keep their loaded order.
    expect(await ids()).toEqual(['2', '1', ...values.slice(2).map((_, i) => String(i + 3))]);

    await headerMenu(page, 'v', 'Clear sort');
    await expect(view(page).locator('[data-column="v"]')).toHaveAttribute('aria-sort', 'none');
    expect(await tableCellText(page, 1, '_id')).toBe(String(values.length));
  });
});

test.describe('Date display', () => {
  test('switching dates to local time carries to every open result, and back', async ({ app, page }) => {
    const docs = [{ _id: 1, when: { $date: '2025-05-01T12:00:00Z' } }];
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs }, other: { docs } } } } } });
    await openCollection(page, 'shop', 'things');
    await openInNewTab(page, 'other');
    const toggle = () => view(page).getByTestId('date-timezone-toggle');
    await expect(toggle()).toHaveText('UTC');

    await toggle().click();
    await expect(toggle()).toHaveText('Local');
    // The other tab's grid stays mounted, and hears of the change.
    await switchTab(page, 'things');
    await expect(toggle()).toHaveText('Local');

    await toggle().click();
    await switchTab(page, 'other');
    await expect(toggle()).toHaveText('UTC');
  });
});
