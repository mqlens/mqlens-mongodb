import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, openCollection, STAGING_URI, view } from '../helpers';

// What a chart makes of the values it is given (#396): a date to group by, a
// decimal to measure, a field some documents simply do not have, and more
// categories than it will draw.

/** 33 regions, two documents with no region at all, and one amount that is not a number. */
const READINGS = [
  ...Array.from({ length: 33 }, (_, i) => ({
    _id: i + 1,
    region: `region-${String(i + 1).padStart(2, '0')}`,
    amount: { $numberDecimal: `${(i + 1) * 1.5}` },
    when: { $date: `2026-0${(i % 9) + 1}-15T00:00:00Z` },
  })),
  { _id: 34, amount: { $numberDecimal: '12.25' }, when: { $date: '2026-03-15T00:00:00Z' } },
  { _id: 35, amount: 'not a number', when: { $date: '2026-04-15T00:00:00Z' } },
  { _id: 36, region: 'region-01', when: { $date: '2026-05-15T00:00:00Z' } },
];

async function openChart(app: App, page: Page): Promise<Locator> {
  await connectStaging(app, page, {
    servers: { [STAGING_URI]: { databases: { metrics: { readings: { docs: READINGS } } } } },
  });
  await openCollection(page, 'metrics', 'readings');
  await expect(view(page)).toContainText('region-01');
  await view(page).getByRole('button', { name: 'Chart' }).click();
  return view(page).getByTestId('chart-view');
}

/** Pick `option` from the combobox labelled `name`. */
async function pick(page: Page, chart: Locator, name: string, option: string | RegExp): Promise<void> {
  await chart.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
}

test.describe('The values a chart is given', () => {
  test('groups by a date, measures a decimal, and says what it left out', async ({ app, page }) => {
    const chart = await openChart(app, page);

    // 33 regions plus the documents with none: more than it draws, and it says so.
    await pick(page, chart, 'X axis', 'region');
    await pick(page, chart, 'Measure', /sum/i);
    await pick(page, chart, 'Measure field', 'amount');
    await expect(chart).toContainText('not shown');

    // A date groups by the day it falls on, and a document without the field
    // is a group of its own rather than being dropped.
    await pick(page, chart, 'X axis', 'when');
    await expect(chart.locator('.recharts-bar-rectangle').first()).toBeVisible();
    await expect(chart).not.toContainText('not shown');

    await pick(page, chart, 'X axis', 'region');
    await expect(chart).toContainText('not shown');
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('plots each document on its own, and waits for a field to plot', async ({ app, page }) => {
    const chart = await openChart(app, page);
    await chart.getByRole('tab', { name: /raw|each document/i }).click();

    // Nothing to plot until a field is chosen.
    await pick(page, chart, 'Y axis', '—');
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(0);

    // With one, every document that has a number of its own is a point; the
    // one whose amount is text, and the one with none, are not.
    await pick(page, chart, 'Y axis', 'amount');
    await pick(page, chart, 'X axis', 'when');
    await expect(chart.locator('.recharts-bar-rectangle').first()).toBeVisible();
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('draws the same points as any of the shapes on offer', async ({ app, page }) => {
    const chart = await openChart(app, page);
    await pick(page, chart, 'X axis', 'region');

    // Each shape is drawn by its own chart; a pie slices the same groups up.
    for (const [type, marker] of [
      ['line', '.recharts-line'],
      ['area', '.recharts-area'],
      ['scatter', '.recharts-scatter'],
      ['pie', '.recharts-pie'],
    ] as const) {
      await pick(page, chart, 'Chart type', type);
      await expect(chart.locator(marker).first()).toBeVisible();
    }

    // Scattering each document on its own puts numbers on both axes. A pie of
    // single documents means nothing, so raw mode does not offer one.
    await chart.getByRole('tab', { name: /raw|each document/i }).click();
    await pick(page, chart, 'Y axis', 'amount');
    await pick(page, chart, 'X axis', '_id');
    await pick(page, chart, 'Chart type', 'scatter');
    await expect(chart.locator('.recharts-scatter').first()).toBeVisible();
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
