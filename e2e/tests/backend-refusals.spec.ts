import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { connectStaging, dismissHoverCards, openCollection, STAGING_URI, view } from '../helpers';

// Small things the backend can refuse without the app losing its footing
// (#396): the server version it puts in the status bar, a collection's saved
// default query, and the tree the Dump view offers as its scope.

test.describe('When a lesser call is refused', () => {
  test('the server version is simply left out', async ({ app, page }) => {
    // Opened by hand rather than through `connectStaging`, so the refusal is
    // in place before the connection that asks for the version.
    await app.open({
      profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI }],
      servers: { [STAGING_URI]: SAMPLE_SERVER },
    });
    await app.failNext('get_mongodb_version', 'no such command');
    await page.getByTestId('conn-card-p-staging').click();
    await page.getByRole('button', { name: 'Connection Staging' }).waitFor();
    await openCollection(page, 'sales_db', 'customers');

    // The app is whole; only the version is missing from the status bar.
    await expect(view(page)).toContainText('Alice Smith');
    await expect(page.getByText(/^MongoDB 7/)).toHaveCount(0);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('a collection whose saved queries cannot be read opens on a plain find', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');

    // The pinned default is unreadable, so there is nothing to apply.
    await app.failNext('load_collection_queries', 'saved queries are unreadable');
    await page.getByRole('complementary').getByText('products', { exact: true }).click();
    await dismissHoverCards(page);

    await expect(view(page)).toContainText('SuperBook Pro');
    const ran = (await app.calls('execute_mql_query')).at(-1)!.args as Record<string, unknown>;
    expect(ran).toMatchObject({ collection: 'products' });
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('a dump offers what of the tree it could read', async ({ app, page }) => {
    await connectStaging(app, page);
    await expect(page.getByRole('button', { name: 'Database sales_db' })).toBeVisible();

    // The first database the dump asks about gives up its collections; the
    // scope picker still lists the database itself.
    await app.failNext('list_collections', 'collections are unreadable');
    await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
    await page.getByTestId('ctx-dump-conn-1').click();
    await dismissHoverCards(page);
    await expect(page.getByTestId('dump-view')).toBeVisible();

    await page.getByTestId('dump-scope-db').click();
    await expect(page.getByTestId('dump-db-select')).toBeVisible();
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('a dump with no tree at all still opens', async ({ app, page }) => {
    await connectStaging(app, page);
    await expect(page.getByRole('button', { name: 'Database sales_db' })).toBeVisible();

    await app.failNext('list_databases', 'databases are unreadable');
    await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
    await page.getByTestId('ctx-dump-conn-1').click();
    await dismissHoverCards(page);

    await expect(page.getByTestId('dump-view')).toBeVisible();
    await page.getByTestId('dump-scope-db').click();
    await expect(page.getByTestId('dump-db-select')).toBeVisible();
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
