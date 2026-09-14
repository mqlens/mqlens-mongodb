import { test, expect } from '../fixtures';
import { loadSample, openCollection } from '../helpers';

test.describe('Browsing a collection', () => {
  test('opens a collection from the sidebar and shows its documents', async ({ app, page }) => {
    await app.open();
    await loadSample(page);

    await openCollection(page, 'sales_db', 'customers');

    for (const name of ['Alice Smith', 'Bob Johnson', 'Charlie Brown']) {
      await expect(page.getByText(name).first()).toBeVisible();
    }
    const queries = await app.calls('execute_mql_query');
    expect(queries.at(-1)?.args).toMatchObject({ database: 'sales_db', collection: 'customers' });
  });
});
