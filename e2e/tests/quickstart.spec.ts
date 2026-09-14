import { test, expect } from '../fixtures';
import { SAMPLE_URI } from '../harness/seed';

test.describe('Quick Start', () => {
  test('Load sample data connects to the sample server and lists its databases', async ({ app, page }) => {
    await app.open();

    await page.getByTestId('qs-load-sample').click();

    await expect(page.getByRole('button', { name: 'Connection Sample (mqlens_demo)' })).toBeVisible();
    for (const db of ['admin', 'config', 'local', 'sales_db', 'user_analytics']) {
      await expect(page.getByRole('button', { name: `Database ${db}`, exact: true })).toBeVisible();
    }

    const connects = await app.calls('connect_db');
    expect(connects).toHaveLength(1);
    expect(connects[0].args).toMatchObject({ uri: SAMPLE_URI });
  });
});
