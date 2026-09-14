import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadSample, openCollection } from '../helpers';

const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');

test.describe('Schema analysis', () => {
  test('lists every field path with its type and coverage', async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');

    await view(page).getByTestId('analyze-schema-btn').click();

    const schema = view(page).getByTestId('schema-view');
    await expect(schema).toBeVisible();
    for (const path of ['_id', 'name', 'email', 'tier', 'joined', 'address', 'address.city', 'address.state']) {
      await expect(schema.getByTestId(`schema-row-${path}`)).toBeVisible();
    }
    await expect(schema.getByTestId('schema-types-_id')).toHaveText('objectId');
    await expect(schema.getByTestId('schema-types-address')).toHaveText('object');
    // Every sampled customer has a name.
    await expect(schema.getByTestId('schema-row-name')).toContainText('100%');
    expect(await app.calls('analyze_schema')).not.toHaveLength(0);
  });

  test('shows partial coverage for a field only some documents have', async ({ app, page }) => {
    await app.open({
      servers: {
        'mongodb://mock': {
          databases: {
            shop: {
              items: {
                docs: [
                  { _id: { $oid: '65a000000000000000000001' }, name: 'Lamp', price: 30 },
                  { _id: { $oid: '65a000000000000000000002' }, name: 'Rug' },
                ],
              },
            },
          },
        },
      },
    });
    await loadSample(page);
    await openCollection(page, 'shop', 'items');

    await view(page).getByTestId('analyze-schema-btn').click();

    const schema = view(page).getByTestId('schema-view');
    await expect(schema.getByTestId('schema-row-price')).toContainText('50%');
    await expect(schema.getByTestId('schema-row-name')).toContainText('100%');
  });
});
