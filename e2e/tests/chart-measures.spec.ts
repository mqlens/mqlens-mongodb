import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, openCollection, STAGING_URI, view } from '../helpers';

// The number a chart puts on each bar (#396): the same documents summed,
// averaged, and reduced to their smallest and largest.

const PRICES = [
  { _id: 1, category: 'Electronics', price: 100 },
  { _id: 2, category: 'Electronics', price: 300 },
  { _id: 3, category: 'Office', price: 50 },
];

async function openChart(app: App, page: Page): Promise<Locator> {
  await connectStaging(app, page, {
    servers: { [STAGING_URI]: { databases: { shop: { items: { docs: PRICES } } } } },
  });
  await openCollection(page, 'shop', 'items');
  await expect(view(page)).toContainText('Electronics');
  await view(page).getByRole('button', { name: 'Chart' }).click();
  const chart = view(page).getByTestId('chart-view');

  await chart.getByRole('combobox', { name: 'X axis' }).click();
  await page.getByRole('option', { name: 'category' }).click();
  return chart;
}

/** Pick a measure, and the field it is measured over. */
async function measure(page: Page, chart: Locator, name: RegExp): Promise<void> {
  await chart.getByRole('combobox', { name: 'Measure', exact: true }).click();
  await page.getByRole('option', { name }).click();
  if ((await chart.getByRole('combobox', { name: 'Measure field' }).count()) > 0) {
    await chart.getByRole('combobox', { name: 'Measure field' }).click();
    await page.getByRole('option', { name: 'price' }).click();
  }
}

/** The heights of the bars, tallest first — one bar per group. */
const barHeights = (chart: Locator) =>
  chart.locator('.recharts-bar-rectangle path').evaluateAll((paths) =>
    paths.map((p) => Math.round((p as SVGGraphicsElement).getBBox().height)),
  );

test.describe('What a chart measures', () => {
  test('sums, averages and takes the smallest and largest of a field', async ({ app, page }) => {
    const chart = await openChart(app, page);

    // Summed: 400 against 50, so the first bar is much the taller.
    await measure(page, chart, /sum/i);
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(2);
    const summed = await barHeights(chart);
    expect(summed[0]).toBeGreaterThan(summed[1] * 4);

    // Averaged: 200 against 50.
    await measure(page, chart, /average|avg/i);
    await expect.poll(async () => (await barHeights(chart))[0] / (await barHeights(chart))[1]).toBeLessThan(4.5);

    // The smallest of each group: 100 against 50.
    await measure(page, chart, /min/i);
    await expect.poll(async () => (await barHeights(chart))[0] / (await barHeights(chart))[1]).toBeLessThan(2.5);

    // The largest: 300 against 50.
    await measure(page, chart, /max/i);
    await expect.poll(async () => (await barHeights(chart))[0] / (await barHeights(chart))[1]).toBeGreaterThan(4.5);
  });

  test('counts the documents in each group when no field is measured', async ({ app, page }) => {
    const chart = await openChart(app, page);

    await measure(page, chart, /count/i);
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(2);
    // Two documents against one.
    const counted = await barHeights(chart);
    expect(counted[0]).toBeGreaterThan(counted[1]);
    expect(counted[0]).toBeLessThan(counted[1] * 3);
  });

});
