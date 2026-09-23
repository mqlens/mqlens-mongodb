import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Doc } from '../harness/seed';
import { connectStaging, openCollection, STAGING_URI, view } from '../helpers';

// Comparing two documents (#396): how each BSON type is shown, and which
// fields count as changed.

const jsonLine = (page: Page, text: string) => view(page).locator('[data-json-line]').filter({ hasText: text }).first();

/** Open shop.things holding `docs`, and compare the first two. */
async function compareThings(app: App, page: Page, docs: Doc[]): Promise<void> {
  await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs } } } } } });
  await openCollection(page, 'shop', 'things');
  await expect(view(page).locator('[data-json-line]').first()).toBeVisible();

  await jsonLine(page, '"left"').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Compare with…', exact: true }).click();
  await jsonLine(page, '"right"').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Compare with selected' }).click();
}

test.describe('Comparing documents', () => {
  test('shows each BSON type, and which fields changed', async ({ app, page }) => {
    const long = 'x'.repeat(200);
    await compareThings(app, page, [
      {
        _id: 1,
        side: 'left',
        note: null,
        ok: true,
        when: { $timestamp: { t: 1, i: 2 } },
        blob: { $binary: { base64: 'aGk=', subType: '00' } },
        qty: 1,
        price: { $numberDecimal: '19.99' },
        same: 'unchanged',
        tags: ['a', 'b'],
        onlyLeft: 'gone',
        shape: 'flat',
      },
      {
        _id: 2,
        side: 'right',
        note: null,
        ok: false,
        when: { $timestamp: { t: 3, i: 4 } },
        blob: { $binary: { base64: 'eWE=', subType: '00' } },
        qty: 2,
        price: 19.99,
        same: 'unchanged',
        tags: ['a'],
        onlyRight: 'new',
        shape: { nested: long },
      },
    ]);

    const modal = page.getByTestId('document-diff-modal');
    const left = modal.getByTestId('diff-left');
    const right = modal.getByTestId('diff-right');
    await expect(modal.getByTestId('diff-summary')).toContainText('changed');

    // Each wrapper reads as the shell spells it.
    await expect(left).toContainText('Timestamp(1, 2)');
    await expect(right).toContainText('Timestamp(3, 4)');
    await expect(left).toContainText('BinData(0, "aGk=")');
    await expect(right).toContainText('BinData(0, "eWE=")');
    await expect(left).toContainText('NumberDecimal("19.99")');
    await expect(left).toContainText('true');
    await expect(right).toContainText('false');
    await expect(left).toContainText('null');

    // A field on one side only shows on that side.
    await expect(left).toContainText('onlyLeft');
    await expect(right).not.toContainText('onlyLeft');
    await expect(right).toContainText('onlyRight');
    await expect(left).not.toContainText('onlyRight');

    // An object too long to show is cut short.
    await expect(right).toContainText('…');
    await expect(right).not.toContainText(long);
  });

  test('a decimal and the same number are not a change', async ({ app, page }) => {
    await compareThings(app, page, [
      { _id: 1, side: 'left', price: { $numberDecimal: '19.99' }, qty: 1 },
      { _id: 2, side: 'right', price: 19.99, qty: 1 },
    ]);

    const modal = page.getByTestId('document-diff-modal');
    // _id and side differ; price and qty read the same on both sides.
    await expect(modal.getByTestId('diff-summary')).toContainText('changed');
    await expect(modal.getByTestId('diff-left')).toContainText('NumberDecimal("19.99")');
    await expect(modal.getByTestId('diff-right')).toContainText('19.99');
  });
});
