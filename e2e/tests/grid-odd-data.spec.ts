import { test, expect } from '../fixtures';
import { connectStaging, openCollection, view } from '../helpers';

// The results grid when what comes back is not what it expects (#396): an
// explain it cannot read, a document Extended JSON rejects, and a find over a
// chart, which has no text in it to find.

test.describe('When the backend sends something odd', () => {
  test('shows a plan it could not read as a single result stage', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');

    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({ explain_mql_query: () => 'not a plan at all' });
    });
    await view(page).getByTestId('explain-plan-tab').click();

    // Rather than an empty panel or a crash.
    await expect(view(page).getByTestId('explain-panel')).toBeVisible();
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('shows a document Extended JSON refuses as it came', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page)).toContainText('Alice Smith');

    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        // A $oid that is not one: EJSON refuses it, and the row still has to render.
        execute_mql_query: () => [JSON.stringify({ _id: { $oid: 12 }, name: 'Odd One' })],
      });
    });
    await view(page).getByRole('button', { name: 'Run', exact: true }).click();

    await expect(view(page)).toContainText('Odd One');
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('a find over the chart has nothing to look through', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'products');
    await expect(view(page)).toContainText('SuperBook Pro');

    await view(page).getByRole('button', { name: 'Chart' }).click();
    await expect(view(page).getByTestId('chart-view')).toBeVisible();

    await view(page).getByTestId('chart-view').click();
    await page.keyboard.press('Control+f');
    await view(page).getByTestId('results-find-input').fill('SuperBook');
    await expect(view(page).getByTestId('results-find-status')).toContainText('No matches');
  });
});
