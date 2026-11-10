import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { callFrom, loadSample, openCollection } from '../helpers';

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

  test('re-samples on demand, shows a field’s top values and exports the schema', async ({ app, page }) => {
    await app.open({ dialog: { save: '/exports/customers.schema' } });
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('analyze-schema-btn').click();
    const schema = view(page).getByTestId('schema-view');

    await schema.getByTestId('schema-sample-size').selectOption('100');
    await schema.getByTestId('schema-sample-mode').selectOption('first');
    await expect
      .poll(async () => (await app.calls('analyze_schema')).at(-1)?.args)
      .toMatchObject({ sampleSize: 100, first: true });

    await schema.getByTestId('schema-row-tier').click();
    const values = schema.getByTestId('schema-values-tier');
    await expect(values).toContainText('Premium');
    await expect(values).toContainText('2 · 67%');
    await expect(values).toContainText('Standard');
    await expect(values).toContainText('1 · 33%');
    await schema.getByTestId('schema-row-tier').click();
    await expect(values).toHaveCount(0);

    const jsonSave = await callFrom(app, 'plugin:dialog|save', () => schema.getByTestId('schema-export-json').click());
    expect(jsonSave).toMatchObject({ options: { defaultPath: 'sales_db.customers.schema.json' } });
    await expect.poll(async () => (await app.calls('plugin:fs|write_text_file')).length).toBe(1);
    const mdSave = await callFrom(app, 'plugin:dialog|save', () => schema.getByTestId('schema-export-md').click());
    expect(mdSave).toMatchObject({ options: { defaultPath: 'sales_db.customers.schema.md' } });
    await expect.poll(async () => (await app.calls('plugin:fs|write_text_file')).length).toBe(2);
  });

  test('says when the schema export fails', async ({ app, page }) => {
    await app.open({ dialog: { save: '/exports/customers.schema.json' } });
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
    await view(page).getByTestId('analyze-schema-btn').click();
    const schema = view(page).getByTestId('schema-view');

    await app.failNext('plugin:fs|write_text_file', 'disk full');
    await schema.getByTestId('schema-export-json').click();
    await expect(schema.getByTestId('schema-export-error')).toContainText('disk full');
  });
});
