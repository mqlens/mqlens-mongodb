import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { connectStaging, getEditorText, openCollection, setEditorText, view } from '../helpers';

// The query bar's own controls (#396): the buttons that clear what is in it,
// the quick sort, and Enter in the paging boxes.

const button = (page: Page, name: string) => view(page).getByRole('button', { name, exact: true });

async function openCustomers(app: App, page: Page, seed: Seed = {}): Promise<void> {
  await connectStaging(app, page, seed);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
}

test.describe('The query bar', () => {
  test('Enter in skip or limit runs the query', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    const options = view(page).getByTestId('query-options-section');
    const before = (await app.calls('execute_mql_query')).length;

    await options.getByRole('spinbutton').first().fill('1');
    await options.getByRole('spinbutton').first().press('Enter');
    await expect.poll(async () => (await app.calls('execute_mql_query')).length).toBeGreaterThan(before);
    expect((await app.calls('execute_mql_query')).at(-1)!.args).toMatchObject({ skip: 1 });

    await options.getByRole('spinbutton').nth(1).fill('2');
    await options.getByRole('spinbutton').nth(1).press('Enter');
    await expect.poll(async () => (await app.calls('execute_mql_query')).at(-1)!.args).toMatchObject({ limit: 2 });
    await expect(view(page)).not.toContainText('Alice Smith');
  });

  test('puts skip and limit back where they started', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    const options = view(page).getByTestId('query-options-section');
    await options.getByRole('spinbutton').first().fill('2');
    await options.getByRole('spinbutton').nth(1).fill('1');

    await button(page, 'Reset Skip').click();
    await expect(options.getByRole('spinbutton').first()).toHaveValue('0');
    await button(page, 'Reset Limit').click();
    await expect(options.getByRole('spinbutton').nth(1)).toHaveValue('50');
    // Back at the defaults, neither button is on offer.
    await expect(button(page, 'Reset Skip')).toHaveCount(0);
    await expect(button(page, 'Reset Limit')).toHaveCount(0);
  });

  test('the quick sort goes down, then up, then away', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    const sort = view(page).getByTestId('sort-query-input');

    await button(page, 'Quick Sort Direction').click();
    await expect.poll(() => getEditorText(page, sort)).toContain('"_id": -1');
    await button(page, 'Quick Sort Direction').click();
    await expect.poll(() => getEditorText(page, sort)).toContain('"_id": 1');
    await button(page, 'Quick Sort Direction').click();
    await expect.poll(() => getEditorText(page, sort)).toBe('');
  });

  test('clears the filter, the projection and the sort', async ({ app, page }) => {
    await openCustomers(app, page);
    await view(page).getByTestId('query-options-toggle').click();
    const options = view(page).getByTestId('query-options-section');
    const filter = view(page).getByTestId('query-filter-input');
    const projection = options.getByTestId('projection-query-input');
    const sort = options.getByTestId('sort-query-input');

    await setEditorText(page, filter, '{ tier: "Premium" }');
    await setEditorText(page, projection, '{ name: 1 }');
    await setEditorText(page, sort, '{ name: -1 }');

    await button(page, 'Clear Filter').click();
    await expect.poll(() => getEditorText(page, filter)).toBe('');
    await button(page, 'Clear Projection').click();
    await expect.poll(() => getEditorText(page, projection)).toBe('');
    await button(page, 'Clear Sort').click();
    await expect.poll(() => getEditorText(page, sort)).toBe('');
  });

  test('clears what an export would carry over from the query', async ({ app, page }) => {
    await openCustomers(app, page, { dialog: { save: '/tmp/customers.json' } });
    await view(page).getByTestId('query-options-toggle').click();
    await setEditorText(page, view(page).getByTestId('query-filter-input'), '{ tier: "Premium" }');
    await setEditorText(page, view(page).getByTestId('query-options-section').getByTestId('sort-query-input'), '{ name: -1 }');
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(view(page)).not.toContainText('Bob Johnson');

    await view(page).getByTestId('export-btn').click();
    const exporter = page.getByTestId('export-view');
    const filter = exporter.getByTestId('export-filtered-card').getByTestId('query-filter-input');
    await expect.poll(() => getEditorText(page, filter)).toContain('Premium');

    // The export's own copy of the query is cleared here, not in the tab it came from.
    await exporter.getByRole('button', { name: 'Clear Filter', exact: true }).click();
    await expect.poll(() => getEditorText(page, filter)).toBe('');
    await exporter.getByRole('button', { name: 'Clear Sort', exact: true }).click();
    await exporter.getByTestId('export-filtered-btn').click();

    const args = (await app.calls('start_filtered_export'))[0].args as { filter: string; sort: string | null };
    expect(args.filter === '' || args.filter === '{}').toBe(true);
  });
});
